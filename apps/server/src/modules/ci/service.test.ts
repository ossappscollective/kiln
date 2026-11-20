import assert from 'node:assert/strict';
import { GithubError, GithubRateLimitError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootCi, run, SHA_1, SHA_2, SHA_3 } from './test-helpers.ts';
import {
  CI_POLL_QUEUE,
  createCiPollHandler,
  dispatchRun,
  enqueueCiPoll,
  MIN_REFRESH_MS,
  pollDelayMs,
  refreshRuns,
} from './service.ts';
import {
  PENDING_DISPATCH_TTL_MS,
  pruneRuns,
  RUN_RETENTION_MS,
  storeRuns,
} from './runs.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { getRepository } from '../../services/repositories.ts';

// Everything here runs against a fake GitHub: no live GitHub call is ever made.

const INPUT_SECRET = 'release-notes-with-a-secret-value-7781';

const repositoryOf = async (t: Awaited<ReturnType<typeof bootCi>>) =>
  (await getRepository(t.db, t.workspaceId, t.repositoryId)) as NonNullable<
    Awaited<ReturnType<typeof getRepository>>
  >;
const ids = (runs: { id: string }[]) => runs.map((r) => r.id);

// ---------------------------------------------------------------------------------------------
// Rights and isolation

dbTest(
  'rights: viewers read stored runs and builds only; members read GitHub and dispatch',
  async (db) => {
    const t = await bootCi(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);

    assert.equal((await t.call(viewer, 'GET', `${t.base}/workflows/runs`)).status, 200);
    assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/builds`)).status, 200);
    for (const path of [
      `${t.base}/workflows`,
      `${t.base}/workflows/ios.yml/inputs`,
      `${t.base}/workflows/runs?refresh=true`,
      `/apps/${appId}/builds/changes?platform=ios&build=240`,
    ]) {
      assert.equal((await t.call(viewer, 'GET', path)).status, 403, path);
    }
    assert.equal(
      (await t.call(viewer, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {})).status,
      403,
    );
    assert.equal(
      (await t.call(viewer, 'PUT', `/apps/${appId}/builds/ios/240/link`, { runId: '1' })).status,
      403,
    );
    assert.equal(t.fake.calls.length, 0, 'a refused request never reaches GitHub');

    assert.equal((await t.call(member, 'GET', `${t.base}/workflows`)).status, 200);
    assert.equal(
      (await t.call(member, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {})).status,
      202,
    );
  },
);

dbTest('a non-member and an unknown repository get 404; no session gets 401', async (db) => {
  const t = await bootCi(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
  for (const [method, path, body] of [
    ['GET', `${t.base}/workflows`],
    ['GET', `${t.base}/workflows/runs`],
    ['POST', `${t.base}/workflows/ios.yml/dispatches`, {}],
    ['GET', `/apps/${appId}/builds`],
  ] as [string, string, unknown?][]) {
    const res = await t.call(outsider, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(res.body, { error: 'not_found' });
  }
  // The ids of one workspace are unknown in another, even to its owner.
  assert.equal(
    (await t.call(outsider, 'GET', `${t.base}/workflows/runs`, undefined, 'other')).status,
    404,
  );
  assert.equal(
    (await t.call(outsider, 'GET', `/apps/${appId}/builds`, undefined, 'other')).status,
    404,
  );
  assert.equal((await t.call(t.owner, 'GET', '/repositories/nope/workflows')).status, 404);
  assert.equal((await t.call(t.owner, 'GET', '/repositories/nope/workflows/runs')).status, 404);
  const anonymous = await t.app.request(`/api/workspaces/${t.workspaceId}${t.base}/workflows/runs`);
  assert.equal(anonymous.status, 401);
  assert.equal(t.fake.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Workflows

dbTest('lists the workflows of the repository and keeps the answer for a while', async (db) => {
  const t = await bootCi(db);
  const first = await t.call(t.owner, 'GET', `${t.base}/workflows`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    workflows: [
      { id: '1', name: 'iOS release', path: '.github/workflows/ios.yml', state: 'active' },
      { id: '2', name: 'Android release', path: '.github/workflows/android.yml', state: 'active' },
    ],
    cached: false,
  });
  const second = await t.call(t.owner, 'GET', `${t.base}/workflows`);
  assert.equal(second.body.cached, true);
  assert.equal(t.fake.count('listWorkflows'), 1);
  assert.ok(t.fake.signals[0], 'the read is cancellable');
  // Using the credential is audited, once: the second read came from the cache.
  const uses = (await t.auditActions()).filter(
    (a) => a.action === 'credential.use' && a.detail.includes('ci.workflows'),
  );
  assert.equal(uses.length, 1);
});

dbTest('workflow inputs are read from the workflow file and cached', async (db) => {
  const t = await bootCi(db);
  t.fake.files.set(
    '.github/workflows/ios.yml',
    'on:\n  workflow_dispatch:\n    inputs:\n      build_number:\n        required: true\n        description: Build number\n',
  );
  const res = await t.call(t.owner, 'GET', `${t.base}/workflows/ios.yml/inputs`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dispatchable, true);
  assert.equal(res.body.parsed, true);
  assert.equal(res.body.ref, 'main');
  assert.deepEqual(res.body.inputs, [
    { name: 'build_number', description: 'Build number', required: true, type: 'string' },
  ]);
  assert.equal(res.body.workflow.path, '.github/workflows/ios.yml');
  await t.call(t.owner, 'GET', `${t.base}/workflows/ios.yml/inputs`);
  assert.equal(t.fake.count('readFile'), 1);
  // By numeric id too.
  assert.equal(
    (await t.call(t.owner, 'GET', `${t.base}/workflows/1/inputs?ref=release%2F1.2`)).status,
    200,
  );

  const missing = await t.call(t.owner, 'GET', `${t.base}/workflows/nope.yml/inputs`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'workflow_not_found');
  assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows/..%2Fx/inputs`)).status, 400);
  assert.equal(
    (await t.call(t.owner, 'GET', `${t.base}/workflows/ios.yml/inputs?ref=a..b`)).status,
    400,
  );
});

