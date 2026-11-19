import assert from 'node:assert/strict';
import type { Database } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { addMember, auditActions, boot, registerOwner, seedWorkspace } from './testkit.ts';

/** 2027-01-10 12:00 UTC. */
const NOW = Date.UTC(2027, 0, 10, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

// biome-ignore lint/suspicious/noExplicitAny: responses are inspected loosely
type Json = Record<string, any>;

async function setup(db: Database) {
  const t = await boot(db);
  t.clock.now = NOW;
  const owner = await registerOwner(t.app);
  const call = async (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    workspace = owner.workspaceId,
  ) => {
    const res = await t.app.request(`/api/workspaces/${workspace}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Json };
  };
  const seedApp = async (
    workspaceId: string,
    platform: 'ios' | 'android',
    identifier: string,
  ): Promise<string> => {
    const id: string = crypto.randomUUID();
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', 0)`,
      [id, workspaceId, 'Acme', platform, identifier],
    );
    return id;
  };
  const androidId = await seedApp(owner.workspaceId, 'android', 'com.acme.app');
  const iosId = await seedApp(owner.workspaceId, 'ios', 'com.acme.app');
  const viewer = await addMember(t.app, owner, 'viewer@example.com', 'viewer');
  const member = await addMember(t.app, owner, 'member@example.com', 'member');
  const plan = async (appId: string, version = '2.0.0', cookie = owner.cookie) =>
    ((await call(cookie, 'POST', `/apps/${appId}/plans`, { version })).body.plan as Json)
      .id as string;
  const release = async (
    appId: string,
    platform: string,
    version: string,
    input: { status: string | null; fraction?: number; track?: string },
  ) =>
    db.execute(
      `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'raw', ?, ?)`,
      [
        crypto.randomUUID(),
        appId,
        owner.workspaceId,
        platform,
        version,
        input.track ?? '',
        input.status,
        input.fraction === undefined ? '{}' : JSON.stringify({ rolloutFraction: input.fraction }),
        NOW - 1000,
      ],
    );
  // Adding the viewer and the member wrote a member.added event each; the tests below count the plan's own events.
  const events = async (type?: string) =>
    (
      (await call(owner.cookie, 'GET', `/events?since=0${type ? `&type=${type}` : ''}`)).body
        .events as Json[]
    ).filter((e) => e.type !== 'member.added');
  return { ...t, owner, viewer, member, call, seedApp, androidId, iosId, plan, release, events };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const rolloutPath = (appId: string, planId: string, tail = '') =>
  `/apps/${appId}/plans/${planId}/rollout${tail}`;
const steps = (...percents: number[]) => percents.map((percent) => ({ percent }));
const put = (t: Setup, appId: string, planId: string, body: unknown, cookie = t.owner.cookie) =>
  t.call(cookie, 'PUT', rolloutPath(appId, planId), body);

// ---------------------------------------------------------------------------------------------
// Rights and isolation

dbTest(
  'rollout routes: viewers read, members write, outsiders and wrong apps get 404',
  async (db) => {
    const t = await setup(db);
    const planId = await t.plan(t.androidId);
    assert.equal(
      (await put(t, t.androidId, planId, { kind: 'steps', steps: steps(10, 100) })).status,
      200,
    );
    const first = (await t.call(t.owner.cookie, 'GET', rolloutPath(t.androidId, planId))).body
      .rollout.steps[0].id as string;

    for (const cookie of [t.viewer.cookie, t.member.cookie, t.owner.cookie]) {
      assert.equal((await t.call(cookie, 'GET', rolloutPath(t.androidId, planId))).status, 200);
    }
    const writes: [string, string, unknown][] = [
      ['PUT', rolloutPath(t.androidId, planId), { kind: 'steps', steps: steps(50) }],
      ['DELETE', rolloutPath(t.androidId, planId), undefined],
      ['POST', rolloutPath(t.androidId, planId, `/steps/${first}/complete`), {}],
      ['POST', rolloutPath(t.androidId, planId, `/steps/${first}/skip`), undefined],
      ['POST', rolloutPath(t.androidId, planId, `/steps/${first}/reopen`), undefined],
    ];
    for (const [method, path, body] of writes) {
      assert.equal(
        (await t.call(t.viewer.cookie, method, path, body)).status,
        403,
        `viewer ${method} ${path}`,
      );
    }
    // Nothing changed by the refused writes.
    const still = (await t.call(t.owner.cookie, 'GET', rolloutPath(t.androidId, planId))).body
      .rollout;
    assert.deepEqual(
      still.steps.map((s: Json) => [s.percent, s.status]),
      [
        [10, 'planned'],
        [100, 'planned'],
      ],
    );
    assert.equal(
      (
        await t.call(
          t.member.cookie,
          'POST',
          rolloutPath(t.androidId, planId, `/steps/${first}/complete`),
          {},
        )
      ).status,
      200,
    );

    // A non-member and an unknown workspace see nothing; the plan reached through another app is not found.
    const other = await seedWorkspace(db, 'Other', 'other@example.com', NOW);
    for (const [method, path, body] of [
      ...writes,
      ['GET', rolloutPath(t.androidId, planId), undefined] as [string, string, unknown],
    ]) {
      const outsider = await t.call(other.cookie, method, path, body, other.workspaceId);
      assert.equal(outsider.status, 404, `outsider ${method} ${path}`);
      assert.equal(
        (await t.call(t.owner.cookie, method, path, body, 'no-such-workspace')).status,
        404,
      );
      // The other workspace's owner cannot reach this workspace's plan by its own workspace id either.
      assert.equal((await t.call(other.cookie, method, path, body, other.workspaceId)).status, 404);
    }
    assert.equal((await t.call(t.owner.cookie, 'GET', rolloutPath(t.iosId, planId))).status, 404);
    assert.equal(
      (
        await t.call(t.owner.cookie, 'PUT', rolloutPath(t.iosId, planId), {
          kind: 'steps',
          steps: steps(100),
        })
      ).status,
      404,
    );
  },
);

dbTest('a plan of another workspace is never changed through this one', async (db) => {
  const t = await setup(db);
  const other = await seedWorkspace(db, 'Other', 'other@example.com', NOW);
  const theirApp = await t.seedApp(other.workspaceId, 'android', 'com.other.app');
  const theirs = await t.call(
    other.cookie,
    'POST',
    `/apps/${theirApp}/plans`,
    { version: '1.0.0' },
    other.workspaceId,
  );
  const theirPlan = theirs.body.plan.id as string;
  assert.equal(
    (
      await t.call(
        other.cookie,
        'PUT',
        rolloutPath(theirApp, theirPlan),
        { kind: 'steps', steps: steps(5, 100) },
        other.workspaceId,
      )
    ).status,
    200,
  );
  assert.equal(
    (await put(t, theirApp, theirPlan, { kind: 'steps', steps: steps(50) })).status,
    404,
  );
  const rollout = (
    await t.call(
      other.cookie,
      'GET',
      rolloutPath(theirApp, theirPlan),
      undefined,
      other.workspaceId,
    )
  ).body.rollout;
  assert.deepEqual(
    rollout.steps.map((s: Json) => s.percent),
    [5, 100],
  );
  const stepId = rollout.steps[0].id as string;
  assert.equal(
    (
      await t.call(
        t.owner.cookie,
        'POST',
        rolloutPath(theirApp, theirPlan, `/steps/${stepId}/complete`),
        {},
      )
    ).status,
    404,
  );
  // A step id of another plan of this workspace is not found either.
  const mine = await t.plan(t.androidId);
  await put(t, t.androidId, mine, { kind: 'steps', steps: steps(10, 100) });
  assert.equal(
    (
      await t.call(
        t.owner.cookie,
        'POST',
        rolloutPath(t.androidId, mine, `/steps/${stepId}/complete`),
        {},
      )
    ).status,
    404,
  );
});

// ---------------------------------------------------------------------------------------------
// Setting the plan

dbTest(
  'PUT stores steps, keeps ids on a second PUT, audits once, and the plan carries a summary',
  async (db) => {
    const t = await setup(db);
    const planId = await t.plan(t.androidId);
    const empty = (await t.call(t.owner.cookie, 'GET', rolloutPath(t.androidId, planId))).body
      .rollout;
    assert.equal(empty.planningOnly, true);
    assert.equal(empty.kind, null);
    assert.deepEqual(empty.steps, []);
    assert.equal(empty.summary, null);

    const plannedAt = new Date(NOW + 24 * HOUR).toISOString();
    const res = await put(t, t.androidId, planId, {
      kind: 'steps',
      template: 'builtin:play-default',
      steps: [
        { percent: 1, plannedAt },
        { percent: 5, note: 'watch crashes' },
        ...steps(20, 50, 100),
      ],
    });
    assert.equal(res.status, 200);
    const rollout = res.body.rollout;
    assert.equal(rollout.planningOnly, true);
    assert.equal(rollout.kind, 'steps');
    assert.equal(rollout.template, 'builtin:play-default');
    assert.deepEqual(
      rollout.steps.map((s: Json) => [s.position, s.percent, s.status]),
      [
        [1, 1, 'planned'],
        [2, 5, 'planned'],
        [3, 20, 'planned'],
        [4, 50, 'planned'],
        [5, 100, 'planned'],
      ],
    );
    assert.equal(rollout.steps[0].plannedAt, NOW + 24 * HOUR);
    assert.equal(rollout.steps[1].note, 'watch crashes');
    assert.equal(rollout.summary.total, 5);
    assert.equal(rollout.summary.next.percent, 1);
    assert.equal(rollout.store, null);

    // The same list again changes nothing and is not audited again; ids are kept.
    const again = await put(t, t.androidId, planId, {
      kind: 'steps',
      template: 'builtin:play-default',
      steps: rollout.steps.map((s: Json) => ({
        id: s.id,
        percent: s.percent,
        plannedAt: s.plannedAt,
        note: s.note,
      })),
    });
    assert.equal(again.status, 200);
    assert.deepEqual(
      again.body.rollout.steps.map((s: Json) => s.id),
      rollout.steps.map((s: Json) => s.id),
    );
    const audits = (await auditActions(db, t.owner.workspaceId)).filter(
      (a) => a.action === 'plan.rollout_set',
    );
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.detail?.percents, [1, 5, 20, 50, 100]);
    assert.equal(audits[0]?.actorId, t.owner.userId);

    // The plan and the plans list carry the short summary.
    const detail = (await t.call(t.owner.cookie, 'GET', `/apps/${t.androidId}/plans/${planId}`))
      .body.plan;
    assert.equal(detail.rollout.total, 5);
    assert.equal(detail.rollout.kind, 'steps');
    const list = (await t.call(t.owner.cookie, 'GET', '/plans')).body.plans as Json[];
    assert.equal(list.find((p) => p.id === planId)?.rollout.next.percent, 1);

    // Removing a step and changing the list works for open steps; DELETE clears everything.
    const removed = await put(t, t.androidId, planId, {
      kind: 'steps',
      steps: [{ id: rollout.steps[2].id, percent: 20 }, ...steps(100)],
    });
    assert.deepEqual(
      removed.body.rollout.steps.map((s: Json) => s.percent),
      [20, 100],
    );
    const cleared = await t.call(t.owner.cookie, 'DELETE', rolloutPath(t.androidId, planId));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.rollout.kind, null);
    assert.deepEqual(cleared.body.rollout.steps, []);
    assert.equal(
      (await t.call(t.owner.cookie, 'GET', `/apps/${t.androidId}/plans/${planId}`)).body.plan
        .rollout,
      null,
    );
    // Same clock tick, so only the set of actions is compared, not their order.
    assert.deepEqual(
      (await auditActions(db, t.owner.workspaceId))
        .map((a) => a.action)
        .filter((a) => a.startsWith('plan.rollout'))
        .sort(),
      ['plan.rollout_clear', 'plan.rollout_set', 'plan.rollout_set'],
    );
    assert.equal((await db.query('SELECT id FROM plan_rollout_steps')).length, 0);
  },
);

