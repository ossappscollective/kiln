import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { bootCi, type CiBoot } from './ci-test-helpers.ts';

// The release pipeline read: stored facts only, so there is no GitHub and no store call (docs/api/release-pipeline.md).

// biome-ignore lint/suspicious/noExplicitAny: responses are inspected loosely
type Json = Record<string, any>;
const HOUR = 3_600_000;

const setVersion = (t: CiBoot, appId: string, fields: { status?: string; since?: number }) =>
  t.db.execute(
    'UPDATE app_releases SET status = ?, raw_state = ?, status_since = ? WHERE app_id = ?',
    [fields.status ?? 'draft', 'PREPARE_FOR_SUBMISSION', fields.since ?? Date.now(), appId],
  );
const seedBuild = (
  t: CiBoot,
  appId: string,
  number: string,
  uploadedAt: number,
  platform = 'ios',
) =>
  t.db.execute(
    `INSERT INTO app_builds (app_id, platform, build_number, workspace_id, store_id, version, processing_state, raw_state, expired, uploaded_at, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, '2.4.0', 'processed', 'VALID', 0, ?, ?, ?)`,
    [appId, platform, number, t.workspaceId, `b-${number}`, uploadedAt, uploadedAt, uploadedAt],
  );

dbTest(
  'pipeline: a draft with its build for longer than the threshold is a stall, with the evidence in ids and times',
  async (db) => {
    const t = await bootCi(db);
    const app = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
    const now = Date.now();
    await setVersion(t, app, { since: now - 10 * HOUR });
    await seedBuild(t, app, '240', now - 12 * HOUR);

    const res = await t.call(t.owner, 'GET', `/apps/${app}/release/pipeline`);
    assert.equal(res.status, 200);
    const p = (res.body as Json).pipeline;
    assert.equal(p.state, 'draft');
    assert.equal(p.waitingOn, 'you');
    assert.equal(p.stalledAfterHours, 6);
    assert.equal(p.stalled.step, 'draft');
    assert.equal(p.stalled.key, 'draft:2.4.0');
    assert.equal(p.stalled.stale, false);
    assert.match(p.stalled.message, /2\.4\.0/);
    assert.ok(p.stalled.evidence.some((e: Json) => e.kind === 'version' && e.id === '2.4.0'));
    assert.ok(p.stalled.evidence.some((e: Json) => e.kind === 'build' && e.id === '240'));
    assert.equal(p.steps.length, 5);
    assert.equal(res.body.app.id, app);
    assert.equal(t.fake.count('listCiRuns'), 0, 'no GitHub call');
  },
);

dbTest(
  'pipeline: a row from before the sync recorded the time falls back to its last sync',
  async (db) => {
    const t = await bootCi(db);
    const app = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
    // seedApp rows have status_since NULL and synced_at 5 (long ago): that is the lower bound for the version, so the stall
    // began when the later thing moved, the upload of the build, and it is not stale.
    await t.db.execute(
      "UPDATE app_releases SET status = 'draft', raw_state = 'PREPARE_FOR_SUBMISSION' WHERE app_id = ?",
      [app],
    );
    await seedBuild(t, app, '240', Date.now() - 12 * HOUR);
    const p = (await t.call(t.owner, 'GET', `/apps/${app}/release/pipeline`)).body.pipeline;
    assert.equal(p.state, 'draft');
    assert.equal(p.stalled.stale, false);
    assert.ok(p.stalled.hours >= 11 && p.stalled.hours <= 12);
  },
);

