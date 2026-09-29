select public.enqueue_dataset('order_feed', 'history', 'main');

select status, cursor, updated_at from public.sync_jobs where dataset = 'order_feed' order by updated_at desc limit 3;
