/**
 * Обезличивание демо-строк в книге (по 2 строки на листах с сырьём).
 * В демо-книге меню «Данные WB» содержит только этот пункт.
 */

var DEMO_BOOK_ID_ = '1frJmDHX5zs4cqxR8mMKuZlsZ54i2JF229rduZH-qrso';

var DEMO_SKIP_SHEETS_ = {
  start: 1,
  '_Настройки': 1,
  '_Колонки': 1,
  '_Лог': 1,
  'Заполненность': 1,
  'Склады_стыковка': 1
};

var DEMO_REPORT_SHEETS_ = {
  'info daily': 1,
  'info weekly': 1,
  'info monthly': 1,
  'sku': 1,
  'sku all': 1,
  'stock': 1
};

var DEMO_PRODUCTS_ = [
  'Флешка USB 32 ГБ',
  'Флешка USB 64 ГБ',
  'Карта памяти microSD 128 ГБ',
  'USB-хаб 4 порта'
];

var DEMO_VENDORS_ = ['FLASH-32', 'FLASH-64', 'SD-128', 'HUB-4'];
var DEMO_BRAND_ = 'TechDemo';
var DEMO_SELLER_ = 'a0000000-0000-4000-8000-000000000001';

function isDemoBook_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getId() === DEMO_BOOK_ID_;
  } catch (e) {
    return false;
  }
}

function buildDemoMenu_() {
  SpreadsheetApp.getUi()
    .createMenu(typeof APP_NAME_ !== 'undefined' ? APP_NAME_ : '📊 Данные WB')
    .addItem('🕶 Обезличить демо-строки', 'menuAnonymizeDemoRows')
    .addToUi();
}

function onOpenInstallable_() {
  if (!isDemoBook_()) return;
  buildDemoMenu_();
}

/** Один раз из редактора Apps Script (без UI). После — закройте и откройте книгу. */
function bootstrapDemoBook_() {
  if (!isDemoBook_()) {
    throw new Error('Это не демо-книга: ' + SpreadsheetApp.getActiveSpreadsheet().getId());
  }
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'onOpenInstallable_') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('onOpenInstallable_')
    .forSpreadsheet(DEMO_BOOK_ID_)
    .onOpen()
    .create();
  Logger.log('Триггер onOpen установлен для демо-книги');
}

function menuAnonymizeDemoRows() {
  var r = anonymizeDemoRows_();
  SpreadsheetApp.getUi().alert(
    typeof APP_NAME_ !== 'undefined' ? APP_NAME_ : 'Данные WB',
    'Обезличено листов: ' + r.sheets + '\nЯчеек: ' + r.cells,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function anonymizeDemoRows_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var totalCells = 0;
  var totalSheets = 0;
  var i;
  for (i = 0; i < sheets.length; i++) {
    var n = anonymizeDemoSheet_(sheets[i]);
    if (n > 0) {
      totalSheets++;
      totalCells += n;
    }
  }
  return { sheets: totalSheets, cells: totalCells };
}

function anonymizeDemoSheet_(sh) {
  if (!sh) return 0;
  var name = sh.getName();
  if (DEMO_SKIP_SHEETS_[name]) return 0;
  if (DEMO_REPORT_SHEETS_[name]) return anonymizeDemoReportSheet_(sh);
  return anonymizeDemoTableSheet_(sh);
}

function anonymizeDemoTableSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;

  // Только демо-хвост: строки 2–3 или чуть больше, если лист короткий.
  var endRow = Math.min(lastRow, lastRow <= 5 ? lastRow : 3);
  if (endRow < 2) return 0;

  var headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var rows = sh.getRange(2, 1, endRow, lastCol).getValues();
  var changed = 0;
  var r;
  var c;
  for (r = 0; r < rows.length; r++) {
    for (c = 0; c < headers.length; c++) {
      var hdr = String(headers[c] || '').trim();
      if (!hdr) continue;
      var oldVal = rows[r][c];
      if (oldVal === '' || oldVal === null) continue;
      var newVal = demoValueForHeader_(hdr, oldVal, r, c);
      changed += demoAssignCell_(rows, r, c, oldVal, newVal);
    }
  }
  if (changed) sh.getRange(2, 1, endRow, lastCol).setValues(rows);
  return changed;
}

