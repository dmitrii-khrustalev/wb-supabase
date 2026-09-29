/**
 * Файл 03 — отчёты из Postgres: финансы, реклама, воронка, FBS, Поставка_new.
 *
 * К-во заказов — view sheet_sales_funnel_daily.
 * Вес заказов — лист «Воронка продаж» (оверлей кг).
 * Ручная цена / регион — если в проекте есть файл 02.
 *
 * Даты: A1 (с) и A2 (по) на листе отчёта. Строки 1–2 не трогаем.
 */

var REPORT_SHEETS_ = {
  ves: { sheet: 'Вес продаж', metric: 'weight', details: true, dateWidth: 40, kind: 'finance' },
  kvo: { sheet: 'К-во продаж', metric: 'qty', details: true, dateWidth: 30, kind: 'finance' },
  ads: { sheet: 'Реклама', metric: 'ads', details: true, dateWidth: 80, kind: 'ads' },
  ordQty: { sheet: 'К-во заказов', metric: 'qty', details: true, dateWidth: 30, kind: 'orders' },
  ordVes: { sheet: 'Вес заказов', metric: 'weight', details: true, dateWidth: 40, kind: 'orders' },
  fbsQty: { sheet: 'К-во Заказов FBS', metric: 'qty', details: true, dateWidth: 30, kind: 'orders_fbs', detailsTitle: 'Детализация заказов FBS по дням' },
  fbsVes: { sheet: 'Вес заказов FBS', metric: 'weight', details: true, dateWidth: 40, kind: 'orders_fbs', detailsTitle: 'Детализация заказов FBS по дням' }
};

function runFinanceReports() {
  reportRun_([REPORT_SHEETS_.ves, REPORT_SHEETS_.kvo], true);
}

function runReportVes() {
  reportRun_([REPORT_SHEETS_.ves], false);
}

function runReportKvo() {
  reportRun_([REPORT_SHEETS_.kvo], false);
}

function runReportAds() {
  reportRun_([REPORT_SHEETS_.ads], false);
}

function runOrderReports() {
  reportRun_([REPORT_SHEETS_.ordQty, REPORT_SHEETS_.ordVes], true);
}

function runReportOrdQty() {
  reportRun_([REPORT_SHEETS_.ordQty], false);
}

function сформироватьОтчет_Заказы_Количество() {
  runReportOrdQty();
}

function runReportOrdVes() {
  reportRun_([REPORT_SHEETS_.ordVes], false);
}

function сформироватьОтчет_Заказы_Вес() {
  runReportOrdVes();
}

function runFbsOrderReports() {
  reportRun_([REPORT_SHEETS_.fbsQty, REPORT_SHEETS_.fbsVes], true);
}

function runReportFbsQty() {
  reportRun_([REPORT_SHEETS_.fbsQty], false);
}

function runReportFbsVes() {
  reportRun_([REPORT_SHEETS_.fbsVes], false);
}

function runReportPostavkaNew() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  reportEnsureMoscowTz_(ss);
  var wall0 = Date.now();
  try {
    var n = reportWritePostavkaNew_(ss);
    var ms = Date.now() - wall0;
    reportLog_(ss, 'Поставка_new', 'отчёт', n, '', ms);
    try {
      SpreadsheetApp.getUi().alert('Поставка_new: ' + (ms / 1000).toFixed(1) + ' с, строк ' + n);
    } catch (e0) {}
  } catch (err) {
    reportLog_(ss, 'Поставка_new', 'ошибка', 0, String(err), Date.now() - wall0);
    try { SpreadsheetApp.getUi().alert('«Поставка_new»: ' + err); } catch (e1) {}
  }
}

function reportRun_(specs, isBatch) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  reportEnsureMoscowTz_(ss);
  var wall0 = Date.now();
  var cacheFin = {};
  var cacheAds = {};
  var cacheOrdQty = {};
  var cacheOrdVes = {};
  var cacheEx = {};
  var cacheFbs = {};
  var parts = [];
  var i;
  for (i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var sh = ss.getSheetByName(spec.sheet);
    if (!sh) {
      reportCreateSheet_(ss, spec.sheet);
      reportLog_(ss, spec.sheet, 'нет дат', 0, 'Создал лист — поставьте даты в A1 (с) и A2 (по)', 0);
      try {
        SpreadsheetApp.getUi().alert('Создал лист «' + spec.sheet + '». Поставьте даты в A1 (с) и A2 (по) и запустите снова.');
      } catch (e0) {}
      return;
    }
    var period = reportReadPeriod_(sh);
    if (!period) {
      reportLog_(ss, spec.sheet, 'нет дат', 0, 'Нет дат в A1 / A2', 0);
      try {
        SpreadsheetApp.getUi().alert('На листе «' + spec.sheet + '» укажите даты в A1 (с) и A2 (по).');
      } catch (e1) {}
      return;
    }
  }

  var sellerId;
  try {
    sellerId = resolveSellerId_(reportSellerSlug_(ss));
  } catch (eS) {
    reportLog_(ss, '', 'ошибка', 0, String(eS), Date.now() - wall0);
    try { SpreadsheetApp.getUi().alert(String(eS)); } catch (e2) {}
    return;
  }

  var needWeight = false;
  for (i = 0; i < specs.length; i++) {
    if (specs[i].metric === 'weight' && specs[i].kind !== 'orders') needWeight = true;
    if (specs[i].kind === 'orders_fbs' && specs[i].metric === 'weight') needWeight = true;
  }
  var weightMap = needWeight ? reportWeightMap_(ss) : {};
  var priceMap = reportManualPriceMap_(ss);

  for (i = 0; i < specs.length; i++) {
    var t0 = Date.now();
    var spec2 = specs[i];
    var sheet = ss.getSheetByName(spec2.sheet);
    var per = reportReadPeriod_(sheet);
    var key = per.from + '|' + per.to + '|' + sellerId;
    try {
      var n;
      if (spec2.kind === 'ads') {
        if (!cacheFin[key]) cacheFin[key] = reportFetchRpc_('report_finance_daily', sellerId, per.from, per.to);
        if (!cacheAds[key]) cacheAds[key] = reportFetchRpc_('report_adv_daily', sellerId, per.from, per.to);
        n = reportWriteAdsSheet_(sheet, spec2, cacheAds[key], cacheFin[key]);
      } else if (spec2.kind === 'orders') {
        if (!cacheEx[key]) cacheEx[key] = reportFetchRpc_('report_order_article_extras', sellerId, per.from, per.to);
        var ordRows;
        if (spec2.metric === 'weight') {
          if (!cacheOrdVes[key]) cacheOrdVes[key] = reportLoadFunnelSheetOrders_(ss, per.from, per.to);
          ordRows = cacheOrdVes[key];
        } else {
          if (!cacheOrdQty[key]) cacheOrdQty[key] = reportLoadFunnelDbOrders_(sellerId, per.from, per.to);
          ordRows = cacheOrdQty[key];
        }
        n = reportWriteOrdersSheet_(sheet, spec2, ordRows, cacheEx[key], priceMap);
      } else if (spec2.kind === 'orders_fbs') {
        if (!cacheFbs[key]) cacheFbs[key] = reportFetchRpc_('report_fbs_orders_daily', sellerId, per.from, per.to);
        n = reportWriteFbsOrdersSheet_(sheet, spec2, cacheFbs[key], weightMap, per.from, per.to);
      } else {
        if (!cacheFin[key]) cacheFin[key] = reportFetchRpc_('report_finance_daily', sellerId, per.from, per.to);
        n = reportWriteSheet_(sheet, spec2, cacheFin[key], weightMap);
      }
      var ms = Date.now() - t0;
      reportLog_(ss, spec2.sheet, 'отчёт', n, '', ms);
      parts.push(spec2.sheet + ': ' + (ms / 1000).toFixed(1) + ' с, строк ' + n);
    } catch (err) {
      var msErr = Date.now() - t0;
      reportLog_(ss, spec2.sheet, 'ошибка', 0, String(err), msErr);
      try { SpreadsheetApp.getUi().alert('«' + spec2.sheet + '»: ' + err); } catch (e3) {}
      return;
    }
  }

  if (needWeight && !Object.keys(weightMap).length && typeof clientWeightMap_ === 'function') {
    parts.push('нет весов в «Товар+Вес» — вес будет 0');
  }
  if (isBatch) {
    reportLog_(ss, 'вес и к-во', 'отчёт', specs.length, parts.join('; '), Date.now() - wall0);
  }
  try {
    SpreadsheetApp.getUi().alert(parts.join('\n'));
  } catch (e4) {}
}

function reportSellerSlug_(ss) {
  if (typeof readSettings_ !== 'function') return 'main';
  var settings = readSettings_(ss);
  var i;
  for (i = 0; i < settings.length; i++) {
    if (settings[i].sheet === 'Финансовые ежедневные' && settings[i].slug) return settings[i].slug;
  }
  for (i = 0; i < settings.length; i++) {
    if (settings[i].slug) return settings[i].slug;
  }
  return 'main';
}

function reportCreateSheet_(ss, name) {
  var sh = ss.insertSheet(name);
  sh.getRange(1, 2).setValue('с');
  sh.getRange(2, 2).setValue('по');
  sh.setColumnWidth(1, 120);
  sh.setColumnWidth(2, 40);
  var donors = [
    'К-во Заказов FBS', 'Вес заказов FBS',
    'К-во заказов', 'Вес заказов',
    'К-во продаж', 'Вес продаж'
  ];
  var d;
  for (d = 0; d < donors.length; d++) {
    if (donors[d] === name) continue;
    var src = ss.getSheetByName(donors[d]);
    if (!src) continue;
    var a1 = src.getRange(1, 1).getValue();
    var a2 = src.getRange(2, 1).getValue();
    if (a1 && a2) {
      sh.getRange(1, 1).setValue(a1);
      sh.getRange(2, 1).setValue(a2);
      break;
    }
  }
  try { sh.getRange(1, 1, 2, 1).setNumberFormat('dd.mm.yyyy'); } catch (e) {}
  return sh;
}

function reportReadPeriod_(sh) {
  var fromIso = reportCellDateIso_(sh.getRange(1, 1));
  var toIso = reportCellDateIso_(sh.getRange(2, 1));
  if (!fromIso || !toIso) return null;
  if (fromIso > toIso) return null;
  return { from: fromIso, to: toIso };
}

/** К-во заказов: order_count из view sheet_sales_funnel_daily. */
function reportLoadFunnelDbOrders_(sellerId, fromIso, toIso) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var all = [];
  var page = 1000;
  var offset = 0;
  var qs = 'seller_id=eq.' + encodeURIComponent(sellerId)
    + '&stat_date=gte.' + encodeURIComponent(fromIso)
    + '&stat_date=lte.' + encodeURIComponent(toIso)
    + '&select=vendor_code,title,stat_date,order_count'
    + '&order=stat_date.asc,vendor_code.asc';
  while (true) {
    var url = cfg.url + '/rest/v1/sheet_sales_funnel_daily?' + qs + '&limit=' + page + '&offset=' + offset;
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: dbHeaders_(cfg.key)
    });
    var code = res.getResponseCode();
    var text = res.getContentText() || '';
    if (code !== 200 && code !== 206 && code !== 416) {
      throw new Error('БД HTTP ' + code + ' ' + text.substring(0, 400));
    }
    var rows = [];
    if (text && code !== 416) {
      rows = JSON.parse(text);
      if (!rows || !rows.length) rows = [];
    }
    var i;
    for (i = 0; i < rows.length; i++) all.push(rows[i]);
    if (rows.length < page) break;
    offset += page;
    if (offset > 200000) break;
  }
  var byKey = {};
  var r;
  for (r = 0; r < all.length; r++) {
    var row = all[r];
    var art = String(row.vendor_code == null ? '' : row.vendor_code).trim();
    if (!art || art === '-') continue;
    var iso = reportDateIso_(row.stat_date);
    if (!iso) continue;
    var name = String(row.title == null ? '' : row.title).trim();
    if (!name || name === '-') name = art;
    var key = art.toLowerCase() + '\t' + iso;
    if (!byKey[key]) byKey[key] = { sa_name: art, title: name, day: iso, qty: 0 };
    else if ((!byKey[key].title || byKey[key].title === byKey[key].sa_name) && name && name !== art) {
      byKey[key].title = name;
    }
    byKey[key].qty += Number(row.order_count) || 0;
  }
  var out = [];
  var k;
  for (k in byKey) {
    if (byKey.hasOwnProperty(k)) out.push(byKey[k]);
  }
  return out;
}

function reportFindHeaderCol_(headers, aliases) {
  var lower = [];
  var i;
  for (i = 0; i < headers.length; i++) lower.push(String(headers[i] || '').trim().toLowerCase());
  var a;
  for (a = 0; a < aliases.length; a++) {
    var want = String(aliases[a] || '').trim().toLowerCase();
    if (!want) continue;
    for (i = 0; i < lower.length; i++) {
      if (lower[i] === want) return i;
    }
  }
  return -1;
}

