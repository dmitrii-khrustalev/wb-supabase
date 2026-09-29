/**
 * Файл 02 — только этот кабинет. Другому не копировать.
 *
 * Читает, не меняет: Товар+Вес, ЗаказыЛК, Товары.
 * Регион складов — из базы (warehouse_dict). «Регион поставки» только для галочки
 * «выбор склада» в Поставка_2 (пустые колонки заранее).
 * После загрузки сырья из 01 дописывает кг / регион, колонки рекламы и вес воронки.
 * Отчёты 03: к-во заказов из базы (воронка), вес заказов с «Воронка продаж».
 * Ручная цена и регион — через функции ниже. ЗаказыЛК — только Сводная / кнопка листа.
 * протянутьФормулыЗаказыЛК — на кнопку листа, в меню нет. Считает по шаблону I1–K1 и оставляет значения.
 * создатьСводная — лист «Сводная», формулы как в первой книге, на листы этой.
 */

function clientManualSheets_() {
  return {
    'Товар+Вес': 1,
    'Регион поставки': 1,
    'ЗаказыЛК': 1,
    'Сводная': 1
  };
}

/** Листы, куда 02 пишет кг/регион/рекламу. Товары — только справочник, не цель overlay. */
function clientOverlayTargetSheet_(sheetName) {
  var name = String(sheetName || '').trim();
  if (!name) return false;
  if (name === 'Рекламные расходы') return true;
  var jobs = ovJobs_();
  var i;
  for (i = 0; i < jobs.length; i++) {
    var sheets = jobs[i].sheets || [];
    var s;
    for (s = 0; s < sheets.length; s++) {
      if (String(sheets[s] || '').trim() === name) return true;
    }
  }
  return false;
}

function clientOverlayInputs_(sheet) {
  var map = {
    'Финансовые ежедневные': ['sa_name', 'nm_id', 'office_name', 'quantity', 'doc_type_name'],
    'Рекламные расходы': ['nm_id', 'clicks', 'cpc', 'stat_date'],
    'Заказы FBW': ['supplier_article', 'nm_id', 'warehouse_name', 'quantity'],
    'Остатки FBW': ['nm_id', 'warehouse_name', 'quantity', 'vendor_code', 'inWayToClient', 'inWayFromClient'],
    'Остатки ЛК': ['nm_id', 'tech_size', 'warehouse_name', 'quantity', 'vendor_code'],
    'Товары': ['nm_id', 'vendor_code'],
    'Поставки FBW': ['vendor_code', 'nm_id', 'warehouse_name', 'quantity'],
    'Остатки FBS': ['nm_id', 'sku', 'vendorCode', 'warehouse_id', 'warehouseName', 'amount'],
    'Заказы FBS': ['article', 'nm_id', 'warehouse_id'],
    'Поставки FBS': ['article', 'nm_id', 'warehouse_id'],
    'Склады FBS': ['name', 'warehouse_id'],
    'Воронка продаж': ['vendor_code', 'nm_id', 'order_count']
  };
  return map[sheet] || [];
}

function clientWeightMap_(ss) {
  return ovLoadWeightMap_(ss);
}

function clientManualPriceMap_(ss) {
  var map = {};
  var sh = ss.getSheetByName('Товар+Вес');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var artCol = 0;
  var pCol = -1;
  var h;
  for (h = 0; h < headers.length; h++) {
    var name = String(headers[h] || '').trim().toLowerCase();
    if (name === 'артикул' || name === 'арт. продавца' || name === 'артикул продавца') artCol = h;
    if (name.indexOf('ручная цена') >= 0) pCol = h;
  }
  if (pCol < 0) return map;
  for (var i = 1; i < data.length; i++) {
    var art = String(data[i][artCol] || '').trim().toLowerCase();
    if (!art) continue;
    var p = Number(data[i][pCol]);
    if (!isNaN(p)) map[art] = p;
  }
  return map;
}

function clientFboOrders_(ss, fromIso, toIso) {
  var sh = ss.getSheetByName('ЗаказыЛК');
  if (!sh) throw new Error('Нет листа «ЗаказыЛК». Отчёт заказов этого кабинета берёт штуки и вес оттуда.');
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 3 || lastCol < 11) throw new Error('На «ЗаказыЛК» нет данных (нужны колонки C дата, D артикул, G к-во, I имя, K вес).');
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var shownDates = sh.getRange(1, 3, lastRow, 1).getDisplayValues();
  var out = [];
  var i;
  for (i = 2; i < data.length; i++) {
    var row = data[i];
    var iso = (typeof reportParseDisplayDate_ === 'function' ? reportParseDisplayDate_(shownDates[i][0]) : '') ||
      (typeof reportDateIso_ === 'function' ? reportDateIso_(row[2]) : '');
    if (!iso || iso < fromIso || iso > toIso) continue;
    var art = String(row[3] == null ? '' : row[3]).trim();
    var name = String(row[8] == null ? '' : row[8]).trim();
    if (!art || art === '-' || !name || name === '-' || name === '') continue;
    out.push({
      sa_name: art,
      title: name,
      day: iso,
      qty: Number(row[6]) || 0,
      weight: Number(row[10]) || 0
    });
  }
  return out;
}

function clientPostavkaWeightMap_(ss) {
  var map = {};
  var sh = ss.getSheetByName('Товар+Вес');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var artCol = 0;
  var wCol = -1;
  var h;
  for (h = 0; h < headers.length; h++) {
    var name = String(headers[h] || '').trim().toLowerCase();
    if (name === 'артикул' || name === 'арт. продавца' || name === 'артикул продавца' || name === 'sa_name') artCol = h;
    if (name === 'вес, кг за 1 шт') wCol = h;
  }
  if (wCol < 0) {
    for (h = 0; h < headers.length; h++) {
      if (String(headers[h] || '').toLowerCase().indexOf('вес') >= 0) { wCol = h; break; }
    }
  }
  if (wCol < 0) return map;
  var norm = typeof reportNormArt_ === 'function' ? reportNormArt_ : function (a) { return String(a || '').toUpperCase().replace(/Х/g, 'X').trim(); };
  var i;
  for (i = 1; i < data.length; i++) {
    var art = norm(data[i][artCol]);
    if (!art) continue;
    var w = parseFloat(String(data[i][wCol]).replace(',', '.'));
    if (!isNaN(w)) map[art] = w;
  }
  return map;
}

function clientPostavkaRegionRef_(ss, skipDict) {
  var regionByWarehouse = skipDict ? {} : ovLoadRegionMap_(ss);
  var approved = [];
  var sh = ss.getSheetByName('Регион поставки');
  if (!sh || sh.getLastRow() < 2) return { regionByWarehouse: regionByWarehouse, approved: approved };
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(function (v) { return String(v || '').trim().toLowerCase(); });
  var whCol = -1, regCol = -1, pickCol = -1;
  var h;
  for (h = 0; h < headers.length; h++) {
    if (whCol < 0 && (headers[h] === 'склад' || headers[h] === 'warehouse' || headers[h] === 'название')) whCol = h;
    if (regCol < 0 && (headers[h] === 'регион' || headers[h] === 'регион поставки')) regCol = h;
    if (pickCol < 0 && headers[h].indexOf('выбор склада') >= 0) pickCol = h;
  }
  if (whCol < 0) whCol = 0;
  if (regCol < 0) regCol = 1;
  for (var i = 1; i < data.length; i++) {
    var wh = String(data[i][whCol] || '').trim();
    var reg = String(data[i][regCol] || '').trim();
    if (!wh) continue;
    var key = wh.toLowerCase();
    if (reg && !regionByWarehouse[key]) regionByWarehouse[key] = reg;
    if (pickCol >= 0 && String(data[i][pickCol] || '').trim().toLowerCase() === 'да') {
      approved.push({ region: reg || regionByWarehouse[key] || '', warehouse: wh });
    }
  }
  return { regionByWarehouse: regionByWarehouse, approved: approved };
}

function applyClientOverlay() {
  applyClientOverlayImpl_(true, null);
}

function applyClientOverlay_(showAlert) {
  applyClientOverlayImpl_(showAlert, null);
}

function applyClientOverlayImpl_(showAlert, onlySheets, loadStarted, ranges) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    if (typeof TZ === 'string' && ss.getSpreadsheetTimeZone() !== TZ) {
      ss.setSpreadsheetTimeZone(TZ);
    }
  } catch (eTz) {}
  var started = loadStarted || Date.now();
  var weightMap = ovLoadWeightMap_(ss);
  var regionMap = ovLoadRegionMap_(ss);
  var whIdMap = ovLoadFbsWarehouseNames_(ss);
  var notes = [];
  if (!Object.keys(weightMap).length) notes.push('нет весов в «Товар+Вес»');
  if (!Object.keys(regionMap).length) notes.push('нет регионов в справочнике складов');

  ovPruneOverlayRanges_(ss);
  ranges = typeof readOverlayRanges_ === 'function' ? readOverlayRanges_() : ranges;
  var nmMap = ovLoadNmArticleMap_(ss);
  var jobs = ovFilterJobs_(ovJobs_(), onlySheets);
  var parts = [];
  var total = 0;
  var leftover = [];
  var i;
  for (i = 0; i < jobs.length; i++) {
    if (!showAlert && typeof overBudget_ === 'function' && overBudget_(started, 90 * 1000)) {
      leftover = ovJobSheetNames_(jobs.slice(i));
      if (ovWantSheet_(onlySheets, 'Рекламные расходы')) leftover.push('Рекламные расходы');
      break;
    }
    try {
      var rng = ovRangeForJob_(jobs[i], ranges);
      var sheetName = (jobs[i].sheets && jobs[i].sheets[0]) ? jobs[i].sheets[0] : jobs[i].label;
      var n = ovFillJob_(ss, jobs[i], weightMap, regionMap, whIdMap, nmMap, rng, !!ranges);
      if (rng && n > 0) ovAdvanceOverlayRange_(sheetName, rng, n);
      else if (rng && rng.n > 0 && typeof clearOverlayRangeInSession_ === 'function') {
        clearOverlayRangeInSession_(sheetName);
      }
      if (n > 0) {
        parts.push(jobs[i].label + ': ' + n);
        total += n;
      }
    } catch (fillErr) {
      notes.push(jobs[i].label + ': ' + String(fillErr && fillErr.message ? fillErr.message : fillErr).substring(0, 80));
    }
  }
  if (!leftover.length && ovWantSheet_(onlySheets, 'Рекламные расходы')) {
    var adsRng = ranges ? (ranges['Рекламные расходы'] || null) : null;
    if (!showAlert && typeof overBudget_ === 'function' && overBudget_(started, 90 * 1000)) {
      leftover = ['Рекламные расходы'];
    } else {
      var adsN = 0;
      try {
        adsN = ovFillAdsSheet_(ss, adsRng, !!ranges);
      } catch (adsErr) {
        notes.push('реклама: ' + String(adsErr && adsErr.message ? adsErr.message : adsErr).substring(0, 80));
      }
      if (adsN > 0) {
        parts.push('Реклама: ' + adsN);
        total += adsN;
        if (adsRng) ovAdvanceOverlayRange_('Рекламные расходы', adsRng, adsN);
      } else if (adsRng && adsRng.n > 0 && typeof clearOverlayRangeInSession_ === 'function') {
        clearOverlayRangeInSession_('Рекламные расходы');
        notes.push('реклама: диапазон сброшен (нет колонок overlay)');
      }
    }
  }
  if (leftover.length) {
    leftover = ovFilterOverlayTargets_(leftover);
    if (leftover.length) {
      if (typeof log_ === 'function') {
        log_(ss, 'overlay', 'продолжает', total, 0, 0, leftover.join(', '), Date.now() - started);
      }
      return leftover;
    }
  }
  ovPruneOverlayRanges_(ss);
  ovEnsureOverlayFilters_(ss, onlySheets);
  var msg = parts.length ? parts.join('. ') : 'нечего заполнять';
  if (notes.length) msg += '. ' + notes.join('; ');
  var logNote = parts.length ? parts.join('; ') : '';
  if (notes.length) logNote += (logNote ? '; ' : '') + notes.join('; ');

  if (typeof log_ === 'function') {
    log_(ss, 'overlay', 'готово', total, 0, 0, logNote, Date.now() - started);
  }
  if (showAlert) {
    try { SpreadsheetApp.getUi().alert('Клиентские колонки подставлены.\n' + msg); } catch (e) {}
  }
  return null;
}

