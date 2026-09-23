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
