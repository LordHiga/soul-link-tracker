-- Apply only after reviewing inspect_run_team_readonly.sql and confirming a restore point.
-- Apply once as the migration owner. The authenticated API role needs no account setup.
-- Confirm RPC read access as authenticated and denial as anon before releasing the app.
-- Initialize active legacy teams explicitly in the app. Keep historical catches intact.
begin;

create schema soul_link_team_private;
revoke all on schema soul_link_team_private from public, anon, authenticated;

-- Derive the key type from the installed runs table.
create table public.run_team_slots as
    select id as run_id, null::smallint as slot, null::text collate "C" as route_name
    from public.runs with no data;
alter table public.run_team_slots
    alter column route_name set not null,
    add primary key (run_id, slot),
    add unique (run_id, route_name),
    add check (slot between 1 and 6),
    add check (btrim(route_name) <> ''),
    add foreign key (run_id) references public.runs(id) on delete cascade;

create table soul_link_team_private.initialized as
    select id as run_id from public.runs with no data;
alter table soul_link_team_private.initialized
    add primary key (run_id),
    add foreign key (run_id) references public.runs(id) on delete cascade;

create table soul_link_team_private.exclusions as
    select run_id, route_name from public.run_team_slots with no data;
alter table soul_link_team_private.exclusions
    add primary key (run_id, route_name),
    add foreign key (run_id) references public.runs(id) on delete cascade;

alter table public.run_team_slots enable row level security;
alter table soul_link_team_private.initialized enable row level security;
alter table soul_link_team_private.exclusions enable row level security;
revoke all on public.run_team_slots from public, anon, authenticated;
revoke all on all tables in schema soul_link_team_private from public, anon, authenticated;

create function soul_link_team_private.eligible_routes(p_run_id public.runs.id%type)
returns setof text
language sql stable set search_path = ''
as $$
    select c.route_name::text collate "C"
    from public.catches as c
    where c.run_id = p_run_id and btrim(c.route_name::text) <> ''
      and c.player_name in ('Higa', 'Eike', 'Ruffy')
    group by c.route_name::text collate "C"
    having count(*) = 3 and count(distinct c.player_name) = 3
       and count(*) filter (where c.status = 'ALIVE') = 3
$$;

create function soul_link_team_private.first_free_slot(p_run_id public.runs.id%type)
returns smallint
language sql stable set search_path = ''
as $$
    select n::smallint from pg_catalog.generate_series(1, 6) as n
    where not exists (select 1 from public.run_team_slots s where s.run_id = p_run_id and s.slot = n)
    order by n limit 1
$$;

create function soul_link_team_private.snapshot(p_run_id public.runs.id%type)
returns jsonb
language sql stable set search_path = ''
as $$
    with selected as (
        select route_name, slot from public.run_team_slots where run_id = p_run_id
    ), available as (
        select e.route_name from soul_link_team_private.eligible_routes(p_run_id) as e(route_name)
        where not exists (select 1 from selected s where s.route_name = e.route_name collate "C")
    ), pokemon_by_route as (
        select c.route_name::text collate "C" as route_name,
            jsonb_agg(jsonb_build_object('player_name', c.player_name, 'pokemon_id', c.pokemon_id,
                'pokemon_name', c.pokemon_name) order by c.player_name) as pokemon
        from public.catches c where c.run_id = p_run_id
          and c.player_name in ('Higa', 'Eike', 'Ruffy')
          and c.route_name::text collate "C" in (
              select route_name from selected union all select route_name from available
          )
        group by c.route_name::text collate "C"
    )
    select jsonb_build_object(
        'finished', r.is_finished is true,
        'initialized', exists (select 1 from soul_link_team_private.initialized i where i.run_id = p_run_id),
        'slots', coalesce((select jsonb_agg(jsonb_build_object('slot', s.slot, 'route_name', s.route_name,
            'pokemon', coalesce(p.pokemon, '[]'::jsonb)) order by s.slot)
            from selected s left join pokemon_by_route p using (route_name)), '[]'::jsonb),
        'candidates', case when r.is_finished is true then '[]'::jsonb else coalesce((
            select jsonb_agg(jsonb_build_object('route_name', a.route_name, 'pokemon', p.pokemon)
                order by a.route_name collate "C")
            from available a join pokemon_by_route p using (route_name)
        ), '[]'::jsonb) end
    ) from public.runs r where r.id = p_run_id
$$;

