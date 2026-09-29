/**
 * Листы «info daily» / «info weekly» / «info monthly» — дашборд из RPC.
 * Утро сначала: день, месяц, stock; неделя — только в понедельник за прошлую пн–вс.
 * Потом сырьё на листы. Меню «info» можно запускать вручную в любой день.
 * Загрузки — Сервис → Загрузки, не блок на листе.
 */

var INFO_DAILY_SHEET_ = 'info daily';
var INFO_WEEKLY_SHEET_ = 'info weekly';
var INFO_MONTHLY_SHEET_ = 'info monthly';
var INFO_SHEET_ = INFO_DAILY_SHEET_;
var INFO_HEADER_BG_ = '#3d3d3d';
var INFO_HEADER_FG_ = '#ffffff';
var INFO_LABEL_BG_ = '#efefef';
var INFO_SECTION_BG_ = '#e8e8e8';
var INFO_CARD_BG_ = '#f7f7f7';
var INFO_LINE_BG_ = '#f3f3f3';
var INFO_GREEN_ = '#1b7a3d';
var INFO_RED_ = '#b3261e';
var INFO_MUTED_ = '#666666';
var INFO_OK_ = '#e7f3ea';
var INFO_BAD_ = '#f8e6e4';

function runInfoDashboard() {
  infoRunKind_('daily');
}

function runInfoWeeklyDashboard() {
  infoRunKind_('weekly');
}

function runInfoMonthlyDashboard() {
  infoRunKind_('monthly');
}

function infoSheetName_(kind) {
  if (kind === 'weekly') return INFO_WEEKLY_SHEET_;
  if (kind === 'monthly') return INFO_MONTHLY_SHEET_;
  return INFO_DAILY_SHEET_;
}

function infoNormalizeKind_(kind) {
  if (kind === 'weekly') return 'weekly';
  if (kind === 'monthly') return 'monthly';
  return 'daily';
}

function infoIsRangeKind_(kind) {
  return kind === 'weekly' || kind === 'monthly';
}

/** После выгрузки отчёта — перейти на его лист (меню / диалог). */
function dashboardActivateSheet_(ss, sheetName) {
  try {
    var sh = ss.getSheetByName(String(sheetName || '').trim());
    if (sh) ss.setActiveSheet(sh);
  } catch (e) {}
}

function infoRunKind_(kind, dayIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  kind = infoNormalizeKind_(kind);
  var sheetName = infoSheetName_(kind);
  try {
    var n = infoWriteDashboard_(ss, kind, dayIso);
    var ms = Date.now() - t0;
    if (typeof reportLog_ === 'function') reportLog_(ss, sheetName, 'отчёт', n, dayIso || '', ms);
    infoNotifyDone_(sheetName, ms);
  } catch (err) {
    if (typeof reportLog_ === 'function') reportLog_(ss, sheetName, 'ошибка', 0, String(err), Date.now() - t0);
    try { SpreadsheetApp.getUi().alert('«' + sheetName + '»: ' + err); } catch (e1) {}
  }
}

function showInfoDayDialog() {
  var t = HtmlService.createTemplateFromFile('info_pick');
  t.payload = JSON.stringify({
    kind: 'daily',
    day: typeof dateFromDays_ === 'function' ? dateFromDays_(1) : '',
    title: 'info за день',
    hint: 'KPI за выбранный день. В истории на листе обновляется только хвост 7 дней из базы.'
  });
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(420).setHeight(280), 'info: день');
}

function showInfoWeekDialog() {
  var t = HtmlService.createTemplateFromFile('info_pick');
  t.payload = JSON.stringify({
    kind: 'weekly',
    day: infoDefaultWeekEndIso_(),
    title: 'info за неделю',
    hint: 'Неделя пн–вс. В истории на листе обновляется только хвост 7 недель из базы.'
  });
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(420).setHeight(300), 'info: неделя');
}

function showInfoMonthDialog() {
  var t = HtmlService.createTemplateFromFile('info_pick');
  t.payload = JSON.stringify({
    kind: 'monthly',
    day: infoDefaultMonthEndIso_(),
    title: 'info за месяц',
    hint: 'Любая дата месяца — этот календарный месяц. По умолчанию текущий месяц до вчера, Δ к тому же числу дней прошлого месяца. 1-го утра — полный прошлый месяц. В истории на листе обновляется только хвост 7 месяцев из базы.'
  });
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(420).setHeight(300), 'info: месяц');
}

function runInfoForDate(payload) {
  if (!payload || !payload.day) throw new Error('Нет даты');
  var kind = infoNormalizeKind_(payload.kind);
  var day = String(payload.day).trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  var sheetName = infoSheetName_(kind);
  try {
    var n = infoWriteDashboard_(ss, kind, day);
    var ms = Date.now() - t0;
    if (typeof reportLog_ === 'function') reportLog_(ss, sheetName, 'отчёт', n, day, ms);
    return { ok: true, sheet: sheetName, ms: ms, day: day };
  } catch (err) {
    if (typeof reportLog_ === 'function') reportLog_(ss, sheetName, 'ошибка', 0, String(err), Date.now() - t0);
    throw err;
  }
}

function showInfoLoadsDialog() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('info_loads').setWidth(640).setHeight(520),
    'info: загрузки'
  );
}