function anonymizeDemoReportSheet_(sh) {
  var name = sh.getName();
  if (name === 'sku') return anonymizeDemoSkuSheet_(sh);
  if (name === 'sku all') return anonymizeDemoSkuAllSheet_(sh);
  if (name === 'stock') return anonymizeDemoStockSheet_(sh);
  if (name.indexOf('info ') === 0) return anonymizeDemoInfoSheet_(sh);
  return 0;
}

function anonymizeDemoInfoSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return 0;
  var rows = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var changed = 0;
  // «кабинет» → slug в соседней ячейке.
  changed += demoReplaceLabelValue_(rows, 'кабинет', 'demo');
  changed += demoScanReportCells_(rows, sh.getName());
  if (changed) sh.getRange(1, 1, lastRow, lastCol).setValues(rows);
  return changed;
}

function anonymizeDemoSkuSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return 0;
  var rows = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var changed = 0;
  changed += demoAssignCell_(rows, 0, 2, rows[0][2], DEMO_VENDORS_[0]);
  changed += demoAssignCell_(rows, 0, 9, rows[0][9], String(10000001));
  if (rows[1] && rows[1][0]) {
    changed += demoAssignCell_(rows, 1, 0, rows[1][0], DEMO_BRAND_ + ' · цена карточки 999 ₽');
  }
  if (rows[2] && rows[2][0]) {
    changed += demoAssignCell_(rows, 2, 0, rows[2][0], DEMO_PRODUCTS_[0]);
  }
  var whHead = demoFindRowWithCell_(rows, 'Склад');
  if (whHead >= 0) changed += demoAnonymizeWarehouseCol_(rows, whHead, 6);
  changed += demoScanReportCells_(rows, 'sku');
  if (changed) sh.getRange(1, 1, lastRow, lastCol).setValues(rows);
  return changed;
}

function anonymizeDemoSkuAllSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 5 || lastCol < 3) return 0;
  var rows = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var changed = demoAnonymizeProductTable_(rows, 4, ['Артикул', 'Название', 'nm_id']);
  changed += demoScanReportCells_(rows, 'sku all');
  if (changed) sh.getRange(1, 1, lastRow, lastCol).setValues(rows);
  return changed;
}

function anonymizeDemoStockSheet_(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 4 || lastCol < 3) return 0;
  var rows = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var changed = demoAnonymizeProductTable_(rows, 2, ['Артикул', 'Название', 'nm_id']);
  changed += demoAnonymizeWarehouseCol_(rows, 2, 11);
  changed += demoScanReportCells_(rows, 'stock');
  if (changed) sh.getRange(1, 1, lastRow, lastCol).setValues(rows);
  return changed;
}

function demoAssignCell_(rows, r, c, oldVal, newVal) {
  if (oldVal === '' || oldVal === null || oldVal === undefined) return 0;
  if (newVal === oldVal || String(newVal) === String(oldVal)) return 0;
  rows[r][c] = newVal;
  return 1;
}

function demoReplaceLabelValue_(rows, label, newVal) {
  var changed = 0;
  var r;
  var c;
  for (r = 0; r < rows.length; r++) {
    for (c = 0; c < rows[r].length - 1; c++) {
      if (String(rows[r][c] || '').trim().toLowerCase() !== label) continue;
      changed += demoAssignCell_(rows, r, c + 1, rows[r][c + 1], newVal);
    }
  }
  return changed;
}

function demoAnonymizeProductTable_(rows, headerRowIdx, headers) {
  if (!rows[headerRowIdx]) return 0;
  var cols = demoFindHeaderCols_(rows[headerRowIdx], headers);
  if (cols.sa < 0 && cols.title < 0 && cols.nm < 0) return 0;
  var changed = 0;
  var r;
  for (r = headerRowIdx + 1; r < rows.length; r++) {
    var slot = (r - headerRowIdx - 1) % DEMO_PRODUCTS_.length;
    if (cols.sa >= 0) changed += demoAssignCell_(rows, r, cols.sa, rows[r][cols.sa], DEMO_VENDORS_[slot]);
    if (cols.title >= 0) changed += demoAssignCell_(rows, r, cols.title, rows[r][cols.title], DEMO_PRODUCTS_[slot]);
    if (cols.nm >= 0) changed += demoAssignCell_(rows, r, cols.nm, rows[r][cols.nm], String(10000001 + slot * 11));
  }
  return changed;
}