function ovFilterOverlayTargets_(names) {
  if (!names || !names.length) return [];
  var out = [];
  var i;
  for (i = 0; i < names.length; i++) {
    var name = String(names[i] || '').trim();
    if (!name) continue;
    if (typeof clientOverlayTargetSheet_ === 'function' && !clientOverlayTargetSheet_(name)) {
      if (typeof clearOverlayRangeInSession_ === 'function') clearOverlayRangeInSession_(name);
      continue;
    }
    out.push(name);
  }
  return out;
}

function ovJobSheetNames_(jobs) {
  var out = [];
  var seen = {};
  for (var i = 0; i < jobs.length; i++) {
    var names = jobs[i].sheets || [];
    for (var s = 0; s < names.length; s++) {
      var name = names[s];
      if (!name || seen[name]) continue;
      seen[name] = 1;
      out.push(name);
    }
  }
  return out;
}

function ovWantSheet_(onlySheets, name) {
  if (!onlySheets || !onlySheets.length) return true;
  var want = String(name || '').trim().toLowerCase();
  for (var i = 0; i < onlySheets.length; i++) {
    if (String(onlySheets[i] || '').trim().toLowerCase() === want) return true;
  }
  return false;
}

function ovFilterJobs_(jobs, onlySheets) {
  if (!onlySheets || !onlySheets.length) return jobs;
  var out = [];
  for (var i = 0; i < jobs.length; i++) {
    var names = jobs[i].sheets || [];
    var ok = false;
    for (var s = 0; s < names.length; s++) {
      if (ovWantSheet_(onlySheets, names[s])) { ok = true; break; }
    }
    if (ok) out.push(jobs[i]);
  }
  return out;
}

function ovSortDataSheets_(ss) {
  if (!ss || typeof sortSheet_ !== 'function') return;
  var jobs = [];
  if (typeof readSettings_ === 'function') {
    try { jobs = readSettings_(ss) || []; } catch (e) { jobs = []; }
  }
  if (!jobs.length && typeof DEFAULT_SHEETS !== 'undefined') jobs = DEFAULT_SHEETS;
  var i;
  for (i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (!job || !job.sheet) continue;
    if (typeof isManualSheet_ === 'function' && isManualSheet_(job.sheet)) continue;
    var sh = ss.getSheetByName(job.sheet);
    if (!sh || sh.getLastRow() < 3) continue;
    var keys = [];
    try {
      var colInfo = typeof readColumnMap_ === 'function' ? readColumnMap_(ss, job.sheet) : { map: {}, order: [], enabled: {} };
      var fallback = typeof selectedKeys_ === 'function'
        ? selectedKeys_(job, colInfo)
        : (typeof typedKeys_ === 'function' ? typedKeys_(job) : []);
      keys = typeof headerKeysFromSheet_ === 'function'
        ? headerKeysFromSheet_(sh, job, colInfo, fallback)
        : fallback;
    } catch (eK) { keys = []; }
    if (!keys.length) continue;
    try { sortSheet_(sh, job, keys); } catch (eS) {}
  }
}

function ovJobs_() {
  var art = ['арт. продавца', 'артикул продавца', 'артикул', 'vendor_code', 'supplier_article', 'sa_name', 'арт. в заказе', 'article'];
  var wh = ['склад', 'warehouse_name', 'warehousename', 'офис', 'office_name'];
  var qty = ['кол-во', 'количество', 'quantity'];
  return [
    { label: 'Поставки FBW', sheets: ['Поставки FBW', 'Поставки FBW'], kind: 'lines', art: art, warehouse: wh, qty: qty, totalName: 'Общий вес, кг' },
    { label: 'Остатки FBW', sheets: ['Остатки FBW', 'Остатки FBW'], kind: 'transit', art: art, warehouse: wh, qty: qty, totalName: 'Общий вес, кг', skipStockWeight: true },
    { label: 'Заказы FBW', sheets: ['Заказы FBW', 'Заказы FBW'], kind: 'lines', art: art, warehouse: wh, qty: qty, defaultQty: 1, totalName: 'Вес, кг за 1 шт сумма' },
    { label: 'Остатки ЛК', sheets: ['Остатки ЛК'], kind: 'lines', art: art, warehouse: wh, qty: qty, totalName: 'Общий вес, кг' },
    { label: 'Остатки FBS', sheets: ['Остатки FBS'], kind: 'lines', art: art.concat(['vendorcode', 'sku']), warehouse: wh.concat(['warehousename']), warehouseId: ['id склада', 'warehouse_id'], qty: ['остаток', 'amount'].concat(qty), totalName: 'Вес, кг за 1 шт сумма' },
    { label: 'Заказы FBS', sheets: ['Заказы FBS'], kind: 'lines', art: art, warehouse: wh.concat(['название']), warehouseId: ['id склада', 'warehouse_id'], qty: qty, defaultQty: 1, totalName: 'Вес, кг за 1 шт сумма' },
    { label: 'Поставки FBS', sheets: ['Поставки FBS'], kind: 'lines', art: art, warehouse: wh, warehouseId: ['id склада', 'warehouse_id'], qty: qty, defaultQty: 1, totalName: 'Вес, кг за 1 шт сумма' },
    { label: 'Склады FBS', sheets: ['Склады FBS'], kind: 'wh', warehouse: ['название', 'name', 'склад'] },
    { label: 'Финансы', sheets: ['Финансовые ежедневные'], kind: 'lines', art: art.concat(['sa_name']), warehouse: wh.concat(['офис', 'office_name']), qty: qty, signedQty: true, totalName: 'Вес, кг за 1 шт сумма', netWeightName: 'Вес итог, кг с учетом возвратов' },
    {
      label: 'Воронка продаж',
      sheets: ['Воронка продаж'],
      kind: 'lines',
      skipRegion: true,
      art: art,
      qty: ['заказы шт', 'заказы', 'order_count'],
      totalName: 'Вес, кг за 1 шт сумма заказов',
      totalAliases: ['вес, кг за 1 шт сумма заказов']
    }
  ];
}

function ovLoadWeightMap_(ss) {
  var map = {};
  var sh = ss.getSheetByName('Товар+Вес');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return map;
  var headers = data[0];
  var artCol = ovCol_(headers, ['артикул', 'арт. продавца', 'артикул продавца', 'sa_name', 'vendor_code']);
  if (artCol < 0) artCol = 0;
  var wCol = ovCol_(headers, ['вес, кг за 1 шт', 'вес, кг за 1 шт']);
  if (wCol < 0) wCol = ovColContains_(headers, 'вес');
  if (wCol < 0) wCol = 1;
  for (var i = 1; i < data.length; i++) {
    var art = ovNormArt_(data[i][artCol]);
    if (!art) continue;
    var w = ovParseNumber_(data[i][wCol]);
    map[art] = w;
  }
  return map;
}

function ovLoadRegionMap_(ss) {
  var map = {};
  try {
    if (typeof fetchWarehouseDictRows_ === 'function') {
      var rows = fetchWarehouseDictRows_(ss);
      var i;
      for (i = 0; i < rows.length; i++) {
        var region = String(rows[i].region || '').trim();
        if (!region) continue;
        var alias = String(rows[i].alias || '').trim().toLowerCase();
        var canon = String(rows[i].canonical || '').trim().toLowerCase();
        if (alias) map[alias] = region;
        if (canon && !map[canon]) map[canon] = region;
      }
    }
  } catch (eDb) {}
  if (Object.keys(map).length) return map;
  return ovLoadRegionMapFromSheet_(ss);
}

function ovLoadRegionMapFromSheet_(ss) {
  var map = {};
  var sh = ss.getSheetByName('Регион поставки');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return map;
  var headers = data[0];
  var whCol = ovCol_(headers, ['склад', 'название', 'warehouse']);
  if (whCol < 0) whCol = 0;
  var rgCol = ovCol_(headers, ['регион поставки', 'регион']);
  if (rgCol < 0) rgCol = 1;
  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][whCol] || '').trim().toLowerCase();
    var region = String(data[i][rgCol] || '').trim();
    if (name && region) map[name] = region;
  }
  return map;
}

