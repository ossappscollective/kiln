import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { bootCi, type CiBoot, run } from './ci-test-helpers.ts';
import { purgeOrphans } from './services/ci-runs.ts';
import { listEvents } from './services/events.ts';

// A run can be dispatched for several apps of one repository (docs/api/ci.md, "One run, several apps"). Fake GitHub only.

// biome-ignore lint/suspicious/noExplicitAny: responses are inspected loosely
type Json = Record<string, any>;

const twoApps = async (t: CiBoot) => {
  const a = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }], {
    identifier: 'com.acme.one',
  });
  const b = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }], {
    identifier: 'com.acme.two',
  });
  return { a, b };
};
const dispatch = (t: CiBoot, body: Json, workflow = 'ios.yml') =>
  t.call(t.owner, 'POST', `${t.base}/workflows/${workflow}/dispatches`, body);
const rows = async (t: CiBoot) =>
  (await t.db.query('SELECT run_ref, app_id FROM ci_run_apps ORDER BY app_id')).map((r) => [
    String(r.run_ref),
    String(r.app_id),
  ]);

dbTest(
  'dispatch accepts appIds, joins appId, stores one link per app and keeps the legacy column for the first',
  async (db) => {
    const t = await bootCi(db);
    const { a, b } = await twoApps(t);
    const res = await dispatch(t, { appIds: [a, b], inputs: { build_number: '241' } });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body.run.appIds, [a, b].sort());
    assert.equal(
      res.body.run.appId,
      res.body.run.appIds[0],
      'appId is the first app, for older clients',
    );
    assert.equal((await rows(t)).length, 2);
    const legacy = await db.query('SELECT app_id FROM workflow_runs');
    assert.equal(String(legacy[0]?.app_id), res.body.run.appId);

    // appId alone still works, and joins appIds without a duplicate.
    const one = await dispatch(t, { appId: a });
    assert.deepEqual(one.body.run.appIds, [a]);
    assert.equal(one.body.run.appId, a);
    const joined = await dispatch(t, { appId: b, appIds: [a, b] });
    assert.deepEqual(joined.body.run.appIds, [a, b].sort());
    const none = await dispatch(t, {});
    assert.deepEqual(none.body.run.appIds, []);
    assert.equal(none.body.run.appId, null);

    // The audit entry names the apps by id and the inputs by name only.
    const audits = (await t.auditActions()).filter((x) => x.action === 'ci.dispatch');
    const detail = JSON.parse(audits[0]?.detail ?? '{}');
    assert.deepEqual(detail.appIds, [a, b].sort());
    assert.deepEqual(detail.inputs, ['build_number']);
    // Ids and times are random digits: look for the value as a whole token, not as a substring.
    assert.ok(
      !/(^|[^0-9a-z-])241([^0-9a-z-]|$)/i.test(JSON.stringify(detail)),
      'an input value is never audited',
    );
  },
);

dbTest(
  'dispatch refuses an app that is unknown or not linked to the repository, before anything is sent',
  async (db) => {
    const t = await bootCi(db);
    const { a } = await twoApps(t);
    const other = await t.seedApp('ios', [], { repositoryId: null, identifier: 'com.acme.three' });
    const unknown = await dispatch(t, { appIds: [a, 'nope'] });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, 'app_not_found');
    assert.equal((await dispatch(t, { appIds: [a, other] })).body.error, 'app_repository_mismatch');
    assert.equal((await dispatch(t, { appIds: [] })).status, 400);
    assert.equal(
      (await dispatch(t, { appIds: Array.from({ length: 21 }, (_, i) => `x${i}`) })).status,
      400,
    );
    assert.equal(t.fake.dispatches.length, 0);
    assert.deepEqual(await rows(t), []);
  },
);

dbTest(
  'a run list for an app keeps its runs, runs of several apps and runs of no app, and drops runs of other apps only',
  async (db) => {
    const t = await bootCi(db);
    const { a, b } = await twoApps(t);
    const c = await t.seedApp('ios', [], { identifier: 'com.acme.four' });
    await dispatch(t, { appIds: [a, b] }, 'ios.yml');
    await dispatch(t, { appId: c }, 'ios.yml');
    await dispatch(t, {}, 'ios.yml');
    const list = async (query: string) =>
      ((await t.call(t.owner, 'GET', `${t.base}/workflows/runs?${query}`)).body.runs as Json[]).map(
        (r) => r.appIds as string[],
      );
    assert.equal((await list('')).length, 3);
    assert.deepEqual((await list(`appId=${a}`)).map((x) => x.length).sort(), [0, 2]);
    assert.deepEqual((await list(`appId=${b}`)).map((x) => x.length).sort(), [0, 2]);
    assert.deepEqual((await list(`appId=${c}`)).map((x) => x.length).sort(), [0, 1]);
  },
);

