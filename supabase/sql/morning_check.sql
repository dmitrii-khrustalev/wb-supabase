-- Утренняя проверка выгрузки WB → Supabase.
-- Вставить в SQL Editor и выполнить целиком (или по блокам).

-- 1) Готовность для GAS
-- DMZ (gas/): 13 core → sheet_dmz_daily_status()
-- main (gas main/): все daily → sheet_daily_status()
select 'dmz' as book, * from public.sheet_dmz_daily_status();
select 'main' as book, * from public.sheet_daily_status();

-- 2) Сводка по core daily: статус, свежесть, дата данных
select *
from public.load_health()
order by slug, dataset;

-- 3) Все daily-джобы кабинета (включая fbo_sales, order_feed и др.)
with p as (
  select
    (timezone('Europe/Moscow', now()))::date as today,
    (timezone('Europe/Moscow', now()))::date - 1 as yesterday
)
select
  s.slug,
  j.dataset,
  j.status,
  left(coalesce(j.error, ''), 100) as error,
  j.updated_at at time zone 'Europe/Moscow' as updated_msk,
  st.last_success_at at time zone 'Europe/Moscow' as success_msk,
  public.dataset_data_date(s.id, j.dataset) as data_date,
  case
    when j.dataset in ('fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products', 'fbs_warehouses', 'fbs_offices')
      then p.today
    else p.yesterday
  end as expected_date
from public.sellers s
cross join p
join public.sync_jobs j on j.seller_id = s.id and j.mode = 'daily'
left join public.sync_state st on st.seller_id = s.id and st.dataset = j.dataset
where s.is_active
order by s.slug, j.status, j.dataset;

-- 4) Ошибки (history + daily)
select
  s.slug,
  j.dataset,
  j.mode,
  j.status,
  j.error,
  j.updated_at at time zone 'Europe/Moscow' as updated_msk
from public.sync_jobs j
join public.sellers s on s.id = j.seller_id
where j.status = 'error'
order by j.updated_at desc;

-- 5) Последние тики загрузки за сегодня (МСК)
select
  lr.dataset,
  lr.mode,
  lr.rows_in,
  lr.rows_upserted,
  left(coalesce(lr.error, lr.note, ''), 80) as note,
  lr.started_at at time zone 'Europe/Moscow' as started_msk,
  lr.duration_ms
from public.load_runs lr
where lr.started_at >= (timezone('Europe/Moscow', now()))::date at time zone 'Europe/Moscow'
order by lr.started_at desc
limit 40;

-- 6) Ключевые даты данных (быстрый взгляд)
select
  s.slug,
  public.dataset_data_date(s.id, 'finance')        as finance,
  public.dataset_data_date(s.id, 'fbo_orders')     as fbo_orders,
  public.dataset_data_date(s.id, 'fbo_sales')      as fbo_sales,
  public.dataset_data_date(s.id, 'order_feed')     as order_feed,
  public.dataset_data_date(s.id, 'region_sales')   as region_sales,
  public.dataset_data_date(s.id, 'goods_returns')  as goods_returns,
  public.dataset_data_date(s.id, 'sales_funnel')   as sales_funnel,
  public.dataset_data_date(s.id, 'fbo_stocks')     as fbo_stocks,
  public.dataset_data_date(s.id, 'stocks_lk')      as stocks_lk,
  public.dataset_data_date(s.id, 'feedbacks')      as feedbacks,
  public.dataset_data_date(s.id, 'tariffs')        as tariffs,
  public.dataset_data_date(s.id, 'wb_retentions')  as wb_retentions
from public.sellers s
where s.is_active
order by s.slug;

-- 7) Cron (sync-tick каждую минуту, enqueue daily в 05:00 МСК)
select jobid, schedule, active, command
from cron.job
order by jobid;

-- 8) Бот: ушло ли утреннее сообщение сегодня
select
  run_date,
  status_text,
  (run_date = (timezone('Europe/Moscow', now()))::date) as is_today,
  position('base_sent' in status_text) > 0 as bot_base_sent,
  position('info_sent' in status_text) > 0 as bot_info_sent,
  updated_at at time zone 'Europe/Moscow' as updated_msk,
  left(daily_text, 200) as preview
from public.sheet_morning;

-- 9) Почему бот ещё молчит: все daily должны уйти из queued/running
select
  count(*) filter (where status in ('queued', 'running')) as open_daily,
  count(*) filter (where status = 'done') as done_daily,
  count(*) filter (where status = 'error') as error_daily,
  count(*) as total_daily
from public.sync_jobs
where mode = 'daily';

-- 10) Cron (должны быть sync-tick, enqueue-daily, notify-digest)
select jobid, jobname, schedule, active
from cron.job
order by jobid;
