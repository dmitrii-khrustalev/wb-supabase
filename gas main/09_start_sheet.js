var START_LOAD_NOTICE_KEY_ = 'START_LOAD_NOTICE';

function startSetLoadNotice_(notice) {
  var props = PropertiesService.getScriptProperties();
  if (!notice) props.deleteProperty(START_LOAD_NOTICE_KEY_);
  else props.setProperty(START_LOAD_NOTICE_KEY_, String(notice).substring(0, 120));
}

function startGetLoadNotice_() {
  return PropertiesService.getScriptProperties().getProperty(START_LOAD_NOTICE_KEY_) || '';
}

function startClearLoadNotice_() {
  startSetLoadNotice_('');
}

function startApplyLoadNotice_(sh) {
  // Предупреждения загрузки клиенту на start не показываем — только _Лог.
}

function startRepaintInfo_(sh) {
  if (!sh) return;
  var rows = startInfoRows_();
  var i;
  for (i = 0; i < rows.length; i++) startPaintInfo_(sh, rows[i]);
}

var START_SHEET_NAME_ = 'start';
var START_BOOK_ID_ = '1pWuewtGP6lGmXKJ8G0Ue6Yt0iXYNaSnO67u60ATz97I';
var START_FONT_ = 'Calibri';
var START_SIZE_ = 10;
var START_INK_ = '#222222';
var START_MUTED_ = '#666666';
var START_GREEN_ = '#1b7a3d';
var START_RED_ = '#b3261e';
var START_HEAD_BG_ = '#3d3d3d';
var START_HEAD_FG_ = '#ffffff';
var START_CARD_BG_ = '#f7f7f7';
var START_WARN_BG_ = '#f8e6e4';
var START_LINE_BG_ = '#f3f3f3';
var START_LOCKED_BG_ = '#e6e6e6';
var START_STATUS_ROW_ = 1;
var START_STATUS_COL_LEFT_ = 4;
var START_STATUS_COL_RIGHT_ = 11;
var START_STATUS_NCOLS_ = 6;
var START_STATUS_TAIL_HEADERS_ = ['🌐', 'Вкл', 'Дней', 'Период', 'Обновлено'];
var START_LAYOUT_KEY_ = 'START_STATUS_LAYOUT_V1';
var START_WIDTHS_KEY_ = 'START_COL_WIDTHS_V1';
var START_DEFAULT_WIDTHS_ = {
  1: 20, 2: 320, 3: 10, 4: 150, 5: 30, 6: 36, 7: 44, 8: 78, 9: 96, 10: 10,
  11: 128, 12: 30, 13: 36, 14: 44, 15: 78, 16: 96
};
var START_DASH_PREFIX_ = 'START_DASH_';
var START_DASH_ORDER_ = [
  'info daily',
  'info weekly',
  'info monthly',
  'sku',
  'sku all',
  'stock'
];

/** Группы сырья на start — как на сайте /sync. */
var START_SHEET_GROUPS_ = [
  {
    label: 'Базовые данные',
    sheets: [
      'Финансовые ежедневные', 'Рекламные расходы', 'Воронка продаж', 'Товары', 'История цен'
    ]
  },
  {
    label: 'FBW',
    sheets: ['Заказы FBW', 'Продажи FBW', 'Остатки FBW', 'Остатки ЛК', 'Поставки FBW']
  },
  {
    label: 'FBS',
    sheets: ['Заказы FBS', 'Остатки FBS', 'Поставки FBS', 'Склады FBS']
  },
  {
    label: 'Аналитика',
    sheets: [
      'Продажи по регионам', 'Возвраты товаров', 'Лента заказов', 'Отзывы', 'Вопросы',
      'Тарифы', 'Удержания WB', 'Складские услуги', 'Заявки на возврат', 'Акции'
    ]
  }
];

