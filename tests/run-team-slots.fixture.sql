-- Run with psql -X -v ON_ERROR_STOP=1 against a fresh, disposable local cluster only.
create role anon;
create role authenticated;
set default_transaction_isolation = 'read committed';

create schema auth;
create function auth.role() returns text language sql stable as $$ select current_user::text $$;
grant usage on schema auth to anon, authenticated;

create function public.team_fixture_run(n integer) returns uuid language sql immutable as $$
    select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

create table public.runs (id uuid primary key, is_finished boolean default false);
create table public.catches (
    id uuid default gen_random_uuid() primary key,
    run_id uuid not null references public.runs(id) on delete cascade,
    route_name text not null,
    player_name text not null,
    status text not null,
    pokemon_id integer,
    pokemon_name text
);
insert into public.runs values (public.team_fixture_run(10), false), (public.team_fixture_run(20), true);
insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name)
select r.id, route, player, 'ALIVE', 1, 'Bisasam'
from public.runs r cross join (values ('Alabastia/ Starter'), ('Route Z'), ('Route A')) routes(route)
cross join (values ('Higa'), ('Eike'), ('Ruffy')) players(player);
insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name)
select public.team_fixture_run(20), 'Historical duplicate ' || n, 'Higa', 'DEAD', 1, 'Bisasam'
from generate_series(1, 17) n cross join generate_series(1, 2);
create temporary table original_catches as select * from public.catches;
create temporary table original_runs as select * from public.runs;

\ir ../supabase/run_team_slots.sql

grant select, update, delete on public.runs to authenticated;
grant select, insert, update, delete on public.catches to authenticated;
-- Deliberately permissive fixture to exercise the anonymous trigger guard too.
grant select, update, delete on public.catches to anon;
alter table public.runs enable row level security;
alter table public.catches enable row level security;
create policy fixture_authenticated_runs on public.runs for all to authenticated
    using (auth.role() = 'authenticated'::text);
create policy "Erlaube alles für authentifizierte Nutzer" on public.catches for all to authenticated
    using (auth.role() = 'authenticated'::text);
create policy fixture_anon_select on public.catches for select to anon using (true);
create policy fixture_anon_update on public.catches for update to anon using (true);

\ir ../supabase/catches_delete_open_run.sql
\ir ../supabase/catches_delete_open_run.sql

create function public.team_fixture_assert(ok boolean, description text)
returns void language plpgsql as $$
begin
    if ok is not true then raise exception 'Fixture failed: %', description; end if;
    raise notice 'PASS: %', description;
end
$$;

select public.team_fixture_assert(not exists (select * from public.run_team_slots),
    'migration does not reconstruct teams or mutate historical duplicates');
select public.team_fixture_assert((select count(*) from pg_constraint where contype = 'f'
    and confrelid = 'public.runs'::regclass and confdeltype = 'c') = 4,
    'all three new foreign keys preserve the existing cascade rule');
select public.team_fixture_assert((select count(*) from pg_class where relrowsecurity and oid in (
    'public.run_team_slots'::regclass, 'soul_link_team_private.initialized'::regclass,
    'soul_link_team_private.exclusions'::regclass)) = 3, 'RLS remains enabled on all team tables');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000099';
select public.team_fixture_assert(not has_table_privilege('public.run_team_slots', 'SELECT, INSERT, UPDATE, DELETE'),
    'authenticated has no direct table access');
select public.team_fixture_assert(not has_function_privilege('anon',
    'public.soul_link_team(uuid,text,text,smallint,text)', 'EXECUTE'), 'anon cannot execute team RPC');
select public.team_fixture_assert((public.soul_link_team(public.team_fixture_run(10))->>'initialized')::boolean is false,
    'reading a legacy run does not initialize it');
select public.team_fixture_assert(jsonb_array_length(public.soul_link_team(public.team_fixture_run(20))->'slots') = 0,
    'closed legacy run has no reconstructed team');
select public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(10), 'initialize') #>> '{slots,0,route_name}' = 'Alabastia/ Starter',
    'legacy initialization orders starter first, then routes deterministically');
select public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(10)) #>> '{slots,1,route_name}' = 'Route A',
    'remaining initialized routes are sorted');
select public.soul_link_team(public.team_fixture_run(10), 'remove', null, 1::smallint, 'Alabastia/ Starter') is not null as removed;
select public.team_fixture_assert(jsonb_array_length(public.soul_link_team(public.team_fixture_run(10), 'initialize')->'slots') = 2,
    'repeating initialization preserves manual removal');
