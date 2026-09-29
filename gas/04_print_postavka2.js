/**
 * Этот кабинет: печать «Поставка_2» и «Поставка_new» по штрихкодам из «Товар+Вес».
 * Другому кабинету не копировать. Общие скрипты (01/03/05–08) этот файл не требуют.
 *
 * Две выгрузки:
 * 1) упаковочный лист с распределением по коробам;
 * 2) простой Excel «Баркод + Количество».
 *
 * Поставка_2 — склад в B5, функции downloadReportByWarehouse2 / downloadSimpleBarcodeList2.
 * Поставка_new — блок в B4 («Склад WB» / «Склад продавца»),
 * функции downloadReportByWarehouse3 / downloadSimpleBarcodeList3.
 */

function print2Col_(headers, names) {
  for (var n = 0; n < names.length; n++) {
    var want = String(names[n]).trim().toLowerCase().replace(/ё/g, 'е');
    for (var i = 0; i < headers.length; i++) {
      var have = String(headers[i] || '').trim().toLowerCase().replace(/ё/g, 'е');
      if (have === want) return i;
    }
  }
  return -1;
}

function print2Number_(value) {
  var n = parseFloat(String(value == null ? '' : value).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function print2IsTotalRow_(art) {
  return String(art || '').trim().toUpperCase() === 'ИТОГО';
}

function print2Reference_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Товар+Вес');
  var result = {};
  if (!sheet || sheet.getLastRow() < 2) return result;
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var artCol = print2Col_(headers, ['Артикул', 'Арт. продавца', 'Ваш артикул']);
  var weightCol = print2Col_(headers, ['Вес, кг за 1 шт']);
  var barcodeCol = print2Col_(headers, ['Штрих-код', 'Штрихкод', 'Штрих код']);
  var drawingCol = print2Col_(headers, ['Чертеж', 'Чертёж']);
  var volumeCol = print2Col_(headers, ['Обьем упаковки', 'Объём упаковки', 'Объем упаковки']);
  var piecesCol = print2Col_(headers, ['Количество в упаковке']);
  if (artCol < 0) return result;
  for (var i = 1; i < data.length; i++) {
    var art = reportNormArt_(data[i][artCol]);
    if (!art) continue;
    result[art] = {
      weight: weightCol < 0 ? 0 : print2Number_(data[i][weightCol]),
      barcode: barcodeCol < 0 ? '' : String(data[i][barcodeCol] || '').trim().replace(/\s/g, ''),
      drawing: drawingCol < 0 ? '' : String(data[i][drawingCol] || ''),
      volume: volumeCol < 0 ? 0 : print2Number_(data[i][volumeCol]),
      piecesPerPackage: piecesCol < 0 ? 1 : (parseInt(data[i][piecesCol], 10) || 1)
    };
  }
  return result;
}

function print2Selection_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Поставка_2');
  if (!sheet) throw new Error('Лист «Поставка_2» не найден');
  var warehouse = String(sheet.getRange('B5').getValue() || '').trim();
  if (!warehouse || warehouse === 'Выберите склад') throw new Error('Выберите склад в B5 на листе «Поставка_2»');
  var lastCol = sheet.getLastColumn();
  var regionRow = sheet.getRange(4, 1, 1, lastCol).getDisplayValues()[0];
  var subRow = sheet.getRange(5, 1, 1, lastCol).getDisplayValues()[0];
  var currentRegion = '', pencilCol = -1, region = '';
  for (var col = POSTAVKA2_REGION_START_; col <= lastCol; col++) {
    if (regionRow[col - 1]) currentRegion = String(regionRow[col - 1]).trim();
    if (String(subRow[col - 1] || '').trim() === warehouse) {
      pencilCol = col + 7;
      region = currentRegion || 'Не указан';
      break;
    }
  }
  if (pencilCol < 0 || pencilCol > lastCol) throw new Error('Для склада «' + warehouse + '» не найдена колонка ✏️');
  var orders = printCollectOrders_(sheet, pencilCol);
  if (!orders.length) throw new Error('Нет товаров с заявкой для склада «' + warehouse + '»');
  return { warehouse: warehouse, region: region, channel: 'WB', orders: orders };
}

function print3Selection_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Поставка_new');
  if (!sheet) throw new Error('Лист «Поставка_new» не найден');
  var raw = String(sheet.getRange('B4').getValue() || '').replace(/\s+/g, ' ').trim();
  var blocks = ['Склад WB', 'Склад продавца'];
  if (!raw || raw === 'Выберите блок' || blocks.indexOf(raw) < 0) {
    throw new Error('Выберите блок в B4: «Склад WB» или «Склад продавца»');
  }
  var pencilCol = print3FindPencilCol_(sheet, raw);
  if (pencilCol < 1) throw new Error('Не найдена колонка ✏️ для блока «' + raw + '»');
  var orders = printCollectOrders_(sheet, pencilCol);
  if (!orders.length) throw new Error('Нет товаров с заявкой по блоку «' + raw + '»');
  return {
    warehouse: raw,
    region: raw,
    channel: raw === 'Склад продавца' ? 'FBS' : 'WB',
    orders: orders
  };
}

