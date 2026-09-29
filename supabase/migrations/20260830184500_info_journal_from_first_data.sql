-- Info journal starts at first real data for the seller, not a hardcoded 2026-03-16.

create or replace function private.info_first_data_date(p_seller_id uuid)
returns date
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select min(x.d)
  from (
    select min(rr_dt) as d
    from public.finance_rows
    where seller_id = p_seller_id
    union all
    select min(stat_date)
    from public.adv_stats
    where seller_id = p_seller_id
    union all
    select min((order_dt at time zone 'Europe/Moscow')::date)
    from public.fbo_orders
    where seller_id = p_seller_id
    union all
    select min((created_at at time zone 'Europe/Moscow')::date)
    from public.fbs_orders
    where seller_id = p_seller_id
    union all
    select min(snapshot_date)
    from public.fbo_stocks
    where seller_id = p_seller_id
    union all
    select min(snapshot_date)
    from public.fbs_stocks
    where seller_id = p_seller_id
  ) x;
$$;

revoke all on function private.info_first_data_date(uuid) from public;

do $patch$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);
  if src not like '%least(p.day, date ''2026-03-16'')%' then
    raise exception 'report_info_daily: journal_from pattern not found';
  end if;
  src := replace(
    src,
    'least(p.day, date ''2026-03-16'')',
    'least(p.day, coalesce(private.info_first_data_date(p.seller_id), p.day))'
  );
  execute src;

  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  if src not like '%least(date ''2026-03-16'', b.week_end - 6 - 30)%' then
    raise exception 'report_info_weekly: journal_from pattern not found';
  end if;
  src := replace(
    src,
    'least(date ''2026-03-16'', b.week_end - 6 - 30)',
    'least(b.week_end, date_trunc(''week'', coalesce(private.info_first_data_date(b.seller_id), b.week_end))::date)'
  );
  execute src;
end
$patch$;

comment on function public.report_info_daily(uuid, date, integer) is
  'Сводка для листа info: KPI, блоки, журнал по дням с первой даты, где есть данные.';

comment on function public.report_info_weekly(uuid, date) is
  'Сводка для листа info weekly: неделя пн–вс, журнал с первой недели, где есть данные.';

notify pgrst, 'reload schema';
