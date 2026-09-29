-- Узкая таблица кВВ: REST не успевает парсить payload jsonb (~600 МБ) за statement_timeout.
create table if not exists public.finance_kvv (
  rrd_id text primary key,
  rr_dt date,
  ppvz_kvw_prc numeric,
  ppvz_kvw_prc_base numeric
);

create index if not exists finance_kvv_rr_dt_idx on public.finance_kvv (rr_dt);
create index if not exists finance_rows_rr_dt_idx on public.finance_rows (rr_dt);

alter table public.finance_kvv enable row level security;
revoke all on table public.finance_kvv from anon, authenticated;
grant select, insert, update, delete on table public.finance_kvv to service_role;

create or replace function public.refresh_finance_kvv(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  n integer;
begin
  insert into public.finance_kvv (rrd_id, rr_dt, ppvz_kvw_prc, ppvz_kvw_prc_base)
  select
    f.rrd_id,
    f.rr_dt,
    coalesce((f.extra->>'ppvz_kvw_prc')::numeric, (f.payload->>'ppvz_kvw_prc')::numeric),
    coalesce((f.extra->>'ppvz_kvw_prc_base')::numeric, (f.payload->>'ppvz_kvw_prc_base')::numeric)
  from public.finance_rows f
  where f.doc_type_name = U&'\041F\0440\043E\0434\0430\0436\0430'
    and f.rr_dt >= p_from
    and f.rr_dt < p_to
  on conflict (rrd_id) do update set
    rr_dt = excluded.rr_dt,
    ppvz_kvw_prc = excluded.ppvz_kvw_prc,
    ppvz_kvw_prc_base = excluded.ppvz_kvw_prc_base;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.refresh_finance_kvv(date, date) from public;
grant execute on function public.refresh_finance_kvv(date, date) to service_role;

create or replace function public.finance_kvv_page(
  p_from date,
  p_offset integer default 0,
  p_limit integer default 1000
)
returns table(
  rrd_id text,
  ppvz_kvw_prc numeric,
  ppvz_kvw_prc_base numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select k.rrd_id, k.ppvz_kvw_prc, k.ppvz_kvw_prc_base
  from public.finance_kvv k
  where k.rr_dt >= p_from
  order by k.rrd_id
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 1000), 1), 2000);
$$;

revoke all on function public.finance_kvv_page(date, integer, integer) from public;
grant execute on function public.finance_kvv_page(date, integer, integer) to service_role;