dbTest(
  'the running-now list can be narrowed to one app, and a limited token sees the runs of its apps and of no app',
  async (db) => {
    const t = await bootCi(db);
    const { a, b } = await twoApps(t);
    const c = await t.seedApp('ios', [], { identifier: 'com.acme.four' });
    await dispatch(t, { appIds: [a, b] });
    await dispatch(t, { appId: c });
    await dispatch(t, {});
    const sizes = async (query = '') =>
      ((await t.call(t.owner, 'GET', `/ci/runs/active${query}`)).body.runs as Json[])
        .map((r) => r.appIds.length)
        .sort();
    assert.deepEqual(await sizes(), [0, 1, 2]);
    assert.deepEqual(await sizes(`?appId=${a}`), [0, 2]);
    assert.deepEqual(await sizes(`?appId=${c}`), [0, 1]);
    assert.equal((await t.call(t.owner, 'GET', '/ci/runs/active?appId=')).status, 400);
  },
);

dbTest(
  'ci.run_started is one event per app of a run, each with its own app; a run of no app has none',
  async (db) => {
    const t = await bootCi(db);
    const { a, b } = await twoApps(t);
    t.fake.dispatchResult = { runId: '77', runUrl: 'https://github.com/acme/app/actions/runs/77' };
    await dispatch(t, { appIds: [a, b] });
    const events = (await listEvents(db, t.workspaceId, { since: 0 })).events.filter(
      (e) => e.type === 'ci.run_started',
    );
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.subject.appId).sort(), [a, b].sort());
    for (const e of events) {
      assert.equal(e.payload.runId, '77');
      assert.deepEqual([...(e.payload.appIds as string[])].sort(), [a, b].sort());
      assert.equal(e.payload.appId, e.subject.appId);
    }
  },
);

dbTest('a pending dispatch adopted by the real run keeps all its apps', async (db) => {
  const t = await bootCi(db);
  const { a, b } = await twoApps(t);
  const sent = await dispatch(t, { appIds: [a, b], inputs: { build_number: '250' } });
  assert.match(sent.body.run.id, /^pending-/);
  t.fake.runs = [run('900', { createdAt: Date.now() + 1000, startedAt: Date.now() + 1000 })];
  const res = await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
  const adopted = (res.body.runs as Json[]).find((r) => r.id === '900');
  assert.ok(adopted, 'the real run took the place of the placeholder');
  assert.deepEqual(adopted.appIds, [a, b].sort());
  assert.deepEqual(adopted.inputs, { build_number: '250' });
  assert.equal((await rows(t)).length, 2);
});

dbTest('a build is linked only to runs that count for its app', async (db) => {
  const t = await bootCi(db);
  const a = await t.seedApp(
    'ios',
    [
      { version: '2.4.0', build: '240' },
      { version: '2.5.0', build: '241' },
      { version: '2.6.0', build: '242' },
    ],
    { identifier: 'com.acme.one' },
  );
  const b = await t.seedApp(
    'ios',
    [
      { version: '2.4.0', build: '240' },
      { version: '2.5.0', build: '241' },
      { version: '2.6.0', build: '242' },
    ],
    { identifier: 'com.acme.two' },
  );
  const later = Date.now() + 60_000;
  // Run 901 was started for app A only, run 902 for both. Run 903 was started on GitHub (no app) and names build 242 in its title.
  await dispatch(t, { appId: a, inputs: { build_number: '240' } });
  await dispatch(t, { appIds: [a, b], inputs: { build_number: '241' } });
  t.fake.runs = [
    run('903', {
      displayTitle: 'Release 2.6.0 (build 242)',
      event: 'push',
      createdAt: later + 2000,
      startedAt: later + 2000,
      headSha: '3'.repeat(40),
    }),
    run('902', { createdAt: later + 1000, startedAt: later + 1000, headSha: '2'.repeat(40) }),
    run('901', { createdAt: later, startedAt: later, headSha: '1'.repeat(40) }),
  ];
  assert.equal(
    (await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`)).body.refreshed,
    true,
  );

  const runOf = async (appId: string) => {
    const list = (await t.call(t.owner, 'GET', `/apps/${appId}/builds`)).body.builds as Json[];
    return Object.fromEntries(list.map((x) => [x.buildNumber, x.link?.run?.id ?? null]));
  };
  assert.deepEqual(await runOf(a), { 240: '901', 241: '902', 242: '903' });
  // Run 901 was started for app A alone: it never links B's build 240, even though the number is the same.
  assert.deepEqual(await runOf(b), { 240: null, 241: '902', 242: '903' });
});

dbTest(
  'the apps of a run go with the run, and an app that is deleted leaves the links',
  async (db) => {
    const t = await bootCi(db);
    const { a, b } = await twoApps(t);
    await dispatch(t, { appIds: [a, b] });
    assert.equal((await rows(t)).length, 2);
    await db.execute('DELETE FROM app_releases WHERE app_id = ?', [b]);
    await db.execute('DELETE FROM apps WHERE id = ?', [b]);
    assert.ok((await purgeOrphans(db)) >= 1);
    assert.deepEqual(
      (await rows(t)).map((r) => r[1]),
      [a],
    );
    await db.execute('DELETE FROM workflow_runs');
    assert.deepEqual(await rows(t), [], 'cascade');
  },
);