function writeStartSheet() {
  var ss = startBook_();
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh) sh = ss.insertSheet(START_SHEET_NAME_, 0);
  else ensureStartSheetFirst_(ss);
  sh.clear();
  try { sh.setTabColor('#5c6b73'); } catch (eT) {}
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 20);
  sh.setColumnWidth(2, 320);
  sh.setColumnWidth(3, 10);
  sh.setColumnWidth(10, 10);

  startRepaintInfo_(sh);

  refreshStartStatus_(ss, { full: true });
  sh.getRange('B1').activate();
}

function refreshStartStatus_(ss, opts) {
  opts = opts || {};
  ss = ss || startBook_();
  ensureStartSheetFirst_(ss);
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh) return;
  try { sh.setFrozenRows(1); } catch (eFr) {}
  try { sh.setFrozenColumns(0); } catch (eFc) {}

  var layout = startReadLayout_(ss);
  if (!opts.full && layout && startLayoutValid_(sh, layout)) {
    startUpdateStatusSoft_(ss, sh, layout);
    startRestoreColumnWidths_(sh);
    startRepaintInfo_(sh);
    startApplyLoadNotice_(sh);
    return;
  }

  startPaintStatusFull_(ss, sh);
  startRestoreColumnWidths_(sh);
  if (!startHasSavedWidths_(ss)) {
    startApplyDefaultColumnWidths_(sh);
    startCaptureColumnWidths_(sh);
  }
  startRepaintInfo_(sh);
  startApplyLoadNotice_(sh);
}

function startLayoutStorageKey_(ss, base) {
  return String(base) + '_' + (ss.getId ? ss.getId() : 'book');
}

