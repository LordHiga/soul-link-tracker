-- Run with psql -X -v ON_ERROR_STOP=1 in a fresh, disposable local PostgreSQL cluster.
-- Tested with PostgreSQL 18. Run as the local fixture cluster owner.
set client_encoding = 'UTF8';
set track_functions = 'pl';
select 'create role anon' where not exists (select 1 from pg_roles where rolname = 'anon') \gexec
select 'create role authenticated' where not exists (select 1 from pg_roles where rolname = 'authenticated') \gexec
create table public.runs (id integer primary key, is_finished boolean, outcome text, finish_note text);
create table public.catches (
    id uuid default gen_random_uuid() primary key,
    run_id integer not null references public.runs(id),
    route_name text not null,
    player_name text not null,
    status text not null,
    pokemon_id integer,
    pokemon_name text,
    killed_by text
);

insert into public.runs values (1, false, null, null), (2, true, 'WIPE', 'Fixture wipe');
insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name, killed_by)
select 1, route, player, 'ALIVE', 1, 'Bisasam', null
from (values ('Alabastia/ Starter'), ('Route 4')) routes(route)
cross join (values ('Higa'), ('Eike'), ('Ruffy')) players(player)
union all
select 2, 'Felstunnel', 'Higa', 'DEAD', 25, 'Pikachu', 'Ruffy'
from generate_series(1, 2);

\ir ../supabase/run_team_slots.sql
grant select on public.runs to authenticated;
grant select, insert, update, delete on public.catches to authenticated;
alter table public.catches enable row level security;
create policy catches_fixture_access on public.catches for all to authenticated using (true);
\ir ../supabase/catches_delete_open_run.sql

create function public.routes_fixture_assert(ok boolean, description text)
returns void language plpgsql as $$
begin
    if ok is not true then raise exception 'Fixture failed: %', description; end if;
    raise notice 'PASS: %', description;
end
$$;

set role authenticated;
select public.soul_link_team(1, 'initialize');
select public.soul_link_team(1, 'remove', null, 2::smallint, 'Route 4');
reset role;
create temporary table original_catches as select to_jsonb(c) as row_data from public.catches c;
create temporary table original_runs as select to_jsonb(r) as row_data from public.runs r;
create temporary table original_slots as select * from public.run_team_slots;
create temporary table original_exclusions as select * from soul_link_team_private.exclusions;
create temporary table original_initialized as select * from soul_link_team_private.initialized;
create temporary table original_team as select public.soul_link_team(1) snapshot;
create temporary table original_team_functions as
select p.oid, pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'soul_link_team_private' or (n.nspname = 'public' and p.proname = 'soul_link_team');

-- Run the exact migration against a spelling variant. The transaction must roll back.
insert into public.catches (run_id, route_name, player_name, status) values (2, 'felstunnel', 'Eike', 'BOX');
\set ON_ERROR_STOP off
\set VERBOSITY terse
\ir ../supabase/routes_catalog.sql
\set VERBOSITY default
\set ON_ERROR_STOP on
select public.routes_fixture_assert(to_regclass('public.routes') is null
    and not exists (select 1 from pg_attribute where attrelid = 'public.catches'::regclass and attname = 'route_id')
    and exists (select 1 from public.catches where route_name = 'felstunnel')
    and exists (select 1 from pg_trigger where tgrelid = 'public.catches'::regclass
      and tgname = 'soul_link_team_catch_change' and tgenabled = 'O'),
    'unlisted key aborts the migration and rolls back its schema changes');
delete from public.catches where route_name = 'felstunnel';

select pg_stat_force_next_flush();
create temporary table trigger_baseline as
select coalesce(pg_stat_get_function_calls('soul_link_team_private.reconcile_catch()'::regprocedure), 0) as calls;
\ir ../supabase/routes_catalog.sql
select pg_stat_force_next_flush();
select pg_stat_clear_snapshot();
select public.routes_fixture_assert(
    (select calls from trigger_baseline) =
    coalesce(pg_stat_get_function_calls('soul_link_team_private.reconcile_catch()'::regprocedure), 0)
    and exists (select 1 from pg_trigger where tgrelid = 'public.catches'::regclass
                and tgname = 'soul_link_team_catch_change' and tgenabled = 'O'),
    'backfill invokes no team reconciliation and leaves the trigger enabled');

