-- info monthly: same blocks as weekly, calendar month vs previous (equal-length prefix if incomplete).
-- Built from live report_info_weekly so patches (FBS ₽, statuses, journal from first data) stay.

do $migrate$
declare
  src text;
  n int;
begin
  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  src := replace(src, 'report_info_weekly', 'report_info_monthly');
  src := replace(src, 'p_week_end', 'p_month_end');

  src := replace(src, $old$
      coalesce(
        p_month_end,
        (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date
          - extract(isodow from (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date)::int
      ) as raw_end
  ),
  bounds as (
    select
      p.seller_id,
      p.today,
      (date_trunc('week', p.raw_end)::date + 6) as week_end
    from params p
  ),
  meta as (
    select
      b.seller_id,
      b.today,
      b.week_end as day,
      (b.week_end - 6) as week_start,
      (b.week_end - 7) as prev_day,
      (b.week_end - 13) as prev_week_start,
      (b.week_end - 6 - 30) as avg_from,
      (b.week_end - 7) as avg_to,
      least(b.week_end, date_trunc('week', coalesce(private.info_first_data_date(b.seller_id), b.week_end))::date) as journal_from,
$old$, $new$
      p_month_end as raw_end
  ),
  bounds as (
    select
      p.seller_id,
      p.today,
      w.cur_from,
      w.cur_to,
      w.prev_from,
      w.prev_to,
      w.complete
    from params p
    cross join lateral private.info_period_windows('month', 'month', p.raw_end, p.today) w
  ),
  meta as (
    select
      b.seller_id,
      b.today,
      b.cur_to as day,
      b.cur_from as week_start,
      b.prev_to as prev_day,
      b.prev_from as prev_week_start,
      b.complete,
      (b.cur_to - b.cur_from + 1) as period_days,
      (b.cur_from - 90) as avg_from,
      (b.cur_from - 1) as avg_to,
      date_trunc('month', coalesce(private.info_first_data_date(b.seller_id), b.cur_from))::date as journal_from,
$new$);

  if position('info_period_windows' in src) = 0 then
    raise exception 'report_info_monthly: window CTE replace failed';
  end if;

  src := replace(src, '* 7.0 / 30.0', '* (select period_days from meta) / 90.0');
  src := replace(src, 'date_trunc(''week'', g.d)::date as week_start', 'date_trunc(''month'', g.d)::date as week_start');
  src := replace(src, '''week_end'', w.week_start + 6', '''week_end'', (date_trunc(''month'', w.week_start) + interval ''1 month - 1 day'')::date');
  src := replace(src, 'm.today,' || chr(10) || '      m.slug', 'm.today,' || chr(10) || '      m.complete,' || chr(10) || '      m.slug');
  src := replace(src, '''grain'', ''week''', '''grain'', ''month''');
  src := replace(src, '''day'', p.day,', '''day'', p.day, ''complete'', p.complete,');

  execute src;
end
$migrate$;

comment on function public.report_info_monthly(uuid, date) is
  'Сводка info monthly: календарный месяц vs прошлый (неполный — равный префикс). Среднее — 90 дней, приведённое к длине окна.';

revoke all on function public.report_info_monthly(uuid, date) from public;
grant execute on function public.report_info_monthly(uuid, date) to anon, authenticated;

notify pgrst, 'reload schema';