/** Вес заказов: кг с «Воронка продаж» (оверлей), не из базы. */
function reportLoadFunnelSheetOrders_(ss, fromIso, toIso) {
  var sh = ss.getSheetByName('Воронка продаж');
  if (!sh) throw new Error('Нет листа «Воронка продаж». Отчёт веса заказов берёт кг оттуда.');
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 2) throw new Error('На «Воронка продаж» нет данных.');
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var dateCol = reportFindHeaderCol_(headers, ['дата', 'дата статы', 'stat_date']);
  var artCol = reportFindHeaderCol_(headers, ['арт. продавца', 'артикул продавца', 'артикул', 'vendor_code']);
  var titleCol = reportFindHeaderCol_(headers, ['название', 'title', 'наименование']);
  var totalCol = reportFindHeaderCol_(headers, ['вес, кг за 1 шт сумма заказов']);
  var unitCol = reportFindHeaderCol_(headers, ['вес, кг за 1 шт', 'weight_kg']);
  var qtyCol = reportFindHeaderCol_(headers, ['заказы шт', 'заказы', 'order_count']);
  if (dateCol < 0) throw new Error('На «Воронка продаж» нет колонки даты.');
  if (artCol < 0) throw new Error('На «Воронка продаж» нет колонки артикула.');
  if (totalCol < 0 && (unitCol < 0 || qtyCol < 0)) {
    throw new Error('На «Воронка продаж» нет «Вес, кг за 1 шт сумма заказов». Сначала загрузите воронку — оверлей подставит вес.');
  }
  var data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var shownDates = sh.getRange(2, dateCol + 1, lastRow - 1, 1).getDisplayValues();
  var out = [];
  var i;
  for (i = 0; i < data.length; i++) {
    var row = data[i];
    var iso = reportParseDisplayDate_(shownDates[i][0]) || reportDateIso_(row[dateCol]);
    if (!iso || iso < fromIso || iso > toIso) continue;
    var art = String(row[artCol] == null ? '' : row[artCol]).trim();
    if (!art || art === '-') continue;
    var name = titleCol >= 0 ? String(row[titleCol] == null ? '' : row[titleCol]).trim() : '';
    if (!name || name === '-') name = art;
    var weight = 0;
    if (totalCol >= 0) weight = Number(row[totalCol]) || 0;
    else {
      var unit = Number(row[unitCol]) || 0;
      var qty = Number(row[qtyCol]) || 0;
      weight = unit * qty;
    }
    out.push({
      sa_name: art,
      title: name,
      day: iso,
      qty: qtyCol >= 0 ? (Number(row[qtyCol]) || 0) : 0,
      weight: weight
    });
  }
  return out;
}

function reportSheetTz_() {
  return TZ || 'Europe/Moscow';
}

function reportEnsureMoscowTz_(ss) {
  if (!ss) return;
  var tz = reportSheetTz_();
  try {
    if (ss.getSpreadsheetTimeZone() !== tz) ss.setSpreadsheetTimeZone(tz);
  } catch (e) {}
}

function reportCellDateIso_(range) {
  var shown = String(range.getDisplayValue() || '').trim();
  var fromShown = reportParseDisplayDate_(shown);
  if (fromShown) return fromShown;
  return reportDateIso_(range.getValue());
}

function reportParseDisplayDate_(str) {
  if (!str) return '';
  str = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
  var m = str.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})(?:\b|$)/);
  if (!m) return '';
  var y = m[3].length === 2 ? '20' + m[3] : m[3];
  var dd = ('0' + m[1]).slice(-2);
  var mm = ('0' + m[2]).slice(-2);
  return y + '-' + mm + '-' + dd;
}

function reportDateIso_(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'string' || typeof val === 'number') {
    var s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      var iso = s.indexOf('T') >= 0 ? s : s.replace(' ', 'T');
      if (!/[zZ]$/.test(iso) && !/[+-]\d{2}:?\d{2}$/.test(iso)) iso += '+03:00';
      var instant = new Date(iso);
      if (!isNaN(instant.getTime())) {
        return Utilities.formatDate(instant, reportSheetTz_(), 'yyyy-MM-dd');
      }
    }
  }
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, reportSheetTz_(), 'yyyy-MM-dd');
  }
  return reportParseDisplayDate_(String(val).trim());
}

function reportFetchRpc_(fnName, sellerId, fromIso, toIso, extra) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var all = [];
  var page = 1000;
  var offset = 0;
  var body = {
    p_seller_id: sellerId,
    p_from: fromIso,
    p_to: toIso
  };
  if (extra) {
    var k;
    for (k in extra) {
      if (extra.hasOwnProperty(k) && extra[k] != null) body[k] = extra[k];
    }
  }
  while (true) {
    var headers = dbHeaders_(cfg.key);
    headers['Content-Type'] = 'application/json';
    var url = cfg.url + '/rest/v1/rpc/' + encodeURIComponent(fnName) + '?limit=' + page + '&offset=' + offset;
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: headers,
      payload: JSON.stringify(body)
    });
    var code = res.getResponseCode();
    var text = res.getContentText() || '';
    if (code !== 200 && code !== 206 && code !== 416) {
      throw new Error('БД HTTP ' + code + ' ' + text.substring(0, 400));
    }
    var rows = [];
    if (text && code !== 416) {
      rows = JSON.parse(text);
      if (!rows || !rows.length) rows = [];
    }
    for (var i = 0; i < rows.length; i++) all.push(rows[i]);
    if (rows.length < page) break;
    offset += page;
    if (offset > 200000) break;
  }
  return all;
}

function reportFetchDaily_(sellerId, fromIso, toIso) {
  return reportFetchRpc_('report_finance_daily', sellerId, fromIso, toIso);
}

function reportWeightMap_(ss) {
  if (typeof clientWeightMap_ === 'function') return clientWeightMap_(ss) || {};
  return {};
}

function reportManualPriceMap_(ss) {
  if (typeof clientManualPriceMap_ === 'function') return clientManualPriceMap_(ss) || {};
  return {};
}

function reportMetric_(row, metric, weightMap) {
  var qty = Number(row.qty) || 0;
  if (metric === 'qty') return qty;
  var art = String(row.sa_name || '').trim().toLowerCase();
  var w = weightMap[art];
  if (w == null) w = 0;
  return qty * w;
}

function reportWriteSheet_(sheet, spec, rows, weightMap) {
  var result = {};
  var datesObj = {};
  var r;
  for (r = 0; r < rows.length; r++) {
    var row = rows[r];
    var art = String(row.sa_name || '').trim();
    var name = String(row.title || '').trim();
    if (!art || art === '-' || !name || name === '-') continue;
    var dayRaw = row.day;
    var iso = reportDateIso_(dayRaw);
    if (!iso) continue;
    var d = iso.substring(8, 10) + '.' + iso.substring(5, 7);
    var val = reportMetric_(row, spec.metric, weightMap);
    datesObj[iso] = d;
    var key = art + '|' + name;
    if (!result[key]) result[key] = {};
    result[key][d] = (result[key][d] || 0) + val;
  }

  var isoList = [];
  for (var isoKey in datesObj) {
    if (datesObj.hasOwnProperty(isoKey)) isoList.push(isoKey);
  }
  isoList.sort();
  var dateList = [];
  var di;
  for (di = 0; di < isoList.length; di++) dateList.push(datesObj[isoList[di]]);

  var keys = [];
  for (var k in result) {
    if (result.hasOwnProperty(k)) keys.push(k);
  }
  keys.sort(function (a, b) {
    return a.split('|')[0].localeCompare(b.split('|')[0], 'ru');
  });

  var colTotals = [];
  for (di = 0; di < dateList.length; di++) colTotals.push(0);
  var grand = 0;
  var dataRows = [];
  var i;
  for (i = 0; i < keys.length; i++) {
    var parts = keys[i].split('|');
    var rowOut = [parts[0], parts[1]];
    var sumRow = 0;
    for (di = 0; di < dateList.length; di++) {
      var v = result[keys[i]][dateList[di]] || 0;
      rowOut.push(v);
      sumRow += v;
      colTotals[di] += v;
      grand += v;
    }
    rowOut.push(sumRow);
    dataRows.push(rowOut);
  }

  var header = ['Артикул', 'Наименование'].concat(dateList);
  header.push('Итого');
  var output = [header, ['Итого', ''].concat(colTotals).concat([grand])];
  for (i = 0; i < dataRows.length; i++) output.push(dataRows[i]);

  reportClearBody_(sheet);
  var cols = output[0].length;
  var outRange = sheet.getRange(3, 1, output.length, cols);
  outRange.setValues(output);
  if (cols > 2) {
    try { sheet.getRange(3, 3, 1, cols - 2).setNumberFormat('@'); } catch (eTxt) {}
  }
  outRange.setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setVerticalAlignment('middle');
  sheet.getRange(3, 1, output.length, 2).setHorizontalAlignment('left');
  sheet.getRange(3, 1, 1, cols).setFontWeight('bold').setBackground('#f1f1f1').setHorizontalAlignment('center');
  if (cols > 2) sheet.getRange(3, 3, 1, cols - 2).setTextRotation(90);
  sheet.getRange(4, 1, 1, cols).setFontWeight('bold').setBackground('#e8e8e8');
  var dateWidth = spec.dateWidth || 40;
  var col;
  for (col = 3; col <= cols; col++) sheet.setColumnWidth(col, dateWidth);
  sheet.setRowHeight(3, 45);
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 300);
  try { sheet.getRange(1, 1, 2, 1).setNumberFormat('dd.mm.yyyy'); } catch (eD) {}

  reportFormatSheet_(sheet, spec);
  return dataRows.length;
}

function reportWriteOrdersSheet_(sheet, spec, rows, extraRows, priceMap) {
  var extras = {};
  var e;
  for (e = 0; e < extraRows.length; e++) {
    var x = extraRows[e];
    var xk = reportArtKey_(x.sa_name);
    if (!xk) continue;
    extras[xk] = x;
  }
  var result = {};
  var datesObj = {};
  var r;
  for (r = 0; r < rows.length; r++) {
    var row = rows[r];
    var art = String(row.sa_name || '').trim();
    var name = String(row.title || '').trim();
    if (!art || art === '-' || !name || name === '-') continue;
    var iso = reportDateIso_(row.day);
    if (!iso) continue;
    var d = iso.substring(8, 10) + '.' + iso.substring(5, 7);
    var val = spec.metric === 'weight' ? (Number(row.weight) || 0) : (Number(row.qty) || 0);
    datesObj[iso] = d;
    var key = art + '|' + name;
    if (!result[key]) result[key] = {};
    result[key][d] = (result[key][d] || 0) + val;
  }

  var isoList = [];
  var isoKey;
  for (isoKey in datesObj) {
    if (datesObj.hasOwnProperty(isoKey)) isoList.push(isoKey);
  }
  isoList.sort();
  var dateList = [];
  var di;
  for (di = 0; di < isoList.length; di++) dateList.push(datesObj[isoList[di]]);

  var keys = [];
  var k;
  for (k in result) {
    if (result.hasOwnProperty(k)) keys.push(k);
  }
  keys.sort(function (a, b) {
    return a.split('|')[0].localeCompare(b.split('|')[0], 'ru');
  });

  var colTotals = [];
  for (di = 0; di < dateList.length; di++) colTotals.push(0);
  var grand = 0;
  var grandRet = 0;
  var grandSt = 0;
  var twAvg = 0;
  var twCur = 0;
  var twMan = 0;
  var totalQty = 0;
  var dataRows = [];
  var i;
  for (i = 0; i < keys.length; i++) {
    var parts = keys[i].split('|');
    var artKey = reportArtKey_(parts[0]);
    var ex = extras[artKey] || {};
    var ret = Number(ex.returns) || 0;
    var stocks = Number(ex.stocks) || 0;
    var avgP = 0;
    var pCnt = Number(ex.price_count) || 0;
    var pSum = Number(ex.price_sum) || 0;
    if (pCnt > 0) avgP = Math.round((pSum / pCnt) * 100) / 100;
    else if (ex.avg_price != null) avgP = Number(ex.avg_price) || 0;
    var curP = Number(ex.current_price) || 0;
    var manP = priceMap[artKey] != null ? priceMap[artKey] : 0;
    var stDate = reportToSheetDate_(ex.stock_date);
    var rowOut = [parts[0], parts[1]];
    var sumRow = 0;
    for (di = 0; di < dateList.length; di++) {
      var v = result[keys[i]][dateList[di]] || 0;
      rowOut.push(v);
      sumRow += v;
      colTotals[di] += v;
      grand += v;
    }
    rowOut.push(sumRow, ret, stocks, avgP, curP, manP, stDate);
    dataRows.push(rowOut);
    grandRet += ret;
    grandSt += stocks;
    if (sumRow > 0) {
      twAvg += avgP * sumRow;
      twCur += curP * sumRow;
      twMan += manP * sumRow;
      totalQty += sumRow;
    }
  }

  var avgT = 0;
  var curT = 0;
  var manT = 0;
  if (totalQty > 0) {
    avgT = twAvg / totalQty;
    curT = twCur / totalQty;
    manT = twMan / totalQty;
  }
  var header = ['Артикул', 'Наименование'].concat(dateList);
  header.push('Итого', 'Возвраты', 'Остатки', 'Ср. цена', 'Текущ цена', 'Цена', 'Дата остатка');
  var totalRow = ['Итого', ''].concat(colTotals).concat([grand, grandRet, grandSt, avgT, curT, manT, '']);
  var output = [header, totalRow];
  for (i = 0; i < dataRows.length; i++) output.push(dataRows[i]);

  reportClearBody_(sheet);
  var cols = output[0].length;
  var outRange = sheet.getRange(3, 1, output.length, cols);
  outRange.setValues(output);
  if (dateList.length) {
    try { sheet.getRange(3, 3, 1, dateList.length).setNumberFormat('@'); } catch (eTxt) {}
  }
  outRange.setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setVerticalAlignment('middle');
  sheet.getRange(3, 1, output.length, 2).setHorizontalAlignment('left');
  var headerRange = sheet.getRange(3, 1, 1, cols);
  headerRange.setFontWeight('bold').setBackground('#f1f1f1').setHorizontalAlignment('center').setWrap(true);
  if (dateList.length) sheet.getRange(3, 3, 1, dateList.length).setTextRotation(90);
  sheet.getRange(3, 3 + dateList.length, 1, 1).setTextRotation(90);
  if (cols >= 4 + dateList.length) {
    sheet.getRange(3, 4 + dateList.length, 1, cols - (3 + dateList.length)).setTextRotation(0);
  }
  sheet.getRange(4, 1, 1, cols).setFontWeight('bold').setBackground('#e8e8e8').setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_);
  var dateWidth = spec.dateWidth || 40;
  var col;
  for (col = 3; col <= 2 + dateList.length; col++) sheet.setColumnWidth(col, dateWidth);
  sheet.setColumnWidth(3 + dateList.length, dateWidth);
  sheet.setColumnWidth(4 + dateList.length, 55);
  sheet.setColumnWidth(5 + dateList.length, 55);
  sheet.setColumnWidth(6 + dateList.length, 55);
  sheet.setColumnWidth(7 + dateList.length, 55);
  sheet.setColumnWidth(8 + dateList.length, 55);
  sheet.setColumnWidth(9 + dateList.length, 90);
  sheet.setRowHeight(3, 55);
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 300);
  try { sheet.getRange(1, 1, 2, 1).setNumberFormat('dd.mm.yyyy'); } catch (eD2) {}

  reportFormatSheet_(sheet, spec);
  return dataRows.length;
}