dbTest(
  'pipeline: release.stalledAfterHours 0 turns the signal off; a longer threshold waits',
  async (db) => {
    const t = await bootCi(db);
    const app = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
    await setVersion(t, app, { since: Date.now() - 10 * HOUR });
    await seedBuild(t, app, '240', Date.now() - 12 * HOUR);
    assert.equal(
      (await t.call(t.owner, 'PUT', '/settings', { 'release.stalledAfterHours': 24 })).status,
      200,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${app}/release/pipeline`)).body.pipeline.stalled,
      null,
    );
    assert.equal(
      (await t.call(t.owner, 'PUT', '/settings', { 'release.stalledAfterHours': 0 })).status,
      200,
    );
    const off = (await t.call(t.owner, 'GET', `/apps/${app}/release/pipeline`)).body.pipeline;
    assert.equal(off.stalled, null);
    assert.equal(off.state, 'draft', 'the state is still shown');
    assert.equal(
      (await t.call(t.owner, 'PUT', '/settings', { 'release.stalledAfterHours': 721 })).status,
      400,
    );
  },
);

dbTest(
  'pipeline: a failed run of the release workflow is the state of an app without a newer build',
  async (db) => {
    const t = await bootCi(db);
    const app = await t.seedApp('ios', [{ version: '2.3.0', build: '230', status: 'live' }]);
    const now = Date.now();
    await t.db.execute(
      `INSERT INTO workflow_runs
       (id, workspace_id, repository_id, app_id, run_id, workflow, workflow_path, status, conclusion, head_sha, branch, event, run_number, url, started_at, run_updated_at, synced_at)
     VALUES ('wr1', ?, ?, ?, '88', 'iOS release', '.github/workflows/ios.yml', 'completed', 'failure', ?, 'main', 'workflow_dispatch', 88, 'https://github.com/acme/app/actions/runs/88', ?, ?, ?)`,
      [
        t.workspaceId,
        t.repositoryId,
        app,
        '1'.repeat(40),
        now - 9 * HOUR,
        now - 8 * HOUR,
        now - 8 * HOUR,
      ],
    );
    await t.db.execute(
      'INSERT INTO ci_run_apps (run_ref, app_id, workspace_id, created_at) VALUES (?, ?, ?, ?)',
      ['wr1', app, t.workspaceId, now - 9 * HOUR],
    );
    const p = (await t.call(t.owner, 'GET', `/apps/${app}/release/pipeline`)).body.pipeline;
    assert.equal(p.state, 'ci_failed');
    assert.equal(p.waitingOn, 'you');
    assert.ok(p.latest.run && p.latest.run.id === '88');
  },
);

dbTest(
  'pipeline: 404 for an unknown app and for a stranger; viewers may read; the summary lists stalled apps first and respects a token',
  async (db) => {
    const t = await bootCi(db);
    const viewer = await t.addMember('viewer');
    const stalled = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }], {
      identifier: 'com.acme.one',
    });
    const quiet = await t.seedApp(
      'android',
      [{ version: '2.4.0', build: '241', status: 'live', track: 'production' }],
      { identifier: 'com.acme.two' },
    );
    await setVersion(t, stalled, { since: Date.now() - 10 * HOUR });
    await seedBuild(t, stalled, '240', Date.now() - 12 * HOUR);

    assert.equal((await t.call(t.owner, 'GET', '/apps/nope/release/pipeline')).status, 404);
    assert.equal((await t.call(viewer, 'GET', `/apps/${stalled}/release/pipeline`)).status, 200);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.call(outsider, 'GET', `/apps/${stalled}/release/pipeline`)).status, 404);
    assert.equal((await t.call(outsider, 'GET', '/release/pipeline/summary')).status, 404);

    const sum = await t.call(t.owner, 'GET', '/release/pipeline/summary');
    assert.equal(sum.status, 200);
    assert.equal(sum.body.stalledAfterHours, 6);
    assert.equal(sum.body.apps[0].app.id, stalled, 'stalled apps come first');
    assert.equal(sum.body.apps[0].stalled.step, 'draft');
    assert.equal(sum.body.apps.length, 2);
    assert.equal(sum.body.totals.apps, 2);
    assert.equal(sum.body.totals.stalled, 1);
    assert.equal(sum.body.totals.byState.draft, 1);

    const made = await t.call(t.owner, 'POST', '/tokens', {
      name: 'CI',
      role: 'viewer',
      appIds: [quiet],
    });
    const token = made.body.token as string;
    const get = async (path: string) => {
      const r = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: r.status, body: (await r.json()) as Json };
    };
    const scoped = await get('/release/pipeline/summary');
    assert.equal(scoped.status, 200);
    assert.deepEqual(
      scoped.body.apps.map((a: Json) => a.app.id),
      [quiet],
    );
    assert.equal(scoped.body.totals.stalled, 0);
    assert.equal(
      (await get(`/apps/${stalled}/release/pipeline`)).status,
      404,
      'an app outside the token does not exist for it',
    );
    assert.equal((await get(`/apps/${quiet}/release/pipeline`)).status, 200);
  },
);
