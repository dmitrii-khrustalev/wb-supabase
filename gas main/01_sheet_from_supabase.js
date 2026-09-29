/**
 * Google Sheets ← база кабинета WB (без обращений к API WB из этой книги).
 *
 * 1. Файл 01 (этот): ядро, любой кабинет. Только листы из Postgres.
 * 2. Файл 02 — только этому кабинету (вес, регион, ЗаказыЛК). Без него загрузка
 *    заканчивается на сырье из базы. Если 02 есть, вызывается после загрузки.
 * 3. Отчёты из базы — файл 03. Вес / ЗаказыЛК / регион — хуки из 02, иначе RPC.
 * 4. Меню «📊 Данные WB» → Сервис → «Ключ базы»: JWT (eyJ…), не короткий sb_…
 * 5. Меню → Сервис → «Настройки загрузки»: какие листы качать и за сколько дней.
 *    _Настройки прячется, код его всё равно читает.
 *    Меню «Листы данных»: скрыть/показать финансы, заказы и остальное сырьё.
 *    Скрытые листы утро и «Загрузить всё» всё равно обновляют.
 *    «Загрузить всё» — как утро: сначала info daily / monthly / stock, потом сырьё.
 * 6. Меню → Сервис → «Колонки листов»: какие поля базы писать на каждый лист.
 *    Обязательные (дата, ключ строки, входы info) снять нельзя.
 *
 * payload не пишем. extra jsonb раскладывается в колонки.
 * Окно дат: колонка «Дней» на _Настройки (пусто / «все» = без окна). МСК.
 * Повторная загрузка: старше окна удаляем, середину не трогаем, из базы только вчера
 * (снимки — сегодня; заказы/поставки — короткое окно + открытые поставки). Overlay (если есть 02) —
 * только на новые строки; если оверлей сам добавил колонку, заполняет весь лист.
 * Товары / склады — целиком. Остатки — последние N дней снимков из базы.
 * Утро: сначала новый день (несколько листов за тик), потом подрезка старого окна
 * со всех листов. DMZ: оверлей только по новому хвосту, затем подрезка.
 * Страховка 7 мин, пауза 20 с. Лимит GAS ~6 мин.
 */

var APP_NAME_ = '📊 Данные WB';
var DB_URL_DEFAULT_ = 'https://evghcmeqaelckagyxgmk.supabase.co';
var SETTINGS_SHEET = '_Настройки';
var SETTINGS_HEADER = [
  'Лист', 'View', 'Колонка даты', 'Дней', 'Вкл', 'Режим', 'Кабинет', 'Страница', 'Сортировка',
  'Данные за / на', 'Обновлено'
];
var COLUMNS_SHEET = '_Колонки';
var DMZ_COLUMNS_SOURCE_ID_ = '1mAITdQLjCDNJPQ_I531MCXSQEhwpImA7TsyrlnmDJbQ';
var COLUMNS_HEADER = ['Лист', 'Ключ', 'Русское', 'Порядок', 'ID-текст', 'Вкл'];
var LOG_SHEET = '_Лог';
var TZ = 'Europe/Moscow'; // как в ЛК WB; даты на листах и в отчётах — календарь Москвы
var TIME_BUDGET_MS = 5 * 60 * 1000; // до лимита GAS 6 мин оставляем ~1 мин на хвост
var SHEET_DATE_BOUNDS_FULL_SCAN_MAX_ = 3000;
var OVERLAY_RESERVE_MS_ = 90 * 1000;
var SHEET_WRITE_CHUNK_ = 1200;
var SHEET_HEAVY_ROWS_ = 5000;
var SHEET_HEAVY_COLS_ = 40;
var RESUME_KEY = 'SHEET_RESUME';
var LOAD_SESSION_KEY_ = 'SHEET_LOAD_SESSION';
var CONTINUE_HANDLER_ = 'continueLoadFromTrigger_';
var CONTINUE_AFTER_MS_ = 20 * 1000;
var MORNING_CHAIN_HANDLER_ = 'runMorningChainTick_';
var MORNING_SAFETY_HANDLER_ = 'runMorningChainSafety_';
var MORNING_JOB_KEY_ = 'MORNING_JOB_SHEET';
var MORNING_CHAIN_ON_KEY_ = 'MORNING_CHAIN_ON';
var MORNING_SAFETY_MS_ = 7 * 60 * 1000;
var MORNING_GAP_MS_ = 20 * 1000;
var MORNING_REPORTS_JOB_ = '__reports__';
var MORNING_TRIM_JOB_ = '__trim__';
var MORNING_PHASE_KEY_ = 'MORNING_PHASE';
var MORNING_TRIM_INDEX_KEY_ = 'MORNING_TRIM_INDEX';
var MORNING_STATS_KEY_ = 'MORNING_STATS';
var DAILY_START_HANDLER_ = 'startDailySheetWatch_';
var DAILY_CHECK_HANDLER_ = 'checkDailySheetReady_';
var DAILY_TRIGGERED_KEY_ = 'DAILY_SHEET_TRIGGERED_DATE';
var DAILY_LOAD_AFTER_DASH_KEY_ = 'DAILY_LOAD_AFTER_DASH';
var DAILY_WATCH_DATE_KEY_ = 'DAILY_SHEET_WATCH_DATE';
var DAILY_WATCH_ATTEMPTS_KEY_ = 'DAILY_SHEET_WATCH_ATTEMPTS';
var DAILY_DASH_STARTED_KEY_ = 'DAILY_DASH_STARTED_DATE';
var DAILY_MORNING_STARTED_KEY_ = 'DAILY_MORNING_STARTED_DATE';
var MORNING_BATCH_DATASETS_KEY_ = 'MORNING_BATCH_DATASETS';
var MORNING_LOAD_ACTIVE_KEY_ = 'MORNING_LOAD_ACTIVE';
var DAILY_CHECK_AFTER_MS_ = 5 * 60 * 1000;
var DAILY_CHECK_BUSY_MS_ = 60 * 1000;
var DAILY_CHECK_STOP_HHMM_ = 1200;
var DAILY_FINAL_SUMMARY_HHMM_ = 700;
var DAILY_SUMMARY_DONE_KEY_ = 'MORNING_SUMMARY_DONE';
var DAILY_START_HOUR_ = 6;
var DAILY_START_MINUTE_ = 0;
var BOOK_SLUG_ = 'main';

function fetchSellerSchedule_() {
  try {
    var slug = resolveActiveSlug_();
    var pack = dbRpc_('get_seller_schedule', { p_slug: slug });
    return pack && typeof pack === 'object' ? pack : {};
  } catch (eSched) {
    Logger.log('fetchSellerSchedule_: ' + eSched);
    return {};
  }
}

function parseScheduleTime_(hhmm, fallbackHour, fallbackMinute) {
  var m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: fallbackHour, minute: fallbackMinute };
  var h = Number(m[1]);
  var min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }
  return { hour: h, minute: min };
}

function gasDailyEnableLabel_() {
  return '⏰ Включить';
}

function gasDailyRunLabel_() {
  return '▶️ Запустить утро';
}

function gasDailyStartParts_() {
  var sched = fetchSellerSchedule_();
  return parseScheduleTime_(sched.gas_daily_at, DAILY_START_HOUR_, DAILY_START_MINUTE_);
}
var SHEET_LOAD_HANDLER_ = 'pollSheetLoadRequest_';
var SHEET_POLL_DISABLED_KEY_ = 'SHEET_POLL_DISABLED';
var SHEET_REQ_KEY_ = 'SHEET_LOAD_REQUEST_ID';
var DASH_QUEUE_KEY_ = 'MORNING_DASH_QUEUE';
var DASH_HANDLER_ = 'runQueuedDashboards_';
var DASH_AFTER_MS_ = 20 * 1000;
var SS_ID_KEY_ = 'SHEET_FILE_ID';
var LOAD_SETTINGS_SNAPSHOT_KEY_ = 'LOAD_SETTINGS_SNAP';
var SS_CACHE_ = null;
var STYLE_FONT_ = 'Calibri';
var STYLE_SIZE_ = 10;
var STYLE_HEADER_BG_ = '#f1f1f1';

function applyBookFont_(range) {
  if (!range) return range;
  var font = typeof STYLE_FONT_ !== 'undefined' ? STYLE_FONT_ : 'Calibri';
  var size = typeof STYLE_SIZE_ !== 'undefined' ? STYLE_SIZE_ : 10;
  return range.setFontFamily(font).setFontSize(size);
}

var ID_KEYS = {
  seller_id: 1, rrd_id: 1, nm_id: 1, barcode: 1, shk_id: 1, advert_id: 1,
  srid: 1, sale_id: 1, income_id: 1, return_id: 1, event_id: 1, feedback_id: 1, question_id: 1,
  row_key: 1,
  chrt_id: 1, imt_id: 1, supply_id: 1, warehouse_id: 1, office_id: 1,
  sku: 1, skus: 1, order_id: 1, rid: 1, order_uid: 1, article: 1,
  vendor_code: 1, sa_name: 1, supplier_article: 1, trbx_id: 1, part_a: 1, part_b: 1,
  preorder_id: 1, sticker_barcode: 1, chrt_id: 1
};

var COLUMN_RU = {
  seller_id: 'ID кабинета',
  rrd_id: 'ID строки',
  nm_id: 'Артикул WB',
  nmId: 'Артикул WB',
  nmID: 'Артикул WB',
  sa_name: 'Арт. продавца',
  supplierArticle: 'Арт. продавца',
  vendor_code: 'Арт. продавца',
  vendorCode: 'Арт. продавца',
  barcode: 'Штрихкод',
  doc_type_name: 'Тип документа',
  quantity: 'Кол-во',
  retail_amount: 'Сумма розн.',
  office_name: 'Склад',
  warehouse_name: 'Склад',
  warehouseName: 'Склад',
  supplier_oper_name: 'Операция',
  rr_dt: 'Дата ISO',
  shk_id: 'ID ШК',
  loaded_at: 'Загружено',
  commission_percent: 'кВВ %',
  ppvz_kvw_prc: 'кВВ без НДС',
  ppvz_kvw_prc_base: 'кВВ база',
  advert_id: 'ID кампании',
  advertId: 'ID кампании',
  stat_date: 'Дата статы',
  app_type: 'Площадка',
  appType: 'Площадка',
  name: 'Название',
  views: 'Показы',
  clicks: 'Клики',
  spend: 'Сумма API',
  sum: 'Сумма API',
  atbs: 'Корзина',
  orders: 'Заказы рек.',
  shks: 'Выкупы рек.',
  cpc: 'CPC',
  ctr: 'CTR %',
  cr: 'CR %',
  payment_type: 'Источник списания',
  paymentType: 'Источник списания',
  lastChangeDate: 'Изменено',
  last_change_dt: 'Изменено',
  warehouseType: 'Тип склада',
  countryName: 'Страна',
  oblastOkrugName: 'Округ',
  country_name: 'Страна',
  region_name: 'Регион WB',
  regionName: 'Регион WB',
  category: 'Категория',
  subject: 'Предмет',
  subject_name: 'Предмет',
  subjectName: 'Предмет',
  stat_date: 'Дата',
  open_count: 'Просмотры',
  cart_count: 'В корзину',
  order_count: 'Заказы',
  order_sum: 'Сумма заказов',
  buyout_count: 'Выкупы',
  buyout_sum: 'Сумма выкупов',
  buyout_percent: '% выкупа',
  add_to_cart_conversion: 'Конверсия в корзину %',
  cart_to_order_conversion: 'Корзина → заказ %',
  add_to_wishlist_count: 'В избранное',
  title: 'Название',
  volume: 'Объём',
  brand: 'Бренд',
  techSize: 'Размер',
  tech_size: 'Размер',
  incomeID: 'ID поставки',
  isSupply: 'Поставка?',
  isRealization: 'Реализация?',
  totalPrice: 'Цена без скидок',
  total_price: 'Цена без скидок',
  discountPercent: 'Скидка прод. %',
  discount_percent: 'Скидка прод. %',
  spp: 'Скидка WB %',
  finishedPrice: 'Цена итог',
  finished_price: 'Цена итог',
  priceWithDisc: 'Цена со скидкой',
  discounted_price: 'Цена со скидкой',
  club_discounted_price: 'Цена клуба',
  isCancel: 'Отмена?',
  is_cancel: 'Отмена?',
  cancelDate: 'Дата отмены',
  orderType: 'Тип заказа',
  sticker: 'Стикер',
  gNumber: '№ заказа',
  srid: 'ID заказа',
  sale_id: 'ID продажи',
  sale_dt: 'Дата продажи',
  income_id: 'ID поступления',
  income_dt: 'Дата поступления',
  return_id: 'ID возврата',
  return_type: 'Тип возврата',
  reason: 'Причина',
  completed_dt: 'Дата получения',
  status_updated_at: 'Статус обновлён',
  cancel_type: 'Тип отмены',
  destination_city: 'Город',
  destination_district: 'Округ',
  seller_price: 'Цена продавца',
  is_mp: 'Маркетплейс?',
  is_b2b: 'B2B?',
  event_id: 'ID события',
  feedback_id: 'ID отзыва',
  question_id: 'ID вопроса',
  feedback_dt: 'Дата отзыва',
  question_dt: 'Дата вопроса',
  product_valuation: 'Оценка',
  product_name: 'Товар',
  brand_name: 'Бренд',
  pros: 'Достоинства',
  cons: 'Недостатки',
  is_answered: 'Есть ответ?',
  answer_text: 'Ответ',
  user_name: 'Покупатель',
  order_status: 'Статус заказа',
  was_viewed: 'Просмотрено?',
  is_warned: 'Предупреждение?',
  query_text: 'Поисковый запрос',
  level: 'Уровень',
  tariff_dt: 'Дата тарифа',
  kind: 'Вид тарифа',
  box_type: 'Тип тары',
  row_key: 'Ключ строки',
  description: 'Описание',
  rate_value: 'Ставка',
  boxDeliveryLiter: 'Доставка короба, ₽/л',
  boxStorageLiter: 'Хранение короба, ₽/л',
  palletDeliveryValueLiter: 'Доставка паллеты, ₽/л',
  palletStorageValueExpr: 'Хранение паллеты',
  deliveryDumpSupOfficeLiter: 'Возврат КГТ, ₽/л',
  kgvpMarketplace: 'КВВ маркетплейс, %',
  paidStorageKgvp: 'КВВ хранение, %',
  coefficient: 'Коэф. приёмки',
  allowUnload: 'Разгрузка разрешена',
  frequency: 'Частота',
  visibility: 'Видимость',
  text: 'Текст',
  status_name: 'Статус',
  price_with_disc: 'Цена со скидкой',
  is_supply: 'Поставка?',
  is_realization: 'Реализация?',
  supplyID: 'ID поставки',
  supply_id: 'ID поставки',
  preorderID: 'ID заказа',
  createDate: 'Создана',
  supplyDate: 'План поставки',
  factDate: 'Факт',
  statusID: 'Код статуса',
  boxTypeID: 'Код тары',
  actualWarehouseName: 'Склад факт',
  color: 'Цвет',
  acceptedQuantity: 'Принято',
  readyForSaleQuantity: 'К продаже',
  updatedDate: 'Обновлено',
  warehouseId: 'ID склада',
  warehouse_id: 'ID склада',
  officeId: 'ID офиса',
  office_id: 'ID офиса',
  deliveryType: 'Код схемы',
  delivery_type: 'Код схемы',
  deliveryType_name: 'Схема',
  cargoType: 'Код габарита',
  cargo_type: 'Код габарита',
  cargoType_name: 'Габарит',
  chrtId: 'ID размера',
  chrt_id: 'ID размера',
  amount: 'Остаток',
  sku: 'SKU',
  title: 'Название',
  wbSize: 'Размер WB',
  wb_size: 'Размер WB',
  skus: 'Штрихкоды',
  sizes: 'Размеры',
  address: 'Адрес',
  city: 'Город',
  federalDistrict: 'Округ',
  isDeleting: 'Удаляется',
  isProcessing: 'В обработке',
  selected: 'Выбран',
  longitude: 'Долгота',
  latitude: 'Широта',
  rid: 'RID',
  orderUid: 'UID заказа',
  order_uid: 'UID заказа',
  createdAt: 'Создано',
  created_at: 'Создано',
  article: 'Арт. в заказе',
  offices: 'Офисы',
  supplyId: 'ID поставки FBS',
  price: 'Цена API',
  price_rub: 'Цена, ₽',
  currency: 'Валюта',
  imt_id: 'ID ИМТ',
  snapshot_date: 'Дата снимка',
  price_date: 'Дата цены',
  order_dt: 'Дата заказа',
  supplier_article: 'Арт. продавца',
  details_loaded: 'Детали загружены',
  supplier_status: 'Статус прод. код',
  supplierStatus: 'Статус прод. код',
  supplierStatus_name: 'Статус продавца',
  wb_status: 'Статус WB код',
  wbStatus: 'Статус WB код',
  wbStatus_name: 'Статус WB',
  source: 'Источник',
  part_a: 'Стикер A',
  sticker_barcode: 'Штрихкод стикера',
  supply_name: 'Название поставки',
  office_name: 'Офис',
  office_address: 'Адрес офиса',
  office_city: 'Город офиса',
  part_b: 'Стикер B',
  sticker_partA: 'Стикер A',
  sticker_partB: 'Стикер B',
  done: 'Закрыта',
  done_name: 'Статус',
  trbx_id: 'ID короба',
  trbxId: 'ID короба',
  order_id: 'ID задания',
  orderId: 'ID задания',
  is_active: 'Активен',
  slug: 'Код кабинета',
  isCancellable: 'Можно отменить',
  isB2b: 'B2B',
  closedAt: 'Закрыта когда',
  scanDt: 'Сканирование',
  ordersCount: 'Заданий',
  trbxCount: 'Коробов',
  isZeroOrder: 'Нулевой заказ',
  colorCode: 'Код цвета',
  requiredMeta: 'Мета обяз.',
  optionalMeta: 'Мета доп.',
  stickerId: 'ID стикера',
  parcel: 'Посылка',
  year: 'Год',
  month: 'Месяц',
  rejectDt: 'Отказ',
  recommendedWh: 'Реком. склад',
  recommendedWhId: 'ID реком. склада',
  isPickupPointShipment: 'Самовывоз',
  comment: 'Комментарий',
  canceled: 'Отмены рек.',
  sum_price: 'Сумма цен',
  inWayToClient: 'В пути к клиенту',
  inWayFromClient: 'В пути от клиента',
  in_way_to_client: 'В пути к покупателю',
  in_way_from_client: 'В пути от покупателя',
  in_way_to_weight_kg: 'В пути к покупателю Вес, кг',
  in_way_from_weight_kg: 'В пути от покупателя Вес, кг',
  stock_weight_kg: 'Остатки вес, кг',
  region: 'Регион',
  options: 'Опции',
  characteristics: 'Характеристики',
  description: 'Описание',
  dimensions: 'Габариты',
  documents: 'Документы',
  kizMarked: 'КИЗ проставлен',
  needKiz: 'Нужен КИЗ',
  nmUUID: 'UUID карточки',
  photos: 'Фото',
  subjectID: 'ID предмета',
  length: 'Длина, см',
  width: 'Ширина, см',
  height: 'Высота, см',
  weightBrutto: 'Вес брутто, кг',
  weightBrutto: 'Вес брутто, кг',
  preorder_id: 'ID заказа',
  create_date: 'Дата создания',
  supply_date: 'Дата поставки',
  fact_date: 'Факт дата',
  status_id: 'Код статуса',
  status_name: 'Статус',
  box_type_id: 'Код тары',
  box_type_name: 'Тип коробки',
  accepted_quantity: 'Принято',
  ready_for_sale: 'К продаже',
  weight_kg: 'Вес, кг за 1 шт',
  total_weight_kg: 'Общий вес, кг',
  updatedAt: 'Обновлено API',
  storeId: 'ID магазина',
  isBoxOnPallet: 'Короб на паллете',
  phone: 'Телефон',
  supplierBoxAmount: 'Коробов поставщика',
  tnved: 'ТН ВЭД',
  unloadingQuantity: 'К разгрузке',
  convertedCurrencyCode: 'Валюта конв.',
  convertedPrice: 'Цена конв.',
  currencyCode: 'Валюта',
  scanPrice: 'Цена скана',
  crossBorderType: 'Код кроссбордер',
  crossBorderType_name: 'Кроссбордер',
  acceptance: 'Приёмка',
  acquiring_bank: 'Банк эквайринга',
  acquiring_fee: 'Эквайринг',
  acquiring_percent: 'Эквайринг %',
  additional_payment: 'Доплаты',
  article_substitution: 'Подмена артикула',
  assembly_id: 'ID сборочного',
  b2b_customer_tin: 'ИНН B2B',
  bonus_type_name: 'Тип бонуса',
  brand_name: 'Бренд',
  cashback_amount: 'Кешбэк',
  cashback_commission_change: 'Кешбэк, комиссия',
  cashback_discount: 'Кешбэк, скидка',
  create_dt: 'Дата создания фин.',
  currency_name: 'Валюта отчёта',
  date_from: 'Период с',
  date_to: 'Период по',
  declaration_number: '№ декларации',
  deduction: 'Удержания',
  delivery_amount: 'Кол-во доставок',
  delivery_method: 'Способ доставки',
  delivery_rub: 'Логистика ₽',
  dlv_prc: 'Логистика %',
  fix_tariff_date_from: 'Фикс. тариф с',
  fix_tariff_date_to: 'Фикс. тариф по',
  gi_box_type_name: 'Тип короба поставки',
  gi_id: 'ID поставки фин.',
  installment_cofinancing_amount: 'Софинанс. рассрочки',
  is_kgvp_v2: 'Признак КВВ v2',
  is_legal_entity: 'Юрлицо',
  kiz: 'КИЗ',
  loyalty_discount: 'Скидка лояльности',
  loyalty_id: 'ID лояльности',
  paid_with_social_certificate: 'Соцсертификат',
  payment_processing: 'Эквайринг обработка',
  payment_schedule: 'График платежей',
  penalty: 'Штраф',
  ppvz_for_pay: 'К перечислению',
  ppvz_inn: 'ИНН ППВЗ',
  ppvz_office_id: 'ID офиса ППВЗ',
  ppvz_office_name: 'Офис ППВЗ',
  ppvz_reward: 'Возм. за выдачу',
  ppvz_sales_commission: 'Вознаграждение WB',
  ppvz_spp_prc: 'СПП %',
  ppvz_supplier_id: 'ID партнёра ППВЗ',
  ppvz_supplier_name: 'Партнёр ППВЗ',
  ppvz_vw: 'Вознаграждение ВБ',
  ppvz_vw_nds: 'НДС с возн. ВБ',
  product_discount_for_report: 'Продуктовый дисконт',
  realizationreport_id: 'ID отчёта',
  rebill_logistic_cost: 'Перевыставл. логистика',
  rebill_logistic_org: 'Организатор перевозки',
  report_type: 'Тип отчёта',
  retail_price: 'Цена розн.',
  retail_price_withdisc_rub: 'Цена со скидкой ₽',
  return_amount: 'Кол-во возвратов',
  sale_dt: 'Дата продажи',
  sale_percent: 'Скидка соглас. %',
  sale_price_affiliated_discount_prc: 'Скидка аффил. %',
  sale_price_promocode_discount_prc: 'Скидка промокод %',
  sale_price_wholesale_discount_prc: 'Скидка опт %',
  seller_promo_discount: 'Промо продавца',
  seller_promo_id: 'ID промо продавца',
  site_country: 'Страна продажи',
  srv_dbs: 'Признак DBS',
  sticker_id: 'ID стикера фин.',
  storage_fee: 'Хранение',
  sup_rating_prc_up: 'Надбавка рейтинга %',
  supplier_promo: 'Промокод поставщика',
  suppliercontract_code: 'Код договора',
  ts_name: 'Размер фин.',
  uuid_promocode: 'UUID промокода',
  warehouse_logistics_coeff: 'Коэф. логистики склада',
  wibes_wb_discount_percent: 'Скидка Wibes %',
  cityName: 'Город',
  foName: 'Федеральный округ',
  saleInvoiceCostPrice: 'Сумма реализации',
  saleInvoiceCostPricePerc: 'Доля в реализации %',
  saleItemInvoiceQty: 'Кол-во в реализации',
  sa: 'Арт. продавца',
  warehouse_region: 'Регион склада',
  dstOfficeId: 'ID ПВЗ',
  dstOfficeAddress: 'Адрес ПВЗ',
  readyToReturnDt: 'Готов к возврату',
  expiredDt: 'Дата просрочки',
  isStatusActive: 'Статус активен',
  forPay: 'К перечислению',
  forpay: 'К перечислению',
  photoLinks: 'Фото',
  video: 'Видео',
  matchingSize: 'Размер подошёл',
  bables: 'Метки',
  supplierFeedbackValuation: 'Оценка ответа прод.',
  supplierProductValuation: 'Оценка товара прод.',
  isAbleReturnProductOrders: 'Можно вернуть?',
  parentFeedbackId: 'ID родит. отзыва',
  childFeedbackId: 'ID дочерн. отзыва',
  retention_dt: 'Дата удержания',
  service_dt: 'Дата услуги',
  paid_storage: 'Платное хранение',
  acceptance: 'Платная приёмка',
  claim_id: 'ID заявки',
  claim_dt: 'Дата заявки',
  claim_updated_dt: 'Обновлено',
  claim_type: 'Тип заявки',
  status_ex: 'Статус (расш.)',
  user_comment: 'Комментарий покупателя',
  wb_comment: 'Комментарий WB',
  currency_code: 'Код валюты',
  is_archive: 'В архиве?',
  promo_id: 'ID акции',
  promo_name: 'Акция',
  promo_type: 'Тип акции',
  start_dt: 'Начало акции',
  end_dt: 'Окончание акции',
  in_action: 'Участвует?',
  plan_price: 'Плановая цена',
  plan_discount: 'Плановая скидка %',
  discount: 'Скидка %',
  photos: 'Фото',
  video_paths: 'Видео',
  actions: 'Действия',
  origin_id_info: 'Проверка IMEI',
  logWarehouseCoef: 'Коэф. лог. хранения',
  warehouseCoef: 'Коэф. склада',
  officeId: 'ID офиса',
  giId: 'ID поставки',
  calcType: 'Способ расчёта',
  warehousePrice: 'Сумма хранения',
  barcodesCount: 'Кол-во штрихкодов',
  palletPlaceCode: 'Код паллетоместа',
  palletCount: 'Кол-во паллет',
  originalDate: 'Дата перв. расчёта',
  loyaltyDiscount: 'Скидка лояльности',
  tariffFixDate: 'Дата фикс. тарифа',
  tariffLowerDate: 'Дата пониж. тарифа',
  giCreateDate: 'Дата создания поставки',
  shkCreateDate: 'Дата приёмки',
  count: 'Кол-во',
  total: 'Сумма',
  advantages: 'Преимущества',
  inPromoActionLeftovers: 'В акции (остатки)',
  inPromoActionTotal: 'В акции всего',
  notInPromoActionLeftovers: 'Не в акции (остатки)',
  notInPromoActionTotal: 'Не в акции всего',
  participationPercentage: '% участия',
  currencyCode: 'Валюта',
  planPrice: 'Плановая цена',
  planDiscount: 'Плановая скидка %',
  measurement: 'Габариты',
  substitution: 'Подмены',
  labeling: 'Маркировка',
  excise: 'Товары с ОМ',
  antifraud: 'Самовыкупы',
  income_id: 'ID поставки',
  bonusType: 'Причина',
  prcOver: 'Превышение габаритов %',
  penaltyAmount: 'Штраф',
  reversalAmount: 'Сторно',
  isValid: 'Обмер подтверждён?',
  oldVendorCode: 'Старый арт.',
  newVendorCode: 'Новый арт.',
  excise_short: 'Код маркировки',
  operation_type_id: 'Тип операции',
  fiscal_doc_number: 'Фиск. документ',
  dateFrom: 'Период с',
  dateTo: 'Период по',
  cancelType: 'Тип отмены',
  returnType: 'Тип возврата',
  orderDt: 'Дата заказа',
  completedDt: 'Дата получения',
  shkId: 'ID ШК',
  updatedAt: 'Обновлено API',
  createdAt: 'Создано API',
  isMp: 'Маркетплейс?',
  isB2b: 'B2B?'
};

var MANUAL_SHEETS_ = {
  'start': 1,
  'info': 1,
  'info daily': 1,
  'info weekly': 1,
  'info monthly': 1,
  'sku': 1,
  'sku all': 1,
  'чинить': 1,
  'остатки': 1,
  'stock': 1,
  'Заполненность': 1
};

function isManualSheet_(name) {
  name = String(name || '').trim();
  if (!name || name.charAt(0) === '_') return true;
  if (MANUAL_SHEETS_[name]) return true;
  if (typeof clientManualSheets_ === 'function') {
    var extra = clientManualSheets_();
    if (extra && extra[name]) return true;
  }
  return false;
}

var OBSOLETE_SHEETS = {
  'Финансовые_ежедневные': 1, 'Рекламные_расходы': 1, 'Заказы': 1, 'Остатки': 1,
  'Товары_размеры': 1, 'Поставки_список': 1, 'Товары_поставок': 1, 'Поставки': 1,
  'FBS_Остатки': 1, 'FBS_Склады': 1, 'FBS_Офисы': 1, 'FBS_Заказы': 1,
  'FBS_Заказы_стикеры': 1, 'FBS_Поставки': 1, 'FBS_Поставки_заказы': 1,
  'FBS_Поставки_короба': 1, 'FBS_Заказы_история': 1, 'FBS_Заказы_переотправка': 1,
  'FBS_Поставки_QR': 1,
  'Воронка_сводка': 1,
  'Воронка_дни': 1,
  'Воронка_группы': 1,
  'В пути': 1,
  'Поставки на склад': 1
};

