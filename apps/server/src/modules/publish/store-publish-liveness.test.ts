import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { listRuns } from './publish-runs.ts';
import {
  DEFAULT_PUBLISH_CLAIM_TTL_MS,
  DEFAULT_PUBLISH_HEARTBEAT_MS,
  PROCESS_ID,
  PUBLISH_SILENT_AFTER_MS,
  reapDeadClaims,
  reapPreviousProcessClaims,
} from './publishing.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * A publish that runs says so honestly, and one that does not run does not say it does (docs/api/pending.md "Publishing now"): the
 * heartbeat is renewed while a step waits, what the step is doing is on the claim, a restart ends the claims of the process before it,
 * a silent claim becomes an interrupted run that blocks nothing, and a person can end one that is silent or has run too long.
 */

const TEXT = 'A freshly written description that nobody else would ever write';
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await condition()); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await condition(), 'the condition was not met in time');
};
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

async function boot(
  db: Parameters<typeof bootStaged>[0],
  options: { heartbeatMs?: number; stepTimeoutMs?: number; log?: (line: string) => void } = {},
) {
  const t = await bootStaged(db, {
    extra: {
      storePublish: {
        enabled: true,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
        ...(options.log === undefined ? {} : { log: options.log }),
      },
    },
  });
  const publish = (app: string, body: Record<string, unknown>) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish`, body);
  const plan = (app: string, steps?: unknown[]) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish/preview`, steps === undefined ? {} : { steps });
  const claim = async (app: string) =>
    (await db.query('SELECT * FROM store_publish_claims WHERE app_id = ?', [app]))[0];
  const poll = async () => (await t.call(t.owner, 'GET', '/pending/publishing')).body;
  return { ...t, publish, plan, claim, poll };
}
type Boot = Awaited<ReturnType<typeof boot>>;

const stageIos = async (t: StagedBoot, name = 'Weather') => {
  const app = await t.addApp('ios', name);
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'description', from: 'local', value: TEXT }))
      .status,
    200,
  );
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' }))
      .status,
    200,
  );
  return app;
};

/** A claim row as a dead (or live) process would have left it. */
const insertClaim = (
  db: Parameters<typeof bootStaged>[0],
  t: Boot,
  app: string,
  row: {
    claimAt: number;
    heartbeatAt?: number | null;
    instanceId?: string | null;
    steps?: string;
    current?: string | null;
    done?: number | null;
  },
) =>
  db.execute(
    `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at, steps, current_step, step_at, instance_id, heartbeat_at, steps_done)
     VALUES (?, 'ios', ?, 'publish', 'writing', 'u', ?, ?, ?, ?, ?, ?, ?)`,
    [
      app,
      t.workspaceId,
      row.claimAt,
      row.steps ?? '["push_draft","submit"]',
      row.current === undefined ? 'submit' : row.current,
      row.claimAt,
      row.instanceId ?? null,
      row.heartbeatAt ?? null,
      row.done ?? null,
    ],
  );

const interruptedRun = (runs: Awaited<ReturnType<typeof listRuns>>) =>
  runs.find((r) => r.results.some((x) => x.error === 'interrupted'));

dbTest(
  'the defaults: a heartbeat every 20 seconds, a dead process seen after 2 minutes',
  async () => {
    assert.equal(DEFAULT_PUBLISH_HEARTBEAT_MS, 20_000);
    assert.equal(DEFAULT_PUBLISH_CLAIM_TTL_MS, 120_000);
    assert.ok(DEFAULT_PUBLISH_CLAIM_TTL_MS >= DEFAULT_PUBLISH_HEARTBEAT_MS * 3);
  },
);