function getInfoLoads() {
  var data = typeof getLoadSettings === 'function' ? getLoadSettings() : { slug: 'main', rows: [] };
  var today = typeof nowMsk_ === 'function' ? String(nowMsk_()).substring(0, 10) : '';
  var accessMap = {};
  try {
    if (typeof readDatasetAccessCache_ === 'function') {
      accessMap = readDatasetAccessCache_(data.slug || 'main') || {};
    }
  } catch (eAcc) {}
  var loads = [];
  var rows = data.rows || [];
  var i;
  for (i = 0; i < rows.length; i++) {
    var row = rows[i];
    var updated = String(row.updated || '').trim();
    var enabled = !!row.enabled;
    var allowed = typeof isSheetAccessAllowed_ === 'function'
      ? isSheetAccessAllowed_(row.sheet, accessMap)
      : true;
    var active = enabled && allowed;
    var fresh = active && today && updated.indexOf(today) === 0;
    loads.push({
      sheet: allowed ? row.sheet : ('🔒 ' + row.sheet),
      enabled: active,
      locked: !allowed,
      period: allowed ? (row.period || '') : '—',
      loaded_at: allowed ? updated : '—',
      fresh: fresh,
      note: !allowed ? 'доступ закрыт' : (enabled ? (updated ? '' : 'ещё не грузили в книгу') : 'выкл')
    });
  }
  return {
    slug: data.slug || 'main',
    updated: typeof nowMsk_ === 'function' ? nowMsk_() : '',
    loads: loads
  };
}

/** Ручной пересчёт (меню). Из триггера/автозагрузки не вызывать — там нет UI. */
function infoNotifyDone_(sheetName, ms) {
  var sec = (Number(ms) / 1000).toFixed(1);
  var msg = sheetName + ': выгрузка завершена (' + sec + ' с)';
  try {
    SpreadsheetApp.getUi().alert(
      typeof APP_NAME_ !== 'undefined' ? APP_NAME_ : 'WB',
      msg,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {}
}

function runInfoDashboardSilent_(ss) {
  if (!ss) return 0;
  infoWriteDashboard_(ss, 'daily');
  infoWriteDashboard_(ss, 'monthly');
  if (infoIsMondayMsk_()) infoWriteDashboard_(ss, 'weekly', infoDefaultWeekEndIso_());
  return 1;
}

function infoIsMondayMsk_() {
  return Utilities.formatDate(new Date(), 'Europe/Moscow', 'u') === '1';
}

function infoIsFirstOfMonthMsk_() {
  return Utilities.formatDate(new Date(), 'Europe/Moscow', 'd') === '1';
}

function infoDefaultWeekEndIso_() {
  var iso = typeof mskToday_ === 'function'
    ? mskToday_()
    : Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
  var p = String(iso).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  var sun = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - sun);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function infoDefaultMonthEndIso_() {
  if (typeof dateFromDays_ === 'function') return dateFromDays_(1);
  var iso = typeof mskToday_ === 'function'
    ? mskToday_()
    : Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
  var p = String(iso).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() - 1);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function infoWriteDashboard_(ss, kind, dayIso) {
  if (typeof reportEnsureMoscowTz_ === 'function') reportEnsureMoscowTz_(ss);
  var slug = typeof reportSellerSlug_ === 'function' ? reportSellerSlug_(ss) : 'main';
  var sellerId = resolveSellerId_(slug);
  kind = infoNormalizeKind_(kind);
  var sheetName = infoSheetName_(kind);
  var insertAt = kind === 'monthly'
    ? startSheetInsertIndex_(ss, 2)
    : (kind === 'weekly' ? startSheetInsertIndex_(ss, 1) : startSheetInsertIndex_(ss, 0));
  dayIso = String(dayIso || '').trim();
  var sheet = ss.getSheetByName(sheetName);
  var histMeta = sheet ? infoFindHistoryMeta_(sheet, kind) : null;
  var canFast = !!(histMeta && histMeta.totalRows > 7 && histMeta.titleRow > 5);
  var histKeep = null;
  if (histMeta && histMeta.totalRows > 0) {
    var readCount = canFast ? Math.min(7, histMeta.totalRows) : histMeta.totalRows;
    histKeep = sheet.getRange(histMeta.bodyRow, 1, readCount, 12).getValues();
  }
  var data = infoFetch_(sellerId, kind, dayIso);
  if (!data || !data.day) throw new Error('RPC report_info_' + kind + ' вернул пусто');
  if (histKeep && histKeep.length) {
    data._histKeep = infoMergeHistory_(histKeep, data.journal || [], kind);
    data._histTotal = histMeta.totalRows || (data._histKeep ? data._histKeep.length : 0);
  }

  infoRenameLegacy_(ss);
  sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName, insertAt);
  } else if (kind === 'daily') {
    var wantPos = startSheetMovePos_(ss, 1);
    var atPos = ss.getSheets()[wantPos - 1];
    if (!atPos || atPos.getName() !== sheetName) {
      try {
        ss.setActiveSheet(sheet);
        ss.moveActiveSheet(wantPos);
      } catch (eMove) {}
    }
  }

  ensureStartSheetFirst_(ss);

  var built = infoBuildGrid_(data, kind);
  if (canFast) {
    infoWriteDashboardFast_(sheet, data, built, histMeta);
  } else {
    infoResetSheet_(sheet);
    infoEnsureGrid_(sheet, built.values.length, 12);
    sheet.getRange(1, 1, built.values.length, 12).setValues(built.values);
    infoApplyLayout_(sheet, data, built);
  }
  var period = infoIsRangeKind_(kind)
    ? infoRange_(data.week_start, data.day)
    : infoDate_(data.day);
  var days = kind === 'weekly' ? '7' : (kind === 'monthly' ? startDaysFromPeriod_(period) : '1');
  writeStartDashboardStamp_(ss, sheetName, period, days);
  dashboardActivateSheet_(ss, sheetName);
  return (data._histKeep || data.journal || []).length;
}

function infoRenameLegacy_(ss) {
  var old = ss.getSheetByName('info');
  if (old && !ss.getSheetByName(INFO_DAILY_SHEET_)) {
    try { old.setName(INFO_DAILY_SHEET_); } catch (eN) {}
  }
}