var DEFAULT_SHEETS = [
  { sheet: 'Финансовые ежедневные', view: 'sheet_finance_rows', dateCol: 'rr_dt', days: '14', enabled: 'да', order: 'rr_dt.asc,rrd_id.asc', typed: 'seller_id,rrd_id,nm_id,sa_name,barcode,doc_type_name,quantity,retail_amount,office_name,supplier_oper_name,rr_dt,shk_id,loaded_at', extra: 'realizationreport_id,gi_id,subject_name,brand_name,ts_name,retail_price,retail_price_withdisc_rub,sale_percent,commission_percent,ppvz_spp_prc,ppvz_kvw_prc_base,ppvz_kvw_prc,ppvz_sales_commission,ppvz_for_pay,ppvz_vw,ppvz_vw_nds,acquiring_fee,acquiring_percent,acquiring_bank,delivery_amount,return_amount,delivery_rub,storage_fee,penalty,additional_payment,deduction,acceptance,srid,create_dt,order_dt,sale_dt,sticker_id,ppvz_office_name,site_country,currency_name,date_from,date_to,kiz,assembly_id,trbx_id,gi_box_type_name,ppvz_office_id,ppvz_inn,ppvz_supplier_name,ppvz_supplier_id,ppvz_reward,product_discount_for_report,supplier_promo,rebill_logistic_cost,rebill_logistic_org,installment_cofinancing_amount,cashback_amount,cashback_discount,cashback_commission_change,loyalty_discount,loyalty_id,seller_promo_id,seller_promo_discount,sale_price_promocode_discount_prc,sale_price_affiliated_discount_prc,sale_price_wholesale_discount_prc,sup_rating_prc_up,warehouse_logistics_coeff,wibes_wb_discount_percent,is_kgvp_v2,is_legal_entity,srv_dbs,report_type,delivery_method,dlv_prc,fix_tariff_date_from,fix_tariff_date_to,declaration_number,bonus_type_name,article_substitution,b2b_customer_tin,paid_with_social_certificate,payment_processing,payment_schedule,suppliercontract_code,uuid_promocode,order_uid' },
  { sheet: 'Рекламные расходы', view: 'sheet_adv_stats', dateCol: 'stat_date', days: '14', enabled: 'да', order: 'stat_date.asc,advert_id.asc,app_type.asc,nm_id.asc', typed: 'seller_id,advert_id,stat_date,app_type,nm_id,name,views,clicks,spend,atbs,orders,shks,cpc,ctr,cr,payment_type,loaded_at', extra: 'canceled,sum_price' },
  { sheet: 'Воронка продаж', view: 'sheet_sales_funnel_daily', dateCol: 'stat_date', days: '14', enabled: 'да', order: 'stat_date.asc,nm_id.asc', typed: 'seller_id,stat_date,nm_id,vendor_code,title,brand_name,subject_name,open_count,cart_count,order_count,order_sum,buyout_count,buyout_sum,buyout_percent,add_to_cart_conversion,cart_to_order_conversion,add_to_wishlist_count,loaded_at', extra: '' },
  { sheet: 'Заказы FBW', view: 'sheet_fbo_orders', dateCol: 'order_dt', days: '14', enabled: 'да', order: 'order_dt.asc,srid.asc', typed: 'seller_id,srid,order_dt,last_change_dt,nm_id,supplier_article,barcode,warehouse_name,total_price,finished_price,is_cancel,loaded_at', extra: 'gNumber,brand,subject,category,techSize,warehouseType,countryName,oblastOkrugName,regionName,discountPercent,spp,priceWithDisc,isSupply,isRealization,incomeID,sticker,cancelDate' },
  { sheet: 'Продажи FBW', view: 'sheet_fbo_sales', dateCol: 'sale_dt', days: '14', enabled: 'да', order: 'sale_dt.asc,sale_id.asc', typed: 'seller_id,sale_id,srid,sale_dt,last_change_dt,nm_id,supplier_article,barcode,warehouse_name,total_price,finished_price,price_with_disc,discount_percent,spp,is_supply,is_realization,loaded_at', extra: 'gNumber,brand,subject,category,techSize,warehouseType,countryName,oblastOkrugName,regionName,incomeID,sticker,forPay' },
  { sheet: 'Продажи по регионам', view: 'sheet_region_sales', dateCol: 'sale_dt', days: '30', enabled: 'да', order: 'sale_dt.asc,region_name.asc,nm_id.asc,sale_id.asc', typed: 'seller_id,sale_id,sale_dt,region_name,country_name,nm_id,supplier_article,total_price,loaded_at', extra: 'cityName,foName,saleInvoiceCostPrice,saleInvoiceCostPricePerc,saleItemInvoiceQty' },
  { sheet: 'Возвраты товаров', view: 'sheet_goods_returns', dateCol: 'order_dt', days: '30', enabled: 'да', order: 'order_dt.asc,return_id.asc', typed: 'seller_id,return_id,order_dt,order_id,srid,shk_id,nm_id,barcode,tech_size,status_name,return_type,reason,completed_dt,loaded_at', extra: 'brand,subjectName,stickerId,dstOfficeId,dstOfficeAddress,readyToReturnDt,expiredDt,isStatusActive' },
  { sheet: 'Лента заказов', view: 'sheet_order_feed', dateCol: 'status_updated_at', days: '14', enabled: 'да', order: 'status_updated_at.desc,event_id.asc', typed: 'seller_id,event_id,status_updated_at,created_at,srid,nm_id,chrt_id,status_name,cancel_type,warehouse_name,warehouse_region,destination_city,destination_district,seller_price,is_mp,is_b2b,loaded_at', extra: '' },
  { sheet: 'Отзывы', view: 'sheet_feedbacks', dateCol: 'feedback_dt', days: '30', enabled: 'нет', order: 'feedback_dt.desc,feedback_id.asc', typed: 'seller_id,feedback_id,feedback_dt,nm_id,supplier_article,product_name,brand_name,product_valuation,text,pros,cons,state,is_answered,answer_text,user_name,order_status,was_viewed,loaded_at', extra: 'photoLinks,video,matchingSize,bables,supplierFeedbackValuation,supplierProductValuation,isAbleReturnProductOrders,subjectName,parentFeedbackId,childFeedbackId' },
  { sheet: 'Вопросы', view: 'sheet_questions', dateCol: 'question_dt', days: '30', enabled: 'нет', order: 'question_dt.desc,question_id.asc', typed: 'seller_id,question_id,question_dt,nm_id,supplier_article,product_name,brand_name,text,state,is_answered,answer_text,was_viewed,is_warned,loaded_at', extra: '' },
  { sheet: 'Поисковые запросы', view: 'sheet_search_queries', dateCol: 'stat_date', days: '30', enabled: 'нет', order: 'stat_date.desc,nm_id.asc,query_text.asc,level.asc', typed: 'seller_id,stat_date,nm_id,query_text,level,supplier_article,subject_name,brand_name,avg_position,open_count,cart_count,order_count,visibility,frequency,loaded_at', extra: 'weekFrequency,medianPosition,openToCart,cartToOrder,rating,feedbackRating,isAdvertised,isSubstitutedSKU' },
  { sheet: 'Тарифы', view: 'sheet_tariffs', dateCol: 'tariff_dt', days: 'все', enabled: 'нет', order: 'kind.asc,warehouse_name.asc,box_type.asc,row_key.asc', typed: 'seller_id,tariff_dt,kind,warehouse_name,box_type,row_key,subject_name,description,rate_value,loaded_at', extra: 'boxDeliveryLiter,boxStorageLiter,palletDeliveryValueLiter,palletStorageValueExpr,deliveryDumpSupOfficeLiter,kgvpMarketplace,paidStorageKgvp,coefficient,allowUnload' },
  { sheet: 'Удержания WB', view: 'sheet_wb_retentions', dateCol: 'retention_dt', days: '90', enabled: 'нет', order: 'retention_dt.desc,kind.asc,row_key.asc', typed: 'seller_id,retention_dt,kind,row_key,nm_id,subject_name,description,amount,supplier_article,barcode,shk_id,income_id,loaded_at', extra: 'bonusType,prcOver,penaltyAmount,reversalAmount,isValid,currency,dateFrom,dateTo,photoUrls,oldVendorCode,newVendorCode,oldSku,newSku,excise_short,operation_type_id,fiscal_doc_number,fiscal_dt,srid,rid,volume,width,length,height' },
  { sheet: 'Складские услуги', view: 'sheet_warehouse_services', dateCol: 'service_dt', days: '90', enabled: 'да', order: 'service_dt.desc,kind.asc,row_key.asc', typed: 'seller_id,service_dt,kind,row_key,nm_id,subject_name,warehouse_name,amount,quantity,income_id,supplier_article,barcode,description,loaded_at', extra: 'logWarehouseCoef,officeId,warehouseCoef,giId,chrtId,size,brand,volume,calcType,palletPlaceCode,palletCount,originalDate,loyaltyDiscount,tariffFixDate,tariffLowerDate,giCreateDate,shkCreateDate,count,total' },
  { sheet: 'Заявки на возврат', view: 'sheet_claims', dateCol: 'claim_dt', days: '30', enabled: 'да', order: 'claim_dt.desc,claim_id.asc', typed: 'seller_id,claim_id,claim_dt,claim_updated_dt,order_dt,delivery_dt,nm_id,claim_type,status,status_ex,product_name,user_comment,wb_comment,price,currency_code,srid,is_archive,loaded_at', extra: 'photos,video_paths,actions,origin_id_info' },
  { sheet: 'Акции', view: 'sheet_promos', dateCol: 'start_dt', days: '365', enabled: 'да', order: 'start_dt.desc,promo_id.asc,nm_id.asc', typed: 'seller_id,promo_id,nm_id,promo_name,promo_type,start_dt,end_dt,description,in_action,price,plan_price,discount,plan_discount,loaded_at', extra: 'advantages,inPromoActionLeftovers,inPromoActionTotal,notInPromoActionLeftovers,notInPromoActionTotal,participationPercentage,exceptionProductsCount,currencyCode' },
  { sheet: 'Остатки FBW', view: 'sheet_fbo_stocks', dateCol: 'snapshot_date', days: '7', enabled: 'да', order: 'snapshot_date.asc,nm_id.asc,warehouse_name.asc', typed: 'seller_id,snapshot_date,nm_id,warehouse_name,quantity,loaded_at', extra: 'vendor_code,chrtId,warehouseId,region,regionName,inWayToClient,inWayFromClient,sizes,source' },
  { sheet: 'Остатки ЛК', view: 'sheet_fbo_stocks_lk', dateCol: 'snapshot_date', days: '7', enabled: 'да', order: 'snapshot_date.asc,nm_id.asc,tech_size.asc,warehouse_name.asc', typed: 'seller_id,snapshot_date,nm_id,tech_size,warehouse_name,quantity,loaded_at', extra: 'vendor_code,brand_name,subject_name,barcode,volume' },
  { sheet: 'Товары', view: 'sheet_skus', dateCol: '', days: 'все', enabled: 'да', order: 'nm_id.asc,chrt_id.asc', typed: 'seller_id,chrt_id,nm_id,vendor_code,title,brand,subject_name,imt_id,barcode,tech_size,wb_size,skus,price,discounted_price,club_discounted_price,discount_percent,currency,loaded_at', extra: 'nmUUID,subjectID,description,length,width,height,weightBrutto,photos,documents,needKiz,kizMarked,createdAt,updatedAt' },
  { sheet: 'История цен', view: 'sheet_product_prices_daily', dateCol: 'price_date', days: '30', enabled: 'да', order: 'price_date.asc,nm_id.asc', typed: 'seller_id,price_date,nm_id,vendor_code,price,discounted_price,club_discounted_price,discount_percent,currency,loaded_at', extra: '' },
  { sheet: 'Поставки FBW', view: 'sheet_fbw', dateCol: 'supply_dt', days: '60', enabled: 'да', order: 'supply_dt.asc,supply_id.asc,nm_id.asc,barcode.asc', typed: 'seller_id,supply_id,preorder_id,create_date,supply_date,fact_date,status_name,box_type_name,warehouse_name,region,barcode,vendor_code,nm_id,tech_size,color,quantity,accepted_quantity,ready_for_sale,weight_kg,total_weight_kg,loaded_at', extra: '' },
  { sheet: 'Остатки FBS', view: 'sheet_fbs_stocks', dateCol: 'snapshot_date', days: '7', enabled: 'да', order: 'snapshot_date.asc,warehouse_id.asc,chrt_id.asc', typed: 'seller_id,snapshot_date,warehouse_id,chrt_id,amount,sku,nm_id,loaded_at', extra: 'vendorCode,title,warehouseName,officeId' },
  { sheet: 'Заказы FBS', view: 'sheet_fbs_orders', dateCol: 'created_at', days: '30', enabled: 'да', order: 'created_at.asc,order_id.asc', typed: 'seller_id,order_id,rid,order_uid,created_at,article,nm_id,chrt_id,warehouse_id,supply_id,supplier_status,wb_status,source,sticker_barcode,part_a,part_b,loaded_at', extra: 'skus,price,scanPrice,currencyCode,convertedPrice,convertedCurrencyCode,cargoType,deliveryType,officeId,offices,address,comment,colorCode,options,isZeroOrder,isPickupPointShipmentAllowed,crossBorderType' },
  { sheet: 'Поставки FBS', view: 'sheet_fbs', dateCol: 'loaded_at', days: '60', enabled: 'да', order: 'loaded_at.asc,supply_id.asc,order_id.asc', typed: 'seller_id,supply_id,supply_name,done,order_id,rid,article,nm_id,chrt_id,supplier_status,wb_status,loaded_at', extra: 'createdAt,closedAt,scanDt,rejectDt,cargoType,crossBorderType,destinationOfficeId,recommendedWhId,isB2b,isPickupPointShipmentAllowed' },
  { sheet: 'Склады FBS', view: 'sheet_fbs_warehouses', dateCol: '', days: 'все', enabled: 'да', order: 'warehouse_id.asc', typed: 'seller_id,warehouse_id,name,office_id,office_name,office_address,office_city,cargo_type,delivery_type,loaded_at', extra: 'storeId,isDeleting,isProcessing' }
];

var SHEET_ROW_KEYS_ = {
  'Финансовые ежедневные': ['rrd_id'],
  'Рекламные расходы': ['advert_id', 'stat_date', 'app_type', 'nm_id'],
  'Воронка продаж': ['stat_date', 'nm_id'],
  'Заказы FBW': ['srid'],
  'Продажи FBW': ['sale_id'],
  'Продажи по регионам': ['sale_id'],
  'Возвраты товаров': ['return_id'],
  'Лента заказов': ['event_id'],
  'Отзывы': ['feedback_id'],
  'Вопросы': ['question_id'],
  'Поисковые запросы': ['stat_date', 'nm_id', 'query_text', 'level'],
  'Тарифы': ['tariff_dt', 'kind', 'warehouse_name', 'box_type', 'row_key'],
  'Удержания WB': ['kind', 'row_key'],
  'Складские услуги': ['kind', 'row_key'],
  'Заявки на возврат': ['claim_id'],
  'Акции': ['promo_id', 'nm_id'],
  'Остатки FBW': ['snapshot_date', 'nm_id', 'warehouse_name'],
  'Остатки ЛК': ['snapshot_date', 'nm_id', 'tech_size', 'warehouse_name'],
  'Товары': ['chrt_id'],
  'История цен': ['price_date', 'nm_id'],
  'Поставки FBW': ['supply_id', 'nm_id', 'barcode'],
  'Остатки FBS': ['snapshot_date', 'warehouse_id', 'chrt_id'],
  'Заказы FBS': ['order_id'],
  'Поставки FBS': ['supply_id', 'order_id'],
  'Склады FBS': ['warehouse_id']
};

var INFO_KEYS_BY_SHEET_ = {
  'Финансовые ежедневные': ['retail_amount', 'ppvz_for_pay', 'ppvz_sales_commission', 'delivery_rub', 'storage_fee', 'acceptance', 'acquiring_fee', 'additional_payment', 'deduction', 'penalty'],
  'Рекламные расходы': ['views', 'orders', 'atbs'],
  'Заказы FBW': ['is_cancel', 'finished_price'],
  'Продажи FBW': ['finished_price', 'total_price'],
  'Продажи по регионам': ['saleItemInvoiceQty', 'saleInvoiceCostPricePerc'],
  'Лента заказов': ['seller_price'],
  'Отзывы': ['product_valuation'],
  'Поисковые запросы': ['order_count', 'avg_position', 'frequency'],
  'Тарифы': ['rate_value'],
  'Удержания WB': ['amount'],
  'Складские услуги': ['amount', 'quantity'],
  'Заявки на возврат': ['price'],
  'Акции': ['price', 'plan_price', 'discount', 'plan_discount'],
  'Остатки FBW': ['inWayToClient', 'inWayFromClient'],
  'История цен': ['price', 'discounted_price', 'club_discounted_price', 'discount_percent'],
  'Заказы FBS': ['wb_status'],
  'Поставки FBW': ['status_name']
};

function buildAppMenu_(accessMap) {
  accessMap = accessMap || {};
  var ui = SpreadsheetApp.getUi();
  var loadOne = ui.createMenu('📦 Загрузить лист')
      .addItem('🔄 Загрузить всё', 'loadAllFromDb')
      .addItem('📊 Загрузить все отчёты', 'loadAllReports_')
      .addItem('📄 Загрузить этот лист', 'menuLoadThisSheet')
      .addSeparator()
      .addItem(loadMenuLabel_('Финансовые ежедневные', '💰', accessMap), 'menuLoadFinance')
      .addItem(loadMenuLabel_('Рекламные расходы', '📢', accessMap), 'menuLoadAds')
      .addItem(loadMenuLabel_('Воронка продаж', '📈', accessMap), 'menuLoadSalesFunnel')
      .addItem(loadMenuLabel_('Товары', '📦', accessMap), 'menuLoadProducts')
      .addItem(loadMenuLabel_('История цен', '💵', accessMap), 'menuLoadPriceHistory')
      .addItem('🏬 Стыковки складов', 'loadWarehouseDict')
      .addSeparator()
      .addSubMenu(ui.createMenu('🚚 FBW')
        .addItem(loadMenuLabel_('Заказы FBW', '📦', accessMap), 'menuLoadFboOrders')
        .addItem(loadMenuLabel_('Продажи FBW', '💵', accessMap), 'menuLoadFboSales')
        .addItem(loadMenuLabel_('Остатки FBW', '📦', accessMap), 'menuLoadFboStocks')
        .addItem(loadMenuLabel_('Остатки ЛК', '📦', accessMap), 'menuLoadFboStocksLk')
        .addItem(loadMenuLabel_('Поставки FBW', '📦', accessMap), 'menuLoadFbwSupplies'))
      .addSubMenu(ui.createMenu('🏬 FBS')
        .addItem(loadMenuLabel_('Заказы FBS', '📦', accessMap), 'menuLoadFbsOrders')
        .addItem(loadMenuLabel_('Остатки FBS', '📦', accessMap), 'menuLoadFbsStocks')
        .addItem(loadMenuLabel_('Поставки FBS', '📦', accessMap), 'menuLoadFbsSupplies')
        .addItem(loadMenuLabel_('Склады FBS', '📦', accessMap), 'menuLoadFbsWarehouses'))
      .addSubMenu(ui.createMenu('📊 Аналитика')
        .addItem(loadMenuLabel_('Продажи по регионам', '🗺', accessMap), 'menuLoadRegionSales')
        .addItem(loadMenuLabel_('Возвраты товаров', '↩', accessMap), 'menuLoadGoodsReturns')
        .addItem(loadMenuLabel_('Лента заказов', '📋', accessMap), 'menuLoadOrderFeed')
        .addItem(loadMenuLabel_('Отзывы', '⭐', accessMap), 'menuLoadFeedbacks')
        .addItem(loadMenuLabel_('Вопросы', '❓', accessMap), 'menuLoadQuestions')
        .addItem(loadMenuLabel_('Поисковые запросы', '🔎', accessMap) + ' (Jam)', 'menuLoadSearchQueries')
        .addItem(loadMenuLabel_('Тарифы', '💲', accessMap), 'menuLoadTariffs')
        .addItem(loadMenuLabel_('Удержания WB', '⚠️', accessMap), 'menuLoadWbRetentions')
        .addItem(loadMenuLabel_('Складские услуги', '🏭', accessMap), 'menuLoadWarehouseServices')
        .addItem(loadMenuLabel_('Заявки на возврат', '📨', accessMap), 'menuLoadClaims')
        .addItem(loadMenuLabel_('Акции', '🏷', accessMap), 'menuLoadPromos'));
  var daily = ui.createMenu('⏰ Ежедневно')
      .addItem(gasDailyEnableLabel_(), 'installDailyAutoLoad')
      .addItem(gasDailyRunLabel_(), 'runMorningNow')
      .addItem('⏹ Отключить', 'disableDailyAutoLoad');
  var service = ui.createMenu('🔧 Сервис')
      .addItem('⚙️ Настройки загрузки', 'showLoadSettingsDialog')
      .addItem('📋 Колонки листов', 'showColumnSettingsDialog')
      .addSeparator()
      .addItem('▶️ Продолжить загрузку', 'continueLoadManual_')
      .addItem('⏹ Остановить загрузку', 'stopAutoLoad')
      .addSeparator()
      .addItem('🔑 Ключ базы', 'setDbKey')
      .addItem('🔄 Обновить доступ', 'checkDbConnection')
      .addItem('📋 Обновить start', 'refreshStartSheetMenu_')
      .addItem('⚙️ Создать настройки', 'setupConfigSheets')
      .addItem('📋 Создать лист start', 'writeStartSheet')
      .addItem('♻️ Пересоздать служебные листы', 'resetServiceSheets')
      .addItem('🎨 Оформить все листы', 'styleAllSheets')
      .addItem('📊 Заполненность ячеек', 'countFilledCellsOnly')
      .addItem('🕶 Обезличить демо-строки', 'menuAnonymizeDemoRows')
      .addSeparator()
      .addItem('🗑️ Полностью перезагрузить', 'forceReloadAllFromDb')
      .addSeparator()
      // .addItem('⏱ Время GAS → база (из _Лог)', 'menuSyncLogDurations');
  var infoMenu = ui.createMenu('📊 info')
      .addItem('📅 День…', 'showInfoDayDialog')
      .addItem('📆 Неделя…', 'showInfoWeekDialog')
      .addItem('📅 Месяц…', 'showInfoMonthDialog');
  var skuMenu = ui.createMenu('📦 sku')
      .addItem('🧾 Карточка…', 'showSkuCardDialog')
      .addItem('📋 Все товары…', 'showSkuAllDialog');
  ui.createMenu(APP_NAME_)
      .addSubMenu(loadOne)
      .addSubMenu(ui.createMenu('👁 Листы данных')
        .addItem('Скрыть', 'hideDataSheets')
        .addItem('Показать', 'showDataSheets')
        .addItem('Показать лог', 'showLogSheet'))
      .addSeparator()
      .addSubMenu(infoMenu)
      .addSubMenu(skuMenu)
      .addItem('📦 stock', 'runOpsStockDashboard')
      .addSeparator()
      .addSubMenu(daily)
      .addSubMenu(service)
      .addToUi();
}

function applyAccessUi_(accessMap) {
  accessMap = accessMap || readDatasetAccessCache_() || {};
  try { buildAppMenu_(accessMap); } catch (eMenu) { Logger.log('applyAccessUi menu: ' + eMenu); }
}

function onOpen() {
  try {
    if (typeof isDemoBook_ === 'function' && isDemoBook_()) {
      buildDemoMenu_();
    } else {
      buildAppMenu_(readDatasetAccessCache_() || {});
    }
  } catch (e) { Logger.log('onOpen menu: ' + e); }
  try {
    if (!(typeof isDemoBook_ === 'function' && isDemoBook_())) {
      ensureSheetLoadWatch_();
    }
  } catch (eWatch) {}
}

function menuLoadThisSheet() {
  var props = PropertiesService.getScriptProperties();
  if (morningWatchActive_(props)) {
    SpreadsheetApp.getUi().alert(APP_NAME_, 'Идёт утреннее авто. Дождитесь 07:00 или завершения.', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  var name = String(activeSpreadsheet_().getActiveSheet().getName() || '').trim();
  if (isManualSheet_(name)) {
    SpreadsheetApp.getUi().alert(APP_NAME_, 'Этот лист не из базы: «' + name + '»', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  if (!isSheetAccessAllowed_(name)) {
    alertSheetAccessDenied_(name);
    return;
  }
  loadSheets_([name]);
}

function menuLoadNamed_(name) {
  var props = PropertiesService.getScriptProperties();
  if (morningWatchActive_(props)) {
    SpreadsheetApp.getUi().alert(APP_NAME_, 'Идёт утреннее авто. Дождитесь 07:00 или завершения.', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  if (!isSheetAccessAllowed_(name)) {
    alertSheetAccessDenied_(name);
    return;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var resume = JSON.parse(props.getProperty(RESUME_KEY) || 'null');
    if (resume && resume.sheet === name && resume.error) props.deleteProperty(RESUME_KEY);
  } catch (eMenu) {}
  loadSheets_([name]);
}

function menuLoadFinance() { menuLoadNamed_('Финансовые ежедневные'); }
function menuLoadAds() { menuLoadNamed_('Рекламные расходы'); }
function menuLoadSalesFunnel() { menuLoadNamed_('Воронка продаж'); }
function menuLoadFboOrders() { menuLoadNamed_('Заказы FBW'); }
function menuLoadFboSales() { menuLoadNamed_('Продажи FBW'); }
function menuLoadRegionSales() { menuLoadNamed_('Продажи по регионам'); }
function menuLoadGoodsReturns() { menuLoadNamed_('Возвраты товаров'); }
function menuLoadOrderFeed() { menuLoadNamed_('Лента заказов'); }
function menuLoadFeedbacks() { menuLoadNamed_('Отзывы'); }
function menuLoadQuestions() { menuLoadNamed_('Вопросы'); }
function menuLoadSearchQueries() { menuLoadNamed_('Поисковые запросы'); }
function menuLoadTariffs() { menuLoadNamed_('Тарифы'); }
function menuLoadWbRetentions() { menuLoadNamed_('Удержания WB'); }
function menuLoadWarehouseServices() { menuLoadNamed_('Складские услуги'); }
function menuLoadClaims() { menuLoadNamed_('Заявки на возврат'); }
function menuLoadPromos() { menuLoadNamed_('Акции'); }
function menuLoadFboStocks() { menuLoadNamed_('Остатки FBW'); }
function menuLoadFboStocksLk() { menuLoadNamed_('Остатки ЛК'); }
function menuLoadProducts() { menuLoadNamed_('Товары'); }
function menuLoadPriceHistory() { menuLoadNamed_('История цен'); }
function menuLoadFbwSupplies() { menuLoadNamed_('Поставки FBW'); }
function menuLoadFbsStocks() { menuLoadNamed_('Остатки FBS'); }
function menuLoadFbsOrders() { menuLoadNamed_('Заказы FBS'); }
function menuLoadFbsSupplies() { menuLoadNamed_('Поставки FBS'); }
function menuLoadFbsWarehouses() { menuLoadNamed_('Склады FBS'); }

function onEdit(e) {
  if (typeof handlePostavka2Edit === 'function') {
    try { handlePostavka2Edit(e); } catch (err) {}
  }
}

function setDbKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt(
    'Ключ базы',
    'Вставьте ключ (начинается с eyJ).',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var key = String(r.getResponseText() || '').trim();
  if (!key) {
    ui.alert('Ключ пустой — не сохранил');
    return;
  }
  if (key.indexOf('sb_') === 0) {
    ui.alert('Этот формат не подойдёт. Нужен ключ, который начинается с eyJ.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DB_KEY', key);
  props.setProperty('DB_URL', DB_URL_DEFAULT_);
  ui.alert('Ключ базы сохранён');
}

function getDbConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty('DB_URL') || '').replace(/\/$/, '');
  var key = String(props.getProperty('DB_KEY') || '').trim();
  if (!url) url = DB_URL_DEFAULT_;
  return { url: url, key: key };
}

function dbHeaders_(key) {
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'User-Agent': 'WB-Sheets/1.0',
    Prefer: 'count=none'
  };
}

function dbRpc_(name, body) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var headers = dbHeaders_(cfg.key);
  headers['Content-Type'] = 'application/json';
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + encodeURIComponent(name), {
    method: 'post',
    muteHttpExceptions: true,
    headers: headers,
    payload: JSON.stringify(body || {})
  });
  var code = res.getResponseCode();
  var text = res.getContentText() || '';
  if (code !== 200 && code !== 204) throw new Error(dbErrorText_(code, text));
  if (!text || text === 'null') return null;
  return JSON.parse(text);
}

var DATASET_SHEETS_ = {
  finance: ['Финансовые ежедневные'],
  adv_stats: ['Рекламные расходы'],
  fbo_orders: ['Заказы FBW'],
  fbo_sales: ['Продажи FBW'],
  region_sales: ['Продажи по регионам'],
  goods_returns: ['Возвраты товаров'],
  order_feed: ['Лента заказов'],
  feedbacks: ['Отзывы'],
  questions: ['Вопросы'],
  search_queries: ['Поисковые запросы'],
  tariffs: ['Тарифы'],
  wb_retentions: ['Удержания WB'],
  warehouse_services: ['Складские услуги'],
  claims: ['Заявки на возврат'],
  promos: ['Акции'],
  fbo_stocks: ['Остатки FBW'],
  stocks_lk: ['Остатки ЛК'],
  sales_funnel: ['Воронка продаж'],
  fbw_supplies: ['Поставки FBW'],
  products: ['Товары'],
  product_prices: ['История цен'],
  fbs_warehouses: ['Склады FBS'],
  fbs_offices: [],
  fbs_stocks: ['Остатки FBS'],
  fbs_orders: ['Заказы FBS'],
  fbs_supplies: ['Поставки FBS']
};

var SHEET_TO_DATASET_ = (function () {
  var out = {};
  var ds;
  var names;
  var i;
  for (ds in DATASET_SHEETS_) {
    names = DATASET_SHEETS_[ds];
    for (i = 0; i < names.length; i++) {
      if (names[i]) out[names[i]] = ds;
    }
  }
  return out;
})();

function resolveActiveSlug_() {
  try {
    var settings = getLoadSettings();
    if (settings && settings.slug) return String(settings.slug);
  } catch (e) {}
  return 'main';
}

function datasetAccessCacheKey_(slug) {
  return 'DATASET_ACCESS_V2_' + String(slug || 'main');
}

function readDatasetAccessCache_(slug) {
  slug = slug || resolveActiveSlug_();
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(datasetAccessCacheKey_(slug));
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    return parsed && parsed.map ? parsed.map : null;
  } catch (e) {
    return null;
  }
}

function writeDatasetAccessCache_(slug, map) {
  PropertiesService.getScriptProperties().setProperty(
    datasetAccessCacheKey_(slug || resolveActiveSlug_()),
    JSON.stringify({ at: Date.now(), map: map || {} })
  );
}

function refreshDatasetAccessCache_(slug) {
  slug = slug || resolveActiveSlug_();
  var map = fetchDatasetAccessMap_(slug);
  writeDatasetAccessCache_(slug, map);
  return map;
}

function fetchDatasetAccessMap_(slug) {
  var book = (typeof BOOK_SLUG_ !== 'undefined' && BOOK_SLUG_) ? String(BOOK_SLUG_) : 'main';
  var pack = null;
  var rows = [];
  try {
    pack = dbRpc_('list_book_access', { p_book_slug: book });
    rows = (pack && pack.datasets) ? pack.datasets : [];
  } catch (eBook) {
    pack = dbRpc_('list_dataset_access', { p_slug: slug || resolveActiveSlug_() });
    rows = (pack && pack.datasets) ? pack.datasets : [];
  }
  var map = {};
  var i;
  for (i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].dataset) map[rows[i].dataset] = !!rows[i].enabled;
  }
  return map;
}

function accessMapForUse_(accessMap) {
  if (accessMap && Object.keys(accessMap).length) return accessMap;
  return readDatasetAccessCache_() || {};
}

function isDatasetAccessAllowed_(dataset, accessMap) {
  if (!dataset) return true;
  accessMap = accessMapForUse_(accessMap);
  if (Object.prototype.hasOwnProperty.call(accessMap, dataset)) return !!accessMap[dataset];
  return true;
}

function isSheetAccessAllowed_(sheetName, accessMap) {
  var ds = SHEET_TO_DATASET_[sheetName];
  if (!ds && sheetName === 'Поисковые запросы') ds = 'search_queries';
  if (!ds) return true;
  return isDatasetAccessAllowed_(ds, accessMap);
}

function alertSheetAccessDenied_(sheetName) {
  SpreadsheetApp.getUi().alert(
    APP_NAME_,
    'Доступ к «' + sheetName + '» закрыт.\nБлок можно подключить отдельно.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function loadMenuLabel_(sheetName, icon, accessMap) {
  if (isSheetAccessAllowed_(sheetName, accessMap)) return icon + ' ' + sheetName;
  return '🔒 ' + sheetName;
}

function reportGasSheetTouch_(sheetName, rows, durationMs) {
  var dataset = SHEET_TO_DATASET_[sheetName];
  if (!dataset) return;
  try {
    dbRpc_('gas_sheet_touch', {
      p_dataset: dataset,
      p_sheet_name: String(sheetName || ''),
      p_rows: Number(rows) || 0,
      p_duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
      p_book_slug: typeof BOOK_SLUG_ !== 'undefined' ? BOOK_SLUG_ : 'main'
    });
  } catch (eTouch) {
    Logger.log('gas_sheet_touch: ' + eTouch);
  }
}

function settingsUpdatedToday_(ss, sheetName) {
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return false;
  var want = String(sheetName || '').trim().toLowerCase();
  var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var i;
  for (i = 0; i < names.length; i++) {
    if (String(names[i][0] || '').trim().toLowerCase() !== want) continue;
    var when = String(sh.getRange(i + 2, 11).getDisplayValue() || '').trim();
    if (!when || when === '—') return false;
    var day = parseLogDayMsk_(when);
    return day === mskToday_();
  }
  return false;
}

var LOG_DONE_STATUSES_ = { 'готово': 1, 'инкремент': 1, 'пропуск': 1 };
var LOG_PHASE_STATUSES_ = { 'удаление': 1, 'сеть': 1, 'запись': 1, 'сортировка': 1 };

function sumSheetLogDurationFromRows_(vals, sheetName, minDay, maxDay) {
  var phaseSum = 0;
  var doneMs = 0;
  var doneRows = 0;
  var doneTs = 0;
  var i;
  var row;
  var day;
  var status;
  var ts;
  var ms;
  for (i = 0; i < vals.length; i++) {
    row = vals[i];
    if (String(row[1] || '').trim() !== sheetName) continue;
    day = parseLogDayMsk_(row[0]);
    if (!day || day < minDay || day > maxDay) continue;
    status = String(row[2] || '').trim();
    ms = Math.max(0, Math.round(Number(row[7]) || 0));
    if (LOG_PHASE_STATUSES_[status]) {
      phaseSum += ms;
      continue;
    }
    if (!LOG_DONE_STATUSES_[status] || !ms) continue;
    ts = parseLogInstantMsk_(row[0]);
    if (ts >= doneTs) {
      doneTs = ts;
      doneMs = ms;
      doneRows = Math.max(0, Math.round(Number(row[3]) || 0));
    }
  }
  return {
    ms: phaseSum > 0 ? phaseSum : doneMs,
    rows: doneRows
  };
}

function sheetLogDurationMs_(sheetName, dayIso) {
  var ss = activeSpreadsheet_();
  var sh = ss.getSheetByName(LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ms: 0, rows: 0 };
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, LOG_HEADER_.length).getValues();
  dayIso = dayIso || mskToday_();
  return sumSheetLogDurationFromRows_(vals, sheetName, dayIso, dayIso);
}

function parseLogDayMsk_(t) {
  if (!t) return '';
  if (Object.prototype.toString.call(t) === '[object Date]') {
    return Utilities.formatDate(t, TZ, 'yyyy-MM-dd');
  }
  var s = String(t).trim();
  if (s.length >= 10 && s.charAt(2) === '.' && s.charAt(5) === '.') {
    return s.substring(6, 10) + '-' + s.substring(3, 5) + '-' + s.substring(0, 2);
  }
  if (s.length >= 10 && s.charAt(4) === '-') return s.substring(0, 10);
  return '';
}

