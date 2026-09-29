-- Info: сумма и средняя цена заказов FBS (Цена API) в daily/weekly.

do $patch$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);
  if src like '%as fbs_sum%' then
    raise exception 'report_info_daily: fbs_sum already patched';
  end if;

  src := replace(src,
    'count(*) as orders,',
    'count(*) as orders,
      coalesce(sum(private.num_text(o.extra->>''price'')), 0) as order_sum,');
  src := replace(src,
    'coalesce(b.orders, 0) as fbs_orders,',
    'coalesce(b.orders, 0) as fbs_orders,
      coalesce(b.order_sum, 0) as fbs_sum,');
  src := replace(src,
    'avg(g.fbs_orders) as fbs_orders,',
    'avg(g.fbs_orders) as fbs_orders,
      avg(g.fbs_sum) as fbs_sum,');
  src := replace(src,
    'c.fbs_orders,',
    'c.fbs_orders,
      c.fbs_sum,');
  src := replace(src,
    'p.fbs_orders as fbs_prev,',
    'p.fbs_orders as fbs_prev,
      p.fbs_sum as fbs_sum_prev,');
  src := replace(src,
    'a.fbs_orders as fbs_avg7,',
    'a.fbs_orders as fbs_avg7,
      a.fbs_sum as fbs_sum_avg7,');
  src := replace(src,
    '''waiting_avg7'', round(coalesce(p.fbs_waiting_avg7, 0), 1),
      ''statuses_7d'', p.fbs_statuses',
    '''waiting_avg7'', round(coalesce(p.fbs_waiting_avg7, 0), 1),
      ''sum'', round(coalesce(p.fbs_sum, 0), 2),
      ''sum_prev'', round(coalesce(p.fbs_sum_prev, 0), 2),
      ''sum_avg7'', round(coalesce(p.fbs_sum_avg7, 0), 2),
      ''statuses_7d'', p.fbs_statuses');
  execute src;

  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  if src like '%as fbs_sum%' then
    raise exception 'report_info_weekly: fbs_sum already patched';
  end if;

  src := replace(src,
    'count(*) as orders,',
    'count(*) as orders,
      coalesce(sum(private.num_text(o.extra->>''price'')), 0) as order_sum,');
  src := replace(src,
    'coalesce(b.orders, 0) as fbs_orders,',
    'coalesce(b.orders, 0) as fbs_orders,
      coalesce(b.order_sum, 0) as fbs_sum,');
  src := replace(src,
    'sum(g.fbs_orders) as fbs_orders,',
    'sum(g.fbs_orders) as fbs_orders,
      sum(g.fbs_sum) as fbs_sum,');
  src := replace(src,
    'sum(g.fbs_orders) * 7.0 / 30.0 as fbs_orders,',
    'sum(g.fbs_orders) * 7.0 / 30.0 as fbs_orders,
      sum(g.fbs_sum) * 7.0 / 30.0 as fbs_sum,');
  src := replace(src,
    'c.fbs_orders,',
    'c.fbs_orders,
      c.fbs_sum,');
  src := replace(src,
    'p.fbs_orders as fbs_prev,',
    'p.fbs_orders as fbs_prev,
      p.fbs_sum as fbs_sum_prev,');
  src := replace(src,
    'a.fbs_orders as fbs_avg7,',
    'a.fbs_orders as fbs_avg7,
      a.fbs_sum as fbs_sum_avg7,');
  src := replace(src,
    '''waiting_avg7'', round(coalesce(p.fbs_waiting_avg7, 0), 1),
      ''statuses_7d'', p.fbs_statuses',
    '''waiting_avg7'', round(coalesce(p.fbs_waiting_avg7, 0), 1),
      ''sum'', round(coalesce(p.fbs_sum, 0), 2),
      ''sum_prev'', round(coalesce(p.fbs_sum_prev, 0), 2),
      ''sum_avg7'', round(coalesce(p.fbs_sum_avg7, 0), 2),
      ''statuses_7d'', p.fbs_statuses');
  execute src;
end
$patch$;

notify pgrst, 'reload schema';
