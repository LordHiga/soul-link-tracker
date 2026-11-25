-- Apply as the migration owner after the read-only route preflight and a restore point.
-- Keep the runs and team tables intact. Repeat runs preserve catalog edits and route IDs.
begin;
set local lock_timeout = '5s';

-- Block concurrent catch writes until the compatibility trigger is installed.
lock table public.catches in access exclusive mode;

create table if not exists public.routes (
    id uuid primary key default gen_random_uuid(),
    name text not null check (name ~ '^[^[:space:]]' and name ~ '[^[:space:]]$'),
    legacy_key text collate "C" not null unique check (legacy_key !~ '^[[:space:]]*$'),
    sort_position integer not null check (sort_position > 0),
    is_legacy boolean not null default false,
    encounter_type text,
    constraint routes_sort_position_key unique (sort_position) deferrable initially immediate
);
lock table public.routes in share row exclusive mode;

create unique index if not exists routes_active_name_key
    on public.routes (lower(name)) where not is_legacy;

alter table public.routes enable row level security;
revoke all on table public.routes from public, anon, authenticated;
grant select on table public.routes to authenticated;
drop policy if exists routes_authenticated_read on public.routes;
create policy routes_authenticated_read on public.routes for select to authenticated using (true);

-- Exact snapshot of KANTO_ROUTES in index.html. Never reset names or positions on replay.
insert into public.routes (name, legacy_key, sort_position)
select route_key, route_key, position::integer
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
]::text[]) with ordinality as seed(route_key, position)
where not exists (select 1 from public.routes r where r.legacy_key = seed.route_key collate "C");

alter table public.catches add column if not exists route_id uuid
    constraint catches_route_id_fkey references public.routes(id);

do $$
begin
    if exists (
        select 1 from public.catches c
        left join public.routes r on r.legacy_key = c.route_name::text collate "C"
        where r.id is null or (c.route_id is not null and c.route_id <> r.id)
    ) or exists (
        select 1
        from (
            select route_name from public.run_team_slots
            union all
            select route_name from soul_link_team_private.exclusions
        ) team
        where not exists (
            select 1 from public.routes r where r.legacy_key = team.route_name::text collate "C"
        )
    ) then
        raise exception 'Unbekannter Routenschlüssel oder widersprüchliche Routen-ID. Bestandsprüfung wiederholen.';
    end if;

    if exists (select 1 from public.catches where route_id is null) then
        if not exists (
            select 1 from pg_catalog.pg_trigger
            where tgrelid = 'public.catches'::regclass and tgname = 'soul_link_team_catch_change'
                and tgenabled = 'O' and not tgisinternal
                and tgtype = 29 -- AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW
                and tgfoid = 'soul_link_team_private.reconcile_catch()'::regprocedure
        ) then
            raise exception 'Der geprüfte Team-Abgleichstrigger fehlt oder ist anders konfiguriert.';
        end if;

        -- The locked table prevents other sessions from writing with the trigger disabled.
        -- The only write here adds route_id; every input to the team trigger stays equal.
        alter table public.catches disable trigger soul_link_team_catch_change;
        update public.catches c set route_id = r.id
        from public.routes r
        where c.route_id is null and r.legacy_key = c.route_name::text collate "C";
        alter table public.catches enable trigger soul_link_team_catch_change;
    end if;
end
$$;

alter table public.catches alter column route_id set not null;

create or replace function soul_link_team_private.keep_route_identity()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if (new.id, new.legacy_key) is distinct from (old.id, old.legacy_key) then
        raise exception 'Routen-ID und historischer Schlüssel sind unveränderlich.' using errcode = '23514';
    end if;
    return new;
end
$$;

create or replace trigger routes_keep_identity
    before update on public.routes
    for each row execute function soul_link_team_private.keep_route_identity();

create or replace function soul_link_team_private.match_catch_route()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
    route public.routes%rowtype;
begin
    if new.route_id is null then
        select * into route from public.routes where legacy_key = new.route_name::text collate "C";
    else
        select * into route from public.routes where id = new.route_id;
    end if;

    if not found or (new.route_name is not null and new.route_name::text collate "C" <> route.legacy_key) then
        raise exception 'Routen-ID und historischer Schlüssel passen nicht zusammen.' using errcode = '23503';
    end if;
    if tg_op = 'UPDATE' and (old.route_id, old.route_name::text collate "C")
        is distinct from (route.id, route.legacy_key) then
        raise exception 'Die Route eines bestehenden Fangs kann nicht geändert werden.' using errcode = '23514';
    end if;

    new.route_id := route.id;
    new.route_name := route.legacy_key;
    return new;
end
$$;

create or replace trigger catches_match_route
    before insert or update of route_id, route_name on public.catches
    for each row execute function soul_link_team_private.match_catch_route();

create or replace function public.manage_route(
    p_action text, p_route_id uuid default null, p_name text default null,
    p_encounter_type text default null, p_expected_neighbor_id uuid default null
)
returns public.routes
language plpgsql security definer set search_path = ''
as $$
declare
    route public.routes%rowtype;
    neighbor public.routes%rowtype;
    route_name text;
    next_id uuid;
begin
    -- Serialize appends and swaps; readers and catch foreign-key checks can continue.
    lock table public.routes in share row exclusive mode;

    if p_action in ('add', 'rename') then
        route_name := regexp_replace(p_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
        if route_name is null or route_name = '' then
            raise exception 'Ein Routenname ist erforderlich.' using errcode = '22023';
        end if;
    end if;

    if p_action = 'add' then
        next_id := gen_random_uuid();
        insert into public.routes (id, name, legacy_key, sort_position, encounter_type)
        select next_id, route_name, 'route:' || next_id, coalesce(max(sort_position), 0) + 1,
               nullif(btrim(p_encounter_type), '')
        from public.routes
        returning * into route;
        return route;
    end if;

    select * into route from public.routes where id = p_route_id;
    if not found then
        raise exception 'Diese Route existiert nicht.' using errcode = '22023';
    end if;

    if p_action = 'rename' then
        update public.routes set name = route_name where id = route.id returning * into route;
    elsif p_action in ('move_up', 'move_down') then
        select * into neighbor from public.routes
        where (p_action = 'move_up' and sort_position < route.sort_position)
           or (p_action = 'move_down' and sort_position > route.sort_position)
        order by case when p_action = 'move_up' then sort_position end desc,
                 case when p_action = 'move_down' then sort_position end
        limit 1;
        if not found or neighbor.id is distinct from p_expected_neighbor_id then
            raise exception 'Die Nachbarroute hat sich geändert oder fehlt. Bitte neu laden.'
                using errcode = '40001';
        end if;
        update public.routes
        set sort_position = case when id = route.id then neighbor.sort_position else route.sort_position end
        where id in (route.id, neighbor.id);
        select * into route from public.routes where id = p_route_id;
    else
        raise exception 'Unbekannte Routenaktion.' using errcode = '22023';
    end if;
    return route;
end
$$;

revoke all on function soul_link_team_private.keep_route_identity() from public, anon, authenticated;
revoke all on function soul_link_team_private.match_catch_route() from public, anon, authenticated;
revoke all on function public.manage_route(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.manage_route(text, uuid, text, text, uuid) to authenticated;

commit;
