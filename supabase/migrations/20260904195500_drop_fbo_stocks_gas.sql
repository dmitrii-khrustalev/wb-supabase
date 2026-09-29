-- Удаление staging-таблицы импорта остатков из Google-листа (заменено daily API: stocks_lk).

drop function if exists public.import_fbo_stocks_gas(text);
drop function if exists public.parse_sheet_date(text);
drop function if exists public.parse_sheet_num(text);
drop table if exists public.fbo_stocks_gas;