function parseLogInstantMsk_(t) {
  if (!t) return 0;
  if (Object.prototype.toString.call(t) === '[object Date]') return t.getTime();
  var s = String(t).trim();
  var m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return new Date(
      Number(m[3]), Number(m[2]) - 1, Number(m[1]),
      Number(m[4]), Number(m[5]), Number(m[6])
    ).getTime();
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Последняя заливка листа за сегодня (МСК) из _Лог → gas_sheet_updates.duration_ms. */
function syncLogDurationsToDb_(daysBack) {
  var ss = activeSpreadsheet_();
  var sh = ss.getSheetByName(LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return { updated: 0, sheets: [] };
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, LOG_HEADER_.length).getValues();
  var today = mskToday_();
  var minDay = today;
  if (daysBack && Number(daysBack) > 0) {
    var d0 = new Date(today + 'T12:00:00');
    d0.setDate(d0.getDate() - Number(daysBack));
    minDay = Utilities.formatDate(d0, TZ, 'yyyy-MM-dd');
  }
  var seen = {};
  var i;
  var row;
  var sheet;
  var day;
  for (i = 0; i < vals.length; i++) {
    row = vals[i];
    sheet = String(row[1] || '').trim();
    if (!sheet) continue;
    day = parseLogDayMsk_(row[0]);
    if (!day || day < minDay || day > today) continue;
    seen[sheet] = 1;
  }
  var items = [];
  var updated = [];
  for (sheet in seen) {
    if (!settingsUpdatedToday_(ss, sheet)) continue;
    var agg = sumSheetLogDurationFromRows_(vals, sheet, minDay, today);
    if (!agg.ms || !SHEET_TO_DATASET_[sheet]) continue;
    items.push({
      book_slug: typeof BOOK_SLUG_ !== 'undefined' ? BOOK_SLUG_ : 'main',
      dataset: SHEET_TO_DATASET_[sheet],
      sheet_name: sheet,
      rows: agg.rows,
      duration_ms: agg.ms
    });
    updated.push(sheet);
  }
  if (items.length) {
    try {
      dbRpc_('gas_sheet_sync_durations', { p_items: items });
    } catch (eBulk) {
      Logger.log('gas_sheet_sync_durations: ' + eBulk);
      for (var j = 0; j < items.length; j++) {
        reportGasSheetTouch_(items[j].sheet_name, items[j].rows, items[j].duration_ms);
      }
    }
  }
  return { updated: updated.length, sheets: updated };
}

function menuSyncLogDurations() {
  var r = syncLogDurationsToDb_(0);
  SpreadsheetApp.getUi().alert(
    'Время GAS → база',
    'Обновлено листов: ' + r.updated + (r.sheets.length ? '\n' + r.sheets.join(', ') : ''),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function dailyLoadedDatasetsKey_() {
  return 'DAILY_LOADED_' + mskToday_();
}

function getDailyLoadedDatasets_(props) {
  props = props || PropertiesService.getScriptProperties();
  try {
    return JSON.parse(props.getProperty(dailyLoadedDatasetsKey_()) || '[]');
  } catch (e) {
    return [];
  }
}

function markDailyLoadedDataset_(props, dataset) {
  if (!dataset) return;
  props = props || PropertiesService.getScriptProperties();
  var list = getDailyLoadedDatasets_(props);
  if (list.indexOf(dataset) < 0) list.push(dataset);
  props.setProperty(dailyLoadedDatasetsKey_(), JSON.stringify(list));
}

function morningLoadOrder_() {
  var out = [];
  var seen = {};
  var i;
  var ds;
  for (i = 0; i < LOAD_SETTINGS_ORDER_.length; i++) {
    ds = SHEET_TO_DATASET_[LOAD_SETTINGS_ORDER_[i]];
    if (ds && !seen[ds]) {
      seen[ds] = 1;
      out.push(ds);
    }
  }
  return out;
}

function isMorningSheetEnabled_(sheetName) {
  var settings;
  var i;
  try {
    settings = getLoadSettings();
  } catch (e) {
    return true;
  }
  for (i = 0; i < settings.rows.length; i++) {
    if (settings.rows[i].sheet === sheetName) {
      return isEnabled_(settings.rows[i].enabled);
    }
  }
  return false;
}

function morningDatasetEnabled_(dataset) {
  if (!isDatasetAccessAllowed_(dataset)) return false;
  if (dataset === 'product_prices') return true;
  var names = datasetSheetNames_(dataset);
  var i;
  if (!names || !names.length) return false;
  for (i = 0; i < names.length; i++) {
    if (isMorningSheetEnabled_(names[i])) return true;
  }
  return false;
}

function fetchReportInfoLoads_() {
  var slug = 'main';
  var settings;
  try {
    settings = getLoadSettings();
    if (settings && settings.slug) slug = settings.slug;
  } catch (e) {}
  return dbRpc_('report_info_loads', { p_seller_id: resolveSellerId_(slug) });
}

function loadsByDataset_(loads) {
  var out = {};
  var i;
  for (i = 0; i < loads.length; i++) {
    if (loads[i] && loads[i].dataset) out[loads[i].dataset] = loads[i];
  }
  return out;
}

function morningJobStatus_(item) {
  return String((item && (item.status || item.job_status)) || '');
}

function isMorningDatasetReady_(item) {
  if (!item || !item.dataset) return false;
  if (morningJobStatus_(item) !== 'done') return false;
  var today = mskToday_();
  var loadedAt = String(item.loaded_at || '');
  if (loadedAt.substring(0, 10) === today) return true;
  var snap = {
    products: 1, product_prices: 1, fbo_stocks: 1, stocks_lk: 1, fbs_stocks: 1,
    fbs_warehouses: 1, fbs_offices: 1, claims: 1, promos: 1
  };
  if (snap[item.dataset]) return false;
  if (item.data_date && item.expected_date) {
    return String(item.data_date) >= String(item.expected_date);
  }
  return false;
}

function morningReadyDatasets_(loadsBy, loaded) {
  var order = morningLoadOrder_();
  var out = [];
  var i;
  var ds;
  var item;
  for (i = 0; i < order.length; i++) {
    ds = order[i];
    if (loaded.indexOf(ds) >= 0) continue;
    if (!morningDatasetNeeded_(ds, loadsBy)) continue;
    item = loadsBy && loadsBy[ds];
    if (!isMorningDatasetReady_(item)) continue;
    out.push(ds);
  }
  return out;
}

function morningWaitingDataset_(loadsBy, loaded) {
  var order = morningLoadOrder_();
  var i;
  var ds;
  var item;
  for (i = 0; i < order.length; i++) {
    ds = order[i];
    if (loaded.indexOf(ds) >= 0) continue;
    if (!morningDatasetNeeded_(ds, loadsBy)) continue;
    item = loadsBy && loadsBy[ds];
    if (!isMorningDatasetReady_(item)) return { ds: ds, item: item };
  }
  return null;
}

function morningReadySheetNames_(loadsBy, loaded) {
  var dss = morningReadyDatasets_(loadsBy, loaded);
  var names = [];
  var i;
  var j;
  var list;
  for (i = 0; i < dss.length; i++) {
    list = datasetSheetNames_(dss[i]);
    if (!list || !list.length) continue;
    for (j = 0; j < list.length; j++) names.push(list[j]);
  }
  return names;
}

function markMorningBatchLoaded_(props) {
  var raw = props.getProperty(MORNING_BATCH_DATASETS_KEY_);
  if (!raw) return [];
  props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
  var list;
  var i;
  try { list = JSON.parse(raw); } catch (e) { return []; }
  if (!list || !list.length) return [];
  for (i = 0; i < list.length; i++) markDailyLoadedDataset_(props, list[i]);
  return list;
}

function morningWatchActive_(props) {
  props = props || PropertiesService.getScriptProperties();
  if (props.getProperty(MORNING_CHAIN_ON_KEY_) === '1'
      && props.getProperty(DAILY_WATCH_DATE_KEY_) === mskToday_()) {
    return props.getProperty(DAILY_TRIGGERED_KEY_) !== mskToday_();
  }
  var today = mskToday_();
  return props.getProperty(DAILY_WATCH_DATE_KEY_) === today
    && props.getProperty(DAILY_TRIGGERED_KEY_) !== today;
}

function clearMorningStartBlockers_(props, reason) {
  props = props || PropertiesService.getScriptProperties();
  if (props.getProperty(MORNING_LOAD_ACTIVE_KEY_) === '1') {
    var watchDay = props.getProperty(DAILY_WATCH_DATE_KEY_);
    if (watchDay && watchDay !== mskToday_()) {
      props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
      props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
    } else {
      return false;
    }
  }
  if (!props.getProperty(RESUME_KEY) && !props.getProperty(LOAD_SESSION_KEY_)) return false;
  props.deleteProperty(RESUME_KEY);
  props.deleteProperty(LOAD_SESSION_KEY_);
  clearContinueTriggers_();
  if (reason) {
    try {
      var ss = activeSpreadsheet_();
      logMorningStep_(ss, 'watch', '', '', 'сброс', reason, 0);
    } catch (eLog) {}
  }
  return true;
}

function purgeAllOverlayRangesInSession_() {
  var ranges = readOverlayRanges_();
  if (!ranges) return;
  var name;
  for (name in ranges) {
    if (!Object.prototype.hasOwnProperty.call(ranges, name)) continue;
    clearOverlayRangeInSession_(name);
  }
}

function morningSheetNamesForDatasets_(datasets) {
  var names = [];
  var i;
  var j;
  var list;
  if (!datasets || !datasets.length) return names;
  for (i = 0; i < datasets.length; i++) {
    list = datasetSheetNames_(datasets[i]);
    if (!list || !list.length) continue;
    for (j = 0; j < list.length; j++) names.push(list[j]);
  }
  return names;
}

function morningNextReadyBatch_(loadsBy, loaded) {
  var all = morningReadyDatasets_(loadsBy, loaded);
  if (!all.length) return { datasets: [], names: [] };
  return {
    datasets: [all[0]],
    names: morningSheetNamesForDatasets_([all[0]])
  };
}

function logMorningStep_(ss, phase, batchLabel, sheetName, status, detail, ms) {
  var tag = morningWatchActive_() ? 'утро' : 'ручн';
  var parts = [tag, String(phase || 'шаг')];
  if (batchLabel) parts.push('блок:' + batchLabel);
  if (sheetName) parts.push(String(sheetName));
  if (detail) parts.push(String(detail));
  log_(ss, sheetName || '', status || 'шаг', 0, 0, 0, parts.join(' | '), ms || 0);
}

function touchSkippedSheetMeta_(ss, job, sh, colInfo, selected) {
  if (!ss || !job || !job.sheet) return;
  var keys = selected && selected.length ? selected.slice() : selectedKeys_(job, colInfo);
  var period = livePeriod_(sh, job, keys);
  writeSettingsMeta_(ss, job.sheet, period, nowMsk_());
  if (job.sheet === 'Рекламные расходы') {
    try { syncAdsNamesFromProducts_(ss, sh, keys); } catch (eNm) {}
  } else if (job.sheet === 'Товары') {
    try { refreshAdsNamesAfterProducts_(ss); } catch (eProd) {}
  }
  ensureSheetFilter_(sh, job.sheet);
  if (sheetUsesOverlay_(job.sheet)) rememberOverlaySkipTail_(job.sheet, sh);
}

function rememberOverlaySkipTail_(sheetName, sh) {
  if (!sheetUsesOverlay_(sheetName) || !sh) return;
  var last = sh.getLastRow();
  if (last < 2) return;
  var maxN = 2500;
  var n = Math.min(last - 1, maxN);
  rememberOverlayRange_(sheetName, Math.max(2, last - n + 1), n);
}

function shrinkOverlayRangeInSession_(sheetName, from, n) {
  if (!sheetName || n < 1) return;
  if (n > 5000) {
    from = from + n - 5000;
    n = 5000;
  }
  var props = PropertiesService.getScriptProperties();
  var cur = readLoadSession_(props);
  if (!cur) cur = { startedAt: Date.now(), pauses: 0, overlayRanges: {} };
  if (!cur.overlayRanges) cur.overlayRanges = {};
  cur.overlayRanges[sheetName] = { from: Number(from) || 2, n: n };
  props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(cur));
}

function clearOverlayRangeInSession_(sheetName) {
  if (!sheetName) return;
  var props = PropertiesService.getScriptProperties();
  var cur = readLoadSession_(props);
  if (!cur || !cur.overlayRanges || !cur.overlayRanges[sheetName]) return;
  delete cur.overlayRanges[sheetName];
  props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(cur));
}

function overlayRangesPendingSheets_(ranges) {
  var out = [];
  if (!overlayEnabled_()) {
    purgeAllOverlayRangesInSession_();
    return out;
  }
  if (!ranges) return out;
  var name;
  for (name in ranges) {
    if (!ranges.hasOwnProperty(name)) continue;
    var r = ranges[name];
    if (r && r.n > 0) out.push(name);
  }
  return out;
}

function reportsSourceDatasetsReady_(loadsBy, loaded) {
  loaded = loaded || [];
  if (!loadsBy) return false;
  if (morningDatasetNeeded_('finance', loadsBy) && loaded.indexOf('finance') < 0) return false;
  if (morningDatasetNeeded_('adv_stats', loadsBy) && loaded.indexOf('adv_stats') < 0) return false;
  return morningDatasetNeeded_('finance', loadsBy) || morningDatasetNeeded_('adv_stats', loadsBy);
}

function maybeEnqueueReportsWhenFinanceReady_(ss, props, loadsBy, loaded) {
  if (morningChainOn_(props)) return;
  if (!hasDashboardCode_()) return;
  var today = mskToday_();
  if (props.getProperty(DAILY_TRIGGERED_KEY_) === today) return;
  if (dashQueuePending_(props).length) return;
  if (props.getProperty(DAILY_DASH_STARTED_KEY_) === today) return;
  if (!reportsSourceDatasetsReady_(loadsBy, loaded)) return;
  props.setProperty(DAILY_DASH_STARTED_KEY_, today);
  try {
    enqueueMorningDashboardsIncremental_(ss);
    logMorningStep_(ss, 'отчёты', 'finance+adv', '', 'очередь', 'info/stock', 0);
    if (morningWatchActive_(props)) scheduleDailySheetCheck_(DAILY_CHECK_BUSY_MS_);
  } catch (eDash) {
    props.deleteProperty(DAILY_DASH_STARTED_KEY_);
    log_(ss, '', 'ошибка', 0, 0, 0, limitMsg_(eDash), 0);
  }
}

function continueLoadManual_() {
  var props = PropertiesService.getScriptProperties();
  clearStaleLoadResume_(props);
  if (sheetLoadActive_(props) || props.getProperty(RESUME_KEY)) {
    try { startClearLoadNotice_(); } catch (eClr) {}
    continueLoadFromTrigger_();
    return;
  }
  var ss = null;
  try { ss = activeSpreadsheet_(); } catch (eSs) {}
  if (morningWatchActive_(props)) {
    logMorningStep_(ss, 'watch', '', '', 'продолжить', 'нет паузы — тот же лист утра', 0);
    try { ss.toast('Нет паузы. Продолжаем утро…', APP_NAME_, 10); } catch (eT) {}
    scheduleMorningWork_(1000);
    return;
  }
  try {
    SpreadsheetApp.getUi().alert(
      APP_NAME_,
      'Нет сохранённой паузы.\n\n«Загрузить всё» — все листы.\nУтро — «Запустить утро» или дождитесь auto.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (eUi) {}
}

function morningDatasetNeeded_(ds, loadsBy) {
  if (!morningDatasetEnabled_(ds)) return false;
  if (ds === 'product_prices') return true;
  var item = loadsBy && loadsBy[ds];
  if (item && item.access_enabled === false) return false;
  return true;
}

function morningAllSheetsLoaded_(loaded, loadsBy) {
  var order = morningLoadOrder_();
  var i;
  var ds;
  var need = 0;
  for (i = 0; i < order.length; i++) {
    ds = order[i];
    if (!morningDatasetNeeded_(ds, loadsBy)) continue;
    need++;
    if (loaded.indexOf(ds) < 0) return false;
  }
  return need > 0;
}

function sheetLoadStarted_(props) {
  props = props || PropertiesService.getScriptProperties();
  return !!(props.getProperty(LOAD_SESSION_KEY_) || props.getProperty(RESUME_KEY));
}

function datasetSheetNames_(scope) {
  if (!scope || scope === 'all') return null;
  return (DATASET_SHEETS_[scope] || []).slice();
}

function sheetLoadFinish_(id, ok, err) {
  if (!id) return;
  dbRpc_('sheet_load_finish', {
    p_id: Number(id),
    p_ok: !!ok,
    p_error: ok ? null : String(err || '').substring(0, 400)
  });
}

function ensureSheetLoadWatch_() {
  clearTriggersByHandler_(SHEET_LOAD_HANDLER_);
}

function pollSheetLoadRequest_() {
  return;
}

function dbParseResponse_(res) {
  var code = res.getResponseCode();
  var text = res.getContentText() || '';
  if (code !== 200 && code !== 206 && code !== 416) {
    throw new Error(dbErrorText_(code, text));
  }
  var rows = [];
  if (text && code !== 416) {
    rows = JSON.parse(text);
    if (!rows || !rows.length) rows = [];
  }
  var responseHeaders = res.getHeaders();
  var contentRange = responseHeaders['Content-Range'] || responseHeaders['content-range'] || '';
  return { rows: rows, contentRange: contentRange, code: code };
}

function dbFetch_(path, rangeFrom, rangeTo) {
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var headers = dbHeaders_(cfg.key);
  headers.Range = String(rangeFrom) + '-' + String(rangeTo);
  var res = UrlFetchApp.fetch(cfg.url + path, {
    method: 'get',
    muteHttpExceptions: true,
    headers: headers
  });
  return dbParseResponse_(res);
}

function dbFetchBatch_(path, offset, pageSize, pageCount) {
  pageCount = Math.max(1, Number(pageCount) || 1);
  if (pageCount === 1) return [dbFetch_(path, offset, offset + pageSize - 1)];
  var cfg = getDbConfig_();
  if (!cfg.key) throw new Error('Нет ключа базы. Меню: «Ключ базы».');
  var requests = [];
  for (var i = 0; i < pageCount; i++) {
    var from = offset + i * pageSize;
    var headers = dbHeaders_(cfg.key);
    headers.Range = String(from) + '-' + String(from + pageSize - 1);
    requests.push({
      url: cfg.url + path,
      method: 'get',
      muteHttpExceptions: true,
      headers: headers
    });
  }
  var responses = UrlFetchApp.fetchAll(requests);
  var packs = [];
  for (i = 0; i < responses.length; i++) packs.push(dbParseResponse_(responses[i]));
  return packs;
}

function mskToday_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function dateFromDays_(days) {
  var iso = mskToday_();
  var p = iso.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() - Number(days));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function isEnabled_(v) {
  var s = String(v || '').trim().toLowerCase();
  return s === 'да' || s === 'yes' || s === '1' || s === 'true';
}

function sheetIncludedInLoad_(job, accessMap) {
  if (!job) return false;
  if (job.sheet === 'История цен') return isDatasetAccessAllowed_('product_prices', accessMap);
  return isEnabled_(job.enabled);
}

function isAllDays_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '' || s === 'все' || s === 'all';
}

function normalizeDays_(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) return String(Math.round(v));
  var s = String(v).trim();
  if (isAllDays_(s)) return s;
  var n = Number(String(s).replace(',', '.'));
  if (isFinite(n) && n > 0) return String(Math.round(n));
  return s;
}

function loadSettingsSnapshotKey_(ss) {
  ss = ss || activeSpreadsheet_();
  return LOAD_SETTINGS_SNAPSHOT_KEY_ + '_' + ss.getId();
}

/** Снимок «Вкл» и «Дней» перед пересозданием _Настройки. */
function snapshotLoadSettingsFromSheet_(ss) {
  ss = ss || activeSpreadsheet_();
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return readLoadSettingsSnapshot_(ss);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  var bySheet = {};
  var slug = 'main';
  var i;
  for (i = 0; i < vals.length; i++) {
    var name = String(vals[i][0] || '').trim();
    if (!name) continue;
    bySheet[name] = {
      enabled: isEnabled_(vals[i][4]),
      days: normalizeDays_(vals[i][3]) || String(vals[i][3] || '').trim()
    };
    if (vals[i][6]) slug = String(vals[i][6]).trim() || slug;
  }
  return { slug: slug, bySheet: bySheet, at: Date.now() };
}

function writeLoadSettingsSnapshot_(ss, snap) {
  if (!snap || !snap.bySheet) return;
  PropertiesService.getDocumentProperties().setProperty(
    loadSettingsSnapshotKey_(ss),
    JSON.stringify(snap)
  );
}

function readLoadSettingsSnapshot_(ss) {
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty(loadSettingsSnapshotKey_(ss));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function applyLoadSettingsSnapshot_(ss, snap) {
  if (!snap || !snap.bySheet) return false;
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return false;
  var n = sh.getLastRow() - 1;
  var names = sh.getRange(2, 1, n, 1).getValues();
  var i;
  for (i = 0; i < names.length; i++) {
    var name = String(names[i][0] || '').trim();
    if (!name || !snap.bySheet[name]) continue;
    var rec = snap.bySheet[name];
    var def = defaultSheetByName_(name);
    var dateCol = (def && def.dateCol) || '';
    var locked = !dateCol || !!SETTINGS_SYNC_FROM_CODE_[name];
    var days = locked ? ((def && def.days) || 'все') : (normalizeDays_(rec.days) || rec.days);
    if (!days) days = (def && def.days) || 'все';
    sh.getRange(i + 2, 4).setValue(days);
    sh.getRange(i + 2, 5).setValue(rec.enabled ? 'да' : 'нет');
    if (snap.slug) sh.getRange(i + 2, 7).setValue(snap.slug);
  }
  syncSettingsOrder_(sh);
  hideSettingsSheet_(ss);
  return true;
}

function setupConfigSheets() {
  var added = setupConfigSheets_();
  try {
    var msg = 'Служебные листы готовы.';
    if (added.length) msg += '\nДобавлено в _Настройки: ' + added.join(', ');
    else msg += '\nНовых листов в списке нет (уже были или обновите страницу F5).';
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {}
}

function resetServiceSheets() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.alert(
    'Пересоздать служебные листы',
    'Сотру и заново создам _Настройки, _Колонки и _Лог.\nСырьевые листы (реклама, заказы…) не трогаю.',
    ui.ButtonSet.YES_NO
  );
  if (a !== ui.Button.YES) return;
  var ss = activeSpreadsheet_();
  var settingsBackup = snapshotLoadSettingsFromSheet_(ss);
  if (ss.getSheets().length <= 3) ss.insertSheet('_tmp');
  var names = [SETTINGS_SHEET, COLUMNS_SHEET, LOG_SHEET];
  for (var i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (sh) ss.deleteSheet(sh);
  }
  setupConfigSheets_();
  if (settingsBackup) {
    applyLoadSettingsSnapshot_(ss, settingsBackup);
    writeLoadSettingsSnapshot_(ss, settingsBackup);
  }
  try {
    if (typeof refreshStartStatus_ === 'function') refreshStartStatus_(ss);
  } catch (eStart) { Logger.log('resetServiceSheets start: ' + eStart); }
  var tmp = ss.getSheetByName('_tmp');
  if (tmp && ss.getSheets().length > 1) ss.deleteSheet(tmp);
  ui.alert('Служебные листы пересозданы.\n«Вкл» и «Дней» из прошлых настроек восстановлены.\nСырьё не трогал.');
}

function setupConfigSheets_() {
  var ss = activeSpreadsheet_();
  var added = ensureSettingsRows_(ss);
  var colSh = ensureColumnsSheet_(ss);
  seedColumns_(ss);
  ensureLogSheet_(ss);
  styleSheet_(ss.getSheetByName(SETTINGS_SHEET));
  if (colSh) styleSheet_(colSh);
  hideSettingsSheet_(ss);
  hideColumnsSheet_(ss);
  hideLogSheet_(ss);
  return added;
}

function ensureColumnsSheet_(ss) {
  ss = ss || activeSpreadsheet_();
  var sh = ensureSheet_(ss, COLUMNS_SHEET, [COLUMNS_HEADER]);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var header = sh.getRange(1, 1, 1, Math.max(lastCol, COLUMNS_HEADER.length)).getValues()[0];
  if (String(header[0] || '').trim() !== 'Лист') {
    sh.getRange(1, 1, 1, COLUMNS_HEADER.length).setValues([COLUMNS_HEADER]);
  } else if (String(header[5] || '').trim() !== 'Вкл') {
    sh.getRange(1, 6).setValue('Вкл');
  }
  if (sh.getLastRow() >= 2) {
    var n = sh.getLastRow() - 1;
    var existing = sh.getRange(2, 6, n, 1).getValues();
    var fill = [];
    var changed = false;
    var i;
    for (i = 0; i < n; i++) {
      var v = existing[i][0];
      if (v === '' || v == null) {
        fill.push(['да']);
        changed = true;
      } else {
        fill.push([v]);
      }
    }
    if (changed) sh.getRange(2, 6, n, 1).setValues(fill);
  }
  return sh;
}

function ensureSettingsSheet_(ss) {
  ss = ss || activeSpreadsheet_();
  ensureSheet_(ss, SETTINGS_SHEET, [SETTINGS_HEADER]);
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  sh.getRange(1, 1, 1, SETTINGS_HEADER.length).setValues([SETTINGS_HEADER]);
  hideSettingsSheet_(ss);
}

function ensureSettingsRows_(ss) {
  ss = ss || activeSpreadsheet_();
  ensureSheet_(ss, SETTINGS_SHEET, [SETTINGS_HEADER]);
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  sh.getRange(1, 1, 1, SETTINGS_HEADER.length).setValues([SETTINGS_HEADER]);
  dropObsoleteSettings_(sh);
  var have = {};
  if (sh.getLastRow() >= 2) {
    var exist = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < exist.length; i++) have[String(exist[i][0] || '').trim()] = true;
  }
  var rows = [];
  var added = [];
  for (var s = 0; s < DEFAULT_SHEETS.length; s++) {
    var d = DEFAULT_SHEETS[s];
    if (have[d.sheet]) continue;
    rows.push([d.sheet, d.view, d.dateCol, d.days, d.enabled, 'замена', 'main', 1000, d.order, '', '']);
    added.push(d.sheet);
  }
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, SETTINGS_HEADER.length).setValues(rows);
  reorderSettingsRows_(sh);
  syncSettingsOrder_(sh);
  hideSettingsSheet_(ss);
  return added;
}

function reorderSettingsRows_(sh) {
  if (!sh || sh.getLastRow() < 2) return;
  var order = typeof LOAD_SETTINGS_ORDER_ !== 'undefined' ? LOAD_SETTINGS_ORDER_ : [];
  var rank = {};
  var i;
  for (i = 0; i < order.length; i++) rank[order[i]] = i;
  var n = sh.getLastRow() - 1;
  var cols = SETTINGS_HEADER.length;
  var vals = sh.getRange(2, 1, n, cols).getValues();
  var before = [];
  for (i = 0; i < vals.length; i++) before.push(String(vals[i][0] || '').trim());
  vals.sort(function (a, b) {
    var na = String(a[0] || '').trim();
    var nb = String(b[0] || '').trim();
    var ra = rank[na];
    var rb = rank[nb];
    if (ra == null && rb == null) return na.localeCompare(nb);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
  var needWrite = false;
  for (i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() !== before[i]) {
      needWrite = true;
      break;
    }
  }
  if (needWrite) sh.getRange(2, 1, n, cols).setValues(vals);
}

var LOAD_SETTINGS_ORDER_ = [
  'Финансовые ежедневные', 'Рекламные расходы', 'Товары',
  'Остатки FBW', 'Остатки FBS', 'Остатки ЛК',
  'Заказы FBW', 'Заказы FBS', 'Поставки FBW', 'Поставки FBS', 'Воронка продаж',
  'Продажи FBW', 'Продажи по регионам', 'Возвраты товаров', 'Лента заказов', 'Отзывы', 'Вопросы',
  'Поисковые запросы', 'Тарифы', 'Удержания WB', 'Складские услуги', 'Заявки на возврат', 'Акции',
  'История цен', 'Склады FBS'
];

/** Справочники: «Дней» всегда из DEFAULT_SHEETS (не из старой строки _Настройки). */
var SETTINGS_SYNC_FROM_CODE_ = { 'Тарифы': true, 'Акции': true, 'История цен': true };

var EXTRA_HIDE_SHEETS_ = ['Склады_стыковка'];

function hideableDataSheetNames_() {
  return LOAD_SETTINGS_ORDER_.concat(EXTRA_HIDE_SHEETS_);
}

function hideSettingsSheet_(ss) {
  ss = ss || activeSpreadsheet_();
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh) return;
  try { sh.hideSheet(); } catch (e) {}
}

function hideColumnsSheet_(ss) {
  ss = ss || activeSpreadsheet_();
  var sh = ss.getSheetByName(COLUMNS_SHEET);
  if (!sh) return;
  try { sh.hideSheet(); } catch (e) {}
}

function hideLogSheet_(ss, force) {
  ss = ss || activeSpreadsheet_();
  var sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) return;
  if (!force && !sh.isSheetHidden()) return;
  try { sh.hideSheet(); } catch (e) {}
}

function showLogSheet() {
  var ss = activeSpreadsheet_();
  var sh = ensureLogSheet_(ss);
  try { styleLogSheet_(sh); } catch (eStyle) {}
  try { sh.showSheet(); ss.setActiveSheet(sh); } catch (e) {}
}

var DATA_SHEETS_HIDDEN_KEY_ = 'DATA_SHEETS_HIDDEN';

function visibleSheetCount_(ss) {
  var sheets = ss.getSheets();
  var n = 0;
  var i;
  for (i = 0; i < sheets.length; i++) {
    if (!sheets[i].isSheetHidden()) n++;
  }
  return n;
}

function hideDataSheets_(ss, force) {
  ss = ss || activeSpreadsheet_();
  if (!force) {
    var flag = '';
    try { flag = PropertiesService.getScriptProperties().getProperty(DATA_SHEETS_HIDDEN_KEY_) || ''; } catch (eF) {}
    if (flag !== '1') return 0;
  }
  var n = 0;
  var i;
  var names = hideableDataSheetNames_();
  for (i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (!sh || sh.isSheetHidden()) continue;
    if (visibleSheetCount_(ss) <= 1) break;
    try { sh.hideSheet(); n++; } catch (eH) {}
  }
  hideLogSheet_(ss);
  return n;
}

function rehideDataSheetsIfWanted_(ss) {
  hideDataSheets_(ss, false);
}

function hideDataSheets() {
  var ss = activeSpreadsheet_();
  var n = hideDataSheets_(ss, true);
  try { PropertiesService.getScriptProperties().setProperty(DATA_SHEETS_HIDDEN_KEY_, '1'); } catch (eP) {}
  try {
    SpreadsheetApp.getUi().alert(
      APP_NAME_,
      'Скрыто листов данных: ' + n + '.\nУтро и «Загрузить всё» всё равно их обновят.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (eA) {
    try { ss.toast('Скрыто ' + n, APP_NAME_, 8); } catch (eT) {}
  }
}

function showDataSheets() {
  var ss = activeSpreadsheet_();
  try { PropertiesService.getScriptProperties().deleteProperty(DATA_SHEETS_HIDDEN_KEY_); } catch (eP) {}
  var n = 0;
  var i;
  var names = hideableDataSheetNames_();
  for (i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (!sh || !sh.isSheetHidden()) continue;
    try { sh.showSheet(); n++; } catch (eS) {}
  }
  try {
    SpreadsheetApp.getUi().alert(APP_NAME_, 'Показано листов данных: ' + n + '.', SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (eA) {
    try { ss.toast('Показано ' + n, APP_NAME_, 8); } catch (eT) {}
  }
}

function showLoadSettingsDialog() {
  var t = HtmlService.createTemplateFromFile('load_settings');
  t.payload = JSON.stringify(getLoadSettings());
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(580).setHeight(640), 'Настройки загрузки');
}

function showColumnSettingsDialog() {
  var ss = activeSpreadsheet_();
  ensureColumnsSheet_(ss);
  seedColumns_(ss);
  var t = HtmlService.createTemplateFromFile('column_settings');
  t.payload = JSON.stringify(getColumnSettings(ss));
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(560).setHeight(640), 'Колонки листов');
}

function defaultSheetByName_(name) {
  for (var s = 0; s < DEFAULT_SHEETS.length; s++) {
    if (DEFAULT_SHEETS[s].sheet === name) return DEFAULT_SHEETS[s];
  }
  return null;
}

function getLoadSettings() {
  var ss = activeSpreadsheet_();
  ensureSettingsSheet_(ss);
  var settings = readSettings_(ss);
  var byName = {};
  var slug = 'main';
  var i;
  for (i = 0; i < settings.length; i++) {
    byName[settings[i].sheet] = settings[i];
    if (settings[i].slug) slug = settings[i].slug;
  }
  var meta = {};
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (sh && sh.getLastRow() >= 2) {
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
    for (i = 0; i < vals.length; i++) {
      var nm = String(vals[i][0] || '').trim();
      if (!nm) continue;
      meta[nm] = {
        period: String(vals[i][9] || ''),
        updated: String(vals[i][10] || '')
      };
    }
  }
  var rows = [];
  for (i = 0; i < LOAD_SETTINGS_ORDER_.length; i++) {
    var name = LOAD_SETTINGS_ORDER_[i];
    var def = defaultSheetByName_(name);
    var job = byName[name];
    if (!job && !def) continue;
    var dateCol = (job && job.dateCol) || (def && def.dateCol) || '';
    rows.push({
      sheet: name,
      enabled: job ? isEnabled_(job.enabled) : isEnabled_(def && def.enabled),
      days: SETTINGS_SYNC_FROM_CODE_[name]
        ? ((def && def.days) || 'все')
        : ((job && job.days) || (def && def.days) || 'все'),
      daysLocked: !dateCol || !!SETTINGS_SYNC_FROM_CODE_[name],
      period: (meta[name] && meta[name].period) || '',
      updated: (meta[name] && meta[name].updated) || ''
    });
  }
  return { slug: slug || 'main', rows: rows };
}

function saveLoadSettings(payload) {
  if (!payload || !payload.rows) throw new Error('Нет данных');
  var ss = activeSpreadsheet_();
  ensureSettingsSheet_(ss);
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) throw new Error('Нет листа настроек');
  var slug = String(payload.slug || 'main').trim() || 'main';
  var by = {};
  var i;
  for (i = 0; i < payload.rows.length; i++) {
    if (payload.rows[i] && payload.rows[i].sheet) by[payload.rows[i].sheet] = payload.rows[i];
  }
  var n = sh.getLastRow() - 1;
  var names = sh.getRange(2, 1, n, 1).getValues();
  for (i = 0; i < names.length; i++) {
    var name = String(names[i][0] || '').trim();
    if (!name) continue;
    var row = by[name];
    var def = defaultSheetByName_(name);
    var dateCol = (def && def.dateCol) || '';
    var locked = !dateCol || !!SETTINGS_SYNC_FROM_CODE_[name];
    var days = locked ? ((def && def.days) || 'все') : normalizeDays_(row && row.days);
    if (!days) days = (def && def.days) || 'все';
    var enabled = row ? !!row.enabled : isEnabled_(sh.getRange(i + 2, 5).getValue());
    sh.getRange(i + 2, 4).setValue(days);
    sh.getRange(i + 2, 5).setValue(enabled ? 'да' : 'нет');
    sh.getRange(i + 2, 7).setValue(slug);
  }
  hideSettingsSheet_(ss);
  writeLoadSettingsSnapshot_(ss, snapshotLoadSettingsFromSheet_(ss));
}

