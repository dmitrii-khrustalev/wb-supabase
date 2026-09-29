/**
 * Листы «sku» (карточка) и «sku all» (рейтинг).
 * Меню «sku»: товар + период/сравнение. Утро эти листы не трогает.
 */

var SKU_SHEET_ = 'sku';
var SKU_ALL_SHEET_ = 'sku all';
var SKU_TAB_ = '#6b5c73';
var SKU_ALL_COLS_ = 34;
var SKU_ALL_DELTA_COLS_ = [6, 9, 12, 15, 18, 21, 24, 27, 30];
var SKU_ALL_DELTA_INVERT_ = { 15: true, 18: true, 27: true };

function showSkuCardDialog() {
  skuShowPick_('card');
}

function showSkuAllDialog() {
  skuShowPick_('all');
}

function skuShowPick_(kind) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = HtmlService.createTemplateFromFile('sku_pick');
  var skus = kind === 'all' ? [] : skuFetchList_(ss);
  var saved = skuReadHeaderMeta_(ss.getSheetByName(SKU_SHEET_));
  t.payload = JSON.stringify({
    kind: kind,
    day: (saved && saved.day) || (typeof dateFromDays_ === 'function' ? dateFromDays_(1) : ''),
    grain: (saved && saved.grain) || 'day',
    compare: (saved && saved.compare) || 'day',
    nm_id: saved && saved.nm_id,
    skus: skus,
    title: kind === 'all' ? 'Все товары' : 'Карточка товара',
    hint: kind === 'all'
      ? 'Рейтинг: периодные метрики — сейчас / до / прирост. Остатки, дни и флаги — снимок.'
      : 'Один товар: KPI, блоки и история. На листе обновляется хвост 7 периодов из базы.'
  });
  SpreadsheetApp.getUi().showModalDialog(
    t.evaluate().setWidth(480).setHeight(kind === 'all' ? 360 : 460),
    kind === 'all' ? 'sku all' : 'sku'
  );
}

function runSkuForPick(payload) {
  if (!payload || !payload.day) throw new Error('Нет даты');
  var kind = payload.kind === 'all' ? 'all' : 'card';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  var sheetName = kind === 'all' ? SKU_ALL_SHEET_ : SKU_SHEET_;
  try {
    var n = kind === 'all'
      ? skuWriteAll_(ss, payload)
      : skuWriteCard_(ss, payload);
    var ms = Date.now() - t0;
    if (typeof reportLog_ === 'function') reportLog_(ss, sheetName, 'отчёт', n, payload.day, ms);
    return { ok: true, sheet: sheetName, ms: ms, n: n };
  } catch (err) {
    if (typeof reportLog_ === 'function') reportLog_(ss, sheetName, 'ошибка', 0, String(err), Date.now() - t0);
    throw err;
  }
}

function skuRpc_(sellerId, rpc, body, keepArray) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var headers = dbHeaders_(cfg.key);
  headers['Content-Type'] = 'application/json';
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + rpc, {
    method: 'post',
    muteHttpExceptions: true,
    headers: headers,
    payload: JSON.stringify(body)
  });
  var code = res.getResponseCode();
  var text = res.getContentText() || '';
  if (code !== 200) throw new Error('БД HTTP ' + code + ' ' + text.substring(0, 400));
  var parsed = JSON.parse(text);
  if (keepArray) return parsed || [];
  if (Array.isArray(parsed)) parsed = parsed[0] || null;
  return parsed;
}

function skuFetchList_(ss) {
  var sellerId = resolveSellerId_(typeof reportSellerSlug_ === 'function' ? reportSellerSlug_(ss) : 'main');
  var parsed = skuRpc_(sellerId, 'report_info_sku_list', { p_seller_id: sellerId }, true);
  return Array.isArray(parsed) ? parsed : [];
}

function skuHistKind_(grain) {
  if (grain === 'week') return 'weekly';
  if (grain === 'month') return 'monthly';
  return 'daily';
}

function skuWriteCard_(ss, payload) {
  if (typeof reportEnsureMoscowTz_ === 'function') reportEnsureMoscowTz_(ss);
  var slug = typeof reportSellerSlug_ === 'function' ? reportSellerSlug_(ss) : 'main';
  var sellerId = resolveSellerId_(slug);
  var grain = payload.grain || 'day';
  var histKind = skuHistKind_(grain);
  var sheet = ss.getSheetByName(SKU_SHEET_);
  if (!sheet) sheet = ss.insertSheet(SKU_SHEET_, startSheetInsertIndex_(ss, 2));
  var savedMeta = skuReadHeaderMeta_(sheet);
  var histMeta = typeof infoFindHistoryMeta_ === 'function' ? infoFindHistoryMeta_(sheet, histKind) : null;
  var sameSku = !!(savedMeta && payload.nm_id && String(savedMeta.nm_id) === String(payload.nm_id));
  var sameGrain = !!(savedMeta && savedMeta.grain === grain);
  var canFast = !!(sameSku && sameGrain && histMeta && histMeta.totalRows > 7 && histMeta.titleRow > 5);
  var histKeep = null;
  if (histMeta && histMeta.totalRows > 0) {
    var readCount = canFast ? Math.min(7, histMeta.totalRows) : histMeta.totalRows;
    histKeep = sheet.getRange(histMeta.bodyRow, 1, readCount, 12).getValues();
  }
  var body = {
    p_seller_id: sellerId,
    p_nm_id: payload.nm_id || null,
    p_grain: grain,
    p_compare: payload.compare || 'day'
  };
  if (payload.day) body.p_anchor = payload.day;
  var data = skuRpc_(sellerId, 'report_info_sku', body);
  if (!data || !data.product) throw new Error('RPC report_info_sku вернул пусто');
  data.slug = slug;
  if (histKeep && histKeep.length && typeof infoMergeHistory_ === 'function') {
    data._histKeep = infoMergeHistory_(histKeep, data.journal || [], histKind);
    data._histTotal = histMeta.totalRows;
  }
  var built = skuBuildCard_(data);
  if (canFast) {
    skuWriteCardFast_(sheet, data, built, histMeta);
  } else {
    skuResetSheet_(sheet, 12);
    sheet.getRange(1, 1, built.values.length, 12).setValues(built.values);
    skuApplyCardLayout_(sheet, data, built);
  }
  var period = typeof infoRange_ === 'function' ? infoRange_(data.cur_from, data.cur_to) : '';
  var days = startDaysFromPeriod_(period);
  writeStartDashboardStamp_(ss, SKU_SHEET_, period, days);
  dashboardActivateSheet_(ss, SKU_SHEET_);
  return (data._histKeep || data.journal || []).length;
}

