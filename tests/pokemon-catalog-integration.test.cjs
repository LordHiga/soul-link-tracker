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

async function setup({ result = { data: fixture() }, initialCatches = [], storage = browserStorage(), loggedIn = true,
    primaryUpdateResult, deleteResult, confirmDelete = true } = {}) {
    const elements = new Map();
    const writes = [];
    const requests = [];
    const reports = [];
    const deletions = [];
    const confirmations = [];
    const teamReads = [];
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
            let deleting = false;
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
                async single() {
                    if (table !== 'catches') return { data: runs.filter(run => run.id === filters.id).map(run => ({ ...run }))[0] };
                    assert.equal(columns, 'id');
                    writes.push(update);
                    if (primaryUpdateResult) return primaryUpdateResult;
                    const record = catches.find(record => record.id === filters.id);
                    if (!record) return { data: null, error: { code: 'PGRST116' } };
                    Object.assign(record, update);
                    return { data: { id: record.id }, error: null };
                },
                async insert(records) {
                    assert.equal(table, 'catches');
                    writes.push(...records);
                    catches.push(...records.map(record => ({ id: 'new-catch', ...record })));
                    return {};
                },
                update(values) { update = values; return query; },
                delete() { deleting = true; return query; },
                async maybeSingle() {
                    assert.equal(table, 'catches');
                    assert.equal(deleting, true);
                    assert.equal(columns, 'id');
                    deletions.push({ ...filters });
                    if (deleteResult) return deleteResult;
                    const index = catches.findIndex(record => Object.entries(filters)
                        .every(([key, value]) => record[key] === value));
                    if (index === -1) return { data: null };
                    const [record] = catches.splice(index, 1);
                    return { data: { id: record.id } };
                },
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
        window: {
            addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') start = callback; },
            confirm(message) { confirmations.push(message); return confirmDelete; }
        },
        document: { getElementById: element, createElement: () => ({ setAttribute() {} }) },
        console: { warn: (_message, id) => reports.push(id), error: console.error },
        AbortSignal, localStorage: storage,
        teamReads,
        testCatalogModule: await catalogModule,
        fetch: () => assert.fail('Pokémon JSON must not be requested from PokéAPI')
    });
    script.runInContext(context);
    const run = code => vm.runInContext(code, context);
    run('pokemonCatalogModule = testCatalogModule');
    return {
        run, element, requests, writes, catches, reports, deletions, confirmations, teamReads, start: () => start(),
        finishRun() { runs[0].is_finished = true; },
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
    assert.ok(!Object.hasOwn(app.writes[0], 'level'));
    assert.equal(app.element('poke-name-input').value, 'Glurak');
});

test('preserves stored IDs, names and levels during status updates even without the catalog', async () => {
    for (const [record, result, shown] of [
        [caught(4, oldName), { data: fixture() }, 'Glumanda'],
        [caught(387, 'Chelast'), { error: { message: 'catalog unavailable' } }, 'Chelast'],
        [caught(null, null), { error: { message: 'catalog unavailable' } }, 'Unbekanntes Pokémon']
    ]) {
        const app = await setup({ initialCatches: [record], result });
        await app.run('checkAuth()');
        await app.open(Object.freeze({ ...record }));
        assert.equal(app.element('poke-name-input').value, shown);
        app.element('poke-status-input').value = 'BOX';
        await app.run('savePokemonData()');
        const [update] = app.writes;
        assert.ok(!Object.hasOwn(update, 'pokemon_id'));
        assert.ok(!Object.hasOwn(update, 'pokemon_name'));
        assert.ok(!Object.hasOwn(update, 'level'));
        assert.equal(app.catches[0].pokemon_id, record.pokemon_id);
        assert.equal(app.catches[0].pokemon_name, record.pokemon_name);
        assert.equal(app.catches[0].level, record.level);
        assert.equal(app.catches[0].status, 'BOX');
    }
});

test('the shared catch form and overview show no Pokémon levels', async () => {
    assert.doesNotMatch(html, /poke-level-input|\bLvl\b|\.levels\b|>Level</);
    const record = caught(4, oldName, { level: 87 });
    const app = await setup({ initialCatches: [record] });
    await app.run('checkAuth()');
    const tracker = app.element('routes-container').innerHTML;
    assert.match(tracker, /Glumanda/);
    assert.doesNotMatch(tracker, /Lvl|\b87\b/);
    await app.open();
    assert.equal(app.element('poke-name-input').value, '');
    await app.open(record);
    assert.equal(app.element('poke-name-input').value, 'Glumanda');
    await app.run('savePokemonData()');
    assert.equal(app.writes.length, 0);
});

