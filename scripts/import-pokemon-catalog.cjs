const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const count = 386;
const api = 'https://pokeapi.co/api/v2';
const sprites = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const generations = ['generation-i', 'generation-ii', 'generation-iii', 'generation-iv',
    'generation-v', 'generation-vi', 'generation-vii', 'generation-viii', 'generation-ix'];
const generation3Types = new Set([
    'normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel',
    'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'
]);
const generationFor = id => id <= 151 ? 1 : id <= 251 ? 2 : 3;
const spriteFor = id => `${sprites}/${id}.png`;

function readSpecies(species, id) {
    const generation = generationFor(id);
    if (species?.id !== id || species.generation?.name !== generations[generation - 1] ||
        !Array.isArray(species.names)) {
        throw new Error(`Pokédex #${id}: unpassende Speziesdaten.`);
    }
    const names = ['de', 'en'].map(language => {
        const entries = species.names.filter(entry => entry?.language?.name === language);
        if (entries.length !== 1 || typeof entries[0].name !== 'string' || !entries[0].name.trim()) {
            throw new Error(`Pokédex #${id}: fehlender oder mehrdeutiger Name (${language}).`);
        }
        return entries[0].name.trim().normalize('NFC');
    });
    return { id, name_de: names[0], name_en: names[1], generation, sprite_url: spriteFor(id) };
}

function readGeneration3Types(pokemon, id) {
    if (pokemon?.id !== id || !Array.isArray(pokemon.past_types)) {
        throw new Error(`Pokédex #${id}: unpassende Typdaten.`);
    }
    let types = pokemon.types;
    let nearestEndGeneration = Infinity;
    const seenGenerations = new Set();
    for (const entry of pokemon.past_types) {
        const endGeneration = generations.indexOf(entry?.generation?.name) + 1;
        if (!endGeneration || seenGenerations.has(endGeneration)) {
            throw new Error(`Pokédex #${id}: ungültige oder doppelte Generation in past_types.`);
        }
        seenGenerations.add(endGeneration);
        // Each historical entry applies through its end generation, inclusive.
        if (endGeneration >= 3 && endGeneration < nearestEndGeneration) {
            types = entry.types;
            nearestEndGeneration = endGeneration;
        }
    }
    if (!Array.isArray(types) || types.length < 1 || types.length > 2) {
        throw new Error(`Pokédex #${id}: erwartet einen oder zwei Typen.`);
    }
    const ordered = [...types].sort((a, b) => a?.slot - b?.slot);
    if (ordered.some((entry, index) => entry?.slot !== index + 1 ||
        !generation3Types.has(entry.type?.name)) || ordered[0].type.name === ordered[1]?.type.name) {
        throw new Error(`Pokédex #${id}: ungültige Gen-3-Typen oder Slots.`);
    }
    return { type_primary: ordered[0].type.name, type_secondary: ordered[1]?.type.name ?? null };
}

function validateCatalog(rows) {
    const ids = new Set();
    for (const row of rows) {
        const { id, name_de, name_en, generation, sprite_url, type_primary, type_secondary } = row;
        if (!Number.isInteger(id) || id < 1 || id > count || ids.has(id)) {
            throw new Error(`Ungültige oder doppelte Pokédex-ID: ${id}.`);
        }
        if ([name_de, name_en].some(name => typeof name !== 'string' || !name.trim() || name.includes('\0')) ||
            generation !== generationFor(id) || sprite_url !== spriteFor(id)) {
            throw new Error(`Pokédex #${id}: ungültiger Katalogeintrag.`);
        }
        if (!generation3Types.has(type_primary) ||
            (type_secondary !== null && (!generation3Types.has(type_secondary) || type_primary === type_secondary))) {
            throw new Error(`Pokédex #${id}: ungültige Gen-3-Typen im Katalog.`);
        }
        ids.add(id);
    }
    if (ids.size !== count) throw new Error(`Katalog unvollständig: ${ids.size}/${count}.`);
}

function makeNameLookup(rows) {
    const normalize = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const names = new Map();
    for (const row of rows) {
        for (const name of [row.name_de, row.name_en]) {
            const key = normalize(name);
            if (!names.has(key)) names.set(key, new Set());
            names.get(key).add(row.id);
        }
    }
    return input => {
        const ids = names.get(normalize(input));
        return ids?.size === 1 ? ids.values().next().value : null;
    };
}