dbTest('validation answers 422 with a path per problem; bad shapes answer 400', async (db) => {
  const t = await setup(db);
  const planId = await t.plan(t.androidId);
  const bad = async (steps_: Json[], expect: RegExp, path?: string) => {
    const res = await put(t, t.androidId, planId, { kind: 'steps', steps: steps_ });
    assert.equal(res.status, 422, JSON.stringify(steps_));
    assert.equal(res.body.error, 'invalid_rollout');
    const issues = res.body.issues as { path: string; message: string }[];
    assert.ok(
      issues.some((i) => expect.test(i.message) && (path === undefined || i.path === path)),
      JSON.stringify(issues),
    );
  };
  await bad([], /at least one step/, 'steps');
  await bad(steps(...Array.from({ length: 13 }, (_, i) => i + 1)), /12 steps at most/);
  await bad(steps(10, 10), /higher than the one before/, 'steps.1.percent');
  await bad(steps(50, 20), /higher than the one before/);
  await bad(steps(0, 10), /whole number from 1 to 100/, 'steps.0.percent');
  await bad(steps(101), /whole number from 1 to 100/);
  await bad(steps(5.5), /whole number/);
  await bad(
    [{ percent: 10, plannedAt: NOW - 1 }],
    /after the plan was created/,
    'steps.0.plannedAt',
  );
  await bad(
    [
      { percent: 10, plannedAt: NOW + 5 * HOUR },
      { percent: 20, plannedAt: NOW + HOUR },
    ],
    /before the step above/,
    'steps.1.plannedAt',
  );
  await bad([{ percent: 10, note: 'a\nb' }], /One line/, 'steps.0.note');
  await bad([{ id: 'nope', percent: 10 }], /does not exist/, 'steps.0.id');
  // Exactly 12 steps are fine, and a step at 100 can be last.
  const twelve = await put(t, t.androidId, planId, {
    kind: 'steps',
    steps: steps(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50, 100),
  });
  assert.equal(twelve.status, 200);

  for (const body of [
    { kind: 'steps' },
    { kind: 'steps', steps: [{ percent: 'ten' }] },
    { kind: 'steps', steps: [{ percent: 10, plannedAt: 'tomorrow' }] },
    { kind: 'steps', steps: [{ percent: 10, status: 'done' }] },
    { kind: 'steps', steps: [{ percent: 10 }], extra: true },
    { kind: 'zigzag', steps: [] },
    [],
  ]) {
    const res = await put(t, t.androidId, planId, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'invalid_request');
  }
  assert.equal((await put(t, t.androidId, planId, 'not json')).status, 400);
  const huge = await put(
    t,
    t.androidId,
    planId,
    JSON.stringify({ kind: 'steps', steps: [{ percent: 10, note: 'x'.repeat(40_000) }] }),
  );
  assert.equal(huge.status, 413);
});

