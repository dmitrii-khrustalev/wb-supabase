-- Справочник объединения складов. Факты (finance / заказы / поставки) не меняем.
-- Утро: DISTINCT новых имён + автосклейка. Поставка читает canonical через JOIN.

create table public.warehouse_merge_rule (
  alias_norm text primary key,
  canonical text not null
);

comment on table public.warehouse_merge_rule is
  'Явные алиасы WB → канон. Утро не перезаписывает, только применяет к новым именам.';

insert into public.warehouse_merge_rule (alias_norm, canonical) values
  ('спб шушары', 'Склад Шушары'),
  ('склад шушары', 'Склад Шушары'),
  ('шушары', 'Склад Шушары'),
  ('самара (новосемейкино)', 'Новосемейкино'),
  ('новосемейкино', 'Новосемейкино'),
  ('краснодар', 'Краснодар (Тихорецкая)'),
  ('краснодар (тихорецкая)', 'Краснодар (Тихорецкая)');

create table public.warehouse_region_rule (
  city_norm text primary key,
  region text not null
);

comment on table public.warehouse_region_rule is
  'Город в имени склада (после warehouse_norm) → регион поставки. Утро подставляет, не перезаписывает.';

insert into public.warehouse_region_rule (city_norm, region) values
  ('коледино', 'Центральный'),
  ('электросталь', 'Центральный'),
  ('ногинск', 'Центральный'),
  ('пушкино', 'Центральный'),
  ('истра', 'Центральный'),
  ('радумля', 'Центральный'),
  ('вешки', 'Центральный'),
  ('белая дача', 'Центральный'),
  ('тула', 'Центральный'),
  ('твер', 'Центральный'),
  ('рязань', 'Центральный'),
  ('владимир', 'Центральный'),
  ('воронеж', 'Центральный'),
  ('котовск', 'Центральный'),
  ('москва', 'Центральный'),
  ('внуково', 'Центральный'),
  ('домодедово', 'Центральный'),
  ('сынково', 'Центральный'),
  ('софьино', 'Центральный'),
  ('ярославль', 'Центральный'),
  ('курск', 'Центральный'),
  ('скотопрогонная', 'Центральный'),
  ('шушары', 'Северо-Западный'),
  ('санкт-петербург', 'Северо-Западный'),
  ('петербург', 'Северо-Западный'),
  ('спб', 'Северо-Западный'),
  ('калининград', 'Северо-Западный'),
  ('архангельск', 'Северо-Западный'),
  ('вологда', 'Северо-Западный'),
  ('красный бор', 'Северо-Западный'),
  ('московское шоссе', 'Северо-Западный'),
  ('казань', 'Приволжский'),
  ('новосемейкино', 'Приволжский'),
  ('самара', 'Приволжский'),
  ('сарапул', 'Приволжский'),
  ('пенза', 'Приволжский'),
  ('ульяновск', 'Приволжский'),
  ('нижний новгород', 'Приволжский'),
  ('кудьма', 'Приволжский'),
  ('киров', 'Приволжский'),
  ('саранск', 'Приволжский'),
  ('краснодар', 'Южный и Северо-Кавказский'),
  ('тихорецк', 'Южный и Северо-Кавказский'),
  ('невинномысск', 'Южный и Северо-Кавказский'),
  ('крыловская', 'Южный и Северо-Кавказский'),
  ('тахтамукай', 'Южный и Северо-Кавказский'),
  ('волгоград', 'Южный и Северо-Кавказский'),
  ('екатеринбург', 'Уральский'),
  ('челябинск', 'Уральский'),
  ('тюмень', 'Уральский'),
  ('нижний тагил', 'Уральский'),
  ('сургут', 'Уральский'),
  ('перспективная', 'Уральский'),
  ('новосибирск', 'Дальневосточный и Сибирский'),
  ('красноярск', 'Дальневосточный и Сибирский'),
  ('омск', 'Дальневосточный и Сибирский'),
  ('барнаул', 'Дальневосточный и Сибирский'),
  ('кемерово', 'Дальневосточный и Сибирский'),
  ('томск', 'Дальневосточный и Сибирский'),
  ('абакан', 'Дальневосточный и Сибирский'),
  ('владивосток', 'Дальневосточный и Сибирский'),
  ('братск', 'Дальневосточный и Сибирский'),
  ('улан-удэ', 'Дальневосточный и Сибирский'),
  ('хабаровск', 'Дальневосточный и Сибирский'),
  ('минск', 'Беларусь'),
  ('бобруйск', 'Беларусь'),
  ('орша', 'Беларусь'),
  ('брест', 'Беларусь'),
  ('гомель', 'Беларусь'),
  ('гродно', 'Беларусь'),
  ('хатежино', 'Беларусь'),
  ('астана', 'Казахстан'),
  ('алматы', 'Казахстан'),
  ('актобе', 'Казахстан'),
  ('карагандинское', 'Казахстан'),
  ('ереван', 'Армения'),
  ('wb', 'Склад WB'),
  ('федеральный округ', 'Центральный');

