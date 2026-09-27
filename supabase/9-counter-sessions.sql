-- The Cave Ledger — counter sessions (open counter → sell → close counter with a report).
-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- * A sale now belongs to a counter session. Its "date" is the day the counter was opened,
--   so sales after midnight stay with the evening they belong to.
-- * Sellers don't pick a payment per sale. At close they enter cash counted, mobile-money
--   totals and the credit list. Credit is kept in public.credits until it's paid back
--   ("Debt collected" in the report of the session when the money came in).

-- ---------- tables ----------------------------------------------------
create table if not exists public.counter_sessions (
  id text primary key,
  date text not null,                        -- business day = day the counter was opened (YYYY-MM-DD)
  status text not null default 'open' check (status in ('open','closed')),
  opened_at bigint not null,
  opened_by text, opened_by_id text, device text,
  closed_at bigint, closed_by text, closed_by_id text,
  total_sales numeric,                       -- worked out by the database at close
  cash numeric,                              -- cash counted in the drawer
  paid_out numeric,                          -- money taken from the drawer for expenses (matumizi)
  mobile jsonb,                              -- {"M-Pesa":0,"Mixx by Yas":0,...,"Card":0}
  credit_total numeric,
  collected_total numeric,
  difference numeric,                        -- accounted for − total sales (negative = short)
  note text,
  report jsonb,                              -- snapshot used for the PDF and the Admin Reports tab
  inserted_at timestamptz not null default now()
);
create index if not exists counter_sessions_date_idx on public.counter_sessions(date);

create table if not exists public.credits (
  id text primary key,
  session_id text references public.counter_sessions(id),
  date text not null,
  name text not null,
  amount numeric not null check (amount > 0),
  paid_amount numeric not null default 0,
  payments jsonb not null default '[]',     -- [{session_id, amount, via, ts, by}]
  paid_at bigint,                            -- set when fully paid
  created_at bigint not null,
  created_by text,
  note text,
  inserted_at timestamptz not null default now()
);
create index if not exists credits_open_idx on public.credits(paid_at);

alter table public.sales add column if not exists session_id text;
create index if not exists sales_session_idx on public.sales(session_id);

