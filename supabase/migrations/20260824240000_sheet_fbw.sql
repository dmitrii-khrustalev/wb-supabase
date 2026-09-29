-- Объединённый лист «Поставки»: поставка × товары (как боевой GAS).
-- Даты и склад из extra. payload не отдаём.

create or replace view public.sheet_fbw
with (security_invoker = false) as
select
  s.seller_id,
  s.supply_id,
  coalesce(s.extra->>'preorderID', s.extra->>'preorderId') as preorder_id,
  coalesce(s.extra->>'createDate', s.extra->>'createDate') as create_date,
  coalesce(s.extra->>'supplyDate', s.extra->>'supplyDate') as supply_date,
  coalesce(s.extra->>'factDate', s.extra->>'factDate') as fact_date,
  case coalesce(s.extra->>'statusID', s.extra->>'statusId')
    when '1' then 'Не запланировано'
    when '2' then 'Запланировано'
    when '3' then 'Отгрузка разрешена'
    when '4' then 'Идёт приёмка'
    when '5' then 'Принято'
    when '6' then 'Отгружено на воротах'
    else coalesce(s.extra->>'statusID', s.extra->>'statusId', '')
  end as status_name,
  case coalesce(s.extra->>'boxTypeID', s.extra->>'boxTypeId')
    when '1' then 'Монокороб'
    when '2' then 'Короб'
    when '3' then 'Дисплей'
    when '4' then 'Паллета'
    when '5' then 'Монопаллета'
    else coalesce(s.extra->>'boxTypeID', s.extra->>'boxTypeId', '')
  end as box_type_name,
  coalesce(
    nullif(s.extra->>'warehouseName', ''),
    nullif(s.extra->>'actualWarehouseName', ''),
    nullif(s.extra->>'warehouseName', ''),
    nullif(s.extra->>'actualWarehouseName', '')
  ) as warehouse_name,
  null::text as region,
  g.barcode,
  coalesce(g.extra->>'vendorCode', g.extra->>'vendor_code') as vendor_code,
  g.nm_id,
  coalesce(g.extra->>'techSize', g.extra->>'tech_size') as tech_size,
  g.extra->>'color' as color,
  g.quantity,
  coalesce(g.extra->>'acceptedQuantity', g.extra->>'accepted_quantity') as accepted_quantity,
  coalesce(g.extra->>'readyForSaleQuantity', g.extra->>'ready_for_sale_quantity') as ready_for_sale,
  null::numeric as weight_kg,
  null::numeric as total_weight_kg,
  case
    when coalesce(s.extra->>'supplyDate', '') ~ '^\d{4}-\d{2}-\d{2}'
      then left(s.extra->>'supplyDate', 10)::date
    when coalesce(s.extra->>'createDate', '') ~ '^\d{4}-\d{2}-\d{2}'
      then left(s.extra->>'createDate', 10)::date
    else (s.loaded_at at time zone 'Europe/Moscow')::date
  end as supply_dt,
  s.loaded_at
from public.fbw_supplies s
left join public.fbw_supply_goods g
  on g.seller_id = s.seller_id
 and g.supply_id = s.supply_id;

comment on view public.sheet_fbw is
  'Поставки FBW: одна строка на товар в поставке. Регион и вес подставляет GAS из ручных листов.';

revoke all on table public.sheet_fbw from public, anon, authenticated;
grant select on table public.sheet_fbw to anon, authenticated;
