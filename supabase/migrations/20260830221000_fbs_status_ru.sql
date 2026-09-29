-- Русские статусы в выгрузке Заказы FBS / Поставки FBS.
-- Таблица fbs_orders остаётся с кодами API — отчёты и info считают по ней.

create or replace function private.fbs_wb_status_ru(p text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case lower(btrim(coalesce(p, '')))
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
    else btrim(p)
  end;
$$;

create or replace function private.fbs_supplier_status_ru(p text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case lower(btrim(coalesce(p, '')))
    when 'new' then 'Новый'
    when 'confirm' then 'На сборке'
    when 'complete' then 'Собран'
    when 'cancel' then 'Отменён'
    when '' then ''
    else btrim(p)
  end;
$$;

revoke all on function private.fbs_wb_status_ru(text) from public;
revoke all on function private.fbs_supplier_status_ru(text) from public;

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
  private.fbs_supplier_status_ru(o.supplier_status) as supplier_status,
  private.fbs_wb_status_ru(o.wb_status) as wb_status,
  o.source,
  st.barcode as sticker_barcode,
  st.part_a,
  st.part_b,
  private.fbs_extra_rub(o.extra) as extra,
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
  private.fbs_supplier_status_ru(o.supplier_status) as supplier_status,
  private.fbs_wb_status_ru(o.wb_status) as wb_status,
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
grant select on table public.sheet_fbs_orders to anon, authenticated;
revoke all on table public.sheet_fbs from public, anon, authenticated;
grant select on table public.sheet_fbs to anon, authenticated;

do $patch$
declare
  src text;
  from_case text := $c$case lower(coalesce(o.wb_status, ''))
        when 'sorted' then 'отсортировано'
        when 'waiting' then 'ожидает'
        when 'ready_for_pickup' then 'готово к выдаче'
        when 'declined_by_client' then 'отказ клиента'
        when 'canceled_by_client' then 'отмена клиента'
        when 'sold' then 'продано'
        else coalesce(nullif(btrim(lower(o.wb_status)), ''), 'без статуса')
      end as status$c$;
  to_case text := 'private.fbs_wb_status_ru(o.wb_status) as status';
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);
  if src not like '%' || from_case || '%' then
    raise exception 'report_info_daily: fbs status case not found';
  end if;
  execute replace(src, from_case, to_case);

  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  if src not like '%' || from_case || '%' then
    raise exception 'report_info_weekly: fbs status case not found';
  end if;
  execute replace(src, from_case, to_case);
end
$patch$;

notify pgrst, 'reload schema';