function demoFindRowWithCell_(rows, label) {
  var i;
  var c;
  for (i = 0; i < rows.length; i++) {
    for (c = 0; c < rows[i].length; c++) {
      if (String(rows[i][c] || '').trim().toLowerCase() === String(label || '').trim().toLowerCase()) {
        return i;
      }
    }
  }
  return -1;
}

function demoFindHeaderCols_(headerRow, headers) {
  var out = { sa: -1, title: -1, nm: -1 };
  var c;
  for (c = 0; c < headerRow.length; c++) {
    var h = String(headerRow[c] || '').trim().toLowerCase();
    if (h === String(headers[0] || '').toLowerCase() || h === 'артикул') out.sa = c;
    if (h === String(headers[1] || '').toLowerCase() || h === 'название' || h === 'товар') out.title = c;
    if (h === String(headers[2] || '').toLowerCase() || h === 'nm_id' || h === 'артикул wb') out.nm = c;
  }
  return out;
}

function demoAnonymizeWarehouseCol_(rows, startRowIdx, colIdx) {
  var changed = 0;
  var r;
  for (r = startRowIdx + 1; r < rows.length; r++) {
    var oldVal = rows[r][colIdx];
    if (oldVal === '' || oldVal === null) continue;
    var s = String(oldVal).trim();
    if (!s || demoIsReportLabel_(s)) continue;
    changed += demoAssignCell_(rows, r, colIdx, oldVal, 'Склад ' + String.fromCharCode(65 + ((r - startRowIdx - 1) % 3)));
  }
  return changed;
}

function demoScanReportCells_(rows, sheetName) {
  var changed = 0;
  var r;
  var c;
  for (r = 0; r < rows.length; r++) {
    for (c = 0; c < rows[r].length; c++) {
      var oldVal = rows[r][c];
      if (oldVal === '' || oldVal === null) continue;
      var newVal = demoAnonymizeReportScalar_(oldVal, r, c, sheetName);
      changed += demoAssignCell_(rows, r, c, oldVal, newVal);
    }
  }
  return changed;
}

function demoAnonymizeReportScalar_(val, rowIdx, colIdx, sheetName) {
  var s = String(val).trim();
  if (!s || demoIsReportLabel_(s)) return val;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return demoFakeUuid_(rowIdx, colIdx);
  }
  if (s.indexOf('@') > 0 && s.indexOf('.') > 0) return 'demo' + (rowIdx + 2) + '@example.com';
  if (/^\+?\d[\d\s\-()]{8,}$/.test(s)) return '+7 900 000-00-0' + ((rowIdx + 2) % 10);
  if (s.length > 24 && (s.indexOf('http') === 0 || s.indexOf('www.') === 0)) return 'https://example.com/demo';
  return val;
}

