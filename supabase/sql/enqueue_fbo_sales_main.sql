-- После миграции 20260906220000_fbo_sales.sql и деплоя edge functions.
-- Только кабинет main; daily_datasets не трогаем.

-- История: loader сам стартует с max(history_from, первая дата заказов/финансов в базе).
select public.enqueue_dataset('fbo_sales', 'history', 'main');

-- 2) После status = done в sync_jobs — разовый daily (или подождать ручного запуска)
-- select public.enqueue_dataset('fbo_sales', 'daily', 'main');

-- Проверка
select mode, status, error, updated_at
from public.sync_jobs
where dataset = 'fbo_sales'
order by updated_at desc
limit 5;

select (sale_dt at time zone 'Europe/Moscow')::date as day, count(*) as rows
from public.fbo_sales
where seller_id = (select id from public.sellers where slug = 'main')
group by 1
order by 1 desc
limit 14;
