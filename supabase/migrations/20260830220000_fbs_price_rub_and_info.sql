-- FBS prices from WB are копейки. Sheet dump and info use the same rub conversion.

create or replace function private.wb_kop_rub(p text)
returns numeric
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select round(private.num_text(p) / 100.0, 2);
$$;

revoke all on function private.wb_kop_rub(text) from public;

create or replace function private.fbs_extra_rub(p jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select coalesce(p, '{}'::jsonb)
    || case
         when p ? 'price'
           then jsonb_build_object('price', private.wb_kop_rub(p->>'price'))
         else '{}'::jsonb
       end
    || case
         when p ? 'convertedPrice'
           then jsonb_build_object('convertedPrice', private.wb_kop_rub(p->>'convertedPrice'))
         else '{}'::jsonb
       end
    || case
         when p ? 'scanPrice'
              and coalesce(p->>'scanPrice', '') not in ('', 'null')
           then jsonb_build_object('scanPrice', private.wb_kop_rub(p->>'scanPrice'))
         else '{}'::jsonb
       end;
$$;

revoke all on function private.fbs_extra_rub(jsonb) from public;

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
  o.supplier_status,
  o.wb_status,
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
  'Заказы FBS: extra.price / convertedPrice / scanPrice в рублях (API отдаёт копейки).';

revoke all on table public.sheet_fbs_orders from public, anon, authenticated;
grant select on table public.sheet_fbs_orders to anon, authenticated;

do $patch$
declare
  src text;
  from_expr constant text := 'coalesce(sum(private.num_text(o.extra->>''price'') / 100.0), 0) as order_sum';
  to_expr constant text := 'coalesce(sum(private.wb_kop_rub(o.extra->>''price'')), 0) as order_sum';
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);
  if src like '%private.wb_kop_rub(o.extra%' then
    null;
  elsif src like '%' || from_expr || '%' then
    execute replace(src, from_expr, to_expr);
  else
    raise exception 'report_info_daily: price sum pattern not found';
  end if;

  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  if src like '%private.wb_kop_rub(o.extra%' then
    null;
  elsif src like '%' || from_expr || '%' then
    execute replace(src, from_expr, to_expr);
  else
    raise exception 'report_info_weekly: price sum pattern not found';
  end if;
end
$patch$;

notify pgrst, 'reload schema';
