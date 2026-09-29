-- report_info_sku: журнал — хвост 7 периодов; daily CTE для KPI — с cur/prev окна.

do $patch_sku$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_sku(uuid, text, text, date, text, text)'::regprocedure);

  if src like '%scan_from date;%' then
    raise notice 'report_info_sku: already patched';
    return;
  end if;

  src := replace(src, 'journal_from date;', 'scan_from date;
  journal_from date;');

  src := replace(src,
    $j$  journal_from := coalesce(
    private.info_sku_first_date(p_seller_id, nm),
    least(w.cur_from, w.prev_from)
  );$j$,
    $j$  scan_from := least(w.cur_from, w.prev_from);
  journal_from := greatest(
    coalesce(private.info_sku_first_date(p_seller_id, nm), scan_from),
    w.cur_to - (case w.grain when 'week' then 48 when 'month' then 210 else 7 end)
  );$j$
  );

  if src not like '%scan_from date;%' then
    raise exception 'report_info_sku: scan_from insert failed';
  end if;

  src := replace(src,
    'from private.info_sku_daily(p_seller_id, journal_from, w.cur_to, nm)',
    'from private.info_sku_daily(p_seller_id, least(w.cur_from, w.prev_from), w.cur_to, nm)'
  );

  execute src;
end
$patch_sku$;

comment on function public.report_info_sku(uuid, text, text, date, text, text) is
  'Карточка товара: KPI с scan_from, журнал — хвост 7 периодов. Полная история — на листе.';

notify pgrst, 'reload schema';
