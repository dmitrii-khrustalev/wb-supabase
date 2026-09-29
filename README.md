# WB → Postgres

Загрузчик Wildberries API в Postgres. Ноутбук не нужен: `pg_cron` каждую минуту вызывает Edge Function, которая забирает **один батч** из WB и пишет в базу.

Несколько кабинетов — одна база, колонка `seller_id`. Google Sheets на этом этапе не трогаем.

## Что уже есть

- Таблицы сырых выгрузок (аналитика + FBS) с полным `payload jsonb`
- Очередь `sync_jobs` и курсоры `sync_state`
- Edge Functions: `sync-tick`, `enqueue-daily`, `enqueue-history`
- Cron: ежедневно 05:00 МСК ставит daily-джобы; каждую минуту тик их доедает

## Один раз: создать проект

1. Создай облачный проект Postgres.
2. Установи CLI (`npx supabase --help`).
3. В корне этого репозитория:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase functions deploy
```

4. Dashboard → Project Settings → API: скопируй URL и `service_role`.
5. SQL Editor — подставь свои значения и выполни:

```sql
-- URL проекта и service_role для вызова Edge Function из cron
select public.setup_wb_cron(
  'https://YOUR_PROJECT_REF.supabase.co',
  'YOUR_SERVICE_ROLE_KEY'
);

-- Первый селлер. slug = main → секрет wb_token_main
insert into public.sellers (name, slug, history_from)
values ('Основной кабинет', 'main', '2026-03-01')
on conflict (slug) do nothing;

select vault.create_secret('WB_API_TOKEN_HERE', 'wb_token_main');
```

Либо токен через CLI (имя = `WB_TOKEN_` + slug в верхнем регистре):

```bash
npx supabase secrets set WB_TOKEN_MAIN=WB_API_TOKEN_HERE
```

6. Запусти историю:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/enqueue-history" ^
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{\"slug\":\"main\"}"
```

Минутный cron сам разгребёт очередь.

Прогресс в SQL Editor:

```sql
select dataset, mode, status, error, updated_at from public.sync_jobs order by created_at;
select dataset, rows_upserted, error, note, started_at from public.load_runs order by started_at desc limit 50;
select * from cron.job;
```

## Второй селлер

Та же база, не новый проект:

```sql
insert into public.sellers (name, slug, history_from)
values ('Второй кабинет', 'second', '2026-03-01');

select vault.create_secret('WB_TOKEN_SECOND_CABINET', 'wb_token_second');
```

```bash
npx supabase secrets set WB_TOKEN_SECOND=WB_TOKEN_SECOND_CABINET
```

Затем `enqueue-history` с `"slug":"second"`. Daily-крону подхватятся все `is_active = true`.

## Расписания

| Cron (UTC) | МСК | Что делает |
|---|---|---|
| `* * * * *` | каждую минуту | `sync-tick` — один батч WB |
| `0 2 * * *` | 05:00 | `enqueue_daily_jobs()` — 11 датасетов |
| `0 6 * * *` | 09:00 | `notify-digest` — в Telegram только если ночная выгрузка с ошибками |

Daily берёт вчера + небольшой lookback (финансы/реклама 7 дней, FBO-заказы 3 дня), upsert по ключу. Остатки — снимок на сегодня. Статусы FBS обновляются за последние 30 дней.

Первый прогон не ждать до 05:00 — в SQL Editor:

```sql
select public.enqueue_daily_jobs();
```

Прогресс: `supabase/sql/daily_check.sql`.

## Telegram

Клавиатура внизу чата: **Цифры · Обновить всё · Один блок · Отменить**. Списка команд слева нет; `/start` один раз ставит кнопки.

«Цифры» и утро — блоки как на info daily (финансы, реклама, заказы, остатки, поставки), процент только к вчера, заголовки жирные. Когда ночные daily-джобы закрылись, `sync-tick` шлёт одно сообщение: эти цифры + строка «✅ База 11/11» (или ❌ по блокам). `notify-digest` в 09:00 пишет только если ночью были ошибки.

