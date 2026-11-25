const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = new vm.Script(html.split('<script>').at(-1).split('</script>')[0]);
const catalogModule = import('../lib/pokemon-catalog-display.mjs');
const route = 'Route 1';
const routeIdFor = key => 'route-id:' + key;
const routeSeed = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'routes_catalog.sql'), 'utf8')
    .match(/from unnest\(array\[([\s\S]*?)\]::text\[\]\)/)[1];
const catalogRoutes = [...routeSeed.matchAll(/'([^']+)'/g)].map(([, name], index) => ({
    id: routeIdFor(name), name, legacy_key: name, sort_position: index + 1, is_legacy: false
}));
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
        pokemon_id: id, pokemon_name: name, status: 'ALIVE', level: 8,
        route_id: routeIdFor(fields.route_name ?? route), ...fields
    };
}

async function setup({ result = { data: fixture() }, initialCatches = [], storage = browserStorage(), loggedIn = true,
    primaryUpdateResult, deleteResult, confirmDelete = true, routeRows = catalogRoutes,
    initialRuns = [{ id: runId, title: 'Test-Run', is_finished: false }] } = {}) {
    const elements = new Map();
    const writes = [];
    const requests = [];
    const reports = [];
    const deletions = [];
    const confirmations = [];
    const teamReads = [];
    const routeReads = [];
    const routeWrites = [];
    let start;
    const runs = initialRuns.map(run => ({ ...run }));
    const routes = routeRows.map(route => ({ ...route }));
    let routeError;
    let rpcError;
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
                showModal() { this.open = true; },
                close() { this.open = false; },
                focus() { this.focused = true; },
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
        rpc(name, parameters) {
            assert.ok(name === 'manage_route' || name === 'delete_route');
            routeWrites.push(parameters);
            return {
                async abortSignal() {
                    if (rpcError) return { error: rpcError };
                    if (name === 'delete_route') {
                        const index = routes.findIndex(item => item.id === parameters.p_route_id);
                        const [removed] = routes.splice(index, 1);
                        for (const route of routes) {
                            if (route.sort_position > removed.sort_position) route.sort_position--;
                        }
                        return {};
                    }
                    const selected = routes.find(item => item.id === parameters.p_route_id);
                    const neighbor = routes.find(item => item.id === parameters.p_expected_neighbor_id);
                    if (parameters.p_action === 'add') {
                        routes.push({
                            id: 'new-route-id', legacy_key: 'route:new-route-id', name: parameters.p_name,
                            sort_position: routes.length + 1, is_legacy: false
                        });
                    } else if (parameters.p_action === 'rename') selected.name = parameters.p_name;
                    else [selected.sort_position, neighbor.sort_position] = [neighbor.sort_position, selected.sort_position];
                    return {};
                }
            };
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
                    if (table === 'routes') assert.equal(column, 'sort_position');
                    return query;
                },
                limit(limit) { assert.equal(limit, 387); return query; },
                eq(column, value) { filters[column] = value; return query; },
                async abortSignal(signal) {
                    assert.equal(signal.aborted, false);
                    if (table === 'routes') {
                        routeReads.push(columns);
                        return { data: routes.map(route => ({ ...route })).reverse(), error: routeError };
                    }
                    assert.equal(table, 'pokemon_catalog');
                    requests.push(columns);
                    return catalogResult;
                },
                async single() {
                    if (table !== 'catches') return { data: runs.filter(run => run.id === filters.id).map(run => ({ ...run }))[0] };
                    assert.equal(columns, 'id');
                    writes.push(update);
                    if (primaryUpdateResult) return primaryUpdateResult;
                    const record = catches.find(record => record.id === filters.id && record.run_id === filters.run_id);
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
        run, element, requests, writes, catches, reports, deletions, confirmations, teamReads,
        routeReads, routeWrites, start: () => start(),
        finishRun() { runs[0].is_finished = true; },
        setCatalogResult(value) { catalogResult = value; },
        setRouteError(value) { routeError = value; },
        setRpcError(value) { rpcError = value; },
        async open(record) {
            context.editRecord = record;
            run(`openModal('${record?.route_id ?? routeIdFor(route)}', '${player}', editRecord)`);
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
        target: { closest: () => ({ dataset: { catchRoute: routeIdFor(route), catchPlayer: player } }) }
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
    assert.equal(app.writes[0].route_id, routeIdFor(route));
    assert.equal(app.writes[0].route_name, route);
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
    const app = await setup({ routeRows: [...catalogRoutes, {
        id: 'search-fixture', name: 'Route 104', legacy_key: 'historischer Schlüssel', sort_position: 59
    }] });
    await app.start();
    app.run("_supabase.from = () => { throw new Error('Unexpected route search request'); }");
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

test('loads all 58 routes in database order and reloads after each route management action', async () => {
    const original = caught(4, oldName);
    const app = await setup({ initialCatches: [original] });
    await app.start();
    const names = () => [...app.element('routes-container').innerHTML.matchAll(/📍 ([^<]+)</g)].map(match => match[1]);
    const view = app.element('route-view');
    view.value = 'all';
    view.dispatch('change');
    assert.equal(names().length, 58);
    assert.deepEqual(names(), catalogRoutes.map(item => item.name));
    assert.equal(app.routeReads.length, 1);
    app.element('routes-manage').dispatch('click');
    await app.run('loadRouteCatalog()');
    assert.equal(app.element('routes-dialog').open, true);
    assert.equal(app.element('routes-editor').disabled, false);

    const list = app.element('route-editor-list');
    const form = {
        dataset: { routeId: routeIdFor(route) },
        elements: { namedItem: () => ({ value: 'Neuer Routenname' }) }
    };
    await list.dispatch('submit', { target: form, preventDefault() {} });
    assert.equal(names()[1], 'Neuer Routenname');
    assert.match(app.element('routes-container').innerHTML, /Glumanda/);
    await app.open(original);
    assert.match(app.element('modal-title').textContent, /Neuer Routenname/);
    app.run('closeModal()');
    assert.deepEqual(app.catches, [original]);
    assert.deepEqual(app.writes, []);

    const move = routeMove => list.dispatch('click', {
        target: { closest: () => ({ dataset: {
            routeMove, routeId: routeIdFor(route), neighborId: routeIdFor('Alabastia/ Starter')
        } }) }
    });
    await move('move_up');
    assert.deepEqual(names().slice(0, 2), ['Neuer Routenname', 'Alabastia/ Starter']);
    await move('move_down');
    assert.deepEqual(names().slice(0, 2), ['Alabastia/ Starter', 'Neuer Routenname']);

    const newName = { value: '', focus() {} };
    const addForm = app.element('route-add-form');
    addForm.elements = { namedItem: () => newName };
    addForm.reset = () => { newName.value = ''; };
    assert.equal(addForm.hidden, true);
    app.element('route-add-open').dispatch('click');
    assert.equal(addForm.hidden, false);
    newName.value = 'Abgebrochener Ort';
    app.element('route-add-cancel').dispatch('click');
    assert.equal(addForm.hidden, true);
    assert.equal(newName.value, '');
    assert.equal(app.routeWrites.length, 3);
    app.element('route-add-open').dispatch('click');
    newName.value = 'Casino Evoli (300)';
    await addForm.dispatch('submit', { preventDefault() {} });
    assert.equal(newName.value, '');
    assert.equal(addForm.hidden, true);
    assert.equal(names().at(-1), 'Casino Evoli (300)');
    assert.equal(app.routeReads.length, 6);
    assert.deepEqual(app.routeWrites.map(fields => fields.p_action), ['rename', 'move_up', 'move_down', 'add']);
    assert.equal(app.routeWrites[1].p_expected_neighbor_id, routeIdFor('Alabastia/ Starter'));
    assert.doesNotMatch(list.innerHTML, /route:new-route-id/);
    assert.match(list.innerHTML, /data-route-delete="new-route-id"/);

    app.element('routes-container').dispatch('click', {
        target: { closest: () => ({ dataset: { catchRoute: 'new-route-id', catchPlayer: player } }) }
    });
    app.element('poke-name-input').value = 'Bisasam';
    await app.run('savePokemonData()');
    assert.equal(app.writes[0].route_id, 'new-route-id');
    assert.equal(app.writes[0].route_name, 'route:new-route-id');
});

test('only added routes show a delete menu; cancellation, rejection and repeated clicks are safe', async () => {
    const custom = { id: 'custom', name: 'Casino Evoli', legacy_key: 'route:custom', sort_position: 59 };
    const historical = { id: 'historical', name: 'Altort', legacy_key: 'route:historical', sort_position: 60, is_legacy: true };
    const routeRows = [...catalogRoutes, custom, historical];
    const canceled = await setup({ routeRows, confirmDelete: false });
    await canceled.start();
    const click = (app, button) => app.element('route-editor-list').dispatch('click', { target: { closest: () => button } });
    const remove = { dataset: { routeDelete: custom.id } };
    const panel = { hidden: true };
    const menu = {
        dataset: { routeMenu: '' }, nextElementSibling: panel,
        setAttribute: (name, value) => assert.deepEqual([name, value], ['aria-expanded', 'true'])
    };
    click(canceled, menu);
    assert.equal(panel.hidden, false);
    await click(canceled, remove);
    assert.match(canceled.confirmations[0], /Casino Evoli/);
    assert.deepEqual(canceled.routeWrites, []);

    const app = await setup({ routeRows });
    await app.start();
    const list = app.element('route-editor-list');
    assert.deepEqual([...list.innerHTML.matchAll(/data-route-delete="([^"]+)"/g)].map(match => match[1]), [custom.id]);
    await click(app, { dataset: { routeDelete: routeIdFor(route) } });
    assert.deepEqual(app.confirmations, []);
    app.setRpcError({ code: '23503' });
    await Promise.all([click(app, remove), click(app, remove)]);
    assert.deepEqual(app.routeWrites.map(fields => fields.p_route_id), [custom.id]);
    assert.match(app.element('routes-dialog-status').textContent, /Fängen oder einem Team/);
    assert.match(list.innerHTML, /Casino Evoli/);
    assert.equal(app.routeReads.length, 1);
    app.setRpcError(undefined);
    await click(app, remove);
    assert.doesNotMatch(list.innerHTML, /Casino Evoli/);
    assert.match(list.innerHTML, /Altort/);
    assert.equal(app.routeReads.length, 2);
    assert.deepEqual(app.writes, []);
});

test('route name drafts survive search and RPC failures; Escape discards and repeated submits are blocked', async () => {
    const app = await setup();
    await app.start();
    const list = app.element('route-editor-list');
    const search = app.element('route-editor-search');
    const input = { name: 'name', value: route, focus() {} };
    const button = { hidden: true };
    const form = {
        dataset: { routeId: routeIdFor(route) },
        elements: { namedItem: () => input },
        querySelector: () => button
    };
    input.form = form;
    const submit = () => list.dispatch('submit', { target: form, preventDefault() {} });
    await submit();
    assert.equal(app.routeWrites.length, 0);
    input.value = '  Route 1  ';
    list.dispatch('input', { target: input });
    assert.equal(button.hidden, true);
    input.value = 'Neuer Entwurf';
    list.dispatch('input', { target: input });
    assert.equal(button.hidden, false);
    search.value = '  ROUTE 1 ';
    search.dispatch('input');
    assert.match(list.innerHTML, /value="Neuer Entwurf"/);
    assert.doesNotMatch(list.innerHTML, /Casino Abra/);
    assert.match(list.innerHTML, /data-neighbor-id="route-id:Alabastia\/ Starter"/);
    assert.equal(app.routeReads.length, 1);

    app.setRpcError({ code: 'failure' });
    await Promise.all([submit(), submit()]);
    assert.equal(app.routeWrites.length, 1);
    assert.match(list.innerHTML, /value="Neuer Entwurf"/);
    assert.match(app.element('routes-dialog-status').textContent, /nicht bestätigt/);
    let prevented = false;
    list.dispatch('keydown', { key: 'Escape', target: input, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(input.value, route);
    assert.equal(button.hidden, true);
    search.value = '';
    search.dispatch('input');
    assert.equal((list.innerHTML.match(/class="route-editor-row/g) ?? []).length, 58);
    assert.doesNotMatch(list.innerHTML, /Neuer Entwurf/);
});

test('displays route-management failures, refreshes stale moves, and supports catalog retry', async () => {
    const original = caught(4, oldName);
    const app = await setup({ initialCatches: [original] });
    app.setRouteError({ code: 'fixture-error' });
    await app.start();
    assert.match(app.element('routes-status').textContent, /nicht geladen/);
    assert.equal(app.element('routes-editor').disabled, true);
    assert.match(app.element('routes-container').innerHTML, /Glumanda/);
    assert.doesNotMatch(app.element('routes-container').innerHTML, /data-catch-route=/);
    await app.open();
    assert.equal(app.element('pokemon-modal').classList.contains('hidden'), true);
    app.element('poke-name-input').value = 'Bisasam';
    await app.run('savePokemonData()');
    assert.deepEqual(app.catches, [original]);
    assert.deepEqual(app.writes, []);
    app.setRouteError(undefined);
    await app.element('routes-retry').dispatch('click');
    assert.equal(app.element('routes-editor').disabled, false);

    const rename = `saveRoute('rename', { p_route_id: '${routeIdFor(route)}', p_name: 'Name' })`;
    app.setRpcError({ code: '23505' });
    assert.equal(await app.run(rename), false);
    assert.match(app.element('routes-dialog-status').textContent, /bereits/);
    assert.equal(app.routeReads.length, 2);

    app.setRpcError({ code: '40001' });
    assert.equal(await app.run(`saveRoute('move_up', { p_route_id: '${routeIdFor(route)}' })`), false);
    assert.match(app.element('routes-dialog-status').textContent, /Reihenfolge/);
    assert.equal(app.routeReads.length, 3);

    app.setRpcError(undefined);
    app.setRouteError({ code: 'notice-after-save' });
    assert.equal(await app.run(rename), true);
    assert.match(app.element('routes-dialog-status').textContent, /gespeichert.*erneut/);
    assert.equal(app.element('routes-editor').disabled, true);
    assert.equal(app.element('routes-dialog-retry').hidden, false);
    app.setRouteError(undefined);
    await app.element('routes-dialog-retry').dispatch('click');
    assert.equal(app.element('routes-editor').disabled, false);
    assert.deepEqual(app.writes, []);
});

test('a Wipe shows archived duplicate catches and used historical routes without enabling catch edits', async () => {
    const legacy = { id: 'legacy-place', name: 'Historischer Ort', legacy_key: 'Alter Ort', sort_position: 59, is_legacy: true };
    const unused = { id: 'unused-place', name: 'Unbenutzter Sonderort', legacy_key: 'Sonderort', sort_position: 60, is_legacy: true };
    const history = { id: runId, title: 'Archivierter Wipe', outcome: 'WIPE', is_finished: true };
    const app = await setup({
        initialRuns: [history], routeRows: [...catalogRoutes, legacy, unused],
        initialCatches: [
            caught(4, oldName, { route_name: legacy.legacy_key, route_id: legacy.id, status: 'DEAD' }),
            caught(6, 'Charizard', { id: 'historic-duplicate', route_name: legacy.legacy_key, route_id: legacy.id, status: 'DEAD' })
        ]
    });
    await app.start();
    const cards = app.element('routes-container').innerHTML;
    assert.match(cards, /Historischer Ort[\s\S]*Glumanda[\s\S]*Glurak/);
    assert.doesNotMatch(cards, /Unbenutzter Sonderort|data-catch-route=/);
    await app.run('loadAndRenderHistory()');
    assert.match(app.element('run-history-cards').innerHTML, /Encounters: 1.*Dead: 1/);
    assert.match(app.element('run-history-cards').innerHTML, /Wipe/);
    await app.open(app.catches[0]);
    assert.equal(app.element('pokemon-modal').classList.contains('hidden'), true);
    assert.deepEqual(app.writes, []);
});

test('saving from a stale catch dialog stops if the run was finished in another tab', async () => {
    const original = caught(4, oldName);
    const app = await setup({ initialCatches: [original] });
    await app.start();
    await app.open(original);
    app.finishRun();
    app.element('poke-status-input').value = 'BOX';
    await app.run('savePokemonData()');
    assert.match(app.element('pokemon-save-error').textContent, /schreibgeschützt/);
    assert.deepEqual(app.writes, []);
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

test('renders German names and historical type badges only in the tracker, with safe legacy fallback', async () => {
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
    const cards = app.element('run-history-cards').innerHTML;
    assert.match(cards, /Encounters: 2 · Alive \/ Box: 2/);
    assert.doesNotMatch(history + cards, /Bisasam|Guardevoir|Flunkifer|Bulbasaur|Gardevoir|Mawile|img src|Pokémon anzeigen|<ul/);
    assert.doesNotMatch(history, /<details/);
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
