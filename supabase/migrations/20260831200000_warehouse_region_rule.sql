-- Регион поставки: город в имени → регион. Утро не перезаписывает заполненное.
-- Заменяет лист «Регион поставки». Имена в фактах не трогаем.

create table if not exists public.warehouse_region_rule (
  city_norm text primary key,
  region text not null
);

comment on table public.warehouse_region_rule is
  'Город в имени склада (после warehouse_norm) → регион поставки. Утро подставляет, не перезаписывает.';

insert into public.warehouse_region_rule (city_norm, region) values
  ('коледино', 'Центральный'),
  ('электросталь', 'Центральный'),
  ('ногинск', 'Центральный'),
  ('пушкино', 'Центральный'),
  ('истра', 'Центральный'),
  ('радумля', 'Центральный'),
  ('вешки', 'Центральный'),
  ('белая дача', 'Центральный'),
  ('тула', 'Центральный'),
  ('твер', 'Центральный'),
  ('рязань', 'Центральный'),
  ('владимир', 'Центральный'),
  ('воронеж', 'Центральный'),
  ('котовск', 'Центральный'),
  ('москва', 'Центральный'),
  ('внуково', 'Центральный'),
  ('домодедово', 'Центральный'),
  ('сынково', 'Центральный'),
  ('софьино', 'Центральный'),
  ('ярославль', 'Центральный'),
  ('курск', 'Центральный'),
  ('скотопрогонная', 'Центральный'),
  ('шушары', 'Северо-Западный'),
  ('санкт-петербург', 'Северо-Западный'),
  ('петербург', 'Северо-Западный'),
  ('спб', 'Северо-Западный'),
  ('калининград', 'Северо-Западный'),
  ('архангельск', 'Северо-Западный'),
  ('вологда', 'Северо-Западный'),
  ('красный бор', 'Северо-Западный'),
  ('московское шоссе', 'Северо-Западный'),
  ('казань', 'Приволжский'),
  ('новосемейкино', 'Приволжский'),
  ('самара', 'Приволжский'),
  ('сарапул', 'Приволжский'),
  ('пенза', 'Приволжский'),
  ('ульяновск', 'Приволжский'),
  ('нижний новгород', 'Приволжский'),
  ('кудьма', 'Приволжский'),
  ('киров', 'Приволжский'),
  ('саранск', 'Приволжский'),
  ('краснодар', 'Южный и Северо-Кавказский'),
  ('тихорецк', 'Южный и Северо-Кавказский'),
  ('невинномысск', 'Южный и Северо-Кавказский'),
  ('крыловская', 'Южный и Северо-Кавказский'),
  ('тахтамукай', 'Южный и Северо-Кавказский'),
  ('волгоград', 'Южный и Северо-Кавказский'),
  ('екатеринбург', 'Уральский'),
  ('челябинск', 'Уральский'),
  ('тюмень', 'Уральский'),
  ('нижний тагил', 'Уральский'),
  ('сургут', 'Уральский'),
  ('перспективная', 'Уральский'),
  ('новосибирск', 'Дальневосточный и Сибирский'),
  ('красноярск', 'Дальневосточный и Сибирский'),
  ('омск', 'Дальневосточный и Сибирский'),
  ('барнаул', 'Дальневосточный и Сибирский'),
  ('кемерово', 'Дальневосточный и Сибирский'),
  ('томск', 'Дальневосточный и Сибирский'),
  ('абакан', 'Дальневосточный и Сибирский'),
  ('владивосток', 'Дальневосточный и Сибирский'),
  ('братск', 'Дальневосточный и Сибирский'),
  ('улан-удэ', 'Дальневосточный и Сибирский'),
  ('хабаровск', 'Дальневосточный и Сибирский'),
  ('минск', 'Беларусь'),
  ('бобруйск', 'Беларусь'),
  ('орша', 'Беларусь'),
  ('брест', 'Беларусь'),
  ('гомель', 'Беларусь'),
  ('гродно', 'Беларусь'),
  ('хатежино', 'Беларусь'),
  ('астана', 'Казахстан'),
  ('алматы', 'Казахстан'),
  ('актобе', 'Казахстан'),
  ('карагандинское', 'Казахстан'),
  ('ереван', 'Армения'),
  ('wb', 'Склад WB'),
  ('федеральный округ', 'Центральный')
on conflict (city_norm) do update set region = excluded.region;

alter table public.warehouse_region_rule enable row level security;
revoke all on table public.warehouse_region_rule from anon, authenticated;
drop policy if exists deny_anon_authenticated on public.warehouse_region_rule;
create policy deny_anon_authenticated on public.warehouse_region_rule
  for all to anon, authenticated using (false) with check (false);

create or replace function public.warehouse_region_guess(p_alias text, p_canonical text)
returns text
language sql
stable
parallel safe
set search_path = public
as $$
  select rr.region
  from public.warehouse_region_rule rr
  where position(rr.city_norm in public.warehouse_norm(p_canonical)) > 0
     or position(rr.city_norm in public.warehouse_norm(p_alias)) > 0
     or position(rr.city_norm in lower(translate(btrim(coalesce(p_canonical, '')), 'Ёё', 'Ее'))) > 0
     or position(rr.city_norm in lower(translate(btrim(coalesce(p_alias, '')), 'Ёё', 'Ее'))) > 0
  order by length(rr.city_norm) desc
  limit 1;
$$;

revoke all on function public.warehouse_region_guess(text, text) from public, anon, authenticated;
grant execute on function public.warehouse_region_guess(text, text) to service_role;

create or replace function public.warehouse_dict_fill_region()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.region is null then
    new.region := public.warehouse_region_guess(new.alias, new.canonical);
  end if;
  return new;
end;
$$;

drop trigger if exists warehouse_dict_fill_region_trg on public.warehouse_dict;
create trigger warehouse_dict_fill_region_trg
before insert or update of alias, canonical, region on public.warehouse_dict
for each row execute function public.warehouse_dict_fill_region();

revoke all on function public.warehouse_dict_fill_region() from public, anon, authenticated;

update public.warehouse_dict d
set region = public.warehouse_region_guess(d.alias, d.canonical),
    updated_at = now()
where d.region is null
  and public.warehouse_region_guess(d.alias, d.canonical) is not null;

update public.warehouse_dict d
set region = s.region, updated_at = now()
from (
  select seller_id, canonical, min(region) as region
  from public.warehouse_dict
  where region is not null
  group by 1, 2
) s
where d.seller_id = s.seller_id
  and d.canonical = s.canonical
  and d.region is null;
