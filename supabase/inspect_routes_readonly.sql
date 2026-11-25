-- Supabase SQL Editor: Block 1 ausführen und prüfen, danach Block 2 separat ausführen.
-- Block 2 setzt die unten genannten lokalen Tabellen und Spaltentypen voraus.
-- Mit der SQL-Editor-Rolle ausführen, die sämtliche Zeilen sehen darf.
-- Routenschlüssel können frei erfassten Text enthalten. Rohwerte im SQL Editor belassen.

-- 1. Installierte Struktur, Rechte und Teamlogik.
with expected(schema_name, table_name) as (
    values ('public', 'runs'), ('public', 'catches'), ('public', 'run_team_slots'),
           ('soul_link_team_private', 'initialized'), ('soul_link_team_private', 'exclusions')
), relations as (
    select e.schema_name || '.' || e.table_name as name, c.oid, c.relkind,
           c.relrowsecurity, c.relforcerowsecurity
    from expected e
    left join pg_catalog.pg_namespace n on n.nspname = e.schema_name
    left join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = e.table_name
), report(section, object_name, details) as (
    select '01 table', r.name, jsonb_build_object(
        'exists', r.oid is not null, 'kind', r.relkind, 'rls', r.relrowsecurity,
        'rls_forced', r.relforcerowsecurity, 'rls_active_for_editor', row_security_active(r.oid::regclass),
        'authenticated_select', has_table_privilege('authenticated', r.oid, 'SELECT'),
        'anon_select', has_table_privilege('anon', r.oid, 'SELECT'))
    from relations r
    union all
    select '02 column', r.name || '.' || a.attname, jsonb_build_object(
        'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
        'collation', col.collname, 'has_default', a.atthasdef, 'identity', a.attidentity)
    from relations r
    join pg_catalog.pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_catalog.pg_collation col on col.oid = a.attcollation
    union all
    select '03 constraint', r.name || '.' || c.conname, jsonb_build_object(
        'type', c.contype, 'validated', c.convalidated, 'definition', pg_get_constraintdef(c.oid))
    from relations r join pg_catalog.pg_constraint c on c.conrelid = r.oid
    union all
    select '04 unique index', r.name || '.' || ix.relname, jsonb_build_object(
        'valid', i.indisvalid, 'definition', pg_get_indexdef(i.indexrelid))
    from relations r
    join pg_catalog.pg_index i on i.indrelid = r.oid and i.indisunique
    join pg_catalog.pg_class ix on ix.oid = i.indexrelid
    union all
    select '05 trigger', r.name || '.' || t.tgname, jsonb_build_object(
        'mode', case t.tgenabled when 'O' then 'origin' when 'D' then 'disabled'
                                when 'R' then 'replica' when 'A' then 'always' end,
        'definition', pg_get_triggerdef(t.oid))
    from relations r join pg_catalog.pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal
    union all
    select '06 policy', p.schemaname || '.' || p.tablename || '.' || p.policyname, jsonb_build_object(
        'command', p.cmd, 'roles', p.roles, 'mode', p.permissive,
        'using_kind', case when p.qual is null then 'none'
                           when p.qual in ('true', 'false') then p.qual else 'conditional' end,
        'check_kind', case when p.with_check is null then 'none'
                           when p.with_check in ('true', 'false') then p.with_check else 'conditional' end)
    from pg_catalog.pg_policies p
    join expected e on e.schema_name = p.schemaname and e.table_name = p.tablename
    union all
    select '07 team routine', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           jsonb_build_object('returns', pg_get_function_result(p.oid), 'security_definer', p.prosecdef,
               'has_fixed_search_path', coalesce(p.proconfig::text like '%search_path=%', false),
               'authenticated_schema_usage', has_schema_privilege('authenticated', n.oid, 'USAGE'),
               'anon_schema_usage', has_schema_privilege('anon', n.oid, 'USAGE'),
               'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
               'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
               'definition_md5', md5(pg_get_functiondef(p.oid)))
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p') and (n.nspname = 'soul_link_team_private'
        or (n.nspname = 'public' and p.proname = 'soul_link_team'))
)
select section, object_name, details from report order by section, object_name;