select public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(10), 'add', 'Alabastia/ Starter') #>> '{slots,0,slot}' = '1',
    'manual admission fills first free slot');
do $$
begin
    perform public.soul_link_team(public.team_fixture_run(20), 'initialize');
    raise exception 'Closed run write was allowed';
exception when raise_exception then
    if sqlerrm <> 'Das Team dieses Runs kann nicht geändert werden.' then raise; end if;
end
$$;
reset role;
select public.team_fixture_assert(not exists (
    (select * from public.catches except select * from original_catches)
    union all
    (select * from original_catches except select * from public.catches)
) and not exists (
    (select * from public.runs except select * from original_runs)
    union all
    (select * from original_runs except select * from public.runs)
), 'migration, initialization and manual changes preserve all existing runs and catches');

begin;
set local role authenticated;
select public.team_fixture_assert(exists (
    select 1 from public.catches where run_id = public.team_fixture_run(20)
), 'authenticated can still read catches from a finished run');
with removed as (
    delete from public.catches where run_id = public.team_fixture_run(20) returning id
)
select public.team_fixture_assert(count(*) = 0,
    'authenticated cannot delete catches from a finished run') from removed;
with added as (
    insert into public.catches (run_id, route_name, player_name, status)
    values (public.team_fixture_run(20), 'RLS insert probe', 'Higa', 'ALIVE') returning id
)
select public.team_fixture_assert(count(*) = 1, 'existing INSERT policy remains effective') from added;
with edited as (
    update public.catches set status = 'BOX' where run_id = public.team_fixture_run(20)
        and route_name = 'RLS insert probe' returning id
)
select public.team_fixture_assert(count(*) = 1, 'existing UPDATE policy remains effective') from edited;
set local role anon;
with removed as (
    delete from public.catches where run_id = public.team_fixture_run(10) returning id
)
select public.team_fixture_assert(count(*) = 0, 'anon cannot delete from an open run') from removed;
rollback;

begin;
insert into public.runs values (public.team_fixture_run(30), null);
insert into public.catches (run_id, route_name, player_name, status)
values (public.team_fixture_run(30), 'Legacy route', 'Higa', 'ALIVE');
set local role authenticated;
with removed as (
    delete from public.catches where run_id = public.team_fixture_run(30) returning id
)
select public.team_fixture_assert(count(*) = 1, 'legacy NULL run status is treated as open') from removed;
rollback;

begin;
set local role authenticated;
select id as removed_catch_id from public.catches
where run_id = public.team_fixture_run(10) and route_name = 'Route A' and player_name = 'Higa' \gset
select public.team_fixture_assert(exists (
    select 1 from jsonb_array_elements(public.soul_link_team(public.team_fixture_run(10))->'slots') slot
    where slot->>'route_name' = 'Route A'
), 'the complete Soul Link occupies a slot before deleting a catch');
with removed as (
    delete from public.catches where id = :'removed_catch_id' and run_id = public.team_fixture_run(10) returning id
)
select public.team_fixture_assert(count(*) = 1 and bool_and(id = :'removed_catch_id'),
    'authenticated catch deletion returns exactly the requested ID') from removed;
select public.team_fixture_assert(not exists (
    select 1 from jsonb_array_elements(public.soul_link_team(public.team_fixture_run(10))->'slots') slot
    where slot->>'route_name' = 'Route A'
), 'deleting one catch removes the now incomplete Soul Link from the team');
reset role;
with expected as (select * from original_catches where id <> :'removed_catch_id')
select public.team_fixture_assert(not exists (
    (select * from public.catches except all select * from expected)
    union all (select * from expected except all select * from public.catches)
), 'catch deletion preserves both partners and all other catches');
rollback;

insert into public.runs values (public.team_fixture_run(1), false), (public.team_fixture_run(2), false),
    (public.team_fixture_run(3), false), (public.team_fixture_run(4), false);
set role authenticated;
insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name)
values (public.team_fixture_run(1), 'Alabastia/ Starter', 'Higa', 'ALIVE', 1, 'Bisasam');
select public.team_fixture_assert(jsonb_array_length(public.soul_link_team(public.team_fixture_run(1))->'slots') = 0,
    'one catch does not add route');
insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name)
values (public.team_fixture_run(1), 'Alabastia/ Starter', 'Eike', 'ALIVE', 4, 'Glumanda');
select public.team_fixture_assert(jsonb_array_length(public.soul_link_team(public.team_fixture_run(1))->'slots') = 0,
    'two catches do not add route');
insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name)
values (public.team_fixture_run(1), 'Alabastia/ Starter', 'Ruffy', 'ALIVE', 9, 'Turtok');
select public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(1)) #>> '{slots,0,slot}' = '1'
       and jsonb_array_length(public.soul_link_team(public.team_fixture_run(1)) #> '{slots,0,pokemon}') = 3,
    'authenticated catches with no account mapping create one shared starter slot');
reset role;

insert into public.catches (run_id, route_name, player_name, status, pokemon_id, pokemon_name)
select public.team_fixture_run(1), 'Route ' || n, player_name, 'ALIVE', 25, 'Pikachu'
from generate_series(2, 7) as n cross join (values ('Higa'), ('Eike'), ('Ruffy')) players(player_name)
order by n, player_name;
select public.team_fixture_assert(jsonb_array_length(public.soul_link_team(public.team_fixture_run(1))->'slots') = 6
    and jsonb_array_length(public.soul_link_team(public.team_fixture_run(1))->'candidates') = 1, 'seventh eligible route stays outside full team');

-- The row order of automatic admissions within a bulk INSERT is unspecified.
select route_name as original_route from public.run_team_slots where run_id = public.team_fixture_run(1) and slot = 2 \gset
select route_name as waiting_route from public.catches
where run_id = public.team_fixture_run(1) and not exists (
    select 1 from public.run_team_slots s where s.run_id = public.team_fixture_run(1) and s.route_name = catches.route_name
) limit 1 \gset
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000098';
select public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(1), 'replace', :'waiting_route', 2::smallint, :'original_route')
    #>> '{slots,1,route_name}' = :'waiting_route', 'another authenticated account can replace the exact slot');
reset role;
select public.team_fixture_assert((select count(*) from public.run_team_slots where run_id = public.team_fixture_run(1)) = 6,
    'replacement keeps six distinct slots');

set role authenticated;
update public.catches set status = 'DEAD' where run_id = public.team_fixture_run(1) and route_name = 'Alabastia/ Starter' and player_name = 'Higa';
reset role;
select public.team_fixture_assert((select count(*) from public.run_team_slots where run_id = public.team_fixture_run(1)) = 5
    and not exists (select 1 from public.run_team_slots where run_id = public.team_fixture_run(1) and slot = 1),
    'DEAD removes entire slot without filling gap');
select public.team_fixture_assert((select count(*) from public.catches
    where run_id = public.team_fixture_run(1) and route_name = 'Alabastia/ Starter' and status = 'ALIVE') = 2,
    'team trigger leaves other players statuses alone');
update public.catches set status = 'FAILED' where run_id = public.team_fixture_run(1) and route_name = :'waiting_route' and player_name = 'Eike';
select public.team_fixture_assert(not exists (select 1 from public.run_team_slots where run_id = public.team_fixture_run(1) and slot = 2),
    'FAILED removes the entire replacement slot');
update public.catches set status = 'BOX' where run_id = public.team_fixture_run(1) and route_name = :'original_route' and player_name = 'Higa';
update public.catches set status = 'ALIVE' where run_id = public.team_fixture_run(1) and route_name = :'original_route' and player_name = 'Higa';
select public.team_fixture_assert(not exists (select 1 from public.run_team_slots where run_id = public.team_fixture_run(1)
    and route_name = :'original_route'), 'manual replacement suppression survives later valid capture status');
select public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(1), 'add', :'original_route') #>> '{slots,0,slot}' = '1',
    'manually excluded route can be re-added into first free slot');

set role anon;
reset request.jwt.claim.sub;
do $$
begin
    perform public.soul_link_team(public.team_fixture_run(1));
    raise exception 'Anonymous account had team read access';
exception when insufficient_privilege then
    raise notice 'PASS: anon cannot read through the team RPC';
end
$$;
do $$
begin
    perform public.soul_link_team(public.team_fixture_run(1), 'remove', null, 1::smallint, 'Route 2');
    raise exception 'Anonymous account had team write access';
exception when insufficient_privilege then
    raise notice 'PASS: anon cannot write through the team RPC';
end
$$;
do $$
begin
    update public.catches set status = 'FAILED' where run_id = public.team_fixture_run(1) and player_name = 'Higa';
    raise exception 'Anonymous account could cause a team update';
exception when insufficient_privilege then
    if sqlerrm <> 'Teamrelevante Fangänderungen erfordern eine Anmeldung.' then raise; end if;
    raise notice 'PASS: anon cannot alter team through permissive fixture catch permissions';
end
$$;
reset role;
select public.team_fixture_assert((select count(*) from public.catches where run_id = public.team_fixture_run(1)
    and player_name = 'Higa' and status = 'FAILED') = 0, 'rejected anonymous writes roll back their catch changes');