function startReadLayout_(ss) {
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty(startLayoutStorageKey_(ss, START_LAYOUT_KEY_));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function startSaveLayout_(ss, layout) {
  PropertiesService.getDocumentProperties().setProperty(
    startLayoutStorageKey_(ss, START_LAYOUT_KEY_),
    JSON.stringify(layout || {})
  );
}

function startHasSavedWidths_(ss) {
  return !!PropertiesService.getDocumentProperties().getProperty(startLayoutStorageKey_(ss, START_WIDTHS_KEY_));
}

function startCaptureColumnWidths_(sh) {
  var ss = sh.getParent();
  var widths = {};
  var col;
  for (col = 1; col <= 16; col++) widths[String(col)] = sh.getColumnWidth(col);
  PropertiesService.getDocumentProperties().setProperty(
    startLayoutStorageKey_(ss, START_WIDTHS_KEY_),
    JSON.stringify(widths)
  );
}

function startRestoreColumnWidths_(sh) {
  var ss = sh.getParent();
  var raw = PropertiesService.getDocumentProperties().getProperty(startLayoutStorageKey_(ss, START_WIDTHS_KEY_));
  var widths = null;
  try { widths = raw ? JSON.parse(raw) : null; } catch (e) { widths = null; }
  if (!widths) {
    startApplyDefaultColumnWidths_(sh);
    return;
  }
  var col;
  for (col = 1; col <= 16; col++) {
    if (widths[String(col)] != null) sh.setColumnWidth(col, Number(widths[String(col)]));
  }
}

function startApplyDefaultColumnWidths_(sh) {
  var col;
  for (col = 1; col <= 16; col++) {
    if (START_DEFAULT_WIDTHS_[col] != null) sh.setColumnWidth(col, START_DEFAULT_WIDTHS_[col]);
  }
}

function startLayoutValid_(sh, layout) {
  if (!layout || !layout.rows || !layout.sections || !layout.sections.length) return false;
  var i;
  for (i = 0; i < layout.sections.length; i++) {
    var sec = layout.sections[i];
    if (!sec || !sec.row || !sec.col || !sec.label) return false;
    if (String(sh.getRange(sec.row, sec.col).getDisplayValue() || '').trim() !== sec.label) return false;
  }
  return true;
}

function startApplyStatusRowSoft_(sh, loc, ld) {
  if (!loc || !ld) return;
  var r = loc.row;
  var col0 = loc.col;
  var alt = loc.alt === true;

  startPaintAccessCell_(sh.getRange(r, col0 + 1), ld.access, ld.locked);
  sh.getRange(r, col0 + 2).setValue(ld.on);
  startPaintOnCell_(sh.getRange(r, col0 + 2), ld.on, ld.locked);
  sh.getRange(r, col0 + 3).setValue(ld.days);
  sh.getRange(r, col0 + 4).setValue(ld.period);
  sh.getRange(r, col0 + 5).setValue(ld.when);

  var bg = ld.locked ? START_LOCKED_BG_ : (alt ? START_LINE_BG_ : START_CARD_BG_);
  sh.getRange(r, col0, 1, START_STATUS_NCOLS_).setBackground(bg);
  sh.getRange(r, col0).setFontWeight('bold').setFontColor(ld.locked ? START_MUTED_ : START_INK_);

  var stale = startWhenIsStale_(ld.when, ld.on, ld.locked);
  if (ld.period === '—' || ld.when === '—') {
    sh.getRange(r, col0 + 4, 1, 2).setFontColor(START_MUTED_);
  } else if (stale) {
    sh.getRange(r, col0 + 5).setFontColor(START_RED_).setFontWeight('bold');
    sh.getRange(r, col0 + 4).setFontColor(START_INK_);
  } else {
    sh.getRange(r, col0 + 4, 1, 2).setFontColor(START_INK_);
  }
  if (stale) sh.getRange(r, col0 + 5).setBackground(START_WARN_BG_);
  if (ld.days === 'снимок' || ld.days === 'все' || ld.days === '—') {
    sh.getRange(r, col0 + 3).setFontColor(START_MUTED_).setFontWeight('normal').setHorizontalAlignment('left');
  } else {
    sh.getRange(r, col0 + 3).setFontColor(START_INK_).setFontWeight('bold').setHorizontalAlignment('center');
  }
}

function startUpdateStatusSoft_(ss, sh, layout) {
  var pack = startStatusSectionPacks_(ss);
  var groups = pack.left.concat(pack.right);
  var g;
  var i;
  for (g = 0; g < groups.length; g++) {
    var rows = groups[g].rows || [];
    for (i = 0; i < rows.length; i++) {
      var ld = rows[i];
      var loc = layout.rows[ld.sheet];
      if (loc) startApplyStatusRowSoft_(sh, loc, ld);
    }
  }
}

/** Мягко обновить 🌐 и статусы на start после «Обновить доступ» — без clear и без колонки B. */
function startRefreshAccessSoft_(ss) {
  ss = ss || startBook_();
  ensureStartSheetFirst_(ss);
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh) return;
  try { sh.setFrozenRows(1); } catch (eFr) {}
  var layout = startReadLayout_(ss);
  if (!layout || !startLayoutValid_(sh, layout)) {
    refreshStartStatus_(ss, { full: true });
    startRestoreColumnWidths_(sh);
    return;
  }
  startUpdateStatusSoft_(ss, sh, layout);
  startRestoreColumnWidths_(sh);
  startApplyLoadNotice_(sh);
}

function startTouchSheetStatus_(ss, sheetName) {
  ss = ss || startBook_();
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh || !sheetName) return;
  var layout = startReadLayout_(ss);
  if (!layout || !startLayoutValid_(sh, layout)) {
    refreshStartStatus_(ss, { full: true });
    layout = startReadLayout_(ss);
  }
  var loc = layout && layout.rows ? layout.rows[String(sheetName).trim()] : null;
  if (!loc) return;
  var settingsBy = startSettingsBySheet_(ss);
  var accessMap = startAccessMap_(ss);
  startApplyStatusRowSoft_(sh, loc, startBuildSheetStatus_(sheetName, settingsBy, accessMap));
}

