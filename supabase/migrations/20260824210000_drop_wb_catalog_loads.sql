-- Stop loading WB warehouses and transit tariffs (API 404). Tables stay.

create or replace function public.wb_datasets()
returns text[]
language sql
immutable
as $$
  select array[
    'products',
    'finance',
    'adv_stats',
    'fbo_orders',
    'fbo_stocks',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies'
  ];
$$;

create or replace function public.enqueue_jobs(p_seller_id uuid, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ds text;
  n integer := 0;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;

  foreach ds in array public.wb_datasets() loop
    n := n + public.enqueue_one_job(p_seller_id, ds, p_mode);
  end loop;
  return n;
end;
$$;

update public.sync_jobs
set
  status = 'done',
  error = 'dataset removed',
  finished_at = coalesce(finished_at, now())
where dataset in ('wb_warehouses', 'transit_tariffs')
  and status in ('queued', 'running', 'error');
