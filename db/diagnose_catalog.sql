-- DIAGNÓSTICO DE SÓLO LECTURA. No es una migración.
-- Ejecutar en SQL Editor del proyecto Supabase correcto con acceso autorizado.
-- Los conteos excluidos se pueden solapar: no deben sumarse.
begin transaction read only;

select
  count(*) as total_restaurants,
  count(*) filter (where r.approved) as approved,
  count(*) filter (where r.published) as published,
  count(*) filter (where not r.approved) as excluded_not_approved,
  count(*) filter (where not r.published) as excluded_not_published,
  count(*) filter (where not exists (
    select 1 from public.subscriptions s where s.restaurant_id=r.id
    and s.status='active' and (s.renews_at is null or s.renews_at>statement_timestamp())
  )) as excluded_no_current_subscription,
  count(*) filter (where r.requires_card_guarantee) as requires_card_guarantee,
  count(*) filter (where r.approved and r.published and exists (
    select 1 from public.subscriptions s where s.restaurant_id=r.id
    and s.status='active' and (s.renews_at is null or s.renews_at>statement_timestamp())
  )) as eligible_using_main_filters,
  count(*) filter (where r.approved and r.published and not r.requires_card_guarantee and exists (
    select 1 from public.subscriptions s where s.restaurant_id=r.id
    and s.status='active' and (s.renews_at is null or s.renews_at>statement_timestamp())
  )) as eligible_using_local_branch_filters
from public.restaurants r;

-- Cuenta lo que devuelve la función realmente instalada, que puede diferir del Git actual.
select count(*) as installed_rpc_catalog_count from public.list_bookable_restaurants();

-- Metadatos para comprobar la variante sin exponer correos ni contactos.
select p.proname as function_name,
  md5(pg_get_functiondef(p.oid)) as installed_definition_fingerprint,
  position('requires_card_guarantee' in pg_get_functiondef(p.oid))>0 as definition_mentions_card_guarantee,
  position('subscriptions' in pg_get_functiondef(p.oid))>0 as definition_mentions_subscriptions
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='list_bookable_restaurants' and p.pronargs=0;

rollback;
