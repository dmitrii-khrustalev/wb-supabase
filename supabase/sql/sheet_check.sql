-- Сверка views для тестового Sheets с базовыми таблицами.
-- Запускай запросы по одному в SQL Editor.

-- 0) Views на месте, payload нет
select
  c.relname as view_name,
  count(*) filter (where a.attname = 'payload') as payload_cols,
  count(*) as cols
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public'
  and c.relkind = 'v'
  and c.relname like 'sheet_%'
group by 1
order by 1;

-- 1) Строки view = строки таблицы (без фильтра)
select * from (
  select 'finance_rows'::text as t,
    (select count(*) from public.finance_rows) as table_rows,
    (select count(*) from public.sheet_finance_rows) as view_rows
  union all select 'adv_stats',
    (select count(*) from public.adv_stats),
    (select count(*) from public.sheet_adv_stats)
  union all select 'fbo_orders',
    (select count(*) from public.fbo_orders),
    (select count(*) from public.sheet_fbo_orders)
  union all select 'fbo_stocks',
    (select count(*) from public.fbo_stocks),
    (select count(*) from public.sheet_fbo_stocks)
  union all select 'products',
    (select count(*) from public.products),
    (select count(*) from public.sheet_products)
  union all select 'product_sizes',
    (select count(*) from public.product_sizes),
    (select count(*) from public.sheet_product_sizes)
  union all select 'fbw_supplies',
    (select count(*) from public.fbw_supplies),
    (select count(*) from public.sheet_fbw_supplies)
  union all select 'fbw_supply_goods',
    (select count(*) from public.fbw_supply_goods),
    (select count(*) from public.sheet_fbw_supply_goods)
  union all select 'fbw',
    (select count(*) from public.fbw_supplies s
      left join public.fbw_supply_goods g
        on g.seller_id = s.seller_id and g.supply_id = s.supply_id),
    (select count(*) from public.sheet_fbw)
  union all select 'fbs_stocks',
    (select count(*) from public.fbs_stocks),
    (select count(*) from public.sheet_fbs_stocks)
  union all select 'fbs_orders',
    (select count(*) from public.fbs_orders),
    (select count(*) from public.sheet_fbs_orders)
  union all select 'fbs_warehouses',
    (select count(*) from public.fbs_warehouses),
    (select count(*) from public.sheet_fbs_warehouses)
  union all select 'fbs_offices',
    (select count(*) from public.fbs_offices),
    (select count(*) from public.sheet_fbs_offices)
  union all select 'fbs_order_stickers',
    (select count(*) from public.fbs_order_stickers),
    (select count(*) from public.sheet_fbs_order_stickers)
  union all select 'fbs_supplies',
    (select count(*) from public.fbs_supplies),
    (select count(*) from public.sheet_fbs_supplies)
  union all select 'fbs_supply_orders',
    (select count(*) from public.fbs_supply_orders),
    (select count(*) from public.sheet_fbs_supply_orders)
  union all select 'fbs_supply_trbx',
    (select count(*) from public.fbs_supply_trbx),
    (select count(*) from public.sheet_fbs_supply_trbx)
) x
order by t;

-- 2) Окна как на _Настройки (МСК). С этим сверять count на тестовых листах.
with p as (
  select
    (timezone('Europe/Moscow', now()))::date as today,
    ((timezone('Europe/Moscow', now()))::date - 14) as d14,
    ((timezone('Europe/Moscow', now()))::date - 7) as d7,
    ((timezone('Europe/Moscow', now()))::date - 30) as d30
)
select * from (
  select 1 as n, 'Рекламные_расходы 14д'::text as sheet,
    (select count(*) from public.sheet_adv_stats a, p where a.stat_date >= p.d14) as rows,
    (select coalesce(sum(spend), 0) from public.sheet_adv_stats a, p where a.stat_date >= p.d14) as metric
  union all
  select 2, 'Заказы 14д',
    (select count(*) from public.sheet_fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date >= p.d14),
    (select coalesce(sum(finished_price), 0) from public.sheet_fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date >= p.d14)
  union all
  select 3, 'Финансовые_ежедневные 14д',
    (select count(*) from public.sheet_finance_rows f, p where f.rr_dt >= p.d14),
    (select coalesce(sum(retail_amount), 0) from public.sheet_finance_rows f, p where f.rr_dt >= p.d14)
  union all
  select 4, 'Остатки 7д',
    (select count(*) from public.sheet_fbo_stocks s, p where s.snapshot_date >= p.d7),
    (select coalesce(sum(quantity), 0) from public.sheet_fbo_stocks s, p where s.snapshot_date >= p.d7)
  union all
  select 5, 'FBS_Заказы 30д',
    (select count(*) from public.sheet_fbs_orders o, p
      where (o.created_at at time zone 'Europe/Moscow')::date >= p.d30),
    0
  union all
  select 6, 'Товары все',
    (select count(*) from public.sheet_products),
    0
) y
order by n;

-- 3) Вчера без фильтров (тест должен совпасть с таблицей, не с боевым GAS)
with p as (
  select ((timezone('Europe/Moscow', now()))::date - 1) as d
)
select
  (select count(*) from public.finance_rows f, p where f.rr_dt = p.d) as finance_all,
  (select count(*) from public.adv_stats a, p where a.stat_date = p.d) as adv_all,
  (select count(*) from public.fbo_orders o, p
    where (o.order_dt at time zone 'Europe/Moscow')::date = p.d) as fbo_orders_all;