dbTest('GitHub failures become the documented error codes', async (db) => {
  const t = await bootCi(db);
  t.fake.errors.workflows.push(
    new GithubError('forbidden', 'GitHub refused GET /actions/workflows', 403),
  );
  const denied = await t.call(t.owner, 'GET', `${t.base}/workflows`);
  assert.equal(denied.status, 422);
  assert.equal(denied.body.error, 'github_forbidden');
  t.fake.errors.workflows.push(new GithubRateLimitError(403, 'primary', 42));
  const limited = await t.call(t.owner, 'GET', `${t.base}/workflows`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '42');
  t.fake.errors.workflows.push(new GithubError('server', 'GitHub failed (500)', 500));
  assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows`)).status, 502);
  // Not cached after a failure.
  assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows`)).status, 200);
});

// ---------------------------------------------------------------------------------------------
// Dispatch

dbTest(
  'dispatch sends the inputs as text, stores a pending run, audits and queues ci.poll',
  async (db) => {
    const t = await bootCi(db);
    const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
    const res = await t.call(t.owner, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {
      ref: 'release/2.4',
      inputs: { build_number: 241, dry_run: false, notes: INPUT_SECRET },
      appId,
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.dispatched, true);
    assert.equal(res.body.runKnown, false);
    assert.deepEqual(t.fake.dispatches, [
      {
        workflow: 'ios.yml',
        ref: 'release/2.4',
        inputs: { build_number: '241', dry_run: 'false', notes: INPUT_SECRET },
      },
    ]);
    const stored = res.body.run;
    assert.match(stored.id, /^pending-/);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.active, true);
    assert.equal(stored.appId, appId);
    assert.equal(stored.branch, 'release/2.4');
    assert.deepEqual(stored.inputs, { build_number: '241', dry_run: 'false', notes: INPUT_SECRET });

    const audit = (await t.auditActions()).find((a) => a.action === 'ci.dispatch');
    assert.ok(audit);
    assert.equal(audit.actorType, 'user');
    assert.equal(audit.targetId, t.repositoryId);
    const detail = JSON.parse(audit.detail);
    assert.deepEqual(detail.inputs, ['build_number', 'dry_run', 'notes']);
    assert.equal(detail.ok, true);
    assert.ok(!audit.detail.includes(INPUT_SECRET), 'input values are never audited');

    const jobs = await db.query("SELECT queue, payload FROM jobs WHERE queue = 'ci.poll'");
    assert.equal(jobs.length, 1);
    assert.equal(JSON.parse(String(jobs[0]?.payload)).repositoryId, t.repositoryId);
  },
);