function syncSettingsOrder_(sh) {
  if (!sh || sh.getLastRow() < 2) return false;
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 9).getValues();
  var changed = false;
  var i;
  var s;
  for (i = 0; i < vals.length; i++) {
    var name = String(vals[i][0] || '').trim();
    if (!name) continue;
    for (s = 0; s < DEFAULT_SHEETS.length; s++) {
      if (DEFAULT_SHEETS[s].sheet !== name) continue;
      var def = DEFAULT_SHEETS[s];
      var want = def.order || '';
      if (want && String(vals[i][8] || '').trim() !== want) {
        vals[i][8] = want;
        changed = true;
      }
      if (SETTINGS_SYNC_FROM_CODE_[name]) {
        var wantDays = normalizeDays_(def.days || 'все');
        if (normalizeDays_(vals[i][3]) !== wantDays) {
          vals[i][3] = wantDays;
          changed = true;
        }
        var wantView = String(def.view || '').trim();
        if (wantView && String(vals[i][1] || '').trim() !== wantView) {
          vals[i][1] = wantView;
          changed = true;
        }
      }
      break;
    }
  }
  if (changed) sh.getRange(2, 1, n, 9).setValues(vals);
  return changed;
}

function dropObsoleteSettings_(sh) {
  if (!sh || sh.getLastRow() < 2) return;
  var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = names.length - 1; i >= 0; i--) {
    var name = String(names[i][0] || '').trim();
    if (OBSOLETE_SHEETS[name]) sh.deleteRow(i + 2);
  }
}

function isSsUnavailable_(err) {
  var s = String(err && err.message ? err.message : err || '');
  return /недоступен документ|not available to the (spreadsheet|document)|failed while accessing document|Service Spreadsheets/i.test(s);
}

function rememberSsId_(ss) {
  if (!ss) return;
  try {
    PropertiesService.getScriptProperties().setProperty(SS_ID_KEY_, ss.getId());
  } catch (e) {}
}

function activeSpreadsheet_() {
  if (SS_CACHE_) {
    try {
      SS_CACHE_.getId();
      return SS_CACHE_;
    } catch (e0) {
      SS_CACHE_ = null;
    }
  }
  var props = PropertiesService.getScriptProperties();
  var id = '';
  try { id = String(props.getProperty(SS_ID_KEY_) || '').trim(); } catch (e1) {}
  var lastErr = null;
  var i;
  for (i = 0; i < 4; i++) {
    if (i) Utilities.sleep(1200 * i);
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss && id) ss = SpreadsheetApp.openById(id);
      if (ss) {
        rememberSsId_(ss);
        SS_CACHE_ = ss;
        return ss;
      }
    } catch (err) {
      lastErr = err;
    }
    if (id) {
      try {
        var opened = SpreadsheetApp.openById(id);
        rememberSsId_(opened);
        SS_CACHE_ = opened;
        return opened;
      } catch (err2) {
        lastErr = err2;
      }
    }
  }
  throw lastErr || new Error('Нет доступа к таблице');
}

function ensureSheet_(ss, name, header) {
  var i;
  var lastErr = null;
  for (i = 0; i < 3; i++) {
    try {
      if (!ss) ss = activeSpreadsheet_();
      var sh = ss.getSheetByName(name);
      if (!sh) sh = ss.insertSheet(name);
      if (sh.getLastRow() < 1) {
        sh.getRange(1, 1, 1, header[0].length).setValues(header);
      }
      return sh;
    } catch (err) {
      lastErr = err;
      if (!isSsUnavailable_(err) || i === 2) throw err;
      Utilities.sleep(1200 * (i + 1));
      SS_CACHE_ = null;
      ss = null;
    }
  }
  throw lastErr;
}

var LOG_HEADER_ = ['Время', 'Лист', 'Статус', 'Строк', 'Страниц', 'Offset', 'Ошибка', 'Длительность_мс', 'Сек'];
var LOG_SEK_COL_ = 9;

var LOG_SHEET_READY_ = false;

function ensureLogSheet_(ss) {
  var sh = ensureSheet_(ss, LOG_SHEET, [LOG_HEADER_]);
  if (LOG_SHEET_READY_) {
    hideLogSheet_(ss);
    return sh;
  }
  if (String(sh.getRange(1, 1).getValue() || '') !== LOG_HEADER_[0]) {
    sh.getRange(1, 1, 1, LOG_HEADER_.length).setValues([LOG_HEADER_]);
  }
  styleLogSheet_(sh);
  if (sh.getLastRow() >= 2) {
    var v2 = String(sh.getRange(2, LOG_SEK_COL_).getValue() || '').trim();
    if (v2 === 'Сек') sh.getRange(2, LOG_SEK_COL_).clearContent();
  }
  LOG_SHEET_READY_ = true;
  hideLogSheet_(ss);
  return sh;
}

function styleLogSheet_(sh) {
  if (!sh) return;
  var lastRow = Math.max(sh.getLastRow(), 1);
  var cols = LOG_HEADER_.length;
  styleHeader_(sh, cols);
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(LOG_SEK_COL_, 70);
  if (lastRow >= 2) {
    styleBody_(sh, 2, lastRow - 1, cols);
    sh.getRange(2, LOG_SEK_COL_, lastRow - 1, 1).setNumberFormat('0.0');
  }
  applyFilter_(sh);
}

function seedColumns_(ss) {
  var sh = ensureColumnsSheet_(ss);
  var have = {};
  if (sh.getLastRow() >= 2) {
    var exist = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < exist.length; i++) {
      var sheetName = String(exist[i][0] || '').trim();
      var key0 = String(exist[i][1] || '').trim();
      have[sheetName + '\t' + key0] = true;
    }
  }
  var add = [];
  for (var s = 0; s < DEFAULT_SHEETS.length; s++) {
    var d = DEFAULT_SHEETS[s];
    var keys = sheetKeys_(d);
    for (var t = 0; t < keys.length; t++) {
      var key = keys[t];
      var k = d.sheet + '\t' + key;
      if (have[k]) continue;
      have[k] = true;
      add.push([d.sheet, key, ruName_(d.sheet, key), (t + 1) * 10, ID_KEYS[key] ? 'да' : '', columnSeedEnabled_(d, key)]);
    }
  }
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, COLUMNS_HEADER.length).setValues(add);
  repairFboStockDropPriceColumns_(sh);
  repairColumnRuNames_(sh);
  clearColumnMapsCache_();
}

function repairColumnRuNames_(sh) {
  if (!sh || sh.getLastRow() < 2) return false;
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 6).getValues();
  var changed = false;
  var i;
  for (i = 0; i < vals.length; i++) {
    var sheetName = String(vals[i][0] || '').trim();
    var key = String(vals[i][1] || '').trim();
    if (!sheetName || !key) continue;
    var ru = String(vals[i][2] || '').trim();
    var autoRu = ruName_(sheetName, key);
    if (!autoRu || autoRu === key) continue;
    if (!ru || ru === key) {
      vals[i][2] = autoRu;
      changed = true;
      continue;
    }
    if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(ru) && /[а-яА-ЯёЁ]/.test(autoRu)) {
      vals[i][2] = autoRu;
      changed = true;
    }
  }
  if (changed) sh.getRange(2, 1, n, 6).setValues(vals);
  return changed;
}

function repairFboStockDropPriceColumns_(sh) {
  if (!sh || sh.getLastRow() < 2) return;
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 6).getValues();
  var changed = false;
  var i;
  for (i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() !== 'Остатки FBW') continue;
    var key = String(vals[i][1] || '').trim();
    if (key !== 'price' && key !== 'discounted_price') continue;
    if (String(vals[i][5] || '').trim().toLowerCase() !== 'нет') {
      vals[i][5] = 'нет';
      changed = true;
    }
  }
  if (changed) sh.getRange(2, 1, n, 6).setValues(vals);
}

function splitKeys_(s) {
  return String(s || '').split(',').map(function (x) {
    return String(x || '').trim();
  }).filter(function (x) { return x; });
}

function columnTypedSet_(d) {
  var out = {};
  var typed = splitKeys_(d && d.typed);
  var i;
  for (i = 0; i < typed.length; i++) out[typed[i]] = true;
  return out;
}

/** Как в DMZ: typed + обяз./info — да, прочие extra — нет. */
function columnSeedEnabled_(d, key) {
  if (!d || !key) return 'нет';
  if (requiredKeySet_(d)[key] || infoKeySet_(d)[key]) return 'да';
  if (columnTypedSet_(d)[key]) return 'да';
  return 'нет';
}

function readDmzColumnEnabledMap_() {
  var dmz = SpreadsheetApp.openById(DMZ_COLUMNS_SOURCE_ID_);
  var dmzSh = dmz.getSheetByName(COLUMNS_SHEET);
  if (!dmzSh || dmzSh.getLastRow() < 2) throw new Error('В книге DMZ нет листа _Колонки');
  var dmzVals = dmzSh.getRange(2, 1, dmzSh.getLastRow() - 1, 6).getValues();
  var out = {};
  var i;
  for (i = 0; i < dmzVals.length; i++) {
    var sn = String(dmzVals[i][0] || '').trim();
    var key = String(dmzVals[i][1] || '').trim();
    if (!sn || !key) continue;
    if (KEY_ALIASES_[key]) key = KEY_ALIASES_[key];
    out[sn + '\t' + key] = dmzVals[i][5];
  }
  return out;
}

function applyDmzColumnEnabled_(sh) {
  if (!sh || sh.getLastRow() < 2) return { copied: 0, unmatched: 0, changed: false };
  var dmzBy = readDmzColumnEnabledMap_();
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 6).getValues();
  var copied = 0;
  var unmatched = 0;
  var changed = false;
  var i;
  for (i = 0; i < vals.length; i++) {
    var sheetName = String(vals[i][0] || '').trim();
    var key = String(vals[i][1] || '').trim();
    if (!sheetName || !key) continue;
    if (KEY_ALIASES_[key]) key = KEY_ALIASES_[key];
    var def = defaultSheetByName_(sheetName);
    var locked = def ? lockedKeySet_(def) : {};
    var want;
    if (locked[key]) {
      want = 'да';
    } else if (Object.prototype.hasOwnProperty.call(dmzBy, sheetName + '\t' + key)) {
      want = isColEnabled_(dmzBy[sheetName + '\t' + key]) ? 'да' : 'нет';
      copied++;
    } else {
      unmatched++;
      continue;
    }
    if (String(vals[i][5] || '') !== want) {
      vals[i][5] = want;
      changed = true;
    }
  }
  if (changed) sh.getRange(2, 1, n, 6).setValues(vals);
  if (changed) clearColumnMapsCache_();
  return { copied: copied, unmatched: unmatched, changed: changed };
}

function copyColumnSettingsFromDmz() {
  var ss = activeSpreadsheet_();
  ensureColumnsSheet_(ss);
  seedColumns_(ss);
  var sh = ss.getSheetByName(COLUMNS_SHEET);
  var r = applyDmzColumnEnabled_(sh);
  PropertiesService.getScriptProperties().setProperty('COLUMN_SYNC_FROM_DMZ_V1', '1');
  SpreadsheetApp.getUi().alert(
    'Галочки из DMZ проставлены.\nСовпало с DMZ: ' + r.copied +
    '\nТолько в main (не трогал): ' + r.unmatched +
    (r.changed ? '' : '\nУже совпадало.')
  );
}

function sheetKeys_(d) {
  if (!d) return [];
  var keys = splitKeys_(d.typed);
  var extra = splitKeys_(d.extra);
  for (var i = 0; i < extra.length; i++) {
    if (extra[i] && keys.indexOf(extra[i]) < 0) keys.push(extra[i]);
  }
  return keys;
}

function requiredKeySet_(d) {
  var out = {};
  if (!d) return out;
  var have = {};
  var all = sheetKeys_(d);
  var i;
  for (i = 0; i < all.length; i++) have[all[i]] = true;
  function add(k) {
    if (k && have[k]) out[k] = true;
  }
  add(d.dateCol);
  var rowKeys = SHEET_ROW_KEYS_[d.sheet] || [];
  for (i = 0; i < rowKeys.length; i++) add(rowKeys[i]);
  var ov = typeof clientOverlayInputs_ === 'function' ? (clientOverlayInputs_(d.sheet) || []) : [];
  for (i = 0; i < ov.length; i++) add(ov[i]);
  return out;
}

function infoKeySet_(d) {
  var out = {};
  if (!d) return out;
  var have = {};
  var all = sheetKeys_(d);
  var i;
  for (i = 0; i < all.length; i++) have[all[i]] = true;
  var info = INFO_KEYS_BY_SHEET_[d.sheet] || [];
  for (i = 0; i < info.length; i++) {
    if (info[i] && have[info[i]]) out[info[i]] = true;
  }
  return out;
}

function lockedKeySet_(d) {
  var out = requiredKeySet_(d);
  var info = infoKeySet_(d);
  var k;
  for (k in info) {
    if (Object.prototype.hasOwnProperty.call(info, k)) out[k] = true;
  }
  return out;
}

function isColEnabled_(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return true;
  return s === 'да' || s === 'yes' || s === '1' || s === 'true';
}

function selectedKeys_(job, colInfo) {
  var def = job ? defaultSheetByName_(job.sheet) : null;
  if (!def && job) def = job;
  if (!def) return [];
  var required = requiredKeySet_(def);
  var catalog = sheetKeys_(def);
  var catalogHave = {};
  var i;
  for (i = 0; i < catalog.length; i++) catalogHave[catalog[i]] = true;
  var seen = {};
  var out = [];
  function push(k) {
    if (!k || k === 'extra' || k === 'payload' || OVERLAY_ONLY_KEYS_[k] || seen[k] || !catalogHave[k]) return;
    seen[k] = true;
    out.push(k);
  }
  var order = (colInfo && colInfo.order) || [];
  var enabled = (colInfo && colInfo.enabled) || {};
  var locked = lockedKeySet_(def);
  if (order.length) {
    for (i = 0; i < order.length; i++) {
      var k = order[i];
      if (locked[k] || enabled[k] !== false) push(k);
    }
  }
  for (i = 0; i < catalog.length; i++) {
    if (locked[catalog[i]]) push(catalog[i]);
  }
  if (!order.length) {
    for (i = 0; i < catalog.length; i++) push(catalog[i]);
  }
  return out;
}

function isAsciiIdentifier_(s) {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(String(s || '').trim());
}

function hasCyrillic_(s) {
  return /[а-яА-ЯёЁ]/.test(String(s || ''));
}

function displayName_(sheetName, key, colInfo) {
  var autoRu = ruName_(sheetName, key);
  var stored = colInfo && colInfo.map && colInfo.map[key] ? String(colInfo.map[key]).trim() : '';
  if (autoRu && autoRu !== key) {
    if (!stored || stored === key) return autoRu;
    if (isAsciiIdentifier_(stored) && hasCyrillic_(autoRu)) return autoRu;
  }
  return stored || autoRu || key;
}

function columnRuLookup_(key) {
  if (!key) return '';
  if (COLUMN_RU[key]) return COLUMN_RU[key];
  var lower = String(key).toLowerCase();
  for (var k in COLUMN_RU) {
    if (!Object.prototype.hasOwnProperty.call(COLUMN_RU, k)) continue;
    if (String(k).toLowerCase() === lower) return COLUMN_RU[k];
  }
  return '';
}

function ruName_(sheetName, key) {
  if (key && key.indexOf('char:') === 0) return key.substring(5);
  if (sheetName === 'Рекламные расходы' && key === 'date') return 'Дата статы';
  if (sheetName === 'Заказы FBW' && key === 'date') return 'Дата-время API';
  if (sheetName === 'Продажи FBW' && key === 'date') return 'Дата-время API';
  if (sheetName === 'Финансовые ежедневные' && key === 'order_dt') return 'Дата заказа фин.';
  if (sheetName === 'История цен' && key === 'price') return 'Цена, ₽';
  if (sheetName === 'История цен' && key === 'discounted_price') return 'Цена со скидкой, ₽';
  if (sheetName === 'История цен' && key === 'club_discounted_price') return 'Цена клуба, ₽';
  if (sheetName === 'Заказы FBS' && key === 'price') return 'Цена, ₽';
  if (sheetName === 'Заказы FBS' && key === 'convertedPrice') return 'Цена конв., ₽';
  if (sheetName === 'Заказы FBS' && key === 'scanPrice') return 'Цена скана, ₽';
  if ((sheetName === 'Заказы FBS' || sheetName === 'Поставки FBS') && key === 'wb_status') return 'Статус WB';
  if ((sheetName === 'Заказы FBS' || sheetName === 'Поставки FBS') && key === 'supplier_status') return 'Статус продавца';
  if (sheetName === 'Тарифы' && key === 'warehouse_name') return 'Склад';
  if (sheetName === 'Тарифы' && key === 'subject_name') return 'Предмет';
  if (sheetName === 'Тарифы' && key === 'rate_value') return 'Ставка, ₽';
  var ru = columnRuLookup_(key);
  if (ru) return ru;
  return key;
}

function readSettings_(ss) {
  ss = ss || activeSpreadsheet_();
  ensureSettingsSheet_(ss);
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var sheet = String(vals[i][0] || '').trim();
    if (!sheet || OBSOLETE_SHEETS[sheet]) continue;
    out.push({
      sheet: sheet,
      view: String(vals[i][1] || '').trim(),
      dateCol: String(vals[i][2] || '').trim(),
      days: normalizeDays_(vals[i][3]),
      enabled: vals[i][4],
      mode: String(vals[i][5] || 'замена').trim(),
      slug: String(vals[i][6] || 'main').trim(),
      page: Number(vals[i][7]) || 1000,
      order: String(vals[i][8] || '').trim()
    });
  }
  return out;
}

var COLUMN_MAPS_CACHE_ = null;

function clearColumnMapsCache_() {
  COLUMN_MAPS_CACHE_ = null;
}

function readAllColumnMaps_(ss, force) {
  if (!force && COLUMN_MAPS_CACHE_) return COLUMN_MAPS_CACHE_;
  var sh = ss.getSheetByName(COLUMNS_SHEET);
  var bySheet = {};
  if (!sh || sh.getLastRow() < 2) return bySheet;
  var nCols = Math.max(sh.getLastColumn(), 6);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, nCols).getValues();
  var rowsBySheet = {};
  var i;
  for (i = 0; i < vals.length; i++) {
    var sheetName = String(vals[i][0] || '').trim();
    if (!sheetName) continue;
    var key = String(vals[i][1] || '').trim();
    if (!key) continue;
    if (KEY_ALIASES_[key]) key = KEY_ALIASES_[key];
    if (OVERLAY_ONLY_KEYS_[key]) continue;
    if (!rowsBySheet[sheetName]) rowsBySheet[sheetName] = [];
    rowsBySheet[sheetName].push({
      key: key,
      ru: String(vals[i][2] || '').trim(),
      ord: Number(vals[i][3]) || 9999,
      enabledRaw: vals[i][5]
    });
  }
  for (var sn in rowsBySheet) {
    if (!Object.prototype.hasOwnProperty.call(rowsBySheet, sn)) continue;
    var def = defaultSheetByName_(sn);
    var locked = lockedKeySet_(def || { sheet: sn });
    var map = {};
    var order = [];
    var enabled = {};
    var seen = {};
    var rows = rowsBySheet[sn];
    rows.sort(function (a, b) { return a.ord - b.ord; });
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (seen[row.key]) continue;
      seen[row.key] = true;
      var ruLabel = String(row.ru || '').trim();
      map[row.key] = displayName_(sn, row.key, { map: { [row.key]: ruLabel } });
      enabled[row.key] = locked[row.key] || isColEnabled_(row.enabledRaw);
      order.push(row.key);
    }
    bySheet[sn] = { map: map, order: order, enabled: enabled };
  }
  COLUMN_MAPS_CACHE_ = bySheet;
  return bySheet;
}

function readColumnMap_(ss, sheetName) {
  var empty = { map: {}, order: [], enabled: {} };
  if (!ss || !sheetName) return empty;
  var all = readAllColumnMaps_(ss);
  return all[sheetName] || empty;
}

function appendColumnDict_(ss, sheetName, key, ru, ord, enabled) {
  var sh = ensureColumnsSheet_(ss);
  var on = enabled == null ? 'да' : (enabled ? 'да' : 'нет');
  sh.appendRow([sheetName, key, ru || '', ord, ID_KEYS[key] ? 'да' : '', on]);
}

function getColumnSettings(ss) {
  ss = ss || activeSpreadsheet_();
  var allCols = readAllColumnMaps_(ss);
  var sheets = [];
  var i;
  var c;
  for (i = 0; i < LOAD_SETTINGS_ORDER_.length; i++) {
    var name = LOAD_SETTINGS_ORDER_[i];
    var def = defaultSheetByName_(name);
    if (!def) continue;
    var colInfo = allCols[name] || { map: {}, order: [], enabled: {} };
    var required = requiredKeySet_(def);
    var info = infoKeySet_(def);
    var catalog = sheetKeys_(def);
    var seen = {};
    var columns = [];
    var order = colInfo.order.length ? colInfo.order : catalog;
    var sources = order.concat(catalog);
    for (c = 0; c < sources.length; c++) {
      var key = sources[c];
      if (!key || seen[key] || OVERLAY_ONLY_KEYS_[key]) continue;
      if (catalog.indexOf(key) < 0) continue;
      seen[key] = true;
      var req = !!required[key];
      var forInfo = !req && !!info[key];
      columns.push({
        key: key,
        ru: displayName_(name, key, colInfo),
        required: req,
        info: forInfo,
        enabled: req || forInfo || colInfo.enabled[key] !== false
      });
    }
    sheets.push({ sheet: name, columns: columns });
  }
  return { sheets: sheets };
}

function saveColumnSettings(payload) {
  if (!payload || !payload.sheets) throw new Error('Нет данных');
  var ss = activeSpreadsheet_();
  var sh = ensureColumnsSheet_(ss);
  seedColumns_(ss);
  var by = {};
  var i;
  var c;
  for (i = 0; i < payload.sheets.length; i++) {
    var item = payload.sheets[i];
    if (!item || !item.sheet) continue;
    var map = {};
    var cols = item.columns || [];
    for (c = 0; c < cols.length; c++) {
      if (cols[c] && cols[c].key) map[cols[c].key] = !!cols[c].enabled;
    }
    by[item.sheet] = map;
  }
  if (sh.getLastRow() < 2) return;
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 6).getValues();
  var changed = false;
  for (i = 0; i < vals.length; i++) {
    var sheetName = String(vals[i][0] || '').trim();
    var key = String(vals[i][1] || '').trim();
    if (!sheetName || !key || !by[sheetName]) continue;
    var def = defaultSheetByName_(sheetName);
    var locked = lockedKeySet_(def);
    var want = locked[key] ? true : (by[sheetName].hasOwnProperty(key) ? by[sheetName][key] : isColEnabled_(vals[i][5]));
    var next = want ? 'да' : 'нет';
    if (String(vals[i][5] || '') !== next) {
      vals[i][5] = next;
      changed = true;
    }
  }
  if (changed) sh.getRange(2, 1, n, 6).setValues(vals);
  clearColumnMapsCache_();
  hideColumnsSheet_(ss);
}

function resolveSellerId_(slug) {
  var path = '/rest/v1/sheet_sellers?slug=eq.' + encodeURIComponent(slug) + '&select=id';
  var res = dbFetch_(path, 0, 0);
  if (!res.rows.length || !res.rows[0].id) throw new Error('Кабинет не найден: ' + slug);
  return res.rows[0].id;
}

function checkDbConnection() {
  var slug = resolveActiveSlug_();
  var accessMap = refreshDatasetAccessCache_(slug);
  applyAccessUi_(accessMap);
  try {
    var ss = activeSpreadsheet_();
    if (ss && typeof hasStartSheet_ === 'function' && hasStartSheet_(ss)) {
      if (typeof startRefreshAccessSoft_ === 'function') startRefreshAccessSoft_(ss);
      else refreshStartStatus_(ss);
    }
  } catch (eStart) { Logger.log('checkDbConnection start: ' + eStart); }
  SpreadsheetApp.getUi().alert('Доступ обновлён.\nКабинет: ' + slug);
}

/** Замер чистой скорости Supabase (без записи в лист). maxPages — сколько страниц по 1000 строк. */
function benchDbSpeed_(sheetName, maxPages) {
  maxPages = Math.max(1, Math.min(Number(maxPages) || 3, 20));
  var pageSize = 1000;
  var ss = activeSpreadsheet_();
  var job = null;
  var settings = readSettings_(ss);
  var i;
  for (i = 0; i < settings.length; i++) {
    if (settings[i].sheet === sheetName) { job = settings[i]; break; }
  }
  if (!job) job = defaultSheetByName_(sheetName);
  if (!job) throw new Error('Неизвестный лист: ' + sheetName);

  var sellerId = resolveSellerId_(job.slug || 'main');
  var fromIso = '';
  if (job.dateCol && !isAllDays_(job.days)) {
    if (incPolicy_(job) === 'replace') fromIso = dateFromDays_(job.days);
    else fromIso = incFetchFrom_(job);
  }
  var path = buildPath_(job, sellerId, fromIso);
  var lines = [
    'Лист: ' + job.sheet,
    'from: ' + (fromIso || 'всё окно'),
    'URL: ' + path
  ];

  var totalRows = 0;
  var serialMs = 0;
  var offset = 0;
  var pages = 0;
  var p;
  for (p = 0; p < maxPages; p++) {
    var t0 = Date.now();
    var pack = dbFetch_(path, offset, offset + pageSize - 1);
    var ms = Date.now() - t0;
    if (pack.code && pack.code >= 400) {
      throw new Error('HTTP ' + pack.code + ' ' + path);
    }
    serialMs += ms;
    var n = (pack.rows || []).length;
    totalRows += n;
    pages++;
    lines.push('стр ' + pages + ': ' + n + ' строк, ' + (ms / 1000).toFixed(2) + ' с');
    if (n < pageSize) break;
    offset += pageSize;
  }

  if (pages > 0 && offset > 0 && pages < maxPages) {
    var t1 = Date.now();
    var packs = dbFetchBatch_(path, offset, pageSize, Math.min(3, maxPages - pages));
    var batchMs = Date.now() - t1;
    var batchRows = 0;
    for (i = 0; i < packs.length; i++) batchRows += (packs[i].rows || []).length;
    lines.push('пачка ' + packs.length + '×' + pageSize + ': ' + batchRows + ' строк, ' + (batchMs / 1000).toFixed(2) + ' с');
    totalRows += batchRows;
    pages += packs.length;
    serialMs += batchMs;
  }

  var avg = pages > 0 ? Math.round(serialMs / pages) : 0;
  lines.push('—');
  lines.push('Сеть: ' + totalRows + ' строк, ' + pages + ' стр., ' + (serialMs / 1000).toFixed(2) + ' с');
  lines.push('Среднее: ' + avg + ' мс/стр (только UrlFetch, без Sheets)');
  log_(ss, job.sheet, 'бенч', totalRows, pages, 0, 'from ' + (fromIso || 'all'), serialMs);
  return lines.join('\n');
}

