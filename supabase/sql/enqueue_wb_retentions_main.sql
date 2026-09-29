select public.enqueue_dataset('wb_retentions', 'history', 'main');

select dataset, mode, status, cursor from sync_jobs
where dataset = 'wb_retentions'
order by updated_at desc;
