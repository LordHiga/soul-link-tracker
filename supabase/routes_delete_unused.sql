-- Apply after routes_catalog.sql. Existing team references must resolve to the catalog.
begin;
set local lock_timeout = '5s';

-- The catch FK already protects route_id. These FKs protect concurrent legacy-key writes
-- as well as references that exist without a catch, such as a team exclusion.
do $$
begin
    if not exists (
        select from pg_catalog.pg_constraint
        where conrelid = 'public.run_team_slots'::regclass and conname = 'run_team_slots_route_fkey'
    ) then
        alter table public.run_team_slots add constraint run_team_slots_route_fkey
            foreign key (route_name) references public.routes(legacy_key) on delete restrict;
    end if;
    if not exists (
        select from pg_catalog.pg_constraint
        where conrelid = 'soul_link_team_private.exclusions'::regclass and conname = 'exclusions_route_fkey'
    ) then
        alter table soul_link_team_private.exclusions add constraint exclusions_route_fkey
            foreign key (route_name) references public.routes(legacy_key) on delete restrict;
    end if;
end
$$;

create or replace function public.delete_route(p_route_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    route public.routes%rowtype;
begin
    -- Same catalog lock as manage_route. The row lock serializes with the reference FK checks.
    lock table public.routes in share row exclusive mode;
    select * into route from public.routes where id = p_route_id for update;
    if not found then
        raise exception 'Dieser Encounter-Ort existiert nicht mehr.' using errcode = 'P0002';
    end if;
    -- Only manage_route-generated keys qualify. Seed and historical keys are protected.
    if route.is_legacy or route.legacy_key <> 'route:' || route.id then
        raise exception 'Dieser Encounter-Ort ist geschützt und kann nicht gelöscht werden.' using errcode = '42501';
    end if;

    if exists (
        select 1 from public.catches c
        where c.route_id = route.id or c.route_name::text collate "C" = route.legacy_key
    ) or exists (
        select 1 from public.run_team_slots s where s.route_name = route.legacy_key
    ) or exists (
        select 1 from soul_link_team_private.exclusions e where e.route_name = route.legacy_key
    ) then
        raise exception 'Dieser Encounter-Ort wird von Fängen oder einem Team verwendet.' using errcode = '23503';
    end if;

    delete from public.routes where id = route.id;
    with positions as (
        select id, row_number() over (order by sort_position)::integer as position from public.routes
    )
    update public.routes r set sort_position = p.position
    from positions p where r.id = p.id and r.sort_position <> p.position;
end
$$;

revoke all on function public.delete_route(uuid) from public, anon, authenticated;
grant execute on function public.delete_route(uuid) to authenticated;

commit;