function infoFetch_(sellerId, kind, dayIso) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var headers = dbHeaders_(cfg.key);
  headers['Content-Type'] = 'application/json';
  kind = infoNormalizeKind_(kind);
  var rpc = 'report_info_' + kind;
  var body = { p_seller_id: sellerId };
  dayIso = String(dayIso || '').trim();
  if (kind === 'monthly') {
    if (dayIso) body.p_month_end = dayIso;
  } else if (kind === 'weekly') {
    if (dayIso) body.p_week_end = dayIso;
  } else {
    if (dayIso) body.p_day = dayIso;
    body.p_journal_days = 7;
  }
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
  if (Array.isArray(parsed)) parsed = parsed[0] || null;
  return parsed;
}

function infoHistNeedle_(kind) {
  if (kind === 'weekly') return 'история по неделям';
  if (kind === 'monthly') return 'история по месяцам';
  return 'история по дням';
}

function infoJournalRow_(jn, kind) {
  var ranged = infoIsRangeKind_(kind);
  return [
    ranged ? infoRange_(jn.day, jn.week_end) : infoDate_(jn.day),
    infoN_(jn.qty),
    infoN_(jn.retail),
    infoN_(jn.for_pay),
    infoN_(jn.ads),
    jn.drr == null ? '' : infoN_(jn.drr),
    infoN_(jn.fbo),
    infoN_(jn.fbs),
    infoN_(jn.fbo_cancels),
    infoN_(jn.fbs_cancels),
    jn.fbo_stock == null ? '' : infoN_(jn.fbo_stock),
    jn.fbs_stock == null ? '' : infoN_(jn.fbs_stock)
  ];
}

/** С листа — всё кроме хвоста 7 периодов; хвост пересчитываем из RPC. */
function infoMergeHistory_(kept, journal, kind) {
  if (!kept || !kept.length) return null;
  var tail = 7;
  var older = kept.length > tail ? kept.slice(tail) : [];
  var fresh = [];
  var i;
  if (journal && journal.length) {
    for (i = 0; i < journal.length; i++) fresh.push(infoJournalRow_(journal[i], kind));
  }
  var out = [];
  for (i = 0; i < fresh.length; i++) out.push(fresh[i]);
  for (i = 0; i < older.length; i++) {
    var row = older[i].slice();
    while (row.length < 12) row.push('');
    out.push(row.slice(0, 12));
  }
  return out.length ? out : null;
}

function infoReadHistoryBlock_(sheet, kind) {
  var meta = infoFindHistoryMeta_(sheet, kind);
  if (!meta || !meta.totalRows) return null;
  return sheet.getRange(meta.bodyRow, 1, meta.totalRows, 12).getValues();
}

function infoFindHistoryMeta_(sheet, kind) {
  if (!sheet || sheet.getLastRow() < 3) return null;
  var last = sheet.getLastRow();
  var colA = sheet.getRange(1, 1, last, 1).getValues();
  var needle = infoHistNeedle_(kind);
  var i;
  for (i = 0; i < colA.length; i++) {
    if (String(colA[i][0] || '').trim().toLowerCase().indexOf(needle) !== 0) continue;
    var titleRow = i + 1;
    var headRow = i + 2;
    var bodyRow = i + 3;
    var dataEnd = bodyRow - 1;
    var r;
    for (r = bodyRow - 1; r < colA.length; r++) {
      if (colA[r][0] === '' || colA[r][0] == null) break;
      dataEnd = r + 1;
    }
    var histCount = dataEnd - bodyRow + 1;
    return { titleRow: titleRow, headRow: headRow, bodyRow: bodyRow, totalRows: Math.max(histCount, 0) };
  }
  return null;
}

function infoWriteDashboardFast_(sheet, data, built, histMeta) {
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
  infoApplyLayoutDashboard_(sheet, data, built, dashRows);

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
      infoApplyLayoutHistory_(sheet, histTitleRow, histHeadRow, histBodyRow, histRows, histBodyRow, writeCount);
    }
  }

  infoApplySheetChrome_(sheet, histBodyRow + histRows - 1, built);
}

function infoResetSheet_(sheet) {
  try { if (sheet.getFilter()) sheet.getFilter().remove(); } catch (eF) {}
  infoClearBandings_(sheet);
  var rows = Math.max(sheet.getLastRow(), 80);
  var cols = Math.max(sheet.getMaxColumns(), 12);
  if (sheet.getMaxColumns() < 12) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
    cols = 12;
  }
  try { sheet.getRange(1, 1, rows, cols).breakApart(); } catch (eB) {}
  sheet.clear();
  try { sheet.setHiddenGridlines(true); } catch (eG) {}
  try { sheet.setTabColor('#5c6b73'); } catch (eT) {}
}

function infoClearBandings_(sheet) {
  if (!sheet) return;
  try {
    var list = sheet.getBandings();
    var i;
    for (i = 0; i < list.length; i++) list[i].remove();
  } catch (eB) {}
}

function infoEnsureGrid_(sheet, needRows, needCols) {
  if (!sheet) return;
  needRows = Math.max(Number(needRows) || 1, 1);
  needCols = Math.max(Number(needCols) || 1, 1);
  if (sheet.getMaxRows() < needRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < needCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols - sheet.getMaxColumns());
  }
}

function infoStripeBody_(sheet, startRow, nRows, nCols) {
  if (!sheet || nRows < 1 || nCols < 1) return;
  var colors = [];
  var r;
  var c;
  for (r = 0; r < nRows; r++) {
    var bg = r % 2 === 1 ? INFO_LINE_BG_ : '#ffffff';
    var line = [];
    for (c = 0; c < nCols; c++) line.push(bg);
    colors.push(line);
  }
  sheet.getRange(startRow, 1, nRows, nCols).setBackgrounds(colors);
}

function infoEmpty_() {
  return ['', '', '', '', '', '', '', '', '', '', '', ''];
}

