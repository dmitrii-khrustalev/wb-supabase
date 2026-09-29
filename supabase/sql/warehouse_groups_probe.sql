-- Пробная выгрузка складов из факта (не пишет в базу).
-- Запускай запросы по одному в SQL Editor.
--
-- Источники как на листах:
--   finance     = Финансовые ежедневные.office_name (только «Продажа»)
--   fbo_orders  = Заказы FBW.warehouse_name
--   fbw         = Поставки FBW.extra.warehouseName + warehouseID
--   fbo_stocks  = Остатки FBW, последний снимок
--   fbs         = Склады FBS
--
-- Группировка: сначала id поставки FBW, потом явные алиасы, иначе имя как есть.
-- «Виртуальный X» липнет к X, если такой склад уже есть.

-- 1) Сырой список: каждое имя × источник
with raw as (
  select 'finance'::text as src,
         btrim(office_name) as name,
         null::text as warehouse_id,
         count(*)::bigint as n
  from public.finance_rows
  where doc_type_name = 'Продажа'
    and nullif(btrim(office_name), '') is not null
  group by 2

  union all
  select 'fbo_orders',
         btrim(warehouse_name),
         null,
         count(*)
  from public.fbo_orders
  where nullif(btrim(warehouse_name), '') is not null
  group by 2

  union all
  select 'fbw',
         nullif(btrim(coalesce(
           extra->>'warehouseName',
           extra->>'actualWarehouseName'
         )), ''),
         nullif(btrim(coalesce(
           extra->>'warehouseID',
           extra->>'warehouseId',
           extra->>'actualWarehouseID'
         )), ''),
         count(*)
  from public.fbw_supplies
  group by 2, 3

  union all
  select 'fbo_stocks',
         btrim(warehouse_name),
         nullif(btrim(extra->>'warehouseId'), ''),
         count(*)
  from public.fbo_stocks
  where snapshot_date = (select max(snapshot_date) from public.fbo_stocks)
    and nullif(btrim(warehouse_name), '') is not null
  group by 2, 3

  union all
  select 'fbs',
         btrim(name),
         warehouse_id,
         1
  from public.fbs_warehouses
  where nullif(btrim(name), '') is not null
)
select src, name, warehouse_id, n
from raw
where name is not null
order by src, n desc, name;


-- 2) Предложение групп (алиасы → канон)
with raw as (
  select 'finance'::text as src,
         btrim(office_name) as name,
         null::text as warehouse_id,
         count(*)::bigint as n
  from public.finance_rows
  where doc_type_name = 'Продажа'
    and nullif(btrim(office_name), '') is not null
  group by 2

  union all
  select 'fbo_orders',
         btrim(warehouse_name),
         null,
         count(*)
  from public.fbo_orders
  where nullif(btrim(warehouse_name), '') is not null
  group by 2

  union all
  select 'fbw',
         nullif(btrim(coalesce(
           extra->>'warehouseName',
           extra->>'actualWarehouseName'
         )), ''),
         nullif(btrim(coalesce(
           extra->>'warehouseID',
           extra->>'warehouseId',
           extra->>'actualWarehouseID'
         )), ''),
         count(*)
  from public.fbw_supplies
  group by 2, 3

  union all
  select 'fbo_stocks',
         btrim(warehouse_name),
         nullif(btrim(extra->>'warehouseId'), ''),
         count(*)
  from public.fbo_stocks
  where snapshot_date = (select max(snapshot_date) from public.fbo_stocks)
    and nullif(btrim(warehouse_name), '') is not null
  group by 2, 3

  union all
  select 'fbs',
         btrim(name),
         warehouse_id,
         1
  from public.fbs_warehouses
  where nullif(btrim(name), '') is not null
),
norm as (
  select
    src,
    name,
    warehouse_id,
    n,
    regexp_replace(
      lower(translate(btrim(name), 'Ёё', 'Ее')),
      '\s+', ' ', 'g'
    ) as n1
  from raw
  where name is not null
),
core as (
  select
    *,
    regexp_replace(
      regexp_replace(n1, '[«»""]', '', 'g'),
      '^(склад |сц |ск |виртуальный |пфц )+',
      '',
      'g'
    ) as n2
  from norm
),
-- Явные пары: как в заказах/финансах → как в поставке FBW.
alias_map(alias_n, canon) as (
  values
    ('спб шушары', 'Склад Шушары'),
    ('склад шушары', 'Склад Шушары'),
    ('шушары', 'Склад Шушары'),
    ('самара (новосемейкино)', 'Новосемейкино'),
    ('новосемейкино', 'Новосемейкино'),
    ('краснодар', 'Краснодар (Тихорецкая)'),
    ('краснодар (тихорецкая)', 'Краснодар (Тихорецкая)')
),
fbw_canon as (
  select
    warehouse_id,
    name as canonical,
    n2 as core,
    sum(n) as fbw_n
  from core
  where src = 'fbw'
    and warehouse_id is not null
    and warehouse_id not in ('-999999')
  group by 1, 2, 3
),
tagged as (
  select
    c.*,
    coalesce(
      m.canon,
      f_id.canonical,
      f_core.canonical,
      case
        when c.n1 in (
          'склад wb', 'склад wb рф',
          'склад поставщика - везу на склад wb'
        ) then c.name
      end,
      c.name
    ) as group_name,
    case
      when m.canon is not null then 'alias'
      when f_id.canonical is not null then 'fbw_id'
      when f_core.canonical is not null then 'name'
      when c.n1 in (
        'склад wb', 'склад wb рф',
        'склад поставщика - везу на склад wb'
      ) then 'service'
      else 'solo'
    end as how
  from core c
  left join lateral (
    select canon
    from alias_map
    where alias_n in (c.n1, c.n2)
    order by length(alias_n) desc
    limit 1
  ) m on true
  left join fbw_canon f_id
    on c.warehouse_id is not null
   and c.warehouse_id = f_id.warehouse_id
   and c.warehouse_id not in ('-999999')
  left join fbw_canon f_core
    on f_id.warehouse_id is null
   and m.canon is null
   and c.n2 = f_core.core
)
select
  t.group_name as "группа",
  max(fc.warehouse_id) as "id FBW",
  string_agg(distinct t.name, ' · ' order by t.name)
    filter (where t.name is distinct from t.group_name) as "другие имена",
  coalesce(sum(t.n) filter (where t.src = 'finance'), 0) as "финансы",
  coalesce(sum(t.n) filter (where t.src = 'fbo_orders'), 0) as "заказы",
  coalesce(sum(t.n) filter (where t.src = 'fbw'), 0) as "поставки",
  coalesce(sum(t.n) filter (where t.src = 'fbo_stocks'), 0) as "остатки",
  coalesce(sum(t.n) filter (where t.src = 'fbs'), 0) as "fbs",
  string_agg(distinct t.how, ', ' order by t.how) as "как склеили"
from tagged t
left join fbw_canon fc on fc.canonical = t.group_name
group by t.group_name
order by
  (coalesce(sum(t.n) filter (where t.src = 'fbo_orders'), 0)
   + coalesce(sum(t.n) filter (where t.src = 'finance'), 0)) desc,
  t.group_name;
