-- Отзывы и вопросы: feedbacks-api.wildberries.ru. Только wb_datasets, не daily_datasets.

create table public.feedbacks (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  feedback_id text not null,
  feedback_dt timestamptz,
  nm_id text,
  supplier_article text,
  product_name text,
  brand_name text,
  product_valuation numeric,
  text text,
  pros text,
  cons text,
  state text,
  is_answered boolean,
  answer_text text,
  user_name text,
  order_status text,
  was_viewed boolean,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, feedback_id)
);

comment on table public.feedbacks is
  'Отзывы покупателей (GET /api/v1/feedbacks, /api/v1/feedbacks/archive).';

create index feedbacks_seller_dt_idx
  on public.feedbacks (seller_id, feedback_dt desc);

create index feedbacks_seller_nm_idx
  on public.feedbacks (seller_id, nm_id, feedback_dt desc);

alter table public.feedbacks enable row level security;
revoke all on table public.feedbacks from anon, authenticated;
grant select, insert, update, delete on table public.feedbacks to service_role;

create or replace view public.sheet_feedbacks
with (security_invoker = false) as
select
  seller_id,
  feedback_id,
  feedback_dt,
  nm_id,
  supplier_article,
  product_name,
  brand_name,
  product_valuation,
  text,
  pros,
  cons,
  state,
  is_answered,
  answer_text,
  user_name,
  order_status,
  was_viewed,
  extra,
  loaded_at
from public.feedbacks;

revoke all on table public.sheet_feedbacks from public, anon, authenticated;
grant select on table public.sheet_feedbacks to anon, authenticated;

create table public.questions (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  question_id text not null,
  question_dt timestamptz,
  nm_id text,
  supplier_article text,
  product_name text,
  brand_name text,
  text text,
  state text,
  is_answered boolean,
  answer_text text,
  was_viewed boolean,
  is_warned boolean,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, question_id)
);

comment on table public.questions is
  'Вопросы покупателей (GET /api/v1/questions).';

create index questions_seller_dt_idx
  on public.questions (seller_id, question_dt desc);

create index questions_seller_nm_idx
  on public.questions (seller_id, nm_id, question_dt desc);

alter table public.questions enable row level security;
revoke all on table public.questions from anon, authenticated;
grant select, insert, update, delete on table public.questions to service_role;

create or replace view public.sheet_questions
with (security_invoker = false) as
select
  seller_id,
  question_id,
  question_dt,
  nm_id,
  supplier_article,
  product_name,
  brand_name,
  text,
  state,
  is_answered,
  answer_text,
  was_viewed,
  is_warned,
  extra,
  loaded_at
from public.questions;

revoke all on table public.sheet_questions from public, anon, authenticated;
grant select on table public.sheet_questions to anon, authenticated;

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
    when 'region_sales' then
      select max((sale_dt at time zone 'Europe/Moscow')::date)
      into d from public.region_sales where seller_id = p_seller_id;
    when 'goods_returns' then
      select max((order_dt at time zone 'Europe/Moscow')::date)
      into d from public.goods_returns where seller_id = p_seller_id;
    when 'order_feed' then
      select max((status_updated_at at time zone 'Europe/Moscow')::date)
      into d from public.order_feed where seller_id = p_seller_id;
    when 'feedbacks' then
      select max((feedback_dt at time zone 'Europe/Moscow')::date)
      into d from public.feedbacks where seller_id = p_seller_id;
    when 'questions' then
      select max((question_dt at time zone 'Europe/Moscow')::date)
      into d from public.questions where seller_id = p_seller_id;
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