function infoBuildGrid_(data, kind) {
  var kpi = data.kpi || {};
  var fin = data.finance || {};
  var ads = data.ads || {};
  var fbo = data.fbo || {};
  var fbs = data.fbs || {};
  var stocks = data.stocks || {};
  var supplies = data.supplies || [];
  var journal = data.journal || [];
  var kept = data._histKeep;
  var i;
  kind = infoNormalizeKind_(kind);
  var ranged = infoIsRangeKind_(kind);

  var rows = [];
  var sec = {};
  var period = ranged ? infoRange_(data.week_start, data.day) : infoDate_(data.day);
  var prevLabel = ranged ? infoRange_(data.prev_week_start, data.prev_day) : infoDateShort_(data.prev_day);
  var sub;
  if (kind === 'monthly') {
    sub = 'Месяц. Δ к прошлому (' + prevLabel + ') и к средней за 90 дней (сумма/90×дней окна; остатки — среднее снимков). Поставки FBW/FBS — текущий статус.';
    if (data.complete === false) sub += ' Неполный месяц: сравнение равным префиксом прошлого.';
  } else if (kind === 'weekly') {
    sub = 'Неделя пн–вс. Δ к позапрошлой (' + prevLabel + ') и к средней неделе за 30 дней (сумма/30×7; остатки — среднее снимков). Поставки FBW/FBS — текущий статус.';
  } else {
    sub = 'Δ под цифрами: к ' + prevLabel + ' и к среднему за 7 дней. В блоках те же даты. Поставки FBW/FBS — текущий статус, без вчера и среднего.';
  }
  if (kept && kept.length) sub += ' История: старое с листа, хвост 7 ' + (kind === 'monthly' ? 'мес.' : (kind === 'weekly' ? 'нед.' : 'дн.')) + ' из базы.';

  sec.header = rows.length + 1;
  rows.push([
    kind === 'monthly' ? 'INFO MONTHLY' : (kind === 'weekly' ? 'INFO WEEKLY' : 'INFO DAILY'),
    '', 'данные за', period, 'обновлено', data.updated_at || '',
    'кабинет', data.slug || '', '', '', '', ''
  ]);
  rows.push([sub, '', '', '', '', '', '', '', '', '', '', '']);
  rows.push(infoEmpty_());

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
  sec.kpiAvg = rows.length + 1;
  rows.push([
    infoDelta_(kpi.qty, kpi.qty_avg7), '', infoDelta_(kpi.retail, kpi.retail_avg7), '',
    infoDelta_(kpi.for_pay, kpi.for_pay_avg7), '', infoDelta_(kpi.ads, kpi.ads_avg7), '',
    infoDelta_(kpi.drr, kpi.drr_avg7), '', infoDelta_(kpi.orders, kpi.orders_avg7), ''
  ]);
  rows.push(infoEmpty_());

  sec.finTitle = rows.length + 1;
  rows.push(['Финансы', '', '', '', '', '', 'Реклама', '', '', '', '', '']);
  sec.finHead = rows.length + 1;
  rows.push(infoHeadSix_(data, kind).concat(infoHeadSix_(data, kind)));
  sec.finBody = rows.length + 1;
  var finRows = [
    infoSix_('Продажи, шт', fin.qty, kpi.qty_prev, kpi.qty_avg7),
    infoSix_('Возвраты, шт', fin.qty_returns, fin.qty_returns_prev, fin.qty_returns_avg7),
    infoSix_('Выручка, ₽', fin.retail, kpi.retail_prev, kpi.retail_avg7),
    infoSix_('Средний чек, ₽', fin.avg_check, fin.avg_check_prev, fin.avg_check_avg7),
    infoSix_('К перечислению, ₽', fin.for_pay, kpi.for_pay_prev, kpi.for_pay_avg7),
    infoSix_('Комиссия, ₽', fin.commission, fin.commission_prev, fin.commission_avg7),
    infoSix_('Логистика, ₽', fin.logistics, fin.logistics_prev, fin.logistics_avg7),
    infoSix_('Хранение, ₽', fin.storage, fin.storage_prev, fin.storage_avg7),
    infoSix_('Приёмка, ₽', fin.acceptance, fin.acceptance_prev, fin.acceptance_avg7),
    infoSix_('Эквайринг, ₽', fin.acquiring, fin.acquiring_prev, fin.acquiring_avg7),
    infoSix_('Удержания, ₽', fin.deduction, fin.deduction_prev, fin.deduction_avg7),
    infoSix_('Штрафы, ₽', fin.penalty, fin.penalty_prev, fin.penalty_avg7)
  ];
  var adsRows = [
    infoSix_('Расход, ₽', ads.spend, kpi.ads_prev, kpi.ads_avg7),
    infoSix_('Показы', ads.views, ads.views_prev, ads.views_avg7),
    infoSix_('Клики', ads.clicks, ads.clicks_prev, ads.clicks_avg7),
    infoSix_('CPC, ₽', ads.cpc, ads.cpc_prev, ads.cpc_avg7),
    infoSix_('CTR', ads.ctr, ads.ctr_prev, ads.ctr_avg7),
    infoSix_('Заказы с рекламы', ads.orders, ads.orders_prev, ads.orders_avg7),
    infoSix_('ДРР', ads.drr, kpi.drr_prev, kpi.drr_avg7),
    infoSix_('После рекламы, ₽', ads.after_ads, ads.after_ads_prev, ads.after_ads_avg7)
  ];
  sec.finRows = 12;
  sec.finInvert = [0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1];
  sec.adsInvert = [1, 0, 0, 1, 0, 0, 1, 0];
  for (i = 0; i < 12; i++) {
    rows.push(infoJoinSix_(finRows[i], adsRows[i]));
  }

  rows.push(infoEmpty_());
  sec.ordTitle = rows.length + 1;
  rows.push(['Заказы FBW', '', '', '', '', '', 'Заказы FBS', '', '', '', '', '']);
  sec.ordHead = rows.length + 1;
  rows.push(infoHeadSix_(data, kind).concat(infoHeadSix_(data, kind)));
  sec.ordBody = rows.length + 1;
  rows.push(infoJoinSix_(
    infoSix_('Заказы, шт', fbo.orders, fbo.orders_prev, fbo.orders_avg7),
    infoSix_('Заказы, шт', fbs.orders, fbs.orders_prev, fbs.orders_avg7)
  ));
  rows.push(infoJoinSix_(
    infoSix_('Отмены', fbo.cancels, fbo.cancels_prev, fbo.cancels_avg7),
    infoSix_('Отмены', fbs.cancels, fbs.cancels_prev, fbs.cancels_avg7)
  ));
  rows.push(infoJoinSix_(
    infoSix_('Сумма, ₽', fbo.sum, fbo.sum_prev, fbo.sum_avg7),
    infoSix_('Сумма, ₽', fbs.sum, fbs.sum_prev, fbs.sum_avg7)
  ));
  rows.push(infoJoinSix_(
    infoSix_('Средняя цена, ₽', infoAvgPrice_(fbo.sum, fbo.orders), infoAvgPrice_(fbo.sum_prev, fbo.orders_prev), infoAvgPrice_(fbo.sum_avg7, fbo.orders_avg7)),
    infoSix_('Средняя цена, ₽', infoAvgPrice_(fbs.sum, fbs.orders), infoAvgPrice_(fbs.sum_prev, fbs.orders_prev), infoAvgPrice_(fbs.sum_avg7, fbs.orders_avg7))
  ));
  rows.push(infoJoinSix_(
    ['', '', '', '', '', ''],
    infoSix_('Отсортировано', fbs.sorted, fbs.sorted_prev, fbs.sorted_avg7)
  ));
  rows.push(infoJoinSix_(
    ['', '', '', '', '', ''],
    infoSix_('Ожидает', fbs.waiting, fbs.waiting_prev, fbs.waiting_avg7)
  ));
  var stRaw = fbs.statuses_7d || [];
  var st = [];
  for (i = 0; i < stRaw.length; i++) {
    if (infoFbsStatusDup_(stRaw[i].status)) continue;
    st.push(stRaw[i]);
  }
  for (i = 0; i < st.length; i++) {
    rows.push(infoJoinSix_(
      ['', '', '', '', '', ''],
      infoSix_(st[i].status || '—', st[i].n, null, null)
    ));
  }
  sec.ordRows = 6 + st.length;
  sec.ordInvertL = [0, 1, 0, 0, 0, 0];
  sec.ordInvertR = [0, 1, 0, 0, 0, 0];
  for (i = 0; i < st.length; i++) {
    sec.ordInvertL.push(0);
    sec.ordInvertR.push(0);
  }

  rows.push(infoEmpty_());
  sec.stkTitle = rows.length + 1;
  rows.push(['Остатки', '', '', '', '', '', '', '', '', '', '', '']);
  sec.stkHead = rows.length + 1;
  rows.push(infoHeadSix_(data, kind).concat(['', '', '', '', '', '']));
  sec.stkBody = rows.length + 1;
  rows.push(infoJoinSix_(
    infoSix_('FBW на складах, шт', stocks.fbo_qty, stocks.fbo_qty_prev, stocks.fbo_qty_avg7),
    ['', '', '', '', '', '']
  ));
  rows.push(infoJoinSix_(
    infoSix_('Артикулов с остатком', stocks.fbo_arts, stocks.fbo_arts_prev, stocks.fbo_arts_avg7),
    ['', '', '', '', '', '']
  ));
  rows.push(infoJoinSix_(
    infoSix_('В пути к клиенту, шт', stocks.in_way_to, stocks.in_way_to_prev, stocks.in_way_to_avg7),
    ['', '', '', '', '', '']
  ));
  rows.push(infoJoinSix_(
    infoSix_('В пути от клиента, шт', stocks.in_way_from, stocks.in_way_from_prev, stocks.in_way_from_avg7),
    ['', '', '', '', '', '']
  ));
  rows.push(infoJoinSix_(
    infoSix_('FBS на складах, шт', stocks.fbs_qty, stocks.fbs_qty_prev, stocks.fbs_qty_avg7),
    ['', '', '', '', '', '']
  ));
  sec.stkRows = 5;

  rows.push(infoEmpty_());
  sec.supTitle = rows.length + 1;
  rows.push(['Поставки FBW', '', '', '', '', '', 'Поставки FBS', '', '', '', '', '']);
  sec.supHead = rows.length + 1;
  rows.push(infoHeadNow_().concat(infoHeadNow_()));
  sec.supBody = rows.length + 1;
  var fbsSup = data.fbs_supplies || {};
  rows.push(infoJoinSix_(
    infoNow_('Идёт приёмка', infoSupply_(supplies, '4', 'supplies')),
    infoNow_('Открытые', fbsSup.open)
  ));
  rows.push(infoJoinSix_(
    infoNow_('Не запланировано', infoSupply_(supplies, '1', 'supplies')),
    infoNow_('Заказы в открытых', fbsSup.open_orders)
  ));
  rows.push(infoJoinSix_(
    infoNow_('Отгружено на воротах', infoSupply_(supplies, '6', 'supplies')),
    infoNow_('Закрытые', fbsSup.closed)
  ));
  rows.push(infoJoinSix_(
    infoNow_('Принято (все)', infoSupply_(supplies, '5', 'supplies')),
    infoNow_('Открытые без QR', fbsSup.no_qr)
  ));
  sec.supRows = 4;

  rows.push(infoEmpty_());
  sec.histTitle = rows.length + 1;
  rows.push(['История по ' + (kind === 'monthly' ? 'месяцам' : (kind === 'weekly' ? 'неделям' : 'дням')), '', '', '', '', '', '', '', '', '', '', '']);
  sec.histHead = rows.length + 1;
  rows.push([kind === 'monthly' ? 'Месяц' : (kind === 'weekly' ? 'Неделя' : 'Дата'), 'Шт', 'Выручка, ₽', 'К переч., ₽', 'Реклама, ₽', 'ДРР', 'FBW зак.', 'FBS зак.', 'FBW отм.', 'FBS отм.', 'Остаток FBW', 'Остаток FBS']);
  sec.histBody = rows.length + 1;
  var histRows = data._histKeep;
  if (!histRows || !histRows.length) {
    histRows = [];
    for (i = 0; i < journal.length; i++) histRows.push(infoJournalRow_(journal[i], kind));
  }
  for (i = 0; i < histRows.length; i++) {
    var histRow = histRows[i].slice();
    while (histRow.length < 12) histRow.push('');
    rows.push(histRow.slice(0, 12));
  }
  sec.histRows = histRows.length;
  return { values: rows, sec: sec };
}