function skuWriteAll_(ss, payload) {
  if (typeof reportEnsureMoscowTz_ === 'function') reportEnsureMoscowTz_(ss);
  var slug = typeof reportSellerSlug_ === 'function' ? reportSellerSlug_(ss) : 'main';
  var sellerId = resolveSellerId_(slug);
  var body = {
    p_seller_id: sellerId,
    p_grain: payload.grain || 'day',
    p_compare: payload.compare || 'day'
  };
  if (payload.day) body.p_anchor = payload.day;
  var data = skuRpc_(sellerId, 'report_info_sku_all', body);
  if (!data) throw new Error('RPC report_info_sku_all вернул пусто');
  data.slug = slug;
  var sheet = ss.getSheetByName(SKU_ALL_SHEET_);
  if (!sheet) sheet = ss.insertSheet(SKU_ALL_SHEET_, startSheetInsertIndex_(ss, 3));
  skuResetSheet_(sheet, SKU_ALL_COLS_);
  var built = skuBuildAll_(data);
  var cols = built.values[0].length;
  sheet.getRange(1, 1, built.values.length, cols).setValues(built.values);
  skuApplyAllLayout_(sheet, data, built);
  var period = typeof infoRange_ === 'function' ? infoRange_(data.cur_from, data.cur_to) : '';
  var days = startDaysFromPeriod_(period);
  writeStartDashboardStamp_(ss, SKU_ALL_SHEET_, period, days);
  dashboardActivateSheet_(ss, SKU_ALL_SHEET_);
  return (data.rows || []).length;
}

function skuWriteCardFast_(sheet, data, built, histMeta) {
  var dashRows = built.sec.histTitle - 1;
  var oldDashRows = histMeta.titleRow - 1;
  var histRows = data._histTotal || histMeta.totalRows || built.sec.histRows;
  var histTitleRow;
  var histHeadRow;
  var histBodyRow;

  if (dashRows !== oldDashRows) {
    if (dashRows > oldDashRows) {
      sheet.insertRowsAfter(oldDashRows, dashRows - oldDashRows);
    } else {
      sheet.deleteRows(dashRows + 1, oldDashRows - dashRows);
    }
  }

  histTitleRow = dashRows + 1;
  histHeadRow = dashRows + 2;
  histBodyRow = dashRows + 3;

  try { sheet.getRange(1, 1, dashRows, 12).breakApart(); } catch (eB) {}
  sheet.getRange(1, 1, dashRows, 12).clearContent();
  sheet.getRange(1, 1, dashRows, 12).setValues(built.values.slice(0, dashRows));
  skuApplyCardLayoutDashboard_(sheet, data, built, dashRows);

  sheet.getRange(histTitleRow, 1, 1, 12).setValues([built.values[dashRows]]);
  sheet.getRange(histHeadRow, 1, 1, 12).setValues([built.values[dashRows + 1]]);

  var oldHistRows = histMeta.totalRows;
  if (histRows !== oldHistRows) {
    if (histRows > oldHistRows) {
      sheet.insertRowsAfter(histBodyRow + oldHistRows - 1, histRows - oldHistRows);
    } else if (histRows < oldHistRows) {
      sheet.deleteRows(histBodyRow + histRows, oldHistRows - histRows);
    }
  }

  if (histRows > 0) {
    var oldTail = Math.min(7, oldHistRows);
    var maxTail = Math.min(7, histRows);
    var histValues = (data._histKeep || []).slice(0, maxTail);
    var writeCount = histValues.length;
    if (writeCount > oldTail) {
      sheet.insertRowsAfter(histBodyRow + oldTail - 1, writeCount - oldTail);
      histRows = oldHistRows + (writeCount - oldTail);
    } else if (writeCount < oldTail) {
      sheet.deleteRows(histBodyRow + writeCount, oldTail - writeCount);
      histRows = oldHistRows - (oldTail - writeCount);
      data._histTotal = histRows;
    }
    if (writeCount > 0) {
      sheet.getRange(histBodyRow, 1, writeCount, 12).setValues(histValues);
      skuApplyCardLayoutHistory_(sheet, histTitleRow, histHeadRow, histBodyRow, writeCount);
    }
  }

  skuApplyCardChrome_(sheet, built, histBodyRow + histRows - 1);
}

