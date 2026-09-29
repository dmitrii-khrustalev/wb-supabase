-- Отключить search_queries (нет Jam). Запускать в SQL Editor целиком.

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
    'fbo_sales',
    'region_sales',
    'goods_returns',
    'order_feed',
    'feedbacks',
    'questions',
    'tariffs',
    'wb_retentions',
    'fbo_stocks',
    'stocks_lk',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
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
    if ds in ('wb_warehouses', 'transit_tariffs', 'search_queries') then
      continue;
    end if;
    n := n + public.enqueue_one_job(p_seller_id, ds, p_mode);
  end loop;
  return n;
end;
$$;

create or replace function public.retry_failed_jobs(p_mode text default 'daily', p_slug text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;

  with latest as (
    select distinct on (j.seller_id, j.dataset, j.mode) j.id, j.seller_id, j.dataset, j.mode
    from public.sync_jobs j
    where j.status = 'error'
      and j.mode = p_mode
      and j.dataset <> 'search_queries'
      and (p_slug is null or j.seller_id in (select s.id from public.sellers s where s.slug = p_slug))
    order by j.seller_id, j.dataset, j.mode, j.updated_at desc
  )
  update public.sync_jobs j
  set
    status = 'queued',
    cursor = '{}'::jsonb,
    error = null,
    attempts = 0,
    started_at = null,
    finished_at = null
  from latest
  where j.id = latest.id
    and not exists (
      select 1
      from public.sync_jobs a
      where a.seller_id = latest.seller_id
        and a.dataset = latest.dataset
        and a.mode = latest.mode
        and a.status in ('queued', 'running')
    );

  get diagnostics n = row_count;
  return n;
end;
$$;

update public.sync_jobs
set
  status = 'error',
  error = 'disabled: Jam subscription required',
  finished_at = now(),
  updated_at = now()
where dataset = 'search_queries'
  and status in ('queued', 'running');

select dataset, mode, status, error
from public.sync_jobs
where dataset = 'search_queries'
order by mode;

select count(*) as still_in_wb_datasets
from unnest(public.wb_datasets()) d
where d = 'search_queries';
