-- Снять search_queries из очереди (нет Jam → 403).
update public.sync_jobs
set
  status = 'error',
  error = 'skipped: Jam subscription required (403)',
  finished_at = now(),
  updated_at = now()
where seller_id = (select id from public.sellers where slug = 'main')
  and dataset = 'search_queries'
  and mode = 'history'
  and status in ('queued', 'running');

select dataset, mode, status, error
from public.sync_jobs
where seller_id = (select id from public.sellers where slug = 'main')
  and dataset in ('search_queries', 'tariffs', 'wb_retentions')
order by dataset;
