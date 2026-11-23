const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = new vm.Script(html.split('<script>').at(-1).split('</script>')[0]);
const catalogModule = import('../lib/pokemon-catalog-display.mjs');
const route = 'Route 1';
const runId = 'run-1';
const player = 'Higa';
const oldName = 'Charmander';

function fixture() {
    const namedRows = new Map([
        [1, ['Bisasam', 'grass', 'poison']], [4, ['Glumanda', 'fire', null]],
        [5, ['Glutexo', 'fire', null]], [6, ['Glurak', 'fire', 'flying']],
        [282, ['Guardevoir', 'psychic', null]], [303, ['Flunkifer', 'steel', null]]
    ]);
    return Array.from({ length: 386 }, (_, index) => {
        const id = index + 1;
        const [name_de, type_primary, type_secondary] = namedRows.get(id) ?? [`Pokémon ${id}`, 'normal', null];
        return { id, name_de, type_primary, type_secondary };
    });
}

function browserStorage() {
    const entries = new Map();
    return { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
}

function caught(id, name, fields = {}) {
    return {
        id: 'catch-1', run_id: runId, route_name: route, player_name: player,
        pokemon_id: id, pokemon_name: name, status: 'ALIVE', level: 8, ...fields
    };
}

async function setup({ result = { data: fixture() }, initialCatches = [], storage = browserStorage(), loggedIn = true } = {}) {
    const elements = new Map();
    const writes = [];
    const requests = [];
    const reports = [];
    let start;
    const runs = [{ id: runId, title: 'Test-Run', is_finished: false }];
    let catalogResult = result;
    const catches = initialCatches.map(record => ({ ...record }));

    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            const listeners = new Map();
            elements.set(id, {
                value: '', innerHTML: '', children: [],
                classList: {
                    add: name => classes.add(name), remove: name => classes.delete(name),
                    contains: name => classes.has(name)
                },
                replaceChildren(...children) { this.children = children; },
                appendChild(child) { this.children.push(child); },
                addEventListener(event, callback) { listeners.set(event, callback); },
                dispatch(event, details) { return listeners.get(event)(details); }
            });
        }
        return elements.get(id);
    }

    const client = {
        auth: {
            getSession: async () => ({ data: { session: loggedIn ? {
                user: { id: 'fixture-user', email: 'fixture@example.test', user_metadata: { has_seen_gag: true } }
            } : null } })
        },
        from(table) {
            const filters = {};
            let columns;
            let update;
            const query = {
                select(value) { columns = value; return query; },
                order(column) {
                    if (table === 'pokemon_catalog') assert.equal(column, 'id');
                    return query;
                },
                limit(limit) { assert.equal(limit, 387); return query; },
                eq(column, value) { filters[column] = value; return query; },
                async abortSignal(signal) {
                    assert.equal(signal.aborted, false);
                    assert.equal(table, 'pokemon_catalog');
                    requests.push(columns);
                    return catalogResult;
                },
                single: async () => ({ data: runs.find(run => run.id === filters.id) }),
                async insert(records) {
                    assert.equal(table, 'catches');
                    writes.push(...records);
                    catches.push(...records.map(record => ({ id: 'new-catch', ...record })));
                    return {};
                },
                update(values) { update = values; return query; },
                then(resolve, reject) {
                    if (table === 'catches' && update) {
                        writes.push(update);
                        Object.assign(catches.find(record => record.id === filters.id), update);
                        return Promise.resolve({}).then(resolve, reject);
                    }
                    const records = table === 'runs' ? runs : catches;
                    const data = records.filter(record => Object.entries(filters)
                        .every(([key, value]) => record[key] === value));
                    return Promise.resolve({ data }).then(resolve, reject);
                }
            };
            return query;
        }
    };

    const context = vm.createContext({
        supabase: { createClient: () => client },
        window: { addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') start = callback; } },
        document: { getElementById: element, createElement: () => ({}) },
        console: { warn: (_message, id) => reports.push(id), error: console.error },
        AbortSignal, localStorage: storage,
        testCatalogModule: await catalogModule,
        fetch: () => assert.fail('Pokémon JSON must not be requested from PokéAPI')
    });
    script.runInContext(context);
    const run = code => vm.runInContext(code, context);
    run('pokemonCatalogModule = testCatalogModule');
    return {
        run, element, requests, writes, catches, reports, start: () => start(),
        setCatalogResult(value) { catalogResult = value; },
        async open(record) {
            context.editRecord = record;
            run(`openModal('${route}', '${player}', editRecord)`);
        }
    };
}

test('loads the complete catalog once after login and exposes exclusively German suggestions', async () => {
    const app = await setup();
    await app.run('checkAuth()');
    await app.run('loadPokemonCatalog()');
    assert.deepEqual(app.requests, ['id,name_de,type_primary,type_secondary']);
    const names = app.element('pokemon-list').children.map(option => option.value);
    assert.equal(names.length, 386);
    assert.deepEqual(names.filter(name => name.startsWith('Glu')), ['Glumanda', 'Glurak', 'Glutexo']);
    assert.ok(!names.includes(oldName));

    const anonymous = await setup({ loggedIn: false });
    await anonymous.run('checkAuth()');
    assert.equal(anonymous.requests.length, 0);
});

