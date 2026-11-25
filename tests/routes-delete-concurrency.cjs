// Run only after routes-delete.fixture.sql in a disposable localhost cluster.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const port = process.argv[2];
assert.match(port ?? '', /^[0-9]{1,5}$/);

function sql(query, application = 'route-delete-probe') {
    return new Promise(resolve => {
        execFile('psql', ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
            '-h', '127.0.0.1', '-p', port, '-U', 'routes_fixture', '-d', 'postgres', '-c', query],
        { env: { ...process.env, PGAPPNAME: application }, timeout: 12000, windowsHide: true },
        (error, stdout, stderr) => resolve({ error, stdout: stdout.trim(), stderr }));
    });
}

async function check(query) {
    const result = await sql(query);
    assert.ifError(result.error);
    return result.stdout;
}

async function waitFor(query) {
    for (let attempt = 0; attempt < 60; attempt++) {
        if (await check(query) === 't') return;
        await delay(25);
    }
    assert.fail('The expected PostgreSQL wait did not occur');
}

async function race(first, second) {
    const winner = sql(`begin; ${first}; select pg_sleep(3); commit;`, 'route-delete-first');
    let rejected;
    try {
        await waitFor(`select exists (select from pg_stat_activity
            where application_name = 'route-delete-first' and wait_event = 'PgSleep')`);
        rejected = sql(second, 'route-delete-second');
        await waitFor(`select exists (select from pg_stat_activity
            where application_name = 'route-delete-second' and cardinality(pg_blocking_pids(pid)) > 0)`);
    } finally {
        const result = await winner;
        assert.ifError(result.error);
    }
    const result = await rejected;
    assert.ok(result.error, 'the blocked write must fail after the first transaction commits');
    assert.match(result.stderr, /23503/);
}

async function main() {
    assert.equal(await check(`select current_user = 'routes_fixture' and
        to_regprocedure('public.routes_fixture_assert(boolean,text)') is not null`), 't');
    assert.equal(await check("select count(*) from public.routes where name like 'Race % first'"), '3');
    const authenticated = 'set role authenticated;';
    const remove = name => `${authenticated} select public.delete_route(id) from public.routes where name = '${name}'`;
    const oldTabCatch = name => `${authenticated} insert into public.catches
        (run_id, route_name, player_name, status)
        select 1, legacy_key, 'Higa', 'BOX' from public.routes where name = '${name}'`;

    await race(oldTabCatch('Race catch first'), remove('Race catch first'));
    assert.equal(await check(`select count(*) from public.routes r join public.catches c on c.route_id = r.id
        where r.name = 'Race catch first'`), '1');
    console.log('PASS: a concurrent catch protects its route');

    await race(remove('Race delete first'), oldTabCatch('Race delete first'));
    assert.equal(await check("select count(*) from public.routes where name = 'Race delete first'"), '0');
    console.log('PASS: a concurrent old-tab catch cannot reference a deleted route');

    await race(`insert into soul_link_team_private.exclusions (run_id, route_name)
        select 1, legacy_key from public.routes where name = 'Race exclusion first'`, remove('Race exclusion first'));
    assert.equal(await check(`select count(*) from public.routes r
        join soul_link_team_private.exclusions e on e.route_name = r.legacy_key where r.name = 'Race exclusion first'`), '1');
    console.log('PASS: a concurrent exclusion protects its route');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