/** FBS: как 02_reports — дни подряд, хвост Итого/Остатки/Продано/В пути/Отменено. */
function reportWriteFbsOrdersSheet_(sheet, spec, rows, weightMap, fromIso, toIso) {
  var isWeight = spec.metric === 'weight';
  weightMap = weightMap || {};

  var dateList = [];
  var fromT = reportJsDateFromIso_(fromIso);
  var toT = reportJsDateFromIso_(toIso);
  if (!fromT || !toT) throw new Error('Укажите даты в A1 (с) и A2 (по).');
  var cur = new Date(fromT.getFullYear(), fromT.getMonth(), fromT.getDate());
  var end = new Date(toT.getFullYear(), toT.getMonth(), toT.getDate());
  while (cur.getTime() <= end.getTime()) {
    var iso = Utilities.formatDate(cur, reportSheetTz_(), 'yyyy-MM-dd');
    dateList.push(iso.substring(8, 10) + '.' + iso.substring(5, 7));
    cur.setDate(cur.getDate() + 1);
  }

  var result = {};
  var r;
  for (r = 0; r < rows.length; r++) {
    var row = rows[r];
    var art = String(row.sa_name || '').trim();
    var name = String(row.title || '').trim();
    if (!art || art === '-') continue;
    if (!name || name === '-') name = art;
    var dayIso = reportDateIso_(row.day);
    if (!dayIso) continue;
    var d = dayIso.substring(8, 10) + '.' + dayIso.substring(5, 7);
    var artKey = reportArtKey_(art);
    var unitW = weightMap[artKey] != null ? Number(weightMap[artKey]) || 0 : 0;
    var mult = isWeight ? unitW : 1;
    var key = art + '|' + name;
    if (!result[key]) {
      result[key] = { data: {}, sold: 0, transit: 0, cancel: 0, stocks: 0 };
    }
    var q = (Number(row.qty) || 0) * mult;
    result[key].data[d] = (result[key].data[d] || 0) + q;
    result[key].sold += (Number(row.sold) || 0) * mult;
    result[key].transit += (Number(row.transit) || 0) * mult;
    result[key].cancel += (Number(row.cancel) || 0) * mult;
    result[key].stocks = (Number(row.stocks) || 0) * mult;
  }

  var keys = [];
  var k;
  for (k in result) {
    if (result.hasOwnProperty(k)) keys.push(k);
  }
  keys.sort(function (a, b) {
    return a.split('|')[0].localeCompare(b.split('|')[0], 'ru');
  });

  var colTotals = [];
  var di;
  for (di = 0; di < dateList.length; di++) colTotals.push(0);
  var grand = 0;
  var grandSold = 0;
  var grandTransit = 0;
  var grandCancel = 0;
  var grandStocks = 0;
  var dataRows = [];
  var i;
  for (i = 0; i < keys.length; i++) {
    var parts = keys[i].split('|');
    var item = result[keys[i]];
    var rowOut = [parts[0], parts[1]];
    var sumRow = 0;
    for (di = 0; di < dateList.length; di++) {
      var v = item.data[dateList[di]] || 0;
      rowOut.push(v);
      sumRow += v;
      colTotals[di] += v;
      grand += v;
    }
    rowOut.push(sumRow, item.stocks || 0, item.sold, item.transit, item.cancel);
    dataRows.push(rowOut);
    grandSold += item.sold;
    grandTransit += item.transit;
    grandCancel += item.cancel;
    grandStocks += item.stocks || 0;
  }

  var header = ['Артикул', 'Наименование'].concat(dateList).concat(
    ['Итого', 'Остатки', 'Продано', 'В пути', 'Отменено']
  );
  var totalRow = ['Итого', ''].concat(colTotals).concat(
    [grand, grandStocks, grandSold, grandTransit, grandCancel]
  );
  var output = [header, totalRow];
  for (i = 0; i < dataRows.length; i++) output.push(dataRows[i]);

  reportClearBody_(sheet);
  var cols = output[0].length;
  var outRange = sheet.getRange(3, 1, output.length, cols);
  outRange.setValues(output);
  if (dateList.length) {
    try { sheet.getRange(3, 3, 1, dateList.length).setNumberFormat('@'); } catch (eTxt) {}
  }
  outRange.setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setVerticalAlignment('middle');
  sheet.getRange(3, 1, output.length, 2).setHorizontalAlignment('left');
  var headerRange = sheet.getRange(3, 1, 1, cols);
  headerRange.setFontWeight('bold').setBackground('#f1f1f1').setHorizontalAlignment('center').setWrap(true);
  if (dateList.length) sheet.getRange(3, 3, 1, dateList.length).setTextRotation(90);
  var itogoCol = 3 + dateList.length;
  sheet.getRange(3, itogoCol).setTextRotation(90);
  if (cols > itogoCol) {
    sheet.getRange(3, itogoCol + 1, 1, cols - itogoCol).setTextRotation(0);
  }
  sheet.getRange(4, 1, 1, cols).setFontWeight('bold').setBackground('#e8e8e8').setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_);

  var dateWidth = spec.dateWidth || (isWeight ? 40 : 30);
  var col;
  for (col = 3; col <= 2 + dateList.length; col++) sheet.setColumnWidth(col, dateWidth);
  sheet.setColumnWidth(itogoCol, dateWidth);
  sheet.setColumnWidth(itogoCol + 1, isWeight ? 55 : 70);
  sheet.setColumnWidth(itogoCol + 2, isWeight ? 55 : 70);
  sheet.setColumnWidth(itogoCol + 3, isWeight ? 55 : 70);
  sheet.setColumnWidth(itogoCol + 4, isWeight ? 55 : 80);
  sheet.setRowHeight(3, 55);
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 300);
  try { sheet.getRange(1, 1, 2, 1).setNumberFormat('dd.mm.yyyy'); } catch (eD) {}

  reportFormatSheet_(sheet, spec);
  return dataRows.length;
}

function reportToSheetDate_(val) {
  var iso = reportDateIso_(val);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  if (typeof calendarDateUtcNoon_ === 'function') return calendarDateUtcNoon_(iso);
  var p = iso.split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0));
}

function reportJsDateFromIso_(val) {
  var iso = reportDateIso_(val);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  var p = iso.split('-');
  var y = Number(p[0]);
  var m = Number(p[1]);
  var d = Number(p[2]);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function reportArtKey_(art) {
  return String(art || '').trim().toLowerCase();
}

function reportWriteAdsSheet_(sheet, spec, adsRows, finRows) {
  var result = {};
  var datesObj = {};
  var r;
  function ensure_(art, title) {
    var key = reportArtKey_(art);
    if (!key || key === '-') return null;
    if (!result[key]) result[key] = { art: String(art).trim(), title: '', days: {} };
    if (!result[key].title && title) result[key].title = String(title).trim();
    return result[key];
  }
  for (r = 0; r < adsRows.length; r++) {
    var a = adsRows[r];
    var rec = ensure_(a.sa_name, a.title);
    if (!rec) continue;
    var iso = reportDateIso_(a.day);
    if (!iso) continue;
    var d = iso.substring(8, 10) + '.' + iso.substring(5, 7);
    datesObj[iso] = d;
    if (!rec.days[d]) rec.days[d] = { ads: 0, sales: 0 };
    rec.days[d].ads += Number(a.spend) || 0;
  }
  for (r = 0; r < finRows.length; r++) {
    var f = finRows[r];
    var recF = ensure_(f.sa_name, f.title);
    if (!recF) continue;
    var isoF = reportDateIso_(f.day);
    if (!isoF) continue;
    var dF = isoF.substring(8, 10) + '.' + isoF.substring(5, 7);
    datesObj[isoF] = dF;
    if (!recF.days[dF]) recF.days[dF] = { ads: 0, sales: 0 };
    recF.days[dF].sales += Number(f.amount) || 0;
  }

  var isoList = [];
  var isoKey;
  for (isoKey in datesObj) {
    if (datesObj.hasOwnProperty(isoKey)) isoList.push(isoKey);
  }
  isoList.sort();
  var dateList = [];
  var di;
  for (di = 0; di < isoList.length; di++) dateList.push(datesObj[isoList[di]]);

  var keys = [];
  var k;
  for (k in result) {
    if (result.hasOwnProperty(k) && result[k].title && result[k].title !== '-') keys.push(k);
  }
  keys.sort(function (a, b) {
    return result[a].art.localeCompare(result[b].art, 'ru');
  });

  var header = ['Артикул', 'Наименование'];
  for (di = 0; di < dateList.length; di++) {
    header.push(dateList[di] + '\nРасходы', dateList[di] + '\nПродажи', dateList[di] + '\nРеклама');
  }
  header.push('Итого\nРасходы', 'Итого\nПродажи', 'Итого\nРеклама');

  var colTotals = [];
  for (di = 0; di < dateList.length * 3; di++) colTotals.push(0);
  var dataRows = [];
  var i;
  for (i = 0; i < keys.length; i++) {
    var recR = result[keys[i]];
    var rowOut = [recR.art, recR.title];
    var totAds = 0;
    var totSales = 0;
    for (di = 0; di < dateList.length; di++) {
      var cell = recR.days[dateList[di]] || { ads: 0, sales: 0 };
      var ads = cell.ads || 0;
      var sales = cell.sales || 0;
      var pct = sales !== 0 ? ads / sales : 0;
      rowOut.push(ads, sales, pct);
      totAds += ads;
      totSales += sales;
      colTotals[di * 3] += ads;
      colTotals[di * 3 + 1] += sales;
    }
    rowOut.push(totAds, totSales, totSales !== 0 ? totAds / totSales : 0);
    dataRows.push(rowOut);
  }

  var totalRow = ['ИТОГО', ''];
  var gAds = 0;
  var gSales = 0;
  for (di = 0; di < dateList.length; di++) {
    var tAds = colTotals[di * 3];
    var tSales = colTotals[di * 3 + 1];
    totalRow.push(tAds, tSales, tSales !== 0 ? tAds / tSales : 0);
    gAds += tAds;
    gSales += tSales;
  }
  totalRow.push(gAds, gSales, gSales !== 0 ? gAds / gSales : 0);

  var output = [header, totalRow];
  for (i = 0; i < dataRows.length; i++) output.push(dataRows[i]);

  reportClearBody_(sheet);
  var cols = output[0].length;
  var outRange = sheet.getRange(3, 1, output.length, cols);
  outRange.setValues(output);
  if (cols > 2) {
    try { sheet.getRange(3, 3, 1, cols - 2).setNumberFormat('@'); } catch (eTxt) {}
  }
  outRange.setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setVerticalAlignment('middle');
  sheet.getRange(3, 1, output.length, 2).setHorizontalAlignment('left');
  var headerRange = sheet.getRange(3, 1, 1, cols);
  headerRange.setFontWeight('bold').setBackground('#f1f1f1').setHorizontalAlignment('center').setWrap(true);
  sheet.setRowHeight(3, 45);
  sheet.getRange(4, 1, 1, cols).setFontWeight('bold').setBackground('#e8e8e8');
  sheet.setColumnWidth(1, 90);
  sheet.setColumnWidth(2, 300);
  var dateWidth = spec.dateWidth || 80;
  var col;
  for (col = 3; col <= cols; col++) sheet.setColumnWidth(col, dateWidth);
  try { sheet.getRange(1, 1, 2, 1).setNumberFormat('dd.mm.yyyy'); } catch (eD) {}

  var lastRow = sheet.getLastRow();
  if (lastRow >= 4) {
    for (di = 0; di < dateList.length; di++) {
      var adsCol = 3 + di * 3;
      var salesCol = adsCol + 1;
      var pctCol = adsCol + 2;
      sheet.getRange(4, adsCol, lastRow - 3, 1).setNumberFormat('#,##0.00');
      sheet.getRange(4, salesCol, lastRow - 3, 1).setNumberFormat('#,##0.00');
      sheet.getRange(4, pctCol, lastRow - 3, 1).setNumberFormat('0.00%');
    }
    sheet.getRange(4, cols - 2, lastRow - 3, 1).setNumberFormat('#,##0.00');
    sheet.getRange(4, cols - 1, lastRow - 3, 1).setNumberFormat('#,##0.00');
    sheet.getRange(4, cols, lastRow - 3, 1).setNumberFormat('0.00%');
  }

  reportFormatSheet_(sheet, spec);
  return dataRows.length;
}

function reportClearBody_(sheet) {
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 3 || lastCol < 1) return;
  try { sheet.getRange(1, 3, 2, lastCol).breakApart(); } catch (e) {}
  var filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(3, 1, lastRow - 2, lastCol).clear();
}

function reportTrimExtra_(sheet) {
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return;
  var lastCol = sheet.getLastColumn();
  var maxCols = sheet.getMaxColumns();
  if (lastCol < 1) lastCol = 1;
  var used = 2;
  var headers = sheet.getRange(3, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (headers[i] !== '' && headers[i] != null) used = i + 1;
  }
  if (maxCols <= used) return;
  try { sheet.getRange(1, 1, Math.min(2, lastRow), maxCols).breakApart(); } catch (e1) {}
  var filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.deleteColumns(used + 1, maxCols - used);
}