test('route search is local, finds hidden routes, and restores the standard view when cleared', async () => {
    const app = await setup();
    await app.start();
    // Route 104 is a search fixture. The FireRed route list does not contain it.
    app.run(`KANTO_ROUTES.push('Route 104'); _supabase.from = () => { throw new Error('Unexpected route search request'); }`);
    const input = app.element('route-search');
    const routes = app.element('routes-container');
    const standardView = routes.innerHTML;
    assert.doesNotMatch(standardView, /Geheimdungeon|Route 104/);

    for (const [query, match] of [['  gEHEIMdUnGeOn  ', /Geheimdungeon/], ['104', /Route 104/]]) {
        input.value = query;
        input.dispatch('input');
        assert.match(routes.innerHTML, match);
        assert.doesNotMatch(routes.innerHTML, /Alabastia\/ Starter/);
    }
    input.value = 'Nicht vorhandene Route';
    input.dispatch('input');
    assert.match(routes.children[0].textContent, /Keine passende Route gefunden/);
    input.value = '';
    input.dispatch('input');
    assert.equal(routes.innerHTML, standardView);
});

const boxedPartner = caught(1, 'Bisasam', { id: 'partner-1', player_name: 'Eike', status: 'BOX' });
const deadPartner = caught(5, 'Glutexo', { id: 'partner-2', player_name: 'Ruffy', status: 'DEAD', killed_by: 'Eike' });

test('removes only the confirmed catch by ID, blocks repeated clicks, and reloads catches and team', async () => {
    const original = caught(4, oldName);
    const app = await setup({ initialCatches: [original, boxedPartner, deadPartner] });
    await app.start();
    app.run('teamUi = { select(id) { teamReads.push(id); } }');
    await app.open();
    assert.equal(app.element('pokemon-remove-btn').hidden, true);
    await app.open(original);
    const button = app.element('pokemon-remove-btn');
    assert.equal(button.hidden, false);
    const removing = button.dispatch('click');
    assert.equal(button.disabled, true);
    assert.equal(app.element('pokemon-save-btn').disabled, true);
    assert.equal(app.element('pokemon-modal').classList.contains('hidden'), false);
    await Promise.all([removing, button.dispatch('click'), app.run('savePokemonData()')]);
    assert.deepEqual(app.deletions, [{ id: original.id, run_id: runId }]);
    assert.deepEqual(app.catches, [boxedPartner, deadPartner]);
    assert.deepEqual(app.writes, []);
    assert.equal(app.confirmations.length, 1);
    assert.match(app.confirmations[0], /Glumanda von Higa auf Route 1.*Partner-Fänge bleiben erhalten/);
    assert.equal(app.element('pokemon-modal').classList.contains('hidden'), true);
    assert.deepEqual(app.teamReads, [runId]);
    assert.doesNotMatch(app.element('routes-container').innerHTML, /Glumanda/);
});

test('a failed or unconfirmed deletion keeps the editor open and shows an error', async () => {
    const original = caught(4, oldName);
    for (const deleteResult of [{ error: { code: '42501' } }, { data: null }]) {
        const app = await setup({ initialCatches: [original], deleteResult });
        await app.start();
        await app.open(original);
        await app.element('pokemon-remove-btn').dispatch('click');
        assert.deepEqual(app.catches, [original]);
        assert.equal(app.deletions.length, 1);
        assert.equal(app.element('pokemon-modal').classList.contains('hidden'), false);
        assert.equal(app.element('pokemon-remove-btn').disabled, false);
        assert.match(app.element('pokemon-save-error').textContent, /nicht entfernt|nicht bestätigt/);
    }
});

test('cancelled confirmation and completed runs never send a delete', async () => {
    const original = caught(4, oldName);
    const cancelled = await setup({ initialCatches: [original], confirmDelete: false });
    await cancelled.start();
    await cancelled.open(original);
    await cancelled.element('pokemon-remove-btn').dispatch('click');
    assert.equal(cancelled.confirmations.length, 1);
    assert.deepEqual(cancelled.deletions, []);

    const finished = await setup({ initialCatches: [original] });
    await finished.start();
    await finished.open(original);
    finished.finishRun();
    await finished.element('pokemon-remove-btn').dispatch('click');
    assert.match(finished.element('pokemon-save-error').textContent, /schreibgeschützt/);
    assert.deepEqual(finished.deletions, []);
    finished.run('closeModal()');
    await finished.run('loadRoutesAndCatches()');
    await finished.open(original);
    assert.equal(finished.element('pokemon-modal').classList.contains('hidden'), true);
});

