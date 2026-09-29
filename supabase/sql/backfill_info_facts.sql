-- Разовый полный проход словаря складов (если утро на 7 днях пропустило имя).
-- select public.warehouse_dict_refresh_days(id, null) from public.sellers where is_active;

-- Догнать факты дальше 90 дней (monthly). sync-tick сам держит ~16 / 90 дней.
-- select public.refresh_info_facts(id, current_date - 180, current_date)
-- from public.sellers where is_active;
