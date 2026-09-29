-- Состояние ежедневной выгрузки. Вставить в SQL Editor.

select dataset, mode, status, error, attempts, updated_at
from public.sync_jobs
where mode = 'daily'
order by updated_at desc;

select dataset, mode, rows_in, rows_upserted, error, note, started_at, duration_ms
from public.load_runs
where mode = 'daily'
order by started_at desc
limit 40;

select
  (select max(rr_dt) from public.finance_rows) as finance_last,
  (select max(order_dt) from public.fbo_orders) as fbo_last,
  (select max(snapshot_date) from public.fbo_stocks) as fbo_stocks_last,
  (select max(snapshot_date) from public.fbs_stocks) as fbs_stocks_last,
  (select max(stat_date) from public.adv_stats) as adv_last;

select jobname, schedule, active
from cron.job
where jobname in ('wb-sync-tick', 'wb-enqueue-daily', 'wb-notify-digest');

select id, run_date, status_text, updated_at
from public.sheet_morning;