dbTest(
  'templates and platforms: Apple phased is informational, iOS cannot have custom percentages',
  async (db) => {
    const t = await setup(db);
    const androidPlan = await t.plan(t.androidId);
    const iosPlan = await t.plan(t.iosId);

    // Templates must exist and fit the app.
    const unknown = await put(t, t.androidId, androidPlan, {
      kind: 'steps',
      template: 'builtin:nope',
      steps: steps(100),
    });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, 'template_not_found');
    const wrongKind = await put(t, t.androidId, androidPlan, {
      kind: 'steps',
      template: 'builtin:apple-phased',
      steps: steps(100),
    });
    assert.equal(wrongKind.body.error, 'template_not_found');
    const immediate = await put(t, t.androidId, androidPlan, {
      kind: 'steps',
      template: 'builtin:immediate',
      steps: steps(100),
    });
    assert.equal(immediate.status, 200);

    // Apple's phased release is for iOS only.
    const onAndroid = await put(t, t.androidId, androidPlan, { kind: 'apple_phased' });
    assert.equal(onAndroid.status, 422);
    assert.equal(onAndroid.body.error, 'rollout_platform_mismatch');
    // iOS: custom percentages are refused (Apple's schedule is fixed), one step at 100% is fine.
    const custom = await put(t, t.iosId, iosPlan, { kind: 'steps', steps: steps(10, 100) });
    assert.equal(custom.status, 422);
    assert.equal(custom.body.error, 'rollout_platform_mismatch');
    assert.equal(
      (await put(t, t.iosId, iosPlan, { kind: 'steps', steps: steps(100) })).status,
      200,
    );

    const startsAt = new Date(Date.UTC(2027, 0, 12, 9, 0, 0)).toISOString();
    const apple = await put(t, t.iosId, iosPlan, {
      kind: 'apple_phased',
      template: 'builtin:apple-phased',
      startsAt,
    });
    assert.equal(apple.status, 200);
    const view = apple.body.rollout;
    assert.equal(view.kind, 'apple_phased');
    assert.deepEqual(view.steps, [], 'no editable steps');
    assert.deepEqual(
      view.apple.schedule.map((s: Json) => [s.day, s.percent]),
      [
        [1, 1],
        [2, 2],
        [3, 5],
        [4, 10],
        [5, 20],
        [6, 50],
        [7, 100],
      ],
    );
    assert.equal(view.apple.schedule[0].date, '2027-01-12');
    assert.equal(view.apple.schedule[6].date, '2027-01-18');
    assert.match(view.apple.note, /not read from the store/);
    assert.equal(view.comparison, null);
    assert.equal(view.summary.kind, 'apple_phased');
    // Day 1 before the plan existed is refused; steps cannot be changed on a phased plan.
    assert.equal(
      (await put(t, t.iosId, iosPlan, { kind: 'apple_phased', startsAt: NOW - 1 })).status,
      422,
    );
    const stepCall = await t.call(
      t.owner.cookie,
      'POST',
      rolloutPath(t.iosId, iosPlan, '/steps/x/complete'),
      {},
    );
    assert.equal(stepCall.status, 409);
    assert.equal(stepCall.body.error, 'no_rollout_steps');
  },
);

