select public.enqueue_dataset('warehouse_services', 'history', 'main');

select dataset, mode, status, cursor from sync_jobs
where dataset = 'warehouse_services'
order by updated_at desc;