function ovLoadFbsWarehouseNames_(ss) {
  var map = {};
  var sh = ovFindSheet_(ss, ['Склады FBS']);
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var idCol = ovCol_(headers, ['id склада', 'warehouse_id']);
  var nameCol = ovCol_(headers, ['название', 'name', 'склад']);
  if (idCol < 0 || nameCol < 0) return map;
  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][idCol] || '').trim();
    var name = String(data[i][nameCol] || '').trim();
    if (id && name) map[id] = name;
  }
  return map;
}

function ovNormArt_(s) {
  return String(s || '').trim().toLowerCase().split('ё').join('е').split('х').join('x');
}

function ovParseNumber_(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  var t = String(val).replace(/\u00a0/g, '').replace(/\s/g, '').replace(',', '.');
  var n = Number(t);
  return isFinite(n) ? n : 0;
}

function ovLookupWeight_(map, article) {
  if (!article) return 0;
  var key = ovNormArt_(article);
  if (!key) return 0;
  if (map[key] != null) return map[key];
  return 0;
}

function ovLoadNmArticleMap_(ss) {
  var map = {};
  var sh = ss.getSheetByName('Товары');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var nmCol = ovCol_(headers, ['артикул wb', 'nm_id', 'nmid']);
  var artCol = ovCol_(headers, ['арт. продавца', 'артикул продавца', 'vendor_code', 'артикул']);
  if (nmCol < 0) nmCol = 0;
  if (artCol < 0) artCol = 2;
  for (var i = 1; i < data.length; i++) {
    var nm = String(data[i][nmCol] || '').trim();
    if (!nm) continue;
    map[nm] = String(data[i][artCol] || '').trim();
  }
  return map;
}

function ovLoadNmTitleMap_(ss) {
  var map = {};
  var sh = ss.getSheetByName('Товары');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var nmCol = ovCol_(headers, ['артикул wb', 'nm_id', 'nmid']);
  var titleCol = ovCol_(headers, ['название', 'title', 'наименование']);
  if (nmCol < 0) nmCol = 0;
  if (titleCol < 0) return map;
  for (var i = 1; i < data.length; i++) {
    var nm = String(data[i][nmCol] || '').trim();
    var title = String(data[i][titleCol] || '').trim();
    if (!nm || !title) continue;
    map[nm] = title;
  }
  return map;
}

var OVERLAY_MAX_ROWS_PER_RUN_ = 2500;

function ovCapSpan_(span) {
  if (!span || span.n <= OVERLAY_MAX_ROWS_PER_RUN_) return span;
  return { from: span.from + span.n - OVERLAY_MAX_ROWS_PER_RUN_, n: OVERLAY_MAX_ROWS_PER_RUN_ };
}

/** Пачки идут с хвоста диапазона (ovCapSpan_); остаток — голова [from .. from+n-left-1]. */
function ovAdvanceOverlayRange_(sheetName, rng, processedN) {
  if (!sheetName || !rng || processedN < 1) return;
  var from = Number(rng.from) || 2;
  var total = Number(rng.n) || 0;
  if (processedN >= total) {
    if (typeof clearOverlayRangeInSession_ === 'function') clearOverlayRangeInSession_(sheetName);
    return;
  }
  var left = total - processedN;
  if (left > 0 && typeof shrinkOverlayRangeInSession_ === 'function') {
    shrinkOverlayRangeInSession_(sheetName, from, left);
  } else if (typeof clearOverlayRangeInSession_ === 'function') {
    clearOverlayRangeInSession_(sheetName);
  }
}

function ovPruneOverlayRanges_(ss) {
  if (!ss || typeof readOverlayRanges_ !== 'function') return;
  var ranges = readOverlayRanges_();
  if (!ranges) return;
  var name;
  for (name in ranges) {
    if (!Object.prototype.hasOwnProperty.call(ranges, name)) continue;
    var r = ranges[name];
    var sh = ss.getSheetByName(name);
    var last = sh ? sh.getLastRow() : 0;
    var from = Number(r && r.from) || 2;
    var n = Number(r && r.n) || 0;
    if (typeof clientOverlayTargetSheet_ === 'function' && !clientOverlayTargetSheet_(name)) {
      if (typeof clearOverlayRangeInSession_ === 'function') clearOverlayRangeInSession_(name);
      continue;
    }
    if (!sh || last < 2 || n < 1 || from > last) {
      if (typeof clearOverlayRangeInSession_ === 'function') clearOverlayRangeInSession_(name);
      continue;
    }
    if (from + n - 1 > last) {
      var fit = last - from + 1;
      if (fit > 0 && typeof shrinkOverlayRangeInSession_ === 'function') {
        shrinkOverlayRangeInSession_(name, from, fit);
      } else if (typeof clearOverlayRangeInSession_ === 'function') {
        clearOverlayRangeInSession_(name);
      }
    }
  }
}

function ovRangeForJob_(job, ranges) {
  if (!ranges || !job) return null;
  var names = job.sheets || [];
  for (var i = 0; i < names.length; i++) {
    var r = ranges[names[i]];
    if (r && r.from && r.n >= 1) return { from: Number(r.from), n: Number(r.n) };
  }
  return null;
}

function ovClampRange_(sh, rng) {
  var last = sh ? sh.getLastRow() : 0;
  if (last < 2) return null;
  if (!rng) {
    var nAll = last - 1;
    if (nAll > OVERLAY_MAX_ROWS_PER_RUN_) {
      return { from: last - OVERLAY_MAX_ROWS_PER_RUN_ + 1, n: OVERLAY_MAX_ROWS_PER_RUN_ };
    }
    return { from: 2, n: nAll };
  }
  var from = Math.max(2, Number(rng.from) || 2);
  var n = Number(rng.n) || 0;
  if (from > last || n < 1) return null;
  if (from + n - 1 > last) n = last - from + 1;
  return n < 1 ? null : ovCapSpan_({ from: from, n: n });
}

function ovReadSparse_(sh, startRow, n, cols) {
  var unique = {};
  for (var i = 0; i < cols.length; i++) {
    var col = Number(cols[i]);
    if (col >= 0) unique[col] = true;
  }
  var sorted = Object.keys(unique).map(Number).sort(function (a, b) { return a - b; });
  var spans = [];
  for (i = 0; i < sorted.length; i++) {
    col = sorted[i];
    var last = spans.length ? spans[spans.length - 1] : null;
    if (last && col <= last.to + 2) last.to = col;
    else spans.push({ from: col, to: col, data: null });
  }
  for (i = 0; i < spans.length; i++) {
    var span = spans[i];
    span.data = sh.getRange(startRow, span.from + 1, n, span.to - span.from + 1).getValues();
  }
  return {
    get: function (row, column) {
      if (column < 0) return '';
      for (var s = 0; s < spans.length; s++) {
        if (column >= spans[s].from && column <= spans[s].to) {
          return spans[s].data[row][column - spans[s].from];
        }
      }
      return '';
    }
  };
}

function ovFillAdsSheet_(ss, rng, limited) {
  var sh = ss.getSheetByName('Рекламные расходы');
  if (!sh || sh.getLastRow() < 2) return 0;
  var added = ovEnsureAdsCols_(sh);
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return 0;
  if (added) rng = null;
  else if (limited && (!rng || rng.n < 1)) rng = null;
  var span = ovClampRange_(sh, rng);
  if (!span) {
    ovEnsureFullFilter_(sh);
    if (rng && rng.n > 0 && typeof clearOverlayRangeInSession_ === 'function') {
      clearOverlayRangeInSession_('Рекламные расходы');
    }
    return 0;
  }
  var startRow = span.from;
  var n = span.n;
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var nmCol = ovCol_(headers, ['артикул wb', 'nm_id', 'nmid']);
  var clicksCol = ovCol_(headers, ['клики', 'clicks']);
  var cpcCol = ovCol_(headers, ['cpc']);
  var dateSrc = ovCol_(headers, ['дата статы', 'stat_date']);
  var artCol = ovCol_(headers, ['артикул']);
  var dateCol = ovCol_(headers, ['дата']);
  var costCol = ovCol_(headers, ['расходы рекламы']);
  if (artCol < 0 || dateCol < 0 || costCol < 0) {
    ovEnsureFullFilter_(sh);
    if (rng && rng.n > 0 && typeof clearOverlayRangeInSession_ === 'function') {
      clearOverlayRangeInSession_('Рекламные расходы');
    }
    return 0;
  }
  ovStyleOverlayHeaders_(sh, [artCol, dateCol, costCol]);
  var nmMap = ovLoadNmArticleMap_(ss);
  var source = ovReadSparse_(sh, startRow, n, [nmCol, clicksCol, cpcCol, dateSrc]);
  var artOut = [];
  var dateOut = [];
  var costOut = [];
  for (var i = 0; i < n; i++) {
    var nm = nmCol >= 0 ? String(source.get(i, nmCol) || '').trim() : '';
    var clicks = clicksCol >= 0 ? Number(source.get(i, clicksCol)) || 0 : 0;
    var cpc = cpcCol >= 0 ? Number(source.get(i, cpcCol)) || 0 : 0;
    artOut.push([nmMap[nm] || '']);
    var dateValue = dateSrc >= 0 ? source.get(i, dateSrc) : '';
    if (dateValue !== '' && typeof toSheetDate_ === 'function') {
      dateValue = toSheetDate_(dateValue);
    }
    dateOut.push([dateValue]);
    costOut.push([clicks * cpc]);
  }
  sh.getRange(startRow, artCol + 1, n, 1).setValues(artOut);
  sh.getRange(startRow, dateCol + 1, n, 1).setValues(dateOut);
  sh.getRange(startRow, costCol + 1, n, 1).setValues(costOut);
  try { sh.getRange(startRow, dateCol + 1, n, 1).setNumberFormat('dd.mm.yyyy'); } catch (e1) {}
  try { sh.getRange(startRow, costCol + 1, n, 1).setNumberFormat('#,##0.00'); } catch (e2) {}
  if (typeof syncAdsNamesFromProducts_ === 'function') {
    try {
      var adsDef = typeof defaultSheetByName_ === 'function' ? defaultSheetByName_('Рекламные расходы') : null;
      var adsCol = typeof readColumnMap_ === 'function' ? readColumnMap_(ss, 'Рекламные расходы') : null;
      var adsKeys = adsDef && typeof selectedKeys_ === 'function' ? selectedKeys_(adsDef, adsCol) : null;
      syncAdsNamesFromProducts_(ss, sh, adsKeys);
    } catch (eNmOv) {}
  }
  ovSyncSheetFont_(sh, startRow, n, added);
  ovEnsureFullFilter_(sh);
  return n;
}