function startTouchDashStatus_(ss, dashName) {
  ss = ss || startBook_();
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh || !dashName) return;
  var layout = startReadLayout_(ss);
  if (!layout || !startLayoutValid_(sh, layout)) {
    refreshStartStatus_(ss, { full: true });
    layout = startReadLayout_(ss);
  }
  var loc = layout && layout.rows ? layout.rows[String(dashName).trim()] : null;
  if (!loc) return;
  var rows = startDashStatusRows_();
  var i;
  for (i = 0; i < rows.length; i++) {
    if (rows[i].sheet === dashName) {
      startApplyStatusRowSoft_(sh, loc, rows[i]);
      return;
    }
  }
}

function writeStartDashboardStamp_(ss, sheetName, period, days) {
  var key = START_DASH_PREFIX_ + String(sheetName || '').trim();
  if (!key || key === START_DASH_PREFIX_) return;
  var when = typeof nowMsk_ === 'function'
    ? nowMsk_()
    : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
    period: String(period || '').replace(/\s+/g, ' ').trim(),
    days: String(days == null ? '' : days).trim(),
    when: startShortWhen_(when)
  }));
  try { startTouchDashStatus_(ss, sheetName); } catch (e) {}
}

function startBook_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e0) {}
  if (ss && ss.getSheetByName(START_SHEET_NAME_)) return ss;
  try {
    var opened = SpreadsheetApp.openById(START_BOOK_ID_);
    if (opened) return opened;
  } catch (e1) {}
  if (ss) return ss;
  if (typeof activeSpreadsheet_ === 'function') return activeSpreadsheet_();
  throw new Error('Нет доступа к книге');
}

function hasStartSheet_(ss) {
  ss = ss || startBook_();
  return !!ss.getSheetByName(START_SHEET_NAME_);
}

function ensureStartSheetFirst_(ss) {
  ss = ss || startBook_();
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh) return;
  if (ss.getSheets()[0].getName() === START_SHEET_NAME_) return;
  try {
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(1);
  } catch (e) {}
}

/** 0-based index for insertSheet when start may be first */
function startSheetInsertIndex_(ss, baseIndex) {
  baseIndex = Number(baseIndex) || 0;
  return hasStartSheet_(ss) ? baseIndex + 1 : baseIndex;
}

/** 1-based position for moveActiveSheet when start may be first */
function startSheetMovePos_(ss, basePos) {
  basePos = Number(basePos) || 1;
  return hasStartSheet_(ss) ? basePos + 1 : basePos;
}

