const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
    collectCatalog, validateCatalog, makeNameLookup, buildImportSql, readGeneration3Types
} = require('../scripts/import-pokemon-catalog.cjs');

const officialNames = new Map([
    [1, ['Bisasam', 'Bulbasaur']],
    [4, ['Glumanda', 'Charmander']],
    [5, ['Glutexo', 'Charmeleon']],
    [6, ['Glurak', 'Charizard']],
    [7, ['Schiggy', 'Squirtle']],
    [25, ['Pikachu', 'Pikachu']]
]);

const fireRedTypes = new Map([
    [1, ['grass', 'poison']],
    [4, ['fire', null]],
    [6, ['fire', 'flying']],
    [25, ['electric', null]],
    [35, ['normal', null]],
    [82, ['electric', 'steel']],
    [282, ['psychic', null]],
    [303, ['steel', null]]
]);

const slots = (...names) => names.map((name, index) => ({ slot: index + 1, type: { name } }));

function mockPokemon(id) {
    const [first = 'normal', second] = fireRedTypes.get(id) ?? [];
    let types = slots(...[first, second].filter(Boolean)).reverse();
    const past_types = [];
    if ([35, 282, 303].includes(id)) {
        past_types.push({ generation: { name: 'generation-v' }, types });
        types = id === 35 ? slots('fairy') : slots(first, 'fairy');
    }
    if (id === 82) past_types.push({ generation: { name: 'generation-i' }, types: slots('electric') });
    return { id, types, past_types };
}

function mockSpecies(id) {
    const generation = id <= 151 ? 'i' : id <= 251 ? 'ii' : 'iii';
    const [de, en] = officialNames.get(id) ?? [`Deutsch ${id}`, `English ${id}`];
    return {
        id,
        generation: { name: `generation-${generation}` },
        names: [{ name: de, language: { name: 'de' } }, { name: en, language: { name: 'en' } }]
    };
}

function mockResponse(url) {
    const [, , , resource, rawId] = new URL(url).pathname.split('/');
    const id = Number(rawId);
    assert.ok(['pokemon', 'pokemon-species'].includes(resource), resource);
    return Response.json(resource === 'pokemon' ? mockPokemon(id) : mockSpecies(id));
}

const wait = async () => {};
const fixture = () => collectCatalog({ fetchImpl: mockResponse, wait });

test('collects all 386 unique IDs from both endpoints and validates every Gen 3 type', async () => {
    const urls = [];
    const rows = await collectCatalog({
        fetchImpl(url) {
            urls.push(url);
            return mockResponse(url);
        },
        wait
    });
    assert.deepEqual(rows.map(row => row.id), Array.from({ length: 386 }, (_, index) => index + 1));
    assert.equal(new Set(urls).size, 772);
    assert.equal(urls.length, 772);
    assert.deepEqual([151, 152, 251, 252, 386].map(id => rows[id - 1].generation), [1, 2, 2, 3, 3]);
    assert.match(rows[385].sprite_url, /\/pokemon\/386\.png$/);
    for (const row of rows) {
        assert.deepEqual([row.type_primary, row.type_secondary], fireRedTypes.get(row.id) ?? ['normal', null]);
    }
    assert.equal(rows.filter(row => [row.type_primary, row.type_secondary].includes('fairy')).length, 0);
});

test('uses the nearest inclusive history boundary and orders slots independently of API order', () => {
    const pokemon = mockPokemon(6);
    pokemon.types = slots('fairy');
    pokemon.past_types = [
        { generation: { name: 'generation-v' }, types: slots('water') },
        { generation: { name: 'generation-i' }, types: slots('normal') },
        { generation: { name: 'generation-iii' }, types: slots('fire', 'flying').reverse() }
    ];
    assert.deepEqual(readGeneration3Types(pokemon, 6), { type_primary: 'fire', type_secondary: 'flying' });
});