function skuResetSheet_(sheet, minCols) {
  try { if (sheet.getFilter()) sheet.getFilter().remove(); } catch (eF) {}
  minCols = Math.max(Number(minCols) || 12, 12);
  var rows = Math.max(sheet.getLastRow(), 80);
  var cols = Math.max(sheet.getMaxColumns(), minCols);
  if (sheet.getMaxColumns() < minCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), minCols - sheet.getMaxColumns());
    cols = sheet.getMaxColumns();
  }
  try { sheet.getRange(1, 1, rows, cols).breakApart(); } catch (eB) {}
  sheet.clear();
  try { sheet.setHiddenGridlines(true); } catch (eG) {}
  try { sheet.setTabColor(SKU_TAB_); } catch (eT) {}
}

function skuReadHeaderMeta_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return null;
  var v = sheet.getRange(1, 1, 1, 12).getValues()[0];
  var nm = String(v[9] || '').trim();
  if (!nm) return null;
  return {
    nm_id: nm,
    grain: String(v[5] || 'day').trim() || 'day',
    compare: String(v[7] || 'day').trim() || 'day',
    day: skuIsoFromCell_(v[11])
  };
}

function skuIsoFromCell_(v) {
  if (!v) return '';
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return '';
}

function skuShare_(part, whole) {
  if (!infoN_(whole)) return '—';
  return (infoN_(part) / infoN_(whole) * 100).toFixed(1) + '%';
}

function skuHead_(from, to) {
  return [
    'Метрика',
    infoRange_(from, to) || infoDateShort_(to),
    'сравнение',
    'Δ',
    '% каб.',
    ''
  ];
}

function skuSix_(label, cur, prev, cab) {
  return [
    label,
    cur == null || cur === '' ? '—' : infoN_(cur),
    prev == null || prev === '' ? '—' : infoN_(prev),
    infoDelta_(cur, prev),
    cab == null || cab === '' ? '—' : skuShare_(cur, cab),
    ''
  ];
}

