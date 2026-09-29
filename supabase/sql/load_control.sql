-- Пульт загрузок. Запускать по одному в SQL Editor.

-- Проверить свежесть
select * from public.load_health();

-- Повторить ошибки daily
-- select public.retry_failed_jobs();

-- Загрузить один кусок, например финансы
-- select public.enqueue_dataset('finance');

-- Daily как в 05:00
-- select public.enqueue_daily_jobs();