function menuBenchDbSpeedThisSheet() {
  var ss = activeSpreadsheet_();
  var name = ss.getActiveSheet().getName();
  if (!defaultSheetByName_(name)) {
    SpreadsheetApp.getUi().alert(
      'Скорость базы',
      'Открой лист данных (Остатки FBW, Воронка…), не служебный.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }
  try {
    var msg = benchDbSpeed_(name, 5);
    SpreadsheetApp.getUi().alert('Скорость базы', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert('Скорость базы', String(e && e.message ? e.message : e), SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

function fetchWarehouseDictRows_(ss) {
  var slug = 'main';
  if (typeof reportSellerSlug_ === 'function') {
    slug = reportSellerSlug_(ss || SpreadsheetApp.getActiveSpreadsheet());
  }
  var sellerId = resolveSellerId_(slug);
  var path = '/rest/v1/sheet_warehouse_dict?seller_id=eq.' + encodeURIComponent(sellerId) +
    '&select=alias,canonical,warehouse_id,region,kind,locked,how,first_seen,last_seen' +
    '&order=region.asc.nullslast,canonical.asc,alias.asc';
  var rows = [];
  var offset = 0;
  var page = 1000;
  var i;
  for (;;) {
    var pack = dbFetch_(path, offset, offset + page - 1);
    var chunk = pack.rows || [];
    for (i = 0; i < chunk.length; i++) rows.push(chunk[i]);
    if (chunk.length < page) break;
    offset += page;
  }
  return rows;
}

function loadWarehouseDict() {
  var ss = typeof activeSpreadsheet_ === 'function' ? activeSpreadsheet_() : SpreadsheetApp.getActiveSpreadsheet();
  var rows = fetchWarehouseDictRows_(ss);
  var name = 'Склады_стыковка';
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  var headers = ['Имя в WB', 'Канон в поставке', 'Склеено', 'Регион', 'ID склада', 'Тип', 'Как', 'Зафиксирован', 'Первый раз', 'Последний раз'];
  var howRu = { rule: 'правило', id: 'по id', name: 'по имени', auto: 'как пришло' };
  var kindRu = { wb: 'WB', fbs: 'FBS', service: 'служебный' };
  var values = [headers];
  var mergeRows = [];
  var i;
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    var alias = String(r.alias || '');
    var canon = String(r.canonical || '');
    var merged = alias !== canon;
    if (merged) mergeRows.push(values.length + 1);
    values.push([
      alias,
      canon,
      merged ? 'да' : '',
      r.region || '',
      r.warehouse_id || '',
      kindRu[r.kind] || r.kind || '',
      howRu[r.how] || r.how || '',
      r.locked ? 'да' : '',
      r.first_seen || '',
      r.last_seen || ''
    ]);
  }
  sh.getRange(1, 1, values.length, headers.length).setValues(values);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#434343')
    .setFontColor('#ffffff');
  if (mergeRows.length) {
    for (i = 0; i < mergeRows.length; i++) {
      sh.getRange(mergeRows[i], 1, 1, headers.length).setBackground('#fff2cc');
    }
  }
  sh.setColumnWidth(1, 280);
  sh.setColumnWidth(2, 280);
  sh.setColumnWidth(3, 80);
  sh.setColumnWidth(4, 220);
  sh.setColumnWidth(5, 110);
  sh.autoResizeColumns(6, 5);
  try { rehideDataSheetsIfWanted_(ss); } catch (eHid) {}
  try {
    SpreadsheetApp.getUi().alert(
      'Склады_стыковка: ' + rows.length + ' имён, склеено ' + mergeRows.length +
      '.\nЖёлтые строки — разные имена WB, в поставке одна колонка.'
    );
  } catch (eAlert) {}
}

function loadOneSheetPrompt() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Имя листа из _Настройки', '', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  loadSheets_([String(r.getResponseText() || '').trim()]);
}

function loadAllFromDb() {
  var props = PropertiesService.getScriptProperties();
  clearStaleLoadResume_(props);
  if (morningWatchActive_(props)) {
    var watchSs = null;
    try { watchSs = activeSpreadsheet_(); } catch (eWatch) {}
    log_(watchSs, '', 'занято', 0, 0, 0, 'идёт утро — дождитесь 07:00 или завершения', 0);
    try { if (watchSs) watchSs.toast('Идёт утреннее авто', APP_NAME_, 8); } catch (eT) {}
    return;
  }
  if (sheetLoadActive_(props) || props.getProperty(RESUME_KEY)) {
    var busySs = null;
    try { busySs = activeSpreadsheet_(); } catch (eBusy) {}
    log_(busySs, '', 'занято', 0, 0, 0, 'идёт загрузка — дождитесь завершения', 0);
    try { busySs.toast('Уже идёт загрузка', APP_NAME_, 8); } catch (eT) {}
    return;
  }
  if (dashQueuePending_(props).length) {
    props.deleteProperty(DASH_QUEUE_KEY_);
    clearTriggersByHandler_(DASH_HANDLER_);
    props.deleteProperty(DAILY_LOAD_AFTER_DASH_KEY_);
  }
  try { startClearLoadNotice_(); } catch (eN) {}
  loadSheets_(null);
}

function loadAllReports_() {
  var ss = activeSpreadsheet_();
  if (!hasDashboardCode_()) {
    SpreadsheetApp.getUi().alert(
      APP_NAME_,
      'В этой книге нет модулей отчётов (info / stock).',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }
  var q = ['info:daily', 'info:monthly'];
  if (ss && (ss.getSheetByName('stock') || ss.getSheetByName('остатки'))) q.push('ops');
  var monday = typeof infoIsMondayMsk_ === 'function'
    ? infoIsMondayMsk_()
    : Utilities.formatDate(new Date(), TZ, 'u') === '1';
  if (monday) q.push('info:weekly');
  enqueueMorningDashboardsIncremental_(ss);
  log_(ss, '', 'отчёты', 0, 0, 0, 'ручн: ' + q.join(', '), 0);
  try { ss.toast('Отчёты: ' + q.join(', '), APP_NAME_, 12); } catch (eT) {}
}

function resetMorningWatchState_(props) {
  props.deleteProperty(DAILY_TRIGGERED_KEY_);
  props.deleteProperty(DAILY_MORNING_STARTED_KEY_);
  props.deleteProperty(DAILY_DASH_STARTED_KEY_);
  props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
  props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
  props.deleteProperty(MORNING_CHAIN_ON_KEY_);
  props.deleteProperty(MORNING_JOB_KEY_);
  props.deleteProperty(DAILY_SUMMARY_DONE_KEY_);
  props.deleteProperty(DAILY_LOAD_AFTER_DASH_KEY_);
  props.deleteProperty(DASH_QUEUE_KEY_);
  props.deleteProperty(dailyLoadedDatasetsKey_());
  props.deleteProperty(RESUME_KEY);
  props.deleteProperty(LOAD_SESSION_KEY_);
  clearContinueTriggers_();
  clearTriggersByHandler_(DASH_HANDLER_);
  clearMorningChainTriggers_();
}

function runMorningNow(optId) {
  var id = String(optId || '').trim() || '1pWuewtGP6lGmXKJ8G0Ue6Yt0iXYNaSnO67u60ATz97I';
  var ss = SpreadsheetApp.openById(id);
  rememberSsId_(ss);
  var props = PropertiesService.getScriptProperties();
  var today = mskToday_();
  resetMorningWatchState_(props);
  props.setProperty(DAILY_WATCH_DATE_KEY_, today);
  props.setProperty(DAILY_WATCH_ATTEMPTS_KEY_, '0');
  startMorningChain_(ss);
}

function clearTriggersByHandler_(handler) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handler) ScriptApp.deleteTrigger(triggers[i]);
  }
}

function installDailyAutoLoad() {
  var ss = activeSpreadsheet_();
  rememberSsId_(ss);
  clearTriggersByHandler_(DAILY_START_HANDLER_);
  clearTriggersByHandler_(DAILY_CHECK_HANDLER_);
  clearMorningChainTriggers_();
  ensureSheetLoadWatch_();
  var props = PropertiesService.getScriptProperties();
  var start = gasDailyStartParts_();
  var hh = start.hour;
  var mm = start.minute;
  var timeLabel = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  ScriptApp.newTrigger(DAILY_START_HANDLER_)
    .timeBased()
    .atHour(hh)
    .nearMinute(mm)
    .everyDays(1)
    .inTimezone(TZ)
    .create();
  props.deleteProperty(DAILY_WATCH_DATE_KEY_);
  props.deleteProperty(DAILY_WATCH_ATTEMPTS_KEY_);
  log_(ss, '', 'авто включено', 0, 0, 0, 'утро: цепочка 1 лист, страховка 7 мин, с ' + timeLabel + ' МСК', 0);
  try {
    SpreadsheetApp.getUi().alert(
      'Ежедневная загрузка включена.\nС ' + timeLabel + ' МСК: листы по одному, без ожидания базы.\nСтраховка 7 минут продолжает тот же лист.\nОтчёты info/stock — после всех листов.'
    );
  } catch (e) {}
}

function disableDailyAutoLoad() {
  clearTriggersByHandler_(DAILY_START_HANDLER_);
  clearTriggersByHandler_(DAILY_CHECK_HANDLER_);
  clearMorningChainTriggers_();
  clearTriggersByHandler_(SHEET_LOAD_HANDLER_);
  clearTriggersByHandler_(DASH_HANDLER_);
  clearContinueTriggers_();
  var props = PropertiesService.getScriptProperties();
  props.setProperty(SHEET_POLL_DISABLED_KEY_, '1');
  props.deleteProperty(DAILY_WATCH_DATE_KEY_);
  props.deleteProperty(DAILY_WATCH_ATTEMPTS_KEY_);
  props.deleteProperty(DAILY_TRIGGERED_KEY_);
  props.deleteProperty(DAILY_LOAD_AFTER_DASH_KEY_);
  props.deleteProperty(DAILY_DASH_STARTED_KEY_);
  props.deleteProperty(DAILY_MORNING_STARTED_KEY_);
  props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
  props.deleteProperty(dailyLoadedDatasetsKey_());
  var ss = null;
  try { ss = activeSpreadsheet_(); } catch (e0) {}
  log_(ss, '', 'авто отключено', 0, 0, 0, 'ежедневная загрузка отключена', 0);
  try { SpreadsheetApp.getUi().alert('Ежедневная загрузка отключена.'); } catch (e1) {}
}

function clearStaleMorningDayState_(props) {
  props = props || PropertiesService.getScriptProperties();
  var today = mskToday_();
  if (props.getProperty(DAILY_WATCH_DATE_KEY_) === today) return;
  props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
  props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
  props.deleteProperty(MORNING_CHAIN_ON_KEY_);
  props.deleteProperty(MORNING_JOB_KEY_);
  props.deleteProperty(MORNING_PHASE_KEY_);
  props.deleteProperty(MORNING_TRIM_INDEX_KEY_);
  props.deleteProperty(MORNING_STATS_KEY_);
  props.deleteProperty(RESUME_KEY);
  props.deleteProperty(LOAD_SESSION_KEY_);
  clearContinueTriggers_();
}

function morningChainOn_(props) {
  props = props || PropertiesService.getScriptProperties();
  return props.getProperty(MORNING_CHAIN_ON_KEY_) === '1'
    && props.getProperty(DAILY_WATCH_DATE_KEY_) === mskToday_()
    && props.getProperty(DAILY_TRIGGERED_KEY_) !== mskToday_();
}

function morningPhase_(props) {
  props = props || PropertiesService.getScriptProperties();
  return props.getProperty(MORNING_PHASE_KEY_) || 'append';
}

function morningAppendFirst_(props) {
  return morningChainOn_(props) && morningPhase_(props) === 'append';
}

function morningRemainingSheets_(ss, props) {
  ss = ss || activeSpreadsheet_();
  props = props || PropertiesService.getScriptProperties();
  var loaded = getDailyLoadedDatasets_(props);
  var queue = morningSheetQueue_(ss);
  var out = [];
  var i;
  var ds;
  for (i = 0; i < queue.length; i++) {
    ds = SHEET_TO_DATASET_[queue[i]];
    if (ds && loaded.indexOf(ds) >= 0) continue;
    out.push(queue[i]);
  }
  return out;
}

function morningBookSlug_() {
  return typeof BOOK_SLUG_ !== 'undefined' ? BOOK_SLUG_ : 'main';
}

function morningSheetSortOrder_(ss, sheetName) {
  var queue = morningSheetQueue_(ss);
  var i;
  for (i = 0; i < queue.length; i++) {
    if (queue[i] === sheetName) return i;
  }
  return 1000;
}

function readMorningStats_(props) {
  props = props || PropertiesService.getScriptProperties();
  try {
    var cur = JSON.parse(props.getProperty(MORNING_STATS_KEY_) || 'null');
    if (cur && cur.day === mskToday_()) return cur;
  } catch (e) {}
  return { day: mskToday_(), startedAt: Date.now(), workMs: 0, overlayMs: 0, trimMs: 0 };
}

function writeMorningStats_(props, cur) {
  (props || PropertiesService.getScriptProperties()).setProperty(MORNING_STATS_KEY_, JSON.stringify(cur));
}

function initMorningStats_(props) {
  props = props || PropertiesService.getScriptProperties();
  var cur = { day: mskToday_(), startedAt: Date.now(), workMs: 0, overlayMs: 0, trimMs: 0 };
  writeMorningStats_(props, cur);
  try {
    dbRpc_('gas_morning_timing_set', {
      p_book_slug: morningBookSlug_(),
      p_run_date: mskToday_(),
      p_started_at: new Date(cur.startedAt).toISOString(),
      p_work_ms: 0,
      p_overlay_ms: 0,
      p_trim_ms: 0,
      p_add: false
    });
  } catch (eT) {
    Logger.log('gas_morning_timing_set start: ' + eT);
  }
}

function morningAddPhaseMs_(phase, ms) {
  ms = Math.max(0, Number(ms) || 0);
  if (!ms) return;
  var props = PropertiesService.getScriptProperties();
  if (!morningChainOn_(props)) return;
  var cur = readMorningStats_(props);
  if (phase === 'work') cur.workMs += ms;
  else if (phase === 'overlay') cur.overlayMs += ms;
  else if (phase === 'trim') cur.trimMs += ms;
  writeMorningStats_(props, cur);
}

function flushMorningTimings_(props) {
  props = props || PropertiesService.getScriptProperties();
  var cur = readMorningStats_(props);
  try {
    dbRpc_('gas_morning_timing_set', {
      p_book_slug: morningBookSlug_(),
      p_run_date: mskToday_(),
      p_started_at: new Date(cur.startedAt).toISOString(),
      p_work_ms: Math.round(Number(cur.workMs) || 0),
      p_overlay_ms: Math.round(Number(cur.overlayMs) || 0),
      p_trim_ms: Math.round(Number(cur.trimMs) || 0),
      p_add: false
    });
  } catch (eT) {
    Logger.log('gas_morning_timing_set: ' + eT);
  }
}

function morningAddSheetTick_(sheet, opt) {
  opt = opt || {};
  if (!sheet) return;
  var y = Math.max(0, Math.round(Number(opt.rowsY) || 0));
  var o = Math.max(0, Math.round(Number(opt.rowsO) || 0));
  if (!y && !o && opt.rows != null) y = Math.max(0, Math.round(Number(opt.rows) || 0));
  var started = new Date(Number(opt.startedAt) || Date.now());
  var finished = new Date(Number(opt.finishedAt) || Date.now());
  var sortOrder = opt.sortOrder;
  if (sortOrder == null) {
    try { sortOrder = morningSheetSortOrder_(null, sheet); } catch (eS) { sortOrder = 1000; }
  }
  try {
    dbRpc_('gas_morning_sheet_tick', {
      p_book_slug: morningBookSlug_(),
      p_run_date: mskToday_(),
      p_sheet_name: String(sheet),
      p_rows_yesterday: y,
      p_rows_old: o,
      p_skipped: !!opt.skipped,
      p_started_at: started.toISOString(),
      p_finished_at: finished.toISOString(),
      p_sort_order: sortOrder
    });
  } catch (eAdd) {
    Logger.log('gas_morning_sheet_tick: ' + eAdd);
    morningAddSheetRows_(sheet, y + o);
  }
}

function morningMarkSheetDone_(ss, job, newRows, opt) {
  if (!job || !job.sheet) return;
  var props = PropertiesService.getScriptProperties();
  var ds = SHEET_TO_DATASET_[job.sheet];
  if (ds) markDailyLoadedDataset_(props, ds);
  if (!morningChainOn_(props)) return;
  opt = opt || {};
  morningAddSheetTick_(job.sheet, {
    rows: newRows,
    rowsY: opt.rowsY,
    rowsO: opt.rowsO,
    skipped: !!opt.skipped,
    startedAt: opt.startedAt,
    finishedAt: Date.now(),
    sortOrder: morningSheetSortOrder_(ss, job.sheet)
  });
}

function reportMorningRows_(rowsWritten, overlayFrom, inc) {
  if (morningAppendFirst_() && inc && overlayFrom >= 2) {
    return Math.max(0, Number(rowsWritten) - (Number(overlayFrom) - 2));
  }
  return Number(rowsWritten) || 0;
}

function morningIsYesterdayRow_(job, iso) {
  if (!job || !job.dateCol) return false;
  var yRef = (incPolicy_(job) === 'snapshot') ? mskToday_() : dateFromDays_(1);
  return !!(iso && iso >= yRef);
}

function incIndexDirtyEdge_(sh, job, keys, dateColIdx, refreshFromIso) {
  var out = { haveKeys: {}, keyRows: {}, ok: true };
  if (!sh || sh.getLastRow() < 2 || dateColIdx < 1) return out;
  if (!refreshFromIso) return out;
  var last = sh.getLastRow();
  var n = last - 1;
  var lastCol = Math.max(sh.getLastColumn(), keys.length);
  var maxScan = 2500;
  var dateDesc = jobDateSortDesc_(job, keys);
  var keyNames = sheetRowKeyNames_(job);
  var take = Math.min(n, maxScan);
  var fromRow = dateDesc ? 2 : (last - take + 1);
  var data = sh.getRange(fromRow, 1, take, lastCol).getValues();
  var dates = sh.getRange(fromRow, dateColIdx, take, 1).getDisplayValues();
  var sawOld = false;
  var i;
  var iso;
  var rk;
  if (dateDesc) {
    for (i = 0; i < take; i++) {
      iso = sheetCellToIso_(dates[i][0]);
      if (!iso) continue;
      if (iso >= refreshFromIso) {
        rk = incRowKey_(data[i], keys, keyNames);
        if (rk) {
          out.haveKeys[rk] = 1;
          out.keyRows[rk] = fromRow + i;
        }
      } else {
        sawOld = true;
        break;
      }
    }
  } else {
    for (i = take - 1; i >= 0; i--) {
      iso = sheetCellToIso_(dates[i][0]);
      if (!iso) continue;
      if (iso >= refreshFromIso) {
        rk = incRowKey_(data[i], keys, keyNames);
        if (rk) {
          out.haveKeys[rk] = 1;
          out.keyRows[rk] = fromRow + i;
        }
      } else {
        sawOld = true;
        break;
      }
    }
  }
  if (take >= maxScan && !sawOld) out.ok = false;
  return out;
}

function morningJobBySheet_(ss, sheetName) {
  var settings = readSettings_(ss) || [];
  var i;
  for (i = 0; i < settings.length; i++) {
    if (settings[i].sheet === sheetName) return settings[i];
  }
  return null;
}

function trimSheetOldWindow_(ss, sheetName) {
  var job = morningJobBySheet_(ss, sheetName);
  if (!job || !job.dateCol || isAllDays_(job.days)) return 0;
  var sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return 0;
  var colInfo = readColumnMap_(ss, sheetName);
  var keys = selectedKeys_(job, colInfo);
  var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var dateIdx = findDateColIndex_(headers0, job, colInfo);
  var keyDateIdx = findDateColIndexFromKeys_(keys, job);
  if (keyDateIdx) dateIdx = keyDateIdx;
  if (!dateIdx) return 0;
  var cutoff = dateFromDays_(job.days);
  if (!cutoff) return 0;
  return incKeepRowsByDate_(sh, job, dateIdx, cutoff, '', keys);
}

function morningTrimTick_(ss, props) {
  props = props || PropertiesService.getScriptProperties();
  ss = ss || activeSpreadsheet_();
  scheduleMorningSafety_();
  var started = Date.now();
  var queue = morningSheetQueue_(ss);
  var i = Number(props.getProperty(MORNING_TRIM_INDEX_KEY_) || 0);
  var dropped = 0;
  var name;
  for (; i < queue.length; i++) {
    if (overBudget_(started, 0)) {
      props.setProperty(MORNING_TRIM_INDEX_KEY_, String(i));
      props.setProperty(MORNING_JOB_KEY_, MORNING_TRIM_JOB_);
      props.setProperty(MORNING_PHASE_KEY_, 'trim');
      morningAddPhaseMs_('trim', Date.now() - started);
      logMorningStep_(ss, 'подрезка', '', queue[i], 'продолжает', 'окно дат', Date.now() - started);
      scheduleMorningWork_(MORNING_GAP_MS_);
      return;
    }
    name = queue[i];
    try {
      dropped += trimSheetOldWindow_(ss, name) || 0;
    } catch (eTrim) {
      log_(ss, name, 'ошибка', 0, 0, 0, 'подрезка: ' + limitMsg_(eTrim), 0);
    }
  }
  props.deleteProperty(MORNING_TRIM_INDEX_KEY_);
  morningAddPhaseMs_('trim', Date.now() - started);
  logMorningStep_(ss, 'подрезка', '', '', 'готово', '−' + dropped + ' стр.', Date.now() - started);
  try { refreshAllPeriodLabels_(ss, null); } catch (eP) {}
  props.setProperty(MORNING_PHASE_KEY_, 'reports');
  props.setProperty(MORNING_JOB_KEY_, MORNING_REPORTS_JOB_);
  scheduleMorningWork_(MORNING_GAP_MS_);
}

function morningSheetQueue_(ss) {
  ss = ss || activeSpreadsheet_();
  var settings = readSettings_(ss);
  var accessMap = accessMapForUse_();
  var want = {};
  var i;
  var job;
  for (i = 0; i < settings.length; i++) {
    job = settings[i];
    if (!sheetIncludedInLoad_(job, accessMap)) continue;
    if (!isSheetAccessAllowed_(job.sheet, accessMap)) continue;
    if (isManualSheet_(job.sheet)) continue;
    want[job.sheet] = true;
  }
  var out = [];
  for (i = 0; i < LOAD_SETTINGS_ORDER_.length; i++) {
    if (want[LOAD_SETTINGS_ORDER_[i]]) out.push(LOAD_SETTINGS_ORDER_[i]);
  }
  return out;
}

function clearMorningChainTriggers_() {
  clearTriggersByHandler_(MORNING_CHAIN_HANDLER_);
  clearTriggersByHandler_(MORNING_SAFETY_HANDLER_);
  clearTriggersByHandler_(DAILY_CHECK_HANDLER_);
}

function scheduleMorningWork_(afterMs) {
  clearTriggersByHandler_(MORNING_CHAIN_HANDLER_);
  ScriptApp.newTrigger(MORNING_CHAIN_HANDLER_)
    .timeBased()
    .after(Math.max(1000, Number(afterMs) || MORNING_GAP_MS_))
    .create();
}

function scheduleMorningSafety_() {
  clearTriggersByHandler_(MORNING_SAFETY_HANDLER_);
  ScriptApp.newTrigger(MORNING_SAFETY_HANDLER_)
    .timeBased()
    .after(MORNING_SAFETY_MS_)
    .create();
}

function bumpMorningWritten_(n) {
  n = Number(n) || 0;
  if (n < 1) return;
  var props = PropertiesService.getScriptProperties();
  if (!morningChainOn_(props)) return;
  var cur = readLoadSession_(props);
  if (!cur) return;
  cur.morningWritten = (Number(cur.morningWritten) || 0) + n;
  props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(cur));
}

function morningAddSheetRows_(sheet, rows) {
  if (!sheet) return;
  try {
    dbRpc_('gas_morning_sheet_add', {
      p_book_slug: typeof BOOK_SLUG_ !== 'undefined' ? BOOK_SLUG_ : 'main',
      p_run_date: mskToday_(),
      p_sheet_name: String(sheet),
      p_rows: Math.max(0, Math.round(Number(rows) || 0))
    });
  } catch (eAdd) {
    Logger.log('gas_morning_sheet_add: ' + eAdd);
  }
}

function startMorningChain_(ss) {
  var props = PropertiesService.getScriptProperties();
  var today = mskToday_();
  ss = ss || activeSpreadsheet_();
  clearTriggersByHandler_(DAILY_CHECK_HANDLER_);
  try { refreshDatasetAccessCache_(); } catch (eAcc) {}
  var queue = morningSheetQueue_(ss);
  props.setProperty(DAILY_WATCH_DATE_KEY_, today);
  props.setProperty(MORNING_CHAIN_ON_KEY_, '1');
  props.setProperty(DAILY_MORNING_STARTED_KEY_, today);
  props.setProperty(MORNING_PHASE_KEY_, 'append');
  props.deleteProperty(MORNING_TRIM_INDEX_KEY_);
  initMorningStats_(props);
  if (!queue.length) {
    log_(ss, '', 'автозапуск', 0, 0, 0, 'нет включённых листов', 0);
    morningChainFinish_(ss, props, queue);
    return;
  }
  props.setProperty(MORNING_JOB_KEY_, queue[0]);
  logMorningStep_(ss, 'цепочка', '', queue[0], 'старт', queue.length + ' лист(ов), новый день', 0);
  scheduleMorningWork_(1000);
}

function runMorningChainTick_() {
  clearTriggersByHandler_(MORNING_CHAIN_HANDLER_);
  var props = PropertiesService.getScriptProperties();
  if (!morningChainOn_(props)) return;
  var ss = null;
  try { ss = activeSpreadsheet_(); } catch (eSs) {}
  var job = props.getProperty(MORNING_JOB_KEY_) || '';
  var phase = morningPhase_(props);
  if (job === MORNING_TRIM_JOB_ || phase === 'trim') {
    morningTrimTick_(ss, props);
    return;
  }
  if (job === MORNING_REPORTS_JOB_ || phase === 'reports') {
    morningChainReportsTick_(ss, props);
    return;
  }
  if (!job) {
    morningChainFinish_(ss, props, morningSheetQueue_(ss));
    return;
  }
  scheduleMorningSafety_();
  var remaining = morningRemainingSheets_(ss, props);
  if (!remaining.length) {
    props.setProperty(MORNING_PHASE_KEY_, 'trim');
    props.setProperty(MORNING_JOB_KEY_, MORNING_TRIM_JOB_);
    morningTrimTick_(ss, props);
    return;
  }
  props.setProperty(MORNING_JOB_KEY_, remaining[0]);
  logMorningStep_(ss, 'пачка', '', remaining[0], 'тик', remaining.length + ' лист(ов)', 0);
  try {
    loadSheets_(remaining);
  } catch (eLoad) {
    log_(ss, remaining[0], 'ошибка', 0, 0, 0, limitMsg_(eLoad), 0);
    scheduleMorningWork_(MORNING_GAP_MS_);
    return;
  }
  if (sheetLoadStarted_(props)) scheduleContinue_();
  else if (morningChainOn_(props) && morningPhase_(props) === 'append') {
    scheduleMorningWork_(MORNING_GAP_MS_);
  }
}

function morningChainReportsTick_(ss, props) {
  if (!hasDashboardCode_()) {
    morningChainFinish_(ss, props, morningSheetQueue_(ss));
    return;
  }
  if (dashQueuePending_(props).length) {
    if (!hasHandlerTrigger_(DASH_HANDLER_)) scheduleDashQueue_(5000);
    scheduleMorningWork_(MORNING_GAP_MS_);
    return;
  }
  if (props.getProperty(DAILY_DASH_STARTED_KEY_) !== mskToday_()) {
    props.setProperty(DAILY_DASH_STARTED_KEY_, mskToday_());
    try {
      enqueueMorningDashboardsIncremental_(ss);
      logMorningStep_(ss, 'отчёты', '', '', 'очередь', 'после всех листов', 0);
    } catch (eDash) {
      props.deleteProperty(DAILY_DASH_STARTED_KEY_);
      log_(ss, '', 'ошибка', 0, 0, 0, limitMsg_(eDash), 0);
    }
    scheduleMorningWork_(MORNING_GAP_MS_);
    return;
  }
  morningChainFinish_(ss, props, morningSheetQueue_(ss));
}

function runMorningChainSafety_() {
  clearTriggersByHandler_(MORNING_SAFETY_HANDLER_);
  var props = PropertiesService.getScriptProperties();
  if (!morningChainOn_(props)) return;
  var ss = null;
  try { ss = activeSpreadsheet_(); } catch (eSs) {}
  var job = props.getProperty(MORNING_JOB_KEY_) || '';
  logMorningStep_(ss, 'страховка', '', job, 'тик', morningPhase_(props), 0);
  scheduleMorningSafety_();
  if (job === MORNING_TRIM_JOB_ || morningPhase_(props) === 'trim') {
    morningTrimTick_(ss, props);
    return;
  }
  if (!job || job === MORNING_REPORTS_JOB_) {
    scheduleMorningWork_(1000);
    return;
  }
  try {
    if (props.getProperty(RESUME_KEY) || props.getProperty(LOAD_SESSION_KEY_)) {
      continueLoadFromTrigger_();
    } else {
      var remaining = morningRemainingSheets_(ss, props);
      if (!remaining.length) {
        props.setProperty(MORNING_PHASE_KEY_, 'trim');
        morningTrimTick_(ss, props);
      } else {
        loadSheets_(remaining);
      }
    }
  } catch (eSafe) {
    log_(ss, job, 'ошибка', 0, 0, 0, limitMsg_(eSafe), 0);
    scheduleMorningWork_(MORNING_GAP_MS_);
  }
}

function morningAdvanceAfterSheet_(ss, props, sheetName) {
  props = props || PropertiesService.getScriptProperties();
  if (!morningChainOn_(props)) return;
  if (sheetName) {
    var ds = SHEET_TO_DATASET_[sheetName];
    if (ds) markDailyLoadedDataset_(props, ds);
  }
  var remaining = morningRemainingSheets_(ss, props);
  if (remaining.length) {
    props.setProperty(MORNING_PHASE_KEY_, 'append');
    props.setProperty(MORNING_JOB_KEY_, remaining[0]);
    logMorningStep_(ss, 'цепочка', '', remaining[0], 'далее', remaining.length + ' лист(ов)', 0);
    scheduleMorningWork_(MORNING_GAP_MS_);
    return;
  }
  props.setProperty(MORNING_PHASE_KEY_, 'trim');
  props.setProperty(MORNING_JOB_KEY_, MORNING_TRIM_JOB_);
  logMorningStep_(ss, 'цепочка', '', '', 'подрезка', 'все листы записаны', 0);
  scheduleMorningWork_(MORNING_GAP_MS_);
}

function morningChainFinish_(ss, props, queue) {
  props = props || PropertiesService.getScriptProperties();
  var today = mskToday_();
  clearMorningChainTriggers_();
  clearContinueTriggers_();
  props.setProperty(DAILY_TRIGGERED_KEY_, today);
  props.deleteProperty(MORNING_CHAIN_ON_KEY_);
  props.deleteProperty(MORNING_JOB_KEY_);
  props.deleteProperty(MORNING_PHASE_KEY_);
  props.deleteProperty(MORNING_TRIM_INDEX_KEY_);
  flushMorningTimings_(props);
  props.deleteProperty(MORNING_STATS_KEY_);
  props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
  props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
  queue = queue || [];
  var loaded = getDailyLoadedDatasets_(props);
  var total = queue.length;
  var done = 0;
  var i;
  var ds;
  for (i = 0; i < queue.length; i++) {
    ds = SHEET_TO_DATASET_[queue[i]];
    if (!ds || loaded.indexOf(ds) >= 0) done++;
  }
  var gasOk = total === 0 || done >= total;
  var summary = 'GAS: ' + done + '/' + total;
  log_(ss, '', 'завершено', done, total, 0, summary, 0);
  try {
    dbRpc_('gas_morning_status_upsert', {
      p_book_slug: typeof BOOK_SLUG_ !== 'undefined' ? BOOK_SLUG_ : 'main',
      p_run_date: today,
      p_base_ok: true,
      p_gas_ok: gasOk,
      p_sheets_done: done,
      p_sheets_total: total,
      p_base_bad: [],
      p_gas_bad: [],
      p_summary: summary,
      p_finished: true
    });
  } catch (eUp) {
    Logger.log('gas_morning_status_upsert: ' + eUp);
  }
  try { startSetLoadNotice_(summary); if (ss) refreshStartStatus_(ss); } catch (eN) {}
}

function startDailySheetWatch_() {
  var props = PropertiesService.getScriptProperties();
  var today = mskToday_();
  if (props.getProperty(DAILY_TRIGGERED_KEY_) === today) return;
  if (morningChainOn_(props)) {
    scheduleMorningWork_(1000);
    return;
  }
  clearStaleMorningDayState_(props);
  clearMorningStartBlockers_(props, 'старт цепочки');
  try { refreshDatasetAccessCache_(); } catch (eAcc) {}
  startMorningChain_();
}

function scheduleDailySheetCheck_(afterMs) {
  scheduleMorningWork_(afterMs);
}

function clearStaleMorningSession_(props) {
  props = props || PropertiesService.getScriptProperties();
  var session = readLoadSession_(props);
  var staleMs = 20 * 60 * 1000;
  if (session && session.startedAt && Date.now() - Number(session.startedAt) < staleMs) return;
  if (props.getProperty(RESUME_KEY)) {
    props.deleteProperty(RESUME_KEY);
    try { startSetLoadNotice_('Пауза потеряна — ждём auto или «Загрузить всё»'); } catch (eN) {}
    try {
      var ssN = activeSpreadsheet_();
      if (ssN) refreshStartStatus_(ssN);
    } catch (eR) {}
  }
  if (props.getProperty(LOAD_SESSION_KEY_)) props.deleteProperty(LOAD_SESSION_KEY_);
  clearContinueTriggers_();
}

function morningPendingSheets_(loadsBy, loaded) {
  var order = morningLoadOrder_();
  var out = [];
  var i;
  var ds;
  for (i = 0; i < order.length; i++) {
    ds = order[i];
    if (!morningDatasetNeeded_(ds, loadsBy)) continue;
    if (loaded.indexOf(ds) >= 0) continue;
    out.push(ds);
  }
  return out;
}

function runMorningFinalSummary_(props, ss, loadsPack, loaded, force) {
  var today = mskToday_();
  if (!force && props.getProperty(DAILY_SUMMARY_DONE_KEY_) === today) return;
  var loads = (loadsPack && loadsPack.loads) ? loadsPack.loads : [];
  var loadsBy = loadsByDataset_(loads);
  loaded = loaded || getDailyLoadedDatasets_(props);
  var order = morningLoadOrder_();
  var baseOk = true;
  var gasOk = true;
  var baseBad = [];
  var gasBad = [];
  var needTotal = 0;
  var needLoaded = 0;
  var i;
  var ds;
  var item;
  for (i = 0; i < order.length; i++) {
    ds = order[i];
    if (!morningDatasetNeeded_(ds, loadsBy)) continue;
    needTotal++;
    item = loadsBy[ds];
    if (!item || item.fresh !== true) {
      baseOk = false;
      baseBad.push(ds);
    }
    if (loaded.indexOf(ds) >= 0) needLoaded++;
    else {
      gasOk = false;
      gasBad.push(ds);
    }
  }
  var book = typeof BOOK_SLUG_ !== 'undefined' ? BOOK_SLUG_ : 'main';
  var text = (baseOk ? 'база: ок' : 'база: не ок — ' + baseBad.slice(0, 6).join(', '))
    + ' | '
    + (gasOk ? ('GAS: ' + needLoaded + '/' + needTotal + ' ок') : ('GAS: не ок — ' + gasBad.slice(0, 6).join(', ')));
  log_(ss, '', 'резюме', needLoaded, needTotal, 0, text, 0);
  try { startSetLoadNotice_(text); if (ss) refreshStartStatus_(ss); } catch (eN) {}
  try {
    dbRpc_('gas_morning_status_upsert', {
      p_book_slug: book,
      p_run_date: today,
      p_base_ok: baseOk,
      p_gas_ok: gasOk,
      p_sheets_done: needLoaded,
      p_sheets_total: needTotal,
      p_base_bad: baseBad,
      p_gas_bad: gasBad,
      p_summary: text
    });
  } catch (eUp) {
    Logger.log('gas_morning_status_upsert: ' + eUp);
  }
  props.setProperty(DAILY_SUMMARY_DONE_KEY_, today);
}

function loadSheetsLockMs_(onlyNames) {
  if (!onlyNames || !onlyNames.length) return 5000;
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(DAILY_WATCH_DATE_KEY_) === mskToday_()) return 30000;
  return 5000;
}

function checkDailySheetReady_() {
  runMorningChainTick_();
}

function forceReloadAllFromDb() {
  var props = PropertiesService.getScriptProperties();
  var ui = SpreadsheetApp.getUi();
  if (morningWatchActive_(props)) {
    ui.alert(
      APP_NAME_,
      'Идёт утреннее авто. Полная перезагрузка недоступна — дождитесь 07:00 или завершения утра.',
      ui.ButtonSet.OK
    );
    return;
  }
  if (sheetLoadActive_(props) || props.getProperty(RESUME_KEY)) {
    ui.alert(APP_NAME_, 'Сейчас уже идёт загрузка. Дождитесь завершения.', ui.ButtonSet.OK);
    return;
  }
  var answer = ui.alert(
    APP_NAME_,
    'Очистить все включённые листы и загрузить заново из базы?\n\n'
      + 'Отчёты (info, sku, stock) и ваши справочники не изменятся.\n\n'
      + 'Это необратимо для данных на листах. Продолжить?',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    ui.alert(APP_NAME_, 'Не удалось начать — уже идёт другая загрузка.', ui.ButtonSet.OK);
    return;
  }
  try {
    clearContinueTriggers_();
    props.deleteProperty(RESUME_KEY);
    props.deleteProperty(LOAD_SESSION_KEY_);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  loadSheets_(null, true);
}

function continueLoadFromTrigger_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(RESUME_KEY);
  if (!raw) {
    clearContinueTriggers_();
    if (morningChainOn_(props)) {
      var job = props.getProperty(MORNING_JOB_KEY_) || '';
      if (job === MORNING_TRIM_JOB_ || morningPhase_(props) === 'trim') {
        morningTrimTick_(null, props);
        return;
      }
      if (job && job !== MORNING_REPORTS_JOB_) {
        var remaining = morningRemainingSheets_(null, props);
        loadSheets_(remaining.length ? remaining : [job]);
        return;
      }
      runMorningChainTick_();
    }
    return;
  }
  var session = readLoadSession_(props);
  var only = session && session.onlyNames && session.onlyNames.length ? session.onlyNames : null;
  loadSheets_(only, !!(session && session.forceFull));
}

function stopAutoLoad() {
  clearContinueTriggers_();
  clearTriggersByHandler_(DASH_HANDLER_);
  clearTriggersByHandler_(DAILY_CHECK_HANDLER_);
  clearMorningChainTriggers_();
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('AUTO_LOAD_STOP_DATE');
  props.deleteProperty(RESUME_KEY);
  props.deleteProperty(LOAD_SESSION_KEY_);
  props.deleteProperty(DASH_QUEUE_KEY_);
  props.deleteProperty(DAILY_WATCH_DATE_KEY_);
  props.deleteProperty(DAILY_WATCH_ATTEMPTS_KEY_);
  props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
  props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
  props.deleteProperty(MORNING_CHAIN_ON_KEY_);
  props.deleteProperty(MORNING_JOB_KEY_);
  props.deleteProperty(MORNING_PHASE_KEY_);
  props.deleteProperty(MORNING_TRIM_INDEX_KEY_);
  var reqId = props.getProperty(SHEET_REQ_KEY_);
  if (reqId) {
    try { sheetLoadFinish_(reqId, false, 'остановлено в книге'); } catch (eReq) {}
    props.deleteProperty(SHEET_REQ_KEY_);
  }
  var ss = activeSpreadsheet_();
  log_(ss, '', 'стоп', 0, 0, 0, 'Автозагрузка остановлена', 0);
  hideLogSheet_(ss, true);
  try { SpreadsheetApp.getUi().alert('Автозагрузка остановлена.'); } catch (e) {}
}