function print3FindPencilCol_(sheet, blockName) {
  var lastCol = sheet.getLastColumn();
  if (lastCol >= 3) {
    var row4 = sheet.getRange(4, 1, 1, lastCol).getValues()[0];
    var row6 = sheet.getRange(6, 1, 1, lastCol).getValues()[0];
    var start = -1;
    var c;
    for (c = 0; c < row4.length; c++) {
      if (String(row4[c] || '').trim() === blockName) {
        start = c;
        break;
      }
    }
    if (start >= 0) {
      var found = -1;
      for (c = start; c < row6.length; c++) {
        var title = String(row4[c] || '').trim();
        if (c > start && title && title !== blockName) break;
        if (String(row6[c] || '').indexOf('✏') >= 0) found = c + 1;
      }
      if (found > 0) return found;
    }
  }
  if (typeof POSTAVKA_WH_START_ === 'number' && blockName === 'Склад WB') {
    return POSTAVKA_WH_START_ + POSTAVKA_WH_WIDTH_ - 1;
  }
  if (typeof POSTAVKA_FBS_START_ === 'number' && blockName === 'Склад продавца') {
    return POSTAVKA_FBS_START_ + POSTAVKA_FBS_WIDTH_ - 1;
  }
  return -1;
}

function printCollectOrders_(sheet, pencilCol) {
  var orders = [];
  if (sheet.getLastRow() < 8) return orders;
  var numRows = sheet.getLastRow() - 7;
  var products = sheet.getRange(8, 1, numRows, 2).getValues();
  var quantities = sheet.getRange(8, pencilCol, numRows, 1).getValues();
  for (var i = 0; i < products.length; i++) {
    if (!products[i][0] || print2IsTotalRow_(products[i][0])) continue;
    var qty = print2Number_(quantities[i][0]);
    if (qty <= 0) continue;
    orders.push({
      art: String(products[i][0]),
      name: String(products[i][1] || ''),
      packs: qty
    });
  }
  return orders;
}

function print2Stamp_(now) {
  function two_(v) { return String(v).padStart(2, '0'); }
  return {
    date: two_(now.getDate()) + '.' + two_(now.getMonth() + 1) + '.' + now.getFullYear(),
    file: now.getFullYear() + two_(now.getMonth() + 1) + two_(now.getDate()) + '_' +
      two_(now.getHours()) + '-' + two_(now.getMinutes()) + '-' + two_(now.getSeconds())
  };
}

function printSafeTitle_(fileName) {
  var name = String(fileName || 'поставка').replace(/\.xlsx$/i, '');
  name = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  if (!name) name = 'поставка';
  return name.slice(0, 180);
}

function printCreateBook_(fileName) {
  var title = printSafeTitle_(fileName);
  var book = SpreadsheetApp.create(title);
  try { book.rename(title); } catch (e0) {}
  try { DriveApp.getFileById(book.getId()).setName(title); } catch (e1) {}
  return book;
}