dbTest(
  'heartbeat: renewed by a timer while one step waits for the store, never moving the step start; stopped when the batch ends',
  async (db) => {
    const t = await boot(db, { heartbeatMs: 15 });
    const app = await stageIos(t);
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    const p = (await t.plan(app)).body.plan;
    assert.equal(p.confirmable, true, JSON.stringify(p.steps).slice(0, 400));
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    const first = await t.claim(app);
    assert.ok(first, 'the claim exists while the step waits');
    await until(
      async () => Number((await t.claim(app))?.heartbeat_at) > Number(first?.heartbeat_at),
    );
    const later = await t.claim(app);
    assert.equal(Number(later?.step_at), Number(first?.step_at), 'the step start does not move');
    assert.equal(later?.current_step, 'push_draft');
    assert.equal(later?.instance_id, PROCESS_ID, 'the claim names the process that owns it');
    const seen = (await t.poll()).apps[0].publishing;
    assert.equal(seen.heartbeatAt, Number(later?.heartbeat_at) || seen.heartbeatAt);
    assert.equal(seen.interruptible, false, 'a beating batch is not offered for ending');
    hold.open();
    const done = await running;
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(await t.claim(app), undefined);
    // The timer is stopped: nothing is written to a claim that is gone.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await t.claim(app), undefined);
  },
);

dbTest(
  'a long step is not a dead one: with a silent heartbeat window shorter than the step, only the timer keeps it live',
  async (db) => {
    const t = await boot(db, { heartbeatMs: 10 });
    const app = await stageIos(t);
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    const p = (await t.plan(app)).body.plan;
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    // Push the claim's own start and step times far into the past: only the heartbeat says it is alive.
    await db.execute(
      'UPDATE store_publish_claims SET claim_at = claim_at - ?, step_at = step_at - ? WHERE app_id = ?',
      [10 * DEFAULT_PUBLISH_CLAIM_TTL_MS, 10 * DEFAULT_PUBLISH_CLAIM_TTL_MS, app],
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await t.poll()).apps.length, 1, 'still reported as running');
    hold.open();
    assert.equal((await running).status, 200);
  },
);

dbTest(
  'detail: what the running step is doing is on the claim and in the poll, as a fixed word and two counts, and goes with the step',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    t.stores.ios.progressLines = [
      { phase: 'uploading_images', done: 12, total: 40 },
      { phase: 'processing_images', done: 12, total: 40 },
    ];
    const p = (await t.plan(app)).body.plan;
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    // The second line is the same step moving on to another phase: written at once, the first within the throttle.
    await until(
      async () => (await t.poll()).apps[0]?.publishing.detail?.phase === 'processing_images',
    );
    const seen = (await t.poll()).apps[0].publishing;
    assert.equal(seen.currentStep, 'push_draft');
    assert.deepEqual(
      { phase: seen.detail.phase, done: seen.detail.done, total: seen.detail.total },
      { phase: 'processing_images', done: 12, total: 40 },
    );
    assert.equal(typeof seen.detail.at, 'number');
    assert.doesNotMatch(JSON.stringify(seen), /\.png|description/);
    hold.open();
    assert.equal((await running).status, 200);
    assert.equal(await t.claim(app), undefined, 'the detail goes with the claim');
  },
);

dbTest(
  'detail: a phase that is not a known word is never written; the same phase is throttled',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    t.stores.ios.progressLines = [
      { phase: 'a token-shaped sk-secret-text' as never, done: 1, total: 2 },
      { phase: 'uploading_images', done: 1, total: 40 },
      { phase: 'uploading_images', done: 2, total: 40 },
      { phase: 'uploading_images', done: 3, total: 40 },
    ];
    const p = (await t.plan(app)).body.plan;
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    await until(async () => (await t.claim(app))?.detail !== null);
    const row = await t.claim(app);
    assert.doesNotMatch(String(row?.detail), /secret/);
    assert.equal(
      JSON.parse(String(row?.detail)).done,
      1,
      'three lines in a burst: the first is kept',
    );
    hold.open();
    assert.equal((await running).status, 200);
  },
);