dbTest(
  'dispatch stores the run when GitHub names it, and the default ref is the default branch',
  async (db) => {
    const t = await bootCi(db);
    t.fake.dispatchResult = {
      runId: '555',
      runUrl: 'https://github.com/acme/app/actions/runs/555',
    };
    const res = await t.call(t.owner, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {});
    assert.equal(res.status, 202);
    assert.equal(res.body.runKnown, true);
    assert.equal(res.body.run.id, '555');
    assert.equal(res.body.run.status, 'queued');
    assert.equal(res.body.run.url, 'https://github.com/acme/app/actions/runs/555');
    assert.equal(t.fake.dispatches[0]?.ref, 'main');
    const stored = await t.call(t.owner, 'GET', `${t.base}/workflows/runs/555`);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.run.id, '555');
  },
);

dbTest('dispatch checks the request, the app, the rate limit and what GitHub says', async (db) => {
  const t = await bootCi(db, { limiter: createTestLimiter({ limit: 3 }) });
  const path = `${t.base}/workflows/ios.yml/dispatches`;
  assert.equal((await t.call(t.owner, 'POST', path, { ref: '-bad' })).status, 400);
  assert.equal((await t.call(t.owner, 'POST', path, { ref: 'a..b' })).status, 400);
  assert.equal((await t.call(t.owner, 'POST', path, { inputs: { 'bad key': 'x' } })).status, 400);
  assert.equal((await t.call(t.owner, 'POST', path, { inputs: { a: { nested: 1 } } })).status, 400);
  const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, 'v']));
  assert.equal((await t.call(t.owner, 'POST', path, { inputs: many })).status, 400);
  assert.equal(
    (await t.call(t.owner, 'POST', `${t.base}/workflows/bad%20name/dispatches`, {})).status,
    400,
  );
  assert.equal(t.fake.dispatches.length, 0);

  const unknownApp = await t.call(t.owner, 'POST', path, { appId: 'nope' });
  assert.equal(unknownApp.status, 422);
  assert.equal(unknownApp.body.error, 'app_not_found');
  const unlinked = await t.seedApp('ios', [], { repositoryId: null, identifier: 'com.acme.other' });
  assert.equal(
    (await t.call(t.owner, 'POST', path, { appId: unlinked })).body.error,
    'app_repository_mismatch',
  );
  assert.equal(t.fake.dispatches.length, 0, 'refused before the rate limit slot and GitHub');

  // GitHub refuses (no workflow_dispatch trigger): audited as a failure, nothing stored.
  t.fake.errors.dispatch.push(
    new GithubError('validation', "Workflow does not have 'workflow_dispatch' trigger", 422),
  );
  const refused = await t.call(t.owner, 'POST', path, {});
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'github_invalid');
  const failed = (await t.auditActions()).filter((a) => a.action === 'ci.dispatch');
  assert.equal(failed.length, 1);
  assert.equal(JSON.parse(failed[0]?.detail ?? '{}').ok, false);
  assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows/runs`)).body.runs.length, 0);

  // The refused one used a slot too: two more are allowed, the next is not (3 per minute).
  assert.equal((await t.call(t.owner, 'POST', path, {})).status, 202);
  assert.equal((await t.call(t.owner, 'POST', path, {})).status, 202);
  const limited = await t.call(t.owner, 'POST', path, {});
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

dbTest('a dispatch that times out says the workflow may have started', async (db) => {
  const t = await bootCi(db, {}, { repositoryTimeoutMs: 20 });
  t.fake.dispatchWorkflow = async () => new Promise(() => undefined);
  const res = await t.call(t.owner, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {});
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
  assert.match(res.body.message, /may still have started/);
  const audit = (await t.auditActions()).find((a) => a.action === 'ci.dispatch');
  assert.equal(JSON.parse(audit?.detail ?? '{}').code, 'timeout');
});

// ---------------------------------------------------------------------------------------------
// Runs

dbTest(
  'refreshing stores the runs, newest first, with status, branch, sha, url and timing',
  async (db) => {
    const t = await bootCi(db);
    t.fake.runs = [
      run('103', {
        status: 'in_progress',
        conclusion: undefined,
        headSha: SHA_3,
        displayTitle: 'Release 2.4.0 (build 241)',
        commitMessage: 'Third\n\nlong body',
      }),
      run('102', {
        name: 'Android release',
        path: '.github/workflows/android.yml',
        branch: 'release/2.3',
        conclusion: 'failure',
      }),
      run('101', { headSha: SHA_2 }),
    ];
    const res = await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
    assert.equal(res.status, 200);
    assert.equal(res.body.refreshed, true);
    assert.equal(typeof res.body.refreshedAt, 'number');
    assert.equal(res.body.active, 1);
    assert.deepEqual(ids(res.body.runs), ['103', '102', '101']);
    const [active, failed] = res.body.runs;
    assert.deepEqual(active, {
      id: '103',
      repositoryId: t.repositoryId,
      appId: null,
      appIds: [],
      workflow: 'iOS release',
      workflowPath: '.github/workflows/ios.yml',
      title: 'Release 2.4.0 (build 241)',
      status: 'in_progress',
      conclusion: null,
      active: true,
      headSha: SHA_3,
      commitMessage: 'Third',
      branch: 'main',
      event: 'workflow_dispatch',
      runNumber: 103,
      url: 'https://github.com/acme/app/actions/runs/103',
      inputs: null,
      dispatchedBy: null,
      startedAt: 1_800_000_000_103,
      updatedAt: 1_800_000_060_103,
      syncedAt: active.syncedAt,
    });
    assert.equal(failed.conclusion, 'failure');
    assert.equal(failed.active, false);

    // Filters and the limit read the stored rows.
    const filtered = await t.call(
      t.owner,
      'GET',
      `${t.base}/workflows/runs?workflow=android.yml&limit=5`,
    );
    assert.deepEqual(ids(filtered.body.runs), ['102']);
    assert.deepEqual(
      ids(
        (await t.call(t.owner, 'GET', `${t.base}/workflows/runs?branch=release%2F2.3`)).body.runs,
      ),
      ['102'],
    );
    assert.deepEqual(
      ids((await t.call(t.owner, 'GET', `${t.base}/workflows/runs?active=true`)).body.runs),
      ['103'],
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `${t.base}/workflows/runs?limit=1`)).body.runs.length,
      1,
    );
    assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows/runs?limit=0`)).status, 400);
    assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows/runs?limit=101`)).status, 400);
  },
);

dbTest(
  'reads of one repository are spaced out, and a changed run is updated in place',
  async (db) => {
    const clock = { now: 1_900_000_000_000 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const repository = await repositoryOf(t);
    const actor = { type: 'system' as const, id: 'test' };
    t.fake.runs = [run('201', { status: 'in_progress', conclusion: undefined })];

    const first = await refreshRuns(ctx, { workspaceId: t.workspaceId, repository }, actor);
    assert.ok(first.ok && first.refreshed);
    clock.now += MIN_REFRESH_MS - 1;
    const second = await refreshRuns(ctx, { workspaceId: t.workspaceId, repository }, actor);
    assert.ok(second.ok && !second.refreshed, 'asked again too soon: the stored rows are served');
    assert.equal(t.fake.count('listCiRuns'), 1);

    t.fake.runs = [run('201', { status: 'completed', conclusion: 'success' })];
    clock.now += 2;
    const forced = await refreshRuns(
      ctx,
      { workspaceId: t.workspaceId, repository, force: true },
      actor,
    );
    assert.ok(forced.ok && forced.refreshed);
    const rows = await db.query('SELECT status, conclusion FROM workflow_runs');
    assert.deepEqual(
      rows.map((r) => [r.status, r.conclusion]),
      [['completed', 'success']],
    );

    clock.now += MIN_REFRESH_MS;
    await refreshRuns(ctx, { workspaceId: t.workspaceId, repository }, actor);
    assert.equal(t.fake.count('listCiRuns'), 3);
  },
);

dbTest('two refreshes at once share one request', async (db) => {
  const t = await bootCi(db);
  t.fake.runs = [run('301')];
  const path = `${t.base}/workflows/runs?refresh=true`;
  const [a, b] = await Promise.all([t.call(t.owner, 'GET', path), t.call(t.owner, 'GET', path)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(t.fake.count('listCiRuns'), 1);
  assert.equal((await db.query('SELECT id FROM workflow_runs')).length, 1);
});

dbTest(
  'a stored run that fell off the first page is asked for by id, a deleted one is settled',
  async (db) => {
    const clock = { now: 1_900_000_000_000 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const repository = await repositoryOf(t);
    const actor = { type: 'system' as const, id: 'test' };
    t.fake.runs = [
      run('401', { status: 'in_progress', conclusion: undefined }),
      run('402', { status: 'queued', conclusion: undefined }),
    ];
    await refreshRuns(ctx, { workspaceId: t.workspaceId, repository, force: true }, actor);
    // The next page no longer lists 401 and 402; GitHub still knows 401 (now finished), not 402.
    const finished = run('401', { status: 'completed', conclusion: 'success' });
    t.fake.listCiRuns = async () => [run('403')];
    t.fake.getCiRun = async (id: string) => (id === '401' ? finished : undefined);
    await refreshRuns(ctx, { workspaceId: t.workspaceId, repository, force: true }, actor);
    const rows = await db.query(
      'SELECT run_id, status, conclusion FROM workflow_runs ORDER BY run_id',
    );
    assert.deepEqual(
      rows.map((r) => [r.run_id, r.status, r.conclusion]),
      [
        ['401', 'completed', 'success'],
        ['402', 'completed', 'unknown'],
        ['403', 'completed', 'success'],
      ],
    );
  },
);

dbTest(
  'one run: stored, read from GitHub when unknown (members), refreshed on request',
  async (db) => {
    const t = await bootCi(db);
    const viewer = await t.addMember('viewer');
    t.fake.runs = [run('501', { status: 'in_progress', conclusion: undefined })];

    assert.equal(
      (await t.call(viewer, 'GET', `${t.base}/workflows/runs/501`)).status,
      404,
      'a viewer never triggers a GitHub read',
    );
    assert.equal(t.fake.count('getCiRun'), 0);
    const read = await t.call(t.owner, 'GET', `${t.base}/workflows/runs/501`);
    assert.equal(read.status, 200);
    assert.equal(read.body.run.status, 'in_progress');
    assert.equal(t.fake.count('getCiRun'), 1);
    // Now stored: a viewer reads it, and no second GitHub call is made.
    assert.equal((await t.call(viewer, 'GET', `${t.base}/workflows/runs/501`)).body.run.id, '501');
    assert.equal(t.fake.count('getCiRun'), 1);
    assert.equal(
      (await t.call(viewer, 'GET', `${t.base}/workflows/runs/501?refresh=true`)).status,
      403,
    );

    t.fake.runs = [run('501', { status: 'completed', conclusion: 'cancelled' })];
    const fresh = await t.call(t.owner, 'GET', `${t.base}/workflows/runs/501?refresh=true`);
    assert.equal(fresh.body.run.conclusion, 'cancelled');
    assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows/runs/999`)).status, 404);
    assert.equal((await t.call(t.owner, 'GET', `${t.base}/workflows/runs/abc`)).status, 400);
  },
);

