-- Вернуть историю fbo_stocks из клона бэкапа (не откатывать прод целиком).
--
-- Что пропало: ~49 653 строк с snapshot_date < 2026-07-27
-- (trim_stock_snapshots 10 сен 2026 ~20:28 Самара).
-- Нужный бэкап: 2026-09-09 22:23 UTC (id 1627650378) — ДО удаления.
--
-- 1. Dashboard → Orders API → Database → Backups → Restore to a new project
--    Выбрать бэкап 9 сен 22:23 UTC. НЕ жать Restore на сам прод.
-- 2. На клоне сразу выключить cron / Edge Functions / Database Webhooks,
--    чтобы он ничего не грузил и не слал в Telegram.
-- 3. Подставить хост клона и пароль postgres клона ниже.
-- 4. Выполнить этот файл на ПРОДЕ (Orders API).
-- 5. После проверки — Pause или Delete клон, чтобы не платить.

create extension if not exists postgres_fdw;

-- Если уже пробовали: снять старый FDW
drop foreign table if exists restore_tmp.fbo_stocks;
drop schema if exists restore_tmp cascade;
drop user mapping if exists for current_user server fbo_stocks_backup;
drop server if exists fbo_stocks_backup cascade;

create server fbo_stocks_backup
foreign data wrapper postgres_fdw
options (
  host 'db.<CLONE_PROJECT_REF>.supabase.co',
  port '5432',
  dbname 'postgres'
);

create user mapping for current_user
server fbo_stocks_backup
options (
  user 'postgres',
  password '<CLONE_DB_PASSWORD>'
);

create schema restore_tmp;

import foreign schema public
limit to (fbo_stocks)
from server fbo_stocks_backup
into restore_tmp;

-- Сверка: на клоне должны быть даты раньше 2026-07-27
select
  'clone' as src,
  min(snapshot_date) as min_d,
  max(snapshot_date) as max_d,
  count(*) as rows
from restore_tmp.fbo_stocks
union all
select
  'prod',
  min(snapshot_date),
  max(snapshot_date),
  count(*)
from public.fbo_stocks;

insert into public.fbo_stocks (
  seller_id, snapshot_date, nm_id, warehouse_name,
  quantity, extra, payload, loaded_at
)
select
  seller_id, snapshot_date, nm_id, warehouse_name,
  quantity, extra, payload, loaded_at
from restore_tmp.fbo_stocks
where snapshot_date < date '2026-07-27'
on conflict do nothing;

-- После вставки min_d должен уйти раньше 2026-07-27
select
  min(snapshot_date) as min_d,
  max(snapshot_date) as max_d,
  count(*) as rows,
  count(*) filter (where snapshot_date < date '2026-07-27') as restored_old
from public.fbo_stocks;

-- Убрать FDW, чтобы прод не держал связь с клоном
drop foreign table if exists restore_tmp.fbo_stocks;
drop schema if exists restore_tmp cascade;
drop user mapping if exists for current_user server fbo_stocks_backup;
drop server if exists fbo_stocks_backup cascade;