function infoApplyLayout_(sheet, data, built) {
  var dashEnd = built.sec.histTitle - 1;
  infoApplyLayoutDashboard_(sheet, data, built, dashEnd);
  if (built.sec.histRows > 0) {
    infoApplyLayoutHistory_(sheet, built.sec.histTitle, built.sec.histHead, built.sec.histBody, built.sec.histRows);
  }
  infoApplySheetChrome_(sheet, built.values.length, built);
}

function infoApplyLayoutDashboard_(sheet, data, built, dashEnd) {
  var sec = built.sec;
  var kpi = data.kpi || {};
  var lastCol = 12;

  applyBookFont_(sheet.getRange(1, 1, dashEnd, lastCol))
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  infoMerge_(sheet, 1, 1, 1, 2);
  infoMerge_(sheet, 2, 1, 1, 12);
  var p;
  for (p = 0; p < 6; p++) {
    infoMerge_(sheet, sec.kpiLabel, 1 + p * 2, 1, 2);
    infoMerge_(sheet, sec.kpiValue, 1 + p * 2, 1, 2);
    infoMerge_(sheet, sec.kpiPrev, 1 + p * 2, 1, 2);
    infoMerge_(sheet, sec.kpiAvg, 1 + p * 2, 1, 2);
  }
  infoMerge_(sheet, sec.finTitle, 1, 1, 6);
  infoMerge_(sheet, sec.finTitle, 7, 1, 6);
  infoMerge_(sheet, sec.ordTitle, 1, 1, 6);
  infoMerge_(sheet, sec.ordTitle, 7, 1, 6);
  infoMerge_(sheet, sec.stkTitle, 1, 1, 12);
  infoMerge_(sheet, sec.supTitle, 1, 1, 6);
  infoMerge_(sheet, sec.supTitle, 7, 1, 6);
  infoMerge_(sheet, sec.supHead, 2, 1, 5);
  infoMerge_(sheet, sec.supHead, 8, 1, 5);
  var sr;
  for (sr = 0; sr < sec.supRows; sr++) {
    infoMerge_(sheet, sec.supBody + sr, 2, 1, 5);
    infoMerge_(sheet, sec.supBody + sr, 8, 1, 5);
  }

  sheet.getRange(1, 1, 1, lastCol)
    .setBackground(INFO_HEADER_BG_)
    .setFontColor(INFO_HEADER_FG_)
    .setFontWeight('bold')
    .setFontSize(11);
  sheet.getRange(1, 3).setFontWeight('normal').setFontSize(9);
  sheet.getRange(1, 5).setFontWeight('normal').setFontSize(9);
  sheet.getRange(1, 7).setFontWeight('normal').setFontSize(9);
  sheet.getRange(1, 1).setFontSize(14);

  sheet.getRange(2, 1, 1, lastCol)
    .setBackground(INFO_LINE_BG_)
    .setFontColor(INFO_MUTED_)
    .setFontStyle('italic')
    .setFontSize(9);

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
  sheet.getRange(sec.kpiAvg, 1, 1, lastCol).setFontSize(9).setHorizontalAlignment('center');

  sheet.getRange(sec.kpiValue, 1).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 3).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 5).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 7).setNumberFormat('#,##0');
  sheet.getRange(sec.kpiValue, 9).setNumberFormat('0.0%');
  sheet.getRange(sec.kpiValue, 11).setNumberFormat('#,##0');

  infoColorDeltaRow_(sheet, sec.kpiPrev, [kpi.qty, kpi.retail, kpi.for_pay, kpi.ads, kpi.drr, kpi.orders], [kpi.qty_prev, kpi.retail_prev, kpi.for_pay_prev, kpi.ads_prev, kpi.drr_prev, kpi.orders_prev]);
  infoColorDeltaRow_(sheet, sec.kpiAvg, [kpi.qty, kpi.retail, kpi.for_pay, kpi.ads, kpi.drr, kpi.orders], [kpi.qty_avg7, kpi.retail_avg7, kpi.for_pay_avg7, kpi.ads_avg7, kpi.drr_avg7, kpi.orders_avg7]);

  infoSectionTitle_(sheet, sec.finTitle, lastCol);
  infoSectionTitle_(sheet, sec.ordTitle, lastCol);
  infoSectionTitle_(sheet, sec.stkTitle, lastCol);
  infoSectionTitle_(sheet, sec.supTitle, lastCol);
  infoColHead_(sheet, sec.finHead, 12);
  infoColHead_(sheet, sec.ordHead, 12);
  infoColHead_(sheet, sec.stkHead, 6);
  infoColHead_(sheet, sec.supHead, 12);
  sheet.getRange(sec.finHead, 1, 1, 12).setWrap(true).setHorizontalAlignment('center');
  sheet.getRange(sec.ordHead, 1, 1, 12).setWrap(true).setHorizontalAlignment('center');
  sheet.getRange(sec.stkHead, 1, 1, 6).setWrap(true).setHorizontalAlignment('center');
  sheet.getRange(sec.supHead, 1, 1, 12).setHorizontalAlignment('center');
  sheet.setRowHeight(sec.finHead, 32);
  sheet.setRowHeight(sec.ordHead, 32);
  sheet.setRowHeight(sec.stkHead, 32);

  infoStripeBody_(sheet, sec.finBody, sec.finRows, 12);
  infoStripeBody_(sheet, sec.ordBody, sec.ordRows, 12);
  infoStripeBody_(sheet, sec.stkBody, sec.stkRows, 6);
  infoStripeBody_(sheet, sec.supBody, sec.supRows, 12);
  sheet.getRange(sec.finBody, 1, sec.finRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.finBody, 7, sec.finRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.finBody, 2, sec.finRows, 3).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
  sheet.getRange(sec.finBody, 8, sec.finRows, 3).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
  sheet.getRange(sec.finBody, 5, sec.finRows, 2).setHorizontalAlignment('right').setFontSize(9);
  sheet.getRange(sec.finBody, 11, sec.finRows, 2).setHorizontalAlignment('right').setFontSize(9);
  sheet.getRange(sec.finBody, 2, 2, 3).setNumberFormat('#,##0');
  sheet.getRange(sec.finBody + 1, 8, 2, 3).setNumberFormat('#,##0');
  sheet.getRange(sec.finBody + 4, 8, 1, 3).setNumberFormat('0.00%');
  sheet.getRange(sec.finBody + 5, 8, 1, 3).setNumberFormat('#,##0');
  sheet.getRange(sec.finBody + 6, 8, 1, 3).setNumberFormat('0.0%');
  infoColorGrowBlock_(sheet, sec.finBody, sec.finRows, sec.finInvert, sec.adsInvert);

  sheet.getRange(sec.ordBody, 1, sec.ordRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.ordBody, 7, sec.ordRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.ordBody, 2, sec.ordRows, 3).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(sec.ordBody, 8, sec.ordRows, 3).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(sec.ordBody + 2, 2, 2, 3).setNumberFormat('#,##0.00');
  sheet.getRange(sec.ordBody + 2, 8, 2, 3).setNumberFormat('#,##0.00');
  sheet.getRange(sec.ordBody, 5, sec.ordRows, 2).setHorizontalAlignment('right').setFontSize(9);
  sheet.getRange(sec.ordBody, 11, sec.ordRows, 2).setHorizontalAlignment('right').setFontSize(9);
  infoColorGrowBlock_(sheet, sec.ordBody, sec.ordRows, sec.ordInvertL, sec.ordInvertR);

  sheet.getRange(sec.stkBody, 1, sec.stkRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.stkBody, 2, sec.stkRows, 3).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(sec.stkBody, 5, sec.stkRows, 2).setHorizontalAlignment('right').setFontSize(9);
  infoColorGrowBlock_(sheet, sec.stkBody, sec.stkRows, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);

  sheet.getRange(sec.supBody, 1, sec.supRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.supBody, 7, sec.supRows, 1).setFontColor(INFO_MUTED_);
  sheet.getRange(sec.supBody, 2, sec.supRows, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
  sheet.getRange(sec.supBody, 8, sec.supRows, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
}

function infoApplyLayoutHistory_(sheet, histTitle, histHead, histBody, histRows, fmtBodyFrom, fmtBodyCount) {
  infoMerge_(sheet, histTitle, 1, 1, 12);
  infoSectionTitle_(sheet, histTitle, 12);
  infoColHead_(sheet, histHead, 12);
  sheet.getRange(histHead, 1, 1, 12).setHorizontalAlignment('center').setWrap(true);
  sheet.setRowHeight(histHead, 32);
  if (histRows > 0) {
    var bodyStart = fmtBodyFrom != null && fmtBodyFrom >= histBody ? fmtBodyFrom : histBody;
    var bodyCount = fmtBodyCount != null ? fmtBodyCount : (histBody + histRows - bodyStart);
    if (bodyCount > 0) {
      sheet.getRange(bodyStart, 2, bodyCount, 4).setNumberFormat('#,##0').setHorizontalAlignment('right');
      sheet.getRange(bodyStart, 6, bodyCount, 1).setNumberFormat('0.0%').setHorizontalAlignment('right');
      sheet.getRange(bodyStart, 7, bodyCount, 6).setNumberFormat('#,##0').setHorizontalAlignment('right');
      infoStripeBody_(sheet, bodyStart, bodyCount, 12);
    }
    applyBookFont_(sheet.getRange(histBody, 1, histRows, 12))
      .setVerticalAlignment('middle')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
}

function infoApplySheetChrome_(sheet, lastRow, built) {
  var sec = built.sec;
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 108);
  sheet.setColumnWidth(3, 108);
  sheet.setColumnWidth(4, 112);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 96);
  sheet.setColumnWidth(7, 180);
  sheet.setColumnWidth(8, 108);
  sheet.setColumnWidth(9, 108);
  sheet.setColumnWidth(10, 112);
  sheet.setColumnWidth(11, 110);
  sheet.setColumnWidth(12, 112);
  sheet.setFrozenRows(7);
  sheet.setRowHeight(1, 28);
  sheet.setRowHeight(sec.kpiValue, 36);
  sheet.setRowHeight(sec.finHead, 32);
  sheet.setRowHeight(sec.ordHead, 32);
  sheet.setRowHeight(sec.stkHead, 32);
  if (built.sec.histRows > 0) sheet.setRowHeight(built.sec.histHead, 32);
}

