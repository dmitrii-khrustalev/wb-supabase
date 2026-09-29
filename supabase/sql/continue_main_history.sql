-- Продолжение загрузки новых датасетов для кабинета main.
-- План: canvas «13 листов» → сначала history в Postgres, потом листы в GAS main.
-- daily_datasets() НЕ расширяем (DMZ не должен ждать новые API).

-- ── 1. Статус history/daily по новым датасетам ──
with new_ds as (
  select unnest(array[
    'fbo_sales',
    'region_sales',
    'goods_returns',
    'order_feed',
    'feedbacks',
    'questions',
    'tariffs',
    'wb_retentions',
    'warehouse_services',
    'claims',
    'promos'
  ]) as dataset
),
last_jobs as (
  select distinct on (j.dataset, j.mode)
    j.dataset,
    j.mode,
    j.status,
    left(coalesce(j.error, ''), 120) as error,
    j.cursor,
    j.updated_at at time zone 'Europe/Moscow' as updated_msk
  from public.sync_jobs j
  join public.sellers s on s.id = j.seller_id and s.slug = 'main'
  where j.dataset in (select dataset from new_ds)
  order by j.dataset, j.mode, j.updated_at desc
)
select
  d.dataset,
  h.status as history_status,
  h.cursor as history_cursor,
  h.error as history_error,
  h.updated_msk as history_updated,
  dy.status as daily_status,
  dy.updated_msk as daily_updated,
  public.dataset_data_date(
    (select id from public.sellers where slug = 'main'),
    d.dataset
  ) as data_date
from new_ds d
left join last_jobs h on h.dataset = d.dataset and h.mode = 'history'
left join last_jobs dy on dy.dataset = d.dataset and dy.mode = 'daily'
order by d.dataset;

-- ── 2. Сколько строк уже в таблицах ──
select 'fbo_sales' as tbl, count(*) as rows from public.fbo_sales
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'region_sales', count(*) from public.region_sales
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'goods_returns', count(*) from public.goods_returns
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'order_feed', count(*) from public.order_feed
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'feedbacks', count(*) from public.feedbacks
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'questions', count(*) from public.questions
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'tariffs', count(*) from public.tariffs
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'wb_retentions', count(*) from public.wb_retentions
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'warehouse_services', count(*) from public.warehouse_services
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'claims', count(*) from public.claims
where seller_id = (select id from public.sellers where slug = 'main')
union all
select 'promos', count(*) from public.promos
where seller_id = (select id from public.sellers where slug = 'main');

-- ── 3. Поставить history в очередь (раскомментируйте нужные) ──
-- select public.enqueue_dataset('fbo_sales', 'history', 'main');
-- select public.enqueue_dataset('region_sales', 'history', 'main');
-- select public.enqueue_dataset('goods_returns', 'history', 'main');
-- select public.enqueue_dataset('order_feed', 'history', 'main');
-- select public.enqueue_dataset('feedbacks', 'history', 'main');
-- select public.enqueue_dataset('questions', 'history', 'main');
-- select public.enqueue_dataset('tariffs', 'history', 'main');
-- select public.enqueue_dataset('wb_retentions', 'history', 'main');
-- select public.enqueue_dataset('warehouse_services', 'history', 'main');
-- select public.enqueue_dataset('claims', 'history', 'main');
-- select public.enqueue_dataset('promos', 'history', 'main');

-- search_queries отключён (нет Jam, 403). Не ставить в очередь.

-- ── 4. После history = done — разовый daily (по одному) ──
-- select public.enqueue_dataset('fbo_sales', 'daily', 'main');
-- select public.enqueue_dataset('region_sales', 'daily', 'main');
-- ...
