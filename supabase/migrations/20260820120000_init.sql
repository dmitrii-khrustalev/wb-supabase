-- WB → Supabase: core schema
-- All fact tables are per-seller. Tokens live in Vault / Edge secrets, not here.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Sellers
-- ---------------------------------------------------------------------------
create table public.sellers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_active boolean not null default true,
  history_from date not null default date '2024-01-01',
  created_at timestamptz not null default now()
);

comment on table public.sellers is 'WB кабинеты. Токен: vault secret wb_token_<slug> или Edge secret WB_TOKEN_<SLUG>.';

-- ---------------------------------------------------------------------------
-- Sync queue
-- ---------------------------------------------------------------------------
create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete cascade,
  dataset text not null,
  mode text not null check (mode in ('history', 'daily')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  cursor jsonb not null default '{}'::jsonb,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create unique index sync_jobs_one_active
  on public.sync_jobs (seller_id, dataset, mode)
  where status in ('queued', 'running');

create index sync_jobs_status_created_idx
  on public.sync_jobs (status, created_at);

create table public.sync_state (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  dataset text not null,
  cursor jsonb not null default '{}'::jsonb,
  last_success_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (seller_id, dataset)
);

create table public.load_runs (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references public.sellers(id) on delete set null,
  dataset text not null,
  mode text not null,
  job_id uuid references public.sync_jobs(id) on delete set null,
  rows_in integer not null default 0,
  rows_upserted integer not null default 0,
  error text,
  note text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer
);

create index load_runs_seller_started_idx on public.load_runs (seller_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Analytics
-- ---------------------------------------------------------------------------
create table public.products (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  nm_id text not null,
  vendor_code text,
  title text,
  brand text,
  subject_name text,
  imt_id text,
  barcode text,
  price numeric,
  discounted_price numeric,
  club_discounted_price numeric,
  discount_percent numeric,
  currency text,
  sizes jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, nm_id)
);

create table public.product_sizes (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  chrt_id text not null,
  nm_id text,
  vendor_code text,
  title text,
  brand text,
  subject_name text,
  tech_size text,
  wb_size text,
  skus text,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, chrt_id)
);

create table public.finance_rows (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  rrd_id text not null,
  nm_id text,
  sa_name text,
  barcode text,
  doc_type_name text,
  quantity numeric,
  retail_amount numeric,
  office_name text,
  supplier_oper_name text,
  rr_dt date,
  shk_id text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, rrd_id)
);

create index finance_rows_dt_idx on public.finance_rows (seller_id, rr_dt);

create table public.adv_stats (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  advert_id text not null,
  stat_date date not null,
  app_type text not null default '',
  nm_id text not null default '',
  name text,
  views numeric,
  clicks numeric,
  spend numeric,
  atbs numeric,
  orders numeric,
  shks numeric,
  cpc numeric,
  ctr numeric,
  cr numeric,
  payment_type text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, advert_id, stat_date, app_type, nm_id)
);

create table public.fbo_orders (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  srid text not null,
  order_dt timestamptz,
  last_change_dt timestamptz,
  nm_id text,
  supplier_article text,
  barcode text,
  warehouse_name text,
  total_price numeric,
  finished_price numeric,
  is_cancel boolean,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, srid)
);

create index fbo_orders_dt_idx on public.fbo_orders (seller_id, order_dt);

create table public.fbo_stocks (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  snapshot_date date not null,
  nm_id text not null,
  warehouse_name text not null,
  quantity numeric,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, snapshot_date, nm_id, warehouse_name)
);

create table public.wb_warehouses (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  warehouse_id text not null,
  name text,
  address text,
  work_time text,
  is_active boolean,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, warehouse_id)
);

create table public.transit_tariffs (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  from_warehouse text not null,
  to_warehouse text not null,
  active_from text not null default '',
  pallet_tariff numeric,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, from_warehouse, to_warehouse, active_from)
);

create table public.fbw_supplies (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  supply_id text not null,
  details_loaded boolean not null default false,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, supply_id)
);

create table public.fbw_supply_goods (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  supply_id text not null,
  nm_id text not null default '',
  barcode text not null default '',
  quantity numeric,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, supply_id, nm_id, barcode)
);

-- ---------------------------------------------------------------------------
-- FBS
-- ---------------------------------------------------------------------------
create table public.fbs_warehouses (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  warehouse_id text not null,
  name text,
  office_id text,
  cargo_type integer,
  delivery_type integer,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, warehouse_id)
);

create table public.fbs_offices (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  office_id text not null,
  name text,
  address text,
  city text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, office_id)
);

create table public.fbs_stocks (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  snapshot_date date not null,
  warehouse_id text not null,
  chrt_id text not null,
  amount numeric,
  sku text,
  nm_id text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, snapshot_date, warehouse_id, chrt_id)
);

create table public.fbs_orders (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  order_id text not null,
  rid text,
  order_uid text,
  created_at timestamptz,
  article text,
  nm_id text,
  chrt_id text,
  warehouse_id text,
  supply_id text,
  supplier_status text,
  wb_status text,
  source text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, order_id)
);

create index fbs_orders_created_idx on public.fbs_orders (seller_id, created_at);

create table public.fbs_order_stickers (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  order_id text not null,
  barcode text,
  part_a text,
  part_b text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, order_id)
);

create table public.fbs_order_reshipment (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  order_id text not null,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, order_id)
);

create table public.fbs_order_clients (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  order_id text not null,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, order_id)
);

comment on table public.fbs_order_clients is 'PII (ФИО/телефон). RLS без политик для anon/authenticated.';

create table public.fbs_order_history (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  order_id text not null,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, order_id)
);

create table public.fbs_supplies (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  supply_id text not null,
  name text,
  done boolean,
  details_loaded boolean not null default false,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, supply_id)
);

create table public.fbs_supply_orders (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  supply_id text not null,
  order_id text not null,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, supply_id, order_id)
);

create table public.fbs_supply_trbx (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  supply_id text not null,
  trbx_id text not null,
  barcode text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, supply_id, trbx_id)
);

create table public.fbs_supply_qr (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  supply_id text not null,
  barcode text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, supply_id)
);

-- ---------------------------------------------------------------------------
-- RLS: deny anon/authenticated; service_role bypasses RLS
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'sellers', 'sync_jobs', 'sync_state', 'load_runs',
    'products', 'product_sizes', 'finance_rows', 'adv_stats',
    'fbo_orders', 'fbo_stocks', 'wb_warehouses', 'transit_tariffs',
    'fbw_supplies', 'fbw_supply_goods',
    'fbs_warehouses', 'fbs_offices', 'fbs_stocks', 'fbs_orders',
    'fbs_order_stickers', 'fbs_order_reshipment', 'fbs_order_clients',
    'fbs_order_history', 'fbs_supplies', 'fbs_supply_orders',
    'fbs_supply_trbx', 'fbs_supply_qr'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
