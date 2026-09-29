-- GAS ходит с JWT service_role. У этой роли нет USAGE на private и EXECUTE
-- на переводчики — PostgREST вызывает функции от имени JWT, не владельца view.
-- Как sheet_fbw: CASE прямо в view, без private.fbs_*_status_ru / fbs_extra_rub.

create or replace view public.sheet_fbs_orders
with (security_invoker = false) as
select
  o.seller_id,
  o.order_id,
  o.rid,
  o.order_uid,
  o.created_at,
  o.article,
  o.nm_id,
  o.chrt_id,
  o.warehouse_id,
  o.supply_id,
  case lower(btrim(coalesce(o.supplier_status, '')))
    when 'new' then 'Новый'
    when 'confirm' then 'На сборке'
    when 'complete' then 'Собран'
    when 'cancel' then 'Отменён'
    when '' then ''
    else btrim(o.supplier_status)
  end as supplier_status,
  case lower(btrim(coalesce(o.wb_status, '')))
    when 'waiting' then 'Ожидает'
    when 'sorted' then 'Отсортировано'
    when 'ready_for_pickup' then 'Готово к выдаче'
    when 'sold' then 'Продано'
    when 'canceled_by_client' then 'Отмена клиента'
    when 'declined_by_client' then 'Отказ клиента'
    when 'defect' then 'Брак'
    when 'canceled' then 'Отменён'
    when 'cancelled' then 'Отменён'
    when '' then ''
    else btrim(o.wb_status)
  end as wb_status,
  o.source,
  st.barcode as sticker_barcode,
  st.part_a,
  st.part_b,
  coalesce(o.extra, '{}'::jsonb)
    || case
         when o.extra ? 'price' then jsonb_build_object(
           'price',
           round(
             case
               when btrim(coalesce(o.extra->>'price', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                 then btrim(o.extra->>'price')::numeric
               else 0
             end / 100.0,
             2
           )
         )
         else '{}'::jsonb
       end
    || case
         when o.extra ? 'convertedPrice' then jsonb_build_object(
           'convertedPrice',
           round(
             case
               when btrim(coalesce(o.extra->>'convertedPrice', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                 then btrim(o.extra->>'convertedPrice')::numeric
               else 0
             end / 100.0,
             2
           )
         )
         else '{}'::jsonb
       end
    || case
         when o.extra ? 'scanPrice'
              and coalesce(o.extra->>'scanPrice', '') not in ('', 'null')
           then jsonb_build_object(
             'scanPrice',
             round(
               case
                 when btrim(coalesce(o.extra->>'scanPrice', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                   then btrim(o.extra->>'scanPrice')::numeric
                 else 0
               end / 100.0,
               2
             )
           )
         else '{}'::jsonb
       end as extra,
  o.loaded_at
from public.fbs_orders o
left join public.fbs_order_stickers st
  on st.seller_id = o.seller_id
 and st.order_id = o.order_id;

comment on view public.sheet_fbs_orders is
  'Заказы FBS: статусы по-русски, цены extra в рублях. Коды API остаются в fbs_orders.';

create or replace view public.sheet_fbs
with (security_invoker = false) as
select
  s.seller_id,
  s.supply_id,
  s.name as supply_name,
  s.done,
  so.order_id,
  o.rid,
  o.article,
  o.nm_id,
  o.chrt_id,
  case lower(btrim(coalesce(o.supplier_status, '')))
    when 'new' then 'Новый'
    when 'confirm' then 'На сборке'
    when 'complete' then 'Собран'
    when 'cancel' then 'Отменён'
    when '' then ''
    else btrim(o.supplier_status)
  end as supplier_status,
  case lower(btrim(coalesce(o.wb_status, '')))
    when 'waiting' then 'Ожидает'
    when 'sorted' then 'Отсортировано'
    when 'ready_for_pickup' then 'Готово к выдаче'
    when 'sold' then 'Продано'
    when 'canceled_by_client' then 'Отмена клиента'
    when 'declined_by_client' then 'Отказ клиента'
    when 'defect' then 'Брак'
    when 'canceled' then 'Отменён'
    when 'cancelled' then 'Отменён'
    when '' then ''
    else btrim(o.wb_status)
  end as wb_status,
  s.extra,
  s.loaded_at
from public.fbs_supplies s
left join public.fbs_supply_orders so
  on so.seller_id = s.seller_id
 and so.supply_id = s.supply_id
left join public.fbs_orders o
  on o.seller_id = s.seller_id
 and o.order_id = so.order_id;

comment on view public.sheet_fbs is
  'Поставки FBS: статусы заказа по-русски. done — как в API (true/false).';

revoke all on table public.sheet_fbs_orders from public, anon, authenticated;
grant select on table public.sheet_fbs_orders to anon, authenticated, service_role;
revoke all on table public.sheet_fbs from public, anon, authenticated;
grant select on table public.sheet_fbs to anon, authenticated, service_role;

notify pgrst, 'reload schema';