-- ---------- row level security ----------------------------------------
alter table public.counter_sessions enable row level security;
alter table public.credits enable row level security;
do $$ declare t text; begin
  foreach t in array array['counter_sessions','credits'] loop
    execute format('drop policy if exists "%1$s read" on public.%1$I', t);
    execute format('create policy "%1$s read" on public.%1$I for select to authenticated using (public.is_member())', t);
    execute format('drop policy if exists "%1$s admin write" on public.%1$I', t);
    execute format('create policy "%1$s admin write" on public.%1$I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
-- any seller may open the counter (insert an open session); closing goes through close_session()
drop policy if exists "counter_sessions open" on public.counter_sessions;
create policy "counter_sessions open" on public.counter_sessions for insert to authenticated
  with check (public.is_member() and status = 'open' and closed_at is null);

-- ---------- close the counter ----------------------------------------
-- p = {closed_at, closed_by, closed_by_id, cash, paid_out, mobile:{...}, note, report,
--      credits:[{id,name,amount}], collected:[{credit_id, amount, via}]}
create or replace function public.close_session(p_id text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.counter_sessions; tot numeric; mob numeric := 0; cr numeric := 0; col numeric := 0;
        c jsonb; k text; amt numeric; ts bigint := coalesce((p->>'closed_at')::bigint, public.now_ms());
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  select * into s from public.counter_sessions where id = p_id for update;
  if not found then raise exception 'Counter session not found'; end if;
  if s.status = 'closed' then return jsonb_build_object('status','closed','total',s.total_sales); end if;

  select coalesce(sum((i->>'qty')::numeric * (i->>'price')::numeric),0) into tot
    from public.sales x cross join lateral jsonb_array_elements(x.items) i
   where x.session_id = p_id and x.voided_at is null;

  for k in select jsonb_object_keys(coalesce(p->'mobile','{}'::jsonb)) loop
    mob := mob + coalesce(nullif(p->'mobile'->>k,'')::numeric,0);
  end loop;

  for c in select * from jsonb_array_elements(coalesce(p->'credits','[]'::jsonb)) loop
    amt := coalesce(nullif(c->>'amount','')::numeric,0);
    if amt > 0 and coalesce(trim(c->>'name'),'') <> '' then
      insert into public.credits(id, session_id, date, name, amount, created_at, created_by)
      values (c->>'id', p_id, s.date, trim(c->>'name'), amt, ts, p->>'closed_by')
      on conflict (id) do nothing;
      cr := cr + amt;
    end if;
  end loop;

  for c in select * from jsonb_array_elements(coalesce(p->'collected','[]'::jsonb)) loop
    amt := coalesce(nullif(c->>'amount','')::numeric,0);
    if amt > 0 then
      update public.credits
         set payments = payments || jsonb_build_array(jsonb_build_object('session_id',p_id,'amount',amt,'via',coalesce(c->>'via','Cash'),'ts',ts,'by',p->>'closed_by')),
             paid_amount = paid_amount + amt,
             paid_at = case when paid_amount + amt >= amount then ts else null end
       where id = c->>'credit_id' and paid_at is null
         and not exists (select 1 from jsonb_array_elements(payments) q where q->>'session_id' = p_id);
      if found then col := col + amt; end if;
    end if;
  end loop;

  update public.counter_sessions set
    status = 'closed', closed_at = ts, closed_by = p->>'closed_by', closed_by_id = p->>'closed_by_id',
    total_sales = tot,
    cash = coalesce(nullif(p->>'cash','')::numeric,0),
    paid_out = coalesce(nullif(p->>'paid_out','')::numeric,0),
    mobile = coalesce(p->'mobile','{}'::jsonb),
    credit_total = cr, collected_total = col,
    difference = coalesce(nullif(p->>'cash','')::numeric,0) + coalesce(nullif(p->>'paid_out','')::numeric,0) + mob + cr - col - tot,
    note = nullif(trim(coalesce(p->>'note','')),''),
    report = p->'report'
  where id = p_id;
  return jsonb_build_object('status','closed','total',tot);
end $$;

-- Admin: reopen a closed session (undoes its credits and the debt it collected)
create or replace function public.reopen_session(p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the Admin can reopen a closed counter'; end if;
  delete from public.credits where session_id = p_id and paid_amount = 0;
  update public.credits c set
      payments = coalesce((select jsonb_agg(q) from jsonb_array_elements(c.payments) q where q->>'session_id' <> p_id),'[]'::jsonb),
      paid_amount = coalesce((select sum((q->>'amount')::numeric) from jsonb_array_elements(c.payments) q where q->>'session_id' <> p_id),0),
      paid_at = null
   where exists (select 1 from jsonb_array_elements(c.payments) q where q->>'session_id' = p_id);
  update public.counter_sessions set status = 'open', closed_at = null, closed_by = null, closed_by_id = null,
         total_sales = null, cash = null, paid_out = null, mobile = null, credit_total = null, collected_total = null,
         difference = null, report = null
   where id = p_id;
end $$;

grant execute on function public.close_session(text,jsonb), public.reopen_session(text) to authenticated;
revoke execute on function public.close_session(text,jsonb), public.reopen_session(text) from anon, public;

-- ---------- old open tabs become credits ------------------------------
-- Any sale still "open" (unpaid tab) is moved to the credit list so it can be collected at a close.
insert into public.credits(id, session_id, date, name, amount, created_at, created_by, note)
select 'tab-' || s.id, null, s.date, coalesce(nullif(trim(s.label),''), nullif(trim(s.customer),''), 'Old tab'),
       (select sum((i->>'qty')::numeric * (i->>'price')::numeric) from jsonb_array_elements(s.items) i),
       s.ts, s.by_name, 'Open tab from ' || s.date
  from public.sales s
 where s.status = 'open' and s.voided_at is null
   and (select sum((i->>'qty')::numeric * (i->>'price')::numeric) from jsonb_array_elements(s.items) i) > 0
on conflict (id) do nothing;
update public.sales set status = 'paid', pay = 'Credit list', edited_at = public.now_ms(), edited_by = 'Counter sessions update'
 where status = 'open' and voided_at is null;

-- ---------- live updates ----------------------------------------------
do $$ declare t text; begin
  foreach t in array array['counter_sessions','credits'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- check
select (select count(*) from public.counter_sessions) as sessions,
       (select count(*) from public.credits) as credits,
       (select count(*) from public.sales where status = 'open') as open_tabs_left;
