-- История остатков FBO из Google-листа. Зерно как у API: дата + nm_id + склад.

create table public.fbo_stocks_gas (
  snapshot_date text,
  vendor_code text,
  nm_id text,
  tech_size text,
  warehouse_name text,
  quantity text,
  region text
);

comment on table public.fbo_stocks_gas is
  'Временная таблица под CSV из Apps Script. Нужны: дата, артикул WB, склад, остаток. Размер суммируется.';

alter table public.fbo_stocks_gas enable row level security;
revoke all on table public.fbo_stocks_gas from anon, authenticated;
grant select, insert, update, delete on table public.fbo_stocks_gas to service_role;

create or replace function public.parse_sheet_date(p text)
returns date
language plpgsql
immutable
as $$
declare
  s text := trim(coalesce(p, ''));
begin
  if s = '' then
    return null;
  end if;
  if s ~ '^\d{4}-\d{2}-\d{2}' then
    return left(s, 10)::date;
  end if;
  if s ~ '^\d{1,2}\.\d{1,2}\.\d{4}' then
    return to_date(s, 'DD.MM.YYYY');
  end if;
  if s ~ '^\d{1,2}/\d{1,2}/\d{4}' then
    return to_date(s, 'DD/MM/YYYY');
  end if;
  return null;
end;
$$;

create or replace function public.parse_sheet_num(p text)
returns numeric
language plpgsql
immutable
as $$
declare
  s text := trim(coalesce(p, ''));
begin
  if s = '' then
    return 0;
  end if;
  s := replace(replace(s, ' ', ''), ',', '.');
  if s ~ '^-?[0-9]+(\.[0-9]+)?$' then
    return s::numeric;
  end if;
  return 0;
end;
$$;

create or replace function public.import_fbo_stocks_gas(p_slug text default 'main')
returns table (
  seller_slug text,
  rows_in bigint,
  dates integer,
  rows_upserted integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  n_in bigint;
  n_dates integer;
  n_up integer := 0;
begin
  select id into sid from public.sellers where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;

  select count(*) into n_in from public.fbo_stocks_gas;

  with src as (
    select
      public.parse_sheet_date(g.snapshot_date) as snapshot_date,
      nullif(trim(g.nm_id), '') as nm_id,
      nullif(trim(g.warehouse_name), '') as warehouse_name,
      public.parse_sheet_num(g.quantity) as quantity,
      nullif(trim(g.vendor_code), '') as vendor_code,
      nullif(trim(g.tech_size), '') as tech_size,
      nullif(trim(g.region), '') as region
    from public.fbo_stocks_gas g
  ),
  ok as (
    select * from src
    where snapshot_date is not null
      and nm_id is not null
      and warehouse_name is not null
  ),
  agg as (
    select
      snapshot_date,
      nm_id,
      warehouse_name,
      sum(quantity) as quantity,
      min(vendor_code) as vendor_code,
      min(region) as region,
      jsonb_agg(
        jsonb_build_object('size', tech_size, 'qty', quantity)
        order by tech_size
      ) filter (where tech_size is not null) as sizes
    from ok
    group by snapshot_date, nm_id, warehouse_name
  )
  insert into public.fbo_stocks (
    seller_id, snapshot_date, nm_id, warehouse_name, quantity, extra, payload, loaded_at
  )
  select
    sid,
    a.snapshot_date,
    a.nm_id,
    a.warehouse_name,
    a.quantity,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'gas_history',
      'vendor_code', a.vendor_code,
      'region', a.region,
      'sizes', a.sizes
    )),
    '{}'::jsonb,
    now()
  from agg a
  on conflict (seller_id, snapshot_date, nm_id, warehouse_name) do update set
    quantity = excluded.quantity,
    extra = public.fbo_stocks.extra || excluded.extra,
    loaded_at = now();

  get diagnostics n_up = row_count;

  select count(distinct public.parse_sheet_date(snapshot_date))::integer
    into n_dates
  from public.fbo_stocks_gas
  where public.parse_sheet_date(snapshot_date) is not null;

  seller_slug := p_slug;
  rows_in := n_in;
  dates := n_dates;
  rows_upserted := n_up;
  return next;
end;
$$;

revoke all on function public.parse_sheet_date(text) from public, anon, authenticated;
revoke all on function public.parse_sheet_num(text) from public, anon, authenticated;
revoke all on function public.import_fbo_stocks_gas(text) from public, anon, authenticated;
grant execute on function public.parse_sheet_date(text) to service_role;
grant execute on function public.parse_sheet_num(text) to service_role;
grant execute on function public.import_fbo_stocks_gas(text) to service_role;
grant execute on function public.import_fbo_stocks_gas(text) to postgres;