test('all three route views combine with search and restore their results without network reads', async () => {
    const group = (routeName, statuses) => statuses.map((status, index) => caught(4, oldName, {
        id: `${routeName}-${index}`, route_name: routeName, player_name: ['Higa', 'Eike', 'Ruffy'][index], status
    }));
    const initialCatches = [
        ...group('Route 1', ['ALIVE', 'ALIVE', 'ALIVE']),
        ...group('Route 2', ['ALIVE', 'BOX', 'ALIVE']),
        ...group('Route 3', ['DEAD', 'ALIVE', 'ALIVE']),
        ...group('Route 4', ['ALIVE', 'ALIVE', 'FAILED']),
        ...group('Route 5', ['ALIVE', 'ALIVE']),
        ...group('Route 6', ['ALIVE', 'ALIVE', 'ALIVE']),
        caught(4, oldName, { id: 'duplicate', route_name: 'Route 6', status: 'BOX' })
    ];
    const app = await setup({ initialCatches });
    await app.start();
    app.run("_supabase.from = () => { throw new Error('Unexpected route filter request'); }");
    const view = app.element('route-view');
    const search = app.element('route-search');
    const routes = app.element('routes-container');
    const setSearch = query => { search.value = query; search.dispatch('input'); };
    const names = () => Array.from(routes.innerHTML.matchAll(/📍 ([^<]+)</g), match => match[1]);
    for (const mode of ['standard', 'all', 'active']) {
        view.value = mode;
        view.dispatch('change');
        const beforeSearch = names();
        assert.ok(beforeSearch.includes('Route 1'));
        if (mode === 'active') assert.deepEqual(beforeSearch, ['Route 1']);
        else for (const name of ['Route 2', 'Route 3', 'Route 4', 'Route 5', 'Route 6']) assert.ok(beforeSearch.includes(name));
        assert.equal(beforeSearch.includes('Route 23'), mode === 'all');
        setSearch('rOuTe 23');
        if (mode === 'active') assert.match(routes.children[0].textContent, /Keine passende Route/);
        else assert.deepEqual(names(), ['Route 23']);
        setSearch('');
        assert.deepEqual(names(), beforeSearch);
        assert.equal(view.value, mode);
    }
    assert.deepEqual(app.catches, initialCatches);
});

test('renaming a catch or adding an ALIVE catch does not overwrite partner status or death attribution', async () => {
    for (const original of [caught(4, oldName), undefined]) {
        const initialCatches = original ? [original, boxedPartner, deadPartner] : [boxedPartner, deadPartner];
        const app = await setup({ initialCatches });
        await app.run('checkAuth()');
        await app.open(original);
        app.element('poke-name-input').value = 'Glurak';
        await app.run('savePokemonData()');
        assert.equal(app.writes.length, 1);
        if (original) assert.ok(!Object.hasOwn(app.writes[0], 'status'));
        assert.deepEqual(app.catches.filter(row => row.player_name !== player), [boxedPartner, deadPartner]);
    }
});

test('intentional status and death attribution changes still synchronize the Soul Link', async () => {
    for (const original of [caught(4, oldName), caught(4, oldName, { status: 'DEAD', killed_by: 'Eike' })]) {
        const app = await setup({ initialCatches: [original, boxedPartner, deadPartner] });
        await app.run('checkAuth()');
        await app.open(original);
        app.element('poke-status-input').value = 'DEAD';
        app.element('poke-killer-input').value = 'Ruffy';
        await app.run('savePokemonData()');
        assert.equal(app.writes.length, 3);
        assert.ok(app.catches.every(row => row.status === 'DEAD' && row.killed_by === 'Ruffy'));
        assert.ok(app.writes.every(update => !Object.hasOwn(update, 'level')));
    }
});

test('unconfirmed or failed catch updates keep the dialog open and stop partner writes', async () => {
    const original = caught(4, oldName);
    for (const primaryUpdateResult of [
        { data: null, error: { code: 'PGRST116' } },
        { data: null, error: null },
        { data: { id: 'another-row' }, error: null },
        { data: null, error: { code: 'fixture-error' } }
    ]) {
        const app = await setup({ initialCatches: [original, boxedPartner, deadPartner], primaryUpdateResult });
        await app.run('checkAuth()');
        await app.open(original);
        app.element('poke-status-input').value = 'BOX';
        await app.run('savePokemonData()');
        assert.equal(app.writes.length, 1);
        assert.equal(app.element('pokemon-modal').classList.contains('hidden'), false);
        assert.match(app.element('pokemon-save-error').textContent, /nicht bestätigt|nicht gespeichert/);
        assert.equal(app.element('pokemon-save-btn').disabled, false);
        assert.deepEqual(app.catches, [original, boxedPartner, deadPartner]);
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
