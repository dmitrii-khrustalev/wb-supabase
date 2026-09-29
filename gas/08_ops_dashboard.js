/**
 * Лист stock. Спрос — последние 7 полных дней, остатки — снимок.
 * Меню «stock». Утро обновляет лист, если он уже есть (до сырья на листы).
 * Старый лист «чинить» удаляется при открытии книги и при пересчёте stock.
 * Старое имя вкладки «остатки» переименовывается в stock.
 */

var OPS_FIX_SHEET_ = 'чинить';
var OPS_STOCK_SHEET_ = 'stock';
var OPS_STOCK_OLD_ = 'остатки';
var OPS_TAB_STOCK_ = '#5c6b73';
var OPS_STOCK_COLS_ = 14;

function opsRemoveFixSheet_(ss) {
  ss = ss || (typeof activeSpreadsheet_ === 'function' ? activeSpreadsheet_() : SpreadsheetApp.getActiveSpreadsheet());
  if (!ss) return;
  var sh = ss.getSheetByName(OPS_FIX_SHEET_);
  if (!sh || ss.getSheets().length < 2) return;
  try { ss.deleteSheet(sh); } catch (e) {}
}

function opsEnsureStockName_(ss) {
  ss = ss || (typeof activeSpreadsheet_ === 'function' ? activeSpreadsheet_() : SpreadsheetApp.getActiveSpreadsheet());
  if (!ss) return;
  var neu = ss.getSheetByName(OPS_STOCK_SHEET_);
  var old = ss.getSheetByName(OPS_STOCK_OLD_);
  if (old && !neu) {
    try { old.setName(OPS_STOCK_SHEET_); } catch (e) {}
    return;
  }
  if (old && neu && old.getSheetId() !== neu.getSheetId()) {
    if (ss.getSheets().length < 2) return;
    try { ss.deleteSheet(old); } catch (e2) {}
  }
}

/** Старый пункт меню: удаляет лист «чинить», если он ещё есть. */
function runOpsFixDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  opsRemoveFixSheet_(ss);
  try {
    SpreadsheetApp.getUi().alert('Отчёт «чинить» убран. Смотрите лист stock.');
  } catch (e) {}
}

function runOpsStockDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  try {
    opsRemoveFixSheet_(ss);
    opsEnsureStockName_(ss);
    var data = opsFetch_(ss);
    var n = opsWriteStock_(ss, data);
    var ms = Date.now() - t0;
    if (typeof reportLog_ === 'function') reportLog_(ss, OPS_STOCK_SHEET_, 'отчёт', n, '', ms);
    if (typeof infoNotifyDone_ === 'function') {
      infoNotifyDone_(OPS_STOCK_SHEET_, ms);
    } else {
      SpreadsheetApp.getUi().alert(OPS_STOCK_SHEET_ + ': выгрузка завершена');
    }
  } catch (err) {
    if (typeof reportLog_ === 'function') reportLog_(ss, OPS_STOCK_SHEET_, 'ошибка', 0, String(err), Date.now() - t0);
    try { SpreadsheetApp.getUi().alert('«' + OPS_STOCK_SHEET_ + '»: ' + err); } catch (e1) {}
  }
}

function runOpsDashboardSilent_(ss) {
  if (!ss) return 0;
  opsRemoveFixSheet_(ss);
  opsEnsureStockName_(ss);
  var wantStk = ss.getSheetByName(OPS_STOCK_SHEET_);
  if (!wantStk) return 0;
  var data = opsFetch_(ss);
  return opsWriteStock_(ss, data);
}

function opsFetch_(ss) {
  if (typeof reportEnsureMoscowTz_ === 'function') reportEnsureMoscowTz_(ss);
  var slug = typeof reportSellerSlug_ === 'function' ? reportSellerSlug_(ss) : 'main';
  var sellerId = resolveSellerId_(slug);
  var data = skuRpc_(sellerId, 'report_ops_now', { p_seller_id: sellerId });
  if (!data) throw new Error('RPC report_ops_now вернул пусто');
  data.slug = slug;
  return data;
}

function opsResetSheet_(sheet, minCols, tabColor) {
  try { if (sheet.getFilter()) sheet.getFilter().remove(); } catch (eF) {}
  var rows = Math.max(sheet.getMaxRows(), 40);
  if (sheet.getMaxColumns() < minCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), minCols - sheet.getMaxColumns());
  }
  try { sheet.getRange(1, 1, rows, sheet.getMaxColumns()).breakApart(); } catch (eB) {}
  sheet.clear();
  try { sheet.setHiddenGridlines(true); } catch (eG) {}
  try { sheet.setTabColor(tabColor); } catch (eT) {}
}

function opsWriteStock_(ss, data) {
  opsEnsureStockName_(ss);
  var sheet = ss.getSheetByName(OPS_STOCK_SHEET_);
  if (!sheet) sheet = ss.insertSheet(OPS_STOCK_SHEET_, startSheetInsertIndex_(ss, 5));
  opsResetSheet_(sheet, OPS_STOCK_COLS_, OPS_TAB_STOCK_);
  var built = opsBuildStock_(data);
  sheet.getRange(1, 1, built.values.length, OPS_STOCK_COLS_).setValues(built.values);
  opsApplyStockLayout_(sheet, built);
  var period = (typeof infoRange_ === 'function')
    ? infoRange_(data.from, data.to)
    : String(data.from || '');
  writeStartDashboardStamp_(ss, OPS_STOCK_SHEET_, period, '7');
  return built.n;
}