-- 2. Nur starten, wenn alle fünf Relationen gewöhnliche Tabellen (kind = r)
-- sind und rls_active_for_editor überall false ist. runs.id und die run_id-Spalten
-- müssen vergleichbare Typen haben. is_finished muss boolean sein. Routenschlüssel
-- müssen text/varchar sein, catches.player_name und catches.status text/varchar oder Enum.
-- Die 58 Ausgangswerte stehen in derselben Reihenfolge wie KANTO_ROUTES in index.html.
with seed as (
    select route_key collate "C" as route_key, position as seed_position
    from unnest(array[
        'Alabastia/ Starter', 'Route 1', 'Route 22', 'Route 2', 'Vertania-Wald', 'Karpador Buy',
        'Route 3', 'Route 4', 'Mondberg', 'Azuria City', 'Route 24', 'Route 25', 'Route 5',
        'Route 6', 'Orania City', 'Route 11', 'Alabastia', 'Vertania City', 'Ms Anne', 'Digdas Höhle',
        'Route 9', 'Route 10', 'Felstunnel', 'Route 8', 'Route 7', 'Prismania City', 'Evoli Tower',
        'Casino Abra (180)', 'Casino Piepi (500)', 'Pokémon-Turm (Lavandia)', 'Route 16',
        'Route 17 (Radweg)', 'Route 18', 'Fuchsania City', 'Safari-Zone', 'Route 12', 'Route 13',
        'Route 14', 'Route 15', 'Kraftwerk', 'Route 19', 'Route 20', 'Seeschauminseln',
        'Zinnoberinsel', 'Pokémon-Villa', 'Eiland Eins (Schatzstrand/Glutherme)', 'Glutberg',
        'Eiland Zwei (Kap Kante)', 'Eiland Drei (Bundbrücke)', 'Beerenforst', 'Route 21',
        'Route 23', 'Siegesstraße', 'Eiland Vier (Eiskaskadenhöhle)',
        'Eiland Fünf (Verlorene Höhle/Weide)', 'Eiland Sechs (Musterbusch/Ruintal)',
        'Eiland Sieben (Schlucht/Tanoby-Ruinen)', 'Geheimdungeon (Azuria-Höhle)'
    ]::text[]) with ordinality as listed(route_key, position)
), catch_rows as (
    select c.run_id, c.route_name::text collate "C" as route_key,
           c.player_name::text collate "C" as player, c.status::text collate "C" as status,
           r.id is null as orphaned, r.id is not null and r.is_finished is not true as open_run
    from only public.catches c left join only public.runs r on r.id = c.run_id
), player_groups as (
    select run_id, route_key, player, count(*) as catches,
           count(*) filter (where status = 'ALIVE') as alive,
           count(*) filter (where orphaned) as orphans, bool_or(open_run) as open_run
    from catch_rows
    group by run_id, route_key, player
), catch_totals as (
    select route_key, sum(catches)::bigint as catches, sum(orphans)::bigint as orphan_catches,
           count(*) filter (where catches > 1) as duplicate_groups,
           count(*) filter (where catches > 1 and open_run) as open_duplicate_groups,
           sum(catches - 1)::bigint as extra_catches
    from player_groups group by route_key
), run_route_catches as (
    select run_id, route_key,
           count(*) filter (where player in ('Higa', 'Eike', 'Ruffy') and catches = 1 and alive = 1) = 3
           and sum(catches) filter (where player in ('Higa', 'Eike', 'Ruffy')) = 3
           and btrim(route_key) <> '' as team_eligible
    from player_groups group by run_id, route_key
), exclusions as (
    select run_id, route_name::text collate "C" as route_key
    from only soul_link_team_private.exclusions
), exclusion_totals as (
    select route_key, count(*) as exclusions from exclusions group by route_key
), slot_totals as (
    select s.route_name::text collate "C" as route_key, count(*) as slots,
           count(*) filter (where i.run_id is null) as slots_in_uninitialized_runs,
           count(*) filter (where c.run_id is null) as slots_without_catches,
           count(*) filter (where r.id is not null and r.is_finished is not true
                            and c.team_eligible is not true) as ineligible_open_slots,
           count(*) filter (where exists (
               select 1 from exclusions e where e.run_id = s.run_id
                   and e.route_key = s.route_name::text collate "C"
           )) as slots_also_excluded
    from only public.run_team_slots s
    left join only public.runs r on r.id = s.run_id
    left join only soul_link_team_private.initialized i on i.run_id = s.run_id
    left join run_route_catches c on c.run_id = s.run_id and c.route_key = s.route_name::text collate "C"
    group by s.route_name::text collate "C"
), keys as (
    select route_key from seed
    union select route_key from catch_totals
    union select route_key from slot_totals
    union select route_key from exclusion_totals
), normalized as (
    -- Nur Suchhilfe. Gruppierung und Zuordnung oben bleiben exakt (Collation C).
    select route_key, regexp_replace(lower(route_key collate "default"), '[^[:alnum:]]+', '', 'g')
        collate "C" as hint_key
    from keys
)
select case
           when k.route_key is null then 'null'
           when k.route_key ~ '^[[:space:]]*$' then 'blank'
           when s.seed_position is not null and c.catches is null
                and t.slots is null and x.exclusions is null then 'seed_unused'
           when s.seed_position is not null then 'exact'
           when cardinality(h.similar_keys) > 0 then 'possible_variant'
           else 'unknown'
       end as match_kind,
       k.route_key, char_length(k.route_key) as key_length, s.seed_position,
       h.similar_keys as review_only_similar_keys,
       coalesce(c.catches, 0) as catches, coalesce(c.orphan_catches, 0) as orphan_catches,
       coalesce(c.duplicate_groups, 0) as duplicate_groups,
       coalesce(c.open_duplicate_groups, 0) as open_duplicate_groups,
       coalesce(c.extra_catches, 0) as extra_catches,
       coalesce(t.slots, 0) as team_slots,
       coalesce(t.slots_in_uninitialized_runs, 0) as slots_in_uninitialized_runs,
       coalesce(t.slots_without_catches, 0) as slots_without_catches,
       coalesce(t.ineligible_open_slots, 0) as ineligible_open_slots,
       coalesce(t.slots_also_excluded, 0) as slots_also_excluded,
       coalesce(x.exclusions, 0) as exclusions
from keys k
left join seed s on s.route_key = k.route_key
left join catch_totals c on c.route_key is not distinct from k.route_key
left join slot_totals t on t.route_key is not distinct from k.route_key
left join exclusion_totals x on x.route_key is not distinct from k.route_key
left join normalized n on n.route_key = k.route_key
cross join lateral (
    select array(select other.route_key from normalized other
                 where n.hint_key <> '' and other.hint_key = n.hint_key
                   and other.route_key <> k.route_key order by other.route_key) as similar_keys
) h
order by s.seed_position nulls last, k.route_key;
