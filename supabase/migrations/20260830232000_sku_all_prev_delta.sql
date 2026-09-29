-- sku all: prev + delta for period metrics (not snapshot stock/days/flags).

create or replace function public.report_info_sku_all(
  p_seller_id uuid,
  p_anchor date default null,
  p_grain text default 'day',
  p_compare text default 'day'
)
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
  w as (
    select * from private.info_period_windows(p_grain, p_compare, p_anchor, (select d from today))
  ),
  daily as (
    select x.* from w
    cross join lateral private.info_sku_daily(p_seller_id, least(w.prev_from, w.cur_from), w.cur_to, null) x
  ),
  cur as (
    select d.nm_id,
      coalesce(sum(d.qty_net), 0) as qty_net,
      coalesce(sum(d.qty_sales), 0) as qty_sales,
      coalesce(sum(d.qty_returns), 0) as qty_returns,
      coalesce(sum(d.retail_net), 0) as retail_net,
      coalesce(sum(d.for_pay), 0) as for_pay,
      coalesce(sum(d.ads_spend), 0) as ads_spend,
      coalesce(sum(d.fbo_orders), 0) as fbo_orders,
      coalesce(sum(d.fbs_orders), 0) as fbs_orders,
      coalesce(sum(d.fbo_cancels + d.fbs_cancels), 0) as cancels
    from daily d join w on true
    where d.d >= w.cur_from and d.d <= w.cur_to
    group by 1
  ),
  prev as (
    select d.nm_id,
      coalesce(sum(d.qty_net), 0) as qty_net,
      coalesce(sum(d.retail_net), 0) as retail_net,
      coalesce(sum(d.for_pay), 0) as for_pay,
      coalesce(sum(d.ads_spend), 0) as ads_spend,
      coalesce(sum(d.fbo_orders + d.fbs_orders), 0) as orders,
      coalesce(sum(d.fbo_cancels + d.fbs_cancels), 0) as cancels
    from daily d join w on true
    where d.d >= w.prev_from and d.d <= w.prev_to
    group by 1
  ),
  last_fbo as (
    select nm_id, max(snapshot_date) as d from public.fbo_stocks where seller_id = p_seller_id group by 1
  ),
  last_fbs as (
    select coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) as nm_id, max(s.snapshot_date) as d
    from public.fbs_stocks s
    left join public.product_sizes z on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
    where s.seller_id = p_seller_id and coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) is not null
    group by 1
  ),
  stk_fbo as (
    select s.nm_id, sum(coalesce(s.quantity, 0)) as qty
    from public.fbo_stocks s
    join last_fbo l on l.nm_id = s.nm_id and l.d = s.snapshot_date
    where s.seller_id = p_seller_id group by 1
  ),
  stk_fbs as (
    select coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) as nm_id, sum(coalesce(s.amount, 0)) as qty
    from public.fbs_stocks s
    left join public.product_sizes z on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
    join last_fbs l on l.nm_id = coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) and l.d = s.snapshot_date
    where s.seller_id = p_seller_id group by 1
  ),
  nms as (
    select p.nm_id from public.products p
    where p.seller_id = p_seller_id and p.nm_id ~ '^[1-9]'
    union select nm_id from cur where nm_id ~ '^[1-9]'
    union select nm_id from prev where nm_id ~ '^[1-9]'
    union select nm_id from stk_fbo where nm_id ~ '^[1-9]'
    union select nm_id from stk_fbs where nm_id ~ '^[1-9]'
  ),
  cab as (
    select coalesce(sum(qty_net), 0) as qty, coalesce(sum(retail_net), 0) as retail,
      coalesce(sum(for_pay), 0) as for_pay, coalesce(sum(ads_spend), 0) as ads,
      coalesce(sum(fbo_orders + fbs_orders), 0) as orders from cur
  ),
  cab_prev as (
    select coalesce(sum(qty_net), 0) as qty, coalesce(sum(retail_net), 0) as retail,
      coalesce(sum(for_pay), 0) as for_pay, coalesce(sum(ads_spend), 0) as ads,
      coalesce(sum(orders), 0) as orders from prev
  ),
  packed as (
    select n.nm_id, pr.vendor_code as sa_name, pr.title,
      coalesce(c.qty_net, 0) as qty, coalesce(pv.qty_net, 0) as qty_prev,
      coalesce(c.qty_returns, 0) as qty_returns, coalesce(c.qty_sales, 0) as qty_sales,
      coalesce(c.retail_net, 0) as retail, coalesce(pv.retail_net, 0) as retail_prev,
      coalesce(c.for_pay, 0) as for_pay, coalesce(pv.for_pay, 0) as for_pay_prev,
      coalesce(c.ads_spend, 0) as ads, coalesce(pv.ads_spend, 0) as ads_prev,
      coalesce(c.fbo_orders + c.fbs_orders, 0) as orders, coalesce(pv.orders, 0) as orders_prev,
      coalesce(c.cancels, 0) as cancels, coalesce(pv.cancels, 0) as cancels_prev,
      coalesce(sf.qty, 0) as fbo_stock, coalesce(ss.qty, 0) as fbs_stock,
      case when coalesce(c.retail_net, 0) <> 0 then coalesce(c.ads_spend, 0) / c.retail_net else null end as drr,
      case when coalesce(pv.retail_net, 0) <> 0 then coalesce(pv.ads_spend, 0) / pv.retail_net else null end as drr_prev,
      coalesce(c.for_pay, 0) - coalesce(c.ads_spend, 0) as after_ads,
      coalesce(pv.for_pay, 0) - coalesce(pv.ads_spend, 0) as after_ads_prev,
      case when coalesce(c.fbo_orders + c.fbs_orders, 0) > 0 then
        (coalesce(sf.qty, 0) + coalesce(ss.qty, 0))
        / ((c.fbo_orders + c.fbs_orders)::numeric / greatest((select (cur_to - cur_from) + 1 from w), 1))
      else null end as days_left,
      case when (select retail from cab) <> 0 then coalesce(c.retail_net, 0) / (select retail from cab) else null end as share,
      case when (select retail from cab_prev) <> 0 then coalesce(pv.retail_net, 0) / (select retail from cab_prev) else null end as share_prev
    from nms n
    left join public.products pr on pr.seller_id = p_seller_id and pr.nm_id = n.nm_id
    left join cur c on c.nm_id = n.nm_id
    left join prev pv on pv.nm_id = n.nm_id
    left join stk_fbo sf on sf.nm_id = n.nm_id
    left join stk_fbs ss on ss.nm_id = n.nm_id
  ),
  flagged as (
    select p.*,
      nullif(concat_ws(', ',
        case when p.fbo_stock + p.fbs_stock <= 0 and p.orders > 0 then 'нет остатка' end,
        case when p.retail > 0 and p.drr is not null and (select retail from cab) > 0
          and p.drr > 2 * ((select ads from cab) / (select retail from cab)) then 'ДРР×2' end,
        case when p.retail_prev > 0 and p.retail <= p.retail_prev * 0.5 then '−50% выр.' end,
        case when p.qty_sales > 0 and p.qty_returns / p.qty_sales > 0.15 then 'возвраты' end,
        case when p.retail_prev > 0 and p.retail >= p.retail_prev * 1.3
          and (p.drr_prev is null or p.drr is null or p.drr <= p.drr_prev) then 'рост' end,
        case when p.days_left is not null and p.days_left < 7 then 'остаток <7д' end,
        case when p.after_ads < 0 then 'после рекламы <0' end,
        case when p.qty_prev = 0 and p.qty > 0 then 'новый' end
      ), '') as flags
    from packed p
  )
  select jsonb_build_object(
    'grain', (select grain from w), 'compare', (select compare from w), 'complete', (select complete from w),
    'cur_from', (select cur_from from w), 'cur_to', (select cur_to from w),
    'prev_from', (select prev_from from w), 'prev_to', (select prev_to from w),
    'today', (select d from today),
    'updated_at', to_char(timezone('Europe/Moscow', now()), 'YYYY-MM-DD HH24:MI'),
    'cab', jsonb_build_object(
      'qty', round((select qty from cab), 2), 'qty_prev', round((select qty from cab_prev), 2),
      'retail', round((select retail from cab), 2), 'retail_prev', round((select retail from cab_prev), 2),
      'for_pay', round((select for_pay from cab), 2), 'for_pay_prev', round((select for_pay from cab_prev), 2),
      'ads', round((select ads from cab), 2), 'ads_prev', round((select ads from cab_prev), 2),
      'orders', (select orders from cab), 'orders_prev', (select orders from cab_prev),
      'drr', case when (select retail from cab) <> 0 then round((select ads from cab) / (select retail from cab), 4) else null end,
      'drr_prev', case when (select retail from cab_prev) <> 0 then round((select ads from cab_prev) / (select retail from cab_prev), 4) else null end
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nm_id', f.nm_id, 'sa_name', f.sa_name, 'title', f.title,
        'qty', round(f.qty, 2), 'qty_prev', round(f.qty_prev, 2),
        'retail', round(f.retail, 2), 'retail_prev', round(f.retail_prev, 2),
        'for_pay', round(f.for_pay, 2), 'for_pay_prev', round(f.for_pay_prev, 2),
        'ads', round(f.ads, 2), 'ads_prev', round(f.ads_prev, 2),
        'drr', case when f.drr is not null then round(f.drr, 4) else null end,
        'drr_prev', case when f.drr_prev is not null then round(f.drr_prev, 4) else null end,
        'after_ads', round(f.after_ads, 2), 'after_ads_prev', round(f.after_ads_prev, 2),
        'orders', f.orders, 'orders_prev', f.orders_prev,
        'cancels', f.cancels, 'cancels_prev', f.cancels_prev,
        'fbo_stock', round(f.fbo_stock, 0), 'fbs_stock', round(f.fbs_stock, 0),
        'days', case when f.days_left is not null then round(f.days_left, 1) else null end,
        'share', case when f.share is not null then round(f.share, 4) else null end,
        'share_prev', case when f.share_prev is not null then round(f.share_prev, 4) else null end,
        'flags', f.flags
      ) order by f.retail desc, f.sa_name, f.nm_id)
      from flagged f
    ), '[]'::jsonb)
  );
$$;

comment on function public.report_info_sku_all(uuid, date, text, text) is
  'Рейтинг всех товаров: период-метрики с prev, остатки/дни/флаги — снимок.';

revoke all on function public.report_info_sku_all(uuid, date, text, text) from public;
grant execute on function public.report_info_sku_all(uuid, date, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