function reportColLetter_(column) {
  var result = '';
  var col = column;
  while (col > 0) {
    var remainder = (col - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    col = Math.floor((col - 1) / 26);
  }
  return result;
}

function reportA1_(row, col, numRows, numCols) {
  var r2 = row + (numRows || 1) - 1;
  var c2 = col + (numCols || 1) - 1;
  var a = reportColLetter_(col) + row;
  if (r2 === row && c2 === col) return a;
  return a + ':' + reportColLetter_(c2) + r2;
}

function reportRangeListDo_(sheet, a1s, fn) {
  if (!sheet || !a1s || !a1s.length) return;
  var CHUNK = 90;
  var i;
  for (i = 0; i < a1s.length; i += CHUNK) {
    fn(sheet.getRangeList(a1s.slice(i, i + CHUNK)));
  }
}

function reportMergeBlocks_(sheet, blocks) {
  if (!sheet || !blocks || !blocks.length) return;
  var i;
  var b;
  var requests = [];
  for (i = 0; i < blocks.length; i++) {
    b = blocks[i];
    requests.push({
      mergeCells: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: b.row - 1,
          endRowIndex: b.row - 1 + (b.numRows || 1),
          startColumnIndex: b.col - 1,
          endColumnIndex: b.col - 1 + (b.numCols || 1)
        },
        mergeType: 'MERGE_ALL'
      }
    });
  }
  try {
    SpreadsheetApp.flush();
    var res = UrlFetchApp.fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheet.getParent().getId()) + ':batchUpdate',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ requests: requests }),
        muteHttpExceptions: true
      }
    );
    if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) return;
  } catch (eBatch) {}
  for (i = 0; i < blocks.length; i++) {
    b = blocks[i];
    try { sheet.getRange(b.row, b.col, b.numRows || 1, b.numCols || 1).mergeAcross(); } catch (eOne) {}
  }
}

function reportIsDateHeader_(headerValue) {
  if (headerValue instanceof Date) return true;
  var s = String(headerValue == null ? '' : headerValue).trim();
  if (!s) return false;
  if (s.match(/^\d{1,2}\.\d{1,2}/)) return true;
  return false;
}

function reportHeaderCol_(headersRow, name) {
  var i;
  for (i = 0; i < headersRow.length; i++) {
    if (String(headersRow[i] || '').trim() === name) return i + 1;
  }
  return 0;
}

function reportFillExtraCols_(sheet, headersRow, lastRow, lastCol) {
  if (lastRow < 3) return;
  var names = ['Возвраты', 'Остатки', 'Ср. цена', 'Текущ цена', 'Цена'];
  var colors = ['#ffc000', '#ccffcc', '#fff2cc', '#a4c2f4', '#d5a6bd'];
  var i;
  for (i = 0; i < names.length; i++) {
    var col = reportHeaderCol_(headersRow, names[i]);
    if (!col || col > lastCol) continue;
    sheet.getRange(3, col, lastRow - 2, 1).setBackground(colors[i]);
    sheet.getRange(4, col).setFontWeight('bold');
  }
  // FBS: Продано / В пути / Отменено — как formatCurrentSheet в 02_reports
  var fbsNames = ['Продано', 'В пути', 'Отменено'];
  var fbsColors = ['#ffff00', '#00b0f0', '#ffc000'];
  for (i = 0; i < fbsNames.length; i++) {
    var fCol = reportHeaderCol_(headersRow, fbsNames[i]);
    if (!fCol || fCol > lastCol) continue;
    sheet.getRange(3, fCol, lastRow - 2, 1).setBackground(fbsColors[i]);
    sheet.getRange(4, fCol).setFontWeight('bold');
  }
  var dateCol = reportHeaderCol_(headersRow, 'Дата остатка');
  if (dateCol && dateCol <= lastCol) {
    sheet.getRange(3, dateCol).setBackground('#d9ead3').setFontWeight('bold');
  }
}

function reportFormatOrderNumbers_(sheet, type, dateColumns, headersRow, lastRow) {
  var numFmt = type === 'weight' ? '#,##0.000' : '#,##0';
  var totFmt = type === 'weight' ? '#,##0.000' : '0';
  var i;
  var col;
  if (lastRow >= 5) {
    for (i = 0; i < dateColumns.length; i++) {
      sheet.getRange(5, dateColumns[i], lastRow - 4, 1).setNumberFormat(numFmt).setHorizontalAlignment('center');
    }
  }
  col = reportHeaderCol_(headersRow, 'Итого');
  if (lastRow >= 5 && col) {
    sheet.getRange(5, col, lastRow - 4, 1).setNumberFormat(numFmt).setHorizontalAlignment('center');
  }
  if (lastRow >= 4 && dateColumns.length) {
    sheet.getRange(4, dateColumns[0], 1, dateColumns.length).setNumberFormat(totFmt);
    if (col) sheet.getRange(4, col).setNumberFormat(totFmt);
  }
  var avgCol = reportHeaderCol_(headersRow, 'Ср. цена');
  var curCol = reportHeaderCol_(headersRow, 'Текущ цена');
  var manCol = reportHeaderCol_(headersRow, 'Цена');
  var retCol = reportHeaderCol_(headersRow, 'Возвраты');
  var stCol = reportHeaderCol_(headersRow, 'Остатки');
  var stDateCol = reportHeaderCol_(headersRow, 'Дата остатка');
  if (lastRow >= 4) {
    if (avgCol) sheet.getRange(4, avgCol, lastRow - 3, 1).setNumberFormat('#,##0.00');
    if (curCol) sheet.getRange(4, curCol, lastRow - 3, 1).setNumberFormat('#,##0.00');
    if (manCol) sheet.getRange(4, manCol, lastRow - 3, 1).setNumberFormat('#,##0.00');
    if (stDateCol && lastRow >= 5) {
      sheet.getRange(5, stDateCol, lastRow - 4, 1).setNumberFormat('dd.mm.yyyy').setHorizontalAlignment('center');
    }
  }
  if (lastRow >= 4) {
    if (retCol) sheet.getRange(4, retCol, lastRow - 3, 1).setNumberFormat('#,##0');
    if (stCol) sheet.getRange(4, stCol, lastRow - 3, 1).setNumberFormat('#,##0');
  }
}

function reportFormatSheet_(sheet, spec) {
  // Как formatCurrentSheet в боевой книге: зелёная детализация, Итого, CF, Calibri, фильтр с 3-й строки.
  reportTrimExtra_(sheet);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 5 || lastCol < 3) return;

  var headersRow = sheet.getRange(3, 1, 1, lastCol).getValues()[0];
  var dateColumns = [];
  var col;
  for (col = 3; col <= lastCol; col++) {
    if (reportIsDateHeader_(headersRow[col - 1])) dateColumns.push(col);
  }
  if (!dateColumns.length) return;

  if (lastCol >= 3) {
    try { sheet.getRange(1, 3, 2, lastCol - 2).breakApart(); } catch (e) {}
    sheet.getRange(1, 3, 1, lastCol - 2).clear();
    sheet.getRange(2, 3, 1, lastCol - 2).clear();
  }

  var dataStartRow = 5;
  var i;
  if (spec.details) {
    var firstDateCol = dateColumns[0];
    var lastDateCol = dateColumns[dateColumns.length - 1];
    var mergeRange = sheet.getRange(1, firstDateCol, 1, lastDateCol - firstDateCol + 1);
    mergeRange.merge();
    sheet.getRange(1, firstDateCol)
      .setValue(spec.detailsTitle || 'Детализация заказов по дням')
      .setFontWeight('bold')
      .setBackground('#0ee247')
      .setFontColor('#000000')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setFontFamily(STYLE_FONT_)
      .setFontSize(STYLE_SIZE_);
    for (var row = 2; row <= 4; row++) {
      for (i = 0; i < dateColumns.length; i++) {
        sheet.getRange(row, dateColumns[i]).setBackground('#0ee247');
      }
    }
  }

  var type = spec.metric === 'qty' ? 'quantity' : (spec.metric === 'weight' ? 'weight' : '');
  var numFmt = type === 'weight' ? '#,##0.000' : (type === 'quantity' ? '#,##0' : '');
  var numCols = dateColumns.slice();
  for (col = 1; col <= lastCol; col++) {
    if (String(headersRow[col - 1]).indexOf('Итого') !== -1) numCols.push(col);
  }
  if (spec.metric === 'ads') {
    for (col = 3; col <= lastCol; col++) {
      var h = String(headersRow[col - 1] || '');
      if (h.indexOf('Реклама') >= 0) {
        sheet.getRange(4, col, lastRow - 3, 1).setNumberFormat('0.00%').setHorizontalAlignment('center');
      } else if (h.indexOf('Расходы') >= 0 || h.indexOf('Продажи') >= 0) {
        sheet.getRange(4, col, lastRow - 3, 1).setNumberFormat('#,##0.00').setHorizontalAlignment('center');
      }
    }
  } else if (spec.kind === 'orders') {
    reportFormatOrderNumbers_(sheet, type, dateColumns, headersRow, lastRow);
  } else if (spec.kind === 'orders_fbs') {
    // Как в 02: qty → '0', weight → '#,##0.000' на даты + хвост с строки 4
    var fbsFmt = type === 'weight' ? '#,##0.000' : '0';
    var trailNames = ['Итого', 'Остатки', 'Продано', 'В пути', 'Отменено'];
    var ti;
    for (ti = 0; ti < trailNames.length; ti++) {
      var tc = reportHeaderCol_(headersRow, trailNames[ti]);
      if (tc) numCols.push(tc);
    }
    if (lastRow >= 4) {
      for (i = 0; i < numCols.length; i++) {
        sheet.getRange(4, numCols[i], lastRow - 3, 1)
          .setNumberFormat(fbsFmt)
          .setHorizontalAlignment('center');
      }
    }
  } else if (numFmt && lastRow >= 4) {
    for (i = 0; i < numCols.length; i++) {
      sheet.getRange(4, numCols[i], lastRow - 3, 1)
        .setNumberFormat(numFmt)
        .setHorizontalAlignment('center');
    }
  }

  var rowN;
  for (rowN = dataStartRow; rowN <= lastRow; rowN++) {
    sheet.getRange(rowN, 1, 1, lastCol).setBackground(rowN % 2 === 0 ? '#f5f5f5' : '#ffffff');
  }

  for (col = 1; col <= lastCol; col++) {
    if (String(headersRow[col - 1]).indexOf('Итого') === -1) continue;
    // FBS: зелёный «Итого» с 3-й строки (не с 1-й), как isFbsDetails в 02
    var fillFrom = spec.kind === 'orders_fbs' ? 3 : 1;
    sheet.getRange(fillFrom, col, lastRow - fillFrom + 1, 1).setBackground('#0ee247');
    sheet.getRange(4, col).setFontWeight('bold');
  }

  reportFillExtraCols_(sheet, headersRow, lastRow, lastCol);

  // У FBS заголовок детализации ещё раз поверх (как applyFbsDetailsHeader_)
  if (spec.kind === 'orders_fbs' && dateColumns.length) {
    var fFirst = dateColumns[0];
    var fLast = dateColumns[dateColumns.length - 1];
    var fSpan = fLast - fFirst + 1;
    try { sheet.getRange(1, fFirst, 2, fSpan).breakApart(); } catch (eFh) {}
    sheet.getRange(1, fFirst, 1, fSpan).merge();
    sheet.getRange(1, fFirst)
      .setValue(spec.detailsTitle || 'Детализация заказов FBS по дням')
      .setFontWeight('bold')
      .setBackground('#0ee247')
      .setFontColor('#000000')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setFontFamily(STYLE_FONT_)
      .setFontSize(STYLE_SIZE_);
    sheet.getRange(2, fFirst, 2, fSpan).setBackground('#0ee247');
    if (fLast < lastCol) {
      sheet.getRange(1, fLast + 1, 2, lastCol - fLast).setBackground(null);
    }
  }

  sheet.clearConditionalFormatRules();
  var newRules = [];
  var curCol = reportHeaderCol_(headersRow, 'Текущ цена');
  var manCol = reportHeaderCol_(headersRow, 'Цена');
  if (curCol && manCol && lastRow >= dataStartRow && spec.kind !== 'orders_fbs') {
    var curLet = reportColLetter_(curCol);
    var manLet = reportColLetter_(manCol);
    newRules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=' + curLet + dataStartRow + '<' + manLet + dataStartRow)
        .setBackground('#ff0000')
        .setFontColor('#000000')
        .setRanges([sheet.getRange(dataStartRow, curCol, lastRow - dataStartRow + 1, 1)])
        .build()
    );
  }
  if (type === 'quantity' || type === 'weight') {
    for (i = 0; i < dateColumns.length; i++) {
      var c = dateColumns[i];
      var lettr = reportColLetter_(c);
      var rng = sheet.getRange(dataStartRow, c, lastRow - dataStartRow + 1, 1);
      newRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied('=' + lettr + dataStartRow + '=0')
          .setBackground('#ff9999')
          .setRanges([rng])
          .build()
      );
      if (type === 'quantity') {
        newRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied('=AND(' + lettr + dataStartRow + '>=1; ' + lettr + dataStartRow + '<=5)')
            .setBackground('#ffcc99')
            .setRanges([rng])
            .build()
        );
        newRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied('=AND(' + lettr + dataStartRow + '>=6; ' + lettr + dataStartRow + '<=10)')
            .setBackground('#ccffcc')
            .setRanges([rng])
            .build()
        );
        newRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied('=' + lettr + dataStartRow + '>=11')
            .setBackground('#99cc99')
            .setRanges([rng])
            .build()
        );
      } else {
        newRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied('=AND(' + lettr + dataStartRow + '>0; ' + lettr + dataStartRow + '<=1)')
            .setBackground('#ffcc99')
            .setRanges([rng])
            .build()
        );
        newRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied('=AND(' + lettr + dataStartRow + '>1; ' + lettr + dataStartRow + '<=6)')
            .setBackground('#ccffcc')
            .setRanges([rng])
            .build()
        );
        newRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied('=' + lettr + dataStartRow + '>6')
            .setBackground('#99cc99')
            .setRanges([rng])
            .build()
        );
      }
    }
  }
  var stDateCol = reportHeaderCol_(headersRow, 'Дата остатка');
  if (stDateCol && lastRow >= dataStartRow) {
    newRules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#e06666', SpreadsheetApp.InterpolationType.MIN, '')
        .setGradientMidpointWithValue('#ffe599', SpreadsheetApp.InterpolationType.PERCENTILE, '50')
        .setGradientMaxpointWithValue('#57bb8a', SpreadsheetApp.InterpolationType.MAX, '')
        .setRanges([sheet.getRange(dataStartRow, stDateCol, lastRow - dataStartRow + 1, 1)])
        .build()
    );
  }
  if (newRules.length) sheet.setConditionalFormatRules(newRules);

  // Цены в конце оформления: 167,88 — не целые
  if (spec.kind === 'orders' && lastRow >= 4) {
    var priceNames = ['Ср. цена', 'Текущ цена', 'Цена'];
    var pi;
    for (pi = 0; pi < priceNames.length; pi++) {
      var pCol = reportHeaderCol_(headersRow, priceNames[pi]);
      if (pCol) sheet.getRange(4, pCol, lastRow - 3, 1).setNumberFormat('#,##0.00');
    }
  }

  sheet.getRange(3, 1, 1, 2).setBackground('#f1f1f1').setFontWeight('bold');
  sheet.getRange(5, 1, lastRow - 4, lastCol).setFontSize(STYLE_SIZE_).setFontFamily(STYLE_FONT_);
  sheet.getRange(3, 1, 1, lastCol).setFontSize(STYLE_SIZE_).setFontFamily(STYLE_FONT_);
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(3, 1, lastRow - 2, lastCol).createFilter();
}

