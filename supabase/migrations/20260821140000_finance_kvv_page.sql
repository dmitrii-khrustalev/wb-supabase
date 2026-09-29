-- Тонкая выдача кВВ для подстановки в Google Sheets (без полного payload).
-- «Продажа» задана как U& escape, чтобы не ломалась кодировка CLI.
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
  select
    f.rrd_id,
    coalesce((f.payload->>'ppvz_kvw_prc')::numeric, (f.extra->>'ppvz_kvw_prc')::numeric),
    coalesce((f.payload->>'ppvz_kvw_prc_base')::numeric, (f.extra->>'ppvz_kvw_prc_base')::numeric)
  from public.finance_rows f
  where f.doc_type_name = U&'\041F\0440\043E\0434\0430\0436\0430'
    and f.rr_dt >= p_from
  order by f.rrd_id
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 1000), 1), 2000);
$$;

revoke all on function public.finance_kvv_page(date, integer, integer) from public;
grant execute on function public.finance_kvv_page(date, integer, integer) to service_role;