select public.routes_fixture_assert(
    count(*) = 58 and count(distinct id) = 58 and bool_and(name = legacy_key and not is_legacy)
    and array_agg(sort_position order by sort_position) = array(select generate_series(1, 58))
    and md5(string_agg(legacy_key, E'\n' order by sort_position)) = 'a93bdbe0647cdbf81a26185f0fa53f5c',
    'all 58 routes have unique stable IDs and exactly the original order') from public.routes;
select public.routes_fixture_assert(
    not exists (select 1 from public.catches c left join public.routes r on r.id = c.route_id
                where r.id is null or c.route_name collate "C" <> r.legacy_key)
    and (select count(*) from public.catches where run_id = 2 and player_name = 'Higa' and route_name = 'Felstunnel') = 2
    and not exists (
        (select to_jsonb(c) - 'route_id' from public.catches c except all select row_data from original_catches)
        union all
        (select row_data from original_catches except all select to_jsonb(c) - 'route_id' from public.catches c)
    ), 'exact ID backfill preserves every catch value and historical duplicates');
select public.routes_fixture_assert(
    not exists (
        (select to_jsonb(r) from public.runs r except all select row_data from original_runs)
        union all
        (select row_data from original_runs except all select to_jsonb(r) from public.runs r)
    )
    and not exists ((table public.run_team_slots except all table original_slots)
                    union all (table original_slots except all table public.run_team_slots))
    and not exists ((table soul_link_team_private.exclusions except all table original_exclusions)
                    union all (table original_exclusions except all table soul_link_team_private.exclusions))
    and not exists ((table soul_link_team_private.initialized except all table original_initialized)
                    union all (table original_initialized except all table soul_link_team_private.initialized))
    and public.soul_link_team(1) = (select snapshot from original_team)
    and not exists (select 1 from original_team_functions where pg_get_functiondef(oid) is distinct from definition),
    'runs, wipes, slots, exclusions, initialization, team RPC result and team definitions stay identical');

set role anon;
do $$
begin
    begin
        perform count(*) from public.routes;
        raise exception 'Anonymous catalog read was allowed';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.manage_route('add', p_name => 'Anonymous place');
        raise exception 'Anonymous RPC was allowed';
    exception when insufficient_privilege then null;
    end;
end
$$;
reset role;

set role authenticated;
select public.routes_fixture_assert(count(*) = 58 and row_security_active('public.routes'),
    'authenticated can read the catalog with RLS active') from public.routes;
select id as starter_id from public.routes where legacy_key = 'Alabastia/ Starter' \gset
select id as route_four_id from public.routes where legacy_key = 'Route 4' \gset
select id as route_twenty_two_id from public.routes where legacy_key = 'Route 22' \gset
select public.routes_fixture_assert((public.manage_route('rename', :'starter_id', 'Starterwahl')).name = 'Starterwahl',
    'authenticated can rename the display name');
select public.routes_fixture_assert(
    (select count(*) from public.catches where route_id = :'starter_id' and route_name = 'Alabastia/ Starter') = 3
    and public.soul_link_team(1) #>> '{slots,0,route_name}' = 'Alabastia/ Starter',
    'renaming leaves catches and slot identity intact');
select public.routes_fixture_assert(
    jsonb_array_length(public.soul_link_team(1, 'remove', null, 1::smallint, 'Alabastia/ Starter')->'slots') = 0,
    'team RPC still accepts the old key when checking the expected slot');
select public.routes_fixture_assert(
    public.soul_link_team(1, 'add', 'Alabastia/ Starter') #>> '{slots,0,route_name}' = 'Alabastia/ Starter',
    'team RPC can re-add a renamed route using the old key');
select public.routes_fixture_assert(
    (public.manage_route('move_up', :'route_four_id', p_expected_neighbor_id =>
        (select id from public.routes where sort_position = 7))).sort_position = 7,
    'move up swaps exactly one adjacent position');
select public.routes_fixture_assert(
    (public.manage_route('move_down', :'route_four_id', p_expected_neighbor_id =>
        (select id from public.routes where sort_position = 8))).sort_position = 8,
    'move down reverses exactly one adjacent swap');
select id as casino_id from public.manage_route('add', p_name => 'Casino Evoli (300)', p_encounter_type => 'purchase') \gset
select public.routes_fixture_assert(
    sort_position = 59 and encounter_type = 'purchase' and legacy_key = 'route:' || id,
    'new encounter gets a generated key, a type and the last position')
from public.routes where id = :'casino_id';
-- A former display name may be reused without reusing a historical key on migration replay.
select public.manage_route('add', p_name => 'Alabastia/ Starter');