function clearContinueTriggers_() {
  var list = ScriptApp.getProjectTriggers();
  for (var i = 0; i < list.length; i++) {
    if (list[i].getHandlerFunction() === CONTINUE_HANDLER_) {
      ScriptApp.deleteTrigger(list[i]);
    }
  }
}

function scheduleContinue_() {
  clearContinueTriggers_();
  ScriptApp.newTrigger(CONTINUE_HANDLER_).timeBased().after(CONTINUE_AFTER_MS_).create();
}

function readLoadSession_(props) {
  try { return JSON.parse(props.getProperty(LOAD_SESSION_KEY_) || 'null'); } catch (e) { return null; }
}

function beginLoadSession_(props, hasResume, onlyNames, forceFull) {
  if (hasResume) {
    var cur = readLoadSession_(props);
    if (cur && cur.startedAt) {
      if (onlyNames && onlyNames.length && !cur.onlyNames) {
        cur.onlyNames = onlyNames;
      }
      if (forceFull) cur.forceFull = true;
      if (!cur.requestId) cur.requestId = props.getProperty(SHEET_REQ_KEY_) || null;
      props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(cur));
      return cur;
    }
  }
  var session = {
    startedAt: Date.now(),
    pauses: 0,
    onlyNames: onlyNames && onlyNames.length ? onlyNames : null,
    forceFull: !!forceFull,
    morningBatch: props.getProperty(MORNING_LOAD_ACTIVE_KEY_) === '1',
    overlayRanges: {},
    requestId: props.getProperty(SHEET_REQ_KEY_) || null
  };
  props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(session));
  return session;
}

function overBudget_(started, reserveMs) {
  return Date.now() - started > TIME_BUDGET_MS - (Number(reserveMs) || 0);
}

/** Сохранить место в лимите GAS: пауза с resume вместо тихого обрыва на тяжёлой подготовке листа. */
function pauseLoadJob_(ss, job, sh, keys, started, opt) {
  opt = opt || {};
  var delMs = Number(opt.delMs) || 0;
  var deleted = Number(opt.deleted) || 0;
  var fetchMs = Number(opt.fetchMs) || 0;
  var writeMs = Number(opt.writeMs) || 0;
  var rowsWritten = Number(opt.rowsWritten) || 0;
  var pages = Number(opt.pages) || 0;
  var offset = Number(opt.offset) || 0;
  if (delMs || fetchMs || writeMs) {
    logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, 0, rowsWritten, pages, offset);
  }
  return jobResume_(
    job, sh, keys, offset, pages, rowsWritten,
    opt.minIso || '', opt.maxIso || '',
    !!opt.inc, opt.refreshFrom || '', opt.fetchFrom || '',
    deleted, opt.error || '',
    opt.extra || { phase: 'fetch' }
  );
}

function overlayEnabled_() {
  return typeof applyClientOverlayImpl_ === 'function' || typeof applyClientOverlay_ === 'function';
}

/** Сбросить зависший resume overlay (копия DMZ-книги без файла 02). */
function clearStaleLoadResume_(props) {
  props = props || PropertiesService.getScriptProperties();
  try {
    var resume = JSON.parse(props.getProperty(RESUME_KEY) || 'null');
    if (resume && resume.phase === 'overlay' && !overlayEnabled_()) {
      props.deleteProperty(RESUME_KEY);
      purgeAllOverlayRangesInSession_();
    }
  } catch (e) {}
}

function overlayReserveMs_() {
  if (morningAppendFirst_()) return 0;
  return overlayEnabled_() ? OVERLAY_RESERVE_MS_ : 0;
}

/** Оверлей (вес/регион) — только если в проекте подключён файл 02. */
function sheetUsesOverlay_(sheetName) {
  if (!overlayEnabled_()) return false;
  var name = String(sheetName || '').trim();
  if (!name) return false;
  if (name === 'Рекламные расходы') return true;
  if (typeof clientOverlayInputs_ === 'function') {
    var inputs = clientOverlayInputs_(name);
    if (inputs && inputs.length) return true;
  }
  return false;
}

function overlaySheetNames_(jobs, onlyNames) {
  var out = [];
  var seen = {};
  if (onlyNames && onlyNames.length) {
    for (var i = 0; i < onlyNames.length; i++) {
      var n = onlyNames[i];
      if (!sheetUsesOverlay_(n) || seen[n]) continue;
      seen[n] = 1;
      out.push(n);
    }
    return out;
  }
  for (var j = 0; j < jobs.length; j++) {
    var s = jobs[j].sheet;
    if (!sheetUsesOverlay_(s) || seen[s]) continue;
    seen[s] = 1;
    out.push(s);
  }
  return out;
}

function overlaySheetsForLoad_(jobs, onlyNames) {
  if (!overlayEnabled_()) return [];
  var out = overlaySheetNames_(jobs, onlyNames);
  var seen = {};
  var i;
  for (i = 0; i < out.length; i++) seen[out[i]] = 1;
  var pending = overlayRangesPendingSheets_(readOverlayRanges_());
  for (i = 0; i < pending.length; i++) {
    if (!seen[pending[i]]) {
      seen[pending[i]] = 1;
      out.push(pending[i]);
    }
  }
  return out;
}

function hasHandlerTrigger_(handler) {
  var list = ScriptApp.getProjectTriggers();
  for (var i = 0; i < list.length; i++) {
    if (list[i].getHandlerFunction() === handler) return true;
  }
  return false;
}

function finishLoadSheets_(ss, props, jobs, overlayNote) {
  props.deleteProperty(RESUME_KEY);
  try { refreshAllPeriodLabels_(ss, jobs); } catch (eP) {}
  try {
    var session = readLoadSession_(props);
    ensureJobsFilters_(ss, jobs, session && session.onlyNames);
  } catch (eFlt) {}
  finishLoadSession_(ss, props, overlayNote || '');
}

function bumpLoadPause_(props) {
  var cur = readLoadSession_(props) || { startedAt: Date.now(), pauses: 0 };
  cur.pauses = (Number(cur.pauses) || 0) + 1;
  props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(cur));
}

function finishLoadSession_(ss, props, overlayNote) {
  var session = readLoadSession_(props);
  var totalMs = session && session.startedAt ? Date.now() - Number(session.startedAt) : 0;
  var note = 'выгрузка завершена';
  if (overlayNote) note += '; ' + overlayNote;
  log_(ss, '', 'завершено', 0, 0, 0, note, totalMs);
  hideLogSheet_(ss, true);
  var reqId = (session && session.requestId) || props.getProperty(SHEET_REQ_KEY_);
  if (reqId) {
    try { sheetLoadFinish_(reqId, true, overlayNote || ''); } catch (eReq) {}
    try { props.deleteProperty(SHEET_REQ_KEY_); } catch (eReq2) {}
  }
  var morningWatch = morningWatchActive_(props);
  var sessionSheet = session && session.onlyNames && session.onlyNames[0] ? session.onlyNames[0] : '';
  var morningRows = session && session.morningWritten ? Number(session.morningWritten) : 0;
  var batchDone = [];
  if (morningWatch && session && session.morningBatch) {
    batchDone = markMorningBatchLoaded_(props);
    if (batchDone.length) {
      logMorningStep_(ss, 'batch', batchDone.join('+'), '', 'готово', 'отмечено в утре', totalMs);
    }
  }
  props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
  props.deleteProperty(LOAD_SESSION_KEY_);
  if (morningChainOn_(props)) {
    morningAdvanceAfterSheet_(ss, props, sessionSheet);
  } else {
    try {
      var loadsPack = fetchReportInfoLoads_();
      var loads = (loadsPack && loadsPack.loads) ? loadsPack.loads : [];
      maybeEnqueueReportsWhenFinanceReady_(ss, props, loadsByDataset_(loads));
    } catch (eRep) {}
  }
  try { syncLogDurationsToDb_(0); } catch (eDur) { Logger.log('syncLogDurationsToDb_: ' + eDur); }
  try { refreshStartStatus_(ss); } catch (eStart) {}
  try { startClearLoadNotice_(); } catch (eClr) {}
}

function dashQueuePending_(props) {
  props = props || PropertiesService.getScriptProperties();
  try {
    var q = JSON.parse(props.getProperty(DASH_QUEUE_KEY_) || '[]');
    return q && q.length ? q : [];
  } catch (e) { return []; }
}

function sheetLoadActive_(props) {
  props = props || PropertiesService.getScriptProperties();
  return !!(props.getProperty(LOAD_SESSION_KEY_) || props.getProperty(RESUME_KEY));
}

function hasDashboardCode_() {
  return typeof infoWriteDashboard_ === 'function' || typeof runOpsDashboardSilent_ === 'function';
}

function enqueueMorningDashboards_(ss) {
  var q = ['info:daily', 'info:monthly'];
  if (ss && (ss.getSheetByName('stock') || ss.getSheetByName('остатки'))) q.push('ops');
  var monday = typeof infoIsMondayMsk_ === 'function'
    ? infoIsMondayMsk_()
    : Utilities.formatDate(new Date(), TZ, 'u') === '1';
  if (monday) q.push('info:weekly');
  var props = PropertiesService.getScriptProperties();
  props.setProperty(DASH_QUEUE_KEY_, JSON.stringify(q));
  props.setProperty(DAILY_LOAD_AFTER_DASH_KEY_, mskToday_());
  scheduleDashQueue_(DASH_AFTER_MS_);
  log_(ss, '', 'отчёты', 0, 0, 0, 'сначала отчёты, потом листы: ' + q.join(', '), 0);
}

/** Утро main: info-отчёты по готовности финансов/рекламы, листы — по мере готовности блоков. */
function enqueueMorningDashboardsIncremental_(ss) {
  var q = ['info:daily', 'info:monthly'];
  if (ss && (ss.getSheetByName('stock') || ss.getSheetByName('остатки'))) q.push('ops');
  var monday = typeof infoIsMondayMsk_ === 'function'
    ? infoIsMondayMsk_()
    : Utilities.formatDate(new Date(), TZ, 'u') === '1';
  if (monday) q.push('info:weekly');
  var props = PropertiesService.getScriptProperties();
  props.setProperty(DASH_QUEUE_KEY_, JSON.stringify(q));
  scheduleDashQueue_(DASH_AFTER_MS_);
  log_(ss, '', 'отчёты', 0, 0, 0, 'info по готовности финансов/рекламы: ' + q.join(', '), 0);
}

function scheduleDashQueue_(afterMs) {
  clearTriggersByHandler_(DASH_HANDLER_);
  ScriptApp.newTrigger(DASH_HANDLER_).timeBased().after(Math.max(5000, Number(afterMs) || DASH_AFTER_MS_)).create();
}

function runQueuedDashboards_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    scheduleDashQueue_(30000);
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  var startSheets = false;
  try {
    var q = [];
    try { q = JSON.parse(props.getProperty(DASH_QUEUE_KEY_) || '[]'); } catch (eParse) { q = []; }
    if (!q.length) {
      clearTriggersByHandler_(DASH_HANDLER_);
      props.deleteProperty(DASH_QUEUE_KEY_);
      return;
    }
    ss = activeSpreadsheet_();
    var job = String(q.shift() || '');
    var t0 = Date.now();
    try {
      if (job === 'info:weekly' && typeof infoWriteDashboard_ === 'function') {
        var weekEnd = typeof infoDefaultWeekEndIso_ === 'function' ? infoDefaultWeekEndIso_() : '';
        infoWriteDashboard_(ss, 'weekly', weekEnd);
        log_(ss, 'info weekly', 'отчёт', 0, 0, 0, weekEnd ? ('утренний ' + weekEnd) : 'утренний', Date.now() - t0);
      } else if (job.indexOf('info:') === 0 && typeof infoWriteDashboard_ === 'function') {
        infoWriteDashboard_(ss, job.slice(5));
        log_(ss, 'info ' + job.slice(5), 'отчёт', 0, 0, 0, 'утренний', Date.now() - t0);
      } else if (job === 'ops' && typeof runOpsDashboardSilent_ === 'function') {
        runOpsDashboardSilent_(ss);
        log_(ss, 'stock', 'отчёт', 0, 0, 0, 'stock', Date.now() - t0);
      }
    } catch (err) {
      log_(ss, job, 'ошибка', 0, 0, 0, String(err && err.message ? err.message : err).substring(0, 180), Date.now() - t0);
    }
    if (q.length) {
      props.setProperty(DASH_QUEUE_KEY_, JSON.stringify(q));
      scheduleDashQueue_(DASH_AFTER_MS_);
    } else {
      props.deleteProperty(DASH_QUEUE_KEY_);
      clearTriggersByHandler_(DASH_HANDLER_);
      if (props.getProperty(DAILY_LOAD_AFTER_DASH_KEY_) === mskToday_()) {
        props.deleteProperty(DAILY_LOAD_AFTER_DASH_KEY_);
        startSheets = true;
      } else if (morningChainOn_(props)) {
        scheduleMorningWork_(MORNING_GAP_MS_);
      }
    }
  } finally {
    try { lock.releaseLock(); } catch (eLock) {}
  }
  if (startSheets) {
    var sheetProps = PropertiesService.getScriptProperties();
    if (sheetLoadActive_(sheetProps)) {
      log_(ss, '', 'листы', 0, 0, 0, 'отчёты готовы, листы уже грузятся', 0);
      return;
    }
    log_(ss, '', 'листы', 0, 0, 0, 'отчёты готовы, грузим листы', 0);
    loadSheets_(null);
  }
}

function loadSheets_(onlyNames, forceFull) {
  var lock = LockService.getScriptLock();
    if (!lock.tryLock(loadSheetsLockMs_(onlyNames))) {
    var busy = null;
    try { busy = activeSpreadsheet_(); } catch (eBusy) {}
    log_(busy, '', 'занято', 0, 0, 0, 'Уже идёт загрузка — этот запуск пропущен', 0);
    return;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty('AUTO_LOAD_STOP_DATE');
    var earlyResume = null;
    try { earlyResume = JSON.parse(props.getProperty(RESUME_KEY) || 'null'); } catch (eEr) { earlyResume = null; }
    if (!onlyNames && !earlyResume && !props.getProperty(LOAD_SESSION_KEY_)) {
      var dq = dashQueuePending_(props);
      if (dq.length) {
        var waitSs = activeSpreadsheet_();
        log_(waitSs, '', 'ожидание', 0, 0, 0, 'сначала отчёты: ' + dq.join(', '), 0);
        try { waitSs.toast('Сначала отчёты — листы после', APP_NAME_, 10); } catch (eW) {}
        return;
      }
    }
    clearContinueTriggers_();
    var started = Date.now();
    var ss = activeSpreadsheet_();
    try {
      if (ss.getSpreadsheetTimeZone() !== TZ) ss.setSpreadsheetTimeZone(TZ);
    } catch (eTz) {}
    clearStaleLoadResume_(props);
    setupConfigSheets_();
    var settings = readSettings_(ss);
    var accessMap = accessMapForUse_();
    var want = {};
    if (onlyNames) {
      for (var i = 0; i < onlyNames.length; i++) want[onlyNames[i]] = true;
    }
    var jobs = [];
    for (var s = 0; s < settings.length; s++) {
      if (!sheetIncludedInLoad_(settings[s], accessMap)) continue;
      if (!isSheetAccessAllowed_(settings[s].sheet, accessMap)) continue;
      if (isManualSheet_(settings[s].sheet)) continue;
      if (onlyNames && !want[settings[s].sheet]) continue;
      jobs.push(settings[s]);
    }
    if (!jobs.length) {
      var morningWatch = props.getProperty(DAILY_WATCH_DATE_KEY_) === mskToday_();
      var batchRaw = props.getProperty(MORNING_BATCH_DATASETS_KEY_);
      var note = morningWatch && batchRaw
        ? 'утро: нет листов для ' + batchRaw + ' (доступ или настройки)'
        : 'Нет включённых листов';
      log_(ss, '', 'нет дел', 0, 0, 0, note, Date.now() - started);
      if (morningChainOn_(props)) {
        var emptySheet = onlyNames && onlyNames[0] ? onlyNames[0] : '';
        morningAdvanceAfterSheet_(ss, props, emptySheet);
      } else if (morningWatch && batchRaw) {
        logMorningStep_(ss, 'batch', batchRaw, '', 'ошибка', note, Date.now() - started);
        props.deleteProperty(MORNING_BATCH_DATASETS_KEY_);
        props.deleteProperty(MORNING_LOAD_ACTIVE_KEY_);
        scheduleDailySheetCheck_(DAILY_CHECK_BUSY_MS_);
      }
      return;
    }

    var resume = null;
    try { resume = JSON.parse(props.getProperty(RESUME_KEY) || 'null'); } catch (e) { resume = null; }
    if (resume && resume.phase === 'overlay' && !overlayEnabled_()) {
      props.deleteProperty(RESUME_KEY);
      resume = null;
    }

    var previousSession = readLoadSession_(props);
    if (previousSession && previousSession.forceFull) forceFull = true;
    var startAt = 0;
    var overlayOnly = !!(resume && resume.phase === 'overlay');
    if (overlayOnly) {
      startAt = jobs.length;
    } else if (resume && resume.sheet) {
      var resumeOk = !onlyNames;
      if (onlyNames) {
        for (var oi = 0; oi < onlyNames.length; oi++) {
          if (onlyNames[oi] === resume.sheet) { resumeOk = true; break; }
        }
      }
      if (resumeOk) {
        for (var j = 0; j < jobs.length; j++) {
          if (jobs[j].sheet === resume.sheet) { startAt = j; break; }
        }
      } else {
        resume = null;
        props.deleteProperty(RESUME_KEY);
      }
    } else {
      resume = null;
      props.deleteProperty(RESUME_KEY);
    }
    beginLoadSession_(props, !!(resume && (resume.sheet || resume.phase)), onlyNames, forceFull);

    var sellerCache = {};
    if (!overlayOnly) {
      for (var n = startAt; n < jobs.length; n++) {
        var job = jobs[n];
        if (n > startAt && overBudget_(started, overlayReserveMs_())) {
          var prepSh = ss.getSheetByName(job.sheet);
          if (!prepSh) prepSh = ss.insertSheet(job.sheet);
          var prepKeys = selectedKeys_(job, readColumnMap_(ss, job.sheet));
          bumpLoadPause_(props);
          props.setProperty(RESUME_KEY, JSON.stringify(
            pauseLoadJob_(ss, job, prepSh, prepKeys, started, { extra: { phase: 'prep' } })
          ));
          scheduleContinue_();
          log_(ss, job.sheet, 'продолжает', 0, 0, 0, 'следующий лист — загрузка продолжит сама', Date.now() - started);
          try { ss.toast('Загрузка продолжается', APP_NAME_, 10); } catch (ePause) {}
          return;
        }
        if (!sellerCache[job.slug]) sellerCache[job.slug] = resolveSellerId_(job.slug);
        var state = (resume && resume.sheet === job.sheet) ? resume : null;
        resume = null;
        var left = null;
        var tJob = Date.now();
        try {
          left = loadOneJob_(ss, job, sellerCache[job.slug], state, started, forceFull);
        } catch (loadErr) {
          left = {
            sheet: job.sheet,
            offset: state && state.offset ? state.offset : 0,
            pages: state && state.pages ? state.pages : 0,
            rowsWritten: state && state.rowsWritten ? state.rowsWritten : 0,
            keys: state && state.keys ? state.keys : selectedKeys_(job, readColumnMap_(ss, job.sheet)),
            inc: !!(state && state.inc),
            refreshFrom: state && state.refreshFrom ? state.refreshFrom : '',
            fetchFrom: state && state.fetchFrom ? state.fetchFrom : '',
            deleted: state && state.deleted ? state.deleted : 0,
            minIso: state && state.minIso ? state.minIso : '',
            maxIso: state && state.maxIso ? state.maxIso : '',
            phase: state && state.phase ? state.phase : 'fetch',
            wiped: !!(state && state.wiped),
            deduped: !!(state && state.deduped),
            sorted: !!(state && state.sorted),
            overlayFrom: state && state.overlayFrom ? state.overlayFrom : 0,
            rowsY: state && state.rowsY ? state.rowsY : 0,
            rowsO: state && state.rowsO ? state.rowsO : 0,
            sheetStartedAt: state && state.sheetStartedAt ? state.sheetStartedAt : Date.now(),
            error: limitMsg_(loadErr)
          };
        }
        morningAddPhaseMs_('work', Date.now() - tJob);
        if (left) {
          bumpLoadPause_(props);
          props.setProperty(RESUME_KEY, JSON.stringify(left));
          scheduleContinue_();
          try { writeSettingsMeta_(ss, job.sheet, left.period || livePeriod_(ss.getSheetByName(job.sheet), job, left.keys), nowMsk_()); } catch (eMeta) {}
          var pauseNote = left.error
            ? (left.error + ' — загрузка продолжит сама')
            : 'загрузка продолжается';
          log_(ss, job.sheet, 'продолжает', left.rowsWritten || 0, left.pages || 0, left.offset, pauseNote, Date.now() - started);
          try { ss.toast('Загрузка продолжается', APP_NAME_, 10); } catch (e) {}
          return;
        }
      }
    }

    if (!overlayEnabled_()) {
      purgeAllOverlayRangesInSession_();
      finishLoadSheets_(ss, props, jobs, '');
      return;
    }

    var overlaySheets = overlaySheetsForLoad_(jobs, onlyNames);
    if (overlayOnly && resume && resume.overlaySheets && resume.overlaySheets.length) {
      var pending = {};
      for (var oi = 0; oi < resume.overlaySheets.length; oi++) pending[resume.overlaySheets[oi]] = 1;
      overlaySheets = overlaySheets.filter(function (n) { return pending[n]; });
    }

    if (overlayOnly && (!overlaySheets || !overlaySheets.length)) {
      overlaySheets = overlayRangesPendingSheets_(readOverlayRanges_());
      if (!overlaySheets.length) {
        finishLoadSheets_(ss, props, jobs, '');
        return;
      }
    }

    var overlayState = {
      phase: 'overlay',
      sheet: jobs.length ? jobs[jobs.length - 1].sheet : '',
      overlaySheets: overlaySheets,
      overlayRanges: readOverlayRanges_() || {}
    };
    if (!overlayOnly) {
      if (!overlaySheets || !overlaySheets.length) {
        finishLoadSheets_(ss, props, jobs, '');
        return;
      }
      bumpLoadPause_(props);
      props.setProperty(RESUME_KEY, JSON.stringify(overlayState));
      scheduleContinue_();
      log_(ss, 'overlay', 'продолжает', 0, 0, 0, 'overlay со следующего запуска', Date.now() - started);
      try { ss.toast('Данные записаны. Через 20 секунд подставлю вес и регион.', APP_NAME_, 15); } catch (e2) {}
      return;
    }

    var overlayLeft = null;
    var overlayNote = '';
    var tOverlay = Date.now();
    try {
      overlayLeft = maybeApplyClientOverlay_(overlaySheets, started);
    } catch (ovErr) {
      overlayNote = 'overlay: ' + limitMsg_(ovErr);
      log_(ss, 'overlay', 'ошибка', 0, 0, 0, overlayNote, Date.now() - started);
    }
    morningAddPhaseMs_('overlay', Date.now() - tOverlay);
    if (!overlayLeft || !overlayLeft.length) {
      var rangeLeft = overlayRangesPendingSheets_(readOverlayRanges_());
      if (rangeLeft.length) overlayLeft = rangeLeft;
    }
    if (overlayLeft && overlayLeft.length) {
      bumpLoadPause_(props);
      overlayState.overlaySheets = overlayLeft;
      overlayState.overlayRanges = readOverlayRanges_() || overlayState.overlayRanges || {};
      props.setProperty(RESUME_KEY, JSON.stringify(overlayState));
      scheduleContinue_();
      log_(ss, 'overlay', 'продолжает', 0, 0, 0,
        'осталось листов: ' + overlayLeft.length + (overlayLeft.length ? ' (' + overlayLeft.join(', ') + ')' : ''),
        Date.now() - started);
      try { ss.toast('Загрузка продолжается', APP_NAME_, 10); } catch (e3) {}
      return;
    }

    props.deleteProperty(RESUME_KEY);
    try { refreshAllPeriodLabels_(ss, jobs); } catch (eP) {}
    finishLoadSession_(ss, props, overlayNote);
  } finally {
    try { rehideDataSheetsIfWanted_(typeof ss !== 'undefined' ? ss : activeSpreadsheet_()); } catch (eHid) {}
    try { lock.releaseLock(); } catch (e) {}
  }
}

function maybeApplyClientOverlay_(onlySheets, started) {
  if (typeof applyClientOverlayImpl_ === 'function') {
    return applyClientOverlayImpl_(false, onlySheets, started, readOverlayRanges_());
  }
  if (typeof applyClientOverlay_ === 'function') applyClientOverlay_(false);
  return null;
}

function dbErrorText_(code, text) {
  var raw = String(text || '').substring(0, 400);
  var low = raw.toLowerCase();
  if (code === 429 || /limit|quota|too many|rate/i.test(low) || /лимит/i.test(raw)) {
    return 'Превышен лимит запроса к базе (HTTP ' + code + '). Продолжим со следующей страницы.';
  }
  return 'БД HTTP ' + code + ' ' + raw;
}

function limitMsg_(err) {
  var s = String(err && err.message ? err.message : err || '');
  if (/limit|quota|exceeded|too many|rate|maximum execution|максимальн/i.test(s) || /лимит/i.test(s)) {
    return 'Превышен лимит сервиса. Загрузка не оборвана — продолжит сама.';
  }
  return s.substring(0, 180);
}

function incPolicy_(job) {
  if (!job.dateCol || isAllDays_(job.days)) return 'replace';
  if (job.dateCol === 'snapshot_date') return 'snapshot';
  return 'window';
}

function incDirtyDays_(job) {
  if (incPolicy_(job) === 'snapshot') return 0;
  var name = job && job.sheet ? String(job.sheet) : '';
  if (name === 'Заказы FBW' || name === 'Заказы FBS') return 3;
  if (name === 'Поставки FBW' || name === 'Поставки FBS') return 3;
  return 1;
}

function incRefreshFrom_(job) {
  if (incPolicy_(job) === 'snapshot') return mskToday_();
  return dateFromDays_(incDirtyDays_(job));
}

function incFetchFrom_(job) {
  return incRefreshFrom_(job);
}

/** Лист уже покрывает окно дней и свежий до вчера — не тянем из базы снова. */
function sheetLoadUpToDate_(sh, job, colInfo, selected) {
  if (!sh || sh.getLastRow() < 2) return false;
  if (!job.dateCol || isAllDays_(job.days)) return false;
  var statusSheet = job.sheet === 'Заказы FBW' || job.sheet === 'Заказы FBS'
    || job.sheet === 'Поставки FBW' || job.sheet === 'Поставки FBS';
  if (statusSheet) {
    try { return settingsUpdatedToday_(sh.getParent(), job.sheet); } catch (eUp) { return false; }
  }
  if (incPolicy_(job) === 'replace') return false;
  if (!sheetLayoutMatches_(sh, job, colInfo, selected)) return false;
  var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var dateIdx = findDateColIndex_(headers0, job, colInfo);
  if (!dateIdx) return false;
  var keyDateIdx = findDateColIndexFromKeys_(selected, job);
  if (keyDateIdx) dateIdx = keyDateIdx;
  var kept = sheetDateBounds_(sh, dateIdx);
  if (!kept.max) return false;
  var cutoff = dateFromDays_(job.days);
  var wantMax = incRefreshFrom_(job);
  if (kept.max < wantMax) return false;
  if (cutoff && kept.min && kept.min > cutoff) return false;
  var gapFrom = isoAddDays_(kept.max, 1);
  if (gapFrom && gapFrom <= wantMax) return false;
  return true;
}

function isoAddDays_(iso, days) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  var p = iso.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function rememberOverlayRange_(sheetName, from, n) {
  if (!sheetName || !from || n < 1) return;
  var props = PropertiesService.getScriptProperties();
  var cur = readLoadSession_(props);
  if (!cur) cur = { startedAt: Date.now(), pauses: 0 };
  if (!cur.overlayRanges) cur.overlayRanges = {};
  var prev = cur.overlayRanges[sheetName];
  if (prev && prev.from) {
    var a = Math.min(prev.from, from);
    var b = Math.max(prev.from + prev.n - 1, from + n - 1);
    cur.overlayRanges[sheetName] = { from: a, n: b - a + 1 };
  } else {
    cur.overlayRanges[sheetName] = { from: from, n: n };
  }
  props.setProperty(LOAD_SESSION_KEY_, JSON.stringify(cur));
  syncOverlayRangesToResume_(props, cur.overlayRanges);
}

function readOverlayRanges_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var cur = readLoadSession_(props);
    if (cur && cur.overlayRanges) return cur.overlayRanges;
    var resume = JSON.parse(props.getProperty(RESUME_KEY) || 'null');
    if (resume && resume.overlayRanges) return resume.overlayRanges;
    return null;
  } catch (e) {
    return null;
  }
}

function syncOverlayRangesToResume_(props, ranges) {
  if (!ranges) return;
  props = props || PropertiesService.getScriptProperties();
  var resume = null;
  try { resume = JSON.parse(props.getProperty(RESUME_KEY) || 'null'); } catch (eR) { resume = null; }
  if (!resume || resume.phase !== 'overlay') return;
  resume.overlayRanges = ranges;
  props.setProperty(RESUME_KEY, JSON.stringify(resume));
}

var INC_PATCH_FIELDS_ = {
  'Рекламные расходы': ['name']
};

function productTitleMapFromSheet_(ss) {
  if (typeof ovLoadNmTitleMap_ === 'function') return ovLoadNmTitleMap_(ss);
  var map = {};
  var sh = ss && ss.getSheetByName('Товары');
  if (!sh || sh.getLastRow() < 2) return map;
  var data = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var headers = data[0];
  var nmCol = -1;
  var titleCol = -1;
  var h;
  for (h = 0; h < headers.length; h++) {
    var label = String(headers[h] || '').trim().toLowerCase();
    if (nmCol < 0 && (label === 'артикул wb' || label === 'nm_id' || label === 'nmid')) nmCol = h;
    if (titleCol < 0 && (label === 'название' || label === 'title' || label === 'наименование')) titleCol = h;
  }
  if (nmCol < 0) nmCol = 0;
  if (titleCol < 0) return map;
  for (h = 1; h < data.length; h++) {
    var nm = String(data[h][nmCol] || '').trim();
    var title = String(data[h][titleCol] || '').trim();
    if (!nm || !title) continue;
    map[nm] = title;
  }
  return map;
}

function enrichAdsRowName_(ss, row) {
  if (!row) return;
  if (row.name != null && String(row.name).trim() !== '') return;
  var nm = String(row.nm_id || '').trim();
  if (!nm || !ss) return;
  var titles = productTitleMapFromSheet_(ss);
  if (titles[nm]) row.name = titles[nm];
}

function adsSheetNameColumns_(sh, keys) {
  var nmIdx = -1;
  var nameIdx = -1;
  if (keys && keys.length) {
    nmIdx = incKeyIndex_(keys, 'nm_id');
    nameIdx = incKeyIndex_(keys, 'name');
  }
  var lastCol = sh ? sh.getLastColumn() : 0;
  var headers = lastCol >= 1 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var h;
  for (h = 0; h < headers.length; h++) {
    var label = String(headers[h] || '').trim().toLowerCase();
    if (nmIdx < 0 && (label === 'артикул wb' || label === 'nm_id' || label === 'nmid')) nmIdx = h;
    if (nameIdx < 0 && (label === 'название' || label === 'name' || label === 'наименование')) nameIdx = h;
  }
  return {
    nmIdx: nmIdx,
    nameIdx: nameIdx,
    width: Math.max(lastCol, nmIdx + 1, nameIdx + 1)
  };
}

function syncAdsNamesFromProducts_(ss, sh, keys) {
  if (!ss || !sh || sh.getLastRow() < 2) return 0;
  var cols = adsSheetNameColumns_(sh, keys);
  if (cols.nmIdx < 0 || cols.nameIdx < 0) return 0;
  var titles = productTitleMapFromSheet_(ss);
  if (!titles || !Object.keys(titles).length) return 0;
  var n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  var data = sh.getRange(2, 1, n, cols.width).getValues();
  var nFilled = 0;
  var i;
  for (i = 0; i < data.length; i++) {
    if (data[i][cols.nameIdx] != null && String(data[i][cols.nameIdx]).trim() !== '') continue;
    var nm = String(data[i][cols.nmIdx] || '').trim();
    if (!nm || !titles[nm]) continue;
    data[i][cols.nameIdx] = titles[nm];
    nFilled++;
  }
  if (nFilled) sh.getRange(2, 1, n, cols.width).setValues(data);
  return nFilled;
}

function refreshAdsNamesAfterProducts_(ss) {
  if (!ss) return 0;
  var adsSh = ss.getSheetByName('Рекламные расходы');
  if (!adsSh || adsSh.getLastRow() < 2) return 0;
  var adsDef = defaultSheetByName_('Рекламные расходы');
  if (!adsDef) return 0;
  var adsCol = readColumnMap_(ss, 'Рекламные расходы');
  var adsKeys = selectedKeys_(adsDef, adsCol);
  return syncAdsNamesFromProducts_(ss, adsSh, adsKeys);
}

function ensureSheetFilter_(sh, sheetName) {
  if (!sh || sh.getLastRow() < 2) return;
  if (sheetName === 'Рекламные расходы' && typeof ovEnsureFullFilter_ === 'function') {
    ovEnsureFullFilter_(sh);
    return;
  }
  applyFilter_(sh);
}

