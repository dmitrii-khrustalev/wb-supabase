-- FBS order price from WB is копейки (×100). Info sums it in ₽.

do $patch$
declare
  src text;
  from_expr constant text := 'coalesce(sum(private.num_text(o.extra->>''price'')), 0) as order_sum';
  to_expr constant text := 'coalesce(sum(private.num_text(o.extra->>''price'') / 100.0), 0) as order_sum';
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);
  if src not like '%' || from_expr || '%' then
    raise exception 'report_info_daily: price sum pattern not found';
  end if;
  if src like '%/ 100.0), 0) as order_sum%' then
    raise exception 'report_info_daily: already divided by 100';
  end if;
  execute replace(src, from_expr, to_expr);

  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  if src not like '%' || from_expr || '%' then
    raise exception 'report_info_weekly: price sum pattern not found';
  end if;
  execute replace(src, from_expr, to_expr);
end
$patch$;

notify pgrst, 'reload schema';
