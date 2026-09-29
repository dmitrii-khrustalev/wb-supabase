select public.enqueue_dataset('goods_returns', 'history', 'main');

select status, cursor, updated_at from public.sync_jobs where dataset = 'goods_returns' order by updated_at desc limit 3;
