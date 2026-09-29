-- product_prices: доступ и load_health, но отдельного WB-job нет (снимок пишет products).

create or replace function public.enqueue_one_job(p_seller_id uuid, p_dataset text, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reused uuid;
  inserted integer;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;
  if p_dataset = 'product_prices' then
    return 0;
  end if;
  if not (p_dataset = any (public.wb_datasets())) then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  if exists (
    select 1
    from public.sync_jobs
    where seller_id = p_seller_id
      and dataset = p_dataset
      and mode = p_mode
      and status in ('queued', 'running')
  ) then
    return 0;
  end if;

  if p_mode = 'daily' then
    update public.sync_jobs j
    set
      status = 'queued',
      cursor = '{}'::jsonb,
      error = null,
      attempts = 0,
      started_at = null,
      finished_at = null
    where j.id = (
      select s.id
      from public.sync_jobs s
      where s.seller_id = p_seller_id
        and s.dataset = p_dataset
        and s.mode = 'daily'
        and s.status in ('done', 'error')
      order by s.created_at desc
      limit 1
    )
    returning j.id into reused;

    if reused is not null then
      return 1;
    end if;
  end if;

  insert into public.sync_jobs (seller_id, dataset, mode, status)
  values (p_seller_id, p_dataset, p_mode, 'queued')
  on conflict (seller_id, dataset, mode) where status in ('queued', 'running')
  do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
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
    if ds in ('wb_warehouses', 'transit_tariffs', 'search_queries', 'product_prices') then
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
      and j.dataset not in ('search_queries', 'product_prices')
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

delete from public.sync_jobs
where dataset = 'product_prices';

create or replace function public.dataset_primary_table(p_dataset text)
returns text
language sql
immutable
as $$
  select case p_dataset
    when 'products' then 'products'
    when 'product_prices' then 'product_prices_daily'
    when 'finance' then 'finance_rows'
    when 'adv_stats' then 'adv_stats'
    when 'fbo_orders' then 'fbo_orders'
    when 'fbo_sales' then 'fbo_sales'
    when 'region_sales' then 'region_sales'
    when 'goods_returns' then 'goods_returns'
    when 'order_feed' then 'order_feed'
    when 'feedbacks' then 'feedbacks'
    when 'questions' then 'questions'
    when 'search_queries' then 'search_queries'
    when 'tariffs' then 'tariffs'
    when 'wb_retentions' then 'wb_retentions'
    when 'warehouse_services' then 'warehouse_services'
    when 'claims' then 'claims'
    when 'promos' then 'promos'
    when 'fbo_stocks' then 'fbo_stocks'
    when 'stocks_lk' then 'fbo_stocks_lk'
    when 'fbw_supplies' then 'fbw_supplies'
    when 'fbs_warehouses' then 'fbs_warehouses'
    when 'fbs_offices' then 'fbs_offices'
    when 'fbs_stocks' then 'fbs_stocks'
    when 'fbs_orders' then 'fbs_orders'
    when 'fbs_supplies' then 'fbs_supplies'
    when 'sales_funnel' then 'sales_funnel_daily'
    else null
  end;
$$;

notify pgrst, 'reload schema';
