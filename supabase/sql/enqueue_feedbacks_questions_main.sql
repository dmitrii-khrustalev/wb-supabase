select public.enqueue_dataset('feedbacks', 'history', 'main');
select public.enqueue_dataset('questions', 'history', 'main');

select dataset, mode, status, cursor, error, updated_at
from public.sync_jobs
where dataset in ('feedbacks', 'questions')
order by dataset, updated_at desc;