do $$
declare
    first_route uuid := (select id from public.routes where sort_position = 1);
    fourth_route uuid := (select id from public.routes where legacy_key = 'Route 4');
begin
    if has_table_privilege('public.routes', 'INSERT, UPDATE, DELETE, TRUNCATE') then
        raise exception 'Authenticated catalog write grant present';
    end if;
    begin
        update public.routes set legacy_key = 'changed' where id = first_route;
        raise exception 'Direct catalog write was allowed';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.manage_route('add', p_name => '  casino evoli (300)  ');
        raise exception 'Duplicate name was allowed';
    exception when unique_violation then null;
    end;
    begin
        perform public.manage_route('move_up', fourth_route, p_expected_neighbor_id => first_route);
        raise exception 'Stale neighbor was allowed';
    exception when serialization_failure then null;
    end;
    begin
        perform public.manage_route('delete', first_route);
        raise exception 'Delete action was allowed';
    exception when invalid_parameter_value then null;
    end;
    begin
        insert into public.catches (run_id, route_name, route_id, player_name, status)
        values (1, 'Route 4', first_route, 'Higa', 'BOX');
        raise exception 'Mismatching catch was allowed';
    exception when foreign_key_violation then null;
    end;
    begin
        update public.catches set route_name = 'Route 4', route_id = fourth_route
        where run_id = 1 and route_name = 'Alabastia/ Starter';
        raise exception 'Existing catch was moved';
    exception when check_violation then null;
    end;
    begin
        perform public.manage_route('rename', first_route, 'Rollback probe');
        perform public.manage_route('add', p_name => 'CASINO EVOLI (300)');
    exception when unique_violation then null;
    end;
    perform public.routes_fixture_assert(
        (select name = 'Starterwahl' from public.routes where id = first_route)
        and (select sort_position = 8 from public.routes where id = fourth_route),
        'invalid writes and failed multi-action transactions do not leak changes');
end
$$;

insert into public.catches (run_id, route_name, player_name, status)
values (1, 'Route 22', 'Higa', 'ALIVE'), (1, 'Route 22', 'Eike', 'ALIVE'), (1, 'Route 22', 'Ruffy', 'ALIVE');
select public.routes_fixture_assert(
    (select count(*) from public.catches where route_id = :'route_twenty_two_id' and route_name = 'Route 22') = 3
    and public.soul_link_team(1) #>> '{slots,1,route_name}' = 'Route 22',
    'old-tab inserts infer IDs and still auto-admit a complete Soul Link');
update public.catches set status = 'DEAD' where run_id = 1 and route_name = 'Route 22' and player_name = 'Ruffy';
select public.routes_fixture_assert(
    jsonb_array_length(public.soul_link_team(1)->'slots') = 1
    and (select count(*) from public.catches where route_id = :'route_twenty_two_id') = 3,
    'old-tab status update still removes the affected team slot');
insert into public.catches (run_id, route_id, player_name, status) values (1, :'casino_id', 'Eike', 'BOX');
select public.routes_fixture_assert(exists (
    select 1 from public.catches c join public.routes r on r.id = c.route_id
    where r.id = :'casino_id' and c.route_name = r.legacy_key
), 'ID-only inserts fill the stable key even for a new encounter');
select public.routes_fixture_assert(
    (public.manage_route('move_up', :'casino_id', p_expected_neighbor_id =>
        (select id from public.routes where sort_position = 58))).sort_position = 58,
    'replay fixture has a customized catalog order');
reset role;

do $$
begin
    begin
        update public.routes set legacy_key = 'changed' where legacy_key = 'Route 4';
        raise exception 'The catalog owner could mutate the historical key';
    exception when check_violation then null;
    end;
end
$$;

select pg_stat_force_next_flush();
select pg_stat_clear_snapshot();
select public.routes_fixture_assert(
    coalesce(pg_stat_get_function_calls('soul_link_team_private.reconcile_catch()'::regprocedure), 0)
        > (select calls from trigger_baseline),
    'function statistics record actual runtime team trigger calls');
create temporary table before_replay as select * from public.routes;
create temporary table before_replay_catches as select * from public.catches;
\ir ../supabase/routes_catalog.sql
select public.routes_fixture_assert(
    (select count(*) from public.routes) = 60
    and not exists ((table public.routes except all table before_replay)
                    union all (table before_replay except all table public.routes))
    and not exists ((table public.catches except all table before_replay_catches)
                    union all (table before_replay_catches except all table public.catches)),
    'migration replay preserves route IDs, edits, positions and every catch');
