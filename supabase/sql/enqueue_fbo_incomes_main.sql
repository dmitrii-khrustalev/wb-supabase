-- После миграции 20260906230000_fbo_incomes.sql и деплоя sync-tick.

select public.enqueue_dataset('fbo_incomes', 'history', 'main');

select status, cursor, error, updated_at
from public.sync_jobs
where dataset = 'fbo_incomes'
order by updated_at desc
limit 5;

select count(*) from public.fbo_incomes;
