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
