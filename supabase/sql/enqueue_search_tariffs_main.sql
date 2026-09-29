select public.enqueue_dataset('search_queries', 'history', 'main');
select public.enqueue_dataset('tariffs', 'history', 'main');

select dataset, mode, status, cursor from sync_jobs
where dataset in ('search_queries', 'tariffs')
order by dataset, updated_at desc;
