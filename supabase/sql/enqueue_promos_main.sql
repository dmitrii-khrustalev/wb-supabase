select public.enqueue_dataset('promos', 'history', 'main');

select dataset, mode, status, cursor from sync_jobs
where dataset = 'promos'
order by updated_at desc;