async function fetchResource(resource, id, fetchImpl, wait) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        // One request at a time, including retries.
        await wait(150);
        let response;
        try {
            response = await fetchImpl(`${api}/${resource}/${id}/`, { signal: AbortSignal.timeout(12_000) });
            if (response.ok) return await response.json();
        } catch {
            // Network, timeout or response-body errors can be transient.
        }
        const status = response?.status;
        if (status && !response.ok && status !== 429 && status !== 408 && status < 500) {
            throw new Error(`Pokédex #${id}: HTTP ${status}.`);
        }
        const retryAfter = response?.headers.get('retry-after');
        const delay = retryAfter == null ? 0 : /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        if (attempt === 3 || delay > 60_000) {
            throw new Error(`Pokédex #${id}: Abruf fehlgeschlagen (${status || 'Netzwerk'}).`);
        }
        await wait(Math.max(500 * 2 ** attempt, delay || 0));
    }
}

async function loadResource(resource, id, cacheDir, parse, fetchImpl, wait) {
    const cacheFile = cacheDir && path.join(cacheDir, `${id}.json`);
    if (cacheFile) {
        try {
            return parse(JSON.parse(await fs.readFile(cacheFile, 'utf8')), id);
        } catch (error) {
            if (error.code && error.code !== 'ENOENT') throw error;
        }
    }

    const data = await fetchResource(resource, id, fetchImpl, wait);
    const fields = parse(data, id);
    if (cacheFile) {
        const cached = resource === 'pokemon'
            ? { id: data.id, types: data.types, past_types: data.past_types }
            : data;
        await fs.writeFile(cacheFile, JSON.stringify(cached), 'utf8');
    }
    return fields;
}

async function collectCatalog({ fetchImpl = fetch, wait = sleep, cacheDir } = {}) {
    const typeCacheDir = cacheDir && path.join(cacheDir, 'pokemon-types');
    if (typeCacheDir) await fs.mkdir(typeCacheDir, { recursive: true });
    const rows = [];
    for (let id = 1; id <= count; id += 1) {
        const species = await loadResource('pokemon-species', id, cacheDir, readSpecies, fetchImpl, wait);
        const types = await loadResource('pokemon', id, typeCacheDir, readGeneration3Types, fetchImpl, wait);
        rows.push({ ...species, ...types });
    }
    validateCatalog(rows);
    return rows;
}

function buildImportSql(rows) {
    validateCatalog(rows);
    const quote = value => "E'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
    const values = [...rows].sort((a, b) => a.id - b.id).map(row =>
        `    (${row.id}, ${quote(row.name_de)}, ${quote(row.name_en)}, ${row.generation}, ${quote(row.sprite_url)}, ` +
        `${quote(row.type_primary)}, ${row.type_secondary === null ? 'null' : quote(row.type_secondary)})`
    ).join(',\n');

    return `begin;
insert into public.pokemon_catalog as catalog (id, name_de, name_en, generation, sprite_url, type_primary, type_secondary)
values
${values}
on conflict (id) do update set
    name_de = excluded.name_de,
    name_en = excluded.name_en,
    generation = excluded.generation,
    sprite_url = excluded.sprite_url,
    type_primary = excluded.type_primary,
    type_secondary = excluded.type_secondary
where (catalog.name_de, catalog.name_en, catalog.generation, catalog.sprite_url, catalog.type_primary, catalog.type_secondary)
    is distinct from (excluded.name_de, excluded.name_en, excluded.generation, excluded.sprite_url, excluded.type_primary, excluded.type_secondary);
commit;
`;
}

async function main() {
    const [cacheDir, outputFile, ...extra] = process.argv.slice(2);
    if (!cacheDir || !outputFile || extra.length) {
        throw new Error('Aufruf: node scripts/import-pokemon-catalog.cjs <Cache-Verzeichnis> <Ausgabe.sql>');
    }
    const sql = buildImportSql(await collectCatalog({ cacheDir }));
    await fs.writeFile(outputFile, sql, { encoding: 'utf8', flag: 'wx' });
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { collectCatalog, validateCatalog, makeNameLookup, buildImportSql, readGeneration3Types };
