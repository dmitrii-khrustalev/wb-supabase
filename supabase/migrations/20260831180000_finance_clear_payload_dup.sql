-- finance_rows.payload дублировал typed-колонки + extra (~245 MB).
-- Проверено: ни один ключ payload не отсутствует в extra.
-- Лист/отчёты читают колонки и extra; payload в view не отдаётся.
-- Колонку не дропаем: NOT NULL default '{}', лоадер пишет {}.

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
    (f.extra->>'ppvz_kvw_prc')::numeric,
    (f.extra->>'ppvz_kvw_prc_base')::numeric,
    (f.extra->>'commission_percent')::numeric
  from public.finance_rows f
  where f.doc_type_name = 'Продажа'
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

comment on column public.finance_rows.payload is
  'Deprecated duplicate of typed columns + extra. Loader writes {}. Kept NOT NULL for upsert compatibility.';

update public.finance_rows
set payload = '{}'::jsonb
where payload <> '{}'::jsonb;