test('rejects Fee, duplicate types, missing slots and more than two types', () => {
    const invalidTypes = [
        slots('fairy'), slots('fire', 'fire'), [slots('fire', 'flying')[1]],
        slots('fire', 'flying', 'normal'), [], slots('shadow')
    ];
    for (const types of invalidTypes) {
        assert.throws(() => readGeneration3Types({ ...mockPokemon(6), types }, 6), /Pokédex #6/);
    }
});

test('validates the 386 real cached Pokémon and the exported SQL without a network request',
    { skip: !process.env.POKEMON_CATALOG_TEST_CACHE }, async () => {
        const rows = await collectCatalog({
            cacheDir: process.env.POKEMON_CATALOG_TEST_CACHE,
            fetchImpl: () => assert.fail('Unexpected request during cache validation')
        });
        assert.equal(rows.length, 386);
        assert.equal(rows.some(row => [row.type_primary, row.type_secondary].includes('fairy')), false);
        for (const [id, expected] of fireRedTypes) {
            assert.deepEqual([rows[id - 1].type_primary, rows[id - 1].type_secondary], expected, `Pokédex #${id}`);
        }
        const sql = fs.readFileSync(path.join(__dirname, '..', 'pokemon-catalog-import.sql'), 'utf8');
        assert.equal(buildImportSql(rows), sql);
    });

test('rejects missing IDs, duplicate IDs and species without German or English names', async () => {
    const rows = await fixture();
    assert.throws(() => validateCatalog(rows.slice(1)), /unvollständig/);
    assert.throws(() => validateCatalog([rows[1], ...rows.slice(1)]), /doppelte/);
    for (const missing of ['de', 'en']) {
        await assert.rejects(collectCatalog({
            fetchImpl: () => {
                const species = mockSpecies(1);
                species.names = species.names.filter(entry => entry.language.name !== missing);
                return Response.json(species);
            },
            wait
        }), /fehlender oder mehrdeutiger Name/);
    }
});

test('resolves both localized names and rejects unknown or ambiguous inputs', async () => {
    const rows = await fixture();
    const resolve = makeNameLookup(rows);
    assert.equal(resolve('  bISaSam '), 1);
    assert.equal(resolve('BULBASAUR'), 1);
    assert.equal(resolve('Deutsch    26'), 26);
    assert.equal(resolve('Unbekannt'), null);
    assert.equal(makeNameLookup([...rows, { id: 2, name_de: 'Bisasam', name_en: 'Example' }])('Bisasam'), null);
});

test('provides one official German label per ID for suggestions, saving and display', async () => {
    const rows = await fixture();
    const resolve = makeNameLookup(rows);
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const [id, [german, english]] of officialNames) {
        assert.equal(resolve(english), id);
        assert.equal(resolve(german), id);
        assert.equal(byId.get(id).name_de, german);
    }
    const labels = rows.map(row => row.name_de);
    assert.deepEqual(labels.filter(label => label.toLowerCase().startsWith('glu')),
        ['Glumanda', 'Glutexo', 'Glurak']);
});

test('prefers the catalog name, falls back to the stored name, and reports missing IDs', async () => {
    const { getPokemonDisplayName } = await import('../lib/pokemon-catalog-display.mjs');
    const rows = await fixture();
    const byId = new Map(rows.map(row => [row.id, row]));
    const legacy = Object.freeze({ pokemon_id: 387, pokemon_name: 'Chelast' });
    const catalogCatch = Object.freeze({ pokemon_id: 4, pokemon_name: 'Charmander' });
    const missing = Object.freeze({});
    const reports = [];
    const reportMissing = (_message, id) => reports.push(id);

    assert.equal(getPokemonDisplayName(catalogCatch, byId, reportMissing), 'Glumanda');
    assert.deepEqual(reports, []);
    assert.equal(getPokemonDisplayName(catalogCatch, new Map(), reportMissing), 'Charmander');
    assert.equal(getPokemonDisplayName(legacy, byId, reportMissing), 'Chelast');
    assert.equal(getPokemonDisplayName(missing, byId, reportMissing), 'Unbekanntes Pokémon');
    assert.deepEqual(reports, [4, 387, undefined]);
    assert.equal(legacy.pokemon_name, 'Chelast');
    assert.equal(catalogCatch.pokemon_name, 'Charmander');
});

test('repeated imports emit the same transactional upsert without duplicate value IDs', async () => {
    const rows = await fixture();
    rows[82].name_en = "Farfetch'd";
    const sql = buildImportSql(rows);
    assert.equal(buildImportSql([...rows].reverse()), sql);
    assert.deepEqual([...sql.matchAll(/^    \((\d+),/gm)].map(match => Number(match[1])), rows.map(row => row.id));
    assert.match(sql, /^begin;\ninsert into public\.pokemon_catalog /);
    assert.match(sql, /E'Farfetch''d'/);
    assert.match(sql, /on conflict \(id\) do update set/);
    assert.match(sql, /type_primary = excluded\.type_primary/);
    assert.match(sql, /type_secondary = excluded\.type_secondary/);
    assert.match(sql, /E'fire', null\)/);
    assert.match(sql, /is distinct from/);
    assert.match(sql, /commit;\n$/);
    assert.throws(() => buildImportSql(rows.slice(0, 385)), /unvollständig/);
});

test('retries rate limits with Retry-After and stops at the retry limit', async () => {
    const delays = [];
    let calls = 0;
    await collectCatalog({
        fetchImpl(url) {
            calls += 1;
            if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
            return mockResponse(url);
        },
        wait: async delay => delays.push(delay)
    });
    assert.equal(calls, 773);
    assert.deepEqual(delays.slice(0, 3), [150, 2000, 150]);

    calls = 0;
    await assert.rejects(collectCatalog({
        fetchImpl() {
            calls += 1;
            return new Response(null, { status: 503 });
        },
        wait
    }), /Pokédex #1.*503/);
    assert.equal(calls, 4);
});