function infoSectionTitle_(sheet, row, lastCol) {
  applyBookFont_(sheet.getRange(row, 1, 1, lastCol))
    .setBackground(INFO_SECTION_BG_)
    .setFontWeight('bold')
    .setFontSize(11);
}

function infoColHead_(sheet, row, cols) {
  applyBookFont_(sheet.getRange(row, 1, 1, cols))
    .setBackground(INFO_LABEL_BG_)
    .setFontWeight('bold')
    .setFontColor(INFO_MUTED_)
    .setFontSize(9);
}

function infoMerge_(sheet, row, col, nRows, nCols) {
  try { sheet.getRange(row, col, nRows, nCols).merge(); } catch (e) {}
}

function infoHeadSix_(data, kind) {
  kind = infoNormalizeKind_(kind);
  if (kind === 'monthly') {
    return [
      'Метрика',
      infoRange_(data.week_start, data.day),
      infoRange_(data.prev_week_start, data.prev_day),
      'Средн. 90д',
      'Δ к пред.',
      'Δ к 90д'
    ];
  }
  if (kind === 'weekly') {
    return [
      'Метрика',
      infoRange_(data.week_start, data.day),
      infoRange_(data.prev_week_start, data.prev_day),
      'Средн. 30д',
      'Δ к пред.',
      'Δ к 30д'
    ];
  }
  var d = infoDateShort_(data.day);
  var p = infoDateShort_(data.prev_day);
  return ['Метрика', d, p, 'Средн. 7д', 'Δ к ' + p, 'Δ к 7д'];
}