dbTest(
  'a dispatch without a run id is matched to the run that appears, keeping its inputs',
  async (db) => {
    const t = await bootCi(db);
    const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
    const res = await t.call(t.owner, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {
      inputs: { build_number: '240' },
      appId,
    });
    const pending = res.body.run;
    // A run of another workflow and a push run first, then ours.
    const later = Date.now() + 1_000;
    t.fake.runs = [
      run('601', {
        path: '.github/workflows/android.yml',
        name: 'Android release',
        createdAt: later,
      }),
      run('602', { event: 'push', createdAt: later }),
      run('603', {
        createdAt: later,
        startedAt: later,
        headSha: SHA_2,
        status: 'in_progress',
        conclusion: undefined,
      }),
    ];
    const list = await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
    assert.equal(list.status, 200);
    assert.ok(!ids(list.body.runs).includes(pending.id), 'the placeholder is gone');
    assert.equal(list.body.runs.length, 3);
    const adopted = list.body.runs.find((r: { id: string }) => r.id === '603');
    assert.deepEqual(adopted.inputs, { build_number: '240' });
    assert.equal(adopted.appId, appId);
    assert.notEqual(adopted.dispatchedBy, null);
    assert.equal(list.body.runs.find((r: { id: string }) => r.id === '601').inputs, null);
  },
);

