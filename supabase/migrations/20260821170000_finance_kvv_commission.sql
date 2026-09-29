-- «Размер кВВ, %» в ЛК = commission_percent, не ppvz_kvw_prc.
alter table public.finance_kvv
  add column if not exists commission_percent numeric;

update public.finance_kvv k
set commission_percent = (f.extra->>'commission_percent')::numeric
from public.finance_rows f
where f.rrd_id = k.rrd_id;

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
  insert into public.finance_kvv (rrd_id, rr_dt, ppvz_kvw_prc, ppvz_kvw_prc_base, commission_percent)
  select
    f.rrd_id,
    f.rr_dt,
    coalesce((f.extra->>'ppvz_kvw_prc')::numeric, (f.payload->>'ppvz_kvw_prc')::numeric),
    coalesce((f.extra->>'ppvz_kvw_prc_base')::numeric, (f.payload->>'ppvz_kvw_prc_base')::numeric),
    coalesce((f.extra->>'commission_percent')::numeric, (f.payload->>'commission_percent')::numeric)
  from public.finance_rows f
  where f.doc_type_name = U&'\041F\0440\043E\0434\0430\0436\0430'
    and f.rr_dt >= p_from
    and f.rr_dt < p_to
  on conflict (rrd_id) do update set
    rr_dt = excluded.rr_dt,
    ppvz_kvw_prc = excluded.ppvz_kvw_prc,
    ppvz_kvw_prc_base = excluded.ppvz_kvw_prc_base,
    commission_percent = excluded.commission_percent;
  get diagnostics n = row_count;
  return n;
end;
$$;

drop function if exists public.finance_kvv_page(date, integer, integer);

create function public.finance_kvv_page(
  p_from date,
  p_offset integer default 0,
  p_limit integer default 1000
)
returns table(
  rrd_id text,
  ppvz_kvw_prc numeric,
  ppvz_kvw_prc_base numeric,
  commission_percent numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select k.rrd_id, k.ppvz_kvw_prc, k.ppvz_kvw_prc_base, k.commission_percent
  from public.finance_kvv k
  where k.rr_dt >= p_from
  order by k.rrd_id
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 1000), 1), 2000);
$$;

revoke all on function public.finance_kvv_page(date, integer, integer) from public;
grant execute on function public.finance_kvv_page(date, integer, integer) to service_role;