create table public.warehouse_dict (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  alias text not null,
  canonical text not null,
  warehouse_id text,
  region text,
  kind text not null default 'wb' check (kind in ('wb', 'fbs', 'service')),
  locked boolean not null default false,
  how text not null default 'auto',
  first_seen date not null default ((timezone('Europe/Moscow', now()))::date),
  last_seen date not null default ((timezone('Europe/Moscow', now()))::date),
  updated_at timestamptz not null default now(),
  primary key (seller_id, alias)
);

create index warehouse_dict_canonical_idx
  on public.warehouse_dict (seller_id, canonical);
create index warehouse_dict_whid_idx
  on public.warehouse_dict (seller_id, warehouse_id)
  where warehouse_id is not null;

comment on table public.warehouse_dict is
  'Каждое имя WB как в выгрузке → канон + регион + id поставки. locked = не менять канон утром.';

alter table public.warehouse_merge_rule enable row level security;
alter table public.warehouse_dict enable row level security;
alter table public.warehouse_region_rule enable row level security;
revoke all on table public.warehouse_merge_rule from anon, authenticated;
revoke all on table public.warehouse_dict from anon, authenticated;
revoke all on table public.warehouse_region_rule from anon, authenticated;
create policy deny_anon_authenticated on public.warehouse_merge_rule
  for all to anon, authenticated using (false) with check (false);
create policy deny_anon_authenticated on public.warehouse_dict
  for all to anon, authenticated using (false) with check (false);
create policy deny_anon_authenticated on public.warehouse_region_rule
  for all to anon, authenticated using (false) with check (false);

create or replace function public.warehouse_norm(p text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(translate(btrim(coalesce(p, '')), 'Ёё', 'Ее')),
        '\s+', ' ', 'g'
      ),
      '[«»""]', '', 'g'
    ),
    '^(склад |сц |ск |виртуальный |пфц )+',
    '',
    'g'
  );
$$;