dbTest(
  'pending dispatches expire; old finished runs are pruned unless a build link names them',
  async (db) => {
    const t = await bootCi(db);
    const base = { workspaceId: t.workspaceId, repositoryId: t.repositoryId };
    const at = 1_900_000_000_000;
    await db.execute(
      `INSERT INTO workflow_runs (id, workspace_id, repository_id, run_id, workflow, status, started_at, run_updated_at, synced_at)
     VALUES ('p1', ?, ?, 'pending-1', 'ios.yml', 'pending', ?, ?, ?)`,
      [t.workspaceId, t.repositoryId, at, at, at],
    );
    const kept = await storeRuns(db, { ...base, runs: [], now: at + PENDING_DISPATCH_TTL_MS - 1 });
    assert.equal(kept.expired, 0);
    const gone = await storeRuns(db, { ...base, runs: [], now: at + PENDING_DISPATCH_TTL_MS + 1 });
    assert.equal(gone.expired, 1);

    await storeRuns(db, { ...base, runs: [run('701'), run('702')], now: at });
    await db.execute(
      `INSERT INTO build_links (id, workspace_id, app_id, platform, build_number, repository_id, run_id, head_sha, source, linked_at)
     VALUES ('l1', ?, 'a', 'ios', '1', ?, '702', ?, 'manual', ?)`,
      [t.workspaceId, t.repositoryId, SHA_1, at],
    );
    const pruned = await pruneRuns(db, { ...base, now: at + RUN_RETENTION_MS + 1 });
    assert.equal(pruned, 1);
    assert.deepEqual(
      (await db.query('SELECT run_id FROM workflow_runs')).map((r) => r.run_id),
      ['702'],
    );
  },
);