function reportLog_(ss, sheetName, status, rows, note, ms) {
  if (typeof log_ === 'function') {
    log_(ss, sheetName, status, rows, 0, 0, note || '', ms);
    return;
  }
  var sh = ss.getSheetByName('_Лог');
  if (!sh) return;
  var t = Utilities.formatDate(new Date(), TZ || 'Europe/Moscow', 'dd.MM.yyyy HH:mm:ss');
  var sec = Math.round((Number(ms) || 0) / 100) / 10;
  var last = Math.max(sh.getLastRow() + 1, 2);
  sh.getRange(last, 1).setNumberFormat('@');
  sh.getRange(last, 1, 1, 9).setValues([[t, sheetName, status, rows, 0, 0, note || '', ms, sec]]);
  sh.getRange(last, 9).setNumberFormat('0.0');
}

var POSTAVKA_NEW_SHEET_ = 'Поставка_new';
var POSTAVKA_WH_START_ = 11;
var POSTAVKA_FBS_START_ = 19;
var POSTAVKA_WH_WIDTH_ = 8;
var POSTAVKA_FBS_WIDTH_ = 7;

function reportNormArt_(art) {
  return String(art || '').toUpperCase().replace(/Х/g, 'X').trim();
}

function reportPostavkaWeightMap_(ss) {
  if (typeof clientPostavkaWeightMap_ === 'function') return clientPostavkaWeightMap_(ss) || {};
  return {};
}

function reportWritePostavkaNew_(ss) {
  var sheet = ss.getSheetByName(POSTAVKA_NEW_SHEET_);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(POSTAVKA_NEW_SHEET_);
    created = true;
    var src = ss.getSheetByName('Поставка') || ss.getSheetByName('Поставка_2');
    if (src) sheet.getRange(1, 1, 5, 2).setValues(src.getRange(1, 1, 5, 2).getValues());
    else {
      sheet.getRange(1, 2).setValue('заказы с');
      sheet.getRange(2, 2).setValue('заказы по');
      sheet.getRange(3, 2).setValue('поставки с');
      sheet.getRange(5, 2).setValue('горизонт, дней');
      sheet.getRange(5, 1).setValue(30);
    }
  }

  var abVals = sheet.getRange(1, 1, 5, 2).getValues();
  var abDisp = sheet.getRange(1, 1, 5, 1).getDisplayValues();
  var fromIso = reportParseDisplayDate_(abDisp[0][0]) || reportDateIso_(abVals[0][0]);
  var toIso = reportParseDisplayDate_(abDisp[1][0]) || reportDateIso_(abVals[1][0]);
  var supplyFrom = reportParseDisplayDate_(abDisp[2][0]) || reportDateIso_(abVals[2][0]);
  var supplyTo = reportParseDisplayDate_(abDisp[3][0]) || reportDateIso_(abVals[3][0]);
  var daysCount = parseFloat(String(abVals[4][0]).replace(',', '.')) || 30;
  if (!fromIso || !toIso || !supplyFrom || !supplyTo) {
    if (created) {
      try {
        SpreadsheetApp.getUi().alert('Создал лист «Поставка_new». Поставьте даты в A1–A4 и горизонт в A5, затем запустите снова.');
      } catch (e0) {}
    }
    throw new Error('Введите даты в A1–A4 на листе «Поставка_new»');
  }
  if (fromIso > toIso) throw new Error('A1 должна быть не позже A2');
  if (supplyFrom > supplyTo) throw new Error('A3 должна быть не позже A4');
  try {
    ss.toast('Заказы ' + fromIso + ' … ' + toIso + ' (Москва)', 'Поставка_new', 8);
  } catch (eT) {}

  var sellerId = resolveSellerId_(reportSellerSlug_(ss));
  var rows = reportFetchRpc_('report_postavka_new', sellerId, fromIso, toIso, {
    p_supply_from: supplyFrom,
    p_supply_to: supplyTo,
    p_days: daysCount
  });
  var weightMap = reportPostavkaWeightMap_(ss);

  var whMetrics = ['Остатки, шт', 'Остатки, кг', 'Заказы, шт', '🚚', 'Ср. продажи, шт', 'Запас в днях', 'К-во на поставку', '✏️'];
  var fbsMetrics = ['Остатки, шт', 'Остатки, кг', 'Заказы, шт', 'Ср. продажи, шт', 'Запас в днях', 'К-во на поставку', '✏️'];
  var metricsRow = ['Артикул продавца', 'Наименование товара'].concat(whMetrics, whMetrics, fbsMetrics);
  var usedCols = metricsRow.length;
  var whWidths = [50, 50, 45, 45, 45, 45, 45, 45];
  var fbsWidths = [50, 50, 45, 45, 45, 45, 45];

  sheet.setConditionalFormatRules([]);
  var oldLastRow = Math.max(sheet.getLastRow(), 7);
  var oldLastCol = Math.max(sheet.getLastColumn(), usedCols);
  if (oldLastCol > 2) sheet.getRange(4, 3, 3, oldLastCol - 2).clear();
  if (oldLastRow > 6) sheet.getRange(7, 1, oldLastRow - 6, oldLastCol).clear();

  sheet.getRange(6, 1, 1, usedCols).setValues([metricsRow]);
  sheet.getRange(6, 1, 1, usedCols)
    .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold')
    .setBackground('#f1f1f1').setWrap(true).setHorizontalAlignment('center');
  var c;
  for (c = 1; c <= usedCols; c++) {
    if (metricsRow[c - 1] === '🚚') sheet.getRange(6, c).setFontSize(STYLE_SIZE_);
    if (metricsRow[c - 1] === '✏️') sheet.getRange(6, c).setFontSize(STYLE_SIZE_);
  }
  sheet.setRowHeight(4, 30);
  sheet.setRowHeight(5, 30);
  sheet.setRowHeight(6, 45);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 350);
  var i;
  for (i = 0; i < whMetrics.length; i++) {
    sheet.setColumnWidth(3 + i, whWidths[i]);
    sheet.setColumnWidth(POSTAVKA_WH_START_ + i, whWidths[i]);
  }
  for (i = 0; i < fbsMetrics.length; i++) {
    sheet.setColumnWidth(POSTAVKA_FBS_START_ + i, fbsWidths[i]);
  }

  function num_(v) { return Number(v) || 0; }
  function vol_(v) {
    if (v == null || v === '') return '';
    var n = Number(v);
    if (!n || n <= 0) return '';
    return Math.round(n);
  }
  function kg_(qty, art) {
    var w = weightMap[art];
    if (w == null) w = 0;
    return qty * w;
  }

  rows.sort(function (a, b) {
    return String(a.sa_name || '').localeCompare(String(b.sa_name || ''), 'ru');
  });

  var dataRows = [];
  var totalRow = new Array(usedCols).fill(0);
  totalRow[0] = 'ИТОГО';
  totalRow[1] = '';
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    var art = reportNormArt_(r.sa_name);
    if (!art) continue;
    var name = String(r.title || '').trim();
    var wbSt = num_(r.wb_stock);
    var fbsSt = num_(r.fbs_stock);
    var wbOrd = num_(r.wb_orders);
    var fbsOrd = num_(r.fbs_orders);
    var inT = num_(r.in_transit);
    var wbAvg = num_(r.wb_avg);
    var fbsAvg = num_(r.fbs_avg);
    var sumAvg = num_(r.sum_avg);
    var wbDays = num_(r.wb_days);
    var fbsDays = num_(r.fbs_days);
    var sumDays = num_(r.sum_days);
    var sumSt = wbSt + fbsSt;
    var row = [
      art, name,
      sumSt, kg_(sumSt, art), wbOrd + fbsOrd, inT, sumAvg, sumDays, vol_(r.sum_vol), '',
      wbSt, kg_(wbSt, art), wbOrd, inT, wbAvg, wbDays, vol_(r.wb_vol), '',
      fbsSt, kg_(fbsSt, art), fbsOrd, fbsAvg, fbsDays, vol_(r.fbs_vol), ''
    ];
    dataRows.push(row);
    var col;
    for (col = 2; col < row.length; col++) {
      if (typeof row[col] === 'number' && metricsRow[col] !== 'Запас в днях') totalRow[col] += row[col];
    }
  }

  if (!dataRows.length) {
    sheet.getRange(7, 1, 1, usedCols).setValues([totalRow]);
    reportPaintPostavka_(sheet, 7);
    return 0;
  }

  sheet.getRange(7, 1, 1, usedCols).setValues([totalRow]);
  sheet.getRange(7, 1, 1, usedCols).setFontWeight('bold').setBackground('#e8e8e8');
  sheet.getRange(8, 1, dataRows.length, usedCols).setValues(dataRows);
  sheet.getRange(8, 1, dataRows.length, usedCols).setFontSize(STYLE_SIZE_).setFontFamily(STYLE_FONT_);

  var lastDataRow = 7 + dataRows.length;
  var h;
  for (h = 0; h < metricsRow.length; h++) {
    if (metricsRow[h] === 'Запас в днях') sheet.getRange(7, h + 1).setValue('');
  }

  reportFormatPostavkaMetrics_(sheet, metricsRow, 8, dataRows.length);

  var LOW = '#ff9999';
  var rules = [];
  var pairs = [['C', 'H'], ['K', 'P'], ['S', 'W']];
  var p;
  for (p = 0; p < pairs.length; p++) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=' + pairs[p][0] + '8<=10')
      .setBackground(LOW)
      .setRanges([sheet.getRange(pairs[p][0] + '8:' + pairs[p][0] + lastDataRow)])
      .build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=' + pairs[p][1] + '8<=30')
      .setBackground(LOW)
      .setRanges([sheet.getRange(pairs[p][1] + '8:' + pairs[p][1] + lastDataRow)])
      .build());
  }
  sheet.setConditionalFormatRules(rules);

  var pencil = [];
  var rowN;
  for (rowN = 8; rowN <= lastDataRow; rowN++) pencil.push(['=R' + rowN + '+Y' + rowN]);
  sheet.getRange(8, 10, dataRows.length, 1).setFormulas(pencil);

  sheet.getRange(7, 8).setFormula('=IF(G7=0;"";(C7+F7)/G7)').setNumberFormat('#,##0.00');
  sheet.getRange(7, 9).setFormula('=SUM(I8:I' + lastDataRow + ')').setNumberFormat('0');
  sheet.getRange(7, 10).setFormula('=SUM(J8:J' + lastDataRow + ')').setNumberFormat('0');
  sheet.getRange(7, 16).setFormula('=IF(O7=0;"";(K7+N7)/O7)').setNumberFormat('#,##0.00');
  sheet.getRange(7, 17).setFormula('=SUM(Q8:Q' + lastDataRow + ')').setNumberFormat('0');
  sheet.getRange(7, 18).setFormula('=SUM(R8:R' + lastDataRow + ')').setNumberFormat('0');
  sheet.getRange(7, 23).setFormula('=IF(V7=0;"";S7/V7)').setNumberFormat('#,##0.00');
  sheet.getRange(7, 24).setFormula('=SUM(X8:X' + lastDataRow + ')').setNumberFormat('0');
  sheet.getRange(7, 25).setFormula('=SUM(Y8:Y' + lastDataRow + ')').setNumberFormat('0');

  if (sheet.getFilter()) sheet.getFilter().remove();
  try { sheet.getRange(6, 1, lastDataRow - 5, usedCols).createFilter(); } catch (eF) {}

  reportPaintPostavka_(sheet, lastDataRow);
  reportPostavkaDropdown_(sheet);
  try { sheet.getRange(1, 1, 4, 1).setNumberFormat('dd.mm.yyyy'); } catch (eD) {}
  return dataRows.length;
}

function reportFormatPostavkaMetrics_(sheet, metricsRow, startRow, nRows) {
  var kg = [];
  var avg = [];
  var ints = [];
  var bold = [];
  var col;
  for (col = 3; col <= metricsRow.length; col++) {
    var h = String(metricsRow[col - 1] || '');
    if (h.indexOf('кг') >= 0) kg.push(col);
    else if (h.indexOf('Ср. продажи') >= 0) avg.push(col);
    else if (h.indexOf('К-во на поставку') >= 0) bold.push(col);
    else ints.push(col);
  }
  function apply_(cols, fmt, rows, weight) {
    if (!cols.length || rows < 1) return;
    var i;
    for (i = 0; i < cols.length; i++) {
      var rng = sheet.getRange(startRow, cols[i], rows, 1);
      rng.setNumberFormat(fmt);
      if (weight) rng.setFontWeight(weight);
    }
  }
  apply_(kg, '#,##0.000', nRows, '');
  apply_(avg, '#,##0.00', nRows, '');
  apply_(ints, '#,##0', nRows, '');
  apply_(bold, '#,##0', nRows, 'bold');
  var j;
  for (j = 0; j < kg.length; j++) sheet.getRange(7, kg[j]).setNumberFormat('#,##0.000');
  for (j = 0; j < avg.length; j++) sheet.getRange(7, avg[j]).setNumberFormat('#,##0.00');
  var totInt = ints.concat(bold);
  for (j = 0; j < totInt.length; j++) sheet.getRange(7, totInt[j]).setNumberFormat('#,##0');
}