function startInfoRows_() {
  return [
    { row: 1, kind: 'title', text: 'Информация' },
    { row: 2, kind: 'head', text: '⏰ Загрузка' },
    {
      row: 3, kind: 'body',
      text: 'Ночью — в базу. С 06:00 — в книгу.',
      marks: [{ t: '06:00', bold: true, color: START_GREEN_ }]
    },
    {
      row: 4, kind: 'body', alt: true,
      text: 'Сводки из базы; сырьё для них не нужно.',
      marks: [{ t: 'из базы', bold: true, color: START_GREEN_ }]
    },
    { row: 5, kind: 'gap' },
    { row: 6, kind: 'head', text: '📊 Сводки' },
    {
      row: 7, kind: 'body',
      text: 'info — день / нед / мес (нед. пн–вс).',
      marks: [{ t: 'info', bold: true, underline: true }]
    },
    {
      row: 8, kind: 'body', alt: true,
      text: 'stock — остаток, утром сам.',
      marks: [{ t: 'stock', bold: true, underline: true }]
    },
    {
      row: 9, kind: 'body',
      text: 'sku — из меню, утром сам не считается.',
      marks: [{ t: 'sku', bold: true, underline: true, at: 0 }]
    },
    { row: 10, kind: 'gap' },
    { row: 11, kind: 'head', text: '📒 Сырьё' },
    {
      row: 12, kind: 'body',
      text: 'Окно последних дней. Утро перезапишет.',
      marks: [{ t: 'Утро перезапишет', bold: true }]
    },
    {
      row: 13, kind: 'body', alt: true,
      text: 'Скрыть: меню → Листы данных.',
      marks: [{ t: 'Листы данных', bold: true, underline: true }]
    },
    { row: 14, kind: 'gap' },
    { row: 15, kind: 'head', text: '🔄 Меню' },
    {
      row: 16, kind: 'body',
      text: 'Загрузить всё — ~6 мин, дальше само.',
      marks: [{ t: 'Загрузить всё', bold: true, underline: true, color: START_GREEN_ }]
    },
    {
      row: 17, kind: 'body', alt: true,
      text: 'Один лист — только он. Сервис → Остановить загрузку.',
      marks: [{ t: 'Остановить загрузку', bold: true, underline: true, color: START_RED_ }]
    },
    { row: 18, kind: 'gap' },
    { row: 19, kind: 'head', text: '⚠ Важно' },
    {
      row: 20, kind: 'warn',
      text: '«Кабинет» не менять.',
      marks: [{ t: '«Кабинет»', bold: true, color: START_RED_ }]
    },
    {
      row: 21, kind: 'warn', alt: true,
      text: 'Застряло — Загрузить всё или _Лог.',
      marks: [{ t: '_Лог', bold: true, underline: true }]
    },
    {
      row: 22, kind: 'warn',
      text: 'info / sku / stock руками не трогать.',
      marks: [{ t: 'не трогать', bold: true, color: START_RED_ }]
    },
    {
      row: 23, kind: 'warn', alt: true,
      text: 'Полная перезагрузка сносит сырьё. Москва.',
      marks: [{ t: 'Полная перезагрузка', bold: true, underline: true, color: START_RED_ }]
    }
  ];
}

function startPaintInfo_(sh, spec) {
  var cell = sh.getRange(spec.row, 2);
  cell.clearFormat();
  cell.setFontFamily(START_FONT_).setFontSize(START_SIZE_)
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('left')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  if (spec.kind === 'gap') {
    cell.setValue('').setBackground('#ffffff');
    sh.setRowHeight(spec.row, 12);
    return;
  }
  if (spec.kind === 'title' || spec.kind === 'head') {
    cell.setValue(spec.text)
      .setBackground(START_HEAD_BG_)
      .setFontColor(START_HEAD_FG_)
      .setFontWeight('bold');
    sh.setRowHeight(spec.row, spec.kind === 'title' ? 28 : 24);
    return;
  }
  var bg = spec.kind === 'warn'
    ? (spec.alt ? '#f3d9d6' : START_WARN_BG_)
    : (spec.alt ? START_LINE_BG_ : START_CARD_BG_);
  cell.setBackground(bg).setFontColor(START_INK_).setFontWeight('normal');
  cell.setRichTextValue(startRich_(spec.text, spec.marks || []));
  sh.setRowHeight(spec.row, 22);
}

function startClearStatusArea_(sh, col0, startRow, numRows) {
  var range = sh.getRange(startRow, col0, numRows, START_STATUS_NCOLS_);
  try { range.breakApart(); } catch (eBreak) {}
  range.clearContent().clearFormat();
}

function startPaintStatusFull_(ss, sh) {
  var startRow = START_STATUS_ROW_;
  var numClear = Math.max(1, Math.max(sh.getLastRow(), startRow + 120) - startRow + 1);
  startClearStatusArea_(sh, START_STATUS_COL_LEFT_, startRow, numClear);
  startClearStatusArea_(sh, START_STATUS_COL_RIGHT_, startRow, numClear);

  var pack = startStatusSectionPacks_(ss);
  var layout = { v: 1, rows: {}, sections: [] };
  startPaintStatusColumn_(sh, pack.left, START_STATUS_COL_LEFT_, startRow, layout);
  startPaintStatusColumn_(sh, pack.right, START_STATUS_COL_RIGHT_, startRow, layout);
  startSaveLayout_(ss, layout);
}

