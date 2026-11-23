-- Run in the approved test database after each import.
-- Compare both fingerprints before and after re-importing the same SQL file.
begin read only;

-- Expect 386 IDs, generations 151/100/135, types 215 single/171 dual, and zero Fairy.
select count(*) as total,
       count(distinct id) as unique_ids,
       min(id) as first_id,
       max(id) as last_id,
       count(*) filter (where generation = 1) as generation_1,
       count(*) filter (where generation = 2) as generation_2,
       count(*) filter (where generation = 3) as generation_3,
       count(*) filter (where type_secondary is null) as single_type,
       count(*) filter (where type_secondary is not null) as dual_type,
       count(*) filter (where 'fairy' in (type_primary, type_secondary)) as fairy_count,
       md5(string_agg(to_jsonb(catalog)::text, E'\n' order by id)) as data_fingerprint,
       md5(string_agg(id::text || ':' || xmin::text, ',' order by id)) as row_version_fingerprint
from public.pokemon_catalog as catalog;

-- Expect six rows, with all name_matches values true.
select expected.id, expected.name_de as expected_name, catalog.name_de,
       catalog.name_de is not distinct from expected.name_de as name_matches
from (values (1, 'Bisasam'), (4, 'Glumanda'), (5, 'Glutexo'),
             (6, 'Glurak'), (7, 'Schiggy'), (25, 'Pikachu')) as expected(id, name_de)
left join public.pokemon_catalog as catalog using (id)
order by expected.id;

-- Expect eight rows, with all types_match values true.
select expected.id, catalog.name_de, catalog.type_primary, catalog.type_secondary,
       (catalog.type_primary, catalog.type_secondary)
           is not distinct from (expected.type_primary, expected.type_secondary) as types_match
from (values (1, 'grass', 'poison'), (4, 'fire', null), (6, 'fire', 'flying'),
             (25, 'electric', null), (35, 'normal', null), (82, 'electric', 'steel'),
             (282, 'psychic', null), (303, 'steel', null)) as expected(id, type_primary, type_secondary)
left join public.pokemon_catalog as catalog using (id)
order by expected.id;

-- Expect RLS enabled and exactly one SELECT policy for authenticated.
select relrowsecurity as rls_enabled
from pg_catalog.pg_class
where oid = 'public.pokemon_catalog'::regclass;

select policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public' and tablename = 'pokemon_catalog';

-- Expect only authenticated to have SELECT, and neither role to have write rights.
-- The privilege functions include inherited and column-level grants.
select rolname, rolsuper, rolbypassrls,
       has_schema_privilege(oid, 'public', 'USAGE') as schema_usage,
       has_table_privilege(oid, 'public.pokemon_catalog', 'SELECT') as table_select,
       has_any_column_privilege(oid, 'public.pokemon_catalog', 'SELECT') as any_column_select,
       has_any_column_privilege(oid, 'public.pokemon_catalog', 'INSERT') as can_insert,
       has_any_column_privilege(oid, 'public.pokemon_catalog', 'UPDATE') as can_update,
       has_table_privilege(oid, 'public.pokemon_catalog', 'DELETE') as can_delete,
       has_table_privilege(oid, 'public.pokemon_catalog', 'TRUNCATE') as can_truncate
from pg_catalog.pg_roles
where rolname in ('anon', 'authenticated')
order by rolname;

-- Requires permission to assume authenticated. Expect 386 rows and active RLS.
set local role authenticated;
select count(*) as visible_rows,
       row_security_active('public.pokemon_catalog'::regclass) as rls_active
from public.pokemon_catalog;

rollback;