dbTest(
  'restart: the claims of the process before are ended at start and kept as interrupted runs; this process keeps its own',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const mine = await stageIos(t, 'Mine');
    const now = Date.now();
    // The old process was alive a second ago: its heartbeat alone cannot tell it is gone.
    await insertClaim(db, t, app, {
      claimAt: now - 5000,
      heartbeatAt: now - 1000,
      instanceId: 'boot-before',
      done: 1,
    });
    await insertClaim(db, t, mine, {
      claimAt: now - 5000,
      heartbeatAt: now - 1000,
      instanceId: PROCESS_ID,
    });
    assert.equal(await reapPreviousProcessClaims(db, { now }), 1);
    assert.equal(await t.claim(app), undefined, 'the ghost is gone');
    assert.ok(await t.claim(mine), 'a claim of this process stays');
    assert.equal(await reapPreviousProcessClaims(db, { now }), 0, 'a second sweep finds nothing');
    const run = interruptedRun(await listRuns(db, { workspaceId: t.workspaceId, appId: app }));
    assert.ok(run, 'an interrupted run is kept');
    assert.equal(run.outcome, 'partial', 'the step that ended applied before is remembered');
    assert.deepEqual(
      run.results.map((r) => [r.type, r.status, r.error, r.outcome]),
      [
        ['push_draft', 'applied', undefined, undefined],
        ['submit', 'failed', 'interrupted', 'unknown'],
      ],
    );
    assert.match(
      run.results[1]?.message ?? '',
      /interrupted: the server restarted or lost the request/,
    );
    assert.equal(run.results[1]?.code, 'publish.interrupted');
    // Every screen says so: not publishing, and the failure is there.
    const poll = await t.poll();
    assert.deepEqual(
      poll.apps.map((a: any) => a.appId),
      [mine],
    );
    assert.equal(
      poll.lastPublish.find((x: any) => x.appId === app)?.lastPublish.results[1].error,
      'interrupted',
    );
  },
);

dbTest('restart: a claim of an older server (no boot id) is a ghost too', async (db) => {
  const t = await boot(db);
  const app = await stageIos(t);
  await insertClaim(db, t, app, {
    claimAt: Date.now() - 1000,
    instanceId: null,
    current: null,
    steps: '[]',
  });
  assert.equal(await reapPreviousProcessClaims(db, { now: Date.now() }), 1);
  const run = interruptedRun(await listRuns(db, { workspaceId: t.workspaceId, appId: app }));
  assert.equal(run, undefined, 'no step is known: nothing to name');
  const runs = await listRuns(db, { workspaceId: t.workspaceId, appId: app });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.outcome, 'failed');
});

dbTest(
  'a silent claim: read by the poll it becomes an interrupted run and is not reported; a heartbeat inside the window keeps it',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const now = Date.now();
    await insertClaim(db, t, app, {
      claimAt: now - 600_000,
      heartbeatAt: now - DEFAULT_PUBLISH_CLAIM_TTL_MS - 1000,
      instanceId: PROCESS_ID,
    });
    const poll = await t.poll();
    assert.deepEqual(poll.apps, []);
    assert.equal(poll.lastPublish[0].lastPublish.results[0].error, 'interrupted');
    assert.equal(await t.claim(app), undefined);
    // Alive: a heartbeat a moment ago, whatever the claim's age.
    await insertClaim(db, t, app, {
      claimAt: now - 600_000,
      heartbeatAt: now - 5000,
      instanceId: PROCESS_ID,
    });
    assert.equal(await reapDeadClaims(db, { now }), 0);
    assert.equal((await t.poll()).apps.length, 1);
  },
);

dbTest(
  'a ghost claim does not block a new publish: it is turned into an interrupted run and the new batch runs',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    await insertClaim(db, t, app, { claimAt: 1, heartbeatAt: null, instanceId: 'gone', done: 0 });
    const p = (await t.plan(app)).body.plan;
    assert.equal(p.confirmable, true, JSON.stringify(p.steps).slice(0, 400));
    const done = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(done.body.result.completed, true);
    const runs = await listRuns(db, { workspaceId: t.workspaceId, appId: app });
    assert.equal(runs.length, 2, 'the ghost run and the new one');
    assert.ok(interruptedRun(runs));
    assert.equal(runs[0]?.outcome, 'completed', 'the newest run is the one that went through');
    assert.equal(await t.claim(app), undefined);
  },
);