function demoIsReportLabel_(s) {
  var t = String(s || '').trim();
  if (!t) return true;
  if (/^(INFO|SKU|STOCK)/i.test(t)) return true;
  if (/^[▲▼]/.test(t)) return true;
  if (/^-?\d+([.,]\d+)?(%| ₽)?$/.test(t.replace(/\s/g, ''))) return true;
  if (/^\d{1,2}\.\d{1,2}(\.\d{2,4})?$/.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return true;
  var labels = [
    'Продажи', 'Выручка', 'К перечислению', 'Реклама', 'ДРР', 'Заказы', 'Финансы',
    'Возвраты', 'Средний чек', 'Комиссия', 'Логистика', 'Хранение', 'Приёмка',
    'Эквайринг', 'Удержания', 'Штрафы', 'Показы', 'Клики', 'CPC', 'CTR', 'Отмены',
    'Сумма', 'Остатки', 'Поставки', 'История', 'Кабинет', 'Товар', 'Артикул',
    'Название', 'Склад', 'Склады', 'Покрытие', 'Статус', 'данные за', 'обновлено',
    'кабинет', 'grain', 'compare', 'nm', 'anchor', 'сейчас', 'до', 'Δ', 'vs',
    'неделя', 'месяц', 'день', 'итого', 'Снимок', 'Флаги', 'Доля', 'После рекламы',
    'Корзины', 'Отсортировано', 'Ожидает', 'FBW', 'FBS', 'В пути', 'Дней',
    'нет при спросе', 'кончится', 'мало', 'норма', 'лежит', 'нет спроса',
    'покрытие от заказов', 'Поставка шт', 'Статус поставки', 'Зак./день'
  ];
  var i;
  for (i = 0; i < labels.length; i++) {
    if (t === labels[i] || t.indexOf(labels[i]) === 0) return true;
  }
  return false;
}

function demoValueForHeader_(hdr, val, rowIdx, colIdx) {
  var h = hdr.toLowerCase();
  var row = rowIdx + 2;
  var slot = rowIdx % DEMO_PRODUCTS_.length;

  if (h.indexOf('id кабинета') >= 0) return DEMO_SELLER_;
  if (h === 'артикул wb' || h.indexOf('артикул wb') >= 0) return String(10000001 + rowIdx * 11 + colIdx);
  if (h.indexOf('арт.') >= 0 || h.indexOf('артикул продавца') >= 0) return DEMO_VENDORS_[slot];
  if (h.indexOf('штрихкод') >= 0 || h === 'sku' || h === 'штрихкоды') return String(4600000000001 + rowIdx * 17 + colIdx);
  if (h === 'название' || h === 'товар' || h === 'наименование') return DEMO_PRODUCTS_[slot];
  if (h === 'бренд' || h.indexOf('бренд') === 0) return DEMO_BRAND_;
  if (h === 'покупатель' || h.indexOf('пользователь') >= 0) return rowIdx % 2 ? 'Покупатель А' : 'Покупатель Б';
  if (h === 'текст' || h === 'достоинства' || h === 'недостатки' || h === 'ответ' || h === 'комментарий') {
    return 'Демо-текст для примера. Реальные данные скрыты.';
  }
  if (h === 'описание' && typeof val === 'string' && val.length > 20) {
    return 'Демо-описание товара.';
  }
  if (h.indexOf('адрес') >= 0) return 'г. Москва, ул. Демо, д. ' + (rowIdx + 1);
  if (h.indexOf('инн') >= 0) return '0000000000';
  if (h.indexOf('партн') >= 0 || h.indexOf('покупатель') >= 0) return 'Demo Partner';
  if (h === 'поисковый запрос') return 'флешка usb 32';
  if (h.indexOf('email') >= 0 || h.indexOf('почта') >= 0) return 'demo' + row + '@example.com';
  if (h.indexOf('телефон') >= 0) return '+7 900 000-00-0' + row;

  if (demoHeaderLooksLikeId_(h)) return demoFakeId_(val, rowIdx, colIdx, h);
  if (demoHeaderLooksLikeUuid_(h)) return demoFakeUuid_(rowIdx, colIdx);

  return val;
}

function demoHeaderLooksLikeId_(h) {
  if (h.indexOf('id ') === 0 || h.slice(-3) === ' id' || h.indexOf('id ') > 0) return true;
  if (h.indexOf('uid') >= 0 || h.indexOf('rid') >= 0 || h.indexOf('srid') >= 0) return true;
  if (h.indexOf('№ заказа') >= 0 || h.indexOf('ключ строки') >= 0) return true;
  if (h.indexOf('стикер') >= 0 && h.indexOf('штрих') < 0) return true;
  return false;
}

function demoHeaderLooksLikeUuid_(h) {
  return h.indexOf('uuid') >= 0;
}

function demoFakeId_(val, rowIdx, colIdx, hdr) {
  var s = String(val == null ? '' : val).trim();
  if (!s) return val;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return demoFakeUuid_(rowIdx, colIdx);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    var n = Math.abs(parseInt(s, 10) || 0);
    if (n > 999999999) return String(9000000000 + rowIdx * 100003 + colIdx * 17);
    return String(100000 + rowIdx * 1009 + colIdx * 13 + (n % 97));
  }
  if (hdr.indexOf('стикер') >= 0) return 'WB-DEMO-' + (100000 + rowIdx * 17 + colIdx);
  return 'DEMO-' + (1000 + rowIdx * 10 + colIdx);
}

function demoFakeUuid_(rowIdx, colIdx) {
  var a = (0x40000000 + rowIdx * 997 + colIdx * 17) >>> 0;
  var b = (0x80000000 + rowIdx * 991 + colIdx * 23) >>> 0;
  function hex(n, len) {
    var s = n.toString(16);
    while (s.length < len) s = '0' + s;
    return s.slice(-len);
  }
  return (
    hex(a, 8) + '-' +
    hex(0x4000 + rowIdx, 4) + '-' +
    hex(0x8000 + colIdx, 4) + '-' +
    hex(0x8000 + rowIdx, 4) + '-' +
    hex(b, 12)
  );
}
