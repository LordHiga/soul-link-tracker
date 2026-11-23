// The fixture SQL must have been applied to a fresh localhost database first.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const port = process.argv[2];
const database = process.argv[3] ?? 'postgres';
assert.match(port ?? '', /^[0-9]{1,5}$/);
assert.match(database, /^(postgres|team_fixture_[a-z0-9_]+)$/);

const authenticated = id => `set role authenticated; set request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000${id}';`;
const begin = "begin isolation level read committed; set local statement_timeout = '10s';";
const catchRun = 'public.team_fixture_run(2)';
const teamRun = 'public.team_fixture_run(3)';

function session(name) {
    const child = spawn('psql', [
        '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-h', '127.0.0.1', '-p', port,
        '-U', 'team_fixture', '-d', database
    ], { env: { ...process.env, PGAPPNAME: name }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise(resolve => {
        child.on('error', error => resolve({ error, code: -1, stdout, stderr }));
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
    return { child, done, output: () => stdout };
}

async function sql(statement, name = 'team_probe') {
    const connection = session(name);
    connection.child.stdin.end(statement);
    return connection.done;
}

async function until(check, message) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        if (await check()) return;
        await delay(50);
    }
    throw new Error(message);
}

async function race(firstSql, secondSql) {
    const first = session('team_holder');
    first.child.stdin.write(`${begin} ${authenticated(2)} ${firstSql}\nselect 'LOCK_READY';\n`);
    let second;
    try {
        await until(() => first.output().includes('LOCK_READY'), 'first transaction did not obtain the run lock');
        second = sql(`${begin} ${authenticated(3)} ${secondSql}\ncommit;\n`, 'team_contender');
        await until(async () => {
            const result = await sql(`select exists (select 1 from pg_stat_activity
                where application_name = 'team_contender' and wait_event_type = 'Lock');`);
            return result.stdout.trim() === 't';
        }, 'second transaction did not wait for the run lock');
    } finally {
        first.child.stdin.end('commit;\n');
    }
    const succeeded = await first.done;
    assert.equal(succeeded.code, 0, succeeded.stderr);
    return second;
}

async function simultaneousCatchInserts() {
    const players = ['Eike', 'Ruffy'];
    const connections = players.map(player => session(`team_catch_${player}`));
    for (const [index, connection] of connections.entries()) {
        connection.child.stdin.write(`${begin} ${authenticated(index + 2)}
            select id from public.runs where id = ${catchRun} for key share;
            select current_setting('transaction_isolation') || ' KEY SHARE READY';\n`);
    }
    let ready = false;
    try {
        // Both sessions must hold the FK-compatible lock before either trigger attempts to lock the run.
        await until(() => connections.every(connection => connection.output().includes('read committed KEY SHARE READY')),
            'both catch transactions must hold KEY SHARE under READ COMMITTED');
        ready = true;
    } finally {
        for (const [index, connection] of connections.entries()) {
            connection.child.stdin.end(ready ? `insert into public.catches (run_id, route_name, player_name, status)
                values (${catchRun}, 'Concurrent', '${players[index]}', 'ALIVE');\ncommit;\n` : 'rollback;\n');
        }
    }
    for (const result of await Promise.all(connections.map(connection => connection.done))) {
        assert.doesNotMatch(result.stderr, /40P01/);
        assert.equal(result.code, 0, result.stderr);
    }
}

(async () => {
    const guard = await sql(`select current_user = 'team_fixture'
      and to_regprocedure('public.team_fixture_assert(boolean,text)') is not null
      and (select count(*) from public.run_team_slots where run_id = ${catchRun}) = 0
      and (select count(*) from public.run_team_slots where run_id = ${teamRun}) = 5;`);
    assert.equal(guard.stdout.trim(), 't', 'Requires freshly seeded local test fixtures');

    await simultaneousCatchInserts();
    const caught = await sql(`select bool_and(status = 'ALIVE') and count(*) = 3 and count(distinct player_name) = 3
        and (select count(*) from public.run_team_slots where run_id = ${catchRun}) = 1
        and exists (select 1 from public.run_team_slots where run_id = ${catchRun} and slot = 1 and route_name = 'Concurrent')
        from public.catches where run_id = ${catchRun} and route_name = 'Concurrent';`);
    assert.equal(caught.stdout.trim(), 't');
    console.log('PASS: both concurrent catches commit without deadlock and produce one shared slot');

    const available = await sql(`select route_name from (select distinct route_name from public.catches where run_id = ${teamRun}) c
        where not exists (select 1 from public.run_team_slots s where s.run_id = ${teamRun} and s.route_name = c.route_name)
        order by route_name;`);
    const routes = available.stdout.trim().split(/\r?\n/);
    assert.equal(routes.length, 2);
    assert.ok(routes.every(route => /^Concurrent [1-7]$/.test(route)));
    const admit = route => `select public.soul_link_team(${teamRun}, 'add', '${route}');`;
    const addRace = await race(admit(routes[0]), admit(routes[1]));
    assert.notEqual(addRace.code, 0);
    assert.match(addRace.stderr, /Teambelegung hat sich/);
    const slots = await sql(`select count(*) from public.run_team_slots where run_id = ${teamRun};`);
    assert.equal(slots.stdout.trim(), '6');
    console.log('PASS: two competing additions cannot occupy one free slot or exceed capacity');

    const replace = `select public.soul_link_team(${teamRun}, 'replace', '${routes[1]}', 1::smallint, '${routes[0]}');`;
    const replaceRace = await race(replace, replace);
    assert.notEqual(replaceRace.code, 0);
    assert.match(replaceRace.stderr, /Slot hat sich geändert/);
    const replacement = await sql(`select route_name from public.run_team_slots where run_id = ${teamRun} and slot = 1;`);
    assert.equal(replacement.stdout.trim(), routes[1]);
    console.log('PASS: parallel replacements atomically preserve the slot and reject the stale request');

    const integrity = await sql(`select count(*) = 6 and count(distinct slot) = 6 and count(distinct route_name) = 6
        and count(*) filter (where route_name in (select soul_link_team_private.eligible_routes(${teamRun}))) = 6
        from public.run_team_slots where run_id = ${teamRun};`);
    assert.equal(integrity.stdout.trim(), 't');
})().catch(error => { console.error(error); process.exitCode = 1; });