**Обновить всё** / **Один блок** ставят джобы в базу (`enqueue_daily_jobs` / `enqueue_dataset`) и заявку `request_bot_load`. Сразу: «база в очереди. Напишу, когда будет готово.» Когда джобы done — «✅ База обновила… Загрузите лист в Google.» Книга из бота сама не заливается: после этого сообщения загрузите лист в Google (или «Загрузить всё»). Утро 05:05 в книге — отдельный триггер, не из чата.

После того как бот отвечает на тестовую ссылку `sendMessage`:

```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN=123:AAAxxx TELEGRAM_CHAT_ID=555666777
npx supabase functions deploy telegram-bot
npx supabase functions deploy sync-tick
npx supabase functions deploy notify-digest
npx supabase db push
```

Потом в SQL Editor снова вызови `setup_wb_cron` с тем же URL проекта и `service_role`, что уже ставил. Появится cron на 09:00 МСК.

Проверка сразу, не ждать утра (подставь свой URL и service_role):

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-digest" ^
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" ^
  -H "Content-Type: application/json" ^
  -d "{}"
```

Если ошибок нет — в чат ничего не придёт. Если есть — сводка за сутки.

Включить webhook (подставь URL и service_role):

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-bot?setup=1" ^
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

В чате: `/start` один раз, чтобы Telegram поставил новую клавиатуру. Дальше только кнопки внизу.

Free-план засыпает после 7 дней без активности. Ежедневный тик обычно держит проект живым. Для гарантии — Pro.

## Датасеты

`products`, `finance`, `adv_stats`, `fbo_orders`, `fbo_stocks`, `stocks_lk`, `fbw_supplies`, `fbs_warehouses`, `fbs_offices`, `fbs_stocks`, `fbs_orders`, `fbs_supplies`, `sales_funnel`.

`sales_funnel` — воронка по дням (`products/history`): история с 2026-03-25, daily — вчера и позавчера. Нужен каталог `products` и токен с правами «Аналитика». Окна по 7 дней, до 20 артикулов за запрос, 2 запроса за тик.

`stocks_lk` — остатки как в ЛК (`warehouse_remains` → таблица `fbo_stocks_lk`), **только daily** (снимок на сегодня). Отдельно от `fbo_stocks` (JSON `wb-warehouses`). Токен «Аналитика», ~1 отчёт/мин.

Склады WB и транзитные тарифы не грузим (API 404).

`fbo_stocks` — снимок analytics `wb-warehouses` (другие названия складов). Картинки QR/стикеров не пишем.

## Этап 2: тестовый Google Sheets из базы

Боевые скрипты `01`–`08` не трогаем, пока тест не совпадёт.

1. `npx supabase db push` — views `sheet_*` без `payload`, SELECT для `anon`.
2. Новый пустой Google-файл → Apps Script → скопировать [`gas/01_sheet_from_supabase.js`](gas/01_sheet_from_supabase.js). Этому кабинету — вторым файлом [`gas/02_sheet_client_overlay.js`](gas/02_sheet_client_overlay.js) (вес и регион после загрузки).
3. Меню **Данные WB → Ключ базы**: **anon JWT** (`eyJ…`), не `service_role`.
4. **Создать настройки**. На `_Настройки` оставь «да» у одного листа (сначала «Рекламные_расходы» или «Заказы»).
5. **Проверить связь**, затем **Загрузить всё**. Если упрётся в 6 минут — запусти ещё раз (продолжит с паузы).
6. Сверка: [`supabase/sql/sheet_check.sql`](supabase/sql/sheet_check.sql). Count на листе = count во view за то же окно, **без** фильтров боевого GAS.

`_Настройки`: дни / вкл / кабинет. `_Колонки`: русские шапки (пустой перевод → ключ как есть). Отчёты `02`/`03`/`08` и выключение WB в боевом GAS — после совпадения сырья.