// ---------------------------------------------------------------------------------------------
// ci.poll

dbTest(
  'ci.poll keeps polling with a growing delay while a run is active, then stops',
  async (db) => {
    const clock = { now: 1_900_000_000_000 };
    const t = await bootCi(db);
    const handler = createCiPollHandler(t.context(clock));
    const payload = {
      workspaceId: t.workspaceId,
      repositoryId: t.repositoryId,
      startedAt: clock.now,
      attempt: 0,
      requestedBy: 'u',
    };
    const job = { id: 'j', queue: CI_POLL_QUEUE, payload, attempts: 1 };
    const queued = async () =>
      (
        await db.query(
          "SELECT payload, run_at FROM jobs WHERE queue = 'ci.poll' AND status = 'queued' ORDER BY run_at",
        )
      ).map((r) => ({
        payload: JSON.parse(String(r.payload)),
        runAt: Number(r.run_at),
      }));

    t.fake.runs = [run('801', { status: 'in_progress', conclusion: undefined })];
    await handler(payload, job);
    let next = await queued();
    assert.equal(next.length, 1);
    assert.equal(next[0]?.payload.attempt, 1);
    assert.equal(next[0]?.runAt, clock.now + 15_000, 'first delay 15 seconds');
    await db.execute('DELETE FROM jobs');

    clock.now += 10_000;
    await handler({ ...payload, attempt: 3 }, job);
    next = await queued();
    assert.equal(next[0]?.runAt, clock.now + pollDelayMs(3));
    assert.equal(pollDelayMs(0), 15_000);
    assert.equal(pollDelayMs(3), 50_625);
    assert.equal(pollDelayMs(4), 60_000);
    assert.equal(pollDelayMs(30), 60_000, 'never longer than a minute');
    await db.execute('DELETE FROM jobs');

    // The run finishes: no further poll.
    t.fake.runs = [run('801', { status: 'completed', conclusion: 'success' })];
    clock.now += 20_000;
    await handler({ ...payload, attempt: 4 }, job);
    assert.deepEqual(await queued(), []);
    // The poll acted as the system and used the credential.
    const audits = await t.auditActions();
    assert.ok(
      audits.some(
        (a) =>
          a.action === 'credential.use' && a.actorType === 'system' && a.detail.includes('ci.poll'),
      ),
    );
  },
);