create or replace function public.warehouse_dict_kind(p_alias text, p_src text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when p_src = 'fbs' then 'fbs'
    when lower(btrim(p_alias)) in (
      'склад wb',
      'склад wb рф',
      'склад поставщика - везу на склад wb'
    ) then 'service'
    when lower(btrim(p_alias)) like '%федеральный округ%' then 'service'
    else 'wb'
  end;
$$;

create or replace function public.warehouse_region_guess(p_alias text, p_canonical text)
returns text
language sql
stable
parallel safe
set search_path = public
as $$
  select rr.region
  from public.warehouse_region_rule rr
  where position(rr.city_norm in public.warehouse_norm(p_canonical)) > 0
     or position(rr.city_norm in public.warehouse_norm(p_alias)) > 0
     or position(rr.city_norm in lower(translate(btrim(coalesce(p_canonical, '')), 'Ёё', 'Ее'))) > 0
     or position(rr.city_norm in lower(translate(btrim(coalesce(p_alias, '')), 'Ёё', 'Ее'))) > 0
  order by length(rr.city_norm) desc
  limit 1;
$$;

create or replace function public.warehouse_dict_refresh(p_seller_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_ins int := 0;
  n_seen int := 0;
  n_merged int := 0;
  new_names text[] := '{}';
begin
  create temp table if not exists _wh_obs (
    alias text primary key,
    warehouse_id text,
    src text
  ) on commit drop;
  truncate _wh_obs;

  insert into _wh_obs (alias, warehouse_id, src)
  select btrim(office_name), null, 'finance'
  from public.finance_rows
  where seller_id = p_seller_id
    and doc_type_name = 'Продажа'
    and nullif(btrim(office_name), '') is not null
  on conflict (alias) do nothing;

  insert into _wh_obs (alias, warehouse_id, src)
  select btrim(warehouse_name), null, 'orders'
  from public.fbo_orders
  where seller_id = p_seller_id
    and nullif(btrim(warehouse_name), '') is not null
  on conflict (alias) do nothing;

  insert into _wh_obs (alias, warehouse_id, src)
  select
    btrim(coalesce(extra->>'warehouseName', extra->>'actualWarehouseName')),
    min(nullif(btrim(coalesce(extra->>'warehouseID', extra->>'warehouseId', extra->>'actualWarehouseID')), '')),
    'fbw'
  from public.fbw_supplies
  where seller_id = p_seller_id
    and nullif(btrim(coalesce(extra->>'warehouseName', extra->>'actualWarehouseName')), '') is not null
  group by 1
  on conflict (alias) do update
    set warehouse_id = coalesce(excluded.warehouse_id, _wh_obs.warehouse_id);

  insert into _wh_obs (alias, warehouse_id, src)
  select btrim(name), warehouse_id, 'fbs'
  from public.fbs_warehouses
  where seller_id = p_seller_id
    and nullif(btrim(name), '') is not null
  on conflict (alias) do nothing;

  update public.warehouse_dict d
  set
    last_seen = (timezone('Europe/Moscow', now()))::date,
    warehouse_id = coalesce(d.warehouse_id, o.warehouse_id),
    updated_at = now()
  from _wh_obs o
  where d.seller_id = p_seller_id
    and d.alias = o.alias;
  get diagnostics n_seen = row_count;

  insert into public.warehouse_dict (
    seller_id, alias, canonical, warehouse_id, region, kind, locked, how
  )
  select
    p_seller_id,
    o.alias,
    r.canonical,
    coalesce(o.warehouse_id, sib.warehouse_id),
    sib.region,
    public.warehouse_dict_kind(o.alias, o.src),
    true,
    'rule'
  from _wh_obs o
  left join public.warehouse_dict d
    on d.seller_id = p_seller_id and d.alias = o.alias
  join lateral (
    select r.canonical
    from public.warehouse_merge_rule r
    where r.alias_norm in (public.warehouse_norm(o.alias), lower(btrim(o.alias)))
    order by length(r.alias_norm) desc
    limit 1
  ) r on true
  left join lateral (
    select x.warehouse_id, x.region
    from public.warehouse_dict x
    where x.seller_id = p_seller_id
      and x.canonical = r.canonical
      and (x.warehouse_id is not null or x.region is not null)
    order by x.warehouse_id nulls last, x.region nulls last
    limit 1
  ) sib on true
  where d.alias is null
  on conflict (seller_id, alias) do nothing;
  get diagnostics n_ins = row_count;
  n_merged := n_ins;

  insert into public.warehouse_dict (
    seller_id, alias, canonical, warehouse_id, region, kind, locked, how
  )
  select
    p_seller_id,
    o.alias,
    sib.canonical,
    coalesce(o.warehouse_id, sib.warehouse_id),
    sib.region,
    public.warehouse_dict_kind(o.alias, o.src),
    false,
    'id'
  from _wh_obs o
  left join public.warehouse_dict d
    on d.seller_id = p_seller_id and d.alias = o.alias
  join lateral (
    select x.canonical, x.warehouse_id, x.region
    from public.warehouse_dict x
    where x.seller_id = p_seller_id
      and o.warehouse_id is not null
      and x.warehouse_id = o.warehouse_id
    limit 1
  ) sib on true
  where d.alias is null
  on conflict (seller_id, alias) do nothing;
  get diagnostics n_ins = row_count;
  n_merged := n_merged + n_ins;

  insert into public.warehouse_dict (
    seller_id, alias, canonical, warehouse_id, region, kind, locked, how
  )
  select
    p_seller_id,
    o.alias,
    o.alias,
    o.warehouse_id,
    null,
    public.warehouse_dict_kind(o.alias, o.src),
    false,
    'auto'
  from _wh_obs o
  left join public.warehouse_dict d
    on d.seller_id = p_seller_id and d.alias = o.alias
  where d.alias is null
  on conflict (seller_id, alias) do nothing;
  get diagnostics n_ins = row_count;

  update public.warehouse_dict d
  set
    canonical = g.canonical,
    warehouse_id = coalesce(d.warehouse_id, g.warehouse_id),
    region = coalesce(d.region, g.region),
    how = case when d.how = 'auto' then 'name' else d.how end,
    updated_at = now()
  from (
    select
      canonical,
      public.warehouse_norm(canonical) as nrm,
      min(warehouse_id) as warehouse_id,
      min(region) as region,
      count(*) over (partition by public.warehouse_norm(canonical)) as n_groups
    from public.warehouse_dict
    where seller_id = p_seller_id
      and kind = 'wb'
      and canonical !~* '^виртуальный'
    group by canonical
  ) g
  where d.seller_id = p_seller_id
    and not d.locked
    and g.n_groups = 1
    and public.warehouse_norm(d.alias) = g.nrm
    and d.canonical is distinct from g.canonical;

  select coalesce(array_agg(d.alias order by d.alias), '{}')
  into new_names
  from public.warehouse_dict d
  where d.seller_id = p_seller_id
    and d.how = 'auto'
    and d.first_seen = (timezone('Europe/Moscow', now()))::date
    and d.canonical = d.alias;

  update public.warehouse_dict d
  set warehouse_id = s.wid, updated_at = now()
  from (
    select seller_id, canonical, min(warehouse_id) as wid
    from public.warehouse_dict
    where seller_id = p_seller_id and warehouse_id is not null
    group by 1, 2
  ) s
  where d.seller_id = s.seller_id
    and d.canonical = s.canonical
    and d.warehouse_id is null;

  update public.warehouse_dict d
  set region = public.warehouse_region_guess(d.alias, d.canonical),
      updated_at = now()
  where d.seller_id = p_seller_id
    and d.region is null
    and public.warehouse_region_guess(d.alias, d.canonical) is not null;

  update public.warehouse_dict d
  set region = s.region, updated_at = now()
  from (
    select seller_id, canonical, min(region) as region
    from public.warehouse_dict
    where seller_id = p_seller_id and region is not null
    group by 1, 2
  ) s
  where d.seller_id = s.seller_id
    and d.canonical = s.canonical
    and d.region is null;

  return jsonb_build_object(
    'seller_id', p_seller_id,
    'seen', n_seen,
    'merged', n_merged,
    'inserted_new', n_ins,
    'new_unmatched', new_names
  );
end;
$$;

create or replace function public.warehouse_dict_refresh_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  acc jsonb := '[]'::jsonb;
  one jsonb;
begin
  for r in select id from public.sellers where is_active loop
    one := public.warehouse_dict_refresh(r.id);
    acc := acc || jsonb_build_array(one);
  end loop;
  return jsonb_build_object('sellers', acc);
end;
$$;

create or replace function public.warehouse_dict_set_region(
  p_seller_id uuid,
  p_canonical text,
  p_region text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.warehouse_dict
  set region = nullif(btrim(p_region), ''),
      updated_at = now()
  where seller_id = p_seller_id
    and canonical = p_canonical;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace view public.sheet_warehouse_dict
with (security_invoker = false) as
select
  seller_id,
  alias,
  canonical,
  warehouse_id,
  region,
  kind,
  locked,
  how,
  first_seen,
  last_seen
from public.warehouse_dict;

comment on view public.sheet_warehouse_dict is
  'Справочник складов для листа. Регион править в warehouse_dict / warehouse_dict_set_region.';

revoke all on table public.sheet_warehouse_dict from public, anon, authenticated;
grant select on table public.sheet_warehouse_dict to anon, authenticated;

revoke all on function public.warehouse_norm(text) from public, anon, authenticated;
grant execute on function public.warehouse_norm(text) to anon, authenticated, service_role;

revoke all on function public.warehouse_dict_kind(text, text) from public, anon, authenticated;
grant execute on function public.warehouse_dict_kind(text, text) to service_role;

revoke all on function public.warehouse_region_guess(text, text) from public, anon, authenticated;
grant execute on function public.warehouse_region_guess(text, text) to service_role;

create or replace function public.warehouse_dict_fill_region()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.region is null then
    new.region := public.warehouse_region_guess(new.alias, new.canonical);
  end if;
  return new;
end;
$$;

drop trigger if exists warehouse_dict_fill_region_trg on public.warehouse_dict;
create trigger warehouse_dict_fill_region_trg
before insert or update of alias, canonical, region on public.warehouse_dict
for each row execute function public.warehouse_dict_fill_region();

revoke all on function public.warehouse_dict_fill_region() from public, anon, authenticated;

revoke all on function public.warehouse_dict_refresh(uuid) from public, anon, authenticated;
grant execute on function public.warehouse_dict_refresh(uuid) to service_role;

revoke all on function public.warehouse_dict_refresh_all() from public, anon, authenticated;
grant execute on function public.warehouse_dict_refresh_all() to service_role;

revoke all on function public.warehouse_dict_set_region(uuid, text, text) from public, anon, authenticated;
grant execute on function public.warehouse_dict_set_region(uuid, text, text) to service_role;

-- Поставка_2: канон и регион из справочника, сырые имена в фактах не трогаем.
drop function if exists public.report_postavka_2(uuid, date, date, date, date);

create or replace function public.report_postavka_2(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_supply_from date,
  p_supply_to date
)
returns table (
  sa_name text,
  title text,
  warehouse_name text,
  region text,
  orders_qty numeric,
  stock_qty numeric,
  in_transit_qty numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with par as (
    select
      p_seller_id as seller_id,
      p_from as d_from,
      p_to as d_to,
      p_supply_from as s_from,
      p_supply_to as s_to
  ),
  last_stock as (
    select max(s.snapshot_date) as d
    from public.fbo_stocks s
    join par on s.seller_id = par.seller_id
  ),
  stock_raw as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendor_code'), ''),
        nullif(btrim(s.extra->>'vendorCode'), '')
      ))), 'Х', 'X') as sa_name,
      coalesce(nullif(btrim(s.warehouse_name), ''), 'Не указан') as alias,
      max(nullif(btrim(p.title), '')) as title,
      sum(coalesce(s.quantity, 0))::numeric as qty
    from public.fbo_stocks s
    join par on s.seller_id = par.seller_id
    join last_stock l on s.snapshot_date = l.d
    left join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where nullif(replace(upper(btrim(coalesce(
      nullif(btrim(p.vendor_code), ''),
      nullif(btrim(s.extra->>'vendor_code'), ''),
      nullif(btrim(s.extra->>'vendorCode'), '')
    ))), 'Х', 'X'), '') is not null
    group by 1, 2
  ),
  stock as (
    select
      r.sa_name,
      coalesce(d.canonical, r.alias) as warehouse_name,
      max(d.region) as region,
      max(r.title) as title,
      sum(r.qty) as qty
    from stock_raw r
    left join public.warehouse_dict d
      on d.seller_id = p_seller_id and d.alias = r.alias
    group by 1, 2
  ),
  orders_raw as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.supplier_article), '')
      ))), 'Х', 'X') as sa_name,
      coalesce(nullif(btrim(o.warehouse_name), ''), 'Не указан') as alias,
      max(nullif(btrim(p.title), '')) as title,
      count(*)::numeric as qty
    from public.fbo_orders o
    join par on o.seller_id = par.seller_id
    left join public.products p
      on p.seller_id = o.seller_id
     and p.nm_id = o.nm_id
    where o.order_dt >= (par.d_from::timestamp at time zone 'Europe/Moscow')
      and o.order_dt < ((par.d_to + 1)::timestamp at time zone 'Europe/Moscow')
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.supplier_article), '')
      ))), 'Х', 'X'), '') is not null
    group by 1, 2
  ),
  orders as (
    select
      r.sa_name,
      coalesce(d.canonical, r.alias) as warehouse_name,
      max(d.region) as region,
      max(r.title) as title,
      sum(r.qty) as qty
    from orders_raw r
    left join public.warehouse_dict d
      on d.seller_id = p_seller_id and d.alias = r.alias
    group by 1, 2
  ),
  transit_raw as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(g.extra->>'vendorCode'), ''),
        nullif(btrim(g.extra->>'vendor_code'), '')
      ))), 'Х', 'X') as sa_name,
      coalesce(
        nullif(btrim(s.extra->>'warehouseName'), ''),
        nullif(btrim(s.extra->>'actualWarehouseName'), ''),
        'Не указан'
      ) as alias,
      max(nullif(btrim(p.title), '')) as title,
      sum(coalesce(g.quantity, 0))::numeric as qty
    from public.fbw_supplies s
    join par on s.seller_id = par.seller_id
    join public.fbw_supply_goods g
      on g.seller_id = s.seller_id
     and g.supply_id = s.supply_id
    left join public.products p
      on p.seller_id = g.seller_id
     and p.nm_id = g.nm_id
    where coalesce(s.extra->>'statusID', s.extra->>'statusId', '') is distinct from '5'
      and coalesce(s.extra->>'supplyDate', '') ~ '^\d{4}-\d{2}-\d{2}'
      and left(s.extra->>'supplyDate', 10)::date >= par.s_from
      and left(s.extra->>'supplyDate', 10)::date <= par.s_to
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(g.extra->>'vendorCode'), ''),
        nullif(btrim(g.extra->>'vendor_code'), '')
      ))), 'Х', 'X'), '') is not null
    group by 1, 2
  ),
  transit as (
    select
      r.sa_name,
      coalesce(d.canonical, r.alias) as warehouse_name,
      max(d.region) as region,
      max(r.title) as title,
      sum(r.qty) as qty
    from transit_raw r
    left join public.warehouse_dict d
      on d.seller_id = p_seller_id and d.alias = r.alias
    group by 1, 2
  ),
  keys as (
    select sa_name, warehouse_name from stock
    union
    select sa_name, warehouse_name from orders
    union
    select sa_name, warehouse_name from transit
  )
  select
    k.sa_name,
    coalesce(st.title, od.title, tr.title, k.sa_name) as title,
    k.warehouse_name,
    coalesce(st.region, od.region, tr.region) as region,
    coalesce(od.qty, 0) as orders_qty,
    coalesce(st.qty, 0) as stock_qty,
    coalesce(tr.qty, 0) as in_transit_qty
  from keys k
  left join stock st using (sa_name, warehouse_name)
  left join orders od using (sa_name, warehouse_name)
  left join transit tr using (sa_name, warehouse_name)
  order by k.sa_name, k.warehouse_name;
$$;

comment on function public.report_postavka_2(uuid, date, date, date, date) is
  'Поставка_2: заказы, остатки и FBW в пути по артикулам. Склад — канон из warehouse_dict.';

revoke all on function public.report_postavka_2(uuid, date, date, date, date)
  from public;
grant execute on function public.report_postavka_2(uuid, date, date, date, date)
  to anon, authenticated, service_role;

select public.warehouse_dict_refresh_all();

notify pgrst, 'reload schema';