function opsBuildStock_(data) {
  var list = data.stocks || [];
  var cab = data.cab || {};
  var rows = [];
  var snap = [];
  if (data.snap_fbo) snap.push('FBW ' + (typeof infoDate_ === 'function' ? infoDate_(data.snap_fbo) : data.snap_fbo));
  if (data.snap_fbs) snap.push('FBS ' + (typeof infoDate_ === 'function' ? infoDate_(data.snap_fbs) : data.snap_fbs));
  var period = (typeof infoRange_ === 'function')
    ? infoRange_(data.from, data.to)
    : String(data.from || '');
  rows.push([
    'STOCK', period, 'покрытие от заказов 7д',
    'обновлено', data.updated_at || '',
    snap.join(' · '), '', '', '', '', '', '', '', ''
  ]);
  var coverN = { 'нет при спросе': 0, 'кончится': 0, 'мало': 0, 'норма': 0, 'лежит': 0, 'нет спроса': 0 };
  var i;
  for (i = 0; i < list.length; i++) {
    var key = String(list[i].cover || '');
    if (coverN[key] != null) coverN[key] += 1;
  }
  rows.push([
    'FBW ' + infoN_(cab.fbo),
    'FBS ' + infoN_(cab.fbs),
    'нет при спросе ' + coverN['нет при спросе'],
    'кончится ' + coverN['кончится'],
    'мало ' + coverN['мало'],
    'норма ' + coverN['норма'],
    'лежит ' + coverN['лежит'],
    'нет спроса ' + coverN['нет спроса'],
    '', '', '', '', '', ''
  ]);
  rows.push([
    'Артикул', 'Название', 'nm_id',
    'FBW', 'FBS', 'Всего',
    'В пути к', 'В пути от',
    'Зак./день', 'Дней', 'Покрытие',
    'Склады FBW', 'Поставка шт', 'Статус поставки'
  ]);
  for (i = 0; i < list.length; i++) {
    var r = list[i];
    rows.push([
      r.sa_name || '',
      r.title || '',
      r.nm_id || '',
      infoN_(r.fbo),
      infoN_(r.fbs),
      infoN_(r.stock),
      infoN_(r.in_way_to),
      infoN_(r.in_way_from),
      infoN_(r.per_day),
      r.days == null ? '' : infoN_(r.days),
      r.cover || '—',
      r.warehouses || '',
      infoN_(r.supply_qty),
      r.supply_status || ''
    ]);
  }
  return { values: rows, n: list.length };
}

function opsApplyStockLayout_(sheet, built) {
  var lastRow = built.values.length;
  var lastCol = OPS_STOCK_COLS_;
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
    .setFontSize(9);
  sheet.getRange(3, 1, 1, lastCol)
    .setBackground(INFO_LABEL_BG_)
    .setFontWeight('bold')
    .setFontSize(9);
  if (built.n > 0) {
    sheet.getRange(4, 4, lastRow - 3, 5).setNumberFormat('#,##0');
    sheet.getRange(4, 9, lastRow - 3, 1).setNumberFormat('0.00');
    sheet.getRange(4, 10, lastRow - 3, 1).setNumberFormat('0.0');
    sheet.getRange(4, 13, lastRow - 3, 1).setNumberFormat('#,##0');
    var covers = sheet.getRange(4, 11, lastRow - 3, 1).getValues();
    var bgs = [];
    var tones = [];
    var i;
    var k;
    for (i = 0; i < covers.length; i++) {
      var cover = String(covers[i][0] || '');
      var stripe = i % 2 === 1 ? INFO_LINE_BG_ : '#ffffff';
      var rowBg = [];
      for (k = 0; k < lastCol; k++) rowBg.push(stripe);
      var tone = INFO_MUTED_;
      if (cover === 'нет при спросе' || cover === 'кончится') {
        rowBg[10] = INFO_BAD_;
        tone = INFO_RED_;
      } else if (cover === 'мало') {
        tone = INFO_RED_;
      } else if (cover === 'норма') {
        rowBg[10] = INFO_OK_;
        tone = INFO_GREEN_;
      } else if (cover === 'лежит') {
        tone = INFO_MUTED_;
      }
      bgs.push(rowBg);
      tones.push([tone]);
    }
    sheet.getRange(4, 1, lastRow - 3, lastCol).setBackgrounds(bgs);
    sheet.getRange(4, 11, lastRow - 3, 1).setFontColors(tones).setFontWeight('bold');
    sheet.getRange(3, 1, lastRow - 2, lastCol).createFilter();
  }
  var w = [120, 220, 90, 60, 60, 60, 70, 70, 70, 55, 110, 220, 80, 140];
  var c;
  for (c = 0; c < w.length; c++) sheet.setColumnWidth(c + 1, w[c]);
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(2);
  sheet.setRowHeight(1, 28);
}