function startPaintStatusColumn_(sh, sections, col0, startRow, layout) {
  var row = startRow;
  var s;
  for (s = 0; s < sections.length; s++) {
    row = startPaintStatusSection_(sh, sections[s], row, col0, START_STATUS_NCOLS_, layout);
    if (s < sections.length - 1) {
      sh.setRowHeight(row, 8);
      row++;
    }
  }
  return row;
}

function startPaintStatusSection_(sh, section, row, col0, ncols, layout) {
  layout.sections.push({ label: section.label, row: row, col: col0 });
  var hdrLabels = [section.label].concat(START_STATUS_TAIL_HEADERS_);
  var hdr = sh.getRange(row, col0, 1, ncols);
  hdr.setValues([hdrLabels])
    .setFontFamily(START_FONT_).setFontSize(START_SIZE_)
    .setFontWeight('bold')
    .setFontColor(START_HEAD_FG_)
    .setBackground(START_HEAD_BG_)
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sh.getRange(row, col0 + 1).setHorizontalAlignment('center');
  sh.setRowHeight(row, 22);
  row++;

  var rows = section.rows || [];
  if (!rows.length) return row;

  var values = [];
  var i;
  for (i = 0; i < rows.length; i++) {
    values.push([
      rows[i].sheet,
      startAccessGlyph_(rows[i].access, rows[i].locked),
      rows[i].on,
      rows[i].days,
      rows[i].period,
      rows[i].when
    ]);
  }
  var body = sh.getRange(row, col0, rows.length, ncols);
  body.setValues(values)
    .setFontFamily(START_FONT_).setFontSize(START_SIZE_)
    .setFontWeight('normal')
    .setFontColor(START_INK_)
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  for (i = 0; i < rows.length; i++) {
    var r = row + i;
    var ld = rows[i];
    layout.rows[ld.sheet] = { row: r, col: col0, alt: alt };
    var alt = i % 2 === 1;
    var bg = ld.locked ? START_LOCKED_BG_ : (alt ? START_LINE_BG_ : START_CARD_BG_);
    sh.getRange(r, col0, 1, ncols).setBackground(bg);
    sh.getRange(r, col0).setFontWeight('bold');
    if (ld.locked) sh.getRange(r, col0).setFontColor(START_MUTED_);

    startPaintAccessCell_(sh.getRange(r, col0 + 1), ld.access, ld.locked);
    startPaintOnCell_(sh.getRange(r, col0 + 2), ld.on, ld.locked);

    if (ld.period === '—' || ld.when === '—') {
      sh.getRange(r, col0 + 4, 1, 2).setFontColor(START_MUTED_);
    }
    if (ld.days === 'снимок' || ld.days === 'все' || ld.days === '—') {
      sh.getRange(r, col0 + 3).setFontColor(START_MUTED_);
    } else {
      sh.getRange(r, col0 + 3).setFontWeight('bold').setHorizontalAlignment('center');
    }
    sh.setRowHeight(r, 22);
  }
  return row + rows.length;
}

function startAccessGlyph_(access, locked) {
  if (access === '—') return '—';
  if (locked || access === 'нет') return '🔒';
  if (access === 'да') return '✓';
  return '—';
}

function startPaintAccessCell_(cell, access, locked) {
  cell.setValue(startAccessGlyph_(access, locked));
  cell.setHorizontalAlignment('center').setFontWeight('bold');
  if (locked || access === 'нет') {
    cell.setFontColor(START_MUTED_);
  } else if (access === 'да') {
    cell.setFontColor(START_GREEN_);
  } else {
    cell.setFontColor(START_MUTED_);
  }
}

function startPaintOnCell_(cell, on, locked) {
  cell.setFontWeight('bold');
  if (locked) {
    cell.setFontColor(START_MUTED_);
  } else {
    cell.setFontColor(on === 'да' ? START_GREEN_ : (on === 'нет' ? START_RED_ : START_MUTED_));
  }
}

