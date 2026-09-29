-- Перезапуск tariffs на этапе acceptance после фикса loader.
update public.sync_jobs
set
  status = 'queued',
  cursor = '{"stage": "acceptance", "tariffDt": "2026-09-07"}'::jsonb,
  error = null,
  finished_at = null,
  updated_at = now()
where seller_id = (select id from public.sellers where slug = 'main')
  and dataset = 'tariffs'
  and mode = 'history';

select dataset, mode, status, cursor, left(coalesce(error, ''), 80) err
from public.sync_jobs
where seller_id = (select id from public.sellers where slug = 'main')
  and dataset in ('tariffs', 'wb_retentions', 'search_queries')
order by dataset;