function skuBuildCard_(data) {
  var kpi = data.kpi || {};
  var fin = data.finance || {};
  var ads = data.ads || {};
  var fbo = data.fbo || {};
  var fbs = data.fbs || {};
  var stocks = data.stocks || {};
  var product = data.product || {};
  var supplies = data.supplies || [];
  var journal = data.journal || [];
  var warehouses = stocks.warehouses || [];
  var rows = [];
  var sec = {};
  var period = infoRange_(data.cur_from, data.cur_to);
  var prevPeriod = infoRange_(data.prev_from, data.prev_to);
  var grainRu = data.grain === 'week' ? 'неделя' : (data.grain === 'month' ? 'месяц' : 'день');
  var cmpRu = data.compare === 'week' ? 'к неделе' : (data.compare === 'month' ? 'к месяцу' : 'ко дню');
  var i;

  sec.header = rows.length + 1;
  rows.push([
    'SKU', '',
    product.sa_name || '', '',
    'grain', data.grain || 'day',
    'compare', data.compare || 'day',
    'nm', product.nm_id || '',
    'anchor', data.cur_to || ''
  ]);
  rows.push([
    (product.brand || '') + (product.price != null ? ' · цена карточки ' + infoN_(product.price) + ' ₽' : ''),
    '', '', '',
    grainRu, period,
    cmpRu, prevPeriod,
    'обновлено', data.updated_at || '',
    data.complete === false ? 'неполный период, равный префикс' : '',
    ''
  ]);
  rows.push([
    product.title || '', '', '', '', '', '', '', '', '', '', '', ''
  ]);

  sec.kpiLabel = rows.length + 1;
  rows.push([
    'Продажи, шт', '', 'Выручка, ₽', '', 'К перечислению, ₽', '',
    'Реклама, ₽', '', 'ДРР', '', 'Заказы FBW+FBS', ''
  ]);
  sec.kpiValue = rows.length + 1;
  rows.push([
    infoN_(kpi.qty), '', infoN_(kpi.retail), '', infoN_(kpi.for_pay), '',
    infoN_(kpi.ads), '', kpi.drr == null ? '' : infoN_(kpi.drr), '', infoN_(kpi.orders), ''
  ]);
  sec.kpiPrev = rows.length + 1;
  rows.push([
    infoDelta_(kpi.qty, kpi.qty_prev), '', infoDelta_(kpi.retail, kpi.retail_prev), '',
    infoDelta_(kpi.for_pay, kpi.for_pay_prev), '', infoDelta_(kpi.ads, kpi.ads_prev), '',
    infoDelta_(kpi.drr, kpi.drr_prev), '', infoDelta_(kpi.orders, kpi.orders_prev), ''
  ]);
  sec.kpiShare = rows.length + 1;
  rows.push([
    skuShare_(kpi.qty, kpi.qty_cab), '', skuShare_(kpi.retail, kpi.retail_cab), '',
    skuShare_(kpi.for_pay, kpi.for_pay_cab), '', skuShare_(kpi.ads, kpi.ads_cab), '',
    '', '', skuShare_(kpi.orders, kpi.orders_cab), ''
  ]);
  rows.push(infoEmpty_());

  var head = skuHead_(data.cur_from, data.cur_to);
  head[2] = prevPeriod;
  sec.finTitle = rows.length + 1;
  rows.push(['Финансы', '', '', '', '', '', 'Реклама', '', '', '', '', '']);
  sec.finHead = rows.length + 1;
  rows.push(head.concat(head));
  sec.finBody = rows.length + 1;
  var finRows = [
    skuSix_('Продажи, шт', fin.qty, kpi.qty_prev, kpi.qty_cab),
    skuSix_('Возвраты, шт', fin.qty_returns, fin.qty_returns_prev, null),
    skuSix_('Выручка, ₽', fin.retail, kpi.retail_prev, kpi.retail_cab),
    skuSix_('Средний чек, ₽', fin.avg_check, fin.avg_check_prev, null),
    skuSix_('Цена карточки, ₽', fin.card_price, null, null),
    skuSix_('К перечислению, ₽', fin.for_pay, kpi.for_pay_prev, kpi.for_pay_cab),
    skuSix_('Комиссия, ₽', fin.commission, fin.commission_prev, null),
    skuSix_('Логистика, ₽', fin.logistics, fin.logistics_prev, null),
    skuSix_('Хранение, ₽', fin.storage, fin.storage_prev, null),
    skuSix_('Приёмка, ₽', fin.acceptance, fin.acceptance_prev, null),
    skuSix_('Эквайринг, ₽', fin.acquiring, fin.acquiring_prev, null),
    skuSix_('Удержания, ₽', fin.deduction, fin.deduction_prev, null),
    skuSix_('Штрафы, ₽', fin.penalty, fin.penalty_prev, null)
  ];
  var adsRows = [
    skuSix_('Расход, ₽', ads.spend, kpi.ads_prev, kpi.ads_cab),
    skuSix_('Показы', ads.views, ads.views_prev, null),
    skuSix_('Клики', ads.clicks, ads.clicks_prev, null),
    skuSix_('CPC, ₽', ads.cpc, ads.cpc_prev, null),
    skuSix_('CTR', ads.ctr, ads.ctr_prev, null),
    skuSix_('Заказы с рекламы', ads.orders, ads.orders_prev, null),
    skuSix_('Корзины (ATBS)', ads.atbs, null, null),
    skuSix_('ДРР', ads.drr, kpi.drr_prev, null),
    skuSix_('После рекламы, ₽', ads.after_ads, ads.after_ads_prev, null)
  ];
  sec.finRows = 13;
  sec.finInvert = [0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1];
  sec.adsInvert = [1, 0, 0, 1, 0, 0, 0, 1, 0];
  for (i = 0; i < 13; i++) {
    rows.push(infoJoinSix_(finRows[i], adsRows[i]));
  }

  rows.push(infoEmpty_());
  sec.ordTitle = rows.length + 1;
  rows.push(['Заказы FBW', '', '', '', '', '', 'Заказы FBS', '', '', '', '', '']);
  sec.ordHead = rows.length + 1;
  rows.push(head.concat(head));
  sec.ordBody = rows.length + 1;
  rows.push(infoJoinSix_(
    skuSix_('Заказы, шт', fbo.orders, fbo.orders_prev, null),
    skuSix_('Заказы, шт', fbs.orders, fbs.orders_prev, null)
  ));
  rows.push(infoJoinSix_(
    skuSix_('Отмены', fbo.cancels, fbo.cancels_prev, null),
    skuSix_('Отмены', fbs.cancels, fbs.cancels_prev, null)
  ));
  rows.push(infoJoinSix_(
    skuSix_('Сумма, ₽', fbo.sum, fbo.sum_prev, null),
    skuSix_('Сумма, ₽', fbs.sum, fbs.sum_prev, null)
  ));
  rows.push(infoJoinSix_(
    skuSix_('Средняя цена, ₽', infoAvgPrice_(fbo.sum, fbo.orders), infoAvgPrice_(fbo.sum_prev, fbo.orders_prev), null),
    skuSix_('Средняя цена, ₽', infoAvgPrice_(fbs.sum, fbs.orders), infoAvgPrice_(fbs.sum_prev, fbs.orders_prev), null)
  ));
  rows.push(infoJoinSix_(
    ['', '', '', '', '', ''],
    skuSix_('Отсортировано', fbs.sorted, fbs.sorted_prev, null)
  ));
  rows.push(infoJoinSix_(
    ['', '', '', '', '', ''],
    skuSix_('Ожидает', fbs.waiting, fbs.waiting_prev, null)
  ));
  sec.ordRows = 6;
  sec.ordInvertL = [0, 1, 0, 0, 0, 0];
  sec.ordInvertR = [0, 1, 0, 0, 0, 0];

  rows.push(infoEmpty_());
  sec.stkTitle = rows.length + 1;
  rows.push(['Остатки', '', '', '', '', '', 'Склады FBW', '', '', '', '', '']);
  sec.stkHead = rows.length + 1;
  rows.push(head.concat(['Склад', 'шт', '', '', '', '']));
  sec.stkBody = rows.length + 1;
  var stkLeft = [
    skuSix_('FBW, шт', stocks.fbo_qty, stocks.fbo_qty_prev, null),
    skuSix_('FBS, шт', stocks.fbs_qty, stocks.fbs_qty_prev, null),
    skuSix_('В пути к клиенту', stocks.in_way_to, stocks.in_way_to_prev, null),
    skuSix_('В пути от клиента', stocks.in_way_from, stocks.in_way_from_prev, null),
    skuSix_('Дней остатка', stocks.days, null, null)
  ];
  sec.stkRows = Math.max(5, warehouses.length);
  for (i = 0; i < sec.stkRows; i++) {
    var left = stkLeft[i] || ['', '', '', '', '', ''];
    var wh = warehouses[i];
    var right = wh
      ? [wh.warehouse || '', infoN_(wh.qty), '', '', '', '']
      : ['', '', '', '', '', ''];
    rows.push(infoJoinSix_(left, right));
  }

  rows.push(infoEmpty_());
  sec.supTitle = rows.length + 1;
  rows.push(['Поставки FBW этого товара', '', '', '', '', '', 'FBS', '', '', '', '', '']);
  sec.supHead = rows.length + 1;
  rows.push(infoHeadNow_().concat(infoHeadNow_()));
  sec.supBody = rows.length + 1;
  var fbsSup = data.fbs_supplies || {};
  var supLines = Math.max(supplies.length, 1);
  for (i = 0; i < supLines; i++) {
    var s = supplies[i];
    rows.push(infoJoinSix_(
      s ? infoNow_(s.status_name || '—', s.qty) : infoNow_('нет в пути', 0),
      i === 0 ? infoNow_('В открытых поставках', fbsSup.open_orders) : ['', '', '', '', '', '']
    ));
  }
  sec.supRows = supLines;

  rows.push(infoEmpty_());
  sec.histTitle = rows.length + 1;
  var histName = data.grain === 'week' ? 'неделям' : (data.grain === 'month' ? 'месяцам' : 'дням');
  rows.push(['История по ' + histName, '', '', '', '', '', '', '', '', '', '', '']);
  sec.histHead = rows.length + 1;
  rows.push([
    data.grain === 'day' ? 'Дата' : 'Период',
    'Шт', 'Выручка, ₽', 'К переч., ₽', 'Реклама, ₽', 'ДРР',
    'FBW зак.', 'FBS зак.', 'FBW отм.', 'FBS отм.', 'Остаток FBW', 'Остаток FBS'
  ]);
  sec.histBody = rows.length + 1;
  var histKind = skuHistKind_(data.grain);
  var histRows = data._histKeep;
  if (!histRows || !histRows.length) {
    histRows = [];
    for (i = 0; i < journal.length; i++) {
      histRows.push(typeof infoJournalRow_ === 'function'
        ? infoJournalRow_(journal[i], histKind)
        : [
          data.grain === 'day' ? infoDate_(journal[i].day) : infoRange_(journal[i].day, journal[i].week_end),
          infoN_(journal[i].qty), infoN_(journal[i].retail), infoN_(journal[i].for_pay), infoN_(journal[i].ads),
          journal[i].drr == null ? '' : infoN_(journal[i].drr),
          infoN_(journal[i].fbo), infoN_(journal[i].fbs),
          infoN_(journal[i].fbo_cancels), infoN_(journal[i].fbs_cancels),
          journal[i].fbo_stock == null ? '' : infoN_(journal[i].fbo_stock),
          journal[i].fbs_stock == null ? '' : infoN_(journal[i].fbs_stock)
        ]);
    }
  }
  for (i = 0; i < histRows.length; i++) {
    var histRow = histRows[i].slice();
    while (histRow.length < 12) histRow.push('');
    rows.push(histRow.slice(0, 12));
  }
  sec.histRows = histRows.length;
  return { values: rows, sec: sec };
}