function reportPaintPostavka_(sheet, lastRow) {
  reportPaintPostavkaBlock_(sheet, 3, POSTAVKA_WH_WIDTH_, 'Итого', 'Склад WB + Склад продавца', '#cee2e3', lastRow);
  reportPaintPostavkaBlock_(sheet, POSTAVKA_WH_START_, POSTAVKA_WH_WIDTH_, 'Склад WB', 'Итого по всем складам', '#76d7c4', lastRow);
  reportPaintPostavkaBlock_(sheet, POSTAVKA_FBS_START_, POSTAVKA_FBS_WIDTH_, 'Склад продавца', 'FBS', '#fce5cd', lastRow);
  if (lastRow >= 7) {
    sheet.getRange(7, 1, 1, sheet.getLastColumn()).setBackground('#e8e8e8').setFontWeight('bold');
  }
  var headers = sheet.getRange(6, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col;
  for (col = 1; col <= headers.length; col++) {
    var h = String(headers[col - 1] || '').trim();
    if (h === '🚚') sheet.getRange(6, col).setFontSize(STYLE_SIZE_);
    if (h === '✏️') {
      sheet.getRange(6, col).setFontSize(STYLE_SIZE_);
      if (lastRow >= 7) sheet.getRange(7, col, lastRow - 6, 1).setFontWeight('bold');
    }
  }
}

function reportPaintPostavkaBlock_(sheet, startCol, width, title4, title5, color, lastRow) {
  sheet.getRange(4, startCol, 1, width)
    .merge()
    .setValue(title4)
    .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBackground(color);
  sheet.getRange(5, startCol, 1, width)
    .merge()
    .setValue(title5)
    .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBackground(color);
  if (startCol === 3) {
    sheet.getRange(6, startCol, 1, width).setBackground(color);
    if (lastRow >= 8) sheet.getRange(8, startCol, lastRow - 7, width).setBackground(color);
  } else if (lastRow >= 6) {
    sheet.getRange(6, startCol, lastRow - 5, width)
      .setBackground(color)
      .setBorder(true, true, true, true, false, false);
  }
}

function reportPostavkaDropdown_(sheet) {
  var kept = String(sheet.getRange('B4').getValue() || '').trim();
  var list = ['Выберите блок', 'Склад WB', 'Склад продавца'];
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true)
    .setAllowInvalid(false)
    .build();
  var b4 = sheet.getRange('B4');
  b4.setDataValidation(rule);
  b4.setValue(list.indexOf(kept) >= 0 && kept !== 'Выберите блок' ? kept : 'Выберите блок');
  if (sheet.getColumnWidth(2) < 150) sheet.setColumnWidth(2, 180);
}

var POSTAVKA2_SHEET_ = 'Поставка_2';
var POSTAVKA2_REGION_START_ = 12;
var POSTAVKA2_BLOCK_ = 8;

function runReportPostavka2() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  reportEnsureMoscowTz_(ss);
  var wall0 = Date.now();
  reportCancelPostavka2Style_();
  try {
    var written = reportWritePostavka2_(ss);
    var remain = 330000 - (Date.now() - wall0);
    if (remain < 45000) {
      reportSchedulePostavka2Style_();
      reportLog_(ss, POSTAVKA2_SHEET_, 'данные', written.n, 'оформление запланировано отдельно', Date.now() - wall0);
      try {
        SpreadsheetApp.getUi().alert('Поставка_2: данные записаны за ' +
          ((Date.now() - wall0) / 1000).toFixed(1) +
          ' с. Оформление продолжится автоматически через ~15 с.');
      } catch (e0) {}
      return;
    }
    reportFinishPostavka2Style_(ss, written);
    var ms = Date.now() - wall0;
    reportLog_(ss, POSTAVKA2_SHEET_, 'готово', written.n, '', ms);
    try {
      SpreadsheetApp.getUi().alert('Поставка_2: готово, ' + written.n + ' строк за ' + (ms / 1000).toFixed(1) + ' с.');
    } catch (e1) {}
  } catch (err) {
    reportLog_(ss, POSTAVKA2_SHEET_, 'ошибка', 0, String(err), Date.now() - wall0);
    try { SpreadsheetApp.getUi().alert('«Поставка_2»: ' + err); } catch (e2) {}
  }
}

function reportCancelPostavka2Style_() {
  var handler = 'continueReportPostavka2Style_';
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handler) ScriptApp.deleteTrigger(triggers[i]);
  }
}

function reportSchedulePostavka2Style_() {
  reportCancelPostavka2Style_();
  ScriptApp.newTrigger('continueReportPostavka2Style_').timeBased().after(15 * 1000).create();
}

function reportPostavka2Reference_(ss, rows) {
  var regionByWarehouse = {};
  var approved = [];
  if (typeof clientPostavkaRegionRef_ === 'function') {
    var client = clientPostavkaRegionRef_(ss, true) || {};
    regionByWarehouse = client.regionByWarehouse || {};
    approved = client.approved || [];
  }

  var pairs = {};
  function addPair_(warehouse, forcedRegion) {
    var wh = String(warehouse || '').trim() || 'Не указан';
    var reg = forcedRegion || regionByWarehouse[wh.toLowerCase()] || 'Не указан';
    pairs[reg + '\u0001' + wh] = { region: reg, warehouse: wh };
  }
  for (var a = 0; a < approved.length; a++) addPair_(approved[a].warehouse, approved[a].region);
  for (var r = 0; r < rows.length; r++) addPair_(rows[r].warehouse_name, rows[r].region || '');

  var regionOrder = ['Склад WB', 'Центральный', 'Северо-Западный', 'Приволжский', 'Южный и Северо-Кавказский', 'Уральский', 'Дальневосточный и Сибирский', 'Беларусь', 'Казахстан', 'Узбекистан', 'Армения', 'Грузия', 'Ереван', 'Не определён', 'Не указан'];
  var regionMap = {};
  Object.keys(pairs).forEach(function (key) {
    var p = pairs[key];
    if (!regionMap[p.region]) regionMap[p.region] = [];
    if (regionMap[p.region].indexOf(p.warehouse) < 0) regionMap[p.region].push(p.warehouse);
  });
  var regions = Object.keys(regionMap).sort(function (x, y) {
    var ix = regionOrder.indexOf(x), iy = regionOrder.indexOf(y);
    if (ix >= 0 || iy >= 0) return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy);
    return x.localeCompare(y, 'ru');
  });
  for (var j = 0; j < regions.length; j++) regionMap[regions[j]].sort(function (x, y) { return x.localeCompare(y, 'ru'); });
  return { regionByWarehouse: regionByWarehouse, regions: regions, regionMap: regionMap };
}

function reportPostavka2Manual_(sheet) {
  var saved = {};
  if (!sheet || sheet.getLastRow() < 8 || sheet.getLastColumn() < POSTAVKA2_REGION_START_) return saved;
  var lastCol = sheet.getLastColumn();
  var sub = sheet.getRange(5, 1, 1, lastCol).getDisplayValues()[0];
  var metrics = sheet.getRange(6, 1, 1, lastCol).getDisplayValues()[0];
  var oldRows = sheet.getLastRow() - 7;
  var values = sheet.getRange(8, 1, oldRows, lastCol).getValues();
  for (var col = POSTAVKA2_REGION_START_; col <= lastCol; col++) {
    if (String(metrics[col - 1] || '').trim() !== '✏️') continue;
    var wh = '';
    for (var back = col; back >= POSTAVKA2_REGION_START_ && back > col - POSTAVKA2_BLOCK_; back--) {
      var candidate = String(sub[back - 1] || '').trim();
      if (candidate) { wh = candidate; break; }
    }
    if (!wh || wh === 'ИТОГО по региону') continue;
    for (var i = 0; i < values.length; i++) {
      var art = reportNormArt_(values[i][0]);
      if (art && values[i][col - 1] !== '') saved[art + '\u0001' + wh] = values[i][col - 1];
    }
  }
  return saved;
}

