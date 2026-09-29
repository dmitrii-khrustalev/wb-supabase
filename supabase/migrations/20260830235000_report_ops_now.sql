-- Ops dashboards: «чинить» (exceptions) + «остатки» (coverage). Snapshot now, demand = last 7 complete days.

create or replace function public.report_ops_now(p_seller_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '90s'
as $$
  with today as (
    select (timezone('Europe/Moscow', now()))::date as d
  ),
  win as (
    select
      t.d as today,
      t.d - 1 as day_to,
      t.d - 7 as day_from
    from today t
  ),
  daily as (
    select x.*
    from win
    cross join lateral private.info_sku_daily(p_seller_id, win.day_from, win.day_to, null) x
    where x.nm_id ~ '^[1-9]'
  ),
  agg as (
    select
      d.nm_id,
      coalesce(sum(d.qty_net), 0) as qty,
      coalesce(sum(d.qty_sales), 0) as qty_sales,
      coalesce(sum(d.qty_returns), 0) as qty_returns,
      coalesce(sum(d.retail_net), 0) as retail,
      coalesce(sum(d.for_pay), 0) as for_pay,
      coalesce(sum(d.ads_spend), 0) as ads,
      coalesce(sum(d.fbo_orders), 0) as fbo_orders,
      coalesce(sum(d.fbs_orders), 0) as fbs_orders,
      coalesce(sum(d.fbo_cancels + d.fbs_cancels), 0) as cancels
    from daily d
    group by 1
  ),
  cab as (
    select
      coalesce(sum(qty), 0) as qty,
      coalesce(sum(retail), 0) as retail,
      coalesce(sum(for_pay), 0) as for_pay,
      coalesce(sum(ads), 0) as ads,
      coalesce(sum(fbo_orders + fbs_orders), 0) as orders
    from agg
  ),
  last_fbo as (
    select max(snapshot_date) as d
    from public.fbo_stocks
    where seller_id = p_seller_id
  ),
  last_fbs as (
    select max(snapshot_date) as d
    from public.fbs_stocks
    where seller_id = p_seller_id
  ),
  stk_fbo as (
    select
      s.nm_id,
      sum(coalesce(s.quantity, 0)) as qty,
      sum(private.num_text(s.extra->>'inWayToClient')) as in_way_to,
      sum(private.num_text(s.extra->>'inWayFromClient')) as in_way_from
    from public.fbo_stocks s
    join last_fbo l on l.d = s.snapshot_date
    where s.seller_id = p_seller_id
      and s.nm_id ~ '^[1-9]'
    group by 1
  ),
  stk_fbs as (
    select
      coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) as nm_id,
      sum(coalesce(s.amount, 0)) as qty
    from public.fbs_stocks s
    left join public.product_sizes z
      on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
    join last_fbs l on l.d = s.snapshot_date
    where s.seller_id = p_seller_id
      and coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) ~ '^[1-9]'
    group by 1
  ),
  wh as (
    select
      s.nm_id,
      string_agg(s.warehouse_name || ' ' || round(s.qty, 0)::text, ', ' order by s.qty desc) as warehouses
    from (
      select
        s.nm_id,
        s.warehouse_name,
        sum(coalesce(s.quantity, 0)) as qty,
        row_number() over (
          partition by s.nm_id
          order by sum(coalesce(s.quantity, 0)) desc
        ) as rn
      from public.fbo_stocks s
      join last_fbo l on l.d = s.snapshot_date
      where s.seller_id = p_seller_id
        and s.nm_id ~ '^[1-9]'
        and coalesce(s.quantity, 0) > 0
      group by s.nm_id, s.warehouse_name
    ) s
    where s.rn <= 3
    group by 1
  ),
  sup as (
    select
      g.nm_id,
      sum(coalesce(g.quantity, 0)) as qty,
      string_agg(distinct
        case coalesce(s.extra->>'statusID', s.extra->>'statusId')
          when '1' then 'не запланировано'
          when '2' then 'запланировано'
          when '3' then 'отгрузка разрешена'
          when '4' then 'приёмка'
          when '6' then 'на воротах'
          else coalesce(s.extra->>'statusID', s.extra->>'statusId', '')
        end, ', ') as statuses
    from public.fbw_supply_goods g
    join public.fbw_supplies s
      on s.seller_id = g.seller_id and s.supply_id = g.supply_id
    where g.seller_id = p_seller_id
      and g.nm_id ~ '^[1-9]'
      and coalesce(s.extra->>'statusID', s.extra->>'statusId', '') <> '5'
    group by 1
  ),
  wait as (
    select
      o.nm_id,
      count(*)::integer as n,
      count(*) filter (
        where o.created_at < timezone('Europe/Moscow', now()) - interval '2 days'
      )::integer as n_old,
      round(max(extract(epoch from (timezone('Europe/Moscow', now()) - o.created_at)) / 86400.0), 1) as oldest
    from public.fbs_orders o
    where o.seller_id = p_seller_id
      and o.nm_id ~ '^[1-9]'
      and lower(coalesce(o.wb_status, '')) = 'waiting'
    group by 1
  ),
  nms as (
    select nm_id from agg
    union select nm_id from stk_fbo
    union select nm_id from stk_fbs
    union select nm_id from sup
    union select nm_id from wait
  ),
  packed as (
    select
      n.nm_id,
      pr.vendor_code as sa_name,
      pr.title,
      coalesce(a.qty, 0) as qty,
      coalesce(a.qty_sales, 0) as qty_sales,
      coalesce(a.qty_returns, 0) as qty_returns,
      coalesce(a.retail, 0) as retail,
      coalesce(a.for_pay, 0) as for_pay,
      coalesce(a.ads, 0) as ads,
      coalesce(a.fbo_orders + a.fbs_orders, 0) as orders,
      coalesce(a.cancels, 0) as cancels,
      coalesce(sf.qty, 0) as fbo,
      coalesce(ss.qty, 0) as fbs,
      coalesce(sf.qty, 0) + coalesce(ss.qty, 0) as stock,
      coalesce(sf.in_way_to, 0) as in_way_to,
      coalesce(sf.in_way_from, 0) as in_way_from,
      case when coalesce(a.retail, 0) <> 0 then a.ads / a.retail else null end as drr,
      coalesce(a.for_pay, 0) - coalesce(a.ads, 0) as after_ads,
      case
        when coalesce(a.fbo_orders + a.fbs_orders, 0) > 0
          then (coalesce(sf.qty, 0) + coalesce(ss.qty, 0))
            / ((a.fbo_orders + a.fbs_orders)::numeric / 7.0)
        else null
      end as days,
      w.warehouses,
      coalesce(su.qty, 0) as supply_qty,
      su.statuses as supply_status,
      coalesce(wt.n, 0) as wait_n,
      coalesce(wt.n_old, 0) as wait_old,
      wt.oldest as wait_oldest
    from nms n
    left join public.products pr on pr.seller_id = p_seller_id and pr.nm_id = n.nm_id
    left join agg a on a.nm_id = n.nm_id
    left join stk_fbo sf on sf.nm_id = n.nm_id
    left join stk_fbs ss on ss.nm_id = n.nm_id
    left join wh w on w.nm_id = n.nm_id
    left join sup su on su.nm_id = n.nm_id
    left join wait wt on wt.nm_id = n.nm_id
  ),
  labeled as (
    select
      p.*,
      case
        when p.stock <= 0 and p.orders > 0 then 'нет при спросе'
        when p.days is not null and p.days < 7 then 'кончится'
        when p.days is not null and p.days < 21 then 'мало'
        when p.days is not null and p.days <= 60 then 'норма'
        when p.days is not null and p.days > 60 then 'лежит'
        when p.stock > 0 and p.orders <= 0 then 'нет спроса'
        else ''
      end as cover
    from packed p
  ),
  cab_drr as (
    select case when (select retail from cab) <> 0
      then (select ads from cab) / (select retail from cab)
      else null end as v
  ),
  issues as (
    select 1 as prio, 'нет остатка'::text as kind, l.nm_id, l.sa_name, l.title,
      'заказы 7д ' || l.orders::text as detail,
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.stock <= 0 and l.orders > 0
    union all
    select 2, 'остаток <7д', l.nm_id, l.sa_name, l.title,
      round(l.days, 1)::text || ' д · склад ' || round(l.stock, 0)::text,
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.stock > 0 and l.days is not null and l.days < 7
    union all
    select 3, 'FBS ожидает', l.nm_id, l.sa_name, l.title,
      l.wait_old::text || ' шт ≥2д · всего ' || l.wait_n::text || ' · старшему ' || l.wait_oldest::text || 'д',
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.wait_old > 0
    union all
    select 4, 'ДРР×2', l.nm_id, l.sa_name, l.title,
      'ДРР ' || round(l.drr * 100, 1)::text || '% при кабинете ' || round((select v from cab_drr) * 100, 1)::text || '%',
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.retail >= 500
      and l.drr is not null
      and (select v from cab_drr) is not null
      and (select v from cab_drr) > 0
      and l.drr > 2 * (select v from cab_drr)
    union all
    select 5, 'после рекламы <0', l.nm_id, l.sa_name, l.title,
      'к переч. ' || round(l.for_pay, 0)::text || ' − реклама ' || round(l.ads, 0)::text,
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.ads > 0 and l.after_ads < 0
    union all
    select 6, 'возвраты', l.nm_id, l.sa_name, l.title,
      round(l.qty_returns / l.qty_sales * 100, 1)::text || '% · продаж ' || round(l.qty_sales, 0)::text,
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.qty_sales >= 5 and l.qty_returns / l.qty_sales > 0.15
    union all
    select 7, 'отмены', l.nm_id, l.sa_name, l.title,
      round(l.cancels / l.orders * 100, 1)::text || '% · заказы 7д ' || l.orders::text,
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.orders >= 5 and l.cancels / l.orders > 0.20
    union all
    select 8, 'поставка в пути', l.nm_id, l.sa_name, l.title,
      round(l.supply_qty, 0)::text || ' шт · ' || coalesce(l.supply_status, ''),
      l.stock, l.orders, l.days, l.drr, l.after_ads
    from labeled l
    where l.supply_qty > 0
      and (l.stock <= 0 or (l.days is not null and l.days < 14))
  ),
  stock_rows as (
    select l.*
    from labeled l
    where l.stock > 0
       or l.orders > 0
       or l.in_way_to > 0
       or l.in_way_from > 0
       or l.supply_qty > 0
       or l.wait_n > 0
  )
  select jsonb_build_object(
    'today', (select today from win),
    'from', (select day_from from win),
    'to', (select day_to from win),
    'snap_fbo', (select d from last_fbo),
    'snap_fbs', (select d from last_fbs),
    'updated_at', to_char(timezone('Europe/Moscow', now()), 'YYYY-MM-DD HH24:MI'),
    'cab', jsonb_build_object(
      'qty', round((select qty from cab), 2),
      'retail', round((select retail from cab), 2),
      'for_pay', round((select for_pay from cab), 2),
      'ads', round((select ads from cab), 2),
      'orders', (select orders from cab),
      'drr', case when (select v from cab_drr) is not null then round((select v from cab_drr), 4) else null end,
      'fbo', round((select coalesce(sum(fbo), 0) from labeled), 0),
      'fbs', round((select coalesce(sum(fbs), 0) from labeled), 0)
    ),
    'counts', (
      select jsonb_object_agg(k, n)
      from (
        select kind as k, count(*)::int as n from issues group by kind
        union all
        select 'всего', count(*)::int from issues
      ) x
    ),
    'issues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'prio', i.prio,
        'kind', i.kind,
        'nm_id', i.nm_id,
        'sa_name', i.sa_name,
        'title', i.title,
        'detail', i.detail,
        'stock', round(i.stock, 0),
        'orders', i.orders,
        'days', case when i.days is not null then round(i.days, 1) else null end,
        'drr', case when i.drr is not null then round(i.drr, 4) else null end,
        'after_ads', round(i.after_ads, 0)
      ) order by i.prio, i.orders desc, i.sa_name, i.nm_id)
      from issues i
    ), '[]'::jsonb),
    'stocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nm_id', s.nm_id,
        'sa_name', s.sa_name,
        'title', s.title,
        'fbo', round(s.fbo, 0),
        'fbs', round(s.fbs, 0),
        'stock', round(s.stock, 0),
        'in_way_to', round(s.in_way_to, 0),
        'in_way_from', round(s.in_way_from, 0),
        'orders_7d', s.orders,
        'per_day', case when s.orders > 0 then round(s.orders / 7.0, 2) else 0 end,
        'days', case when s.days is not null then round(s.days, 1) else null end,
        'warehouses', s.warehouses,
        'supply_qty', round(s.supply_qty, 0),
        'supply_status', s.supply_status,
        'cover', s.cover
      ) order by
        case s.cover
          when 'нет при спросе' then 1
          when 'кончится' then 2
          when 'мало' then 3
          when 'норма' then 4
          when 'лежит' then 5
          when 'нет спроса' then 6
          else 7
        end,
        s.days nulls last,
        s.sa_name,
        s.nm_id)
      from stock_rows s
    ), '[]'::jsonb)
  );
$$;

comment on function public.report_ops_now(uuid) is
  'Сейчас: исключения к действию и покрытие остатков. Спрос — 7 полных дней.';

revoke all on function public.report_ops_now(uuid) from public;
grant execute on function public.report_ops_now(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