function ensureJobsFilters_(ss, jobs, onlyNames) {
  if (!ss || !jobs || !jobs.length) return;
  var want = null;
  if (onlyNames && onlyNames.length) {
    want = {};
    for (var w = 0; w < onlyNames.length; w++) want[onlyNames[w]] = 1;
  }
  var seen = {};
  var i;
  for (i = 0; i < jobs.length; i++) {
    var name = jobs[i].sheet;
    if (!name || seen[name]) continue;
    if (want && !want[name]) continue;
    seen[name] = 1;
    var sh = ss.getSheetByName(name);
    if (!sh) continue;
    ensureSheetFilter_(sh, name);
  }
}

function incSheetMinIso_(sh, dateColIdx) {
  return sheetDateBounds_(sh, dateColIdx).min;
}

function sheetDateIsoAt_(sh, row, dateColIdx) {
  if (!sh || row < 1 || dateColIdx < 1) return '';
  return sheetCellToIso_(sh.getRange(row, dateColIdx).getDisplayValue());
}

function sheetDateBounds_(sh, dateColIdx) {
  var out = { min: '', max: '' };
  var last = sh ? sh.getLastRow() : 0;
  var n = last - 1;
  if (n < 1 || dateColIdx < 1) return out;

  if (n <= SHEET_DATE_BOUNDS_FULL_SCAN_MAX_) {
    var col = sh.getRange(2, dateColIdx, n, 1).getDisplayValues();
    for (var i = 0; i < col.length; i++) {
      var iso = sheetCellToIso_(col[i][0]);
      if (!iso) continue;
      if (!out.min || iso < out.min) out.min = iso;
      if (!out.max || iso > out.max) out.max = iso;
    }
    return out;
  }

  var first = sheetDateIsoAt_(sh, 2, dateColIdx);
  var end = sheetDateIsoAt_(sh, last, dateColIdx);
  if (first && end) {
    out.min = first < end ? first : end;
    out.max = first < end ? end : first;
  } else if (first) {
    out.min = out.max = first;
  } else if (end) {
    out.min = out.max = end;
  }
  return out;
}

function jobDateColAliases_(job) {
  var col = job && job.dateCol ? String(job.dateCol) : '';
  if (col === 'supply_dt') return ['supply_dt', 'supply_date', 'create_date'];
  return col ? [col] : [];
}

function findDateColIndexFromKeys_(keys, job) {
  if (!job || !keys) return 0;
  var aliases = jobDateColAliases_(job);
  var a;
  var i;
  for (a = 0; a < aliases.length; a++) {
    for (i = 0; i < keys.length; i++) {
      if (keys[i] === aliases[a]) return i + 1;
    }
  }
  return 0;
}

function livePeriod_(sh, job, keys) {
  if (!job) return '';
  var idx = findDateColIndexFromKeys_(keys, job);
  if (!idx && sh && sh.getLastColumn() >= 1) {
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    idx = findDateColIndex_(headers, job, { map: {} });
  }
  var b = idx ? sheetDateBounds_(sh, idx) : { min: '', max: '' };
  return periodLabel_(job, b.min, b.max);
}

function refreshAllPeriodLabels_(ss, jobs) {
  if (!ss) return;
  if (!jobs || !jobs.length) {
    try { jobs = readSettings_(ss) || []; } catch (e) { jobs = []; }
  }
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (!job || !job.sheet) continue;
    if (isManualSheet_(job.sheet)) continue;
    var sh = ss.getSheetByName(job.sheet);
    if (!sh) continue;
    var colInfo = readColumnMap_(ss, job.sheet);
    var keys = headerKeysFromSheet_(sh, job, colInfo, selectedKeys_(job, colInfo));
    var period = livePeriod_(sh, job, keys);
    if (!period) continue;
    writeSettingsPeriod_(ss, job.sheet, period);
  }
}

function writeSettingsPeriod_(ss, sheetName, period) {
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var want = String(sheetName || '').trim().toLowerCase();
  for (var i = 0; i < names.length; i++) {
    if (String(names[i][0] || '').trim().toLowerCase() !== want) continue;
    sh.setColumnWidth(10, 200);
    sh.getRange(i + 2, 10).setNumberFormat('@').setValue(period || '');
    return;
  }
}

function jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, error, extra) {
  extra = extra || {};
  return {
    sheet: job.sheet,
    offset: offset,
    pages: pages,
    rowsWritten: rowsWritten,
    keys: keys,
    minIso: minIso,
    maxIso: maxIso,
    period: livePeriod_(sh, job, keys),
    inc: inc,
    refreshFrom: refreshFrom,
    fetchFrom: fetchFrom,
    deleted: deleted,
    error: error || '',
    phase: extra.phase || 'fetch',
    wiped: !!extra.wiped,
    deduped: !!extra.deduped,
    sorted: !!extra.sorted,
    overlayFrom: extra.overlayFrom ? Number(extra.overlayFrom) : 0,
    rowsY: Number(extra.rowsY) || 0,
    rowsO: Number(extra.rowsO) || 0,
    sheetStartedAt: Number(extra.sheetStartedAt) || 0
  };
}

function sheetTz_() {
  return TZ;
}

function sheetCellToIso_(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'number' && isFinite(val) && val > 20000 && val < 120000) {
    var utc = new Date(Math.floor(val + 0.0000001) * 86400 * 1000 - 25569 * 86400 * 1000);
    if (!isNaN(utc.getTime())) return Utilities.formatDate(utc, 'UTC', 'yyyy-MM-dd');
  }
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, TZ, 'yyyy-MM-dd');
  }
  var t = String(val).trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    var instant = parseIsoInstant_(t);
    if (instant) return Utilities.formatDate(instant, TZ, 'yyyy-MM-dd');
  }
  var ru = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (ru) {
    var mm = ru[2].length === 1 ? '0' + ru[2] : ru[2];
    var dd = ru[1].length === 1 ? '0' + ru[1] : ru[1];
    return ru[3] + '-' + mm + '-' + dd;
  }
  var parsed = parseDateString_(t);
  if (parsed) return Utilities.formatDate(parsed, TZ, 'yyyy-MM-dd');
  return '';
}

function sheetRowKeyNames_(job) {
  return (SHEET_ROW_KEYS_[job.sheet] || []).slice();
}

function incKeyIndex_(keys, name) {
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === name) return i;
  }
  return -1;
}

function incRowKey_(values, keys, keyNames) {
  if (!keyNames || !keyNames.length || !values || !keys) return '';
  var parts = [];
  for (var i = 0; i < keyNames.length; i++) {
    var idx = incKeyIndex_(keys, keyNames[i]);
    if (idx < 0) return '';
    var v = idx < values.length ? values[idx] : '';
    if (v == null || v === '') return '';
    var iso = sheetCellToIso_(v);
    parts.push(iso || String(v).replace(/^\s+|\s+$/g, '').toLowerCase());
  }
  return parts.join('\x1f');
}

function incIndexKeys_(sh, keys, keyNames) {
  var out = {};
  if (!sh || sh.getLastRow() < 2 || !keyNames.length) return out;
  var width = Math.max(sh.getLastColumn(), keys.length);
  if (width < 1) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues();
  for (var i = 0; i < data.length; i++) {
    var k = incRowKey_(data[i], keys, keyNames);
    if (k) out[k] = 1;
  }
  return out;
}

function incIndexKeyRows_(sh, keys, keyNames) {
  var out = {};
  if (!sh || sh.getLastRow() < 2 || !keyNames.length) return out;
  var width = Math.max(sh.getLastColumn(), keys.length);
  if (width < 1) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues();
  for (var i = 0; i < data.length; i++) {
    var k = incRowKey_(data[i], keys, keyNames);
    if (k) out[k] = i + 2;
  }
  return out;
}

function incPatchFields_(sh, job, keys, rowIdx, dbRow, ss) {
  var patchKeys = INC_PATCH_FIELDS_[job.sheet];
  if (!patchKeys || !patchKeys.length || !sh || rowIdx < 2 || !dbRow) return false;
  var changed = false;
  for (var pi = 0; pi < patchKeys.length; pi++) {
    var pk = patchKeys[pi];
    var kidx = incKeyIndex_(keys, pk);
    if (kidx < 0) continue;
    var newVal = dbRow[pk];
    if ((newVal == null || String(newVal).trim() === '') && job.sheet === 'Рекламные расходы' && pk === 'name') {
      enrichAdsRowName_(ss, dbRow);
      newVal = dbRow[pk];
    }
    if (newVal == null || String(newVal).trim() === '') continue;
    var cur = sh.getRange(rowIdx, kidx + 1).getValue();
    if (cur != null && String(cur).trim() !== '') continue;
    var cellVal = isSheetDateKey_(pk) ? toSheetDate_(newVal) : cellValue_(newVal);
    sh.getRange(rowIdx, kidx + 1).setValue(cellVal);
    changed = true;
  }
  return changed;
}

function incRewriteBody_(sh, lastCol, keep) {
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (n < 1 || lastCol < 1) return;
  sh.getRange(2, 1, n, lastCol).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, lastCol).setValues(keep);
}

function ensureSheetCols_(sh, ncol) {
  ncol = Math.max(1, Number(ncol) || 1);
  if (!sh) return;
  var maxC = sh.getMaxColumns();
  if (maxC < ncol) sh.insertColumnsAfter(maxC, ncol - maxC);
}

/** Удаляет колонки справа от ncol (старые поля после смены галочек). */
function trimSheetExtraColumns_(sh, ncol) {
  if (!sh) return;
  ncol = Math.max(1, Number(ncol) || 1);
  var lastCol = sh.getLastColumn();
  if (lastCol <= ncol) return;
  var extra = lastCol - ncol;
  var maxRow = Math.max(sh.getLastRow(), 1);
  try {
    sh.getRange(1, ncol + 1, maxRow, extra).clearContent();
    sh.deleteColumns(ncol + 1, extra);
  } catch (e) {
    try { sh.getRange(1, ncol + 1, maxRow, extra).clearContent(); } catch (e2) {}
  }
}

function writeSheetBlock_(sh, startRow, values, numCols) {
  var numRows = values.length;
  numCols = Math.max(1, Number(numCols) || 1);
  if (!sh || numRows < 1) return;
  ensureSheetCols_(sh, numCols);
  var needRows = startRow + numRows - 1;
  if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
  sh.getRange(startRow, 1, numRows, numCols).setValues(values);
}

function sheetJobHeavy_(sh, keys, rowCount) {
  var rows = Number(rowCount);
  if (!rows && sh) rows = Math.max(sh.getLastRow() - 1, 0);
  return rows > SHEET_HEAVY_ROWS_ || (keys && keys.length > SHEET_HEAVY_COLS_);
}

/** Пишет блок строк кусками; при нехватке времени возвращает число записанных строк. */
function writeSheetValuesChunked_(sh, startRow, values, numCols, keys, fmtState, started, heavy) {
  if (!values || !values.length) return values.length;
  numCols = Math.max(1, Number(numCols) || 1);
  var chunk = heavy ? SHEET_WRITE_CHUNK_ : values.length;
  var written = 0;
  while (written < values.length) {
    if (written > 0 && overBudget_(started, 0)) return written;
    var slice = values.slice(written, written + chunk);
    var row = startRow + written;
    ensureFormatsAhead_(sh, row, slice.length, keys, fmtState);
    writeSheetBlock_(sh, row, slice, numCols);
    styleBody_(sh, row, slice.length, numCols);
    written += slice.length;
  }
  return written;
}

function finishSheetJob_(ss, job, sh, keys, started, overlayFrom, inc, heavy, opt) {
  opt = opt || {};
  var delMs = Number(opt.delMs) || 0;
  var deleted = Number(opt.deleted) || 0;
  var fetchMs = Number(opt.fetchMs) || 0;
  var writeMs = Number(opt.writeMs) || 0;
  var sortMs = Number(opt.sortMs) || 0;
  var rowsWritten = Number(opt.rowsWritten) || 0;
  var pages = Number(opt.pages) || 0;
  var offset = Number(opt.offset) || 0;
  var wiped = !!opt.wiped;
  if (overBudget_(started, 0)) {
    return jobResume_(job, sh, keys, offset, pages, rowsWritten, opt.minIso || '', opt.maxIso || '', inc,
      opt.refreshFrom || '', opt.fetchFrom || '', deleted, '', {
        phase: 'finish', wiped: wiped, deduped: !!opt.deduped, sorted: !!opt.sorted, overlayFrom: overlayFrom
      });
  }
  writeSettingsMeta_(ss, job.sheet, livePeriod_(sh, job, keys), nowMsk_());
  try {
    trimSheetExtraColumns_(sh, keys.length);
    var lastCol = keys.length;
    styleHeader_(sh, lastCol);
    if (!inc && !heavy) {
      styleSheet_(sh);
    } else {
      var fromRow = 0;
      if (!inc && sh.getLastRow() >= 2) fromRow = 2;
      else if (overlayFrom && sh.getLastRow() >= overlayFrom) fromRow = overlayFrom;
      if (fromRow) finishStyleBody_(sh, fromRow, lastCol, started, heavy, keys.length);
    }
    if (!heavy && !overBudget_(started, 0)) applyFilter_(sh);
  } catch (eStyle) {}
  if (overBudget_(started, 0)) {
    return jobResume_(job, sh, keys, offset, pages, rowsWritten, opt.minIso || '', opt.maxIso || '', inc,
      opt.refreshFrom || '', opt.fetchFrom || '', deleted, '', {
        phase: 'finish', wiped: wiped, deduped: !!opt.deduped, sorted: !!opt.sorted, overlayFrom: overlayFrom
      });
  }
  logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, sortMs, rowsWritten, pages, offset);
  var note = inc ? ('окно, −' + deleted + ' стр., с ' + isoToRu_(opt.fetchFrom || opt.refreshFrom || '')) : '';
  if (morningAppendFirst_()) note = inc ? ('новый день с ' + isoToRu_(opt.fetchFrom || opt.refreshFrom || '')) : note;
  if (wiped || heavy) note = (note ? note + '; ' : '') + 'без полной сортировки';
  if (wiped && !overlayFrom && sh.getLastRow() >= 2) overlayFrom = 2;
  if (overlayFrom && sh.getLastRow() >= overlayFrom) {
    rememberOverlayRange_(job.sheet, overlayFrom, sh.getLastRow() - overlayFrom + 1);
  }
  if (job.sheet === 'Рекламные расходы' && sh.getLastRow() >= 2) {
    try {
      var adsNm = syncAdsNamesFromProducts_(ss, sh, keys);
      if (adsNm > 0) {
        note = (note ? note + '; ' : '') + 'названия: ' + adsNm;
        log_(ss, 'Рекламные расходы', 'названия', adsNm, 0, 0, 'из Товары', 0);
      }
      ensureSheetFilter_(sh, 'Рекламные расходы');
    } catch (eAdsFin) {}
  } else if (job.sheet === 'Товары') {
    try {
      var adsFilled = refreshAdsNamesAfterProducts_(ss);
      if (adsFilled) log_(ss, 'Рекламные расходы', 'названия', adsFilled, 0, 0, 'после Товары', 0);
    } catch (eProdAds) {}
  }
  log_(ss, job.sheet, inc ? 'инкремент' : 'готово', reportMorningRows_(rowsWritten, overlayFrom, inc), pages, offset, note, Date.now() - started);
  var dur = sheetLogDurationMs_(job.sheet);
  var touchRows = reportMorningRows_(rowsWritten, overlayFrom, inc);
  reportGasSheetTouch_(job.sheet, touchRows || dur.rows, dur.ms || (Date.now() - started));
  if (morningAppendFirst_()) morningMarkSheetDone_(ss, job, touchRows, {
    rowsY: opt.rowsY, rowsO: opt.rowsO, startedAt: opt.sheetStartedAt
  });
  return null;
}

function writeSheetHeaders_(sh, keys, job, colInfo) {
  if (!keys || !keys.length) return;
  var headersRu = keys.map(function (key) {
    return displayName_(job.sheet, key, colInfo);
  });
  var ncol = headersRu.length;
  trimSheetExtraColumns_(sh, ncol);
  ensureSheetCols_(sh, ncol);
  sh.getRange(1, 1, 1, ncol).setValues([headersRu]);
  styleHeader_(sh, ncol);
}

function findDateColIndex_(headers, job, colInfo) {
  if (!job.dateCol || !headers || !headers.length) return 0;
  var aliases = jobDateColAliases_(job);
  var a;
  var i;
  for (a = 0; a < aliases.length; a++) {
    var wantRu = String(displayName_(job.sheet, aliases[a], colInfo || { map: {} })).trim().toLowerCase();
    var wantKey = String(aliases[a]).trim().toLowerCase();
    for (i = 0; i < headers.length; i++) {
      var h = String(headers[i] || '').trim().toLowerCase();
      if (!h) continue;
      if (h === wantKey || h === wantRu) return i + 1;
    }
  }
  return 0;
}

function headerKeysFromSheet_(sh, job, colInfo, fallbackKeys) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return fallbackKeys.slice();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var ruToKey = {};
  var i;
  for (i = 0; i < fallbackKeys.length; i++) {
    var key = fallbackKeys[i];
    if (!key) continue;
    ruToKey[String(key).trim().toLowerCase()] = key;
    var ru = displayName_(job.sheet, key, colInfo);
    ruToKey[String(ru).trim().toLowerCase()] = key;
  }
  var out = [];
  for (i = 0; i < headers.length; i++) {
    var name = String(headers[i] || '').trim();
    out.push(name ? (ruToKey[name.toLowerCase()] || '') : '');
  }
  return out;
}

function dbHeaderKeysFromSheet_(sh, job, colInfo) {
  var def = job ? defaultSheetByName_(job.sheet) : null;
  if (!def && job) def = job;
  var catalog = sheetKeys_(def);
  var ruToKey = {};
  var i;
  for (i = 0; i < catalog.length; i++) {
    var key = catalog[i];
    if (!key) continue;
    ruToKey[String(key).trim().toLowerCase()] = key;
    var ru = displayName_(job.sheet, key, colInfo || { map: {} });
    ruToKey[String(ru).trim().toLowerCase()] = key;
  }
  var lastCol = sh ? sh.getLastColumn() : 0;
  if (lastCol < 1) return { keys: [], inMiddle: false };
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var keys = [];
  var sawOther = false;
  var inMiddle = false;
  for (i = 0; i < headers.length; i++) {
    var name = String(headers[i] || '').trim();
    if (!name) continue;
    var mapped = ruToKey[name.toLowerCase()];
    if (mapped) {
      if (sawOther) inMiddle = true;
      keys.push(mapped);
    } else {
      sawOther = true;
    }
  }
  return { keys: keys, inMiddle: inMiddle };
}

function sheetLayoutMatches_(sh, job, colInfo, selected) {
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) return false;
  if (!selected || !selected.length) return false;
  var mapped = dbHeaderKeysFromSheet_(sh, job, colInfo);
  if (mapped.inMiddle) return false;
  if (mapped.keys.length !== selected.length) return false;
  for (var i = 0; i < selected.length; i++) {
    if (mapped.keys[i] !== selected[i]) return false;
  }
  return true;
}

function clearSheetForReload_(sh) {
  if (!sh) return;
  clearFilter_(sh);
  try { sh.clear(); } catch (e) {}
}

function safeDeleteRows_(sh, startRow, howMany) {
  if (!sh || howMany < 1 || startRow < 1) return;
  var frozen = sh.getFrozenRows() || 0;
  var last = sh.getLastRow();
  var bodyRows = Math.max(last - frozen, 0);
  if (howMany >= bodyRows) {
    var lastCol = Math.max(sh.getLastColumn(), 1);
    if (bodyRows > 0) sh.getRange(frozen + 1, 1, bodyRows, lastCol).clearContent();
    return;
  }
  sh.deleteRows(startRow, howMany);
}

function jobDateSortDesc_(job, keys) {
  if (!job || !job.dateCol) return false;
  var specs = parseOrderSpecs_(effectiveOrder_(job), keys || []);
  var i;
  for (i = 0; i < specs.length; i++) {
    if (keys && keys[specs[i].idx] === job.dateCol) return !specs[i].asc;
  }
  var ord = effectiveOrder_(job);
  if (!ord) return false;
  return new RegExp('(^|,)' + String(job.dateCol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.desc($|,)', 'i').test(ord);
}

/** Большой лист: подрезка окна с краёв по sort order, без чтения всей колонки дат. */
function incKeepRowsByDateEdge_(sh, job, dateColIdx, cutoffIso, refreshFromIso, keys, lastCol, n) {
  var last = n + 1;
  var dateDesc = jobDateSortDesc_(job, keys);
  var dropTop = 0;
  var dropBottom = 0;
  var maxEdge = 800;
  var r;
  var scanned = 0;

  if (dateDesc) {
    r = 2;
    while (r <= last && scanned < maxEdge) {
      var isoTop = sheetDateIsoAt_(sh, r, dateColIdx);
      scanned++;
      if (!isoTop || (refreshFromIso && isoTop >= refreshFromIso)) { dropTop++; r++; }
      else break;
    }
    if (scanned >= maxEdge) return -1;
    r = last;
    scanned = 0;
    while (r >= 2 + dropTop && scanned < maxEdge) {
      var isoBot = sheetDateIsoAt_(sh, r, dateColIdx);
      scanned++;
      if (!isoBot || (cutoffIso && isoBot < cutoffIso)) { dropBottom++; r--; }
      else break;
    }
    if (scanned >= maxEdge) return -1;
  } else {
    r = 2;
    scanned = 0;
    while (r <= last && scanned < maxEdge) {
      var isoOld = sheetDateIsoAt_(sh, r, dateColIdx);
      scanned++;
      if (!isoOld || (cutoffIso && isoOld < cutoffIso)) { dropTop++; r++; }
      else break;
    }
    if (scanned >= maxEdge) return -1;
    r = last;
    scanned = 0;
    while (r >= 2 + dropTop && scanned < maxEdge) {
      var isoNew = sheetDateIsoAt_(sh, r, dateColIdx);
      scanned++;
      if (!isoNew || (refreshFromIso && isoNew >= refreshFromIso)) { dropBottom++; r--; }
      else break;
    }
    if (scanned >= maxEdge) return -1;
  }

  var dropped = 0;
  if (dropBottom > 0) {
    safeDeleteRows_(sh, last - dropBottom + 1, dropBottom);
    dropped += dropBottom;
    last = sh.getLastRow();
  }
  if (dropTop > 0) {
    safeDeleteRows_(sh, 2, dropTop);
    dropped += dropTop;
  }
  return dropped;
}

function incKeepRowsByDate_(sh, job, dateColIdx, cutoffIso, refreshFromIso, keys) {
  var last = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (last < 2 || dateColIdx < 1) return 0;
  var n = last - 1;
  if (cutoffIso && refreshFromIso && cutoffIso === refreshFromIso) {
    sh.getRange(2, 1, n, lastCol).clearContent();
    return n;
  }
  if (n > SHEET_DATE_BOUNDS_FULL_SCAN_MAX_) {
    var edgeDropped = incKeepRowsByDateEdge_(sh, job, dateColIdx, cutoffIso, refreshFromIso, keys, lastCol, n);
    if (edgeDropped >= 0) return edgeDropped;
    return 0;
  }
  var col = sh.getRange(2, dateColIdx, n, 1).getDisplayValues();
  var isos = [];
  var i;
  for (i = 0; i < n; i++) isos.push(sheetCellToIso_(col[i][0]));
  var dropTop = 0;
  while (dropTop < n) {
    var iso = isos[dropTop];
    if (!iso || (cutoffIso && iso < cutoffIso) || (refreshFromIso && iso >= refreshFromIso)) dropTop++;
    else break;
  }
  var dropFrom = n;
  while (dropFrom > dropTop) {
    var iso2 = isos[dropFrom - 1];
    if (!iso2 || (cutoffIso && iso2 < cutoffIso) || (refreshFromIso && iso2 >= refreshFromIso)) dropFrom--;
    else break;
  }
  var messy = false;
  for (i = dropTop; i < dropFrom; i++) {
    var iso3 = isos[i];
    if (!iso3 || (cutoffIso && iso3 < cutoffIso) || (refreshFromIso && iso3 >= refreshFromIso)) {
      messy = true;
      break;
    }
  }
  if (messy) {
    if (n > 5000) return 0;
    return incKeepRowsByDateSlow_(sh, job, dateColIdx, cutoffIso, refreshFromIso, keys, lastCol, n);
  }
  var dropped = 0;
  if (dropFrom < n) {
    var tail = n - dropFrom;
    safeDeleteRows_(sh, dropFrom + 2, tail);
    dropped += tail;
    n = Math.max(sh.getLastRow() - 1, 0);
  }
  if (dropTop > 0) {
    safeDeleteRows_(sh, 2, dropTop);
    dropped += dropTop;
  }
  return dropped;
}

function incKeepRowsByDateSlow_(sh, job, dateColIdx, cutoffIso, refreshFromIso, keys, lastCol, n) {
  var data = sh.getRange(2, 1, n, lastCol).getValues();
  var shownDates = sh.getRange(2, dateColIdx, n, 1).getDisplayValues();
  var keyNames = sheetRowKeyNames_(job);
  var keep = [];
  var byKey = {};
  var order = [];
  var dropped = 0;
  var i;
  for (i = 0; i < n; i++) {
    var iso = sheetCellToIso_(shownDates[i][0]);
    var gone = false;
    if (!iso) {
      gone = true;
    } else {
      if (cutoffIso && iso < cutoffIso) gone = true;
      if (refreshFromIso && iso >= refreshFromIso) gone = true;
    }
    if (gone) {
      dropped++;
      continue;
    }
    var rk = incRowKey_(data[i], keys, keyNames);
    if (rk) {
      if (byKey[rk] == null) order.push(rk);
      else dropped++;
      byKey[rk] = data[i];
    } else {
      order.push('\0' + i);
      byKey[order[order.length - 1]] = data[i];
    }
  }
  for (i = 0; i < order.length; i++) keep.push(byKey[order[i]]);
  if (!dropped) return 0;
  incRewriteBody_(sh, lastCol, keep);
  return dropped;
}

function incDedupeSheet_(sh, job, keys) {
  var last = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var keyNames = sheetRowKeyNames_(job);
  if (last < 2 || lastCol < 1 || !keyNames.length) return 0;
  var n = last - 1;
  var data = sh.getRange(2, 1, n, lastCol).getValues();
  var byKey = {};
  var order = [];
  var dropped = 0;
  for (var i = 0; i < n; i++) {
    var rk = incRowKey_(data[i], keys, keyNames);
    if (!rk) {
      order.push('\0' + i);
      byKey[order[order.length - 1]] = data[i];
      continue;
    }
    if (byKey[rk] == null) order.push(rk);
    else dropped++;
    byKey[rk] = data[i];
  }
  if (!dropped) return 0;
  var keep = [];
  for (i = 0; i < order.length; i++) keep.push(byKey[order[i]]);
  incRewriteBody_(sh, lastCol, keep);
  return dropped;
}

function mergeTypedKeys_(job, colInfo, keys) {
  return selectedKeys_(job, colInfo);
}

function sheetHasTypedHeaders_(sh, job, colInfo) {
  return sheetLayoutMatches_(sh, job, colInfo, selectedKeys_(job, colInfo));
}

function loadOneJob_(ss, job, sellerId, resume, started, forceFull) {
  if (isManualSheet_(job.sheet)) return null;
  var pageSize = Math.min(Math.max(Number(job.page) || 1000, 1), 1000);
  var offset = resume && resume.offset ? Number(resume.offset) : 0;
  var pages = resume && resume.pages ? Number(resume.pages) : 0;
  var rowsWritten = resume && resume.rowsWritten ? Number(resume.rowsWritten) : 0;
  var colInfo = readColumnMap_(ss, job.sheet);
  var selected = selectedKeys_(job, colInfo);
  var keys = (resume && resume.keys && resume.keys.length) ? resume.keys.slice() : selected.slice();
  if (!keys.length) keys = selected.slice();
  var inc = !!(resume && resume.inc);
  var refreshFrom = resume && resume.refreshFrom ? resume.refreshFrom : '';
  var fetchFrom = resume && resume.fetchFrom ? resume.fetchFrom : '';
  var deleted = resume && resume.deleted ? Number(resume.deleted) : 0;
  var phase = resume && resume.phase ? resume.phase : 'fetch';
  var wiped = !!(resume && resume.wiped);
  var deduped = !!(resume && resume.deduped);
  var sorted = !!(resume && resume.sorted);
  var overlayFrom = resume && resume.overlayFrom ? Number(resume.overlayFrom) : 0;
  var rowsY = resume && resume.rowsY ? Number(resume.rowsY) : 0;
  var rowsO = resume && resume.rowsO ? Number(resume.rowsO) : 0;
  var sheetStartedAt = resume && resume.sheetStartedAt ? Number(resume.sheetStartedAt) : Date.now();
  var delMs = 0;
  var fetchMs = 0;
  var writeMs = 0;
  var sortMs = 0;
  var fmtState = { through: 0, keyCount: 0, widthCount: 0 };

  var sh = ss.getSheetByName(job.sheet);
  if (!sh) sh = ss.insertSheet(job.sheet);
  try { rehideDataSheetsIfWanted_(ss); } catch (eHid) {}

  var needPrep = !resume || String(resume.phase || '') === 'prep';

  if (!resume && !forceFull && sheetLoadUpToDate_(sh, job, colInfo, selected)) {
    logMorningStep_(ss, 'лист', '', job.sheet, 'пропуск', 'уже актуально', Date.now() - started);
    touchSkippedSheetMeta_(ss, job, sh, colInfo, selected);
    var skipRows = morningAppendFirst_() ? 0 : Math.max(sh.getLastRow() - 1, 0);
    reportGasSheetTouch_(job.sheet, skipRows, Date.now() - started);
    if (morningAppendFirst_()) morningMarkSheetDone_(ss, job, 0, { skipped: true, startedAt: sheetStartedAt });
    return null;
  }

  clearFilter_(sh);

  if (needPrep) {
    if (overBudget_(started, overlayReserveMs_())) {
      return pauseLoadJob_(ss, job, sh, selected.slice(), started, {
        extra: { phase: 'prep', sheetStartedAt: sheetStartedAt, rowsY: rowsY, rowsO: rowsO }
      });
    }
    if (!forceFull) {
      var policy = incPolicy_(job);
      if (policy !== 'replace' && sh.getLastRow() >= 2 && sheetLayoutMatches_(sh, job, colInfo, selected)) {
        var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
        var dateIdx = findDateColIndex_(headers0, job, colInfo);
        if (dateIdx) {
          inc = true;
          var cutoff = dateFromDays_(job.days);
          refreshFrom = incRefreshFrom_(job);
          keys = selected.slice();
          var keyDateIdx = findDateColIndexFromKeys_(keys, job);
          if (keyDateIdx) dateIdx = keyDateIdx;
          fetchFrom = incFetchFrom_(job);
          if (morningAppendFirst_()) {
            deleted = 0;
            rowsWritten = Math.max(sh.getLastRow() - 1, 0);
            if (!overlayFrom) overlayFrom = rowsWritten + 2;
          } else {
            var tDel = Date.now();
            deleted = incKeepRowsByDate_(sh, job, dateIdx, cutoff, refreshFrom, keys);
            delMs += Date.now() - tDel;
            if (cutoff && refreshFrom && cutoff === refreshFrom) {
              wiped = true;
              rowsWritten = 0;
            } else {
              rowsWritten = Math.max(sh.getLastRow() - 1, 0);
              var kept = sheetDateBounds_(sh, dateIdx);
              if (kept.min && cutoff && kept.min > cutoff) {
                refreshFrom = cutoff;
                fetchFrom = cutoff;
                var wipeN = Math.max(sh.getLastRow() - 1, 0);
                if (wipeN > 0) sh.getRange(2, 1, wipeN, sh.getLastColumn()).clearContent();
                wiped = true;
                rowsWritten = 0;
              } else if (kept.max) {
                var gapFrom = isoAddDays_(kept.max, 1);
                if (gapFrom && (!fetchFrom || gapFrom < fetchFrom)) fetchFrom = gapFrom;
              }
            }
          }
        }
      }
    }
    if (forceFull || !inc) {
      keys = selected.slice();
      clearSheetForReload_(sh);
      rowsWritten = 0;
      wiped = true;
    }
    if (overBudget_(started, overlayReserveMs_())) {
      return pauseLoadJob_(ss, job, sh, keys, started, {
        delMs: delMs, deleted: deleted, fetchMs: fetchMs, writeMs: writeMs,
        rowsWritten: rowsWritten, pages: pages, offset: offset,
        inc: inc, refreshFrom: refreshFrom, fetchFrom: fetchFrom,
        extra: { phase: 'fetch', wiped: wiped, deduped: false, sorted: false, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt }
      });
    }
    phase = 'fetch';
  }

  var minIso = resume && resume.minIso ? resume.minIso : '';
  var maxIso = resume && resume.maxIso ? resume.maxIso : '';
  var extra = { phase: phase, wiped: wiped, deduped: deduped, sorted: sorted, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt };
  var heavy = sheetJobHeavy_(sh, keys, rowsWritten);

  if (phase === 'finish') {
    return finishSheetJob_(ss, job, sh, keys, started, overlayFrom, inc, heavy, {
      delMs: delMs, deleted: deleted, fetchMs: fetchMs, writeMs: writeMs, sortMs: sortMs,
      rowsWritten: rowsWritten, pages: pages, offset: offset,
      minIso: minIso, maxIso: maxIso, refreshFrom: refreshFrom, fetchFrom: fetchFrom,
      wiped: wiped, deduped: deduped, sorted: sorted,
      rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt
    });
  }

  if (phase !== 'finish') {
    var path = buildPath_(job, sellerId, inc ? (fetchFrom || refreshFrom) : '');
    var keyNames = sheetRowKeyNames_(job);
    if (overBudget_(started, overlayReserveMs_())) {
      return pauseLoadJob_(ss, job, sh, keys, started, {
        delMs: delMs, deleted: deleted, fetchMs: fetchMs, writeMs: writeMs,
        rowsWritten: rowsWritten, pages: pages, offset: offset,
        inc: inc, refreshFrom: refreshFrom, fetchFrom: fetchFrom,
        minIso: minIso, maxIso: maxIso,
        extra: { phase: 'fetch', wiped: wiped, deduped: deduped, sorted: sorted, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt }
      });
    }
    var tIdx = Date.now();
    var haveKeys = {};
    var keyRows = {};
    if (inc && !wiped) {
      var edge = null;
      if (morningAppendFirst_()) {
        var edgeHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
        var edgeDateIdx = findDateColIndex_(edgeHeaders, job, colInfo);
        var edgeKeyDate = findDateColIndexFromKeys_(keys, job);
        if (edgeKeyDate) edgeDateIdx = edgeKeyDate;
        edge = incIndexDirtyEdge_(sh, job, keys, edgeDateIdx, refreshFrom || fetchFrom);
      }
      if (edge && edge.ok) {
        haveKeys = edge.haveKeys;
        keyRows = edge.keyRows;
      } else {
        haveKeys = incIndexKeys_(sh, keys, keyNames);
        keyRows = incIndexKeyRows_(sh, keys, keyNames);
      }
      delMs += Date.now() - tIdx;
    }
    var batchSeen = {};
    var prefetched = [];
    var networkBatchPages = inc ? 1 : 3;
    while (true) {
      extra = { phase: 'fetch', wiped: wiped, deduped: false, sorted: false, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt };
      if (overBudget_(started, 0)) {
        logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, 0, rowsWritten, pages, offset);
        return jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, '', extra);
      }
      var pack;
      var tFetch = Date.now();
      try {
        if (!prefetched.length) {
          prefetched = dbFetchBatch_(path, offset, pageSize, networkBatchPages);
        }
        pack = prefetched.shift();
      } catch (fetchErr) {
        fetchMs += Date.now() - tFetch;
        logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, 0, rowsWritten, pages, offset);
        return jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, limitMsg_(fetchErr), extra);
      }
      fetchMs += Date.now() - tFetch;
      var rows = pack.rows || [];
      if (!rows.length) break;

      var tWrite = Date.now();
      var prepared = [];
      for (var pr = 0; pr < rows.length; pr++) {
        var prep = prepareRow_(job.sheet, rows[pr]);
        if (job.sheet === 'Рекламные расходы') enrichAdsRowName_(ss, prep);
        prepared.push(prep);
      }
      if (rowsWritten === 0) writeSheetHeaders_(sh, keys, job, colInfo);

      var values = [];
      for (var r = 0; r < rows.length; r++) {
        var bounds = dateBounds_(rows[r], job.dateCol);
        if (bounds) {
          if (!minIso || bounds < minIso) minIso = bounds;
          if (!maxIso || bounds > maxIso) maxIso = bounds;
        }
        var line = rowToValues_(prepared[r], keys);
        if (inc && keyNames.length) {
          var rk = incRowKey_(line, keys, keyNames);
          if (rk && keyRows[rk]) {
            if (job.sheet === 'Поставки FBW' || job.sheet === 'Поставки FBS') {
              try {
                sh.getRange(keyRows[rk], 1, 1, keys.length).setValues([line]);
                bumpMorningWritten_(1);
              } catch (eRw) {}
              if (morningIsYesterdayRow_(job, bounds)) rowsY++; else rowsO++;
              continue;
            }
            incPatchFields_(sh, job, keys, keyRows[rk], prepared[r], ss);
            if (morningIsYesterdayRow_(job, bounds)) rowsY++; else rowsO++;
            continue;
          }
          if (rk && (haveKeys[rk] || batchSeen[rk])) continue;
          if (rk) {
            haveKeys[rk] = 1;
            batchSeen[rk] = 1;
          }
        }
        values.push(line);
        if (morningIsYesterdayRow_(job, bounds)) rowsY++; else rowsO++;
      }
      extra.rowsY = rowsY;
      extra.rowsO = rowsO;
      extra.sheetStartedAt = sheetStartedAt;
      if (!values.length) {
        writeMs += Date.now() - tWrite;
        pages += 1;
        offset += rows.length;
        if (rows.length < pageSize) break;
        continue;
      }
      var startRow = rowsWritten + 2;
      var numCols = keys.length;
      if (!numCols) {
        keys = selected.slice();
        numCols = keys.length;
      }
      heavy = sheetJobHeavy_(sh, keys, rowsWritten + values.length);
      var wrote = 0;
      try {
        ensureColumnWidthsOnce_(sh, keys, fmtState);
        wrote = writeSheetValuesChunked_(sh, startRow, values, numCols, keys, fmtState, started, heavy);
      } catch (writeErr) {
        var healed = false;
        if (rowsWritten === 0 && isSheetRecoverableWriteError_(writeErr)) {
          try {
            clearSheetForReload_(sh);
            keys = selected.slice();
            numCols = keys.length;
            heavy = sheetJobHeavy_(sh, keys, values.length);
            writeSheetHeaders_(sh, keys, job, colInfo);
            ensureColumnWidthsOnce_(sh, keys, fmtState);
            wrote = writeSheetValuesChunked_(sh, startRow, values, numCols, keys, fmtState, started, heavy);
            healed = true;
          } catch (eHeal) {}
        }
        if (!healed) {
          writeMs += Date.now() - tWrite;
          logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, 0, rowsWritten, pages, offset);
          return jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, limitMsg_(writeErr), extra);
        }
      }
      if (!overlayFrom) overlayFrom = startRow;
      extra.overlayFrom = overlayFrom;
      rowsWritten += wrote;
      bumpMorningWritten_(wrote);
      pages += 1;
      writeMs += Date.now() - tWrite;
      if (wrote < values.length) {
        logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, 0, rowsWritten, pages, offset);
        extra = { phase: 'fetch', wiped: wiped, deduped: false, sorted: false, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt };
        return jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, '', extra);
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    if (overBudget_(started, overlayReserveMs_())) {
      logLoadPhases_(ss, job.sheet, delMs, deleted, fetchMs, writeMs, 0, rowsWritten, pages, offset);
      extra = { phase: 'finish', wiped: wiped, deduped: false, sorted: false, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt };
      return jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, '', extra);
    }
  }

  if (inc && !wiped && !deduped) {
    deduped = true;
  }
  heavy = sheetJobHeavy_(sh, keys, rowsWritten);
  if (!sorted && !wiped && inc && !heavy && !overlayFrom) {
    if (overBudget_(started, overlayReserveMs_())) {
      extra = { phase: 'finish', wiped: wiped, deduped: true, sorted: false, overlayFrom: overlayFrom, rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt };
      return jobResume_(job, sh, keys, offset, pages, rowsWritten, minIso, maxIso, inc, refreshFrom, fetchFrom, deleted, '', extra);
    }
    var tSort = Date.now();
    try { sortSheet_(sh, job, keys); } catch (eSort) {}
    sortMs = Date.now() - tSort;
    sorted = true;
  }
  return finishSheetJob_(ss, job, sh, keys, started, overlayFrom, inc, heavy, {
    delMs: delMs, deleted: deleted, fetchMs: fetchMs, writeMs: writeMs, sortMs: sortMs,
    rowsWritten: rowsWritten, pages: pages, offset: offset,
    minIso: minIso, maxIso: maxIso, refreshFrom: refreshFrom, fetchFrom: fetchFrom,
    wiped: wiped, deduped: deduped, sorted: sorted,
    rowsY: rowsY, rowsO: rowsO, sheetStartedAt: sheetStartedAt
  });
}