dbTest(
  'done steps are locked, nothing open may sit before a done step, switching needs them reopened',
  async (db) => {
    const t = await setup(db);
    const planId = await t.plan(t.androidId);
    const made = (await put(t, t.androidId, planId, { kind: 'steps', steps: steps(5, 20, 100) }))
      .body.rollout;
    const [a, b, c] = made.steps as Json[];
    assert.equal(
      (
        await t.call(
          t.owner.cookie,
          'POST',
          rolloutPath(t.androidId, planId, `/steps/${a?.id}/complete`),
          {},
        )
      ).status,
      200,
    );

    const changePercent = await put(t, t.androidId, planId, {
      kind: 'steps',
      steps: [
        { id: a?.id, percent: 6 },
        { id: b?.id, percent: 20 },
        { id: c?.id, percent: 100 },
      ],
    });
    assert.equal(changePercent.status, 422);
    assert.match(changePercent.body.issues[0].message, /keeps its percentage/);
    const dropDone = await put(t, t.androidId, planId, {
      kind: 'steps',
      steps: [{ id: b?.id, percent: 20 }, ...steps(100)],
    });
    assert.equal(dropDone.status, 422);
    assert.match(
      dropDone.body.issues.map((i: Json) => i.message).join(' '),
      /done and cannot be removed/,
    );
    // A new open step cannot be put before the one that is done.
    const before = await put(t, t.androidId, planId, {
      kind: 'steps',
      steps: [{ percent: 2 }, { id: a?.id, percent: 5 }, { id: b?.id, percent: 20 }],
    });
    assert.equal(before.status, 422);
    assert.match(
      before.body.issues.map((i: Json) => i.message).join(' '),
      /before a completed step/,
    );
    // Open steps after it can change, and a new one can be added after it.
    const ok = await put(t, t.androidId, planId, {
      kind: 'steps',
      steps: [{ id: a?.id, percent: 5 }, { id: b?.id, percent: 25 }, ...steps(60, 100)],
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      ok.body.rollout.steps.map((s: Json) => [s.percent, s.status]),
      [
        [5, 'done'],
        [25, 'planned'],
        [60, 'planned'],
        [100, 'planned'],
      ],
    );

    // Switching to the phased release needs the done steps reopened.
    const iosPlan = await t.plan(t.iosId);
    await put(t, t.iosId, iosPlan, { kind: 'steps', steps: steps(100) });
    const only = (await t.call(t.owner.cookie, 'GET', rolloutPath(t.iosId, iosPlan))).body.rollout
      .steps[0].id as string;
    await t.call(
      t.owner.cookie,
      'POST',
      rolloutPath(t.iosId, iosPlan, `/steps/${only}/complete`),
      {},
    );
    const blocked = await put(t, t.iosId, iosPlan, { kind: 'apple_phased' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'rollout_has_done_steps');
    await t.call(t.owner.cookie, 'POST', rolloutPath(t.iosId, iosPlan, `/steps/${only}/reopen`));
    assert.equal((await put(t, t.iosId, iosPlan, { kind: 'apple_phased' })).status, 200);
    assert.equal(
      (await db.query('SELECT id FROM plan_rollout_steps WHERE plan_id = ?', [iosPlan])).length,
      0,
    );
  },
);

// ---------------------------------------------------------------------------------------------
// Moving steps

dbTest('complete, skip and reopen: order rules, idempotence, audit and events', async (db) => {
  const t = await setup(db);
  const planId = await t.plan(t.androidId);
  const made = (await put(t, t.androidId, planId, { kind: 'steps', steps: steps(5, 20, 50, 100) }))
    .body.rollout;
  const ids = (made.steps as Json[]).map((s) => s.id as string);
  const act = (i: number, action: string, body?: unknown, cookie = t.owner.cookie) =>
    t.call(cookie, 'POST', rolloutPath(t.androidId, planId, `/steps/${ids[i]}/${action}`), body);

  // A rollout goes in order.
  const early = await act(1, 'complete');
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'earlier_steps_open');
  assert.equal((await t.events()).length, 0);

  t.clock.now = NOW + HOUR;
  const first = await act(0, 'complete', undefined, t.member.cookie);
  assert.equal(first.status, 200);
  assert.equal(first.body.rollout.planningOnly, true);
  assert.deepEqual(
    first.body.rollout.steps.map((s: Json) => s.status),
    ['done', 'planned', 'planned', 'planned'],
  );
  assert.equal(first.body.rollout.steps[0].doneAt, NOW + HOUR);
  assert.equal(first.body.rollout.steps[0].doneBy.id, t.member.userId);
  assert.equal(first.body.rollout.steps[0].doneSource, 'manual');
  assert.deepEqual(
    {
      current: first.body.rollout.summary.current,
      next: first.body.rollout.summary.next.percent,
      planPercent: first.body.rollout.summary.planPercent,
    },
    { current: { index: 1, percent: 5 }, next: 20, planPercent: 5 },
  );

  // Asking again changes nothing: no second audit entry and no second event.
  assert.equal((await act(0, 'complete')).status, 200);
  assert.equal((await t.events('plan.rollout_step_done')).length, 1);

  assert.equal((await act(1, 'skip')).status, 200);
  assert.equal((await act(1, 'skip')).status, 200);
  const skipDone = await act(0, 'skip');
  assert.equal(skipDone.status, 409);
  assert.equal(skipDone.body.error, 'invalid_transition');
  // With the step above skipped, the next can be completed; reopening the skipped one is refused while a later one is done.
  assert.equal((await act(2, 'complete')).status, 200);
  const reopenEarlier = await act(1, 'reopen');
  assert.equal(reopenEarlier.status, 409);
  assert.equal(reopenEarlier.body.error, 'later_steps_done');
  assert.equal((await act(2, 'reopen')).status, 200);
  assert.equal((await act(1, 'reopen')).status, 200);
  assert.equal((await act(9 as number, 'complete')).status, 404);

  const events = await t.events();
  assert.deepEqual(
    events.map((e) => e.type),
    [
      'plan.rollout_step_done',
      'plan.rollout_step_skipped',
      'plan.rollout_step_done',
      'plan.rollout_step_reopened',
      'plan.rollout_step_reopened',
    ],
  );
  assert.deepEqual(events[0]?.subject, { appId: t.androidId });
  assert.equal(events[0]?.payload.planId, planId);
  assert.equal(events[0]?.payload.stepId, ids[0]);
  assert.equal(events[0]?.payload.percent, 5);
  assert.equal(events[0]?.payload.index, 1);
  assert.equal(events[0]?.payload.total, 4);
  assert.equal(events[0]?.payload.source, 'manual');
  assert.deepEqual(events[0]?.payload.actor, { type: 'user', id: t.member.userId });
  assert.equal(JSON.stringify(events).includes('secret'), false);
  assert.equal(events[0]?.createdAt, NOW + HOUR);

  const audit = (await auditActions(db, t.owner.workspaceId)).filter((a) =>
    a.action.startsWith('plan.rollout_step'),
  );
  assert.deepEqual(audit.map((a) => a.action).sort(), [
    'plan.rollout_step_done',
    'plan.rollout_step_done',
    'plan.rollout_step_reopened',
    'plan.rollout_step_reopened',
    'plan.rollout_step_skipped',
  ]);
  const memberDone = audit.find(
    (a) => a.action === 'plan.rollout_step_done' && a.actorId === t.member.userId,
  );
  assert.ok(memberDone, 'the member who completed the step is the actor');
  assert.equal(memberDone.targetId, planId);
  assert.equal(memberDone.detail?.percent, 5);

  // A viewer's read of the events includes these (they need plans.read, which every role has).
  assert.equal(
    (
      (await t.call(t.viewer.cookie, 'GET', '/events?since=0&type=plan.rollout_step_done')).body
        .events as Json[]
    ).length,
    2,
  );

  // Bodies: empty or {} is fine, junk is 400, fromStore only on complete.
  assert.equal(
    (
      await t.call(
        t.owner.cookie,
        'POST',
        rolloutPath(t.androidId, planId, `/steps/${ids[2]}/skip`),
        'not json',
      )
    ).status,
    400,
  );
  assert.equal((await act(2, 'skip', { fromStore: true })).status, 400);
  assert.equal((await act(2, 'complete', { fromStore: 'yes' })).status, 400);
});

// ---------------------------------------------------------------------------------------------
// The store beside the plan

dbTest(
  'store beside plan: Play fraction compared, mismatch flagged, confirm from the store only on request',
  async (db) => {
    const t = await setup(db);
    const planId = await t.plan(t.androidId);
    const made = (
      await put(t, t.androidId, planId, { kind: 'steps', steps: steps(5, 20, 50, 100) })
    ).body.rollout;
    const ids = (made.steps as Json[]).map((s) => s.id as string);
    const get = async () =>
      (await t.call(t.owner.cookie, 'GET', rolloutPath(t.androidId, planId))).body.rollout as Json;
    const complete = (i: number, body?: unknown) =>
      t.call(
        t.owner.cookie,
        'POST',
        rolloutPath(t.androidId, planId, `/steps/${ids[i]}/complete`),
        body,
      );

    // No synced release: nothing to compare, and confirming from the store is refused.
    assert.equal((await get()).comparison.verdict, 'unknown');
    const none = await complete(0, { fromStore: true });
    assert.equal(none.status, 409);
    assert.equal(none.body.error, 'store_share_unknown');

    // The store says 20% while the plan has nothing done: flagged, never fixed by itself.
    await t.release(t.androidId, 'android', '2.0.0', {
      status: 'rolling_out',
      fraction: 0.2,
      track: 'production',
    });
    await t.release(t.androidId, 'android', '2.0.0', {
      status: 'rolling_out',
      fraction: 0.01,
      track: 'internal',
    });
    let view = await get();
    assert.equal(view.store.percent, 20, 'the production track is the one compared');
    assert.equal(view.store.inferred, false);
    assert.equal(view.store.status, 'rolling_out');
    assert.equal(view.comparison.verdict, 'store_ahead');
    assert.equal(view.comparison.mismatch, true);
    assert.equal(view.comparison.confirmStepId, ids[0]);
    assert.deepEqual(
      view.steps.map((s: Json) => s.status),
      ['planned', 'planned', 'planned', 'planned'],
    );
    assert.equal((await t.events()).length, 0, 'reading the store marks nothing done');

    // A step the store has not reached cannot be confirmed from it.
    await complete(0, { fromStore: true });
    const notYet = await complete(1, { fromStore: true });
    assert.equal(notYet.status, 200, 'the store is at 20%, so the 20% step can be confirmed');
    const tooHigh = await complete(2, { fromStore: true });
    assert.equal(tooHigh.status, 409);
    assert.equal(tooHigh.body.error, 'store_not_at_step');
    assert.deepEqual([tooHigh.body.storePercent, tooHigh.body.stepPercent], [20, 50]);
    view = await get();
    assert.deepEqual(
      view.steps.map((s: Json) => [s.status, s.doneSource]),
      [
        ['done', 'store'],
        ['done', 'store'],
        ['planned', null],
        ['planned', null],
      ],
    );
    assert.equal(view.comparison.verdict, 'match');
    assert.equal(view.comparison.mismatch, false);
    assert.match(view.comparison.message, /Store says 20%.*step 2 of 4 \(20%\)/);
    const confirmed = (await t.events('plan.rollout_step_done')).map((e) => e.payload.source);
    assert.deepEqual(confirmed, ['store', 'store']);

    // The plan runs ahead of the store: also flagged.
    await complete(2);
    view = await get();
    assert.equal(view.comparison.verdict, 'store_behind');
    assert.equal(view.comparison.mismatch, true);
    assert.equal(view.comparison.confirmStepId, null);

    // A Play release that is live with no share is at 100% (marked inferred); halted is noted.
    await db.execute('DELETE FROM app_releases WHERE app_id = ?', [t.androidId]);
    await t.release(t.androidId, 'android', '2.0.0', { status: 'live' });
    view = await get();
    assert.equal(view.store.percent, 100);
    assert.equal(view.store.inferred, true);
    assert.equal(view.comparison.confirmStepId, ids[3]);
    await db.execute(
      "UPDATE app_releases SET status = 'halted', details_json = ? WHERE app_id = ?",
      [JSON.stringify({ rolloutFraction: 0.5 }), t.androidId],
    );
    view = await get();
    assert.equal(view.comparison.halted, true);
    assert.match(view.comparison.message, /halted/);
  },
);

dbTest(
  'iOS: the store share is not read, so the plan cannot be compared and nothing is inferred',
  async (db) => {
    const t = await setup(db);
    const planId = await t.plan(t.iosId);
    await put(t, t.iosId, planId, { kind: 'steps', steps: steps(100) });
    await t.release(t.iosId, 'ios', '2.0.0', { status: 'live' });
    const view = (await t.call(t.owner.cookie, 'GET', rolloutPath(t.iosId, planId))).body
      .rollout as Json;
    assert.equal(view.store.platform, 'ios');
    assert.equal(view.store.percent, null);
    assert.equal(view.comparison.verdict, 'unknown');
    assert.equal(view.comparison.mismatch, false);
    assert.equal(view.comparison.confirmStepId, null);
    assert.match(view.comparison.message, /Apple phased release is not read/);
    const stepId = view.steps[0].id as string;
    const confirm = await t.call(
      t.owner.cookie,
      'POST',
      rolloutPath(t.iosId, planId, `/steps/${stepId}/complete`),
      { fromStore: true },
    );
    assert.equal(confirm.status, 409);
    assert.equal(confirm.body.error, 'store_share_unknown');
  },
);

// ---------------------------------------------------------------------------------------------
// Clean-up

dbTest('deleting a plan removes its rollout steps and reminder log', async (db) => {
  const t = await setup(db);
  const planId = await t.plan(t.androidId);
  await put(t, t.androidId, planId, { kind: 'steps', steps: steps(10, 100) });
  await db.execute(
    "INSERT INTO plan_reminders (plan_id, workspace_id, item_id, kind, due_key, sent_at) VALUES (?, ?, 'target_date', 'overdue', '2027-01-01', 1)",
    [planId, t.owner.workspaceId],
  );
  assert.equal(
    (await t.call(t.owner.cookie, 'DELETE', `/apps/${t.androidId}/plans/${planId}`)).status,
    204,
  );
  assert.equal((await db.query('SELECT id FROM plan_rollout_steps')).length, 0);
  assert.equal((await db.query('SELECT plan_id FROM plan_reminders')).length, 0);
  assert.equal((await t.call(t.owner.cookie, 'GET', rolloutPath(t.androidId, planId))).status, 404);
});
