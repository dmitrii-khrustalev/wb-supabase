select public.enqueue_dataset('region_sales', 'history', 'main');

select status, cursor, updated_at from public.sync_jobs where dataset = 'region_sales' order by updated_at desc limit 3;