function ovEnsureAdsCols_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var extra = [];
  function need(aliases, fallback) {
    if (ovCol_(headers, aliases) >= 0) return;
    extra.push(fallback);
    headers.push(fallback);
  }
  need(['артикул'], 'Артикул');
  need(['дата'], 'Дата');
  need(['расходы рекламы'], 'Расходы рекламы');
  if (extra.length) {
    sh.getRange(1, lastCol + 1, 1, extra.length).setValues([extra]);
    if (typeof styleHeader_ === 'function') {
      try { styleHeader_(sh, lastCol + extra.length); } catch (eH) {}
    }
    if (sh.getLastRow() >= 2 && typeof styleBody_ === 'function') {
      try { styleBody_(sh, 2, sh.getLastRow() - 1, sh.getLastColumn()); } catch (eB) {}
    }
  }
  return extra.length > 0;
}

function ovLookupRegion_(map, warehouse) {
  if (!warehouse) return '';
  var key = String(warehouse).trim().toLowerCase();
  if (!key) return '';
  return map[key] || '';
}

function ovFillJob_(ss, job, weightMap, regionMap, whIdMap, nmMap, rng, limited) {
  var sh = ovFindSheet_(ss, job.sheets);
  if (!sh || sh.getLastRow() < 2) return 0;
  var added = ovEnsureReportCols_(sh, job);
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return 0;
  if (added) rng = null;
  var span = null;
  if (added) {
    span = ovClampRange_(sh, null);
  } else if (limited && (!rng || rng.n < 1)) {
    if (sh.getLastRow() >= 2) span = ovClampRange_(sh, null);
    else {
      ovEnsureFullFilter_(sh);
      return 0;
    }
  } else {
    span = ovClampRange_(sh, rng);
  }
  if (!span) {
    ovEnsureFullFilter_(sh);
    if (rng && rng.n > 0 && typeof clearOverlayRangeInSession_ === 'function') {
      var stuckName = (job.sheets && job.sheets[0]) ? job.sheets[0] : '';
      if (stuckName) clearOverlayRangeInSession_(stuckName);
    }
    return 0;
  }
  span = ovCapSpan_(span);
  var startRow = span.from;
  var n = span.n;
  lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var artCols = ovCols_(headers, job.art);
  var nmCol = ovCol_(headers, ['артикул wb', 'nm_id', 'nmid']);
  var wh = ovCol_(headers, job.warehouse);
  var whId = job.warehouseId ? ovCol_(headers, job.warehouseId) : -1;
  var qty = ovCol_(headers, job.qty);
  var docType = ovCol_(headers, ['тип документа', 'doc_type_name', 'операция']);
  var regionCols = job.skipRegion ? [] : ovRegionCols_(headers);
  var weight = ovCol_(headers, ['вес, кг за 1 шт', 'weight_kg']);
  var total = job.totalName ? ovCol_(headers, ovJobTotalAliases_(job)) : -1;
  var netWeight = job.netWeightName ? ovCol_(headers, [String(job.netWeightName).toLowerCase(), 'вес итог, кг с учетом возвратов']) : -1;
  var toClient = ovCol_(headers, ['в пути к покупателю', 'в пути к клиенту', 'in_way_to_client']);
  var fromClient = ovCol_(headers, ['в пути от покупателя', 'в пути от клиента', 'in_way_from_client']);
  var toWeight = ovCol_(headers, ['в пути к покупателю вес, кг', 'in_way_to_weight_kg']);
  var fromWeight = ovCol_(headers, ['в пути от покупателя вес, кг', 'in_way_from_weight_kg']);
  var stockWeight = ovCol_(headers, ['остатки вес, кг', 'stock_weight_kg']);
  ovStyleOverlayHeaders_(sh, regionCols.concat([
    weight, total, netWeight, toWeight, fromWeight, stockWeight
  ]));

  var sourceCols = artCols.concat([nmCol, wh, whId, qty, docType, weight, toClient, fromClient]);
  var source = ovReadSparse_(sh, startRow, n, sourceCols);
  var regionOut = [];
  var weightOut = [];
  var totalOut = [];
  var netOut = [];
  var toWOut = [];
  var fromWOut = [];
  var stockOut = [];

  for (var i = 0; i < n; i++) {
    var warehouse = wh >= 0 ? source.get(i, wh) : '';
    var warehouseId = whId >= 0 ? source.get(i, whId) : '';
    if (!warehouse && warehouseId != null && String(warehouseId) !== '') {
      warehouse = whIdMap[String(warehouseId).trim()] || '';
    }
    var article = '';
    for (var ac = 0; ac < artCols.length; ac++) {
      var candidate = source.get(i, artCols[ac]);
      if (candidate != null && String(candidate).trim() !== '') {
        article = candidate;
        break;
      }
    }
    if (!article && nmCol >= 0 && nmMap) {
      article = nmMap[String(source.get(i, nmCol) || '').trim()] || '';
    }
    var wExist = weight >= 0 ? ovParseNumber_(source.get(i, weight)) : 0;
    var w = job.kind === 'wh' || job.kind === 'region-only' ? 0 : (ovLookupWeight_(weightMap, article) || wExist);
    var q = qty >= 0 ? ovParseNumber_(source.get(i, qty)) : (job.defaultQty || 0);
    if (q === 0 && job.defaultQty) q = job.defaultQty;
    var qNet = q;
    if (job.signedQty && docType >= 0) {
      var dt = String(source.get(i, docType) || '').toLowerCase();
      if (dt.indexOf('возврат') >= 0) qNet = -Math.abs(q);
      else if (dt.indexOf('продажа') >= 0) qNet = Math.abs(q);
    }
    var toQ = toClient >= 0 ? ovParseNumber_(source.get(i, toClient)) : 0;
    var fromQ = fromClient >= 0 ? ovParseNumber_(source.get(i, fromClient)) : 0;
    regionOut.push([ovLookupRegion_(regionMap, warehouse)]);
    weightOut.push([w]);
    totalOut.push([w * q]);
    netOut.push([w * qNet]);
    toWOut.push([w * toQ]);
    fromWOut.push([w * fromQ]);
    stockOut.push([w * q]);
  }

  for (var r = 0; r < regionCols.length; r++) {
    sh.getRange(startRow, regionCols[r] + 1, n, 1).setValues(regionOut);
  }
  if (job.kind !== 'wh' && job.kind !== 'region-only') {
    if (weight >= 0) sh.getRange(startRow, weight + 1, n, 1).setValues(weightOut);
    if (total >= 0) sh.getRange(startRow, total + 1, n, 1).setValues(totalOut);
    if (netWeight >= 0) sh.getRange(startRow, netWeight + 1, n, 1).setValues(netOut);
  }
  if (job.kind === 'transit') {
    if (toWeight >= 0) sh.getRange(startRow, toWeight + 1, n, 1).setValues(toWOut);
    if (fromWeight >= 0) sh.getRange(startRow, fromWeight + 1, n, 1).setValues(fromWOut);
    if (stockWeight >= 0 && !job.skipStockWeight) sh.getRange(startRow, stockWeight + 1, n, 1).setValues(stockOut);
  }
  ovFormatOverlayCols_(sh, startRow, n, regionCols, job, weight, total, netWeight, toWeight, fromWeight, stockWeight);
  ovSyncSheetFont_(sh, startRow, n, added);
  ovEnsureFullFilter_(sh);
  return n;
}

/** Calibri 10 на шапке и теле после оверлея (в т.ч. новые колонки). */
function ovSyncSheetFont_(sh, startRow, n, fullSheet) {
  if (!sh) return;
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var lastRow = Math.max(sh.getLastRow(), 1);
  if (typeof styleHeader_ === 'function') {
    try { styleHeader_(sh, lastCol); } catch (eH) {}
  }
  var bodyStart = fullSheet ? 2 : (Number(startRow) || 2);
  var bodyRows = fullSheet ? Math.max(lastRow - 1, 0) : (Number(n) || 0);
  if (bodyRows > 0 && typeof styleBody_ === 'function') {
    try { styleBody_(sh, bodyStart, bodyRows, lastCol); } catch (eB) {}
  }
}

function ovFormatOverlayCols_(sh, startRow, n, regionCols, job, weight, total, netWeight, toWeight, fromWeight, stockWeight) {
  if (!sh || n < 1) return;
  var i;
  for (i = 0; i < regionCols.length; i++) {
    try { sh.setColumnWidth(regionCols[i] + 1, 120); } catch (e0) {}
  }
  function fmtWeight_(col, width) {
    if (col < 0) return;
    try { sh.getRange(startRow, col + 1, n, 1).setNumberFormat('0.000'); } catch (e) {}
    try { sh.setColumnWidth(col + 1, width || 90); } catch (e2) {}
  }
  if (job.kind !== 'wh' && job.kind !== 'region-only') {
    fmtWeight_(weight, 90);
    fmtWeight_(total, 110);
    fmtWeight_(netWeight, 120);
  }
  if (job.kind === 'transit') {
    fmtWeight_(toWeight, 110);
    fmtWeight_(fromWeight, 110);
    if (!job.skipStockWeight) fmtWeight_(stockWeight, 90);
  }
}

function ovStyleOverlayHeaders_(sh, cols) {
  if (!sh || !cols || !cols.length || sh.getLastColumn() < 1) return;
  var unique = {};
  var valid = [];
  for (var i = 0; i < cols.length; i++) {
    var col = Number(cols[i]);
    if (!isFinite(col) || col < 0 || unique[col]) continue;
    unique[col] = true;
    valid.push(col);
  }
  if (!valid.length) return;
  valid.sort(function (a, b) { return a - b; });
  var source = sh.getRange(1, 1);
  var from = valid[0];
  var through = from;
  for (i = 1; i <= valid.length; i++) {
    if (i < valid.length && valid[i] === through + 1) {
      through = valid[i];
      continue;
    }
    source.copyFormatToRange(sh, from + 1, through + 1, 1, 1);
    if (i < valid.length) {
      from = valid[i];
      through = from;
    }
  }
}