dbTest(
  'a live claim of this process is never taken over or ended by a read, and a second publish is refused',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    await insertClaim(db, t, app, {
      claimAt: Date.now() - 1000,
      heartbeatAt: Date.now(),
      instanceId: PROCESS_ID,
    });
    const refused = await t.publish(app, {
      planHash: 'a'.repeat(64),
      steps: [{ type: 'push_draft' }],
    });
    assert.equal(refused.body.error, 'publish_in_progress');
    assert.equal((await t.poll()).apps.length, 1);
    assert.ok(await t.claim(app));
  },
);

dbTest(
  'interrupt: a person ends a silent claim; a recent live one is refused; none is 404; the run says interrupted',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const url = `/apps/${app}/publish/interrupt`;
    assert.equal((await t.call(t.owner, 'POST', url)).status, 404, 'nothing runs');
    const now = Date.now();
    await insertClaim(db, t, app, {
      claimAt: now - 30_000,
      heartbeatAt: now - 2000,
      instanceId: PROCESS_ID,
    });
    const live = (await t.poll()).apps[0].publishing;
    assert.equal(live.interruptible, false);
    const refused = await t.call(t.owner, 'POST', url);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'still_running');
    assert.ok(await t.claim(app), 'a live batch is never stopped from here');
    // Silent for longer than the window but inside the time to live: the server offers it.
    await db.execute(
      'UPDATE store_publish_claims SET claim_at = ?, heartbeat_at = ?, step_at = ? WHERE app_id = ?',
      [
        now - PUBLISH_SILENT_AFTER_MS - 5000,
        now - PUBLISH_SILENT_AFTER_MS - 5000,
        now - PUBLISH_SILENT_AFTER_MS - 5000,
        app,
      ],
    );
    assert.equal((await t.poll()).apps[0].publishing.interruptible, true);
    const ended = await t.call(t.owner, 'POST', url);
    assert.equal(ended.status, 200, ended.text);
    assert.equal(ended.body.interrupted, true);
    assert.equal(await t.claim(app), undefined);
    const run = interruptedRun(await listRuns(db, { workspaceId: t.workspaceId, appId: app }));
    assert.ok(run);
    assert.equal(run.results[0]?.outcome, 'unknown');
    assert.deepEqual((await t.poll()).apps, []);
  },
);

dbTest(
  'interrupt: a claim that has run longer than any batch should is offered even while it beats',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const now = Date.now();
    await insertClaim(db, t, app, {
      claimAt: now - 16 * 60_000,
      heartbeatAt: now - 1000,
      instanceId: PROCESS_ID,
    });
    assert.equal((await t.poll()).apps[0].publishing.interruptible, true);
    assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/publish/interrupt`)).status, 200);
  },
);

dbTest('interrupt: a viewer cannot end a claim (it needs the right to publish)', async (db) => {
  const t = await boot(db);
  const app = await stageIos(t);
  const now = Date.now();
  await insertClaim(db, t, app, {
    claimAt: now - 16 * 60_000,
    heartbeatAt: now - 1000,
    instanceId: PROCESS_ID,
  });
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'POST', `/apps/${app}/publish/interrupt`)).status, 403);
  assert.ok(await t.claim(app));
});

dbTest(
  'a batch whose claim was ended by a person goes on and finishes cleanly (its writes find no claim and change nothing)',
  async (db) => {
    const lines: string[] = [];
    const t = await boot(db, { heartbeatMs: 10, log: (l) => lines.push(l) });
    const app = await stageIos(t);
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    const p = (await t.plan(app)).body.plan;
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    await db.execute('DELETE FROM store_publish_claims WHERE app_id = ?', [app]);
    await until(() => lines.some((l) => /its claim was ended by somebody else/.test(l)));
    hold.open();
    const done = await running;
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(await t.claim(app), undefined);
  },
);