dbTest(
  'ci.poll gives up after its maximum duration, waits out a rate limit, retries a temporary failure',
  async (db) => {
    const clock = { now: 1_900_000_000_000 };
    const t = await bootCi(db);
    const handler = createCiPollHandler(t.context(clock, { pollMaxMs: 60_000 }));
    const start = clock.now;
    const payload = {
      workspaceId: t.workspaceId,
      repositoryId: t.repositoryId,
      startedAt: start,
      attempt: 0,
      requestedBy: 'u',
    };
    const job = { id: 'j', queue: CI_POLL_QUEUE, payload, attempts: 1 };
    const jobs = async () =>
      db.query("SELECT payload, run_at FROM jobs WHERE queue = 'ci.poll' AND status = 'queued'");
    t.fake.runs = [run('901', { status: 'queued', conclusion: undefined })];

    // A rate limit: the next poll waits for what GitHub says.
    t.fake.errors.runs.push(new GithubRateLimitError(403, 'primary', 30));
    await handler(payload, job);
    const waiting = await jobs();
    assert.equal(waiting.length, 1);
    assert.equal(Number(waiting[0]?.run_at), start + 30_000);
    await db.execute('DELETE FROM jobs');

    // A temporary failure throws, so the queue retries it with its own backoff.
    t.fake.errors.runs.push(new GithubError('server', 'GitHub failed (503)', 503));
    await assert.rejects(handler(payload, job), /GitHub failed/);
    assert.equal((await jobs()).length, 0);

    // A permanent failure is audited once and ends the chain without throwing.
    t.fake.errors.runs.push(new GithubError('auth', 'GitHub rejected the credentials', 401));
    await handler(payload, job);
    assert.equal((await jobs()).length, 0);
    const failed = (await t.auditActions()).filter((a) => a.action === 'ci.poll');
    assert.equal(failed.length, 1);
    assert.equal(JSON.parse(failed[0]?.detail ?? '{}').code, 'github_auth');

    // Past the maximum duration with the run still going: audited, not queued again.
    clock.now = start + 61_000;
    await handler(payload, job);
    assert.equal((await jobs()).length, 0);
    const ended = (await t.auditActions()).filter((a) => a.action === 'ci.poll');
    assert.equal(JSON.parse(ended[1]?.detail ?? '{}').ended, 'max_duration');
  },
);

dbTest(
  'ci.poll ignores a repository that is gone, and never queues two polls for one repository',
  async (db) => {
    const clock = { now: 1_900_000_000_000 };
    const t = await bootCi(db);
    const handler = createCiPollHandler(t.context(clock));
    const job = { id: 'j', queue: CI_POLL_QUEUE, payload: null, attempts: 1 };
    await handler(
      {
        workspaceId: t.workspaceId,
        repositoryId: 'gone',
        startedAt: clock.now,
        attempt: 0,
        requestedBy: 'u',
      },
      job,
    );
    await handler('not a payload', job);
    assert.equal(t.fake.calls.length, 0);

    const payload = {
      workspaceId: t.workspaceId,
      repositoryId: t.repositoryId,
      startedAt: clock.now,
      attempt: 0,
      requestedBy: 'u',
    };
    const ctx = { db, now: () => clock.now };
    assert.ok(await enqueueCiPoll(ctx, payload));
    assert.equal(await enqueueCiPoll(ctx, payload), undefined, 'one is already waiting');
    assert.ok(await enqueueCiPoll(ctx, { ...payload, repositoryId: 'another' }));
  },
);

dbTest(
  'dispatchRun is usable directly with an injected clock (audit time, run start)',
  async (db) => {
    const clock = { now: 1_950_000_000_000 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const done = await dispatchRun(
      ctx,
      {
        workspaceId: t.workspaceId,
        repositoryId: t.repositoryId,
        workflow: 'ios.yml',
        inputs: { a: '1' },
      },
      { type: 'user', id: 'u1' },
    );
    assert.ok(done.ok);
    assert.equal(done.run.startedAt, clock.now);
    const audit = await db.query(
      "SELECT created_at FROM audit_events WHERE action = 'ci.dispatch'",
    );
    assert.equal(Number(audit[0]?.created_at), clock.now);
  },
);