function ovEnsureOverlayFilters_(ss, onlySheets) {
  if (!ss) return;
  var names = [];
  if (onlySheets && onlySheets.length) {
    names = onlySheets.slice();
  } else {
    var jobs = ovJobs_();
    names = ovJobSheetNames_(jobs);
    if (names.indexOf('Рекламные расходы') < 0) names.push('Рекламные расходы');
  }
  var seen = {};
  var i;
  for (i = 0; i < names.length; i++) {
    var name = names[i];
    if (!name || seen[name]) continue;
    seen[name] = 1;
    if (typeof clientOverlayTargetSheet_ === 'function' && !clientOverlayTargetSheet_(name)) continue;
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) continue;
    ovEnsureFullFilter_(sh);
  }
}

function ovEnsureFullFilter_(sh) {
  if (!sh) return;
  var lastRow = Math.max(sh.getLastRow(), 1);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  if (lastCol < 1) return;
  var filter = null;
  var criteria = {};
  try { filter = sh.getFilter(); } catch (e0) {}
  if (filter) {
    try {
      var oldRange = filter.getRange();
      if (oldRange.getRow() === 1 && oldRange.getColumn() === 1 &&
          oldRange.getNumRows() === lastRow && oldRange.getNumColumns() === lastCol) return;
      for (var col = 1; col <= oldRange.getLastColumn(); col++) {
        var criterion = filter.getColumnFilterCriteria(col);
        if (criterion) criteria[col] = criterion;
      }
      filter.remove();
    } catch (e1) {
      try { filter.remove(); } catch (e2) {}
    }
  }
  try {
    sh.getRange(1, 1, lastRow, lastCol).createFilter();
    var fullFilter = sh.getFilter();
    var cols = Object.keys(criteria);
    for (var i = 0; i < cols.length; i++) {
      var position = Number(cols[i]);
      if (position <= lastCol) fullFilter.setColumnFilterCriteria(position, criteria[cols[i]]);
    }
  } catch (e3) {
    if (typeof applyFilter_ === 'function') {
      try { applyFilter_(sh); } catch (e4) {}
    }
  }
}

function ovDropStockWeightCol_(sh, job) {
  if (!sh || !job || !job.skipStockWeight) return;
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var stockIdx = ovCol_(headers, ['остатки вес, кг', 'stock_weight_kg']);
  if (stockIdx < 0) return;
  var totalName = job.totalName || 'Общий вес, кг';
  var totalIdx = ovCol_(headers, [String(totalName).toLowerCase(), 'общий вес, кг', 'total_weight_kg']);
  if (totalIdx < 0) return;
  try { sh.deleteColumn(stockIdx + 1); } catch (e) {}
}

function ovJobTotalAliases_(job) {
  if (!job || !job.totalName) return [];
  if (job.totalAliases && job.totalAliases.length) return job.totalAliases.slice();
  return [String(job.totalName).toLowerCase(), 'общий вес, кг', 'вес, кг за 1 шт сумма', 'total_weight_kg'];
}

function ovEnsureReportCols_(sh, job) {
  ovDropStockWeightCol_(sh, job);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var extra = [];
  function need(aliases, fallback) {
    if (ovCol_(headers, aliases) >= 0) return;
    extra.push(fallback);
    headers.push(fallback);
  }
  if (!job.skipRegion) need(['регион поставки'], 'Регион поставки');
  if (job.kind === 'wh' || job.kind === 'region-only') {
    if (extra.length) {
      sh.getRange(1, lastCol + 1, 1, extra.length).setValues([extra]);
      if (typeof styleHeader_ === 'function') {
        try { styleHeader_(sh, lastCol + extra.length); } catch (eH) {}
      }
    }
    return extra.length > 0;
  }
  need(['вес, кг за 1 шт', 'weight_kg'], 'Вес, кг за 1 шт');
  if (job.totalName) need(ovJobTotalAliases_(job), job.totalName);
  if (job.netWeightName) need([String(job.netWeightName).toLowerCase(), 'вес итог, кг с учетом возвратов'], job.netWeightName);
  if (job.kind === 'transit') {
    need(['в пути к покупателю вес, кг', 'in_way_to_weight_kg'], 'В пути к покупателю Вес, кг');
    need(['в пути от покупателя вес, кг', 'in_way_from_weight_kg'], 'В пути от покупателя Вес, кг');
    if (!job.skipStockWeight) need(['остатки вес, кг', 'stock_weight_kg'], 'Остатки вес, кг');
  }
  if (extra.length) {
    sh.getRange(1, lastCol + 1, 1, extra.length).setValues([extra]);
    if (typeof styleHeader_ === 'function') {
      try { styleHeader_(sh, lastCol + extra.length); } catch (eH2) {}
    }
    if (sh.getLastRow() >= 2 && typeof styleBody_ === 'function') {
      try { styleBody_(sh, 2, sh.getLastRow() - 1, sh.getLastColumn()); } catch (eB2) {}
    }
  }
  ovFixWeightHeaders_(sh, job.totalName);
  return extra.length > 0;
}

function ovPolishSheet_(sh) {
  if (!sh) return;
  var lastRow = Math.max(sh.getLastRow(), 1);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var n = lastRow - 1;
  ovSyncSheetFont_(sh, 2, n, true);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var dateFmt = typeof DATE_FMT_ === 'string' ? DATE_FMT_ : 'dd.mm.yyyy';
  try { sh.getRange(1, 1, 1, lastCol).setWrap(true); } catch (eW) {}
  try { sh.setRowHeight(1, 44); } catch (eH) {}
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim().toLowerCase();
    if (!h) continue;
    var width = ovWidthForHeader_(h);
    if (width) sh.setColumnWidth(i + 1, width);
    if (n < 1) continue;
    var col = sh.getRange(2, i + 1, n, 1);
    if (h.indexOf('вес') >= 0) {
      try { col.setNumberFormat('0.000'); } catch (e) {}
    } else if (h.indexOf('дата') >= 0 || h === 'факт' || h === 'план поставки' || h === 'загружено' || h === 'создано' || h === 'обновлено' || h === 'обновлено api' || h.indexOf('изменён') >= 0 || h.indexOf('изменен') >= 0 || h === 'сканирование' || h === 'отказ' || h === 'закрыта когда' || h === 'период с' || h === 'период по') {
      try { col.setNumberFormat(dateFmt); } catch (e2) {}
    } else if (h === 'остаток' || h === 'кол-во' || h === 'количество' || h === 'принято' || h === 'готово к продаже') {
      try { col.setNumberFormat('#,##0'); } catch (e3) {}
    }
    if (h === 'регион поставки' || h === 'регион' || h.indexOf('адрес') >= 0 || h === 'склад' || h === 'название') {
      try { col.setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW); } catch (e4) {}
    }
  }
}

function ovWidthForHeader_(h) {
  if (h === 'регион поставки' || h === 'регион') return 120;
  if (h.indexOf('адрес') >= 0) return 160;
  if (h === 'склад' || h === 'название') return 130;
  if (h.indexOf('вес') >= 0 && (h.indexOf('сумма заказов') >= 0)) return 130;
  if (h.indexOf('вес') >= 0 && (h.indexOf('сумма') >= 0 || h.indexOf('итог') >= 0)) return 110;
  if (h.indexOf('общий вес') >= 0) return 100;
  if (h.indexOf('вес') >= 0) return 90;
  if (h === 'загружено' || h === 'создано' || h === 'обновлено' || h.indexOf('изменён') >= 0 || h.indexOf('изменен') >= 0) return 100;
  if (h.indexOf('дата') >= 0) return 100;
  if (h === 'арт. продавца' || h === 'артикул продавца' || h === 'артикул') return 120;
  if (h === 'город офиса' || h === 'офис') return 120;
  return 0;
}

function ovFixWeightHeaders_(sh, totalName) {
  if (!sh || !totalName) return;
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var unitName = 'Вес, кг за 1 шт';
  var wantTotal = String(totalName).trim();
  var unitSeen = false;
  var hasNamedTotal = false;
  var dupCols = [];
  var i;
  for (i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim();
    var low = h.toLowerCase();
    if (low === wantTotal.toLowerCase() || low === 'общий вес, кг' || low === 'вес, кг за 1 шт сумма') {
      if (h !== unitName) hasNamedTotal = true;
    }
    if (h === unitName) {
      if (!unitSeen) unitSeen = true;
      else dupCols.push(i);
    }
  }
  if (!hasNamedTotal && dupCols.length) {
    sh.getRange(1, dupCols[0] + 1).setValue(wantTotal);
  }
}

function ovRegionCols_(headers) {
  var out = [];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim().toLowerCase();
    if (h === 'регион wb' || h.indexOf('регион wb') >= 0) continue;
    if (h === 'регион поставки' || h === 'регион') out.push(i);
  }
  return out;
}

function ovFindSheet_(ss, names) {
  for (var i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (sh) return sh;
  }
  return null;
}

function ovCol_(headers, aliases) {
  if (!aliases) return -1;
  var lower = [];
  for (var i = 0; i < headers.length; i++) {
    lower.push(String(headers[i] || '').trim().toLowerCase());
  }
  for (var a = 0; a < aliases.length; a++) {
    var want = String(aliases[a] || '').trim().toLowerCase();
    if (!want) continue;
    for (var h = 0; h < lower.length; h++) {
      if (lower[h] === want) return h;
    }
  }
  return -1;
}

function ovCols_(headers, aliases) {
  var out = [];
  var seen = {};
  if (!aliases) return out;
  for (var a = 0; a < aliases.length; a++) {
    var idx = ovCol_(headers, [aliases[a]]);
    if (idx < 0 || seen[idx]) continue;
    seen[idx] = 1;
    out.push(idx);
  }
  return out;
}