function reportWritePostavka2_(ss) {
  var sheet = ss.getSheetByName(POSTAVKA2_SHEET_);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(POSTAVKA2_SHEET_);
    created = true;
    var src = ss.getSheetByName('Поставка_new');
    if (src) sheet.getRange(1, 1, 5, 2).setValues(src.getRange(1, 1, 5, 2).getValues());
    else {
      sheet.getRange(1, 2, 5, 1).setValues([['заказы с'], ['заказы по'], ['поставки с'], ['поставки по'], ['горизонт, дней']]);
      sheet.getRange(5, 1).setValue(30);
    }
  }

  var abVals = sheet.getRange(1, 1, 5, 2).getValues();
  var abDisp = sheet.getRange(1, 1, 5, 1).getDisplayValues();
  var fromIso = reportParseDisplayDate_(abDisp[0][0]) || reportDateIso_(abVals[0][0]);
  var toIso = reportParseDisplayDate_(abDisp[1][0]) || reportDateIso_(abVals[1][0]);
  var supplyFrom = reportParseDisplayDate_(abDisp[2][0]) || reportDateIso_(abVals[2][0]);
  var supplyTo = reportParseDisplayDate_(abDisp[3][0]) || reportDateIso_(abVals[3][0]);
  var daysCount = parseFloat(String(abVals[4][0]).replace(',', '.')) || 30;
  if (!fromIso || !toIso || !supplyFrom || !supplyTo) {
    if (created) {
      try { SpreadsheetApp.getUi().alert('Создал лист «Поставка_2». Укажите даты A1–A4 и горизонт A5.'); } catch (e0) {}
    }
    throw new Error('Введите даты в A1–A4 на листе «Поставка_2»');
  }
  if (fromIso > toIso) throw new Error('A1 должна быть не позже A2');
  if (supplyFrom > supplyTo) throw new Error('A3 должна быть не позже A4');

  var sellerId = resolveSellerId_(reportSellerSlug_(ss));
  var rows = reportFetchRpc_('report_postavka_2', sellerId, fromIso, toIso, {
    p_supply_from: supplyFrom,
    p_supply_to: supplyTo
  });
  var ref = reportPostavka2Reference_(ss, rows);
  var weightMap = reportPostavkaWeightMap_(ss);
  var manual = reportPostavka2Manual_(sheet);
  reportUngroupColumns_(sheet);
  var dateDiff = Math.round((new Date(toIso + 'T12:00:00Z') - new Date(fromIso + 'T12:00:00Z')) / 86400000) + 1;

  var baseMetrics = ['Заказы,\nшт', 'В пути,\nшт', 'В пути,\nкг', 'На складе ВБ,\nшт', 'Итого ВБ,\nшт', 'Ср. продажи,\nшт', 'Запас в днях', 'К-во на поставку', '✏️'];
  var whMetrics = ['Остатки, шт', 'Остатки, кг', 'Заказы, шт', '🚚', 'Ср. продажи, шт', 'Запас в днях', 'К-во на поставку', '✏️'];
  var metricsRow = ['Артикул продавца', 'Наименование товара'].concat(baseMetrics);
  var regionRow = new Array(11).fill('');
  var subRow = new Array(11).fill('');
  var ri, wi, mi;
  for (ri = 0; ri < ref.regions.length; ri++) {
    var reg = ref.regions[ri];
    var whs = ref.regionMap[reg];
    regionRow.push(reg);
    subRow.push('ИТОГО по региону');
    for (mi = 1; mi < POSTAVKA2_BLOCK_; mi++) { regionRow.push(''); subRow.push(''); }
    for (wi = 0; wi < whs.length; wi++) {
      regionRow.push('');
      subRow.push(whs[wi]);
      for (mi = 1; mi < POSTAVKA2_BLOCK_; mi++) { regionRow.push(''); subRow.push(''); }
    }
    metricsRow = metricsRow.concat(whMetrics);
    for (wi = 0; wi < whs.length; wi++) metricsRow = metricsRow.concat(whMetrics);
  }
  var usedCols = metricsRow.length;
  if (sheet.getMaxColumns() < usedCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), usedCols - sheet.getMaxColumns());

  var byArt = {}, byKey = {}, titles = {};
  function n_(v) { return Number(v) || 0; }
  for (var x = 0; x < rows.length; x++) {
    var rr = rows[x];
    var art = reportNormArt_(rr.sa_name);
    if (!art) continue;
    var wh = String(rr.warehouse_name || '').trim() || 'Не указан';
    var region = String(rr.region || '').trim() || ref.regionByWarehouse[wh.toLowerCase()] || 'Не указан';
    var key = art + '\u0001' + region + '\u0001' + wh;
    var fact = { orders: n_(rr.orders_qty), stock: n_(rr.stock_qty), transit: n_(rr.in_transit_qty) };
    byKey[key] = fact;
    if (!byArt[art]) byArt[art] = { orders: 0, stock: 0, transit: 0 };
    byArt[art].orders += fact.orders;
    byArt[art].stock += fact.stock;
    byArt[art].transit += fact.transit;
    if (!titles[art] && rr.title) titles[art] = String(rr.title);
  }

  var arts = Object.keys(byArt).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
  if (arts.length > 200) {
    arts = arts.slice(0, 200);
    try { SpreadsheetApp.getUi().alert('Найдено больше 200 товаров. Выведены первые 200, как в исходном отчёте.'); } catch (eCap) {}
  }
  var dataRows = [];
  for (var ai = 0; ai < arts.length; ai++) {
    var artN = arts[ai], total = byArt[artN], weight = weightMap[artN] || 0;
    var avg = dateDiff > 0 ? Math.round(total.orders / dateDiff * 100) / 100 : 0;
    var days = avg > 0 ? Math.round((total.stock + total.transit) / avg * 100) / 100 : 0;
    var vol = Math.round(avg * daysCount - total.stock - total.transit);
    var out = [artN, titles[artN] || '', total.orders, total.transit, total.transit * weight, total.stock,
      total.stock + total.transit, avg, days, vol > 0 ? vol : '', ''];
    for (ri = 0; ri < ref.regions.length; ri++) {
      reg = ref.regions[ri];
      whs = ref.regionMap[reg];
      var whBlocks = [], rs = 0, ro = 0, rt = 0;
      for (wi = 0; wi < whs.length; wi++) {
        wh = whs[wi];
        fact = byKey[artN + '\u0001' + reg + '\u0001' + wh] || { orders: 0, stock: 0, transit: 0 };
        var wa = dateDiff > 0 ? Math.round(fact.orders / dateDiff * 100) / 100 : 0;
        var wd = wa > 0 ? (fact.stock + fact.transit) / wa : 0;
        var wv = Math.round(wa * daysCount - fact.stock - fact.transit);
        whBlocks.push([fact.stock, fact.stock * weight, fact.orders, fact.transit, wa, wd, wv > 0 ? wv : '',
          manual[artN + '\u0001' + wh] == null ? '' : manual[artN + '\u0001' + wh]]);
        rs += fact.stock; ro += fact.orders; rt += fact.transit;
      }
      var ra = dateDiff > 0 ? Math.round(ro / dateDiff * 100) / 100 : 0;
      var rd = ra > 0 ? (rs + rt) / ra : 0;
      var rv = Math.round(ra * daysCount - rs - rt);
      out = out.concat([rs, rs * weight, ro, rt, ra, rd, rv > 0 ? rv : '', '']);
      for (wi = 0; wi < whBlocks.length; wi++) out = out.concat(whBlocks[wi]);
    }
    dataRows.push(out);
  }

  var oldLastRow = Math.max(sheet.getLastRow(), 7);
  var oldLastCol = Math.max(sheet.getLastColumn(), usedCols);
  sheet.setConditionalFormatRules([]);
  if (oldLastCol > 2) {
    try { sheet.getRange(4, 3, 2, oldLastCol - 2).breakApart(); } catch (eBreak) {}
    sheet.getRange(4, 3, Math.max(3, oldLastRow - 3), oldLastCol - 2).clear();
  }
  if (oldLastRow > 6) sheet.getRange(7, 1, oldLastRow - 6, oldLastCol).clear();
  if (usedCols >= POSTAVKA2_REGION_START_) {
    sheet.getRange(4, POSTAVKA2_REGION_START_, 1, usedCols - POSTAVKA2_REGION_START_ + 1)
      .setValues([regionRow.slice(POSTAVKA2_REGION_START_ - 1)]);
    sheet.getRange(5, POSTAVKA2_REGION_START_, 1, usedCols - POSTAVKA2_REGION_START_ + 1)
      .setValues([subRow.slice(POSTAVKA2_REGION_START_ - 1)]);
  }
  sheet.getRange(6, 1, 1, usedCols).setValues([metricsRow]);
  if (sheet.getFilter()) sheet.getFilter().remove();

  sheet.getRange(4, 3).setValue('Все склады WB');
  sheet.getRange(5, 3).setValue('Итого по всем регионам');
  var mergeBlocks = [
    { row: 4, col: 3, numRows: 1, numCols: 9 },
    { row: 5, col: 3, numRows: 1, numCols: 9 }
  ];
  var cursor = POSTAVKA2_REGION_START_;
  for (ri = 0; ri < ref.regions.length; ri++) {
    whs = ref.regionMap[ref.regions[ri]];
    var regionWidth = POSTAVKA2_BLOCK_ * (1 + whs.length);
    mergeBlocks.push({ row: 4, col: cursor, numRows: 1, numCols: regionWidth });
    mergeBlocks.push({ row: 5, col: cursor, numRows: 1, numCols: POSTAVKA2_BLOCK_ });
    var wc = cursor + POSTAVKA2_BLOCK_;
    for (wi = 0; wi < whs.length; wi++) {
      mergeBlocks.push({ row: 5, col: wc, numRows: 1, numCols: POSTAVKA2_BLOCK_ });
      wc += POSTAVKA2_BLOCK_;
    }
    cursor += regionWidth;
  }
  reportMergeBlocks_(sheet, mergeBlocks);

  var totalRow = new Array(usedCols).fill(0);
  totalRow[0] = 'ИТОГО';
  for (ai = 0; ai < dataRows.length; ai++) {
    for (var cc = 2; cc < usedCols; cc++) {
      if (typeof dataRows[ai][cc] === 'number' && String(metricsRow[cc]).indexOf('Запас в днях') < 0) totalRow[cc] += dataRows[ai][cc];
    }
  }
  var lastDataRow = 7 + dataRows.length;
  if (dataRows.length) {
    totalRow[8] = '=IF(H7=0;"";(F7+D7)/H7)';
    totalRow[9] = '=SUM(J8:J' + lastDataRow + ')';
    totalRow[10] = '=SUM(K8:K' + lastDataRow + ')';
    cursor = POSTAVKA2_REGION_START_;
    for (ri = 0; ri < ref.regions.length; ri++) {
      var totalBlocks = 1 + ref.regionMap[ref.regions[ri]].length;
      for (var totalBlock = 0; totalBlock < totalBlocks; totalBlock++) {
        var totalStart = cursor + totalBlock * POSTAVKA2_BLOCK_;
        var totalAvg = reportColLetter_(totalStart + 4);
        totalRow[totalStart + 4] = '=IF(' + totalAvg + '7=0;"";(' + reportColLetter_(totalStart) + '7+' + reportColLetter_(totalStart + 3) + '7)/' + totalAvg + '7)';
        totalRow[totalStart + 5] = '=SUM(' + reportColLetter_(totalStart + 6) + '8:' + reportColLetter_(totalStart + 6) + lastDataRow + ')';
        totalRow[totalStart + 6] = '=SUM(' + reportColLetter_(totalStart + 7) + '8:' + reportColLetter_(totalStart + 7) + lastDataRow + ')';
      }
      cursor += totalBlocks * POSTAVKA2_BLOCK_;
    }
  }
  sheet.getRange(7, 1, 1, usedCols).setValues([totalRow]);
  if (dataRows.length) sheet.getRange(8, 1, dataRows.length, usedCols).setValues(dataRows);

  var regionPencils = [];
  cursor = POSTAVKA2_REGION_START_;
  for (ri = 0; ri < ref.regions.length; ri++) {
    whs = ref.regionMap[ref.regions[ri]];
    var regionPencil = cursor + 7;
    regionPencils.push(regionPencil);
    var whPencils = [];
    for (wi = 0; wi < whs.length; wi++) whPencils.push(cursor + POSTAVKA2_BLOCK_ * (wi + 1) + 7);
    if (dataRows.length && whPencils.length) {
      var regionFormulas = [];
      for (var rn = 8; rn <= lastDataRow; rn++) {
        regionFormulas.push(['=' + whPencils.map(function (c) { return reportColLetter_(c) + rn; }).join('+')]);
      }
      sheet.getRange(8, regionPencil, dataRows.length, 1).setFormulas(regionFormulas);
    }
    cursor += POSTAVKA2_BLOCK_ * (1 + whs.length);
  }
  if (dataRows.length && regionPencils.length) {
    var baseFormulas = [];
    for (rn = 8; rn <= lastDataRow; rn++) {
      baseFormulas.push(['=' + regionPencils.map(function (c) { return reportColLetter_(c) + rn; }).join('+')]);
    }
    sheet.getRange(8, 11, dataRows.length, 1).setFormulas(baseFormulas);
  }

  return {
    n: dataRows.length,
    sheet: sheet,
    metricsRow: metricsRow,
    ref: ref,
    lastRow: 7 + dataRows.length,
    usedCols: usedCols
  };
}

function reportPostavka2RefFromSheet_(sheet, usedCols) {
  var regionRow = sheet.getRange(4, 1, 1, usedCols).getDisplayValues()[0];
  var subRow = sheet.getRange(5, 1, 1, usedCols).getDisplayValues()[0];
  var starts = [];
  for (var col = POSTAVKA2_REGION_START_; col <= usedCols; col++) {
    var name = String(regionRow[col - 1] || '').trim();
    if (name) starts.push({ name: name, col: col });
  }
  var regions = [];
  var regionMap = {};
  for (var i = 0; i < starts.length; i++) {
    var region = starts[i].name;
    var end = i + 1 < starts.length ? starts[i + 1].col - 1 : usedCols;
    regions.push(region);
    regionMap[region] = [];
    for (col = starts[i].col + POSTAVKA2_BLOCK_; col <= end; col += POSTAVKA2_BLOCK_) {
      var wh = String(subRow[col - 1] || '').trim();
      if (wh && wh !== 'ИТОГО по региону') regionMap[region].push(wh);
    }
  }
  return { regions: regions, regionMap: regionMap };
}

function continueReportPostavka2Style_() {
  var wall0 = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  reportCancelPostavka2Style_();
  try {
    var lastRow = reportFinishPostavka2Style_(ss, null);
    reportLog_(ss, POSTAVKA2_SHEET_, 'готово', Math.max(0, lastRow - 7), '', Date.now() - wall0);
    try { ss.toast('Оформление завершено', POSTAVKA2_SHEET_, 8); } catch (eToast) {}
  } catch (err) {
    reportLog_(ss, POSTAVKA2_SHEET_, 'ошибка оформления', 0, String(err), Date.now() - wall0);
    throw err;
  }
}

function reportFinishPostavka2Style_(ss, written) {
  var sheet;
  var metricsRow;
  var ref;
  var lastRow;
  var usedCols;
  if (written && written.sheet) {
    sheet = written.sheet;
    metricsRow = written.metricsRow;
    ref = written.ref;
    lastRow = written.lastRow;
    usedCols = written.usedCols || metricsRow.length;
  } else {
    sheet = ss.getSheetByName(POSTAVKA2_SHEET_);
    if (!sheet || sheet.getLastRow() < 7) throw new Error('лист с данными не найден');
    var headers = sheet.getRange(6, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    usedCols = headers.length;
    while (usedCols > 2 && !String(headers[usedCols - 1] || '').trim()) usedCols--;
    metricsRow = headers.slice(0, usedCols);
    ref = reportPostavka2RefFromSheet_(sheet, usedCols);
    lastRow = sheet.getLastRow();
  }

  reportPostavka2Style_(sheet, metricsRow, ref, lastRow);
  reportPostavka2Dropdowns_(sheet, ref);
  if (sheet.getFilter()) sheet.getFilter().remove();
  if (lastRow >= 8) {
    try { sheet.getRange(6, 1, lastRow - 5, usedCols).createFilter(); } catch (eFilter) {}
  }
  try { sheet.getRange(1, 1, 4, 1).setNumberFormat('dd.mm.yyyy'); } catch (eDate) {}
  return lastRow;
}

function reportPostavka2Style_(sheet, metricsRow, ref, lastRow) {
  var usedCols = metricsRow.length;
  var colors = { 'Склад WB': '#76d7c4', 'Центральный': '#b7b7b7', 'Северо-Западный': '#b4a7d6', 'Приволжский': '#ffff00', 'Южный и Северо-Кавказский': '#f2cfcd', 'Уральский': '#6aa84f', 'Дальневосточный и Сибирский': '#3881c9', 'Беларусь': '#b6d7a8', 'Казахстан': '#f9cb9c', 'Узбекистан': '#8e7cc3', 'Армения': '#ea9999', 'Грузия': '#9fc5e8', 'Ереван': '#ffe599', 'Не определён': '#cccccc', 'Не указан': '#cccccc' };
  sheet.setFrozenRows(6);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 350);
  if (usedCols > 2) sheet.setColumnWidths(3, usedCols - 2, 45);
  sheet.setColumnWidths(3, 2, 50);
  sheet.setRowHeight(4, 30); sheet.setRowHeight(5, 30); sheet.setRowHeight(6, 45);
  sheet.getRange(4, 3, 3, usedCols - 2).setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold').setWrap(true).setHorizontalAlignment('center');
  sheet.getRange(4, 3, Math.max(3, lastRow - 3), 9).setBackground('#cee2e3');
  var cursor = POSTAVKA2_REGION_START_;
  var ri;
  for (ri = 0; ri < ref.regions.length; ri++) {
    var width = POSTAVKA2_BLOCK_ * (1 + ref.regionMap[ref.regions[ri]].length);
    sheet.getRange(4, cursor, Math.max(3, lastRow - 3), width)
      .setBackground(colors[ref.regions[ri]] || '#f1f1f1')
      .setBorder(true, true, true, true, false, false);
    cursor += width;
  }
  sheet.getRange(7, 1, 1, usedCols).setBackground('#e8e8e8').setFontWeight('bold');
  if (lastRow >= 8) sheet.getRange(8, 1, lastRow - 7, usedCols).setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_);
  reportPostavka2FormatMetrics_(sheet, metricsRow, lastRow);
  var totalDays = ['I7'];
  var c;
  for (c = POSTAVKA2_REGION_START_; c <= usedCols; c += POSTAVKA2_BLOCK_) {
    totalDays.push(reportColLetter_(c + 5) + '7');
  }
  reportRangeListDo_(sheet, totalDays, function (rl) { rl.setNumberFormat('#,##0.00'); });

  if (lastRow >= 8) {
    var dataRange = sheet.getRange(8, 1, lastRow - 7, usedCols);
    var cell = 'INDIRECT(ADDRESS(ROW();COLUMN()))';
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=OR(AND(COLUMN()=6;' + cell + '<=10);AND(COLUMN()>=12;MOD(COLUMN()-12;8)=0;' + cell + '<=10))')
        .setBackground('#ff9999')
        .setRanges([dataRange])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=OR(AND(COLUMN()=9;' + cell + '<=30);AND(COLUMN()>=12;MOD(COLUMN()-12;8)=5;' + cell + '<=30))')
        .setBackground('#ff9999')
        .setRanges([dataRange])
        .build()
    ]);
  }
}