function startStatusSectionPacks_(ss) {
  var settingsBy = startSettingsBySheet_(ss);
  var accessMap = startAccessMap_(ss);
  return {
    left: [
      { label: 'Базовые данные', rows: startSheetStatusRows_(settingsBy, accessMap, START_SHEET_GROUPS_[0].sheets) },
      { label: 'FBW', rows: startSheetStatusRows_(settingsBy, accessMap, START_SHEET_GROUPS_[1].sheets) },
      { label: 'FBS', rows: startSheetStatusRows_(settingsBy, accessMap, START_SHEET_GROUPS_[2].sheets) }
    ],
    right: [
      { label: 'Отчеты', rows: startDashStatusRows_() },
      { label: 'Аналитика', rows: startSheetStatusRows_(settingsBy, accessMap, START_SHEET_GROUPS_[3].sheets) }
    ]
  };
}

function startAccessMap_(ss) {
  try {
    if (typeof readDatasetAccessCache_ === 'function') return readDatasetAccessCache_() || {};
    if (typeof fetchDatasetAccessMap_ === 'function') return fetchDatasetAccessMap_();
  } catch (eAcc) {}
  return {};
}

function startSettingsBySheet_(ss) {
  var by = {};
  var sh = ss.getSheetByName(typeof SETTINGS_SHEET !== 'undefined' ? SETTINGS_SHEET : '_Настройки');
  if (!sh || sh.getLastRow() < 2) return by;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
  var i;
  for (i = 0; i < vals.length; i++) {
    var name = String(vals[i][0] || '').trim();
    if (!name) continue;
    var days = String(vals[i][3] == null ? '' : vals[i][3]).trim();
    if (!days) days = 'все';
    by[name] = {
      on: (typeof isEnabled_ === 'function' ? isEnabled_(vals[i][4]) : String(vals[i][4]).toLowerCase() === 'да') ? 'да' : 'нет',
      days: days,
      period: startShortDateText_(String(vals[i][9] || '').replace(/\s+/g, ' ').trim()),
      when: startShortWhen_(vals[i][10])
    };
  }
  return by;
}

function startSheetStatusRows_(by, accessMap, sheetNames) {
  var out = [];
  var i;
  for (i = 0; i < sheetNames.length; i++) {
    out.push(startBuildSheetStatus_(sheetNames[i], by, accessMap));
  }
  return out;
}

function startBuildSheetStatus_(sheetName, by, accessMap) {
  var rec = by[sheetName] || { on: 'нет', days: 'все', period: '', when: '—' };
  var allowed = typeof isSheetAccessAllowed_ === 'function'
    ? isSheetAccessAllowed_(sheetName, accessMap)
    : true;
  return {
    sheet: sheetName,
    access: allowed ? 'да' : 'нет',
    on: rec.on || 'нет',
    days: allowed ? (rec.days || 'все') : '—',
    period: allowed ? (rec.period || '—') : '—',
    when: allowed ? (rec.when || '—') : '—',
    locked: !allowed
  };
}

function startDashStatusRows_() {
  var props = PropertiesService.getScriptProperties();
  var out = [];
  var i;
  for (i = 0; i < START_DASH_ORDER_.length; i++) {
    var sheet = START_DASH_ORDER_[i];
    var raw = props.getProperty(START_DASH_PREFIX_ + sheet);
    var rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
    out.push({
      sheet: sheet,
      access: '—',
      on: rec && rec.when && rec.when !== '—' ? 'да' : '—',
      days: (rec && rec.days) ? rec.days : '—',
      period: startShortDateText_((rec && rec.period) ? rec.period : '—'),
      when: startShortDateText_((rec && rec.when) ? rec.when : '—'),
      locked: false
    });
  }
  return out;
}

