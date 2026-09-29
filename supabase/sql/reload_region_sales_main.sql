-- Перезагрузка region_sales: раньше sale_dt = конец 30-дневного окна, не день продажи.
delete from public.region_sales where seller_id = (select id from public.sellers where slug = 'main');

select public.enqueue_dataset('region_sales', 'history', 'main');

select status, cursor from public.sync_jobs where dataset = 'region_sales' and mode = 'history';