function skuApplyCardLayout_(sheet, data, built) {
  var dashEnd = built.sec.histTitle - 1;
  skuApplyCardLayoutDashboard_(sheet, data, built, dashEnd);
  if (built.sec.histRows > 0) {
    skuApplyCardLayoutHistory_(sheet, built.sec.histTitle, built.sec.histHead, built.sec.histBody, built.sec.histRows);
  }
  skuApplyCardChrome_(sheet, built, built.values.length);
}

function skuApplyCardLayoutDashboard_(sheet, data, built, dashEnd) {
  var sec = built.sec;
  var kpi = data.kpi || {};
  var lastCol = 12;

  applyBookFont_(sheet.getRange(1, 1, dashEnd, lastCol))
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  infoMerge_(sheet, 1, 1, 1, 2);
  infoMerge_(sheet, 1, 3, 1, 2);
  infoMerge_(sheet, 2, 1, 1, 4);
  infoMerge_(sheet, 3, 1, 1, 12);
  var p;
  for (p = 0; p < 6; p++) {
    infoMerge_(sheet, sec.kpiLabel, 1 + p * 2, 1, 2);
    infoMerge_(sheet, sec.kpiValue, 1 + p * 2, 1, 2);
    infoMerge_(sheet, sec.kpiPrev, 1 + p * 2, 1, 2);
    infoMerge_(sheet, sec.kpiShare, 1 + p * 2, 1, 2);
  }
  infoMerge_(sheet, sec.finTitle, 1, 1, 6);
  infoMerge_(sheet, sec.finTitle, 7, 1, 6);
  infoMerge_(sheet, sec.ordTitle, 1, 1, 6);
  infoMerge_(sheet, sec.ordTitle, 7, 1, 6);
  infoMerge_(sheet, sec.stkTitle, 1, 1, 6);
  infoMerge_(sheet, sec.stkTitle, 7, 1, 6);
  infoMerge_(sheet, sec.supTitle, 1, 1, 6);
  infoMerge_(sheet, sec.supTitle, 7, 1, 6);

  sheet.getRange(1, 1, 1, lastCol)
    .setBackground(INFO_HEADER_BG_)
    .setFontColor(INFO_HEADER_FG_)
    .setFontWeight('bold')
    .setFontSize(11);
  sheet.getRange(1, 1).setFontSize(14);
  sheet.getRange(2, 1, 1, lastCol)
    .setBackground(INFO_LINE_BG_)
    .setFontColor(INFO_MUTED_)
    .setFontStyle('italic')
    .setFontSize(9);
  sheet.getRange(3, 1, 1, lastCol)
    .setBackground(INFO_LINE_BG_)
    .setFontWeight('bold')
    .setFontSize(11)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  sheet.getRange(sec.kpiLabel, 1, 1, lastCol)
    .setBackground(INFO_LABEL_BG_)
    .setFontWeight('bold')
    .setFontSize(9)
    .setHorizontalAlignment('center');
  sheet.getRange(sec.kpiValue, 1, 1, lastCol)
    .setFontSize(18)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setBackground(INFO_CARD_BG_);
  sheet.setRowHeight(sec.kpiValue, 36);
  sheet.getRange(sec.kpiPrev, 1, 1, lastCol).setFontSize(9).setHorizontalAlignment('center');
  sheet.getRange(sec.kpiShare, 1, 1, lastCol).setFontSize(9).setHorizontalAlignment('center').setFontColor(INFO_MUTED_);
  sheet.getRange(sec.kpiValue, 1).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 3).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 5).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 7).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 9).setNumberFormat('0.0%');
  sheet.getRange(sec.kpiValue, 11).setNumberFormat('#,##0');
  infoColorDeltaRow_(sheet, sec.kpiPrev, [kpi.qty, kpi.retail, kpi.for_pay, kpi.ads, kpi.drr, kpi.orders], [kpi.qty_prev, kpi.retail_prev, kpi.for_pay_prev, kpi.ads_prev, kpi.drr_prev, kpi.orders_prev]);

  infoSectionTitle_(sheet, sec.finTitle, lastCol);
  infoSectionTitle_(sheet, sec.ordTitle, lastCol);
  infoSectionTitle_(sheet, sec.stkTitle, lastCol);
  infoSectionTitle_(sheet, sec.supTitle, lastCol);
  infoColHead_(sheet, sec.finHead, 12);
  infoColHead_(sheet, sec.ordHead, 12);
  infoColHead_(sheet, sec.stkHead, 12);
  infoColHead_(sheet, sec.supHead, 12);
  sheet.setRowHeight(sec.finHead, 32);
  sheet.setRowHeight(sec.ordHead, 32);
  sheet.setRowHeight(sec.stkHead, 32);

  infoStripeBody_(sheet, sec.finBody, sec.finRows, 12);
  sheet.getRange(sec.finBody, 1, sec.finRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.finBody, 7, sec.finRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.finBody, 2, sec.finRows, 2).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
  sheet.getRange(sec.finBody, 8, sec.finRows, 2).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
  sheet.getRange(sec.finBody, 4, sec.finRows, 2).setHorizontalAlignment('right').setFontSize(9);
  sheet.getRange(sec.finBody, 10, sec.finRows, 2).setHorizontalAlignment('right').setFontSize(9);
  skuColorGrowBlock_(sheet, sec.finBody, sec.finRows, sec.finInvert, sec.adsInvert);

  infoStripeBody_(sheet, sec.ordBody, sec.ordRows, 12);
  sheet.getRange(sec.ordBody, 1, sec.ordRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.ordBody, 7, sec.ordRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.ordBody, 2, sec.ordRows, 2).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(sec.ordBody, 8, sec.ordRows, 2).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(sec.ordBody + 2, 2, 2, 2).setNumberFormat('#,##0.00');
  sheet.getRange(sec.ordBody + 2, 8, 2, 2).setNumberFormat('#,##0.00');
  skuColorGrowBlock_(sheet, sec.ordBody, sec.ordRows, sec.ordInvertL, sec.ordInvertR);

  infoStripeBody_(sheet, sec.stkBody, sec.stkRows, 12);
  sheet.getRange(sec.stkBody, 1, sec.stkRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.stkBody, 2, sec.stkRows, 2).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(sec.stkBody, 8, sec.stkRows, 1).setNumberFormat('#,##0').setHorizontalAlignment('right');
  skuColorGrowBlock_(sheet, sec.stkBody, 5, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);

  infoStripeBody_(sheet, sec.supBody, sec.supRows, 12);
  sheet.getRange(sec.supBody, 1, sec.supRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.supBody, 7, sec.supRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.supBody, 2, sec.supRows, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
  sheet.getRange(sec.supBody, 8, sec.supRows, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
}

function skuApplyCardLayoutHistory_(sheet, histTitle, histHead, histBody, histRows) {
  infoMerge_(sheet, histTitle, 1, 1, 12);
  infoSectionTitle_(sheet, histTitle, 12);
  infoColHead_(sheet, histHead, 12);
  sheet.getRange(histHead, 1, 1, 12).setHorizontalAlignment('center').setWrap(true);
  sheet.setRowHeight(histHead, 32);
  if (histRows > 0) {
    sheet.getRange(histBody, 2, histRows, 4).setNumberFormat('#,##0').setHorizontalAlignment('right');
    sheet.getRange(histBody, 6, histRows, 1).setNumberFormat('0.0%').setHorizontalAlignment('right');
    sheet.getRange(histBody, 7, histRows, 6).setNumberFormat('#,##0').setHorizontalAlignment('right');
    infoStripeBody_(sheet, histBody, histRows, 12);
    applyBookFont_(sheet.getRange(histBody, 1, histRows, 12))
      .setVerticalAlignment('middle')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
}

function skuApplyCardChrome_(sheet, built, lastRow) {
  var sec = built.sec;
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 80);
  sheet.setColumnWidth(5, 80);
  sheet.setColumnWidth(6, 70);
  sheet.setColumnWidth(7, 180);
  sheet.setColumnWidth(8, 100);
  sheet.setColumnWidth(9, 100);
  sheet.setColumnWidth(10, 80);
  sheet.setColumnWidth(11, 80);
  sheet.setColumnWidth(12, 90);
  sheet.setFrozenRows(8);
  sheet.setRowHeight(1, 28);
  sheet.setRowHeight(3, 26);
  sheet.setRowHeight(sec.kpiValue, 36);
  if (sec.histRows > 0) sheet.setRowHeight(sec.histHead, 32);
}

function skuAllPad_(row) {
  var out = row.slice();
  while (out.length < SKU_ALL_COLS_) out.push('');
  return out;
}

function skuTriple_(cur, prev) {
  return [
    cur == null ? '' : infoN_(cur),
    prev == null ? '' : infoN_(prev),
    (cur == null && prev == null) ? '' : infoDelta_(cur, prev)
  ];
}

function skuAllRealRows_(raw) {
  var out = [];
  var i;
  for (i = 0; i < (raw || []).length; i++) {
    var nm = String(raw[i].nm_id || '').replace(/^\s+|\s+$/g, '');
    if (!nm || nm === '0') continue;
    out.push(raw[i]);
  }
  return out;
}

function skuBuildAll_(data) {
  var cab = data.cab || {};
  var list = skuAllRealRows_(data.rows || []);
  var rows = [];
  var period = infoRange_(data.cur_from, data.cur_to);
  var prevPeriod = infoRange_(data.prev_from, data.prev_to);
  var grainRu = data.grain === 'week' ? 'неделя' : (data.grain === 'month' ? 'месяц' : 'день');
  var cmpRu = data.compare === 'week' ? 'к неделе' : (data.compare === 'month' ? 'к месяцу' : 'ко дню');
  var cabCancels = 0;
  var cabCancelsPrev = 0;
  var i;
  for (i = 0; i < list.length; i++) {
    cabCancels += infoN_(list[i].cancels);
    cabCancelsPrev += infoN_(list[i].cancels_prev);
  }
  var cabAfter = infoN_(cab.for_pay) - infoN_(cab.ads);
  var cabAfterPrev = infoN_(cab.for_pay_prev) - infoN_(cab.ads_prev);
  rows.push(skuAllPad_([
    'SKU ALL', grainRu, period, 'vs', prevPeriod, cmpRu,
    'обновлено', data.updated_at || '', data.complete === false ? 'неполный период' : ''
  ]));
  rows.push(skuAllPad_([
    'Кабинет', 'итого', ''
  ].concat(skuTriple_(cab.qty, cab.qty_prev))
    .concat(skuTriple_(cab.retail, cab.retail_prev))
    .concat(skuTriple_(cab.for_pay, cab.for_pay_prev))
    .concat(skuTriple_(cab.ads, cab.ads_prev))
    .concat(skuTriple_(cab.drr, cab.drr_prev))
    .concat(skuTriple_(cabAfter, cabAfterPrev))
    .concat(skuTriple_(cab.orders, cab.orders_prev))
    .concat(skuTriple_(cabCancels, cabCancelsPrev))
    .concat(skuTriple_(1, 1))));
  rows.push(skuAllPad_([
    'Товар', '', '',
    'Шт', '', '',
    'Выручка', '', '',
    'К перечислению', '', '',
    'Реклама', '', '',
    'ДРР', '', '',
    'После рекламы', '', '',
    'Заказы', '', '',
    'Отмены', '', '',
    'Доля', '', '',
    'Снимок', '', '', ''
  ]));
  rows.push(skuAllPad_([
    'Артикул', 'Название', 'nm_id',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'сейчас', 'до', 'Δ',
    'Ост. FBW', 'Ост. FBS', 'Дней', 'Флаги'
  ]));
  for (i = 0; i < list.length; i++) {
    var r = list[i];
    rows.push(skuAllPad_([
      r.sa_name || '',
      r.title || '',
      r.nm_id || ''
    ].concat(skuTriple_(r.qty, r.qty_prev))
      .concat(skuTriple_(r.retail, r.retail_prev))
      .concat(skuTriple_(r.for_pay, r.for_pay_prev))
      .concat(skuTriple_(r.ads, r.ads_prev))
      .concat(skuTriple_(r.drr, r.drr_prev))
      .concat(skuTriple_(r.after_ads, r.after_ads_prev))
      .concat(skuTriple_(r.orders, r.orders_prev))
      .concat(skuTriple_(r.cancels, r.cancels_prev))
      .concat(skuTriple_(r.share, r.share_prev))
      .concat([
        infoN_(r.fbo_stock),
        infoN_(r.fbs_stock),
        r.days == null ? '' : infoN_(r.days),
        r.flags || ''
      ])));
  }
  return { values: rows, n: list.length, rows: list };
}

function skuApplyAllLayout_(sheet, data, built) {
  var lastRow = built.values.length;
  var lastCol = SKU_ALL_COLS_;
  var dataStart = 5;
  var n = built.n || 0;
  applyBookFont_(sheet.getRange(1, 1, lastRow, lastCol))
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, 1, 1, lastCol)
    .setBackground(INFO_HEADER_BG_)
    .setFontColor(INFO_HEADER_FG_)
    .setFontWeight('bold');
  sheet.getRange(1, 1).setFontSize(14);
  sheet.getRange(2, 1, 1, lastCol)
    .setBackground(INFO_SECTION_BG_)
    .setFontWeight('bold')
    .setFontSize(9);
  sheet.getRange(3, 1, 1, lastCol)
    .setBackground(INFO_LABEL_BG_)
    .setFontWeight('bold')
    .setFontSize(9)
    .setHorizontalAlignment('center');
  sheet.getRange(4, 1, 1, lastCol)
    .setBackground(INFO_LABEL_BG_)
    .setFontColor(INFO_MUTED_)
    .setFontSize(8)
    .setHorizontalAlignment('center');
  var merges = [
    [3, 1, 2], [3, 4, 3], [3, 7, 3], [3, 10, 3], [3, 13, 3],
    [3, 16, 3], [3, 19, 3], [3, 22, 3], [3, 25, 3], [3, 28, 3],
    [3, 31, 4]
  ];
  var m;
  for (m = 0; m < merges.length; m++) {
    try {
      sheet.getRange(merges[m][0], merges[m][1], 1, merges[m][2]).merge();
    } catch (eM) {}
  }
  var fmtInt = '#,##0';
  var fmtPct = '0.0%';
  var fmtDay = '0.0';
  var moneyPairs = [4, 7, 10, 13, 19, 22, 25];
  var pctPairs = [16, 28];
  var p;
  if (lastRow >= 2) {
    for (p = 0; p < moneyPairs.length; p++) {
      sheet.getRange(2, moneyPairs[p], lastRow - 1, 2).setNumberFormat(fmtInt);
    }
    for (p = 0; p < pctPairs.length; p++) {
      sheet.getRange(2, pctPairs[p], lastRow - 1, 2).setNumberFormat(fmtPct);
    }
    sheet.getRange(2, 31, lastRow - 1, 2).setNumberFormat(fmtInt);
    sheet.getRange(2, 33, lastRow - 1, 1).setNumberFormat(fmtDay);
  }
  skuColorDeltaCols_(sheet, 2, 1, SKU_ALL_DELTA_COLS_, SKU_ALL_DELTA_INVERT_);
  if (n > 0) {
    var bgs = [];
    var flagColors = [];
    var list = built.rows || data.rows || [];
    var i;
    var c;
    for (i = 0; i < n; i++) {
      var fill = i % 2 === 1 ? INFO_LINE_BG_ : '#ffffff';
      var rowBg = [];
      for (c = 0; c < lastCol; c++) rowBg.push(fill);
      bgs.push(rowBg);
      var flags = String(list[i] && list[i].flags || '');
      if (flags.indexOf('нет остатка') >= 0 || flags.indexOf('−50%') >= 0 || flags.indexOf('после рекламы') >= 0) {
        flagColors.push([INFO_RED_]);
      } else if (flags.indexOf('рост') >= 0) {
        flagColors.push([INFO_GREEN_]);
      } else {
        flagColors.push([null]);
      }
    }
    sheet.getRange(dataStart, 1, n, lastCol).setBackgrounds(bgs);
    sheet.getRange(dataStart, lastCol, n, 1).setFontColors(flagColors);
    skuColorDeltaCols_(sheet, dataStart, n, SKU_ALL_DELTA_COLS_, SKU_ALL_DELTA_INVERT_);
    sheet.getRange(4, 1, lastRow - 3, lastCol).createFilter();
  }
  skuAllGroupBorders_(sheet, lastRow);
  var c;
  var w = [
    120, 220, 90,
    70, 70, 58, 80, 80, 58, 80, 80, 58,
    70, 70, 58, 58, 58, 58, 80, 80, 58,
    70, 70, 58, 62, 62, 58, 58, 58, 58,
    72, 72, 50, 180
  ];
  for (c = 0; c < w.length; c++) sheet.setColumnWidth(c + 1, w[c]);
  sheet.setFrozenRows(4);
  sheet.setFrozenColumns(2);
}