function print2ShowDownload_(book, fileName, title, details, width, height) {
  var safeTitle = printSafeTitle_(fileName);
  var xlsxName = safeTitle + '.xlsx';
  try { book.rename(safeTitle); } catch (e0) {}
  SpreadsheetApp.flush();
  var id = book.getId();
  var bookFile = DriveApp.getFileById(id);
  try { bookFile.setName(safeTitle); } catch (e1) {}
  var downloadFile = bookFile;
  var url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx';
  try {
    var token = ScriptApp.getOAuthToken();
    var resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      followRedirects: true,
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() === 200) {
      var ctype = '';
      try {
        var headers = resp.getHeaders();
        ctype = String(headers['Content-Type'] || headers['content-type'] || '');
      } catch (eH) {}
      if (ctype.toLowerCase().indexOf('html') < 0) {
        var blob = resp.getBlob()
          .setName(xlsxName)
          .setContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        downloadFile = DriveApp.createFile(blob);
        try { bookFile.setTrashed(true); } catch (eTrash) {}
        var dl = downloadFile.getDownloadUrl();
        if (dl) url = dl;
      }
    }
  } catch (eExport) {}
  var html = HtmlService.createHtmlOutput(
    '<html><body style="font-family:Arial;text-align:center;padding:20px">' +
    '<h3>✅ ' + title + '</h3><p><strong>' + xlsxName + '</strong></p>' +
    '<p>' + details + '</p><br>' +
    '<a href="' + url + '" download="' + xlsxName.replace(/"/g, '') + '" target="_blank" ' +
    'style="background:#4CAF50;color:white;padding:10px 20px;text-decoration:none;border-radius:5px">📥 Скачать Excel</a>' +
    '<br><br><button onclick="google.script.host.close()">Закрыть</button></body></html>'
  ).setWidth(width || 450).setHeight(height || 300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Скачивание');
  Utilities.sleep(30000);
  try { downloadFile.setTrashed(true); } catch (e2) {}
  try { bookFile.setTrashed(true); } catch (e3) {}
}

function printWritePacking_(selected) {
  var ref = print2Reference_();
  var expanded = [];
  var boxLimitVolume = 0.014;
  var boxLimitWeight = 23;
  var box = 1, boxVolume = 0, boxWeight = 0;
  var i;

  for (i = 0; i < selected.orders.length; i++) {
    var item = selected.orders[i];
    var info = ref[reportNormArt_(item.art)] || {
      weight: 0, volume: 0, piecesPerPackage: 1, drawing: '', barcode: ''
    };
    var packsLeft = item.packs;
    var pieces = info.piecesPerPackage || 1;
    var volumePerPack = (Number(info.volume) || 0) * pieces;
    var weightPerPack = (Number(info.weight) || 0) * pieces;
    while (packsLeft > 0) {
      var byVolume = volumePerPack > 0
        ? Math.floor((boxLimitVolume - boxVolume + 1e-9) / volumePerPack)
        : Infinity;
      var byWeight = weightPerPack > 0
        ? Math.floor((boxLimitWeight - boxWeight + 1e-9) / weightPerPack)
        : Infinity;
      var fits = Math.min(byVolume, byWeight, packsLeft);
      if (fits > 0) {
        expanded.push({
          drawing: info.drawing || '', weight: info.weight || 0,
          name: item.name, barcode: info.barcode || '', box: box,
          art: item.art, packs: fits, pieces: pieces, volume: info.volume || 0
        });
        boxVolume = Math.round((boxVolume + fits * volumePerPack) * 1e6) / 1e6;
        boxWeight = Math.round((boxWeight + fits * weightPerPack) * 1e6) / 1e6;
        packsLeft -= fits;
      } else if (boxVolume > 0 || boxWeight > 0) {
        box++;
        boxVolume = 0;
        boxWeight = 0;
      } else {
        expanded.push({
          drawing: info.drawing || '', weight: info.weight || 0,
          name: item.name, barcode: info.barcode || '', box: box,
          art: item.art, packs: packsLeft, pieces: pieces, volume: info.volume || 0
        });
        packsLeft = 0;
      }
    }
  }
  if (!expanded.length) throw new Error('Не удалось разложить заявку по коробкам');

  var now = new Date();
  var stamp = print2Stamp_(now);
  var fileName = selected.warehouse + '_' + stamp.file + '.xlsx';
  var book = printCreateBook_(fileName);
  var sheet = book.getActiveSheet();
  sheet.setName('УПАКОВКА');
  var headers = ['Чертеж', 'Вес 1 шт, кг', 'Наименование товара', 'Штрих код', 'Объем коробки',
    'Объем упаковки', 'Объем заказа', '№ коробки', 'Артикул', 'Кол-во, упаковок',
    'Кол-во в упак.', 'Кол-во, шт.', 'Общий вес, кг', 'Факт. вес, кг'];
  sheet.getRange(1, 1, 1, 3).setValues([[stamp.date, selected.channel || 'WB', selected.warehouse]])
    .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold');
  sheet.getRange(2, 1, 1, headers.length).setValues([headers]).setFontFamily(STYLE_FONT_)
    .setFontSize(STYLE_SIZE_).setFontWeight('bold').setBackground('#ffff00').setHorizontalAlignment('center')
    .setVerticalAlignment('middle').setWrap(true).setBorder(true, true, true, true, false, false);
  var values = [];
  for (i = 0; i < expanded.length; i++) {
    var d = expanded[i], row = i + 3;
    values.push([d.drawing, d.weight, d.name, d.barcode, boxLimitVolume, d.volume,
      '=F' + row + '*L' + row, d.box, d.art, d.packs, d.pieces,
      '=J' + row + '*K' + row, '=B' + row + '*L' + row, '']);
  }
  sheet.getRange(3, 1, values.length, 14).setValues(values).setFontFamily(STYLE_FONT_)
    .setFontSize(STYLE_SIZE_).setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true);
  var sumRow = values.length + 3;
  sheet.getRange(sumRow, 7, 1, 7).setValues([[
    '=SUM(G3:G' + (sumRow - 1) + ')', '', '', '=SUM(J3:J' + (sumRow - 1) + ')', '',
    '=SUM(L3:L' + (sumRow - 1) + ')', '=SUM(M3:M' + (sumRow - 1) + ')'
  ]]).setBackground('#00ff00').setFontWeight('bold');
  sheet.getRange(3, 2, values.length, 1).setNumberFormat('0.000');
  sheet.getRange(3, 4, values.length, 1).setNumberFormat('0');
  sheet.getRange(3, 5, values.length, 3).setNumberFormat('0.000000');
  sheet.getRange(3, 10, values.length, 1).setFontWeight('bold');
  sheet.getRange(3, 13, values.length, 2).setNumberFormat('0.000');
  sheet.getRange(sumRow, 7).setNumberFormat('0.000000');
  sheet.getRange(sumRow, 10, 1, 3).setNumberFormat('0');
  sheet.getRange(sumRow, 13).setNumberFormat('0.000');

  var deliveryRow = sumRow + 2;
  sheet.getRange(deliveryRow, 2, 1, 3).merge().setValue('Отгрузка')
    .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold')
    .setBackground('#ffff00').setHorizontalAlignment('center')
    .setBorder(true, true, true, true, false, false);
  var deliveryLabels = ['Дата готовности:', 'Дата отгрузки:', 'Тайм слот:'];
  for (i = 0; i < deliveryLabels.length; i++) {
    var labelRow = deliveryRow + 1 + i;
    sheet.getRange(labelRow, 2, 1, 2).merge().setValue(deliveryLabels[i])
      .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold')
      .setBorder(true, true, true, true, false, false);
    sheet.getRange(labelRow, 4).setValue('').setBorder(true, true, true, true, false, false);
    if (i < 2) sheet.getRange(labelRow, 4).setNumberFormat('dd.mm.yyyy');
  }
  sheet.getRange(1, 9, 1, 6).merge()
    .setValue('Коробов: ' + Math.max.apply(null, expanded.map(function (x) { return x.box; })))
    .setFontFamily(STYLE_FONT_).setFontSize(STYLE_SIZE_).setFontWeight('bold')
    .setHorizontalAlignment('center');
  try {
    sheet.getRange(1, 5, 1, 3).shiftColumnGroupDepth(1);
    sheet.getColumnGroup(5, 1).collapse();
  } catch (eGroup) {}
  var widths = [190, 100, 550, 140, 100, 100, 100, 85, 190, 85, 85, 85, 100, 100];
  for (i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  sheet.setFrozenRows(2);
  sheet.getRange(2, 1, Math.max(1, values.length + 1), headers.length).createFilter();
  print2ShowDownload_(book, fileName, 'Упаковочный лист готов',
    'Коробов: ' + Math.max.apply(null, expanded.map(function (x) { return x.box; })) +
    '<br>Склад: ' + selected.warehouse + ' (' + selected.region + ')', 450, 330);
}

function printWriteBarcodes_(selected) {
  var ref = print2Reference_();
  var rows = [];
  for (var i = 0; i < selected.orders.length; i++) {
    var item = selected.orders[i];
    var barcode = (ref[reportNormArt_(item.art)] || {}).barcode;
    if (barcode) rows.push([barcode, Math.round(item.packs)]);
  }
  if (!rows.length) {
    throw new Error(selected.orders.length
      ? 'Заявка есть, но штрихкоды на «Товар+Вес» не найдены'
      : 'Нет товаров с заявкой');
  }
  var stamp = print2Stamp_(new Date());
  var fileName = selected.warehouse + '_' + stamp.file + '.xlsx';
  var book = printCreateBook_(fileName);
  var sheet = book.getActiveSheet();
  sheet.setName('Штрихкоды');
  sheet.getRange(1, 1, 1, 2).setValues([['Баркод', 'Количество']]).setFontWeight('bold');
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  print2ShowDownload_(book, fileName, 'Список штрихкодов готов',
    'Товаров: ' + rows.length + '<br>Склад: ' + selected.warehouse, 400, 270);
}

function downloadReportByWarehouse2() {
  try {
    printWritePacking_(print2Selection_());
  } catch (err) {
    SpreadsheetApp.getUi().alert('Печать Поставка_2: ' + err);
  }
}

function downloadSimpleBarcodeList2() {
  try {
    printWriteBarcodes_(print2Selection_());
  } catch (err) {
    SpreadsheetApp.getUi().alert('Штрихкоды Поставка_2: ' + err);
  }
}

function downloadReportByWarehouse3() {
  try {
    printWritePacking_(print3Selection_());
  } catch (err) {
    SpreadsheetApp.getUi().alert('Печать Поставка_new: ' + err);
  }
}

function downloadSimpleBarcodeList3() {
  try {
    printWriteBarcodes_(print3Selection_());
  } catch (err) {
    SpreadsheetApp.getUi().alert('Штрихкоды Поставка_new: ' + err);
  }
}