test('rejects failed, incomplete and duplicate catalogs before any new catch can be saved', async () => {
    const duplicateRows = fixture();
    duplicateRows[385] = duplicateRows[0];
    for (const result of [{ error: { message: 'test timeout' } }, { data: fixture().slice(1) }, { data: duplicateRows }]) {
        const app = await setup({ result });
        await app.run('checkAuth()');
        assert.equal(app.element('pokemon-catalog-error').classList.contains('hidden'), false);
        await app.open();
        app.element('poke-name-input').value = 'Glumanda';
        await app.run('savePokemonData()');
        assert.equal(app.writes.length, 0);
        assert.match(app.element('pokemon-save-error').textContent, /nicht verfügbar/);
        app.setCatalogResult({ data: fixture() });
        await app.run('retryPokemonCatalog()');
        assert.equal(app.requests.length, 2);
        assert.equal(app.element('pokemon-list').children.length, 386);
    }
});

test('saves a selected catalog name and exact ID and blocks unknown or ambiguous labels', async () => {
    const rows = fixture();
    rows[385].name_de = 'Doppelt';
    rows[384].name_de = 'Doppelt';
    const app = await setup({ result: { data: rows } });
    await app.start();
    app.element('routes-container').dispatch('click', {
        target: { closest: () => ({ dataset: { catchRoute: route, catchPlayer: player } }) }
    });
    for (const value of ['Missing', 'Doppelt']) {
        app.element('poke-name-input').value = value;
        await app.run('savePokemonData()');
    }
    assert.equal(app.writes.length, 0);
    app.element('poke-name-input').value = 'Glurak';
    app.element('poke-name-input').dispatch('input');
    await app.element('pokemon-form').dispatch('submit', { preventDefault() {} });
    assert.equal(app.writes.length, 1);
    assert.equal(app.writes[0].pokemon_id, 6);
    assert.equal(app.writes[0].pokemon_name, 'Glurak');
    assert.equal(app.element('poke-name-input').value, 'Glurak');
});

test('preserves the stored IDs and names during status and level updates even without the catalog', async () => {
    for (const [record, result, shown] of [
        [caught(4, oldName), { data: fixture() }, 'Glumanda'],
        [caught(387, 'Chelast'), { error: { message: 'catalog unavailable' } }, 'Chelast'],
        [caught(null, null), { error: { message: 'catalog unavailable' } }, 'Unbekanntes Pokémon']
    ]) {
        const app = await setup({ initialCatches: [record], result });
        await app.run('checkAuth()');
        await app.open(Object.freeze({ ...record }));
        assert.equal(app.element('poke-name-input').value, shown);
        app.element('poke-level-input').value = 9;
        app.element('poke-status-input').value = 'BOX';
        await app.run('savePokemonData()');
        const [update] = app.writes;
        assert.ok(!Object.hasOwn(update, 'pokemon_id'));
        assert.ok(!Object.hasOwn(update, 'pokemon_name'));
        assert.equal(app.catches[0].pokemon_id, record.pokemon_id);
        assert.equal(app.catches[0].pokemon_name, record.pokemon_name);
        assert.equal(app.catches[0].level, 9);
        assert.equal(app.catches[0].status, 'BOX');
    }
});

test('renders German history names and ordered historical badges on the tracker, with safe legacy fallback', async () => {
    const app = await setup({ initialCatches: [
        caught(1, 'Bulbasaur'), caught(282, 'Gardevoir', { player_name: 'Eike' }),
        caught(303, 'Mawile', { player_name: 'Ruffy' }),
        caught(387, '<img src=x>', { route_name: 'Route 2' })
    ] });
    await app.run('checkAuth()');
    const tracker = app.element('routes-container').innerHTML;
    assert.match(tracker, /Bisasam[\s\S]*?Pflanze[\s\S]*?Gift/);
    assert.match(tracker, /Guardevoir[\s\S]*?Psycho/);
    assert.match(tracker, /Flunkifer[\s\S]*?Stahl/);
    assert.match(tracker, /&lt;img src=x&gt;/);
    assert.doesNotMatch(tracker, /Bulbasaur|Gardevoir|Mawile|>Fee<|<img src=x>|onclick="openModal/);
    await app.run('loadAndRenderHistory()');
    const history = app.element('runs-overview-table-body').innerHTML;
    assert.match(history, /<details[\s\S]*Bisasam[\s\S]*Guardevoir[\s\S]*Flunkifer/);
    assert.match(history, /&lt;img src=x&gt;/);
    assert.doesNotMatch(history, /Bulbasaur|Gardevoir|Mawile|<img src=x>/);
    assert.deepEqual(app.reports, [387]);
    assert.deepEqual(app.writes, []);
});

test('restores the validated browser cache on reload and replaces incomplete cached data', async () => {
    const storage = browserStorage();
    const first = await setup({ storage });
    await first.run('checkAuth()');
    const second = await setup({ storage, result: { error: { message: 'would fail if called' } } });
    await second.run('checkAuth()');
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 0);
    assert.equal(second.element('pokemon-list').children.length, 386);
    const key = 'soul-link-tracker:pokemon-catalog:v1';
    const cached = JSON.parse(storage.getItem(key));
    cached.rows.pop();
    storage.setItem(key, JSON.stringify(cached));
    const third = await setup({ storage });
    await third.run('checkAuth()');
    assert.equal(third.requests.length, 1);
    assert.equal(third.element('pokemon-list').children.length, 386);
    const expired = JSON.parse(storage.getItem(key));
    expired.expiresAt = 0;
    storage.setItem(key, JSON.stringify(expired));
    const fourth = await setup({ storage });
    await fourth.run('checkAuth()');
    assert.equal(fourth.requests.length, 1);
});
