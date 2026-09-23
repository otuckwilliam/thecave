-- The Cave Ledger: database + your data, in one go.
-- Paste ALL of this into Supabase → SQL Editor → New query, then click Run.

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


-- The Cave Ledger — data moved from the Claude version (products, orders, sales).
-- Run after schema.sql. Safe to re-run (existing rows are kept).
begin;
insert into public.products(id,name,size,cat,cost,price,reorder,open,counted_at,needs_count,count_source,supplier,rank,active) values
('p000','4th Street Red','','Wine',12000,20000,1,0,1784307600000,true,null,'Mohans',67,true),
('p001','4th Street White','','Wine',12000,20000,1,0,1784307600000,true,null,'Mohans',999,true),
('p002','Absolut Vodka','200ml','Spirits',17000,30000,5,0,1784307600000,true,null,'',999,true),
('p003','Absolut Vodka','375ml','Spirits',27000,40000,5,0,1784307600000,true,null,'',41,true),
('p004','Absolut Vodka','750ml','Spirits',45000,65000,5,13,1784307600000,true,'Paper stock take, 17 Jul 2026','',10,true),
('p005','Agavita Tequila Blanco','700ml','Spirits',24872,35000,5,0,1784307600000,true,null,'',999,true),
('p006','Agavita Tequila Gold','700ml','Spirits',24872,35000,5,0,1784307600000,true,null,'',999,true),
('p007','Altar Wine','750ml','Wine',12000,20000,5,4,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p008','Amarula','375ml','Spirits',13000,25000,5,2,1784307600000,true,'Paper stock take, 17 Jul 2026','',61,true),
('p009','Amarula','750ml','Spirits',24583,55000,5,0,1784307600000,true,null,'',75,true),
('p010','Anlssilveruis','','Spirits',30000,50000,1,0,1784307600000,true,null,'Mohans',999,true),
('p011','Bacardi Carta Blanca','750ml','Spirits',27499,35000,5,0,1784307600000,true,null,'',999,true),
('p012','Baileys Irish Cream','750ml','Spirits',35300,45000,5,0,1784307600000,true,null,'',999,true),
('p013','Ballantines','200ml','Spirits',14000,20000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',105,true),
('p014','Ballantines','750ml','Spirits',30000,50000,5,10,1784307600000,true,'Paper stock take, 17 Jul 2026','',24,true),
('p015','Baltika','450ml','Soft drinks',2167,5000,5,0,1784307600000,true,null,'',999,true),
('p016','Baron D Arignac Brut','750ml','Champagne & sparkling',13550,30000,5,0,1784307600000,true,null,'',95,true),
('p017','Baron D Arignac Demi Sec','750ml','Champagne & sparkling',12000,20000,5,0,1784307600000,true,null,'',999,true),
('p018','Baron D Arignac Dry Red','750ml','Wine',11000,18000,5,0,1784307600000,true,null,'',999,true),
('p019','Baron D Arignac Dry White','750ml','Wine',11000,18000,5,0,1784307600000,true,null,'',999,true),
('p020','Baron D Arignac Medium Sweet Red','750ml','Wine',12000,18000,5,0,1784307600000,true,null,'',999,true),
('p021','Baron D Arignac Rose Champaign','750ml','Champagne & sparkling',13550,20000,5,0,1784307600000,true,null,'',999,true),
('p022','Baron D Arignac White Medium Sweet','750ml','Wine',12000,18000,5,0,1784307600000,true,null,'',999,true),
('p023','Bavaria','330ml','Soft drinks',2417,5000,10,0,1784307600000,true,null,'',79,true),
('p024','Belaire Pare Luxe','750ml','Champagne & sparkling',100000,100000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p025','Belaire Rare Rose','750ml','Champagne & sparkling',100000,150000,5,0,1784307600000,true,null,'',999,true),
('p026','Black And White','200ml','Spirits',8500,15000,5,0,1784307600000,true,null,'',50,true),
('p027','Black And White','750ml','Spirits',24000,35000,5,8,1784307600000,true,'Paper stock take, 17 Jul 2026','',31,true),
('p028','Black Label','750ml','Spirits',56000,85000,5,0,1784307600000,true,null,'',999,true),
('p029','Bombay Saphire Dry Gin','700ml','Spirits',39200,45000,5,2,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p030','Bongo Don','200ml','Spirits',2500,5000,5,0,1784307600000,true,null,'',114,true),
('p031','Bongo Don','750ml','Spirits',8000,15000,5,5,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p032','Bonne Esperance Dry Red','750ml','Wine',9800,20000,5,0,1784307600000,true,null,'',999,true),
('p033','Bonne Esperance Dry White','750ml','Wine',9800,23000,5,0,1784307600000,true,null,'',999,true),
('p034','Bonne Esperance Sweet Red','750ml','Wine',9800,20000,5,0,1784307600000,true,null,'',999,true),
('p035','Bonne Esperance Sweet White','750ml','Wine',9800,20000,5,0,1784307600000,true,null,'',999,true),
('p036','Bruto Fruit','','Beer',3400,5000,2,8,1784307600000,true,'Paper stock take, 17 Jul 2026','TBL',1,true),
('p037','Budweiser','','Beer',1791,4000,5,0,1784307600000,true,null,'Kawe',999,true),
('p038','Calvet Cabernet Sauvignon','750ml','Wine',14850,20000,5,0,1784307600000,true,null,'',999,true),
('p039','Calvet Chardonnay','750ml','Wine',14850,20000,5,0,1784307600000,true,null,'',999,true),
('p040','Calvet Cinsault Rose','750ml','Wine',14850,20000,5,0,1784307600000,true,null,'',999,true),
('p041','Calvet Merlot','750ml','Wine',14850,25000,5,0,1784307600000,true,null,'',999,true),
('p042','Calvet Syrah','750ml','Wine',14850,20000,5,0,1784307600000,true,null,'',999,true),
('p043','Camino Short','','Spirits',4,60000,2,0,1784307600000,true,null,'',999,true),
('p044','Campari Mills 200','','Spirits',20000,27000,1,1,1784307600000,true,'Paper stock take, 17 Jul 2026','Mohans',999,true),
('p045','Captain Morgan','200ml','Spirits',4000,10000,1,0,1784307600000,true,null,'Mohans',999,true),
('p046','Captain Morgan Jamaica Rum','750ml','Spirits',26000,55000,5,0,1784307600000,true,null,'',999,true),
('p047','Captain Morgan Spiced Gold','750ml','Spirits',26000,40000,5,15,1784307600000,true,'Paper stock take, 17 Jul 2026','',62,true),
('p048','Castle Light Kopo','','Beer',1833,3000,2,0,1784307600000,true,null,'Mohans',18,true),
('p049','Castle Lite Can','330ml','Beer',1645,2500,10,16,1784307600000,true,'Paper stock take, 17 Jul 2026','',4,true),
('p050','Ceres Cranberry','','Soft drinks',4000,10000,3,0,1784307600000,true,null,'Stive',999,true),
('p051','Ceres Tropical','1L','Soft drinks',4833,7000,5,0,1784307600000,true,null,'',999,true),
('p052','Cerez White Grape','','Soft drinks',4166,7000,2,0,1784307600000,true,null,'Stive',999,true),
('p053','Chateau Sweet','','Wine',3000,6000,3,0,1784307600000,true,null,'Bevco',999,true),
('p054','Chateau','','Wine',3000,6000,3,0,1784307600000,true,null,'Bevco',999,true),
('p055','Chivas Regal Aged 12 Years','750ml','Spirits',75000,90000,5,0,1784307600000,true,null,'',999,true),
('p056','Class 21','','Spirits',10000,35000,1,6,1784307600000,true,'Paper stock take, 17 Jul 2026','Mohans',999,true),
('p057','Cocacola','500ml','Soft drinks',866,2000,10,0,1784307600000,true,null,'',44,true),
('p058','Corona','','Beer',3000,5000,5,0,1784307600000,true,null,'Mawela',999,true),
('p059','Dasani Water','1.5L','Soft drinks',791,2000,5,0,1784307600000,true,null,'',999,true),
('p060','Dasani Water','500ml','Soft drinks',333,1000,5,16,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p061','Davidoff VSOP Cognac','750ml','Spirits',90000,140000,5,2,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p062','Desperados','330ml','Beer',2708,4000,10,0,1784307600000,true,null,'',104,true),
('p063','Dodoma Dry White Wine','750ml','Wine',0,16000,2,0,1784307600000,true,null,'',92,true),
('p064','Dodoma Wine Dry Red','750ml','Wine',10000,18000,5,0,1784307600000,true,null,'',109,true),
('p065','Dodoma Wine Natural Sweet White','750ml','Wine',10000,18000,5,0,1784307600000,true,null,'',110,true),
('p066','Dompo Red Wine','750ml','Wine',14000,18000,5,5,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p067','Drostdy Hof Red','375ml','Wine',5000,10000,5,0,1784307600000,true,null,'Manzese',43,true),
('p068','Drostdy Hof Red','750ml','Wine',13000,23000,5,0,1784307600000,true,null,'Manzese',58,true),
('p069','Drostdy Hof White','375ml','Wine',6500,10000,5,0,1784307600000,true,null,'Manzese',83,true),
('p070','Drostdy Hof White','750ml','Wine',12500,20000,5,0,1784307600000,true,null,'Manzese',84,true),
('p071','Drostoph White','','Wine',13000,20000,1,0,1784307600000,true,null,'',999,true),
('p072','Famous Grouse','1L','Spirits',36500,65900,5,0,1784307600000,true,null,'',999,true),
('p073','Fanta Chungwa','','Soft drinks',733,1000,5,0,1784307600000,true,null,'Bonite',115,true),
('p074','Fanta Orange','','Soft drinks',866,2000,5,0,1784307600000,true,null,'Bonite',49,true),
('p075','Fitch And Leedes Ginger Ale','200ml','Soft drinks',1750,3000,5,0,1784307600000,true,null,'',999,true),
('p076','Fitch And Leedes Indian Tonic','200ml','Soft drinks',1750,3000,10,0,1784307600000,true,null,'',999,true),
('p077','Flying Fish','330ml','Beer',1667,3000,10,0,1784307600000,true,null,'',77,true),
('p078','Four Cousin Rose','1L','Wine',25000,40000,2,0,1784307600000,true,null,'Mawela',86,true),
('p079','Four Cousins Marula Dream','500ml','Spirits',33000,45000,5,0,1784307600000,true,null,'',999,true),
('p080','Four Cousins Natural Sweet Red','1.5L','Wine',30000,40000,5,0,1784307600000,true,null,'',85,true),
('p081','Four Cousins Natural Sweet Red','750ml','Wine',11666,23000,5,0,1784307600000,true,null,'',55,true),
('p082','Four Cousins Natural Sweet White','1.5L','Wine',25000,40000,5,0,1784307600000,true,null,'',68,true),
('p083','Four Cousins Natural Sweet White','750ml','Wine',15000,23000,5,0,1784307600000,true,null,'',45,true),
('p084','Four Cousins Sweet Rose','750ml','Wine',12000,23000,5,0,1784307600000,true,null,'',100,true),
('p085','Francos Family','','Wine',11000,23000,1,7,1784307600000,true,'Paper stock take, 17 Jul 2026','Mawela',103,true),
('p086','Freixenet Cava','750ml','Champagne & sparkling',35000,50000,5,0,1784307600000,true,null,'',999,true),
('p087','Freixenet Ice','750ml','Champagne & sparkling',35000,50000,5,5,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p088','Freixenet Ice Rose','750ml','Champagne & sparkling',35000,55000,5,0,1784307600000,true,null,'',76,true),
('p089','Freixenet Primium Cava Rose','','Champagne & sparkling',35000,55000,1,0,1784307600000,true,null,'Mohans',999,true),
('p090','Furaha Cocktail Pink','750ml','Champagne & sparkling',12000,10000,5,0,1784307600000,true,null,'',999,true),
('p091','Furaha Red Grape','','Champagne & sparkling',12000,10000,1,0,1784307600000,true,null,'Bevco',999,true),
('p092','Furaha Whine Grape','','Champagne & sparkling',12000,10000,1,0,1784307600000,true,null,'Bevco',999,true),
('p093','Gato Negro Merlot','750ml','Wine',12400,18000,5,0,1784307600000,true,null,'',999,true),
('p094','Glenfiddch 15years','','Spirits',120000,160000,1,0,1784307600000,true,null,'MMI',999,true),
('p095','Glenfiddich 12year','','Spirits',80000,130000,1,0,1784307600000,true,null,'MMI',999,true),
('p096','Gordons','200ml','Spirits',12000,18000,1,3,1784307600000,true,'Paper stock take, 17 Jul 2026','Serengeti',33,true),
('p097','Gordons','750ml','Spirits',36000,45000,5,2,1784307600000,true,'Paper stock take, 17 Jul 2026','',48,true),
('p098','Grand Malt','','Soft drinks',1525,5000,3,0,1784307600000,true,null,'Kawe',69,true),
('p099','Grants','200ml','Spirits',16000,21000,5,0,1784307600000,true,null,'',999,true),
('p100','Grants','350ml','Spirits',16000,25000,5,0,1784307600000,true,null,'',17,true),
('p101','Grants','750ml','Spirits',22000,55000,5,7,1784307600000,true,'Paper stock take, 17 Jul 2026','',2,true),
('p102','Guiness Smooth','300ml','Beer',1312,2000,10,0,1784307600000,true,null,'',999,true),
('p103','Hansons Choice','200ml','Spirits',2466,5000,10,5,1784307600000,true,'Paper stock take, 17 Jul 2026','',72,true),
('p104','Hansons Choice','','Spirits',9500,16000,2,7,1784307600000,true,'Paper stock take, 17 Jul 2026','Manzese',59,true),
('p105','Heineken','330ml','Beer',2375,4000,10,33,1784307600000,true,'Paper stock take, 17 Jul 2026','',8,true),
('p106','Hennessy V.S.O.P','','Spirits',175000,230000,1,0,1784307600000,true,null,'MMI',42,true),
('p107','Hennessy Very Special Cognac','750ml','Spirits',89000,195000,5,7,1784307600000,true,'Paper stock take, 17 Jul 2026','',47,true),
('p108','Hunting Lodge','','Spirits',15000,45000,1,1,1784307600000,true,'Paper stock take, 17 Jul 2026','Manzese',65,true),
('p109','Ice Drop','large','Soft drinks',291,2000,2,0,1784307600000,true,null,'Ice Drop',15,true),
('p110','Ice Drop','small','Soft drinks',145,1000,4,0,1784307600000,true,null,'Ice Drop',40,true),
('p111','Image Dry Wine','','Wine',10400,18000,3,0,1784307600000,true,null,'Manzese',999,true),
('p112','Imagi Red','200ml','Wine',3958,5000,10,11,1784307600000,true,'Paper stock take, 17 Jul 2026','',53,true),
('p113','Impala Sparkling Red Grape','750ml','Champagne & sparkling',6550,10000,5,0,1784307600000,true,null,'',999,true),
('p114','Impala Sparkling White Grape','750ml','Champagne & sparkling',6550,10000,5,0,1784307600000,true,null,'',999,true),
('p115','Imperial Blue','','Spirits',17000,37000,1,2,1784307600000,true,'Paper stock take, 17 Jul 2026','Manzese',999,true),
('p116','J.B Rare','200ml','Spirits',9000,15000,5,0,1784307600000,true,null,'',999,true),
('p117','Jack Daniel','1L','Spirits',50000,95000,1,0,1784307600000,true,null,'Red and White',999,true),
('p118','Jack Daniel','350ml','Spirits',32000,45000,1,0,1784307600000,true,null,'Mohans',999,true),
('p119','Jack Daniels','700ml','Spirits',68000,80000,5,0,1784307600000,true,null,'',22,true),
('p120','Jack Daniels Whiskey','700ml','Spirits',51000,80000,5,11,1784307600000,true,'Paper stock take, 17 Jul 2026','',16,true),
('p121','Jager Master','200ml','Spirits',17000,25000,1,2,1784307600000,true,'Paper stock take, 17 Jul 2026','Mohans',999,true),
('p122','Jager Master 350','','Spirits',13000,25000,1,0,1784307600000,true,null,'Mohans',96,true),
('p123','Jagermeister','1L','Spirits',45000,65000,5,0,1784307600000,true,null,'',46,true),
('p124','Jagermeister','700ml','Spirits',38000,55000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',29,true),
('p125','Jameson','200ml','Spirits',28000,38000,5,0,1784307600000,true,null,'',999,true),
('p126','Jameson 375','','Spirits',36000,46000,1,0,1784307600000,true,null,'Mohans',56,true),
('p127','Jameson','750ml','Spirits',55000,75000,5,10,1784307600000,true,'Paper stock take, 17 Jul 2026','',36,true),
('p128','Jameson Black Barrel','750ml','Spirits',80000,95000,5,0,1784307600000,true,null,'',999,true),
('p129','JB Rare','200ml','Spirits',9000,15000,2,0,1784307600000,true,null,'Serengeti',70,true),
('p130','JB Rare','','Spirits',30000,45000,2,1,1784307600000,true,'Paper stock take, 17 Jul 2026','Serengeti',11,true),
('p131','Jelzin Vodka','700ml','Spirits',12350,20000,5,3,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p132','Jose Cuervo Especial','750ml','Spirits',18849,30000,5,0,1784307600000,true,null,'',999,true),
('p133','Jose Cuervo Especial Gold','750ml','Spirits',18849,30000,5,0,1784307600000,true,null,'',999,true),
('p134','JP Chenet Ice Edition','750ml','Champagne & sparkling',35000,45000,5,2,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p135','K Vant','250ml','Spirits',3000,5000,10,7,1784307600000,true,'Paper stock take, 17 Jul 2026','',38,true),
('p136','K Vant','750ml','Spirits',8000,15000,5,9,1784307600000,true,'Paper stock take, 17 Jul 2026','',27,true),
('p137','Kilimanjaro Lager Can','330ml','Beer',1639,3000,10,2,1784307600000,true,'Paper stock take, 17 Jul 2026','',57,true),
('p138','Kilimanjaro Lager Ndogo','','Beer',1400,2500,5,5,1784307600000,true,'Paper stock take, 17 Jul 2026','MGCL',13,true),
('p139','Kilimanjaro Light','330ml','Beer',1667,3000,10,0,1784307600000,true,null,'',999,true),
('p140','Konyagi','200ml','Spirits',3000,5000,10,0,1784307600000,true,null,'',26,true),
('p141','Konyagi','500ml','Spirits',6188,10000,5,10,1784307600000,true,'Paper stock take, 17 Jul 2026','',39,true),
('p142','Konyagi','750ml','Spirits',8500,15000,5,8,1784307600000,true,'Paper stock take, 17 Jul 2026','',28,true),
('p143','Krest Soda Water','500ml','Soft drinks',733,2000,5,0,1784307600000,true,null,'',107,true),
('p144','Krest Tonic Water','500ml','Soft drinks',733,2000,10,0,1784307600000,true,null,'',30,true),
('p145','KWV Cabernet Sauvignon','750ml','Wine',25000,35000,5,0,1784307600000,true,null,'',90,true),
('p146','KWV Chardoney','','Wine',25000,45000,2,0,1784307600000,true,null,'',54,true),
('p147','KWV Merlot','750ml','Wine',25000,40000,5,0,1784307600000,true,null,'',91,true),
('p148','KWV Pinotage','750ml','Wine',21000,40000,5,0,1784307600000,true,null,'',88,true),
('p149','KWV Sauvignon Blanc','750ml','Wine',25000,30000,5,0,1784307600000,true,null,'',999,true),
('p150','KWV Shiraz','750ml','Wine',25000,35000,5,0,1784307600000,true,null,'',999,true),
('p151','Lions Hill Dry Red','750ml','Wine',11000,23000,5,0,1784307600000,true,null,'',999,true),
('p152','Lions Hill Dry White','750ml','Wine',11000,20000,5,0,1784307600000,true,null,'',999,true),
('p153','Lions Hill Natural Sweet White','750ml','Wine',11000,23000,5,0,1784307600000,true,null,'',87,true),
('p154','Lions Hill Sweet Red','750ml','Wine',11000,23000,5,0,1784307600000,true,null,'',108,true),
('p155','Lions Hill Sweet Rose','750ml','Wine',11000,23000,5,0,1784307600000,true,null,'',101,true),
('p156','Magic Moment 375','','Spirits',6000,15000,1,6,1784307600000,true,'Paper stock take, 17 Jul 2026','Mohans',113,true),
('p157','Magic Moments Chocolate','750ml','Spirits',15500,35000,5,0,1784307600000,true,null,'',999,true),
('p158','Magic Moments Green Apple','750ml','Spirits',15500,35000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',89,true),
('p159','Magicmoment Green 375','','Spirits',8000,15000,1,0,1784307600000,true,null,'Mohans',93,true),
('p160','Malibu Liqueur','750ml','Spirits',30000,40000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p161','Mango Cerez','','Soft drinks',0,6000,3,0,1784307600000,true,null,'Stive',999,true),
('p162','Mansion House','','Spirits',12000,25000,1,6,1784307600000,true,'Paper stock take, 17 Jul 2026','Mohans',98,true),
('p163','Marengo Sparklin Wine','','Champagne & sparkling',19000,30000,2,0,1784307600000,true,null,'Bevco',999,true),
('p164','Martel Blue Swift','','Spirits',200000,260000,1,6,1784307600000,true,'Paper stock take, 17 Jul 2026','Mawela',12,true),
('p165','Martel VSOP','','Spirits',91000,220000,1,0,1784307600000,true,null,'Mawela',5,true),
('p166','Martell','','Spirits',81000,150000,1,0,1784307600000,true,null,'Mawela',37,true),
('p167','Martine Rose','','Champagne & sparkling',41000,65000,1,5,1784307600000,true,'Paper stock take, 17 Jul 2026','Bevco',9,true),
('p168','Martini Asti','750ml','Champagne & sparkling',16550,25000,5,0,1784307600000,true,null,'',999,true),
('p169','Martini Bianco','750ml','Spirits',18000,25000,5,0,1784307600000,true,null,'',999,true),
('p170','Martini Dolce','750ml','Champagne & sparkling',16550,25000,5,0,1784307600000,true,null,'',999,true),
('p171','Martini Fiero','750ml','Spirits',25749,35000,5,0,1784307600000,true,null,'',999,true),
('p172','Martini Prosecco','','Champagne & sparkling',27000,35000,1,0,1784307600000,true,null,'Bevco',999,true),
('p173','Martini Rosso','750ml','Spirits',22000,55000,5,0,1784307600000,true,null,'',999,true),
('p174','Mateus Rose','750ml','Wine',24000,30000,5,4,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p175','Mentos 65pc','','Other',10000,15000,1,0,1784307600000,true,null,'Stive',999,true),
('p176','Mentos Gum 35pc','','Other',6000,10000,2,0,1784307600000,true,null,'Stive',999,true),
('p177','Moet Rose','','Champagne & sparkling',185000,250000,1,1,1784307600000,true,'Paper stock take, 17 Jul 2026','Bahati',21,true),
('p178','Mohans Wine','','Wine',11000,18000,1,0,1784307600000,true,null,'Mohans',999,true),
('p179','Monster Enargy','500ml','Soft drinks',2500,5000,5,0,1784307600000,true,null,'',999,true),
('p180','Naked','700ml','Spirits',50050,65000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p181','Old Nick Caribbean Gold Rum','700ml','Spirits',15000,20000,5,0,1784307600000,true,null,'',999,true),
('p182','Old Nick White Rum','700ml','Spirits',15000,20000,5,0,1784307600000,true,null,'',999,true),
('p183','Olmeca Taquila','','Spirits',55000,75000,3,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p184','Pearly Bay Dry Red','750ml','Wine',11500,23000,5,0,1784307600000,true,null,'',999,true),
('p185','Pearly Bay Dry White','750ml','Wine',11500,23000,5,0,1784307600000,true,null,'',102,true),
('p186','Pearly Bay Sweet Red','750ml','Wine',11500,23000,5,0,1784307600000,true,null,'',999,true),
('p187','Pearly Bay Sweet Rose','750ml','Wine',11500,23000,5,0,1784307600000,true,null,'',7,true),
('p188','Pearly Bay Sweet White','750ml','Wine',11500,23000,5,0,1784307600000,true,null,'',64,true),
('p189','Pearlybay Celebration','','Champagne & sparkling',20000,45000,5,5,1784307600000,true,'Paper stock take, 17 Jul 2026','Manzese',34,true),
('p190','Prite','','Soft drinks',867,2000,3,0,1784307600000,true,null,'Bonite',52,true),
('p191','Provetto Brut','750ml','Champagne & sparkling',20000,45000,5,0,1784307600000,true,null,'',97,true),
('p192','Provetto Secco Champaign','750ml','Champagne & sparkling',20000,45000,5,15,1784307600000,true,'Paper stock take, 17 Jul 2026','',35,true),
('p193','Red Bull','250ml','Soft drinks',2958,5000,10,5,1784307600000,true,'Paper stock take, 17 Jul 2026','',23,true),
('p194','Red Label','200ml','Spirits',10000,15000,5,0,1784307600000,true,null,'',999,true),
('p195','Red Label','750ml','Spirits',30500,55000,5,0,1784307600000,true,null,'',6,true),
('p196','Rendez Vous Apple Sparkling','750ml','Champagne & sparkling',8000,15000,5,0,1784307600000,true,null,'',82,true),
('p197','Rendez Vous Blue','750ml','Champagne & sparkling',8000,15000,5,0,1784307600000,true,null,'',112,true),
('p198','Rendez Vous Pink','750ml','Champagne & sparkling',8000,15000,5,0,1784307600000,true,null,'',111,true),
('p199','Rendez Vous Red Grape','750ml','Champagne & sparkling',8000,15000,5,0,1784307600000,true,null,'',80,true),
('p200','Rendez Vous White Grape Sparkling','750ml','Champagne & sparkling',8000,15000,5,0,1784307600000,true,null,'',81,true),
('p201','Robertson Winery Sweet Red','750ml','Wine',16000,25000,5,0,1784307600000,true,null,'',71,true),
('p202','Robertson Winery Sweet Rose','750ml','Wine',16000,20000,5,0,1784307600000,true,null,'',999,true),
('p203','Robertson Winery Sweet White','750ml','Wine',16000,25000,5,0,1784307600000,true,null,'',99,true),
('p204','Safari Lager Ndogo','','Beer',1400,2500,3,8,1784307600000,true,'Paper stock take, 17 Jul 2026','Manzese',20,true),
('p205','Safari Lager','','Beer',2041,3000,5,0,1784307600000,true,null,'Kawe',78,true),
('p206','Saint Anna Natural Sweet','750ml','Wine',12000,20000,5,5,1784307600000,true,'Paper stock take, 17 Jul 2026','',74,true),
('p207','Savanna Dry','','Beer',2300,5000,2,16,1784307600000,true,'Paper stock take, 17 Jul 2026','Bevco',14,true),
('p208','Serengeti Cabernet Sauvignon Merlot','750ml','Wine',9000,15000,5,0,1784307600000,true,null,'',999,true),
('p209','Serengeti Chenin Blanc Sauvignon Blanc','750ml','Wine',9000,20000,5,0,1784307600000,true,null,'',999,true),
('p210','Serengeti Lager','','Beer',1600,2500,4,27,1784307600000,true,'Paper stock take, 17 Jul 2026','Kawe',19,true),
('p211','Serengeti Lite','330ml','Beer',1600,2500,10,30,1784307600000,true,'Paper stock take, 17 Jul 2026','',3,true),
('p212','Serengeti Natural Sweet White','750ml','Wine',9000,20000,5,0,1784307600000,true,null,'',106,true),
('p213','Serengeti Sweet Red','750ml','Wine',9000,15000,5,0,1784307600000,true,null,'',999,true),
('p214','Siera Taqila','','Spirits',35000,55000,1,0,1784307600000,true,null,'Mohans',999,true),
('p215','Sigeton 12','','Spirits',80000,120000,1,0,1784307600000,true,null,'Ngowi',999,true),
('p216','Single Ton','','Spirits',80000,120000,1,0,1784307600000,true,null,'Ngowi',63,true),
('p217','Smirnoff Extra Smooth','750ml','Spirits',22000,30000,5,0,1784307600000,true,null,'',94,true),
('p218','Smirnoff Ice Black','300ml','Beer',2800,4000,10,6,1784307600000,true,'Paper stock take, 17 Jul 2026','',66,true),
('p219','Smirnoff NO21','200ml','Spirits',11000,16000,5,0,1784307600000,true,null,'',51,true),
('p220','Smirnoff NO21','750ml','Spirits',22000,30000,5,0,1784307600000,true,null,'',999,true),
('p221','Smirnoff','','Spirits',11000,22000,1,0,1784307600000,true,null,'Red and White',999,true),
('p222','St Remy VSOP','700ml','Spirits',31600,65000,5,0,1784307600000,true,null,'',73,true),
('p223','Stoney Tangawizi','500ml','Soft drinks',733,2000,5,0,1784307600000,true,null,'',60,true),
('p224','Strawberry Lips','750ml','Spirits',14000,25000,5,0,1784307600000,true,null,'',999,true),
('p225','Switch','','Soft drinks',3400,5000,5,0,1784307600000,true,null,'',999,true),
('p226','Tall Horse Cabernet Sauvignon','750ml','Wine',18000,20000,5,0,1784307600000,true,null,'',999,true),
('p227','Tall Horse Chardonnay','750ml','Wine',18000,20000,5,0,1784307600000,true,null,'',999,true),
('p228','Tall Horse Merlot','750ml','Wine',18000,20000,5,0,1784307600000,true,null,'',999,true),
('p229','Tall Horse Sauvignon Blanc','750ml','Wine',18000,20000,5,0,1784307600000,true,null,'',999,true),
('p230','Tall Horse Shiraz','750ml','Wine',18000,20000,5,0,1784307600000,true,null,'',999,true),
('p231','Tanqueray Export Strength','750ml','Spirits',38000,45000,5,1,1784307600000,true,'Paper stock take, 17 Jul 2026','',999,true),
('p232','Trident','','Other',1200,3500,1,0,1784307600000,true,null,'Stive',999,true),
('p233','Vice Roy','200ml','Spirits',4166,10000,3,0,1784307600000,true,null,'',999,true),
('p234','Vice Roy','700ml','Spirits',23000,35000,2,0,1784307600000,true,null,'Manzese',999,true),
('p235','Vinecrafter Merlot','750ml','Wine',15930,20000,5,0,1784307600000,true,null,'',999,true),
('p236','Vinecrafter Sauvignon Blanc','750ml','Wine',15930,20000,5,0,1784307600000,true,null,'',999,true),
('p237','Vinecrafter Shiraz','750ml','Wine',15930,20000,5,0,1784307600000,true,null,'',999,true),
('p238','William Lawsons','350ml','Spirits',13000,20000,5,0,1784307600000,true,null,'',999,true),
('p239','William Lawsons','750ml','Spirits',29000,45000,1,0,1784307600000,true,null,'',999,true),
('p240','William Low Son','200ml','Spirits',8500,16000,1,0,1784307600000,true,null,'MCL',999,true),
('p241','William Low Son','','Spirits',8500,16000,1,0,1784307600000,true,null,'MCL',999,true),
('p242','William Lowson','1L','Spirits',31500,50000,1,0,1784307600000,true,null,'Stive',999,true),
('p243','Windhoek','330ml','Beer',2333,4000,10,13,1784307600000,true,'Paper stock take, 17 Jul 2026','',25,true)
on conflict (id) do nothing;
insert into public.orders(id,no,created_ms,by_name,supplier,status,expected_date,sent_at,items,deliveries) values ('o8ywaiwh27vyz','LPO-0001',1790165333915,'','Bevco','draft',null,null,'[{"name": "Chateau", "pid": "p054", "qty": 6, "size": "", "unitCost": 3000}, {"name": "Chateau Sweet", "pid": "p053", "qty": 6, "size": "", "unitCost": 3000}, {"name": "Furaha Red Grape", "pid": "p091", "qty": 2, "size": "", "unitCost": 12000}, {"name": "Furaha Whine Grape", "pid": "p092", "qty": 2, "size": "", "unitCost": 12000}, {"name": "Marengo Sparklin Wine", "pid": "p163", "qty": 4, "size": "", "unitCost": 19000}, {"name": "Martini Prosecco", "pid": "p172", "qty": 2, "size": "", "unitCost": 27000}]'::jsonb,'[]'::jsonb) on conflict (id) do nothing;
insert into public.orders(id,no,created_ms,by_name,supplier,status,expected_date,sent_at,items,deliveries) values ('oyo9ys3v28mhk','LPO-0002',1790165368280,'','Bonite','draft',null,null,'[{"name": "Fanta Chungwa", "pid": "p073", "qty": 10, "size": "", "unitCost": 733}, {"name": "Fanta Orange", "pid": "p074", "qty": 10, "size": "", "unitCost": 866}, {"name": "Prite", "pid": "p190", "qty": 6, "size": "", "unitCost": 867}]'::jsonb,'[]'::jsonb) on conflict (id) do nothing;
insert into public.orders(id,no,created_ms,by_name,supplier,status,expected_date,sent_at,items,deliveries) values ('owhghkam28pf4','LPO-0003',1790165372080,'','Ice Drop','draft',null,null,'[{"name": "Ice Drop", "pid": "p109", "qty": 4, "size": "large", "unitCost": 291}, {"name": "Ice Drop", "pid": "p110", "qty": 8, "size": "small", "unitCost": 145}]'::jsonb,'[]'::jsonb) on conflict (id) do nothing;
insert into public.sales(id,date,ts,items,pay,customer,by_name,by_id,device,paid_at,paid_via,voided_at,voided_by,void_reason,edited_at,edited_by) values ('gaavnme2rxur','2026-09-23',1790166269475,'[{"cost": 3400, "name": "Bruto Fruit", "pid": "p036", "price": 5000, "qty": 1, "size": ""}, {"cost": 1600, "name": "Serengeti Lite", "pid": "p211", "price": 2500, "qty": 2, "size": "330ml"}]'::jsonb,'Credit','otuck','otuck',null,'d4hroxch2ifmx',null,null,null,null,null,1790168415654,'otuck') on conflict (id) do nothing;
insert into public.settings(key,value) values ('access', jsonb_build_object('salt','40fb5bb7659d5ba27a41e2343a6ec3fa','autoLockMin',15)) on conflict (key) do nothing;
commit;