function infoHeadNow_() {
  return ['Метрика', 'Сейчас', '', '', '', ''];
}

function infoNow_(label, cur) {
  return [
    label,
    cur == null || cur === '' ? '—' : infoN_(cur),
    '',
    '',
    '',
    ''
  ];
}

function infoSix_(label, cur, prev, avg) {
  var hasPrev = prev != null && prev !== '';
  var hasAvg = avg != null && avg !== '';
  return [
    label,
    cur == null || cur === '' ? '—' : infoN_(cur),
    hasPrev ? infoN_(prev) : '—',
    hasAvg ? infoN_(avg) : '—',
    hasPrev ? infoDelta_(cur, prev) : '—',
    hasAvg ? infoDelta_(cur, avg) : '—'
  ];
}

function infoJoinSix_(left, right) {
  return (left || ['', '', '', '', '', '']).concat(right || ['', '', '', '', '', '']);
}

function infoDateShort_(v) {
  var s = infoDate_(v);
  if (s.length >= 5) return s.substring(0, 5);
  return s;
}

function infoRange_(from, to) {
  var a = infoDateShort_(from);
  var b = infoDateShort_(to);
  if (!a && !b) return '';
  if (!b) return a;
  return a + '–' + b;
}

function infoDeltaFontColor_(text, invert) {
  var t = String(text == null ? '' : text);
  if (!t || t === '—') return INFO_MUTED_;
  var up = t.charAt(0) === '+';
  var down = t.charAt(0) === '-';
  if (invert ? down : up) return INFO_GREEN_;
  if (invert ? up : down) return INFO_RED_;
  return INFO_MUTED_;
}

