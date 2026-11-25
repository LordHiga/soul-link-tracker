const assert = require('node:assert/strict');
const { test } = require('node:test');
const teamModule = import('../lib/soul-link-team.mjs');

function deferred() {
    let resolve, reject;
    const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
    return { promise, resolve, reject };
}

const snapshot = (route, finished = false) => ({
    initialized: true, finished, slots: route ? [{ slot: 1, route_name: route, pokemon: [] }] : [], candidates: []
});

test('switching runs clears old slots and ignores stale replies even when switching back', async () => {
    const { createTeamController } = await teamModule;
    const pending = [];
    let visible;
    const team = createTeamController(args => {
        const operation = deferred();
        pending.push({ ...operation, args });
        return operation.promise;
    }, state => { visible = state; });
    const first = team.select('old');
    const second = team.select('new');
    pending[1].resolve(snapshot('Route Neu'));
    await second;
    assert.equal(visible.data.slots[0].route_name, 'Route Neu');
    const third = team.select('old');
    assert.equal(visible.data, null);
    pending[0].resolve(snapshot('Nicht mehr gültig'));
    await first;
    assert.equal(visible.data, null);
    pending[2].resolve(snapshot('Route Alt, aktuell'));
    await third;
    assert.equal(visible.data.slots[0].route_name, 'Route Alt, aktuell');
});

test('a completed run never sends a mutation and preserves its saved team', async () => {
    const { createTeamController } = await teamModule;
    const requests = [];
    let visible;
    const team = createTeamController(async args => {
        requests.push(args);
        return snapshot('Historische Route', true);
    }, state => { visible = state; });
    await team.select('closed');
    await team.change('remove', { p_slot: 1, p_expected_route: 'Historische Route' });
    assert.equal(requests.length, 1);
    assert.equal(visible.data.slots[0].route_name, 'Historische Route');
});

test('a failed read or write is visible and never produces an optimistic change', async () => {
    const { createTeamController } = await teamModule;
    let mode = 'read error';
    let visible;
    const team = createTeamController(async args => {
        if (mode === 'read error' || args.p_action !== 'read') throw new Error('fixture failure');
        return snapshot('Route 1');
    }, state => { visible = state; });
    await team.select('active');
    assert.equal(visible.data, null);
    assert.match(visible.error, /nicht geladen/);
    mode = 'read success';
    await team.refresh();
    await team.change('remove', { p_slot: 1, p_expected_route: 'Route 1' });
    assert.equal(visible.data.slots[0].route_name, 'Route 1');
    assert.match(visible.error, /nicht bestätigt/);
    assert.equal(visible.saving, false);
});

test('a delayed read cannot overwrite a newer confirmed team change', async () => {
    const { createTeamController } = await teamModule;
    const delayedRead = deferred();
    let visible;
    let reading = 0;
    const team = createTeamController(async args => {
        if (args.p_action === 'replace') return snapshot('Route 2');
        return reading++ === 0 ? snapshot('Route 1') : delayedRead.promise;
    }, state => { visible = state; });
    await team.select('active');
    const refresh = team.refresh();
    await team.change('replace', { p_slot: 1, p_expected_route: 'Route 1', p_route: 'Route 2' });
    delayedRead.resolve(snapshot('Route 1'));
    await refresh;
    assert.equal(visible.data.slots[0].route_name, 'Route 2');
});

test('team controls display renamed routes and pass their original keys to the RPC', async () => {
    const { mountSoulLinkTeam } = await teamModule;
    const elements = new Map();
    const getElementById = id => {
        if (!elements.has(id)) {
            const events = new Map();
            elements.set(id, {
                addEventListener: (event, callback) => events.set(event, callback),
                dispatch: (event, details) => events.get(event)(details),
                showModal() { this.open = true; },
                close() { this.open = false; }
            });
        }
        return elements.get(id);
    };
    const state = snapshot('Alter Schlüssel');
    state.candidates = [{ route_name: 'Zweiter Schlüssel', pokemon: [] }];
    const requests = [];
    const labels = new Map([['Alter Schlüssel', 'Neuer Anzeigename'], ['Zweiter Schlüssel', 'Casino-Ort']]);
    const team = mountSoulLinkTeam({
        document: { getElementById },
        request: async payload => { requests.push(payload); return state; },
        displayName: () => '', getBadges: () => [], escape: String,
        routeLabel: key => labels.get(key) ?? key
    });
    await team.select('run');
    getElementById('team-manage').dispatch('click');
    const controls = getElementById('team-controls');
    assert.match(controls.innerHTML, /Slot 1 · Neuer Anzeigename/);
    assert.match(controls.innerHTML, /value="Zweiter Schlüssel">Casino-Ort/);
    assert.match(getElementById('team-grid').innerHTML, /aria-label="Slot 1 · Neuer Anzeigename"/);
    getElementById('team-candidate').value = 'Zweiter Schlüssel';
    controls.dispatch('click', { target: { closest: () => ({ dataset: { teamAction: 'add' } }) } });
    await Promise.resolve();
    controls.dispatch('click', { target: { closest: () => ({ dataset: { teamAction: 'remove', slot: '1' } }) } });
    assert.deepEqual(requests, [
        { p_run_id: 'run', p_action: 'read' },
        { p_run_id: 'run', p_action: 'add', p_route: 'Zweiter Schlüssel' },
        { p_run_id: 'run', p_action: 'remove', p_route: null, p_slot: 1, p_expected_route: 'Alter Schlüssel' }
    ]);
});

test('the responsive grid holds six aligned rows for Higa, Eike and Ruffy, with catalog labels and no stats', async () => {
    const { renderTeamGrid } = await teamModule;
    const { getPokemonDisplayName, getPokemonTypeBadges } = await import('../lib/pokemon-catalog-display.mjs');
    const catalog = new Map([
        [1, { name_de: 'Bisasam', type_primary: 'grass', type_secondary: 'poison' }],
        [4, { name_de: 'Glumanda', type_primary: 'fire' }],
        [9, { name_de: 'Turtok', type_primary: 'water' }]
    ]);
    const escape = value => value.replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const caught = (player_name, pokemon_id) => ({ player_name, pokemon_id, level: 91, status: 'ALIVE' });
    const starter = { slot: 1, route_name: '<Route>', pokemon: [caught('Ruffy', 9), caught('Higa', 1), caught('Eike', 4)] };
    const html = renderTeamGrid([starter], pokemon => getPokemonDisplayName(pokemon, catalog),
        id => getPokemonTypeBadges(catalog.get(id)), escape);
    assert.equal((html.match(/grid h-14 grid-cols-3 gap-1 sm:gap-2 lg:h-9/g) || []).length, 6);
    assert.equal((html.match(/aria-label="Slot [2-6], leer"/g) || []).length, 15);
    assert.match(html, /Bisasam.*Pflanze.*Gift.*Glumanda.*Feuer.*Turtok.*Wasser/s);
    assert.match(html, /min-w-0.*lg:grid-cols-\[[^\]]+\].*flex-wrap/s);
    assert.match(html, /&lt;Route>/);
    assert.doesNotMatch(html, /<Route>|ALIVE|Lvl|91/);
    const removed = renderTeamGrid([], () => assert.fail('removed Pokémon must not render'), () => [], escape);
    assert.equal((removed.match(/aria-label="Slot [1-6], leer"/g) || []).length, 18);
    for (let slot = 1; slot <= 6; slot++) {
        assert.equal(removed.split(`aria-label="Slot ${slot}, leer">Slot ${slot}</div>`).length - 1, 3);
    }
});