function ovFirstFilled_(row, indexes) {
  if (!row || !indexes) return '';
  for (var i = 0; i < indexes.length; i++) {
    var idx = indexes[i];
    if (idx < 0 || idx >= row.length) continue;
    var v = row[idx];
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

function ovColContains_(headers, needle) {
  var want = String(needle || '').toLowerCase();
  var best = -1;
  for (var i = 0; i < headers.length; i++) {
    var name = String(headers[i] || '').toLowerCase();
    if (name.indexOf(want) < 0) continue;
    if (name.indexOf('кг за 1 шт') >= 0) return i;
    if (best < 0) best = i;
  }
  return best;
}

/**
 * Этот кабинет: имя и вес на «ЗаказыЛК» (кнопка листа, не меню).
 * I1 / J1 / K1 — шаблон-формула, на строки данных пишутся уже значения.
 */
function протянутьФормулыЗаказыЛК() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'ЗаказыЛК';
  var sheet = ss.getSheetByName(sheetName);
  var ui = SpreadsheetApp.getUi();
  if (!sheet) {
    ui.alert('Лист «' + sheetName + '» не найден');
    return;
  }
  try { if (sheet.getFilter()) sheet.getFilter().remove(); } catch (eF) {}
  var colA = sheet.getRange('A:A').getValues();
  var lastRow = 0;
  var i;
  for (i = colA.length - 1; i >= 0; i--) {
    if (colA[i][0] !== '' && colA[i][0] !== null) {
      lastRow = i + 1;
      break;
    }
  }
  if (lastRow < 3) {
    ui.alert('Нет данных для заполнения');
    return;
  }
  var n = lastRow - 2;
  sheet.getRange('I1').copyTo(sheet.getRange(3, 9, n, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  sheet.getRange('J1').copyTo(sheet.getRange(3, 10, n, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  sheet.getRange('K1').copyTo(sheet.getRange(3, 11, n, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  SpreadsheetApp.flush();
  var dest = sheet.getRange(3, 9, n, 3);
  dest.setValues(dest.getValues());
  sheet.getRange(2, 1, lastRow, sheet.getLastColumn()).createFilter();
  ui.alert('Имя и вес записаны значениями на «' + sheetName + '» до строки ' + lastRow);
}

/**
 * Лист «Сводная» — те же формулы, что в первой книге, на листы этой.
 * Даты в C3 / C5–C6 / C10–C11 не затираем при повторном запуске.
 */
var SV_SHEET_ = 'Сводная';
var SV_FBS_OFFICE_ = 'Склад поставщика - везу на склад WB';
var SV_SEP_ = ';';
var SV_YELLOW_ = '#ffff00';
var SV_ORANGE_ = '#ffc000';

function создатьСводная() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  try {
    svWriteSheet_(ss);
    SpreadsheetApp.getUi().alert(
      'Сводная: формулы записаны. Меняйте даты в C3 (сутки), C5–C6 (период), C10–C11 (в пути FBW).'
    );
    if (typeof reportLog_ === 'function') reportLog_(ss, SV_SHEET_, 'отчёт', 1, 'формулы', Date.now() - t0);
  } catch (err) {
    try { SpreadsheetApp.getUi().alert('«Сводная»: ' + err); } catch (e1) {}
  }
}

function svWriteSheet_(ss) {
  var cols = svResolveCols_(ss);
  var sh = ss.getSheetByName(SV_SHEET_);
  var keep = null;
  if (sh) {
    keep = {
      c3: sh.getRange('C3').getValue(),
      c5: sh.getRange('C5').getValue(),
      c6: sh.getRange('C6').getValue(),
      c10: sh.getRange('C10').getValue(),
      c11: sh.getRange('C11').getValue(),
      row13: sh.getRange(13, 3, 1, 10).getValues()[0],
      names: sh.getRange(15, 3, 1, 10).getValues()[0],
      dates: sh.getRange(18, 3, 1, 10).getValues()[0]
    };
    try { sh.getRange(1, 1, Math.max(sh.getMaxRows(), 20), Math.max(sh.getMaxColumns(), 17)).breakApart(); } catch (eB) {}
  } else {
    sh = ss.insertSheet(SV_SHEET_, 0);
  }
  if (sh.getMaxColumns() < 17) sh.insertColumnsAfter(sh.getMaxColumns(), 17 - sh.getMaxColumns());
  if (sh.getMaxRows() < 22) sh.insertRowsAfter(sh.getMaxRows(), 22 - sh.getMaxRows());
  sh.clear();
  try { sh.setHiddenGridlines(true); } catch (eG) {}
  try { sh.setTabColor('#c27c0e'); } catch (eT) {}

  var dates = svDefaultDates_(keep);
  sh.getRange('C3').setValue(dates.c3);
  sh.getRange('C5').setValue(dates.c5);
  sh.getRange('C6').setValue(dates.c6);
  sh.getRange('C10').setValue(dates.c10);
  sh.getRange('C11').setValue(dates.c11);
  sh.getRange('C3:C6').setNumberFormat('dd.mm.yyyy');
  sh.getRange('C10:C11').setNumberFormat('dd.mm.yyyy');

  svWriteKpi_(sh, cols);
  svWriteStock_(sh, cols);
  svWriteAttacked_(sh, cols, keep);
  svStyleSvodnaya_(sh);
}

function svDefaultDates_(keep) {
  var tz = typeof TZ !== 'undefined' ? TZ : 'Europe/Moscow';
  var now = new Date();
  var iso = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var parts = iso.split('-');
  var today = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  var yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  var monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  function pick(v, fallback) {
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    return fallback;
  }
  return {
    c3: keep ? pick(keep.c3, yest) : yest,
    c5: keep ? pick(keep.c5, monthStart) : monthStart,
    c6: keep ? pick(keep.c6, today) : today,
    c10: keep ? pick(keep.c10, monthStart) : monthStart,
    c11: keep ? pick(keep.c11, today) : today
  };
}

function svExpandAliases_(sheet, names) {
  var out = [];
  var seen = {};
  function add(s) {
    s = String(s || '').trim().toLowerCase();
    if (!s || seen[s]) return;
    seen[s] = 1;
    out.push(s);
  }
  var i;
  for (i = 0; i < names.length; i++) {
    add(names[i]);
    if (typeof ruName_ === 'function') add(ruName_(sheet, names[i]));
    if (typeof COLUMN_RU !== 'undefined' && COLUMN_RU[names[i]]) add(COLUMN_RU[names[i]]);
  }
  if (seen.quantity || seen['количество'] || seen['кол-во']) {
    add('кол-во');
    add('количество');
    add('quantity');
  }
  return out;
}

function svResolveCols_(ss) {
  function need(name, names, headerRow) {
    var sh = ss.getSheetByName(name);
    if (!sh) throw new Error('Нет листа «' + name + '»');
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var row = headerRow || 1;
    var headers = sh.getRange(row, 1, 1, lastCol).getValues()[0];
    var aliases = svExpandAliases_(name, names);
    var idx = ovCol_(headers, aliases);
    if (idx < 0) {
      var have = [];
      var h;
      for (h = 0; h < headers.length && have.length < 24; h++) {
        var t = String(headers[h] || '').trim();
        if (t) have.push(t);
      }
      throw new Error('На «' + name + '» нет колонки «' + names[0] + '». На листе: ' + have.join(', '));
    }
    return { sheet: name, letter: svColLetter_(idx + 1) };
  }
  var lkDate = need('ЗаказыЛК', ['день', 'дата'], 2);
  var lkQty = need('ЗаказыЛК', ['заказано, шт.', 'заказано, шт'], 2);
  var lkSum = need('ЗаказыЛК', ['сумма заказов минус комиссия wb, руб.', 'сумма заказов'], 2);
  var lkKg = need('ЗаказыЛК', ['вес, кг за 1 шт сумма'], 2);
  var fbsDate = need('Заказы FBS', ['создано', 'created_at', 'дата']);
  var fbsKg = need('Заказы FBS', ['вес, кг за 1 шт сумма']);
  var finDate = need('Финансовые ежедневные', ['дата iso', 'дата', 'rr_dt']);
  var finType = need('Финансовые ежедневные', ['тип документа', 'doc_type_name']);
  var finOffice = need('Финансовые ежедневные', ['офис', 'склад', 'office_name']);
  var finQty = need('Финансовые ежедневные', ['кол-во', 'quantity']);
  var finRub = need('Финансовые ежедневные', ['сумма розн.', 'retail_amount']);
  var finKg = need('Финансовые ежедневные', ['вес итог, кг с учетом возвратов']);
  var finKvv = need('Финансовые ежедневные', ['квв %', 'commission_percent']);
  var adsDate = need('Рекламные расходы', ['дата', 'дата статы', 'stat_date']);
  var adsCost = need('Рекламные расходы', ['расходы рекламы']);
  var fbw = 'Остатки FBW';
  var trDate = need(fbw, ['дата снимка', 'snapshot_date', 'дата']);
  var trStock = need(fbw, ['кол-во', 'quantity', 'остаток']);
  var trTo = need(fbw, ['в пути к клиенту', 'в пути к покупателю', 'inWayToClient', 'in_way_to_client']);
  var trFrom = need(fbw, ['в пути от клиента', 'в пути от покупателя', 'inWayFromClient', 'in_way_from_client']);
  var trToKg = need(fbw, ['в пути к покупателю вес, кг', 'in_way_to_weight_kg']);
  var trFromKg = need(fbw, ['в пути от покупателя вес, кг', 'in_way_from_weight_kg']);
  var trStockKg = need(fbw, ['общий вес, кг', 'total_weight_kg', 'вес, кг за 1 шт сумма']);
  var fbwDate = need('Поставки FBW', ['дата поставки', 'supply_date', 'supply_dt']);
  var fbwStatus = need('Поставки FBW', ['статус', 'status_name']);
  var fbwQty = need('Поставки FBW', ['кол-во', 'количество', 'quantity']);
  var fbwKg = need('Поставки FBW', ['общий вес, кг', 'total_weight_kg']);
  var pFbsDate = need('Поставки FBS', ['создано', 'createdAt', 'created_at', 'дата', 'загружено', 'loaded_at']);
  var pFbsStatus = need('Поставки FBS', ['статус wb', 'статус wb код', 'wb_status', 'wbStatus_name']);
  var pFbsKg = need('Поставки FBS', ['вес, кг за 1 шт сумма']);
  var stDate = need('Остатки FBW', ['дата снимка', 'snapshot_date', 'дата']);
  var stWh = need('Остатки FBW', ['склад', 'warehouse_name']);
  var stQty = need('Остатки FBW', ['кол-во', 'quantity', 'остаток']);
  var stKg = need('Остатки FBW', ['общий вес, кг', 'вес, кг за 1 шт сумма', 'total_weight_kg']);
  return {
    lkDate: lkDate, lkQty: lkQty, lkSum: lkSum, lkKg: lkKg,
    fbsDate: fbsDate, fbsKg: fbsKg,
    finDate: finDate, finType: finType, finOffice: finOffice,
    finQty: finQty, finRub: finRub, finKg: finKg, finKvv: finKvv,
    adsDate: adsDate, adsCost: adsCost,
    trDate: trDate, trStock: trStock, trTo: trTo, trFrom: trFrom,
    trToKg: trToKg, trFromKg: trFromKg, trStockKg: trStockKg,
    fbwDate: fbwDate, fbwStatus: fbwStatus, fbwQty: fbwQty, fbwKg: fbwKg,
    pFbsDate: pFbsDate, pFbsStatus: pFbsStatus, pFbsKg: pFbsKg,
    stDate: stDate, stWh: stWh, stQty: stQty, stKg: stKg
  };
}

function svColLetter_(n) {
  var s = '';
  var x = n;
  while (x > 0) {
    var m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function svSifs_(ref, sumLetter, pairs) {
  var parts = ["SUMIFS('" + ref.sheet + "'!$" + sumLetter + ":$" + sumLetter];
  var i;
  for (i = 0; i < pairs.length; i++) {
    parts.push("'" + ref.sheet + "'!$" + pairs[i][0] + ":$" + pairs[i][0]);
    parts.push(pairs[i][1]);
  }
  return parts.join(SV_SEP_) + ')';
}

function svCifs_(ref, pairs) {
  var parts = ['COUNTIFS('];
  var bits = [];
  var i;
  for (i = 0; i < pairs.length; i++) {
    bits.push("'" + ref.sheet + "'!$" + pairs[i][0] + ":$" + pairs[i][0]);
    bits.push(pairs[i][1]);
  }
  return 'COUNTIFS(' + bits.join(SV_SEP_) + ')';
}

function svDay_(letter, cell) {
  return [[letter, '">="&' + cell], [letter, '"<"&(' + cell + '+1)']];
}

function svEq_(letter, cell) {
  return [[letter, '"="&' + cell]];
}

function svPeriod_(letter, fromCell, toCell) {
  return [[letter, '">="&' + fromCell], [letter, '"<="&' + toCell]];
}

function svPeriodDt_(letter, fromCell, toCell) {
  return [[letter, '">="&' + fromCell], [letter, '"<"&(' + toCell + '+1)']];
}

function svFinNet_(cols, valLetter, datePairs, officeCrit) {
  var typeL = cols.finType.letter;
  var officeL = cols.finOffice.letter;
  var salePairs = datePairs.concat([[typeL, '"Продажа"']]);
  var retPairs = datePairs.concat([[typeL, '"Возврат"']]);
  if (officeCrit) {
    salePairs = salePairs.concat([[officeL, officeCrit]]);
    retPairs = retPairs.concat([[officeL, officeCrit]]);
  }
  var sale = svSifs_(cols.finRub, valLetter, salePairs);
  var ret = svSifs_(cols.finRub, valLetter, retPairs);
  return sale + '-' + ret;
}

function svFinSigned_(cols, valLetter, datePairs, officeCrit) {
  var typeL = cols.finType.letter;
  var officeL = cols.finOffice.letter;
  var salePairs = datePairs.concat([[typeL, '"Продажа"']]);
  var retPairs = datePairs.concat([[typeL, '"Возврат"']]);
  if (officeCrit) {
    salePairs = salePairs.concat([[officeL, officeCrit]]);
    retPairs = retPairs.concat([[officeL, officeCrit]]);
  }
  return svSifs_({ sheet: cols.finKg.sheet }, valLetter, salePairs) + '+' +
    svSifs_({ sheet: cols.finKg.sheet }, valLetter, retPairs);
}

function svOfficeNe_() {
  return '"<>' + SV_FBS_OFFICE_ + '"';
}

function svOfficeEq_() {
  return '"' + SV_FBS_OFFICE_ + '"';
}

function svWriteKpi_(sh, cols) {
  sh.getRange('B2').setValue('Показатель');
  sh.getRange('D2').setValue('Вид показателя');
  var headers = [
    'Объем FBS+FBW, кг', 'Объем FBW, кг', 'Объем FBS, кг',
    'Сумма заказов, руб.', 'Заказов FBS+FBW', 'Заказов FBW', 'Заказов FBS',
    'Цена за кг', 'Сумма расходов по рекламе', 'Доля рекламы %', 'Комиссия ВБ %',
    'FBW', 'FBS'
  ];
  sh.getRange(2, 5, 1, headers.length).setValues([headers]);
  sh.getRange('B2:Q2').setBackground(SV_YELLOW_);
  try { sh.getRange('B2:C2').merge(); } catch (eB2) {}

  sh.getRange('B3').setValue('Сутки');
  sh.getRange('B5').setValue('За период');
  sh.getRange('B3:B6').setBackground(SV_ORANGE_);
  sh.getRange('C3:C6').setBackground(SV_ORANGE_);
  try { sh.getRange('B3:B4').merge(); } catch (e1) {}
  try { sh.getRange('C3:C4').merge(); } catch (e2) {}
  try { sh.getRange('B5:B6').merge(); } catch (e3) {}

  sh.getRange('D3').setValue('Заказано');
  sh.getRange('D4').setValue('Выкуплено');
  sh.getRange('D5').setValue('Заказано');
  sh.getRange('D6').setValue('Выкуплено');

  var fbs = cols.fbsDate;

  var finDateL = cols.finDate.letter;

  // сутки — заказано
  var e3 = svSifs_(cols.lkKg, cols.lkKg.letter, svEq_(cols.lkDate.letter, '$C3'));
  var g3 = svSifs_(cols.fbsKg, cols.fbsKg.letter, svDay_(cols.fbsDate.letter, '$C3'));
  var h3 = svSifs_(cols.lkSum, cols.lkSum.letter, svEq_(cols.lkDate.letter, '$C3'));
  var i3 = svSifs_(cols.lkQty, cols.lkQty.letter, svEq_(cols.lkDate.letter, '$C3'));
  var k3 = svCifs_(fbs, svDay_(cols.fbsDate.letter, '$C3'));
  sh.getRange('E3').setFormula('=' + e3);
  sh.getRange('F3').setFormula('=E3-G3');
  sh.getRange('G3').setFormula('=' + g3);
  sh.getRange('H3').setFormula('=' + h3);
  sh.getRange('I3').setFormula('=' + i3);
  sh.getRange('J3').setFormula('=I3-K3');
  sh.getRange('K3').setFormula('=' + k3);

  // сутки — выкуплено
  var dayFin = svEq_(finDateL, '$C3');
  sh.getRange('E4').setFormula('=F4+G4');
  sh.getRange('F4').setFormula('=' + svFinSigned_(cols, cols.finKg.letter, dayFin, svOfficeNe_()));
  sh.getRange('G4').setFormula('=' + svFinSigned_(cols, cols.finKg.letter, dayFin, svOfficeEq_()));
  sh.getRange('H4').setFormula('=' + svFinNet_(cols, cols.finRub.letter, dayFin, null));
  sh.getRange('I4').setFormula('=J4+K4');
  sh.getRange('J4').setFormula('=' + svFinNet_(cols, cols.finQty.letter, dayFin, svOfficeNe_()));
  sh.getRange('K4').setFormula('=' + svFinNet_(cols, cols.finQty.letter, dayFin, svOfficeEq_()));
  sh.getRange('L4').setFormula('=IF(E4=0;"";H4/E4)');
  sh.getRange('M4').setFormula('=' + svSifs_(cols.adsCost, cols.adsCost.letter, svEq_(cols.adsDate.letter, '$C3')));
  sh.getRange('N4').setFormula('=IF(H4=0;"";M4/H4)');
  sh.getRange('O4').setFormula('=' + svAvgKvv_(cols, dayFin, null));
  sh.getRange('P4').setFormula('=' + svAvgKvv_(cols, dayFin, svOfficeNe_()));
  sh.getRange('Q4').setFormula('=' + svAvgKvv_(cols, dayFin, svOfficeEq_()));

  // период — заказано
  var e5 = svSifs_(cols.lkKg, cols.lkKg.letter, svPeriod_(cols.lkDate.letter, '$C5', '$C6'));
  var g5 = svSifs_(cols.fbsKg, cols.fbsKg.letter, svPeriodDt_(cols.fbsDate.letter, '$C5', '$C6'));
  var h5 = svSifs_(cols.lkSum, cols.lkSum.letter, svPeriod_(cols.lkDate.letter, '$C5', '$C6'));
  var i5 = svSifs_(cols.lkQty, cols.lkQty.letter, svPeriod_(cols.lkDate.letter, '$C5', '$C6'));
  var k5 = svCifs_(fbs, svPeriodDt_(cols.fbsDate.letter, '$C5', '$C6'));
  sh.getRange('E5').setFormula('=' + e5);
  sh.getRange('F5').setFormula('=E5-G5');
  sh.getRange('G5').setFormula('=' + g5);
  sh.getRange('H5').setFormula('=' + h5);
  sh.getRange('I5').setFormula('=' + i5);
  sh.getRange('J5').setFormula('=I5-K5');
  sh.getRange('K5').setFormula('=' + k5);

  var perFin = svPeriod_(finDateL, '$C5', '$C6');
  sh.getRange('E6').setFormula('=F6+G6');
  sh.getRange('F6').setFormula('=' + svFinSigned_(cols, cols.finKg.letter, perFin, svOfficeNe_()));
  sh.getRange('G6').setFormula('=' + svFinSigned_(cols, cols.finKg.letter, perFin, svOfficeEq_()));
  sh.getRange('H6').setFormula('=' + svFinNet_(cols, cols.finRub.letter, perFin, null));
  sh.getRange('I6').setFormula('=J6+K6');
  sh.getRange('J6').setFormula('=' + svFinNet_(cols, cols.finQty.letter, perFin, svOfficeNe_()));
  sh.getRange('K6').setFormula('=' + svFinNet_(cols, cols.finQty.letter, perFin, svOfficeEq_()));
  sh.getRange('L6').setFormula('=IF(E6=0;"";H6/E6)');
  sh.getRange('M6').setFormula('=' + svSifs_(cols.adsCost, cols.adsCost.letter, svPeriod_(cols.adsDate.letter, '$C5', '$C6')));
  sh.getRange('N6').setFormula('=IF(H6=0;"";M6/H6)');
  sh.getRange('O6').setFormula('=' + svAvgKvv_(cols, perFin, null));
  sh.getRange('P6').setFormula('=' + svAvgKvv_(cols, perFin, svOfficeNe_()));
  sh.getRange('Q6').setFormula('=' + svAvgKvv_(cols, perFin, svOfficeEq_()));
}

function svAvgKvv_(cols, datePairs, officeCrit) {
  var kvv = cols.finKvv.letter;
  var dateL = cols.finDate.letter;
  var officeL = cols.finOffice.letter;
  var pairs = datePairs.concat([[kvv, '"<>0"']]);
  if (officeCrit) pairs = pairs.concat([[officeL, officeCrit]]);
  var bits = ["'" + cols.finKvv.sheet + "'!$" + kvv + ":$" + kvv];
  var i;
  for (i = 0; i < pairs.length; i++) {
    bits.push("'" + cols.finKvv.sheet + "'!$" + pairs[i][0] + ":$" + pairs[i][0]);
    bits.push(pairs[i][1]);
  }
  return 'AVERAGEIFS(' + bits.join(SV_SEP_) + ')';
}

function svFbsOpenPairs_(statusLetter) {
  return [
    [statusLetter, '"<>продано"'],
    [statusLetter, '"<>sold"'],
    [statusLetter, '"<>отмена клиента"'],
    [statusLetter, '"<>canceled_by_client"'],
    [statusLetter, '"<>отменено покупателем при получении"'],
    [statusLetter, '"<>отказ клиента"'],
    [statusLetter, '"<>declined_by_client"']
  ];
}

function svSumLatestSnap_(valRef, valLetter, dateRef) {
  var s = "'" + valRef.sheet + "'";
  var dL = dateRef.letter;
  var vL = valLetter;
  return 'SUMIFS(' + s + '!$' + vL + ':$' + vL + ',' + s + '!$' + dL + ':$' + dL + ',MAX(' + s + '!$' + dL + ':$' + dL + '))';
}

function svWriteStock_(sh, cols) {
  sh.getRange('B8').setValue('Остатки продукци на складе ВБ');
  try { sh.getRange('B8:O8').merge(); } catch (e8) {}
  sh.getRange('B8').setBackground(SV_YELLOW_);
  sh.getRange('B9').setValue('Показатель');
  sh.getRange('D9').setValue('Вид показателя');
  sh.getRange(9, 5, 1, 11).setValues([[
    'Заказано FBS+FBW', 'Заказано FBW', 'Заказано FBS',
    'В пути от пок-ля FBW', 'На складе', '', '',
    'В пути FBW', 'Итого остатки на ВБ', 'Атаковано', 'Итого остатки +атаковано'
  ]]);
  sh.getRange('B9:O9').setBackground(SV_YELLOW_);
  try { sh.getRange('B9:C9').merge(); } catch (e9) {}

  sh.getRange('B10').setValue('За период');
  try { sh.getRange('B10:B11').merge(); } catch (e10) {}
  sh.getRange('B10:C11').setBackground(SV_ORANGE_);
  sh.getRange('D10').setValue('шт');
  sh.getRange('D11').setValue('кг');

  sh.getRange('E10').setFormula('=F10+G10');
  sh.getRange('F10').setFormula('=' + svSumLatestSnap_(cols.trTo, cols.trTo.letter, cols.trDate));
  var g10pairs = svPeriodDt_(cols.pFbsDate.letter, '$C10', '$C11').concat(svFbsOpenPairs_(cols.pFbsStatus.letter));
  sh.getRange('G10').setFormula('=' + svCifs_(cols.pFbsDate, g10pairs));
  sh.getRange('H10').setFormula('=' + svSumLatestSnap_(cols.trFrom, cols.trFrom.letter, cols.trDate));
  sh.getRange('I10').setFormula('=' + svSumLatestSnap_(cols.trStock, cols.trStock.letter, cols.trDate));
  var l10 = svSifs_(cols.fbwQty, cols.fbwQty.letter, svPeriod_(cols.fbwDate.letter, '$C$10', '$C$11').concat([
    [cols.fbwStatus.letter, '"<>Принято"']
  ]));
  sh.getRange('L10').setFormula('=' + l10);
  sh.getRange('M10').setFormula('=L10+I10+E10+H10');
  sh.getRange('N10').setFormula('=M16');
  sh.getRange('O10').setFormula('=M10+N10');

  sh.getRange('E11').setFormula('=F11+G11');
  sh.getRange('F11').setFormula('=' + svSumLatestSnap_(cols.trToKg, cols.trToKg.letter, cols.trDate));
  var g11pairs = [
    [cols.pFbsDate.letter, '"<="&$C11']
  ].concat(svFbsOpenPairs_(cols.pFbsStatus.letter));
  sh.getRange('G11').setFormula('=' + svSifs_(cols.pFbsKg, cols.pFbsKg.letter, g11pairs));
  sh.getRange('H11').setFormula('=' + svSumLatestSnap_(cols.trFromKg, cols.trFromKg.letter, cols.trDate));
  sh.getRange('I11').setFormula('=' + svSumLatestSnap_(cols.trStockKg, cols.trStockKg.letter, cols.trDate));
  var l11 = svSifs_(cols.fbwKg, cols.fbwKg.letter, svPeriod_(cols.fbwDate.letter, '$C$10', '$C$11').concat([
    [cols.fbwStatus.letter, '"<>Принято"']
  ]));
  sh.getRange('L11').setFormula('=' + l11);
  sh.getRange('M11').setFormula('=L11+I11+E11+H11');
  sh.getRange('N11').setFormula('=M17');
  sh.getRange('O11').setFormula('=M11+N11');
}

function svWriteAttacked_(sh, cols, keep) {
  var names = [
    'Электросталь', 'Коледино', 'Краснодар', 'Склад Шушары', 'Сарапул',
    'Пенза WB', 'Волгоград', 'Новосемейкино', 'Тула', 'Котовск'
  ];
  if (keep && keep.names) {
    var i;
    for (i = 0; i < 10; i++) {
      if (keep.names[i] != null && String(keep.names[i]).trim() !== '') names[i] = keep.names[i];
    }
  }
  var dateRow = [];
  var i2;
  var fallbackDate = sh.getRange('C3').getValue();
  for (i2 = 0; i2 < 10; i2++) {
    var d = keep && keep.row13 && keep.row13[i2];
    dateRow.push(d instanceof Date && !isNaN(d.getTime()) ? d : fallbackDate);
  }

  sh.getRange(13, 3, 1, 10).setValues([dateRow]);
  sh.getRange(13, 3, 1, 10).setNumberFormat('dd.mm.yyyy');
  try { sh.getRange('C14:K14').merge(); } catch (e14) {}
  sh.getRange('C14').setValue('Пострадавшие склады');
  sh.getRange('C14').setBackground(SV_YELLOW_);
  sh.getRange('B15').setValue('Склад');
  sh.getRange(15, 3, 1, 10).setValues([names]);
  sh.getRange('M15').setValue('Итого атаковано');
  sh.getRange('B16').setValue('шт');
  sh.getRange('B17').setValue('кг');
  sh.getRange('B18').setValue('Дата атаки');
  if (keep && keep.dates) sh.getRange(18, 3, 1, 10).setValues([keep.dates]);
  sh.getRange(18, 3, 1, 10).setNumberFormat('dd.mm.yyyy');

  var letters = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  var j;
  for (j = 0; j < letters.length; j++) {
    var col = letters[j];
    var qty = svSifs_(cols.stQty, cols.stQty.letter, [
      [cols.stWh.letter, col + '$15'],
      [cols.stDate.letter, col + '$13']
    ]);
    var kg = svSifs_(cols.stKg, cols.stKg.letter, [
      [cols.stWh.letter, col + '$15'],
      [cols.stDate.letter, col + '$13']
    ]);
    sh.getRange(col + '16').setFormula('=' + qty);
    sh.getRange(col + '17').setFormula('=' + kg);
  }
  sh.getRange('M16').setFormula('=SUM(C16:L16)');
  sh.getRange('M17').setFormula('=SUM(C17:L17)');
}

function svStyleSvodnaya_(sh) {
  sh.setColumnWidth(1, 24);
  sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 100);
  sh.setColumnWidth(4, 90);
  var c;
  for (c = 5; c <= 17; c++) sh.setColumnWidth(c, 88);
  var rng = sh.getRange(1, 1, 18, 17);
  rng.setFontFamily('Calibri').setFontSize(9).setVerticalAlignment('middle');
  sh.getRange('B2:Q2').setFontWeight('bold').setWrap(true);
  sh.getRange('B9:O9').setFontWeight('bold').setWrap(true);
  sh.getRange('E3:G3').setNumberFormat('#,##0.00');
  sh.getRange('H3').setNumberFormat('#,##0.00');
  sh.getRange('I3:K3').setNumberFormat('#,##0');
  sh.getRange('E4:G4').setNumberFormat('#,##0.00');
  sh.getRange('H4').setNumberFormat('#,##0.00');
  sh.getRange('I4:K4').setNumberFormat('#,##0');
  sh.getRange('L4:M4').setNumberFormat('#,##0.00');
  sh.getRange('N4').setNumberFormat('0.00%');
  sh.getRange('O4:Q4').setNumberFormat('0.00');
  sh.getRange('E5:G5').setNumberFormat('#,##0.00');
  sh.getRange('H5').setNumberFormat('#,##0.00');
  sh.getRange('I5:K5').setNumberFormat('#,##0');
  sh.getRange('E6:G6').setNumberFormat('#,##0.00');
  sh.getRange('H6').setNumberFormat('#,##0.00');
  sh.getRange('I6:K6').setNumberFormat('#,##0');
  sh.getRange('L6:M6').setNumberFormat('#,##0.00');
  sh.getRange('N6').setNumberFormat('0.00%');
  sh.getRange('O6:Q6').setNumberFormat('0.00');
  sh.getRange('E10:O10').setNumberFormat('#,##0');
  sh.getRange('E11:O11').setNumberFormat('#,##0.00');
  sh.getRange('C16:M16').setNumberFormat('#,##0');
  sh.getRange('C17:M17').setNumberFormat('#,##0.00');
  sh.setFrozenRows(2);
}