function skuAllGroupBorders_(sheet, lastRow) {
  if (lastRow < 3) return;
  var groups = [
    [1, 3],
    [4, 3], [7, 3], [10, 3], [13, 3],
    [16, 3], [19, 3], [22, 3], [25, 3], [28, 3],
    [31, 4]
  ];
  var color = '#7a7a7a';
  var style = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;
  var g;
  for (g = 0; g < groups.length; g++) {
    sheet.getRange(2, groups[g][0], lastRow - 1, groups[g][1])
      .setBorder(true, true, true, true, false, false, color, style);
  }
}

function skuColorGrowBlock_(sheet, startRow, n, invertL, invertR) {
  if (n < 1) return;
  var vals = sheet.getRange(startRow, 1, n, 12).getValues();
  var leftColors = [];
  var rightColors = [];
  var r;
  for (r = 0; r < n; r++) {
    leftColors.push([typeof infoDeltaFontColor_ === 'function'
      ? infoDeltaFontColor_(vals[r][3], invertL && invertL[r])
      : INFO_MUTED_]);
    rightColors.push([typeof infoDeltaFontColor_ === 'function'
      ? infoDeltaFontColor_(vals[r][9], invertR && invertR[r])
      : INFO_MUTED_]);
  }
  sheet.getRange(startRow, 4, n, 1).setFontColors(leftColors);
  sheet.getRange(startRow, 10, n, 1).setFontColors(rightColors);
}

function skuColorDeltaCell_(sheet, row, col, invert) {
  var map = {};
  if (invert) map[col] = true;
  skuColorDeltaCols_(sheet, row, 1, [col], map);
}

function skuColorDeltaCols_(sheet, startRow, n, cols, invertMap) {
  if (!n) return;
  var k;
  for (k = 0; k < cols.length; k++) {
    var col = cols[k];
    var invert = !!(invertMap && invertMap[col]);
    var range = sheet.getRange(startRow, col, n, 1);
    var vals = range.getValues();
    var colors = [];
    var i;
    for (i = 0; i < n; i++) {
      var t = String(vals[i][0] || '');
      if (!t || t === '—') colors.push([INFO_MUTED_]);
      else if (t.charAt(0) === '+') colors.push([invert ? INFO_RED_ : INFO_GREEN_]);
      else if (t.charAt(0) === '-') colors.push([invert ? INFO_GREEN_ : INFO_RED_]);
      else colors.push([null]);
    }
    range.setFontColors(colors);
  }
}
