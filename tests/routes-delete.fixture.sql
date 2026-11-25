-- Run with psql -X -v ON_ERROR_STOP=1 in a disposable local PostgreSQL cluster.
\ir routes-catalog.fixture.sql
\ir ../supabase/routes_delete_unused.sql
\ir ../supabase/routes_delete_unused.sql

set role authenticated;
select public.manage_route('add', p_name => 'Fixture unused');
select public.manage_route('add', p_name => 'Fixture open catch');
select public.manage_route('add', p_name => 'Fixture archived catch');
select public.manage_route('add', p_name => 'Fixture team slot');
select public.manage_route('add', p_name => 'Fixture exclusion');
insert into public.catches (run_id, route_name, route_id, player_name, status)
select 1, legacy_key, id, 'Higa', 'BOX' from public.routes where name = 'Fixture open catch';
reset role;

-- Isolate each reference type, including slots and exclusions without a catch.
insert into public.catches (run_id, route_id, player_name, status)
select 2, id, 'Eike', 'DEAD' from public.routes where name = 'Fixture archived catch';
insert into public.run_team_slots (run_id, slot, route_name)
select 1, 6, legacy_key from public.routes where name = 'Fixture team slot';
insert into soul_link_team_private.exclusions (run_id, route_name)
select 1, legacy_key from public.routes where name = 'Fixture exclusion';
insert into public.routes (id, name, legacy_key, sort_position, is_legacy)
select id, 'Fixture historical place', 'route:' || id, 66, true from (select gen_random_uuid() as id) generated;

create temporary table pre_delete_catches as table public.catches;
create temporary table pre_delete_runs as table public.runs;
create temporary table pre_delete_slots as table public.run_team_slots;
create temporary table pre_delete_exclusions as table soul_link_team_private.exclusions;
create temporary table pre_delete_routes as table public.routes;

set role anon;
do $$
begin
    perform public.delete_route(null);
    raise exception 'Anonymous delete RPC was allowed';
exception when insufficient_privilege then
    raise notice 'PASS: anonymous cannot call delete_route';
end
$$;
reset role;
set role authenticated;
do $$
declare
    route public.routes%rowtype;
begin
    perform public.routes_fixture_assert(not has_table_privilege('public.routes', 'DELETE'),
        'authenticated has no direct DELETE grant');
    for route in select * from public.routes where not (legacy_key = 'route:' || id and not is_legacy)
    loop
        begin
            perform public.delete_route(route.id);
            raise exception 'Protected route was deleted';
        exception when insufficient_privilege then null;
        end;
    end loop;
    for route in select * from public.routes where name in
        ('Fixture open catch', 'Fixture archived catch', 'Fixture team slot', 'Fixture exclusion')
    loop
        begin
            perform public.delete_route(route.id);
            raise exception 'Referenced route was deleted';
        exception when foreign_key_violation then null;
        end;
    end loop;
    raise notice 'PASS: all standard and historical routes, open and archived catches, slots and exclusions are protected';
end
$$;
select id as unused_id from public.routes where name = 'Fixture unused' \gset
select public.delete_route(:'unused_id');
select public.routes_fixture_assert(
    count(*) = 65 and array_agg(sort_position order by sort_position) = array(select generate_series(1, 65)),
    'deletion closes the gap in the global order') from public.routes;
do $$
begin
    perform public.delete_route('00000000-0000-0000-0000-000000000000');
    raise exception 'Missing route was accepted';
exception when no_data_found then
    raise notice 'PASS: missing route is reported';
end
$$;
reset role;
select public.routes_fixture_assert(
    not exists ((table public.catches except all table pre_delete_catches)
                union all (table pre_delete_catches except all table public.catches))
    and not exists ((table public.runs except all table pre_delete_runs)
                    union all (table pre_delete_runs except all table public.runs))
    and not exists ((table public.run_team_slots except all table pre_delete_slots)
                    union all (table pre_delete_slots except all table public.run_team_slots))
    and not exists ((table soul_link_team_private.exclusions except all table pre_delete_exclusions)
                    union all (table pre_delete_exclusions except all table soul_link_team_private.exclusions)),
    'deleting or rejecting deletion preserves every catch, run, team slot and exclusion');
select public.routes_fixture_assert(
    (select array_agg(id order by sort_position) from public.routes) =
        (select array_agg(id order by sort_position) from pre_delete_routes where id <> :'unused_id')
    and not exists (select 1 from public.routes r join pre_delete_routes b using (id)
                    where to_jsonb(r) - 'sort_position' <> to_jsonb(b) - 'sort_position'),
    'deletion preserves the relative order, names and identities of all other routes');
set role authenticated;
select public.manage_route('add', p_name => 'Race catch first');
select public.manage_route('add', p_name => 'Race delete first');
select public.manage_route('add', p_name => 'Race exclusion first');
reset role;