function typedKeys_(job) {
  var def = null;
  for (var i = 0; i < DEFAULT_SHEETS.length; i++) {
    if (DEFAULT_SHEETS[i].sheet === job.sheet || DEFAULT_SHEETS[i].view === job.view) {
      def = DEFAULT_SHEETS[i];
      break;
    }
  }
  if (def) return sheetKeys_(def);
  return [];
}

function buildPath_(job, sellerId, fromIso) {
  var q = '/rest/v1/' + encodeURIComponent(job.view) + '?seller_id=eq.' + encodeURIComponent(sellerId);
  var from = fromIso || '';
  if (!from && job.dateCol && !isAllDays_(job.days)) from = dateFromDays_(job.days);
  var cutoff = job.days && !isAllDays_(job.days) ? dateFromDays_(job.days) : '';
  if (job.sheet === 'Поставки FBW' && from) {
    q += '&or=(supply_dt.gte.' + encodeURIComponent(from)
      + ',and(status_name.neq.' + encodeURIComponent('Принято')
      + ',supply_dt.gte.' + encodeURIComponent(cutoff || from) + '))';
  } else if (job.sheet === 'Поставки FBS' && from) {
    q += '&or=(loaded_at.gte.' + encodeURIComponent(from + 'T00:00:00+03:00')
      + ',done.eq.false)';
  } else if (job.dateCol && from) {
    var col = job.dateCol;
    if (col === 'order_dt' || col === 'created_at' || col === 'loaded_at' || col === 'last_change_dt') {
      q += '&' + col + '=gte.' + encodeURIComponent(from + 'T00:00:00+03:00');
    } else {
      q += '&' + col + '=gte.' + encodeURIComponent(from);
    }
  }
  if (effectiveOrder_(job)) q += '&order=' + effectiveOrder_(job);
  return q;
}

function effectiveOrder_(job) {
  if (job && job.order) return job.order;
  if (!job) return '';
  for (var i = 0; i < DEFAULT_SHEETS.length; i++) {
    if (DEFAULT_SHEETS[i].sheet === job.sheet || DEFAULT_SHEETS[i].view === job.view) {
      return DEFAULT_SHEETS[i].order || '';
    }
  }
  return '';
}

function parseOrderSpecs_(order, keys) {
  var out = [];
  var parts = String(order || '').split(',');
  for (var i = 0; i < parts.length; i++) {
    var p = String(parts[i] || '').trim();
    if (!p) continue;
    var m = p.match(/^([A-Za-z0-9_]+)\.(asc|desc)$/i);
    if (!m) continue;
    var idx = -1;
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === m[1]) { idx = k; break; }
    }
    if (idx < 0) continue;
    out.push({ idx: idx, asc: String(m[2]).toLowerCase() !== 'desc' });
  }
  return out;
}

function sortValue_(v) {
  if (v == null || v === '') return { k: 2, v: '' };
  if (typeof v === 'number' && isFinite(v)) return { k: 0, v: v };
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return { k: 0, v: v.getTime() };
  }
  var iso = sheetCellToIso_(v);
  if (iso) {
    var t = String(v);
    var hm = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    var add = 0;
    if (hm) add = (Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3] || 0)) * 1000;
    var p = iso.split('-');
    return { k: 0, v: Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + add };
  }
  var s = String(v).replace(/\s/g, '').replace(',', '.');
  if (/^-?\d+(\.\d+)?$/.test(s)) return { k: 0, v: Number(s) };
  return { k: 1, v: String(v).toLowerCase() };
}

function cmpSortVals_(a, b) {
  if (a.k !== b.k) return a.k - b.k;
  if (a.v < b.v) return -1;
  if (a.v > b.v) return 1;
  return 0;
}

function sortSheet_(sh, job, keys) {
  if (!sh) return;
  clearFilter_(sh);
  var last = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (last < 3 || lastCol < 1) return;
  var specs = parseOrderSpecs_(effectiveOrder_(job), keys);
  if (!specs.length && job.dateCol) {
    var di = -1;
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === job.dateCol) { di = k; break; }
    }
    if (di >= 0) specs.push({ idx: di, asc: true });
  }
  if (!specs.length) return;
  var rng = sh.getRange(2, 1, last - 1, lastCol);
  var data = rng.getValues();
  var dateIdxs = [];
  var i;
  for (i = 0; i < keys.length; i++) {
    if (DATE_ONLY_KEYS_[keys[i]] || isDateTimeKey_(keys[i])) dateIdxs.push(i);
  }
  var r;
  for (r = 0; r < data.length; r++) {
    for (i = 0; i < dateIdxs.length; i++) {
      var ci = dateIdxs[i];
      if (ci >= data[r].length) continue;
      var converted = toSheetDate_(data[r][ci]);
      if (converted) data[r][ci] = converted;
    }
  }
  data.sort(function (a, b) {
    for (var s = 0; s < specs.length; s++) {
      var ia = specs[s].idx;
      var va = ia < a.length ? sortValue_(a[ia]) : sortValue_('');
      var vb = ia < b.length ? sortValue_(b[ia]) : sortValue_('');
      var c = cmpSortVals_(va, vb);
      if (c) return specs[s].asc ? c : -c;
    }
    return 0;
  });
  rng.setValues(data);
  try { styleBody_(sh, 2, last - 1, lastCol); } catch (eFont) {}
  for (i = 0; i < dateIdxs.length; i++) {
    try { sh.getRange(2, dateIdxs[i] + 1, last - 1, 1).setNumberFormat(DATE_FMT_); } catch (e) {}
  }
}

function prepareRow_(sheetName, row) {
  var extra = row && row.extra && typeof row.extra === 'object' && !(row.extra instanceof Array) ? row.extra : {};
  var out = {};
  var k;
  if (row) {
    for (k in row) {
      if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
      if (k === 'extra' || k === 'payload') continue;
      out[k] = row[k];
    }
  }
  for (k in extra) {
    if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
    if (out[k] === undefined) out[k] = extra[k];
  }
  fillWarehouseAliases_(out);
  if (sheetName === 'Тарифы') translateTariffKind_(out);
  if (sheetName === 'Товары') expandProduct_(out);
  return out;
}

function firstFilled_() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

function translateTariffKind_(out) {
  var map = {
    commission: 'Комиссия',
    box: 'Короб',
    pallet: 'Паллета',
    return: 'Возврат',
    acceptance: 'Приёмка',
  };
  if (out.kind == null || out.kind === '') return;
  var k = String(out.kind).trim().toLowerCase();
  if (map[k]) out.kind = map[k];
}

function fillWarehouseAliases_(out) {
  var name = firstFilled_(
    out.warehouse_name,
    out.warehouseName,
    out.warehouseName,
    out.actualWarehouseName,
    out.actualWarehouseName,
    out.warehouse
  );
  if (!name) return;
  out.warehouse_name = name;
  if (out.warehouseName == null || out.warehouseName === '') out.warehouseName = name;
}

function expandProduct_(out) {
  if (out.sizes !== undefined) out.sizes = flattenSizes_(out.sizes);
  if (out.characteristics !== undefined) {
    applyCharacteristics_(out, out.characteristics);
    delete out.characteristics;
  }
  var dim = out.dimensions;
  if (dim && typeof dim === 'object' && !(dim instanceof Array)) {
    if (out.length === undefined) out.length = dim.length;
    if (out.width === undefined) out.width = dim.width;
    if (out.height === undefined) out.height = dim.height;
    if (out.weightBrutto === undefined) {
      out.weightBrutto = dim.weightBrutto != null ? dim.weightBrutto : dim.weight;
    }
    delete out.dimensions;
  }
  if (out.photos !== undefined) out.photos = flattenPhotos_(out.photos);
  if (out.documents !== undefined) out.documents = flattenDocuments_(out.documents);
  var keys = Object.keys(out);
  for (var i = 0; i < keys.length; i++) {
    var v = out[keys[i]];
    if (v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Date]') {
      out[keys[i]] = flattenAny_(v);
    }
  }
}

function applyCharacteristics_(out, chars) {
  if (typeof chars === 'string') {
    try { chars = JSON.parse(chars); } catch (e) { out.characteristics = chars; return; }
  }
  if (!(chars instanceof Array)) return;
  for (var i = 0; i < chars.length; i++) {
    var c = chars[i];
    if (!c || typeof c !== 'object') continue;
    var name = c.name || c.charcName || c.Name || '';
    if (!name && c.id != null) name = 'id_' + c.id;
    if (!name) continue;
    var val = c.value;
    if (val === undefined) val = c.values;
    if (val === undefined) val = c.charcValues;
    if (val instanceof Array) val = val.join(', ');
    out['char:' + name] = val;
  }
}

function flattenSizes_(sizes) {
  if (typeof sizes === 'string') return stripNl_(sizes);
  if (!(sizes instanceof Array)) return flattenAny_(sizes);
  var parts = [];
  for (var i = 0; i < sizes.length; i++) {
    var s = sizes[i];
    if (!s || typeof s !== 'object') {
      if (s != null && s !== '') parts.push(String(s));
      continue;
    }
    var tech = s.techSize || s.tech_size || '';
    var wb = s.wbSize || s.wb_size || '';
    var skus = s.skus instanceof Array ? s.skus.join(',') : (s.skus || '');
    var label = [tech, wb].filter(function (x) { return x; }).join('/');
    if (skus) label = label ? label + ' (' + skus + ')' : skus;
    if (label) parts.push(label);
  }
  return parts.join('; ');
}

function flattenPhotos_(photos) {
  if (typeof photos === 'string') return stripNl_(photos);
  if (!(photos instanceof Array)) {
    if (photos && typeof photos === 'object') {
      return photos.big || photos.c516x688 || photos.c246x328 || flattenAny_(photos);
    }
    return '';
  }
  var urls = [];
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    if (typeof p === 'string') urls.push(p);
    else if (p && typeof p === 'object') {
      var u = p.big || p.c516x688 || p.c246x328 || p.square || p.tm || '';
      if (u) urls.push(u);
    }
  }
  return urls.join('; ');
}

function flattenDocuments_(docs) {
  if (typeof docs === 'string') return stripNl_(docs);
  if (docs instanceof Array) {
    var parts = [];
    for (var i = 0; i < docs.length; i++) {
      if (typeof docs[i] === 'string') parts.push(docs[i]);
      else if (docs[i] && docs[i].url) parts.push(docs[i].url);
      else if (docs[i]) parts.push(flattenAny_(docs[i]));
    }
    return parts.join('; ');
  }
  if (docs && typeof docs === 'object') {
    var keys = Object.keys(docs);
    var out = [];
    for (var k = 0; k < keys.length; k++) {
      var v = docs[keys[k]];
      if (v instanceof Array) v = v.join(', ');
      else if (v && typeof v === 'object') v = flattenAny_(v);
      if (v) out.push(keys[k] + ': ' + v);
    }
    return out.join('; ');
  }
  return '';
}

function flattenAny_(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'object') return stripNl_(String(val));
  if (Object.prototype.toString.call(val) === '[object Date]') return val;
  if (val instanceof Array) {
    var parts = [];
    for (var i = 0; i < val.length; i++) {
      var item = flattenAny_(val[i]);
      if (item !== '') parts.push(item);
    }
    return parts.join('; ');
  }
  var keys = Object.keys(val);
  var bits = [];
  for (var k = 0; k < keys.length; k++) {
    var v = val[keys[k]];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') v = flattenAny_(v);
    bits.push(keys[k] + ': ' + v);
  }
  return bits.join('; ');
}

var KEY_ALIASES_ = {
  warehouseName: 'warehouse_name',
  warehouseName: 'warehouse_name',
  actualWarehouseName: 'warehouse_name',
  actualWarehouseName: 'warehouse_name',
  warehouse: 'warehouse_name'
};

function collectFlatKeys_(rows, existing) {
  var have = {};
  for (var i = 0; i < existing.length; i++) have[existing[i]] = true;
  var found = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row) continue;
    var ks = Object.keys(row);
    for (var k = 0; k < ks.length; k++) {
      var key = ks[k];
      if (!key || have[key] || key === 'payload' || key === 'extra' || OVERLAY_ONLY_KEYS_[key] || key === 'supply_dt') continue;
      var canon = KEY_ALIASES_[key];
      if (canon && have[canon]) continue;
      have[key] = true;
      found.push(key);
    }
  }
  found.sort();
  return found;
}

function rowToValues_(row, keys) {
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var raw = row ? row[key] : '';
    if (isSheetDateKey_(key)) out.push(toSheetDate_(raw));
    else out.push(cellValue_(raw));
  }
  return out;
}

function stripNl_(val) {
  return String(val)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function cellValue_(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    if (Object.prototype.toString.call(val) === '[object Date]') return toSheetDate_(val) || '';
    return stripNl_(flattenAny_(val));
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'string') return stripNl_(val);
  return val;
}

var DATE_ONLY_KEYS_ = {
  rr_dt: 1, stat_date: 1, snapshot_date: 1, supply_dt: 1, tariff_dt: 1,
  date_from: 1, date_to: 1,
  create_date: 1, supply_date: 1, fact_date: 1,
  created_at: 1, order_dt: 1
};

function isSheetRecoverableWriteError_(e) {
  var msg = String(e && e.message ? e.message : e).toLowerCase();
  return msg.indexOf('границ') >= 0 || msg.indexOf('bounds') >= 0 || msg.indexOf('out of bounds') >= 0
    || msg.indexOf('незакрепленн') >= 0 || msg.indexOf('unfrozen') >= 0;
}

function isSheetBoundsError_(e) {
  return isSheetRecoverableWriteError_(e);
}

var DATE_FMT_ = 'dd.mm.yyyy';

var OVERLAY_ONLY_KEYS_ = {
  ads_article: 1, ads_date: 1, ads_cost: 1
};

function isDateTimeKey_(key) {
  if (!key || DATE_ONLY_KEYS_[key]) return false;
  if (/(_at|_dt|_date)$/.test(key)) return true;
  if (/_date_/.test(key)) return true;
  if (/Date$/.test(key) || /At$/.test(key) || /Dt$/.test(key)) return true;
  return false;
}

function isSheetDateKey_(key) {
  return !!(key && (DATE_ONLY_KEYS_[key] || isDateTimeKey_(key)));
}

function parseDateString_(s) {
  var t = String(s).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    var y = Number(t.substring(0, 4));
    var m = Number(t.substring(5, 7));
    var d = Number(t.substring(8, 10));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  var instant = parseIsoInstant_(t);
  if (!instant) return null;
  return toMskDate_(instant);
}

function parseIsoInstant_(s) {
  var t = String(s).trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return null;
  var iso = t.indexOf('T') >= 0 ? t : t.replace(' ', 'T');
  if (!/[zZ]$/.test(iso) && !/[+-]\d{2}:\d{2}$/.test(iso) && !/[+-]\d{4}$/.test(iso)) {
    iso += '+03:00';
  }
  var instant = new Date(iso);
  if (isNaN(instant.getTime())) return null;
  return instant;
}

function toMskDate_(d) {
  var parts = Utilities.formatDate(d, TZ, 'yyyy-MM-dd-HH-mm-ss').split('-');
  return new Date(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2]),
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5])
  );
}

function calendarDateLocal_(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  var p = iso.split('-');
  var y = Number(p[0]);
  var m = Number(p[1]);
  var d = Number(p[2]);
  if (!y || !m || !d) return '';
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function calendarDateUtcNoon_(iso) {
  return calendarDateLocal_(iso);
}

function toSheetDate_(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'number' && isFinite(val) && val > 20000 && val < 120000) {
    return Math.floor(val + 0.0000001);
  }
  var iso = '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    iso = Utilities.formatDate(val, TZ, 'yyyy-MM-dd');
  } else {
    var t = String(val).trim();
    if (!t) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      iso = t;
    } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
      var instant = parseIsoInstant_(t);
      if (instant) iso = Utilities.formatDate(instant, TZ, 'yyyy-MM-dd');
    } else {
      var ru = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (ru) {
        var mm = ru[2].length === 1 ? '0' + ru[2] : ru[2];
        var dd = ru[1].length === 1 ? '0' + ru[1] : ru[1];
        iso = ru[3] + '-' + mm + '-' + dd;
      }
    }
  }
  return calendarDateLocal_(iso);
}

var FORMAT_AHEAD_ROWS_ = 4000;

function formatKeyCols_(sh, from, n, keys, startKeyIdx) {
  if (!sh || n < 1 || !keys) return;
  for (var i = startKeyIdx || 0; i < keys.length; i++) {
    var key = keys[i];
    if (!key) continue;
    try {
      if (DATE_ONLY_KEYS_[key] || isDateTimeKey_(key)) sh.getRange(from, i + 1, n, 1).setNumberFormat(DATE_FMT_);
      else if (ID_KEYS[key]) sh.getRange(from, i + 1, n, 1).setNumberFormat('@');
    } catch (e) {}
  }
}

function ensureFormatsAhead_(sh, startRow, numRows, keys, state) {
  if (!sh || numRows < 1 || !keys || !keys.length || !state) return;
  var needTo = startRow + numRows - 1;
  var keyCount = keys.length;
  if (state.keyCount && state.keyCount < keyCount) {
    formatKeyCols_(sh, startRow, numRows, keys, state.keyCount);
    state.keyCount = keyCount;
  }
  if (state.through >= needTo && state.keyCount >= keyCount) return;
  formatKeyCols_(sh, startRow, numRows, keys, 0);
  state.through = needTo;
  state.keyCount = keyCount;
}

function ensureColumnWidthsOnce_(sh, keys, state) {
  if (!sh || !keys || !state) return;
  var from = state.widthCount || 0;
  if (from >= keys.length) return;
  for (var i = from; i < keys.length; i++) {
    if (isSheetDateKey_(keys[i])) {
      try { sh.setColumnWidth(i + 1, 100); } catch (e) {}
    }
  }
  state.widthCount = keys.length;
}

function preformatDateTimeCols_(sheet, startRow, numRows, keys) {
  if (numRows < 1) return;
  formatKeyCols_(sheet, startRow, numRows, keys, 0);
  var dummy = { widthCount: 0 };
  ensureColumnWidthsOnce_(sheet, keys, dummy);
}

function formatDateColumns_(sheet, startRow, numRows, keys) {
  if (numRows < 1) return;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (isSheetDateKey_(key)) {
      try { sheet.getRange(startRow, i + 1, numRows, 1).setNumberFormat(DATE_FMT_); } catch (e) {}
    }
  }
}

function clearFilter_(sheet) {
  if (!sheet) return;
  try {
    var f = sheet.getFilter();
    if (f) f.remove();
  } catch (e) {}
}

function applyFilter_(sheet) {
  if (!sheet) return;
  clearFilter_(sheet);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  if (lastCol < 1) return;
  try {
    sheet.getRange(1, 1, lastRow, lastCol).createFilter();
  } catch (e) {}
}

function styleAllSheets() {
  var ss = activeSpreadsheet_();
  var sheets = ss.getSheets();
  var n = 0;
  for (var i = 0; i < sheets.length; i++) {
    if (isManualSheet_(sheets[i].getName())) continue;
    styleSheet_(sheets[i]);
    if (typeof ovPolishSheet_ === 'function') {
      try { ovPolishSheet_(sheets[i]); } catch (eP) {}
    }
    n++;
  }
  SpreadsheetApp.getUi().alert('Оформил ' + n + ' листов: Calibri 10, шапка #f1f1f1, фильтр.\nstart, info, sku, stock не трогал.');
}

function styleSheet_(sheet) {
  if (!sheet) return;
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var chunk = 5000;
  for (var r = 1; r <= lastRow; r += chunk) {
    var n = Math.min(chunk, lastRow - r + 1);
    sheet.getRange(r, 1, n, lastCol)
      .setFontFamily(STYLE_FONT_)
      .setFontSize(STYLE_SIZE_)
      .setFontColor('#000000')
      .setFontWeight('normal')
      .setBackground('#ffffff')
      .setVerticalAlignment('middle')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
  styleHeader_(sheet, lastCol);
  applyFilter_(sheet);
}

function styleHeader_(sheet, lastCol) {
  if (!sheet || lastCol < 1) return;
  sheet.getRange(1, 1, 1, lastCol)
    .setFontFamily(STYLE_FONT_)
    .setFontSize(STYLE_SIZE_)
    .setFontWeight('bold')
    .setFontColor('#000000')
    .setBackground(STYLE_HEADER_BG_)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 44);
}

function styleBodyChunked_(sheet, startRow, numRows, numCols, started) {
  if (!sheet || numRows < 1 || numCols < 1) return;
  var chunk = typeof SHEET_WRITE_CHUNK_ !== 'undefined' ? SHEET_WRITE_CHUNK_ : 1200;
  var done = 0;
  while (done < numRows) {
    if (done > 0 && started && overBudget_(started, 0)) return;
    var n = Math.min(chunk, numRows - done);
    styleBody_(sheet, startRow + done, n, numCols);
    done += n;
  }
}

/** Calibri на записанном диапазоне; для «тяжёлых» листов — кусками, finance (много колонок) не трогаем целиком. */
function finishStyleBody_(sh, fromRow, lastCol, started, heavy, numCols) {
  if (!sh || fromRow < 2 || sh.getLastRow() < fromRow || lastCol < 1) return;
  var numRows = sh.getLastRow() - fromRow + 1;
  if (numCols <= SHEET_HEAVY_COLS_) {
    styleBodyChunked_(sh, fromRow, numRows, lastCol, started);
    return;
  }
  if (!heavy || numRows <= 2000) styleBodyChunked_(sh, fromRow, numRows, lastCol, started);
}

function styleBody_(sheet, startRow, numRows, numCols) {
  if (!sheet || numRows < 1 || numCols < 1) return;
  sheet.getRange(startRow, 1, numRows, numCols)
    .setFontFamily(STYLE_FONT_)
    .setFontSize(STYLE_SIZE_)
    .setFontWeight('normal')
    .setFontColor('#000000')
    .setBackground('#ffffff')
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
}

function formatIdColumns_(sheet, startRow, numRows, keys) {
  if (numRows < 1) return;
  for (var i = 0; i < keys.length; i++) {
    if (!ID_KEYS[keys[i]]) continue;
    try { sheet.getRange(startRow, i + 1, numRows, 1).setNumberFormat('@'); } catch (e) {}
  }
}

function logLoadPhases_(ss, sheetName, delMs, deleted, fetchMs, writeMs, sortMs, rowsWritten, pages, offset) {
  if (delMs) log_(ss, sheetName, 'удаление', deleted || 0, 0, 0, '', delMs);
  if (fetchMs) log_(ss, sheetName, 'сеть', rowsWritten || 0, pages || 0, offset || 0, '', fetchMs);
  if (writeMs) log_(ss, sheetName, 'запись', rowsWritten || 0, pages || 0, offset || 0, '', writeMs);
  if (sortMs) log_(ss, sheetName, 'сортировка', rowsWritten || 0, 0, 0, '', sortMs);
}

function nowMsk_() {
  return Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm:ss');
}

function dateBounds_(row, dateCol) {
  if (!row || !dateCol) return '';
  var extra = row.extra && typeof row.extra === 'object' && !(row.extra instanceof Array) ? row.extra : {};
  var val = row[dateCol];
  if (val === undefined || val === null || val === '') val = extra[dateCol];
  if (val === undefined || val === null || val === '') return '';
  if (Object.prototype.toString.call(val) === '[object Date]') {
    return Utilities.formatDate(val, TZ, 'yyyy-MM-dd');
  }
  var t = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  var instant = parseIsoInstant_(t);
  if (instant) return Utilities.formatDate(instant, TZ, 'yyyy-MM-dd');
  if (t.length >= 10 && t.charAt(4) === '-') return t.substring(0, 10);
  return '';
}

function isoToRu_(iso) {
  if (!iso) return '';
  var s = String(iso);
  if (s.length >= 10 && s.charAt(4) === '-') {
    return s.substring(8, 10) + '.' + s.substring(5, 7) + '.' + s.substring(0, 4);
  }
  return s;
}

function periodLabel_(job, minIso, maxIso) {
  if (job.dateCol === 'snapshot_date') {
    return maxIso ? ('на ' + isoToRu_(maxIso)) : '';
  }
  if (!job.dateCol) {
    return maxIso ? ('на ' + isoToRu_(maxIso)) : '';
  }
  var from = minIso || '';
  var to = maxIso || '';
  if (from && to && from === to) return 'на ' + isoToRu_(from);
  if (from && to) return 'с ' + isoToRu_(from) + ' по ' + isoToRu_(to);
  if (to) return 'на ' + isoToRu_(to);
  if (from) return 'с ' + isoToRu_(from);
  return '';
}

function writeSettingsMeta_(ss, sheetName, period, updated) {
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var want = String(sheetName || '').trim().toLowerCase();
  for (var i = 0; i < names.length; i++) {
    if (String(names[i][0] || '').trim().toLowerCase() !== want) continue;
    sh.getRange(i + 2, 10).setNumberFormat('@').setValue(period || '');
    sh.getRange(i + 2, 11).setNumberFormat('@').setValue(updated || '');
    try {
      if (typeof startTouchSheetStatus_ === 'function') startTouchSheetStatus_(ss, sheetName);
    } catch (eStart) { Logger.log('startTouchSheetStatus_: ' + eStart); }
    return;
  }
}

function log_(ss, sheetName, status, rows, pages, offset, error, ms) {
  var t = nowMsk_();
  var sec = Math.round((Number(ms) || 0) / 100) / 10;
  var row = [t, sheetName, status, rows, pages, offset, error || '', ms, sec];
  var attempt;
  for (attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt) {
        Utilities.sleep(900 * attempt);
        SS_CACHE_ = null;
        LOG_SHEET_READY_ = false;
        ss = activeSpreadsheet_();
      } else if (!ss) {
        ss = activeSpreadsheet_();
      }
      try { SpreadsheetApp.flush(); } catch (eF) {}
      var sh = ss.getSheetByName(LOG_SHEET);
      if (!sh) sh = ensureLogSheet_(ss);
      if (!sh) continue;
      var last = Math.max(sh.getLastRow() + 1, 2);
      var rng = sh.getRange(last, 1, 1, LOG_HEADER_.length);
      rng.setValues([row]);
      styleBody_(sh, last, 1, LOG_HEADER_.length);
      rng.getCell(1, LOG_SEK_COL_).setNumberFormat('0.0');
      return;
    } catch (e) {}
  }
}
