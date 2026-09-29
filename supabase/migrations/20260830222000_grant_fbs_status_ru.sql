-- Views sheet_fbs* are queried as anon; translator functions were revoke-all from public.

grant execute on function private.fbs_wb_status_ru(text) to anon, authenticated;
grant execute on function private.fbs_supplier_status_ru(text) to anon, authenticated;
grant execute on function private.fbs_extra_rub(jsonb) to anon, authenticated;
grant execute on function private.wb_kop_rub(text) to anon, authenticated;

notify pgrst, 'reload schema';
