-- For a separately approved SQL Editor preflight. Outputs metadata and counts only.
begin isolation level repeatable read read only;
set local search_path = pg_catalog;
-- Fail if the current role would have to evaluate an RLS policy.
set local row_security = off;
set local statement_timeout = '5s';
set local lock_timeout = '1s';
select 1 / (current_setting('transaction_read_only') = 'on')::integer as read_only_confirmed;

select table_name, column_name, udt_schema, udt_name, is_nullable, is_identity
from information_schema.columns
where table_schema = 'public' and table_name in ('runs', 'catches', 'feedbacks')
order by table_name, ordinal_position;

select c.conrelid::regclass as table_name, c.conname, c.contype, c.convalidated,
       case when c.contype in ('p', 'u', 'f') then pg_get_constraintdef(c.oid) end as key_definition
from pg_constraint c
where c.conrelid in ('public.runs'::regclass, 'public.catches'::regclass, 'public.feedbacks'::regclass)
order by table_name, c.conname;

select i.indrelid::regclass as table_name, ix.relname as index_name, i.indisunique,
       i.indisvalid, i.indpred is not null as partial, i.indexprs is not null as expression_index,
       array(select a.attname from unnest(i.indkey) with ordinality as k(attnum, position)
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
             where k.position <= i.indnkeyatts order by k.position) as key_columns
from pg_index i join pg_class ix on ix.oid = i.indexrelid
where i.indrelid in ('public.runs'::regclass, 'public.catches'::regclass, 'public.feedbacks'::regclass)
order by table_name, index_name;

-- Inventory custom triggers and behavior flags. Return no function bodies.
select t.tgrelid::regclass as table_name, t.tgname, t.tgenabled,
       case when (t.tgtype::integer & 2) <> 0 then 'BEFORE'
            when (t.tgtype::integer & 64) <> 0 then 'INSTEAD OF' else 'AFTER' end as timing,
       (t.tgtype::integer & 1) <> 0 as row_level,
       (t.tgtype::integer & 4) <> 0 as on_insert,
       (t.tgtype::integer & 8) <> 0 as on_delete,
       (t.tgtype::integer & 16) <> 0 as on_update,
       n.nspname as function_schema, p.proname as function_name,
       p.prosecdef as security_definer, p.proconfig::text like '%search_path=%' as has_fixed_search_path,
       p.prosrc ~* 'auth\.(uid|jwt|role)' as refers_to_auth_context,
       p.prosrc ~* '\m(insert|update|delete|perform|execute)\M' as possibly_changes_data,
       p.prosrc ~* '\mfor[[:space:]]+(no[[:space:]]+key[[:space:]]+)?update\M' as possible_row_lock,
       p.prosrc ~* '\mstatus\M' as mentions_status
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n on n.oid = p.pronamespace
where not t.tgisinternal
  and t.tgrelid in ('public.runs'::regclass, 'public.catches'::regclass, 'public.feedbacks'::regclass)
order by table_name, t.tgname;

select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       r.rolname as request_role, r.rolsuper, r.rolbypassrls,
       has_schema_privilege(r.oid, c.relnamespace, 'USAGE') as schema_usage,
       has_table_privilege(r.oid, c.oid, 'SELECT') as table_select,
       has_any_column_privilege(r.oid, c.oid, 'SELECT') as any_select,
       has_any_column_privilege(r.oid, c.oid, 'INSERT') as any_insert,
       has_any_column_privilege(r.oid, c.oid, 'UPDATE') as any_update,
       has_table_privilege(r.oid, c.oid, 'DELETE') as table_delete
from pg_class c cross join pg_roles r
where c.oid in ('public.runs'::regclass, 'public.catches'::regclass, 'public.feedbacks'::regclass)
  and r.rolname in ('anon', 'authenticated')
order by table_name, request_role;

-- Describes policy scope without returning predicates that could contain user identifiers.
select tablename, policyname, cmd, permissive,
       'public' = any(roles) as applies_to_public,
       'anon' = any(roles) as names_anon,
       'authenticated' = any(roles) as names_authenticated,
       cardinality(roles) - cardinality(array(select role_name from unnest(roles) as pr(role_name)
           where role_name in ('public', 'anon', 'authenticated'))) as other_role_count,
       case when qual is null then 'none' when qual in ('true', 'false') then qual else 'conditional' end as using_kind,
       case when with_check is null then 'none' when with_check in ('true', 'false') then with_check else 'conditional' end as check_kind,
       concat_ws(' ', qual, with_check) ~* 'auth\.(uid|jwt|role)' as refers_to_auth_context
from pg_policies
where schemaname = 'public' and tablename in ('runs', 'catches', 'feedbacks')
order by tablename, policyname;

select to_regclass('public.run_team_slots') is not null as slots_already_exist,
       to_regnamespace('soul_link_team_private') is not null as private_schema_already_exists,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'soul_link_team') as rpc_already_exists;

