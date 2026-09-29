-- Поставки на склад (statistics incomes). Только wb_datasets, не daily_datasets.

create table public.fbo_incomes (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  income_id text not null,
  income_dt timestamptz,
  last_change_dt timestamptz,
  nm_id text,
  supplier_article text,
  barcode text,
  tech_size text,
  quantity numeric,
  total_price numeric,
  warehouse_name text,
  status_name text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, income_id)
);

comment on table public.fbo_incomes is
  'Поставки на склад FBW (GET /api/v1/supplier/incomes). История + daily через loader fbo_incomes.';

create index fbo_incomes_seller_dt_idx
  on public.fbo_incomes (seller_id, income_dt);

alter table public.fbo_incomes enable row level security;
revoke all on table public.fbo_incomes from anon, authenticated;
grant select, insert, update, delete on table public.fbo_incomes to service_role;

create or replace view public.sheet_fbo_incomes
with (security_invoker = false) as
select
  seller_id,
  income_id,
  income_dt,
  last_change_dt,
  nm_id,
  supplier_article,
  barcode,
  tech_size,
  quantity,
  total_price,
  warehouse_name,
  status_name,
  extra,
  loaded_at
from public.fbo_incomes;

revoke all on table public.sheet_fbo_incomes from public, anon, authenticated;
grant select on table public.sheet_fbo_incomes to anon, authenticated;

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
    'fbo_incomes',
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
    when 'fbo_sales' then
      select max((sale_dt at time zone 'Europe/Moscow')::date)
      into d from public.fbo_sales where seller_id = p_seller_id;
    when 'fbo_incomes' then
      select max((income_dt at time zone 'Europe/Moscow')::date)
      into d from public.fbo_incomes where seller_id = p_seller_id;
    when 'fbo_stocks' then
      select max(snapshot_date) into d from public.fbo_stocks where seller_id = p_seller_id;
    when 'stocks_lk' then
      select max(snapshot_date) into d from public.fbo_stocks_lk where seller_id = p_seller_id;
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

notify pgrst, 'reload schema';
