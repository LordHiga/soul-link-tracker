const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = new vm.Script(html.split('<script>').at(-1).split('</script>')[0]);
const probe = `<script>fixture</script><em data-probe="value">A&B's</em>`;
const escaped = '&lt;script&gt;fixture&lt;/script&gt;&lt;em data-probe=&quot;value&quot;&gt;A&amp;B&#039;s&lt;/em&gt;';

function setup(tables) {
    const elements = new Map();
    const writes = [];
    const radios = ['open', 'in progress', 'done', 'rejected'].map(value => ({ value, checked: false }));
    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            const events = new Map();
            elements.set(id, {
                value: '', innerHTML: '', textContent: '', children: [],
                classList: {
                    add: name => classes.add(name), remove: name => classes.delete(name),
                    contains: name => classes.has(name)
                },
                appendChild(child) { this.children.push(child); },
                querySelectorAll(selector) {
                    assert.equal(selector, 'button[data-edit-feedback]');
                    return [...this.innerHTML.matchAll(/<button type="button" data-edit-feedback/g)]
                        .map((_, index) => element('edit-' + index));
                },
                addEventListener(event, handler) { events.set(event, handler); },
                dispatch(event, details) { return events.get(event)(details); }
            });
        }
        return elements.get(id);
    }
    const client = {
        from(table) {
            const query = {
                select: () => query,
                eq: () => query,
                insert: async values => { writes.push({ table, action: 'insert', values: values[0] }); return {}; },
                update: values => { writes.push({ table, action: 'update', values }); return query; },
                delete: () => { writes.push({ table, action: 'delete' }); return query; },
                then(resolve, reject) { return Promise.resolve({ data: [...(tables[table] ?? [])] }).then(resolve, reject); }
            };
            return query;
        }
    };
    client.auth = { getSession: async () => ({ data: { session: null } }) };
    let ready;
    const context = vm.createContext({
        supabase: { createClient: () => client },
        window: { addEventListener: (_name, handler) => { ready = handler; } },
        document: {
            getElementById: element, createElement: () => ({}),
            querySelectorAll(selector) {
                assert.equal(selector, 'input[name="feedback-status"]');
                return radios;
            },
            querySelector(selector) {
                assert.equal(selector, 'input[name="feedback-status"]:checked');
                return radios.find(radio => radio.checked);
            }
        },
        alert() {}, confirm: () => true, console: { error: console.error }
    });
    script.runInContext(context);
    element('feedback-filter-type').value = 'ALL';
    return { element, writes, radios, context, run: code => vm.runInContext(code, context), start: () => ready() };
}

function assertTextOnly(markup) {
    assert.ok(markup.includes(escaped));
    assert.doesNotMatch(markup, /<script|<em data-probe|\bon(?:click|error)\s*=/i);
}

test('run titles, Pokémon and route names are text in history; the archive note uses textContent', async () => {
    const run = { id: 'fixture-run', title: probe, is_finished: true, finish_note: probe, outcome: 'WIPE' };
    const app = setup({ runs: [run], catches: [{ run_id: run.id, pokemon_name: probe, route_name: probe, player_name: 'Higa' }] });
    app.context.fixture = run;
    await app.run('loadAndRenderHistory()');
    const history = app.element('runs-overview-table-body').innerHTML;
    assertTextOnly(history);
    assert.equal(history.split(escaped).length - 1, 3);
    await app.run('loadedRuns = [fixture]; loadRoutesAndCatches = async () => {}; showRuns()');
    assert.equal(app.element('run-select').children[0].textContent, probe + ' [WIPE]');
    app.run('currentRunData = fixture; updateRunLockState()');
    assert.equal(app.element('banner-note').textContent, '"' + probe + '"');
});

test('feedback fields render as text and DOM click preserves the exact editable description', async () => {
    const description = probe + '\nzweite Zeile \\';
    const app = setup({ feedbacks: [{ id: probe, type: probe, owner: probe, description, status: probe }] });
    await app.run('loadFeedback()');
    const markup = app.element('feedback-list-container').innerHTML;
    assertTextOnly(markup);
    assert.equal(markup.split(escaped).length - 1, 3);
    app.element('edit-0').dispatch('click');
    assert.equal(app.element('feedback-id').value, probe);
    assert.equal(app.element('feedback-description').value, description);
    assert.equal(app.radios.find(radio => radio.value === 'open').checked, true);
    assert.equal(app.element('feedback-modal').classList.contains('hidden'), false);

    app.element('feedback-type').value = 'Bug';
    await app.run('saveFeedback()');
    assert.equal(app.writes[0].action, 'update');
    assert.equal(app.writes[0].values.description, description);
    app.run('openFeedbackModal(); currentUserName = "Fixture"');
    app.element('feedback-description').value = probe;
    await app.run('saveFeedback()');
    assert.equal(app.writes[1].action, 'insert');
    assert.equal(app.writes[1].values.description, probe);
    await app.run('deleteFeedback("fixture-id")');
    assert.equal(app.writes[2].action, 'delete');
});

test('route and team output escape quoted names and resolve sprites using only numeric IDs', async () => {
    const app = setup({});
    app.context.fixture = { [probe]: { Higa: { pokemon_name: probe, pokemon_id: probe, level: probe, status: 'ALIVE' } } };
    app.context.routeProbe = probe;
    app.run('KANTO_ROUTES.push(routeProbe); renderRoutes(fixture)');
    const tracker = app.element('routes-container').innerHTML;
    assertTextOnly(tracker);
    assert.ok(tracker.includes('data-catch-route="' + escaped + '"'));
    assert.ok(tracker.includes('alt="' + escaped + '"'));
    assert.match(tracker, /\/sprites\/pokemon\/0\.png/);

    const { renderTeamGrid } = await import('../lib/soul-link-team.mjs');
    const markup = renderTeamGrid([{ slot: 1, route_name: probe, pokemon: [
        { player_name: 'Higa', pokemon_id: probe, pokemon_name: probe }
    ] }], record => record.pokemon_name, () => [], app.run('escapeHtml'));
    assertTextOnly(markup);
    assert.ok(markup.includes('aria-label="Slot 1 · ' + escaped + '"'));
    assert.match(markup, /\/sprites\/pokemon\/0\.png/);
});

test('broken catch sprites use the fixed fallback only once', async () => {
    const app = setup({});
    await app.start();
    let marker = true;
    let writes = 0;
    const target = {
        tagName: 'IMG',
        hasAttribute: name => name === 'data-catch-sprite' && marker,
        removeAttribute: () => { marker = false; },
        set src(url) {
            assert.equal(url, 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/0.png');
            writes++;
        }
    };
    const routes = app.element('routes-container');
    routes.dispatch('error', { target });
    routes.dispatch('error', { target });
    assert.equal(writes, 1);
});
