begin;

create table public.pokemon_catalog (
    id smallint primary key check (id between 1 and 386),
    name_de text not null check (btrim(name_de) <> ''),
    name_en text not null check (btrim(name_en) <> ''),
    generation smallint not null check (generation = case
        when id <= 151 then 1
        when id <= 251 then 2
        else 3
    end),
    sprite_url text not null check (sprite_url like 'https://%'),
    type_primary text not null,
    type_secondary text,
    constraint pokemon_catalog_valid_gen3_types check (
        array_remove(array[type_primary, type_secondary], null) <@ array[
            'normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel',
            'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'
        ]::text[]
        and type_primary is distinct from type_secondary
    )
);

create index pokemon_catalog_generation_id_idx
    on public.pokemon_catalog (generation, id);

alter table public.pokemon_catalog enable row level security;

revoke all on table public.pokemon_catalog from public, anon, authenticated;
grant select on table public.pokemon_catalog to authenticated;

create policy pokemon_catalog_authenticated_read
    on public.pokemon_catalog for select
    to authenticated
    using (true);

commit;
