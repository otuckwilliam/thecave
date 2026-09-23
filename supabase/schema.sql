-- =====================================================================
-- The Cave Ledger — database schema for Supabase
-- Run this once in: Supabase dashboard → SQL Editor → New query → Run
-- Safe to re-run: it only creates what is missing and replaces functions.
-- =====================================================================

-- ---------- who is signed in -----------------------------------------
-- Every Supabase login must have a row here, otherwise it sees nothing.
--   role 'admin'   = owner / manager (full control)
--   role 'counter' = the shop's counter computer (sellers unlock it with a PIN)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','counter')),
  label text,
  created_at timestamptz not null default now()
);

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where user_id = auth.uid()), false)
$$;
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where user_id = auth.uid())
$$;

-- ---------- catalogue --------------------------------------------------
create table if not exists public.products (
  id text primary key,
  name text not null,
  size text not null default '',
  cat text not null default 'Other',
  cost numeric not null default 0,
  price numeric not null default 0,
  reorder integer not null default 5,
  open numeric not null default 0,          -- bottles at last count
  counted_at bigint not null default 0,     -- ms since epoch of last count
  needs_count boolean not null default false,
  count_source text,
  supplier text not null default '',
  rank integer not null default 999,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- sellers (PIN profiles used on the counter) -----------------
create table if not exists public.staff (
  id text primary key,
  name text not null,
  role text not null default 'seller' check (role in ('seller')),
  pin_hash text not null,
  active boolean not null default true,
  created_at bigint not null default (extract(epoch from now())*1000)::bigint,
  created_by text
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

-- ---------- money in / money out --------------------------------------
create table if not exists public.sales (
  id text primary key,
  date text not null,                 -- YYYY-MM-DD, shop's local day
  ts bigint not null,                 -- ms since epoch when rung up
  items jsonb not null,               -- [{pid,name,size,qty,price,cost}]
  pay text not null,
  customer text,
  by_name text,
  by_id text,
  device text,
  paid_at bigint, paid_via text, paid_by text,
  voided_at bigint, voided_by text, void_reason text,
  edited_at bigint, edited_by text,
  inserted_at timestamptz not null default now()
);
create index if not exists sales_date_idx on public.sales(date);

create table if not exists public.expenses (
  id text primary key,
  date text not null,
  ts bigint not null,
  cat text not null,
  amount numeric not null,
  note text,
  by_name text, by_id text,
  inserted_at timestamptz not null default now()
);
create index if not exists expenses_date_idx on public.expenses(date);

create table if not exists public.restocks (
  id text primary key,
  date text not null,
  ts bigint not null,
  pid text not null references public.products(id),
  name text,
  qty numeric not null,
  unit_cost numeric not null default 0,
  supplier text,
  order_id text, order_no text,
  by_name text,
  inserted_at timestamptz not null default now()
);
create index if not exists restocks_date_idx on public.restocks(date);
create index if not exists restocks_pid_idx on public.restocks(pid);

create table if not exists public.orders (
  id text primary key,
  no text,
  created_ms bigint not null,
  by_name text, by_id text,
  supplier text,
  status text not null default 'draft' check (status in ('draft','sent','partial','received','cancelled')),
  expected_date text,
  sent_at bigint, received_at bigint, cancelled_at bigint, closed_at bigint, close_note text,
  items jsonb not null default '[]',
  deliveries jsonb not null default '[]',
  note text,
  updated_at timestamptz not null default now()
);

-- ---------- row level security ----------------------------------------
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.staff    enable row level security;
alter table public.settings enable row level security;
alter table public.sales    enable row level security;
alter table public.expenses enable row level security;
alter table public.restocks enable row level security;
alter table public.orders   enable row level security;

do $$ declare t text; begin
  foreach t in array array['products','staff','settings','sales','expenses','restocks','orders'] loop
    execute format('drop policy if exists "%1$s read" on public.%1$I', t);
    execute format('create policy "%1$s read" on public.%1$I for select to authenticated using (public.is_member())', t);
    execute format('drop policy if exists "%1$s admin write" on public.%1$I', t);
    execute format('create policy "%1$s admin write" on public.%1$I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

drop policy if exists "profiles read own" on public.profiles;
create policy "profiles read own" on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- the counter may ring up sales and add expenses (never change or delete them directly)
drop policy if exists "sales counter insert" on public.sales;
create policy "sales counter insert" on public.sales for insert to authenticated with check (public.is_member());
drop policy if exists "expenses counter insert" on public.expenses;
create policy "expenses counter insert" on public.expenses for insert to authenticated with check (public.is_member());

-- ---------- actions the counter is allowed to do ----------------------
-- Void a sale: admins any time; the counter only within 10 minutes of it reaching the server.
create or replace function public.void_sale(p_id text, p_by text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found then raise exception 'sale not found'; end if;
  if s.voided_at is not null then return; end if;
  if not public.is_admin() and s.inserted_at < now() - interval '10 minutes' then
    raise exception 'Only the Admin can void a sale after 10 minutes';
  end if;
  update public.sales set voided_at = (extract(epoch from now())*1000)::bigint, voided_by = p_by, void_reason = p_reason where id = p_id;
end $$;

-- Mark a credit (deni) sale as paid back.
create or replace function public.mark_credit_paid(p_id text, p_via text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  update public.sales set paid_at = (extract(epoch from now())*1000)::bigint, paid_via = p_via, paid_by = p_by
   where id = p_id and pay = 'Credit' and paid_at is null;
end $$;

-- Receive a delivery against an order. Idempotent: the same delivery id is only applied once.
-- p_delivery = {id, ts, by, note, date, items:[{pid, qty, unitCost}]}
create or replace function public.receive_delivery(p_order text, p_delivery jsonb, p_update_costs boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare o public.orders; it jsonb; dl jsonb; got jsonb := '{}'::jsonb; done boolean := true; oi jsonb; pname text;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status in ('received','cancelled') then return o.status; end if;
  if exists (select 1 from jsonb_array_elements(o.deliveries) d where d->>'id' = p_delivery->>'id') then return o.status; end if;

  for it in select * from jsonb_array_elements(p_delivery->'items') loop
    if (it->>'qty')::numeric > 0 then
      select name into pname from public.products where id = it->>'pid';
      insert into public.restocks(id, date, ts, pid, name, qty, unit_cost, supplier, order_id, order_no, by_name)
      values ((p_delivery->>'id') || ':' || (it->>'pid'), p_delivery->>'date', (p_delivery->>'ts')::bigint, it->>'pid', pname,
              (it->>'qty')::numeric, coalesce((it->>'unitCost')::numeric,0), o.supplier, o.id, o.no, p_delivery->>'by')
      on conflict (id) do nothing;
      if p_update_costs and public.is_admin() then
        update public.products set cost = (it->>'unitCost')::numeric, updated_at = now() where id = it->>'pid';
      end if;
    end if;
  end loop;

  o.deliveries := o.deliveries || jsonb_build_array(p_delivery);
  for dl in select * from jsonb_array_elements(o.deliveries) loop
    for it in select * from jsonb_array_elements(dl->'items') loop
      got := jsonb_set(got, array[it->>'pid'], to_jsonb(coalesce((got->>(it->>'pid'))::numeric,0) + (it->>'qty')::numeric));
    end loop;
  end loop;
  for oi in select * from jsonb_array_elements(o.items) loop
    if coalesce((got->>(oi->>'pid'))::numeric,0) < (oi->>'qty')::numeric then done := false; end if;
  end loop;

  update public.orders set deliveries = o.deliveries,
    status = case when done then 'received' else 'partial' end,
    received_at = case when done then (p_delivery->>'ts')::bigint else received_at end,
    sent_at = coalesce(sent_at, (p_delivery->>'ts')::bigint),
    updated_at = now()
   where id = o.id;
  return case when done then 'received' else 'partial' end;
end $$;

-- Bottles on hand for every product = last count + deliveries since − sales since.
create or replace function public.stock_levels()
returns table(pid text, on_hand numeric) language sql stable security invoker set search_path = public as $$
  with sold as (
    select i->>'pid' as pid, sum((i->>'qty')::numeric) as q
      from public.sales s cross join lateral jsonb_array_elements(s.items) i
      join public.products p on p.id = i->>'pid'
     where s.voided_at is null and s.ts > p.counted_at
     group by 1),
  got as (
    select r.pid, sum(r.qty) as q from public.restocks r join public.products p on p.id = r.pid
     where r.ts > p.counted_at group by 1)
  select p.id, p.open + coalesce(got.q,0) - coalesce(sold.q,0)
    from public.products p left join sold on sold.pid = p.id left join got on got.pid = p.id
$$;

grant execute on function public.void_sale(text,text,text), public.mark_credit_paid(text,text,text),
  public.receive_delivery(text,jsonb,boolean), public.stock_levels(), public.my_role(), public.is_admin(), public.is_member() to authenticated;
revoke execute on function public.void_sale(text,text,text), public.mark_credit_paid(text,text,text),
  public.receive_delivery(text,jsonb,boolean) from anon, public;

-- ---------- live updates between devices ------------------------------
do $$ declare t text; begin
  foreach t in array array['products','staff','settings','sales','expenses','restocks','orders'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;


-- ===== one login per person (Admin / Seller) =====
-- (same as 2-logins-update.sql)
-- The Cave Ledger — switch to one login per person (Admin / Seller).
-- Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists active boolean not null default true;
create unique index if not exists profiles_username_key on public.profiles (lower(username)) where username is not null;
alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles set role = 'seller' where role = 'counter';
alter table public.profiles add constraint profiles_role_check check (role in ('admin','seller'));

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' and active from public.profiles where user_id = auth.uid()), false)
$$;
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active from public.profiles where user_id = auth.uid()), false)
$$;

-- Sellers may only void their OWN sales, within 10 minutes. Admins: any sale.
create or replace function public.void_sale(p_id text, p_by text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found then raise exception 'sale not found'; end if;
  if s.voided_at is not null then return; end if;
  if not public.is_admin() and (s.by_id is distinct from auth.uid()::text or s.inserted_at < now() - interval '10 minutes') then
    raise exception 'Sellers can only void their own sales, within 10 minutes. Ask the Admin.';
  end if;
  update public.sales set voided_at = (extract(epoch from now())*1000)::bigint, voided_by = p_by, void_reason = p_reason where id = p_id;
end $$;

-- the old PIN table is no longer used
drop policy if exists "staff read" on public.staff;
revoke all on public.staff from anon, authenticated;


-- ===== seller details (same as 3-seller-details.sql) =====
-- The Cave Ledger — seller details (phone, start date, private notes). Admin-only.
-- Run once in Supabase → SQL Editor. Safe to re-run.
create table if not exists public.staff_info (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text,
  started_on date,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.staff_info enable row level security;
drop policy if exists "staff_info admin" on public.staff_info;
create policy "staff_info admin" on public.staff_info for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- ===== open tabs & payment changes (same as 4-open-sales.sql) =====
-- The Cave Ledger — open tabs (unpaid sales) and changing payment mode.
-- Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.sales add column if not exists status text not null default 'paid';
alter table public.sales add column if not exists label text;
alter table public.sales drop constraint if exists sales_status_check;
alter table public.sales add constraint sales_status_check check (status in ('open','paid'));
-- old "Credit" sales that were never paid become open tabs
update public.sales set status = 'open', label = coalesce(label, customer, 'Credit')
 where pay = 'Credit' and paid_at is null and voided_at is null and status = 'paid';

create or replace function public.shop_today() returns text language sql stable as $$
  select to_char(now() at time zone 'Africa/Dar_es_Salaam', 'YYYY-MM-DD')
$$;
create or replace function public.valid_pay(p text) returns boolean language sql immutable as $$
  select p in ('Cash','M-Pesa','Mixx by Yas','Airtel Money','HaloPesa','Card')
$$;
create or replace function public.now_ms() returns bigint language sql stable as $$
  select (extract(epoch from now())*1000)::bigint
$$;

-- change the drinks / name on an open tab (any seller)
create or replace function public.update_open_sale(p_id text, p_items jsonb, p_label text, p_customer text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found then raise exception 'Tab not found'; end if;
  if s.voided_at is not null then raise exception 'This tab was voided'; end if;
  if s.status <> 'open' then raise exception 'This sale is already paid — reopen it first'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'A tab needs at least one drink'; end if;
  update public.sales set items = p_items, label = coalesce(nullif(trim(p_label),''), label),
         customer = nullif(trim(coalesce(p_customer,'')),''), edited_at = public.now_ms(), edited_by = p_by
   where id = p_id;
end $$;

-- take payment for an open tab (any seller)
create or replace function public.close_sale(p_id text, p_pay text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  if not public.valid_pay(p_pay) then raise exception 'Unknown payment method'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found then raise exception 'Tab not found'; end if;
  if s.voided_at is not null then raise exception 'This tab was voided'; end if;
  if s.status = 'paid' then return; end if;
  update public.sales set status = 'paid', pay = p_pay, paid_at = public.now_ms(), paid_via = p_pay, paid_by = p_by where id = p_id;
end $$;

-- change how a paid sale was paid (sellers: today's sales; Admin: any)
create or replace function public.set_sale_payment(p_id text, p_pay text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  if not public.valid_pay(p_pay) then raise exception 'Unknown payment method'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if s.voided_at is not null then raise exception 'This sale was voided'; end if;
  if s.status <> 'paid' then raise exception 'Take payment for the tab first'; end if;
  if not public.is_admin() and s.date <> public.shop_today() and to_char(to_timestamp(coalesce(s.paid_at, s.ts)/1000.0) at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD') <> public.shop_today() then
    raise exception 'Only the Admin can change payment on older sales';
  end if;
  update public.sales set pay = p_pay, paid_via = p_pay, edited_at = public.now_ms(), edited_by = p_by where id = p_id;
end $$;

-- put a paid sale back to open / unpaid (sellers: today's sales; Admin: any)
create or replace function public.reopen_sale(p_id text, p_label text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if s.voided_at is not null then raise exception 'This sale was voided'; end if;
  if s.status = 'open' then return; end if;
  if not public.is_admin() and s.date <> public.shop_today() then raise exception 'Only the Admin can reopen older sales'; end if;
  update public.sales set status = 'open', pay = 'Open', paid_at = null, paid_via = null, paid_by = null,
         label = coalesce(nullif(trim(p_label),''), label, customer, 'Reopened'), edited_at = public.now_ms(), edited_by = p_by
   where id = p_id;
end $$;

-- old "mark credit paid" now simply closes the tab
create or replace function public.mark_credit_paid(p_id text, p_via text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.close_sale(p_id, p_via, p_by); end $$;

grant execute on function public.update_open_sale(text,jsonb,text,text,text), public.close_sale(text,text,text),
  public.set_sale_payment(text,text,text), public.reopen_sale(text,text,text), public.shop_today() to authenticated;
revoke execute on function public.update_open_sale(text,jsonb,text,text,text), public.close_sale(text,text,text),
  public.set_sale_payment(text,text,text), public.reopen_sale(text,text,text) from anon, public;
