select public.enqueue_dataset('claims', 'history', 'main');

select dataset, mode, status, cursor from sync_jobs
where dataset = 'claims'
order by updated_at desc;