create function public.soul_link_team(
    p_run_id public.runs.id%type, p_action text default 'read', p_route text default null,
    p_slot smallint default null, p_expected_route text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    finished boolean;
    free_slot smallint;
begin
    if p_action = 'read' then
        return soul_link_team_private.snapshot(p_run_id);
    end if;

    -- Serialize against the catch trigger without conflicting with FK KEY SHARE locks.
    select r.is_finished into finished from public.runs r where r.id = p_run_id for no key update;
    if not found or finished is true then
        raise exception 'Das Team dieses Runs kann nicht geändert werden.';
    end if;

    if p_action = 'initialize' then
        insert into soul_link_team_private.initialized values (p_run_id) on conflict do nothing;
        if found then
            insert into public.run_team_slots (run_id, slot, route_name)
            select p_run_id, row_number() over (order by (route_name <> 'Alabastia/ Starter'),
                route_name collate "C")::smallint, route_name
            from soul_link_team_private.eligible_routes(p_run_id) as e(route_name)
            order by (route_name <> 'Alabastia/ Starter'), route_name collate "C" limit 6;
        end if;
        return soul_link_team_private.snapshot(p_run_id);
    end if;

    if not exists (select 1 from soul_link_team_private.initialized where run_id = p_run_id) then
        raise exception 'Das Team muss zuerst initialisiert werden.';
    end if;
    if p_action in ('remove', 'replace') and not exists (
        select 1 from public.run_team_slots where run_id = p_run_id and slot = p_slot
          and route_name = p_expected_route collate "C"
    ) then
        raise exception 'Der Slot hat sich geändert. Bitte erneut auswählen.';
    end if;

    if p_action = 'remove' then
        delete from public.run_team_slots where run_id = p_run_id and slot = p_slot;
    elsif p_action in ('add', 'replace') then
        if not exists (select 1 from soul_link_team_private.eligible_routes(p_run_id) e(route_name)
                       where e.route_name collate "C" = p_route)
           or exists (select 1 from public.run_team_slots where run_id = p_run_id and route_name = p_route) then
            raise exception 'Die Route ist nicht für eine Aufnahme verfügbar.';
        end if;
        free_slot := soul_link_team_private.first_free_slot(p_run_id);
        if p_action = 'add' and free_slot is not null then
            insert into public.run_team_slots values (p_run_id, free_slot, p_route);
        elsif p_action = 'replace' and free_slot is null then
            update public.run_team_slots set route_name = p_route where run_id = p_run_id and slot = p_slot;
        else
            raise exception 'Die Teambelegung hat sich geändert. Bitte erneut auswählen.';
        end if;
        delete from soul_link_team_private.exclusions where run_id = p_run_id and route_name = p_route;
    else
        raise exception 'Unbekannte Teamaktion.';
    end if;

    if p_action in ('remove', 'replace') then
        insert into soul_link_team_private.exclusions values (p_run_id, p_expected_route) on conflict do nothing;
    end if;
    return soul_link_team_private.snapshot(p_run_id);
end
$$;

create function soul_link_team_private.initialize_new_run()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if new.is_finished is not true
       and current_setting('role', true) is distinct from 'anon' and session_user <> 'anon' then
        insert into soul_link_team_private.initialized values (new.id);
    end if;
    return new;
end
$$;

create function soul_link_team_private.reconcile_catch()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
    old_run public.runs.id%type;
    new_run public.runs.id%type;
    locked_run record;
    can_admit boolean := false;
    free_slot smallint;
begin
    if tg_op = 'UPDATE' and (old.run_id, old.route_name, old.player_name, old.status)
        is not distinct from (new.run_id, new.route_name, new.player_name, new.status) then
        return null;
    end if;
    if tg_op <> 'INSERT' and old.player_name in ('Higa', 'Eike', 'Ruffy') then
        old_run := old.run_id;
    end if;
    if tg_op <> 'DELETE' and new.player_name in ('Higa', 'Eike', 'Ruffy') then
        new_run := new.run_id;
        can_admit := new.status = 'ALIVE' and (tg_op = 'INSERT' or old.status is distinct from new.status
            or (old.run_id, old.route_name, old.player_name) is distinct from
                (new.run_id, new.route_name, new.player_name));
    end if;

    for locked_run in select id, is_finished from public.runs where id in (old_run, new_run)
        order by id for no key update
    loop
        if locked_run.is_finished is true then continue; end if;
        -- SECURITY DEFINER changes current_user; the request role still identifies API callers.
        if current_setting('role', true) = 'anon' or session_user = 'anon' then
            raise exception 'Teamrelevante Fangänderungen erfordern eine Anmeldung.' using errcode = '42501';
        end if;
        if locked_run.id = old_run then
            delete from public.run_team_slots s where s.run_id = old_run and s.route_name = old.route_name::text
                and not exists (select 1 from soul_link_team_private.eligible_routes(old_run) e(route_name)
                                where e.route_name collate "C" = s.route_name);
        end if;
        if locked_run.id = new_run then
            if not exists (select 1 from soul_link_team_private.eligible_routes(new_run) e(route_name)
                           where e.route_name collate "C" = new.route_name::text) then
                delete from public.run_team_slots where run_id = new_run and route_name = new.route_name::text;
            elsif can_admit and exists (select 1 from soul_link_team_private.initialized where run_id = new_run)
                and not exists (select 1 from soul_link_team_private.exclusions
                                where run_id = new_run and route_name = new.route_name::text)
                and not exists (select 1 from public.run_team_slots where run_id = new_run and route_name = new.route_name::text) then
                free_slot := soul_link_team_private.first_free_slot(new_run);
                if free_slot is not null then
                    insert into public.run_team_slots values (new_run, free_slot, new.route_name::text);
                end if;
            end if;
        end if;
    end loop;
    return null;
end
$$;

revoke all on all functions in schema soul_link_team_private from public, anon, authenticated;
revoke all on function public.soul_link_team(public.runs.id%type, text, text, smallint, text)
    from public, anon, authenticated;
grant execute on function public.soul_link_team(public.runs.id%type, text, text, smallint, text) to authenticated;

create trigger soul_link_team_new_run after insert on public.runs
    for each row execute function soul_link_team_private.initialize_new_run();
create trigger soul_link_team_catch_change after insert or update or delete on public.catches
    for each row execute function soul_link_team_private.reconcile_catch();

commit;