function reportPostavka2FormatMetrics_(sheet, metricsRow, lastRow) {
  var kg = [], avg = [], bold = [], trucks = [], pencils = [];
  var dataEnd = Math.max(7, lastRow);
  var usedCols = metricsRow.length;
  if (lastRow >= 7 && usedCols >= 3) {
    sheet.getRange(7, 3, dataEnd - 6, usedCols - 2).setNumberFormat('#,##0');
  }
  for (var col = 3; col <= usedCols; col++) {
    var h = String(metricsRow[col - 1] || '').trim();
    var letter = reportColLetter_(col);
    var range = letter + '7:' + letter + dataEnd;
    if (h.indexOf('кг') >= 0) kg.push(range);
    else if (h.indexOf('Ср. продажи') >= 0) avg.push(range);
    else if (h.indexOf('К-во на поставку') >= 0) bold.push(range);
    if (h === '🚚') trucks.push(letter + '6');
    if (h === '✏️') {
      pencils.push(letter + '6');
      bold.push(range);
    }
  }
  reportRangeListDo_(sheet, kg, function (rl) { rl.setNumberFormat('#,##0.000'); });
  reportRangeListDo_(sheet, avg, function (rl) { rl.setNumberFormat('#,##0.00'); });
  reportRangeListDo_(sheet, bold, function (rl) { rl.setNumberFormat('#,##0').setFontWeight('bold'); });
  reportRangeListDo_(sheet, trucks, function (rl) { rl.setFontSize(STYLE_SIZE_); });
  reportRangeListDo_(sheet, pencils, function (rl) { rl.setFontSize(STYLE_SIZE_); });
}

function reportPostavka2Dropdowns_(sheet, ref) {
  var keptRegion = String(sheet.getRange('B4').getValue() || '');
  var regions = ['Выберите регион'].concat(ref.regions);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(regions, true).setAllowInvalid(false).build();
  sheet.getRange('B4').setDataValidation(rule).setValue(ref.regions.indexOf(keptRegion) >= 0 ? keptRegion : 'Выберите регион');
  reportPostavka2HandleRegion_(sheet, sheet.getRange('B4').getValue());
}

function reportPostavka2HandleRegion_(sheet, region) {
  var b5 = sheet.getRange('B5');
  var warehouses = [];
  if (region && region !== 'Выберите регион' && sheet.getLastColumn() >= POSTAVKA2_REGION_START_) {
    var regionRow = sheet.getRange(4, POSTAVKA2_REGION_START_, 1, sheet.getLastColumn() - POSTAVKA2_REGION_START_ + 1).getDisplayValues()[0];
    var subRow = sheet.getRange(5, POSTAVKA2_REGION_START_, 1, sheet.getLastColumn() - POSTAVKA2_REGION_START_ + 1).getDisplayValues()[0];
    var current = '';
    for (var i = 0; i < regionRow.length; i++) {
      if (regionRow[i]) current = String(regionRow[i]).trim();
      if (current === region && subRow[i] && subRow[i] !== 'ИТОГО по региону') warehouses.push(String(subRow[i]).trim());
    }
  }
  var list = warehouses.length ? warehouses : ['Выберите склад'];
  var kept = String(b5.getValue() || '');
  b5.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build())
    .setValue(list.indexOf(kept) >= 0 ? kept : list[0]);
}

function handlePostavka2Edit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== POSTAVKA2_SHEET_) return;
  if (e.range.getA1Notation() !== 'B4') return;
  reportPostavka2HandleRegion_(e.range.getSheet(), e.value || '');
}

function reportUngroupColumns_(sheet) {
  if (!sheet) return;
  try { sheet.expandAllColumnGroups(); } catch (e0) {}
  var ssId = sheet.getParent().getId();
  var sheetId = sheet.getSheetId();
  var token = ScriptApp.getOAuthToken();
  try {
    var meta = UrlFetchApp.fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) +
        '?fields=sheets(properties(sheetId),columnGroups)',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    if (meta.getResponseCode() < 200 || meta.getResponseCode() >= 300) throw new Error(String(meta.getResponseCode()));
    var sheets = JSON.parse(meta.getContentText() || '{}').sheets || [];
    var groups = [];
    var s;
    for (s = 0; s < sheets.length; s++) {
      if (sheets[s].properties && sheets[s].properties.sheetId === sheetId) {
        groups = sheets[s].columnGroups || [];
        break;
      }
    }
    if (!groups.length) return;
    groups.sort(function (a, b) { return (b.depth || 0) - (a.depth || 0); });
    var requests = [];
    var g;
    for (g = 0; g < groups.length; g++) {
      if (groups[g] && groups[g].range) requests.push({ deleteDimensionGroup: { range: groups[g].range } });
    }
    if (!requests.length) return;
    var res = UrlFetchApp.fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(ssId) + ':batchUpdate',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ requests: requests }),
        muteHttpExceptions: true
      }
    );
    if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) return;
  } catch (eApi) {}
  try {
    var lastCol = Math.max(sheet.getLastColumn(), POSTAVKA2_REGION_START_);
    sheet.getRange(1, POSTAVKA2_REGION_START_, 1, lastCol - POSTAVKA2_REGION_START_ + 1)
      .shiftColumnGroupDepth(-8);
  } catch (eShift) {}
}

function createPostavka2Groups() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(POSTAVKA2_SHEET_);
  if (!sheet || sheet.getLastColumn() < POSTAVKA2_REGION_START_) return;
  reportUngroupColumns_(sheet);
  var lastCol = sheet.getLastColumn();
  var regionRow = sheet.getRange(4, 1, 1, lastCol).getDisplayValues()[0];
  var starts = [];
  for (var col = POSTAVKA2_REGION_START_; col <= lastCol; col++) {
    if (String(regionRow[col - 1] || '').trim()) starts.push(col);
  }
  for (var i = 0; i < starts.length; i++) {
    var start = starts[i];
    var end = i + 1 < starts.length ? starts[i + 1] - 1 : lastCol;
    var firstWh = start + POSTAVKA2_BLOCK_;
    if (firstWh <= end) {
      sheet.getRange(1, firstWh, 1, end - firstWh + 1).shiftColumnGroupDepth(1);
      for (var whStart = firstWh; whStart <= end; whStart += POSTAVKA2_BLOCK_) {
        var width = Math.min(POSTAVKA2_BLOCK_, end - whStart + 1);
        if (width > 0) sheet.getRange(1, whStart, 1, width).shiftColumnGroupDepth(1);
      }
    }
  }
  try { sheet.collapseAllColumnGroups(); } catch (e2) {}
}

/** Замер RPC отчёта постранично (без записи на лист). */
function benchReportRpcOnly_(fnName, sellerId, fromIso, toIso, extra) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var lines = [];
  var totalRows = 0;
  var totalMs = 0;
  var page = 1000;
  var offset = 0;
  var pageNum = 0;
  var body = {
    p_seller_id: sellerId,
    p_from: fromIso,
    p_to: toIso
  };
  if (extra) {
    var k;
    for (k in extra) {
      if (extra.hasOwnProperty(k) && extra[k] != null) body[k] = extra[k];
    }
  }
  while (true) {
    pageNum++;
    var t0 = Date.now();
    var headers = dbHeaders_(cfg.key);
    headers['Content-Type'] = 'application/json';
    var url = cfg.url + '/rest/v1/rpc/' + encodeURIComponent(fnName) + '?limit=' + page + '&offset=' + offset;
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: headers,
      payload: JSON.stringify(body)
    });
    var ms = Date.now() - t0;
    totalMs += ms;
    var code = res.getResponseCode();
    var text = res.getContentText() || '';
    if (code !== 200 && code !== 206 && code !== 416) {
      throw new Error(fnName + ' HTTP ' + code + ' ' + text.substring(0, 300));
    }
    var rows = [];
    if (text && code !== 416) {
      rows = JSON.parse(text);
      if (!rows || !rows.length) rows = [];
    }
    totalRows += rows.length;
    lines.push('стр ' + pageNum + ': ' + rows.length + ' строк, ' + (ms / 1000).toFixed(2) + ' с');
    if (rows.length < page) break;
    offset += page;
    if (offset > 200000) break;
  }
  return {
    fn: fnName,
    from: fromIso,
    to: toIso,
    rows: totalRows,
    ms: totalMs,
    pages: pageNum,
    lines: lines
  };
}

function benchReportRpcLine_(pack) {
  var out = ['RPC: ' + pack.fn];
  if (pack.from && pack.to) out.push('период: ' + pack.from + ' … ' + pack.to);
  for (var i = 0; i < pack.lines.length; i++) out.push(pack.lines[i]);
  out.push('→ ' + pack.rows + ' строк, ' + (pack.ms / 1000).toFixed(2) + ' с');
  return out;
}

function benchReportSpeedForSheet_(ss, sheetName) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var slug = typeof reportSellerSlug_ === 'function' ? reportSellerSlug_(ss) : 'main';
  var sellerId = resolveSellerId_(slug);
  var lines = ['Лист: ' + sheetName];
  var totalMs = 0;
  var totalRows = 0;

  var spec = null;
  var k;
  for (k in REPORT_SHEETS_) {
    if (!Object.prototype.hasOwnProperty.call(REPORT_SHEETS_, k)) continue;
    if (REPORT_SHEETS_[k].sheet === sheetName) { spec = REPORT_SHEETS_[k]; break; }
  }

  if (spec) {
    var sh = ss.getSheetByName(sheetName);
    var per = sh ? reportReadPeriod_(sh) : null;
    if (!per) throw new Error('Нет дат в A1–A2 на листе «' + sheetName + '»');
    var packs = [];
    if (spec.kind === 'ads') {
      packs.push(benchReportRpcOnly_('report_finance_daily', sellerId, per.from, per.to));
      packs.push(benchReportRpcOnly_('report_adv_daily', sellerId, per.from, per.to));
    } else if (spec.kind === 'orders') {
      packs.push(benchReportRpcOnly_('report_order_article_extras', sellerId, per.from, per.to));
    } else if (spec.kind === 'orders_fbs') {
      packs.push(benchReportRpcOnly_('report_fbs_orders_daily', sellerId, per.from, per.to));
    } else {
      packs.push(benchReportRpcOnly_('report_finance_daily', sellerId, per.from, per.to));
    }
    for (var p = 0; p < packs.length; p++) {
      var block = benchReportRpcLine_(packs[p]);
      for (var b = 0; b < block.length; b++) lines.push(block[b]);
      totalMs += packs[p].ms;
      totalRows += packs[p].rows;
      if (p < packs.length - 1) lines.push('');
    }
    lines.push('—');
    lines.push('Итого RPC: ' + totalRows + ' строк, ' + (totalMs / 1000).toFixed(2) + ' с (без Sheets)');
    if (typeof log_ === 'function') log_(ss, sheetName, 'бенч отчёт', totalRows, packs[0].pages, 0, packs.map(function (x) { return x.fn; }).join('+'), totalMs);
    return lines.join('\n');
  }

  if (typeof infoSheetName_ === 'function' && typeof infoFetch_ === 'function') {
    var kinds = ['daily', 'weekly', 'monthly'];
    var ki;
    for (ki = 0; ki < kinds.length; ki++) {
      if (infoSheetName_(kinds[ki]) !== sheetName) continue;
      var dayIso = '';
      if (kinds[ki] === 'weekly' && typeof infoDefaultWeekEndIso_ === 'function') dayIso = infoDefaultWeekEndIso_();
      var t0 = Date.now();
      infoFetch_(sellerId, kinds[ki], dayIso);
      var ms = Date.now() - t0;
      lines.push('RPC: report_info_' + kinds[ki]);
      lines.push('Сеть: ' + (ms / 1000).toFixed(2) + ' с (без Sheets)');
      if (typeof log_ === 'function') log_(ss, sheetName, 'бенч отчёт', 0, 0, 0, 'report_info_' + kinds[ki], ms);
      return lines.join('\n');
    }
  }

  if (sheetName === 'stock' || sheetName === 'остатки') {
    if (typeof skuRpc_ !== 'function') throw new Error('skuRpc_ недоступен');
    var t1 = Date.now();
    skuRpc_(sellerId, 'report_ops_now', { p_seller_id: sellerId });
    var ms1 = Date.now() - t1;
    lines.push('RPC: report_ops_now');
    lines.push('Сеть: ' + (ms1 / 1000).toFixed(2) + ' с (без Sheets)');
    if (typeof log_ === 'function') log_(ss, sheetName, 'бенч отчёт', 0, 0, 0, 'report_ops_now', ms1);
    return lines.join('\n');
  }

  if (sheetName === POSTAVKA_NEW_SHEET_ || sheetName === POSTAVKA2_SHEET_) {
    var shPost = ss.getSheetByName(sheetName);
    if (!shPost) throw new Error('Лист «' + sheetName + '» не найден');
    var abVals = shPost.getRange(1, 1, 5, 2).getValues();
    var abDisp = shPost.getRange(1, 1, 5, 1).getDisplayValues();
    var fromIso = reportParseDisplayDate_(abDisp[0][0]) || reportDateIso_(abVals[0][0]);
    var toIso = reportParseDisplayDate_(abDisp[1][0]) || reportDateIso_(abVals[1][0]);
    var supplyFrom = reportParseDisplayDate_(abDisp[2][0]) || reportDateIso_(abVals[2][0]);
    var supplyTo = reportParseDisplayDate_(abDisp[3][0]) || reportDateIso_(abVals[3][0]);
    var daysCount = parseFloat(String(abVals[4][0]).replace(',', '.')) || 30;
    if (!fromIso || !toIso || !supplyFrom || !supplyTo) throw new Error('Нет дат в A1–A4 на «' + sheetName + '»');
    var rpcName = sheetName === POSTAVKA2_SHEET_ ? 'report_postavka_2' : 'report_postavka_new';
    var packPost = benchReportRpcOnly_(rpcName, sellerId, fromIso, toIso, {
      p_supply_from: supplyFrom,
      p_supply_to: supplyTo,
      p_days: daysCount
    });
    var blockPost = benchReportRpcLine_(packPost);
    for (var bp = 0; bp < blockPost.length; bp++) lines.push(blockPost[bp]);
    lines.push('—');
    lines.push('Итого RPC: ' + packPost.rows + ' строк, ' + (packPost.ms / 1000).toFixed(2) + ' с (без Sheets)');
    if (typeof log_ === 'function') log_(ss, sheetName, 'бенч отчёт', packPost.rows, packPost.pages, 0, rpcName, packPost.ms);
    return lines.join('\n');
  }

  throw new Error('Неизвестный отчётный лист: ' + sheetName);
}

function menuBenchReportSpeedThisSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    var msg = benchReportSpeedForSheet_(ss, ss.getActiveSheet().getName());
    SpreadsheetApp.getUi().alert('Скорость отчёта', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Скорость отчёта', String(e && e.message ? e.message : e), SpreadsheetApp.getUi().ButtonSet.OK);
  }
}
