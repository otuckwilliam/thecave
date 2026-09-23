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
