/**
 * Лист «Заполненность» — снимок, сколько непустых ячеек на каждом листе.
 * Как в project_java: дата справа, повтор в тот же день перезаписывает столбец,
 * прирост % и кол-во к предыдущей дате. Сам лист в подсчёт не входит.
 */

var FILLED_CELLS_REPORT_SHEET = 'Заполненность';

function countFilledCellsOnly() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = typeof TZ !== 'undefined' ? TZ : (Session.getScriptTimeZone() || 'Europe/Moscow');
  var stampDate = new Date();
  var todayKey = filledDayKey_(stampDate);

  var current = {};
  var currentNames = [];
  var sheets = ss.getSheets();
  var i;
  for (i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var name = sh.getName();
    if (name === FILLED_CELLS_REPORT_SHEET) continue;
    current[name] = countFilledOnSheet_(sh);
    currentNames.push(name);
  }

  var report = ss.getSheetByName(FILLED_CELLS_REPORT_SHEET);
  if (!report) report = ss.insertSheet(FILLED_CELLS_REPORT_SHEET);
  try {
    ss.setActiveSheet(report);
    ss.moveActiveSheet(ss.getSheets().length);
  } catch (e) {}

  var hist = filledReadHistory_(report);
  var names = hist.names.slice();
  var seen = {};
  var n;
  for (n = 0; n < names.length; n++) seen[names[n]] = true;
  var c;
  for (c = 0; c < currentNames.length; c++) {
    if (!seen[currentNames[c]]) {
      names.push(currentNames[c]);
      seen[currentNames[c]] = true;
    }
  }

  var overwrite = false;
  if (hist.dates.length) {
    overwrite = filledDayKey_(hist.dates[hist.dates.length - 1]) === todayKey;
  }

  var dateHeaders = [];
  var d;
  for (d = 0; d < hist.dates.length; d++) {
    if (overwrite && d === hist.dates.length - 1) dateHeaders.push(stampDate);
    else dateHeaders.push(filledHeaderDate_(hist.dates[d]));
  }
  if (!overwrite) dateHeaders.push(stampDate);
  var dateCount = dateHeaders.length;

  var output = [['Лист'].concat(dateHeaders, ['прирост %', 'прирост кол-во'])];
  var total = 0;
  var r;
  for (r = 0; r < names.length; r++) {
    var sheetName = names[r];
    var prev = hist.grid[sheetName] || [];
    var row = [sheetName];
    var lastHist = overwrite ? hist.dates.length - 1 : hist.dates.length;
    for (d = 0; d < lastHist; d++) {
      var oldVal = prev[d];
      row.push(oldVal === '' || oldVal == null ? 0 : oldVal);
    }
    var nowVal = current.hasOwnProperty(sheetName) ? current[sheetName] : 0;
    var prevVal = 0;
    if (row.length >= 2) prevVal = Number(row[row.length - 1]) || 0;
    row.push(nowVal);
    if (dateCount >= 2) {
      row.push(filledPct_(prevVal, nowVal));
      row.push(nowVal - prevVal);
    } else {
      row.push('', '');
    }
    total += nowVal;
    output.push(row);
  }
  var oldTotals = filledTotals_(hist, names);
  if (overwrite && oldTotals.length) oldTotals = oldTotals.slice(0, oldTotals.length - 1);
  var prevTotal = oldTotals.length ? Number(oldTotals[oldTotals.length - 1]) || 0 : 0;
  if (dateCount >= 2) {
    output.push(['ИТОГО'].concat(oldTotals, [total], [filledPct_(prevTotal, total), total - prevTotal]));
  } else {
    output.push(['ИТОГО'].concat(oldTotals, [total], ['', '']));
  }

  var width = dateCount + 3;
  report.clear();
  report.getRange(1, 1, output.length, width).setValues(output);
  applyBookFont_(report.getRange(1, 1, output.length, width));

  report.setFrozenRows(1);
  report.setFrozenColumns(1);
  report.getRange(1, 1, 1, width)
    .setFontWeight('bold')
    .setBackground('#f1f1f1')
    .setHorizontalAlignment('center')
    .setWrap(true);
  report.setRowHeight(1, 36);
  report.setColumnWidth(1, 220);
  if (dateCount >= 1) {
    report.getRange(1, 2, 1, dateCount).setNumberFormat('dd.MM.yyyy');
    report.getRange(2, 2, output.length - 1, dateCount).setNumberFormat('#,##0');
    for (var col = 2; col <= dateCount + 1; col++) report.setColumnWidth(col, 100);
  }
  report.setColumnWidth(dateCount + 2, 95);
  report.setColumnWidth(dateCount + 3, 115);
  if (output.length > 1) {
    report.getRange(2, dateCount + 2, output.length - 1, 1).setNumberFormat('0.00%');
    report.getRange(2, dateCount + 3, output.length - 1, 1).setNumberFormat('+#,##0;-#,##0;0');
  }
  report.getRange(output.length, 1, 1, width).setFontWeight('bold').setBackground('#e8e8e8');
  filledColorGrowth_(report, output.length, dateCount);
  var filter = report.getFilter();
  if (filter) filter.remove();
  report.getRange(1, 1, output.length, width).createFilter();

  var stamp = Utilities.formatDate(stampDate, tz, 'dd.MM.yyyy');
  var msg = 'Заполненность: ' + stamp +
    '\nЛистов сейчас: ' + currentNames.length +
    '\nИтого ячеек: ' + total;
  try { SpreadsheetApp.getUi().alert(msg); } catch (e2) { Logger.log(msg); }
}

function countFilledOnSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return 0;
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var n = 0;
  var r;
  var c;
  for (r = 0; r < values.length; r++) {
    var row = values[r];
    for (c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) n++;
    }
  }
  return n;
}

function filledHeaderDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  var str = String(value || '').trim();
  if (!str) return value;
  var ru = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (ru) {
    return new Date(
      Number(ru[3]),
      Number(ru[2]) - 1,
      Number(ru[1]),
      Number(ru[4] || 0),
      Number(ru[5] || 0),
      Number(ru[6] || 0)
    );
  }
  if (typeof parseDateString_ === 'function') {
    var parsed = parseDateString_(str);
    if (parsed) return parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    var iso = new Date(str);
    if (!isNaN(iso.getTime())) return iso;
  }
  return value;
}

function filledDayKey_(value) {
  var d = filledHeaderDate_(value);
  var tz = typeof TZ !== 'undefined' ? TZ : (Session.getScriptTimeZone() || 'Europe/Moscow');
  if (!(d instanceof Date) || isNaN(d.getTime())) return String(value || '');
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function filledReadHistory_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { names: [], dates: [], grid: {} };

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headerRow = 0;
  var a0 = String(values[0][0] || '').trim().toLowerCase();
  if (a0 === 'обновлено') headerRow = 1;

  var headers = values[headerRow] || [];
  var dates = [];
  var dateCols = [];
  var c;
  for (c = 1; c < headers.length; c++) {
    var h = String(headers[c] || '').trim().toLowerCase();
    if (!h) continue;
    if (h.indexOf('прирост') === 0) continue;
    dates.push(headers[c]);
    dateCols.push(c);
  }

  var names = [];
  var grid = {};
  var r;
  for (r = headerRow + 1; r < values.length; r++) {
    var name = String(values[r][0] || '').trim();
    if (!name) continue;
    var upper = name.toUpperCase();
    if (upper === 'ИТОГО' || upper === 'ИТОГО:') continue;
    names.push(name);
    var rowVals = [];
    for (var d = 0; d < dateCols.length; d++) {
      var v = values[r][dateCols[d]];
      rowVals.push(v === '' || v == null ? 0 : v);
    }
    grid[name] = rowVals;
  }
  return { names: names, dates: dates, grid: grid };
}

function filledPct_(prev, now) {
  prev = Number(prev) || 0;
  now = Number(now) || 0;
  if (prev === 0) return now === 0 ? 0 : '';
  return (now - prev) / prev;
}

function filledTotals_(hist, names) {
  var totals = [];
  var d;
  for (d = 0; d < hist.dates.length; d++) {
    var sum = 0;
    var i;
    for (i = 0; i < names.length; i++) {
      var row = hist.grid[names[i]] || [];
      var v = Number(row[d]);
      if (!isNaN(v)) sum += v;
    }
    totals.push(sum);
  }
  return totals;
}

function filledColorGrowth_(sheet, rowCount, dateCount) {
  if (dateCount < 2 || rowCount < 3) return;
  var lastCol = dateCount + 1;
  var prevCol = dateCount;
  var pctCol = dateCount + 2;
  var qtyCol = dateCount + 3;
  var dataRows = rowCount - 1;
  if (dataRows < 1) return;

  var lastVals = sheet.getRange(2, lastCol, dataRows, 1).getValues();
  var prevVals = sheet.getRange(2, prevCol, dataRows, 1).getValues();
  var colors = [];
  var i;
  for (i = 0; i < dataRows; i++) {
    var now = Number(lastVals[i][0]) || 0;
    var prev = Number(prevVals[i][0]) || 0;
    var color = null;
    if (now === 0 && prev > 0) color = '#f4cccc';
    else if (now > prev) color = '#d9ead3';
    else if (now < prev) color = '#fce5cd';
    colors.push([color]);
  }
  sheet.getRange(2, lastCol, dataRows, 1).setBackgrounds(colors);
  sheet.getRange(2, pctCol, dataRows, 1).setBackgrounds(colors);
  sheet.getRange(2, qtyCol, dataRows, 1).setBackgrounds(colors);
}