function infoColorGrowBlock_(sheet, startRow, n, invertL, invertR) {
  if (n < 1) return;
  var vals = sheet.getRange(startRow, 1, n, 12).getValues();
  var leftColors = [];
  var rightColors = [];
  var r;
  for (r = 0; r < n; r++) {
    var leftInv = invertL && invertL[r];
    var rightInv = invertR && invertR[r];
    leftColors.push([
      infoDeltaFontColor_(vals[r][4], leftInv),
      infoDeltaFontColor_(vals[r][5], leftInv)
    ]);
    rightColors.push([
      infoDeltaFontColor_(vals[r][10], rightInv),
      infoDeltaFontColor_(vals[r][11], rightInv)
    ]);
  }
  sheet.getRange(startRow, 5, n, 2).setFontColors(leftColors);
  sheet.getRange(startRow, 11, n, 2).setFontColors(rightColors);
}

function infoColorDeltaText_(sheet, row, col, invert) {
  var t = String(sheet.getRange(row, col).getValue() || '');
  sheet.getRange(row, col).setFontColor(infoDeltaFontColor_(t, invert));
}

function infoN_(v) {
  if (v == null || v === '') return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function infoDate_(v) {
  if (v == null || v === '') return '';
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.substring(8, 10) + '.' + s.substring(5, 7) + '.' + s.substring(0, 4);
  }
  return s;
}

function infoFbsStatusDup_(name) {
  var s = String(name || '').toLowerCase();
  return s === 'отсортировано' || s === 'ожидает' || s === 'sorted' || s === 'waiting';
}

function infoAvgPrice_(sum, qty) {
  var n = infoN_(qty);
  if (!n) return null;
  return infoN_(sum) / n;
}

function infoDelta_(cur, base) {
  var b = infoN_(base);
  if (!b) return '—';
  var p = (infoN_(cur) - b) / b;
  var sign = p > 0 ? '+' : '';
  return sign + (p * 100).toFixed(1) + '%';
}

function infoSupply_(rows, statusId, field) {
  var i;
  for (i = 0; i < rows.length; i++) {
    if (String(rows[i].status_id) === String(statusId)) return infoN_(rows[i][field]);
  }
  return 0;
}

function infoColorDeltaRow_(sheet, row, curs, bases) {
  var i;
  for (i = 0; i < curs.length; i++) {
    var col = 1 + i * 2;
    var b = infoN_(bases[i]);
    var c = infoN_(curs[i]);
    var invert = (i === 3 || i === 4);
    var tone = INFO_MUTED_;
    if (b) {
      if (invert ? c < b : c > b) tone = INFO_GREEN_;
      else if (invert ? c > b : c < b) tone = INFO_RED_;
    }
    sheet.getRange(row, col).setFontColor(tone);
  }
}
