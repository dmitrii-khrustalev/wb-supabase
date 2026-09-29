-- Откат stocks_history, если уже применяли 20260904190000_stocks_history.sql

drop view if exists public.sheet_fbo_stocks_history;
drop table if exists public.fbo_stocks_history;

delete from public.sync_jobs where dataset = 'stocks_history';
delete from public.sync_state where dataset = 'stocks_history';
delete from public.load_runs where dataset = 'stocks_history';

-- Вернуть функции как после миграции воронки (20260904180000)
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
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

create or replace function public.daily_datasets()
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
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

create or replace function public.dataset_data_date(p_seller_id uuid, p_dataset text)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d date;
begin
  case p_dataset
    when 'finance' then
      select max(rr_dt) into d from public.finance_rows where seller_id = p_seller_id;
    when 'adv_stats' then
      select max(stat_date) into d from public.adv_stats where seller_id = p_seller_id;
    when 'fbo_orders' then
      select max((order_dt at time zone 'Europe/Moscow')::date)
      into d from public.fbo_orders where seller_id = p_seller_id;
    when 'fbo_stocks' then
      select max(snapshot_date) into d from public.fbo_stocks where seller_id = p_seller_id;
    when 'fbs_stocks' then
      select max(snapshot_date) into d from public.fbs_stocks where seller_id = p_seller_id;
    when 'fbs_orders' then
      select max((created_at at time zone 'Europe/Moscow')::date)
      into d from public.fbs_orders where seller_id = p_seller_id;
    when 'sales_funnel' then
      select max(stat_date) into d from public.sales_funnel_daily where seller_id = p_seller_id;
    else
      d := null;
  end case;
  return d;
end;
$$;
