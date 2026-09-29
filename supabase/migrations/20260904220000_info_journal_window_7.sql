-- info daily/weekly/monthly: не сканировать всю историю — макс. 7 периодов в RPC.
-- Старую историю держит лист (GAS); база далеко назад не пересчитывается.

do $patch_daily$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);

  if src like '%as scan_from,%' then
    raise notice 'report_info_daily: already patched';
    return;
  end if;

  src := replace(src,
    'least(p.day, coalesce(private.info_first_data_date(p.seller_id), p.day)) as journal_from,',
    $m$(p.day - 7) as scan_from,
      greatest(
        p.day - (greatest(coalesce(p_journal_days, 7), 1) - 1),
        p.day - 7
      ) as journal_from,$m$
  );
  src := replace(src,
    'least(p.day, date ''2026-03-16'') as journal_from,',
    $m$(p.day - 7) as scan_from,
      greatest(
        p.day - (greatest(coalesce(p_journal_days, 7), 1) - 1),
        p.day - 7
      ) as journal_from,$m$
  );

  if src not like '%as scan_from,%' then
    raise exception 'report_info_daily: journal_from pattern not found';
  end if;

  src := replace(src,
    'generate_series(m.journal_from, m.day, ''1 day''::interval)::date as d',
    'generate_series(m.scan_from, m.day, ''1 day''::interval)::date as d'
  );
  src := replace(src, 'f.rr_dt >= m.journal_from', 'f.rr_dt >= m.scan_from');
  src := replace(src, 'a.stat_date >= m.journal_from', 'a.stat_date >= m.scan_from');
  src := replace(src, 'where o.order_dt >= (m.journal_from::timestamp', 'where o.order_dt >= (m.scan_from::timestamp');
  src := replace(src,
    'and (o.created_at at time zone ''Europe/Moscow'')::date >= m.journal_from',
    'and (o.created_at at time zone ''Europe/Moscow'')::date >= m.scan_from'
  );
  src := replace(src, 's.snapshot_date >= m.journal_from', 's.snapshot_date >= m.scan_from');

  src := replace(src,
    $j$        ) order by g.d desc), '[]'::jsonb)
        from grid g
      ) as journal$j$,
    $j$        ) order by g.d desc), '[]'::jsonb)
        from grid g
        cross join meta jm
        where g.d >= jm.journal_from
      ) as journal$j$
  );

  execute src;
end
$patch_daily$;

do $patch_weekly$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);

  if src like '%as scan_from,%' then
    raise notice 'report_info_weekly: already patched';
    return;
  end if;

  src := replace(src,
    'least(b.week_end, date_trunc(''week'', coalesce(private.info_first_data_date(b.seller_id), b.week_end))::date) as journal_from,',
    $m$(b.week_end - 6 - 30) as scan_from,
      (b.week_end - 48) as journal_from,$m$
  );
  src := replace(src,
    'least(date ''2026-03-16'', b.week_end - 6 - 30) as journal_from,',
    $m$(b.week_end - 6 - 30) as scan_from,
      (b.week_end - 48) as journal_from,$m$
  );

  if src not like '%as scan_from,%' then
    raise exception 'report_info_weekly: journal_from pattern not found';
  end if;

  src := replace(src,
    'generate_series(m.journal_from, m.day, ''1 day''::interval)::date as d',
    'generate_series(m.scan_from, m.day, ''1 day''::interval)::date as d'
  );
  src := replace(src, 'f.rr_dt >= m.journal_from', 'f.rr_dt >= m.scan_from');
  src := replace(src, 'a.stat_date >= m.journal_from', 'a.stat_date >= m.scan_from');
  src := replace(src, 'where o.order_dt >= (m.journal_from::timestamp', 'where o.order_dt >= (m.scan_from::timestamp');
  src := replace(src,
    'and (o.created_at at time zone ''Europe/Moscow'')::date >= m.journal_from',
    'and (o.created_at at time zone ''Europe/Moscow'')::date >= m.scan_from'
  );
  src := replace(src, 's.snapshot_date >= m.journal_from', 's.snapshot_date >= m.scan_from');

  src := replace(src,
    $j$          from grid g
          group by 1
        ) w
      ) as journal$j$,
    $j$          from grid g
          group by 1
        ) w
        where w.week_start >= (select journal_from from meta)
      ) as journal$j$
  );

  execute src;
end
$patch_weekly$;

do $patch_monthly$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_monthly(uuid, date)'::regprocedure);

  if src like '%as scan_from,%' then
    raise notice 'report_info_monthly: already patched';
    return;
  end if;

  src := replace(src,
    'date_trunc(''month'', coalesce(private.info_first_data_date(b.seller_id), b.cur_from))::date as journal_from,',
    $m$(b.cur_from - 90) as scan_from,
      greatest(
        (date_trunc('month', b.cur_to)::date - interval '6 months')::date,
        b.cur_from - 90
      ) as journal_from,$m$
  );

  if src not like '%as scan_from,%' then
    raise exception 'report_info_monthly: journal_from pattern not found';
  end if;

  src := replace(src,
    'generate_series(m.journal_from, m.day, ''1 day''::interval)::date as d',
    'generate_series(m.scan_from, m.day, ''1 day''::interval)::date as d'
  );
  src := replace(src, 'f.rr_dt >= m.journal_from', 'f.rr_dt >= m.scan_from');
  src := replace(src, 'a.stat_date >= m.journal_from', 'a.stat_date >= m.scan_from');
  src := replace(src, 'where o.order_dt >= (m.journal_from::timestamp', 'where o.order_dt >= (m.scan_from::timestamp');
  src := replace(src,
    'and (o.created_at at time zone ''Europe/Moscow'')::date >= m.journal_from',
    'and (o.created_at at time zone ''Europe/Moscow'')::date >= m.scan_from'
  );
  src := replace(src, 's.snapshot_date >= m.journal_from', 's.snapshot_date >= m.scan_from');

  src := replace(src,
    $j$          from grid g
          group by 1
        ) w
        where w.week_start >= (select journal_from from meta)
      ) as journal$j$,
    $j$          from grid g
          group by 1
        ) w
        where w.week_start >= (select journal_from from meta)
      ) as journal$j$
  );

  execute src;
end
$patch_monthly$;

comment on function public.report_info_daily(uuid, date, integer) is
  'info daily: KPI за ~8 дней, журнал в RPC — хвост 7 дней (p_journal_days). Полная история — на листе.';

notify pgrst, 'reload schema';