-- Stop the transaction before accessing app rows if an audited relation is a view,
-- foreign table or custom table access method, or if a column needs a custom cast.
-- A division-by-zero error here signals failed prerequisites.
with expected(table_name, column_name, allowed_type_oids, allow_enum) as (
    values
        ('runs', 'id', array['int2'::regtype, 'int4'::regtype, 'int8'::regtype, 'uuid'::regtype,
                            'text'::regtype, 'varchar'::regtype]::oid[], false),
        ('runs', 'is_finished', array['bool'::regtype]::oid[], false),
        ('catches', 'run_id', array['int2'::regtype, 'int4'::regtype, 'int8'::regtype, 'uuid'::regtype,
                                  'text'::regtype, 'varchar'::regtype]::oid[], false),
        ('catches', 'route_name', array['text'::regtype, 'varchar'::regtype]::oid[], false),
        ('catches', 'player_name', array['text'::regtype, 'varchar'::regtype]::oid[], true),
        ('catches', 'status', array['text'::regtype, 'varchar'::regtype]::oid[], true)
)
select 1 / (count(*) = (select count(*) from expected))::integer as safe_to_read_aggregates
from expected e
join pg_namespace n on n.nspname = 'public'
join pg_class c on c.relnamespace = n.oid and c.relname = e.table_name and c.relkind = 'r'
join pg_am am on am.oid = c.relam and am.amname = 'heap'
join pg_attribute a on a.attrelid = c.oid and a.attname = e.column_name and a.attnum > 0 and not a.attisdropped
join pg_type t on t.oid = a.atttypid
where (t.oid = any(e.allowed_type_oids) or (e.allow_enum and t.typtype = 'e'))
  and not exists (
      select 1 from pg_cast x join pg_proc p on p.oid = x.castfunc
      where x.castsource = t.oid and x.casttarget = 'text'::regtype
        and p.pronamespace <> 'pg_catalog'::regnamespace
  )
  and (not c.relrowsecurity or exists (
      select 1 from pg_roles runner where runner.rolname = current_user
        and (runner.rolsuper or runner.rolbypassrls
             or (not c.relforcerowsecurity and pg_has_role(c.relowner, 'USAGE')))
  ));

-- Aggregate only. Identify suspicious variant groups without emitting their labels.
with records as (
    select c.run_id, c.route_name::text collate "C" as route,
           c.player_name::text collate "C" as player_name, c.status::text as status,
           r.id is not null as linked, r.id is not null and r.is_finished::text is distinct from 'true' as active
    from only public.catches c left join only public.runs r on r.id::text collate "C" = c.run_id::text collate "C"
), duplicate_keys as (
    select run_id, route, player_name, bool_or(active) as active, count(*) as catch_count
    from records group by run_id, route, player_name having count(*) > 1
), variant_groups as (
    select run_id
    from records where btrim(route) <> ''
    group by run_id, regexp_replace(lower(route collate "default"), '[^[:alnum:]]+', '', 'g')
    having count(distinct route) > 1
), active_links as (
    select run_id, route, count(*) as catch_count, count(distinct player_name) as player_count,
           count(*) filter (where status = 'ALIVE') as alive_count
    from records
    where active and btrim(route) <> '' and player_name in ('Higa', 'Eike', 'Ruffy')
    group by run_id, route
)
select (select count(*) from only public.runs) as total_runs,
       (select count(*) from only public.runs where is_finished is not true) as active_runs,
       (select count(*) from records) as total_catches,
       (select count(*) from records where not linked) as orphan_catches,
       (select count(*) from records where route is null or btrim(route) = '') as blank_routes,
       (select count(*) from records where player_name is null or player_name not in ('Higa', 'Eike', 'Ruffy')) as other_players,
       (select count(*) from duplicate_keys) as duplicate_catch_keys,
       (select count(*) from duplicate_keys where active) as duplicate_catch_keys_in_active_runs,
       (select coalesce(sum(catch_count - 1), 0) from duplicate_keys) as catches_beyond_unique_keys,
       (select count(*) from variant_groups) as possible_route_variant_groups,
       count(*) filter (where player_count < 3) as incomplete_active_links,
       count(distinct run_id) filter (where player_count < 3) as active_runs_with_incomplete_links,
       count(*) filter (where catch_count = 3 and alive_count = 3 and player_count = 3) as eligible_active_links,
       count(distinct run_id) filter (
           where catch_count = 3 and alive_count = 3 and player_count = 3
       ) as active_runs_with_eligible_links
from active_links;

select case when status::text in ('ALIVE', 'BOX', 'DEAD', 'FAILED') then status::text
            when status is null then 'NULL' else 'OTHER' end as status_kind,
       count(*) as occurrences
from only public.catches
group by 1 order by 1;

rollback;
