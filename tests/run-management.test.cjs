const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = new vm.Script(html.split('<script>').at(-1).split('</script>')[0]);
const date = '23.11.26 14:30';

function setup(initialRuns = []) {
    const runs = [...initialRuns];
    const elements = new Map();
    const alerts = [];
    const inserts = [];
    const updates = [];
    const controls = {};

    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            elements.set(id, {
                value: '',
                appendChild() {},
                replaceChildren() {},
                classList: {
                    add: name => classes.add(name),
                    remove: name => classes.delete(name),
                    contains: name => classes.has(name)
                }
            });
        }
        return elements.get(id);
    }

    const client = {
        from(table) {
            let payload, runId, operation;
            const query = {
                select: () => query,
                order: async () => controls.readError ? { error: controls.readError } : { data: [...runs] },
                eq(column, value) {
                    assert.equal(column, table === 'catches' ? 'run_id' : 'id');
                    runId = value;
                    return query;
                },
                or(filter) {
                    assert.equal(filter, 'is_finished.eq.false,is_finished.is.null');
                    return query;
                },
                insert(values) {
                    operation = 'insert';
                    payload = values;
                    inserts.push(values);
                    return query;
                },
                update(values) {
                    payload = values;
                    return query;
                },
                async single() {
                    if (operation !== 'insert') return { data: runs.find(run => run.id === runId) };
                    await controls.insertPending;
                    const inserted = { id: 'new-run', is_finished: false, ...payload };
                    runs.unshift(inserted);
                    return { data: inserted };
                },
                async maybeSingle() {
                    updates.push({ runId, payload });
                    const index = runs.findIndex(run => run.id === runId && !run.is_finished);
                    if (controls.noUpdatedRow || index === -1) return { data: null, error: null };
                    runs[index] = { ...runs[index], ...payload };
                    return { data: runs[index] };
                },
                then(resolve, reject) {
                    return Promise.resolve({ data: table === 'catches' ? [] : [...runs] }).then(resolve, reject);
                }
            };
            return query;
        }
    };

    const context = vm.createContext({
        supabase: { createClient: () => client },
        window: { addEventListener() {} },
        document: { getElementById: element, createElement: () => ({}) },
        alert: message => alerts.push(message)
    });
    script.runInContext(context);
    const run = code => vm.runInContext(code, context);
    element('new-run-title-input').value = '2';
    element('new-run-startdate-input').value = date;
    element('finish-outcome-input').value = 'WIPE';
    return { run, element, controls, inserts, updates, alerts, runs };
}

test('creates and selects the first run after a successful empty read', async () => {
    const app = setup();
    await app.run('loadRuns()');
    assert.equal(app.inserts.length, 1);
    assert.equal(app.inserts[0].title, '1');
    assert.equal(app.element('run-select').value, 'new-run');
});

test('run list read failure reports the error and preserves the current selection', async () => {
    const app = setup([{ id: 'existing', title: '1' }]);
    await app.run('loadRuns()');
    app.controls.readError = { message: 'mock read failure' };
    await app.run('loadRuns()');
    assert.equal(app.inserts.length, 0);
    assert.equal(app.element('run-select').value, 'existing');
    assert.match(app.alerts[0], /Run-Liste/);
});

test('selects the new run after a wipe and keeps the previous one in history', async () => {
    const app = setup([{ id: 'old-run', title: 'Alter Run', is_finished: true, outcome: 'WIPE' }]);
    await app.run('loadRuns()');
    await app.run('submitNewRun()');
    assert.equal(app.inserts[0].startdate, new Date(2026, 10, 23, 14, 30).toISOString());
    assert.equal(app.element('run-select').value, 'new-run');
    await app.run('loadAndRenderHistory()');
    assert.match(app.element('runs-overview-table-body').innerHTML, /Alter Run/);
    assert.match(app.element('runs-overview-table-body').innerHTML, /Wipe/);
});

test('confirmed finish archives the run captured when the dialog was opened', async () => {
    const app = setup([{ id: 'first', title: 'Erster Run' }, { id: 'second', title: 'Zweiter Run' }]);
    await app.run('loadRuns()');
    app.run('openFinishRunModal()');
    app.element('run-select').onchange({ target: { value: 'second' } });
    app.element('finish-enddate-input').value = date;
    await app.run('finishRun()');
    assert.equal(app.updates[0].runId, 'first');
    assert.equal(app.updates[0].payload.enddate, new Date(2026, 10, 23, 14, 30).toISOString());
    assert.equal(app.runs[0].is_finished, true);
    assert.equal(app.element('finish-run-modal').classList.contains('hidden'), true);
    assert.equal(app.element('run-select').value, 'second');
    await app.run('loadAndRenderHistory()');
    assert.match(app.element('runs-overview-table-body').innerHTML, /Wipe/);
});

test('history preserves saved outcomes, including unknown and missing completion types', async () => {
    const app = setup([
        { id: 'active', title: 'Aktiv', is_finished: false },
        { id: 'wipe', title: 'Alte Niederlage', is_finished: true, outcome: 'WIPE' },
        { id: 'winner', title: 'Alter Sieg', is_finished: true, outcome: 'WON' },
        { id: 'other', title: 'Anderer Abschluss', is_finished: true, outcome: '<em>Abbruch</em>' },
        { id: 'unknown', title: 'Unbekannter Abschluss', is_finished: true }
    ]);
    await app.run('loadAndRenderHistory()');
    const rows = app.element('runs-overview-table-body').innerHTML;
    const cards = app.element('run-history-cards').innerHTML;
    for (const markup of [rows, cards]) {
        assert.match(markup, /Laufend/);
        assert.match(markup, /Champ/);
        assert.match(markup, /Abgeschlossen/);
        assert.match(markup, /&lt;em&gt;Abbruch&lt;\/em&gt;/);
        assert.equal((markup.match(/>Wipe</g) ?? []).length, 1);
    }
    assert.equal((cards.match(/<details class=/g) ?? []).length, 5);
    assert.doesNotMatch(cards, /<details[^>]*\sopen[\s=>]/);
});

test('finish without an updated row leaves the dialog open and reports failure', async () => {
    const app = setup([{ id: 'first', title: '1', is_finished: false }]);
    await app.run('loadRuns()');
    app.run('openFinishRunModal()');
    app.controls.noUpdatedRow = true;
    await app.run('finishRun()');
    assert.equal(app.runs[0].is_finished, false);
    assert.equal(app.element('finish-run-modal').classList.contains('hidden'), false);
    assert.match(app.alerts[0], /Run-Abschluss konnte nicht bestätigt werden/);
});

test('invalid dates are rejected before either mutation', async () => {
    const app = setup([{ id: 'first', title: '1' }]);
    await app.run('loadRuns()');
    app.element('new-run-startdate-input').value = '31.02.26 12:00';
    await app.run('submitNewRun()');
    app.run('openFinishRunModal()');
    app.element('finish-enddate-input').value = '23.11.26 24:00';
    await app.run('finishRun()');
    assert.equal(app.inserts.length, 0);
    assert.equal(app.updates.length, 0);
    assert.equal(app.alerts.length, 2);
});

test('multiple clicks during creation send one insert and re-enable the button', async () => {
    const app = setup();
    let release;
    app.controls.insertPending = new Promise(resolve => { release = resolve; });
    const pending = app.run('submitNewRun()');
    assert.equal(app.element('create-run-btn').disabled, true);
    await app.run('submitNewRun()');
    assert.equal(app.inserts.length, 1);
    release();
    await pending;
    assert.equal(app.element('create-run-btn').disabled, false);
});
