-- Сверка Postgres с Google Sheets за вчера (МСК).
-- Дата: параметр ниже. Сегодня 21.08.2026 → вчера = 2026-08-20.
-- В SQL Editor запускай запросы по одному (последний результат — то, что видишь).

-- 0) Дата сверки
select ((timezone('Europe/Moscow', now()))::date - 1) as yesterday_msk;

-- =============================================================================
-- 1) СВОДКА ЗА ВЧЕРА — это главное, что сравнивать с листами
-- =============================================================================
with p as (
  select ((timezone('Europe/Moscow', now()))::date - 1) as d
)
select * from (
  select
    1 as n,
    'finance / Финансовые_ежедневные'::text as dataset,
    (select count(*) from finance_rows f, p where f.rr_dt = p.d)::numeric as rows_db,
    (select count(*) from finance_rows f, p
      where f.rr_dt = p.d and coalesce(f.doc_type_name, '') <> '')::numeric as rows_like_sheet,
    (select coalesce(sum(quantity), 0) from finance_rows f, p
      where f.rr_dt = p.d and f.doc_type_name = 'Продажа') as qty_sale,
    (select coalesce(sum(retail_amount), 0) from finance_rows f, p
      where f.rr_dt = p.d and f.doc_type_name = 'Продажа') as amount_sale,
    (select coalesce(sum(
      case
        when doc_type_name = 'Продажа' then retail_amount
        when doc_type_name = 'Возврат' then -retail_amount
        else 0
      end
    ), 0) from finance_rows f, p where f.rr_dt = p.d) as amount_signed,
    'Лист: фильтр Дата=вчера, без пустого doc_type_name. Сумма = retail_amount Продажа. GAS не пишет Логистику/хранение.'::text as how
  union all
  select 2, 'adv / Рекламные_расходы',
    (select count(*) from adv_stats a, p where a.stat_date = p.d),
    (select count(*) from adv_stats a, p where a.stat_date = p.d and coalesce(a.nm_id, '') <> ''),
    (select coalesce(sum(clicks), 0) from adv_stats a, p where a.stat_date = p.d),
    (select coalesce(sum(spend), 0) from adv_stats a, p where a.stat_date = p.d),
    (select coalesce(sum(orders), 0) from adv_stats a, p where a.stat_date = p.d),
    'Лист: date или Дата = 20.08.2026. Колонка sum = spend. Не «Расходы рекламы» (это clicks*cpc).'
  union all
  select 3, 'fbo_orders / Заказы',
    (select count(*) from fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date = p.d),
    (select count(*) from fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date = p.d
        and coalesce(o.is_cancel, false) = false),
    (select coalesce(sum(finished_price), 0) from fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date = p.d),
    (select coalesce(sum(total_price), 0) from fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date = p.d),
    (select coalesce(sum(finished_price), 0) from fbo_orders o, p
      where (o.order_dt at time zone 'Europe/Moscow')::date = p.d
        and coalesce(o.is_cancel, false) = false),
    'Лист Заказы, колонка Дата. Сумма finishedPrice / finished_price. Ключ в базе srid, на листе сырой объект API.'
  union all
  select 4, 'fbo_stocks / Остатки',
    (select count(*) from fbo_stocks s, p where s.snapshot_date = p.d),
    (select count(*) from fbo_stocks s, p where s.snapshot_date = p.d and s.quantity > 0),
    (select coalesce(sum(quantity), 0) from fbo_stocks s, p where s.snapshot_date = p.d),
    0, 0,
    'GAS пишет дату ПРОГОНА (часто сегодня). Если утренний крона 21.08 — в листе 21.08. Сверь и ту дату.'
  union all
  select 5, 'fbs_stocks / FBS Остатки',
    (select count(*) from fbs_stocks s, p where s.snapshot_date = p.d),
    (select count(*) from fbs_stocks s, p where s.snapshot_date = p.d and s.amount > 0),
    (select coalesce(sum(amount), 0) from fbs_stocks s, p where s.snapshot_date = p.d),
    0, 0,
    'Книга WB FBS Заказы, лист Остатки или FBS_Остатки, колонка amount.'
) x
order by n;

-- 2) Финансы: что именно за вчера (типы операций)
select
  coalesce(doc_type_name, '(пусто)') as doc_type_name,
  coalesce(supplier_oper_name, '') as supplier_oper_name,
  count(*) as rows,
  sum(quantity) as qty,
  sum(retail_amount) as retail_amount
from public.finance_rows
where rr_dt = ((timezone('Europe/Moscow', now()))::date - 1)
group by 1, 2
order by rows desc;

-- 3) Финансы: топ артикулов продаж
select sa_name, count(*) as rows, sum(quantity) as qty, sum(retail_amount) as retail_amount
from public.finance_rows
where rr_dt = ((timezone('Europe/Moscow', now()))::date - 1)
  and doc_type_name = 'Продажа'
group by sa_name
order by retail_amount desc nulls last
limit 20;

-- 4) FBO заказы: отмены
select
  coalesce(is_cancel, false) as is_cancel,
  count(*) as orders,
  round(sum(finished_price)::numeric, 2) as finished_price,
  round(sum(total_price)::numeric, 2) as total_price
from public.fbo_orders
where (order_dt at time zone 'Europe/Moscow')::date = ((timezone('Europe/Moscow', now()))::date - 1)
group by 1;

-- 5) Реклама по кампаниям
select advert_id, count(*) as rows,
  sum(views) as views, sum(clicks) as clicks,
  round(sum(spend)::numeric, 4) as spend, sum(orders) as orders
from public.adv_stats
where stat_date = ((timezone('Europe/Moscow', now()))::date - 1)
group by advert_id
order by spend desc nulls last;

-- 6) Снимки остатков (все даты, не только вчера)
select 'fbo' as kind, snapshot_date, count(*) as rows, sum(quantity) as qty
from public.fbo_stocks group by 1, 2
union all
select 'fbs', snapshot_date, count(*), sum(amount) from public.fbs_stocks group by 1, 2
order by 2 desc, 1;

-- 7) Справочники / FBS / FBW (без привязки к вчера)
select 'products' as dataset, count(*)::bigint as rows from public.products
union all select 'fbs_orders', count(*) from public.fbs_orders
union all select 'fbs_supplies', count(*) from public.fbs_supplies
union all select 'fbs_supply_orders', count(*) from public.fbs_supply_orders
union all select 'fbw_supplies', count(*) from public.fbw_supplies
union all select 'fbw_supply_goods', count(*) from public.fbw_supply_goods
union all select 'fbs_warehouses', count(*) from public.fbs_warehouses
union all select 'fbs_offices', count(*) from public.fbs_offices;

-- 8) FBS статусы
select
  coalesce(supplier_status, '(null)') as supplier_status,
  coalesce(wb_status, '(null)') as wb_status,
  count(*) as orders
from public.fbs_orders
group by 1, 2
order by orders desc;
