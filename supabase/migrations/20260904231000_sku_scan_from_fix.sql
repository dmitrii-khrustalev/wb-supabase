-- Fix report_info_sku: KPI daily CTE must scan cur/prev window (not unset scan_from).

do $fix_sku$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_sku(uuid, text, text, date, text, text)'::regprocedure);

  if src like '%info_sku_daily(p_seller_id, least(w.cur_from, w.prev_from), w.cur_to, nm)%' then
    raise notice 'report_info_sku: daily CTE already fixed';
    return;
  end if;

  src := replace(src,
    'from private.info_sku_daily(p_seller_id, scan_from, w.cur_to, nm)',
    'from private.info_sku_daily(p_seller_id, least(w.cur_from, w.prev_from), w.cur_to, nm)'
  );

  src := replace(src,
    'from private.info_sku_daily(p_seller_id, journal_from, w.cur_to, nm)',
    'from private.info_sku_daily(p_seller_id, least(w.cur_from, w.prev_from), w.cur_to, nm)'
  );

  if src not like '%info_sku_daily(p_seller_id, least(w.cur_from, w.prev_from), w.cur_to, nm)%' then
    raise exception 'report_info_sku: daily CTE fix failed';
  end if;

  if src like '%scan_from date;%' and src not like '%scan_from :=%' then
    src := replace(src,
      'from private.info_period_windows(p_grain, p_compare, p_anchor, today);',
      E'from private.info_period_windows(p_grain, p_compare, p_anchor, today);\n\n  scan_from := least(w.cur_from, w.prev_from);'
    );
  end if;

  execute src;
end
$fix_sku$;

notify pgrst, 'reload schema';
