-- После миграции 20260904194500_stocks_lk.sql

-- Разовый daily (или дождаться 05:00 МСК)
select public.enqueue_dataset('stocks_lk', 'daily', 'main');

-- Проверка
select snapshot_date, count(*) as rows, count(distinct warehouse_name) as warehouses
from public.fbo_stocks_lk
group by 1
order by 1 desc
limit 10;

select warehouse_name, sum(quantity) as qty
from public.fbo_stocks_lk
where snapshot_date = (select max(snapshot_date) from public.fbo_stocks_lk)
group by 1
order by 2 desc
limit 30;