function startShortDateText_(s) {
  return String(s == null ? '' : s).replace(/\b(\d{2}\.\d{2}\.)(\d{4})\b/g, function (_all, dmy, y) {
    return dmy + y.slice(-2);
  });
}

function startWhenIsStale_(whenText, onText, locked) {
  if (locked || String(onText || '').toLowerCase() !== 'да') return false;
  var day = startParseRuDay_(String(whenText || '').replace(/.*(\d{2}\.\d{2}\.\d{2,4}).*/, '$1'));
  if (!day) return false;
  var today = typeof mskToday_ === 'function' ? mskToday_() : '';
  if (!today) return false;
  var y = day.getFullYear();
  var m = ('0' + (day.getMonth() + 1)).slice(-2);
  var d = ('0' + day.getDate()).slice(-2);
  return (y + '-' + m + '-' + d) < today;
}

function startShortWhen_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '—';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(
      v,
      typeof TZ !== 'undefined' ? TZ : Session.getScriptTimeZone(),
      'dd.MM.yy HH:mm'
    );
  }
  var m = s.match(/^(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/);
  if (m) return startShortDateText_(m[1]);
  return startShortDateText_(s.replace(/\s+/g, ' '));
}

function startDaysBetweenRu_(fromRu, toRu) {
  var a = startParseRuDay_(fromRu);
  var b = startParseRuDay_(toRu);
  if (!a || !b) return '—';
  var n = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
  return n > 0 ? String(n) : '—';
}

function startDaysFromPeriod_(period) {
  var s = String(period || '').trim();
  if (!s || s === '—') return '—';
  if (/^на\s/i.test(s)) return 'снимок';
  var m = s.match(/с\s+(\d{2}\.\d{2}\.\d{2,4})\s+по\s+(\d{2}\.\d{2}\.\d{2,4})/);
  if (m) return startDaysBetweenRu_(m[1], m[2]);
  return '1';
}

function startParseRuDay_(s) {
  var p = String(s || '').split('.');
  if (p.length !== 3) return null;
  var y = Number(p[2]);
  if (p[2].length === 2) y = 2000 + y;
  var d = new Date(y, Number(p[1]) - 1, Number(p[0]));
  return isNaN(d.getTime()) ? null : d;
}

function refreshStartSheetMenu_() {
  var ss = startBook_();
  var sh = ss.getSheetByName(START_SHEET_NAME_);
  if (!sh) {
    writeStartSheet();
    return;
  }
  startCaptureColumnWidths_(sh);
  refreshStartStatus_(ss, { full: true });
  startRestoreColumnWidths_(sh);
  try {
    SpreadsheetApp.getUi().alert('Лист start обновлён.');
  } catch (e) {}
}

function startFitWidths_(sh) {
  startApplyDefaultColumnWidths_(sh);
  startCaptureColumnWidths_(sh);
}

function startRich_(text, marks) {
  var base = SpreadsheetApp.newTextStyle()
    .setFontFamily(START_FONT_)
    .setFontSize(START_SIZE_)
    .setForegroundColor(START_INK_)
    .setBold(false)
    .setUnderline(false)
    .build();
  var b = SpreadsheetApp.newRichTextValue().setText(text).setTextStyle(base);
  var used = {};
  var i;
  for (i = 0; i < marks.length; i++) {
    var m = marks[i];
    var from = m.at != null ? Number(m.at) : text.indexOf(m.t);
    if (from < 0) continue;
    var key = from + ':' + m.t;
    if (used[key]) continue;
    used[key] = 1;
    var st = SpreadsheetApp.newTextStyle()
      .setFontFamily(START_FONT_)
      .setFontSize(START_SIZE_)
      .setBold(!!m.bold)
      .setUnderline(!!m.underline)
      .setForegroundColor(m.color || START_INK_)
      .build();
    b = b.setTextStyle(from, from + m.t.length, st);
  }
  return b.build();
}