update public.runs set is_finished = true where id = public.team_fixture_run(1);
set role authenticated;
select public.team_fixture_assert(jsonb_array_length(public.soul_link_team(public.team_fixture_run(1))->'slots') = 5,
    'a closed run retains its saved team');
do $$
declare original_team jsonb := public.soul_link_team(public.team_fixture_run(1))->'slots';
begin
    perform public.soul_link_team(public.team_fixture_run(1), 'remove', null, 1::smallint, original_team #>> '{0,route_name}');
    raise exception 'Closed run team was changed';
exception when raise_exception then
    if sqlerrm <> 'Das Team dieses Runs kann nicht geändert werden.' then raise; end if;
    perform public.team_fixture_assert(public.soul_link_team(public.team_fixture_run(1))->'slots' = original_team, 'closed team cannot be edited');
end
$$;
reset role;

-- Exercise all three cascade targets on a disposable run with both a populated and an excluded route.
insert into public.catches (run_id, route_name, player_name, status)
select public.team_fixture_run(4), routes.route_name, players.player_name, 'ALIVE'
from (values ('Cascade A'), ('Cascade B')) routes(route_name)
cross join (values ('Higa'), ('Eike'), ('Ruffy')) players(player_name);
select route_name as cleared from public.run_team_slots where run_id = public.team_fixture_run(4) and slot = 1 \gset
select public.soul_link_team(public.team_fixture_run(4), 'remove', null, 1::smallint, :'cleared') is not null;
select public.team_fixture_assert(
    (select count(*) from public.run_team_slots where run_id = public.team_fixture_run(4)) = 1
    and exists (select 1 from soul_link_team_private.initialized where run_id = public.team_fixture_run(4))
    and exists (select 1 from soul_link_team_private.exclusions where run_id = public.team_fixture_run(4)),
    'all three cascade targets contain fixture metadata before deleting its run');

create temporary table unaffected_before as
select 'runs' as source, to_jsonb(r) as row_data from public.runs r where id <> public.team_fixture_run(4)
union all select 'catches', to_jsonb(c) from public.catches c where run_id <> public.team_fixture_run(4)
union all select 'slots', to_jsonb(s) from public.run_team_slots s where run_id <> public.team_fixture_run(4)
union all select 'initialized', to_jsonb(i) from soul_link_team_private.initialized i where run_id <> public.team_fixture_run(4)
union all select 'exclusions', to_jsonb(e) from soul_link_team_private.exclusions e where run_id <> public.team_fixture_run(4);

set role authenticated;
delete from public.runs where id = public.team_fixture_run(4);
reset role;
select public.team_fixture_assert(not exists (
    select 1 from public.runs where id = public.team_fixture_run(4)
    union all select 1 from public.catches where run_id = public.team_fixture_run(4)
    union all select 1 from public.run_team_slots where run_id = public.team_fixture_run(4)
    union all select 1 from soul_link_team_private.initialized where run_id = public.team_fixture_run(4)
    union all select 1 from soul_link_team_private.exclusions where run_id = public.team_fixture_run(4)
), 'deleting the fixture run clears its catches and all three team metadata tables');
with after_delete as (
    select 'runs' as source, to_jsonb(r) as row_data from public.runs r
    union all select 'catches', to_jsonb(c) from public.catches c
    union all select 'slots', to_jsonb(s) from public.run_team_slots s
    union all select 'initialized', to_jsonb(i) from soul_link_team_private.initialized i
    union all select 'exclusions', to_jsonb(e) from soul_link_team_private.exclusions e
)
select public.team_fixture_assert(not exists (
    (select * from unaffected_before except all select * from after_delete)
    union all (select * from after_delete except all select * from unaffected_before)
), 'cascade leaves unrelated runs, catches and team metadata unchanged');

-- Seed the race fixtures. A runner uses two independent sessions after this file.
insert into public.catches (run_id, route_name, player_name, status)
values (public.team_fixture_run(2), 'Concurrent', 'Higa', 'ALIVE');
insert into public.catches (run_id, route_name, player_name, status)
select public.team_fixture_run(3), 'Concurrent ' || n, player_name, 'ALIVE'
from generate_series(1, 7) as n cross join (values ('Higa'), ('Eike'), ('Ruffy')) players(player_name);
select public.soul_link_team(public.team_fixture_run(3), 'remove', null, 1::smallint,
    (select route_name from public.run_team_slots where run_id = public.team_fixture_run(3) and slot = 1)) is not null as freed_slot;
