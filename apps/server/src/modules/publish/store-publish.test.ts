import assert from 'node:assert/strict';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { PASSWORD } from '../../testkit.ts';
import { FakeRolloutStore } from './rollout-test-helpers.ts';
import { textEntry } from './store-draft-record.ts';
import type { RolloutConnectorFactory } from './store-rollout.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * Publishing several steps at once (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md) and the pending view. Everything
 * runs against fakes: no store and no GitHub is contacted.
 */

const TEXT = 'A freshly written description that nobody else would ever write';
const HASH = 'a'.repeat(64);
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), 'the condition was not met in time');
};

type Boot = Awaited<ReturnType<typeof boot>>;

/** The staged app with the batch on (default) and a rollout fake; `rollout` and `publish` can be switched off. */
async function boot(
  db: Parameters<typeof bootStaged>[0],
  options: {
    publish?: boolean;
    rollout?: boolean;
    draft?: boolean;
    submit?: boolean;
    release?: boolean;
    /** The batch's own backstop per step, and where its log lines go (tests). */
    stepTimeoutMs?: number;
    log?: (line: string) => void;
  } = {},
) {
  const rolloutStores = {
    ios: new FakeRolloutStore('ios'),
    android: new FakeRolloutStore('android'),
  };
  const rolloutBuilt: unknown[] = [];
  const rolloutFactory: RolloutConnectorFactory = (input) => {
    rolloutBuilt.push(input);
    return input.kind === 'app_store_connect' ? rolloutStores.ios : rolloutStores.android;
  };
  const t = await bootStaged(db, {
    ...(options.draft === undefined ? {} : { draft: { enabled: options.draft } }),
    ...(options.submit === undefined ? {} : { submit: { enabled: options.submit } }),
    ...(options.release === undefined ? {} : { release: { enabled: options.release } }),
    extra: {
      storePublish: {
        enabled: options.publish ?? true,
        ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
        ...(options.log === undefined ? {} : { log: options.log }),
      },
      rollout: { enabled: options.rollout ?? true, connectorFactory: rolloutFactory },
    },
  });
  const path = (app: string, rest = '') => `/apps/${app}/publish${rest}`;
  const plan = (app: string, steps?: unknown[], cookie = t.owner) =>
    t.call(cookie, 'POST', path(app, '/preview'), steps === undefined ? {} : { steps });
  const publish = (app: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', path(app), body);
  /** Preview, then publish what it said with its phrase, as a person would. */
  const planAndPublish = async (app: string, steps?: unknown[], cookie = t.owner) => {
    const p = await plan(app, steps, cookie);
    if (p.status !== 200 || !p.body.plan.confirmable) return { plan: p, publish: p };
    const body = {
      planHash: p.body.plan.planHash,
      steps: p.body.plan.publishSteps,
      ...(p.body.plan.confirmation ? { phrase: p.body.plan.confirmation.phrase } : {}),
    };
    return { plan: p, publish: await publish(app, body, cookie) };
  };
  const bearer = async (token: string, method: string, rest: string, body?: unknown) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${rest}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const mint = async (input: Record<string, unknown>) => {
    const res = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input });
    assert.equal(res.status, 201, res.text);
    return res.body.token as string;
  };
  const publishClaim = async (app: string) =>
    (await db.query('SELECT * FROM store_publish_claims WHERE app_id = ?', [app]))[0];
  return {
    ...t,
    rolloutStores,
    rolloutBuilt,
    path,
    plan,
    publish,
    planAndPublish,
    bearer,
    mint,
    publishClaim,
  };
}

const stageIos = async (t: StagedBoot, name?: string) => {
  const app = await t.addApp('ios', name);
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'description', from: 'local', value: TEXT }))
      .status,
    200,
  );
  // A submit needs screenshots in the draft.
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' }))
      .status,
    200,
  );
  return app;
};
const noStoreIo = (t: Boot) => {
  for (const store of [t.stores.ios, t.stores.android])
    assert.equal(store.reads + store.applyCalls, 0, 'a draft store was reached');
  for (const store of [t.submitStores.ios, t.submitStores.android])
    assert.equal(store.reads + store.submitCalls, 0, 'a submit store was reached');
  for (const store of [t.releaseStores.ios, t.releaseStores.android])
    assert.equal(store.reads + store.releaseCalls, 0, 'a release store was reached');
  for (const store of [t.rolloutStores.ios, t.rolloutStores.android])
    assert.equal(store.reads + store.writes.length, 0, 'a rollout store was reached');
  assert.equal(
    t.built.length + t.submitBuilt.length + t.releaseBuilt.length + t.rolloutBuilt.length,
    0,
    'no connector was built',
  );
};
const stepOf = (body: any, type: string) => (body.plan.steps as any[]).find((s) => s.type === type);
const resultOf = (res: { body: any }, type: string) =>
  (res.body.result.steps as any[]).find((s) => s.type === type);

// ----- the pending view ----------------------------------------------------------------------------------

dbTest(
  'pending: nothing pending is an empty view and no summary line; a staged text is one item that waits for a push; no store is read',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios');
    const empty = await t.call(t.owner, 'GET', `/apps/${app}/pending`);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body.pending.totals, {
      items: 0,
      actionable: 0,
      blocking: 0,
      platforms: [],
      nextSteps: [],
    });
    assert.deepEqual((await t.call(t.owner, 'GET', '/pending/summary')).body.apps, []);
    assert.equal((await t.call(t.owner, 'GET', '/apps/nope/pending')).status, 404);

    assert.equal(
      (
        await t.stageText(app, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: TEXT,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await t.stageText(app, {
          locale: 'de-DE',
          field: 'description',
          from: 'local',
          value: `${TEXT} auf Deutsch`,
        })
      ).status,
      200,
    );
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    assert.equal(view.platforms.length, 1);
    const items = view.platforms[0].items as any[];
    assert.equal(items.length, 1, 'the staged texts are one item');
    assert.deepEqual(
      [items[0].kind, items[0].platform, items[0].state, items[0].nextStep],
      ['listing_text', 'ios', 'staged', 'push_draft'],
    );
    assert.equal(items[0].counts.changes, 2);
    assert.ok(items[0].refs.every((r: any) => typeof r.id === 'string'));
    assert.deepEqual(view.totals.nextSteps, ['push_draft']);
    assert.doesNotMatch(JSON.stringify(view), /freshly written|auf Deutsch/, 'never a staged text');
    const summary = (await t.call(t.owner, 'GET', '/pending/summary')).body;
    assert.equal(summary.apps.length, 1);
    assert.deepEqual(
      [
        summary.apps[0].appId,
        summary.apps[0].count,
        summary.apps[0].blocking,
        summary.apps[0].kinds,
      ],
      [app, 1, 0, ['listing_text']],
    );
    assert.deepEqual(summary.totals, { apps: 1, count: 1, blocking: 0 });
    noStoreIo(t);
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.call(viewer, 'GET', `/apps/${app}/pending`)).status,
      200,
      'listing.read is enough',
    );
  },
);

dbTest(
  'pending: a pushed draft waits for a submit and an approved version for a release; a version in review only informs',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    assert.equal((await t.previewAndPush(app)).push.status, 200);
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    const kinds = (view.platforms[0].items as any[]).map((i) => [i.kind, i.nextStep]);
    assert.deepEqual(kinds, [['pushed_draft', 'submit']]);
    // A stored approved version waits for its release, a version in review only informs.
    const insert = (id: string, version: string, status: string) =>
      db.execute(
        "INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, status_since, synced_at) VALUES (?, ?, ?, 'ios', ?, '', ?, 'RAW', 5, 5)",
        [id, app, t.workspaceId, version, status],
      );
    await insert('r-1', '2.1', 'approved');
    await insert('r-2', '2.2', 'in_review');
    const after = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    const byKind = Object.fromEntries((after.platforms[0].items as any[]).map((i) => [i.kind, i]));
    assert.deepEqual(Object.keys(byKind).sort(), ['approved', 'in_review', 'pushed_draft']);
    assert.equal(byKind.approved.nextStep, 'release');
    assert.equal(byKind.in_review.nextStep, null);
    assert.equal(after.totals.actionable, 2);
    assert.deepEqual(after.totals.nextSteps, ['submit', 'release']);
    const line = (await t.call(t.owner, 'GET', '/pending/summary')).body.apps[0];
    assert.deepEqual([line.count, line.waiting], [2, 1]);
  },
);

dbTest(
  'pending: the labels of staged graphics name the language, and the detail of the other items says what they contain (stored state, scoped, rights)',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const staged = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending.platforms[0]
      .items as any[];
    const set = staged.find((i) => i.kind === 'asset_set');
    assert.match(
      set.label,
      /^.+ \(en-US\): \d+ files?$/,
      'the language is in the label, so two sets of two languages differ',
    );
    const detail = (id: string, kind: string, cookie = t.owner, a = app) =>
      t.call(cookie, 'GET', `/apps/${a}/pending/detail?kind=${kind}&id=${encodeURIComponent(id)}`);
    assert.equal((await detail(set.id, 'asset_set')).status, 400, 'staged kinds are cart items');
    assert.equal(
      (await detail('listing_text', 'pushed_draft')).status,
      404,
      'nothing was pushed yet',
    );
    assert.equal((await t.previewAndPush(app)).push.status, 200);
    const pushed = await detail('pushed_draft', 'pushed_draft');
    assert.equal(pushed.status, 200, pushed.text);
    assert.equal(pushed.headers.get('cache-control'), 'no-store');
    const d = pushed.body.detail.pushedDraft;
    assert.deepEqual(d.texts, [{ locale: 'en-US', field: 'description' }]);
    assert.equal(d.sets.length, 1);
    assert.equal(d.sets[0].locale, 'en-US');
    assert.ok(d.sets[0].files >= 1);
    assert.doesNotMatch(
      JSON.stringify(pushed.body),
      /freshly written|"hash"|sha256|md5/,
      'never a text, a file or a hash',
    );
    const insert = (id: string, version: string, status: string, track = '') =>
      db.execute(
        "INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, status_since, synced_at) VALUES (?, ?, ?, 'ios', ?, ?, ?, 'RAW', 5, 5)",
        [id, app, t.workspaceId, version, track, status],
      );
    await insert('r-1', '2.1', 'approved');
    await insert('r-2', '2.2', 'in_review');
    const approved = (await detail('release:r-1', 'approved')).body.detail.release;
    assert.deepEqual(approved, { version: '2.1', track: null, status: 'approved', since: 5 });
    assert.equal(
      (await detail('release:r-2', 'in_review')).body.detail.release.status,
      'in_review',
    );
    await db.execute(
      "INSERT INTO release_plans (id, workspace_id, app_id, version, created_by, created_at, updated_at) VALUES ('plan-1', ?, ?, '2.1', 'u', 1, 1)",
      [t.workspaceId, app],
    );
    await db.execute(
      "INSERT INTO plan_rollout_steps (id, workspace_id, plan_id, position, percent, planned_at, status) VALUES ('step-1', ?, 'plan-1', 0, 25, 7, 'planned')",
      [t.workspaceId],
    );
    const step = await detail('rollout:step-1', 'rollout_step');
    assert.deepEqual(step.body.detail.rolloutStep, {
      planVersion: '2.1',
      percent: 25,
      plannedAt: 7,
    });
    assert.equal(
      (await detail('rollout:step-1', 'in_review')).status,
      404,
      'the kind must match the item',
    );
    assert.equal(
      (await detail('release:r-2', 'approved')).status,
      404,
      'the kind must match the item',
    );
    assert.equal((await detail('release:nope', 'approved')).status, 404);
    assert.equal((await detail('pushed_draft', 'bogus')).status, 400);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${app}/pending/detail?kind=approved`)).status,
      400,
      'no id',
    );
    // Scope: another app, another workspace, a viewer (listing.read is enough), a token limited to other apps.
    const other = await stageIos(t, 'Other');
    assert.equal(
      (await detail('pushed_draft', 'pushed_draft', t.owner, other)).status,
      404,
      'the other app pushed nothing',
    );
    assert.equal(
      (await detail('release:r-1', 'approved', t.owner, other)).status,
      404,
      'a release of another app',
    );
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal(
      (
        await t.call(
          outsider,
          'GET',
          `/apps/${app}/pending/detail?kind=pushed_draft&id=pushed_draft`,
        )
      ).status,
      404,
    );
    const viewer = await t.addMember('viewer');
    assert.equal((await detail('pushed_draft', 'pushed_draft', viewer)).status, 200);
    const token = await t.mint({ actions: ['listing.read', 'apps.read'], appIds: [other] });
    assert.equal(
      (
        await t.bearer(
          token,
          'GET',
          `/apps/${app}/pending/detail?kind=pushed_draft&id=pushed_draft`,
        )
      ).status,
      404,
    );
    assert.deepEqual(await t.audit('pending.%'), [], 'reading writes no audit entry');
  },
);

dbTest(
  'pending: an app-scoped token sees only its apps in the summary and 404 for another app',
  async (db) => {
    const t = await boot(db);
    const mine = await stageIos(t, 'Mine');
    const other = await stageIos(t, 'Other');
    const token = await t.mint({ actions: ['listing.read', 'apps.read'], appIds: [mine] });
    const summary = await t.bearer(token, 'GET', '/pending/summary');
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.deepEqual(
      (summary.body.apps as any[]).map((a) => a.appId),
      [mine],
    );
    assert.equal((await t.bearer(token, 'GET', `/apps/${mine}/pending`)).status, 200);
    assert.equal((await t.bearer(token, 'GET', `/apps/${other}/pending`)).status, 404);
    const all = await t.mint({});
    assert.equal(((await t.bearer(all, 'GET', '/pending/summary')).body.apps as any[]).length, 2);
  },
);

dbTest(
  'pending, Google Play: a pushed draft release is an item that waits for the release step; the summary and the view agree; releasing it clears it',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    for (const body of [
      { field: 'track', value: 'production' },
      { field: 'version_codes', value: '241' },
      { field: 'release_notes', locale: 'en-US', value: 'Bug fixes' },
    ])
      assert.equal((await t.stageField(app, body)).status, 200);
    const line = async () => (await t.call(t.owner, 'GET', '/pending/summary')).body.apps[0];
    const items = async () =>
      (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending.platforms[0]?.items ?? [];
    assert.deepEqual(
      (await items()).map((i: any) => i.kind),
      ['release_field', 'release_field', 'release_field'],
    );
    assert.equal((await t.previewAndPush(app)).push.status, 200);

    const view = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    assert.deepEqual(
      (view.platforms[0].items as any[]).map((i) => [i.kind, i.nextStep, i.id]),
      [['draft_release', 'release', 'draft_release:production:241']],
      'no "submit" item for a push that held only release fields',
    );
    assert.match(
      view.platforms[0].items[0].label,
      /Draft release in production with 1 version code 241, not released yet/,
    );
    assert.deepEqual(view.totals.nextSteps, ['release']);
    const play = await t.call(
      t.owner,
      'GET',
      `/apps/${app}/pending/detail?kind=draft_release&id=${encodeURIComponent('draft_release:production:241')}`,
    );
    assert.deepEqual(
      [play.status, play.body.detail.draftRelease.track, play.body.detail.draftRelease.codes],
      [200, 'production', ['241']],
    );
    const summary = await line();
    assert.deepEqual(
      [summary.count, summary.waiting, summary.blocking, summary.kinds, summary.nextSteps],
      [
        view.totals.actionable,
        view.totals.items - view.totals.actionable,
        view.totals.blocking,
        ['draft_release'],
        ['release'],
      ],
      'the banner and the detail count the same',
    );

    // The plan: nothing to push, nothing to submit (Google Play has nothing to submit for release fields), the release needs its share.
    const plan = await t.plan(app);
    assert.equal(stepOf(plan.body, 'push_draft').availability, 'nothing_to_do');
    assert.equal(stepOf(plan.body, 'submit').availability, 'nothing_to_do');
    assert.equal(stepOf(plan.body, 'release').availability, 'needs_input');

    // Only the release step, with the track and the share typed: it releases the draft the push wrote.
    const release = { type: 'release', track: 'production', userFraction: 0.1 };
    const { publish } = await t.planAndPublish(app, [release]);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    assert.deepEqual(t.releaseStores.android.released, ['production:241:0.1']);
    assert.deepEqual(await items(), [], 'released: nothing pending any more');
    assert.equal(await line(), undefined);
  },
);

dbTest(
  'pending, Google Play: a draft release the last sync saw in production is pending; one in a test track is not, unless this app pushed',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    const insert = (id: string, track: string, status: string, codes: string[]) =>
      db.execute(
        "INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, details_json, status_since, synced_at) VALUES (?, ?, ?, 'android', ?, ?, ?, 'draft', ?, 5, 5)",
        [id, app, t.workspaceId, `v-${id}`, track, status, JSON.stringify({ versionCodes: codes })],
      );
    await insert('d-1', 'internal', 'draft', ['300']);
    assert.deepEqual(
      (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending.totals.items,
      0,
    );
    await insert('d-2', 'production', 'draft', ['198', '197']);
    await insert('d-3', 'production', 'live', ['190']);
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    assert.deepEqual(
      (view.platforms[0].items as any[]).map((i) => [
        i.kind,
        i.id,
        i.nextStep,
        i.counts.versionCodes,
      ]),
      [['draft_release', 'draft_release:production:197,198', 'release', 2]],
    );
    assert.match(
      view.platforms[0].items[0].label,
      /with 2 version codes 197, 198, not released yet/,
    );
    const line = (await t.call(t.owner, 'GET', '/pending/summary')).body.apps[0];
    assert.deepEqual([line.count, line.kinds, line.nextSteps], [1, ['draft_release'], ['release']]);
  },
);

// ----- the switches ----------------------------------------------------------------------------------------

dbTest(
  'flag off: the batch answers 409 publish_batch_disabled before any store is reached; the rights check comes first',
  async (db) => {
    const t = await boot(db, { publish: false });
    const app = await stageIos(t);
    const config = await t.call(t.owner, 'GET', '/store-publish/config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [config.body.enabled, config.body.envName, config.body.action, config.body.minimumRole],
      [false, 'KILN_STORE_PUBLISH_BATCH_ENABLED', 'store.publish', 'admin'],
    );
    assert.equal(config.body.steps.push_draft.enabled, true, 'the steps keep their own switches');
    for (const res of [
      await t.plan(app),
      await t.publish(app, { planHash: HASH, steps: [{ type: 'push_draft' }] }),
    ]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'publish_batch_disabled');
      assert.match(res.body.message, /KILN_STORE_PUBLISH_BATCH_ENABLED=true/);
    }
    noStoreIo(t);
    assert.equal(await t.publishClaim(app), undefined);
    assert.equal((await t.audit('pending.%')).length, 0);
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.publish(app, { planHash: HASH, steps: [{ type: 'push_draft' }] }, viewer)).status,
      403,
    );
    // The pending view needs no switch.
    assert.equal((await t.call(t.owner, 'GET', `/apps/${app}/pending`)).status, 200);
  },
);

dbTest(
  'the batch turns no step on: a step whose own switch is off is unavailable in the plan and refused (step_disabled) in the publish',
  async (db) => {
    const t = await boot(db, { submit: false, release: false, rollout: false });
    const app = await stageIos(t);
    const all = await t.plan(app);
    assert.equal(all.status, 200, all.text);
    const plan = all.body.plan;
    assert.deepEqual(
      plan.steps.map((s: any) => [s.type, s.availability]),
      [
        ['push_draft', 'available'],
        ['submit', 'feature_disabled'],
        ['release', 'feature_disabled'],
        ['rollout', 'feature_disabled'],
      ],
    );
    assert.equal(plan.confirmable, true, 'what was not asked for does not block');
    assert.equal(plan.confirmationRequired, false, 'a push alone is not irreversible');
    assert.equal(stepOf(all.body, 'submit').requires.envName, 'KILN_STORE_SUBMIT_ENABLED');
    const asked = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(
      asked.body.plan.confirmable,
      false,
      'a requested step that is off makes the plan unconfirmable',
    );
    assert.equal(asked.body.plan.planHash, null);
    const res = await t.publish(app, {
      planHash: HASH,
      phrase: 'x',
      steps: [{ type: 'push_draft' }, { type: 'submit' }],
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'step_disabled');
    assert.deepEqual(res.body.disabled, [{ step: 'submit', envName: 'KILN_STORE_SUBMIT_ENABLED' }]);
    assert.equal(t.stores.ios.applyCalls, 0, 'nothing was pushed');
  },
);

dbTest(
  'rights: only owners and admins preview or publish; non-members get 404; every step needs its own right',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    for (const cookie of [viewer, member]) {
      assert.equal((await t.plan(app, undefined, cookie)).status, 403);
      assert.equal(
        (await t.publish(app, { planHash: HASH, steps: [{ type: 'push_draft' }] }, cookie)).status,
        403,
      );
      assert.equal((await t.call(cookie, 'GET', '/store-publish/config')).status, 200);
    }
    noStoreIo(t);
    assert.equal(
      (await t.planAndPublish(app, [{ type: 'push_draft' }], admin)).publish.status,
      200,
      'an admin may',
    );
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.plan(app, undefined, outsider)).status, 404);
    assert.equal(
      (await t.publish(app, { planHash: HASH, steps: [{ type: 'push_draft' }] }, outsider)).status,
      404,
    );
  },
);

// ----- the plan --------------------------------------------------------------------------------------------

dbTest(
  'plan: a push and the submit after it are one plan with ONE phrase; the submit is deferred and promised; a preview writes nothing',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const res = await t.plan(app);
    assert.equal(res.status, 200, res.text);
    const plan = res.body.plan;
    assert.deepEqual(
      plan.steps.map((s: any) => [s.type, s.order, s.availability, s.included]),
      [
        ['push_draft', 1, 'available', true],
        ['submit', 2, 'available', true],
        ['release', 3, 'nothing_to_do', false],
        ['rollout', 4, 'nothing_to_do', false],
      ],
    );
    assert.equal(stepOf(res.body, 'push_draft').deferred, false);
    assert.ok(
      stepOf(res.body, 'push_draft').confirmHash,
      'the push has the hash of its own preview',
    );
    assert.equal(
      stepOf(res.body, 'push_draft').preview.submits,
      false,
      'the individual preview is carried',
    );
    assert.equal(stepOf(res.body, 'submit').deferred, true);
    assert.equal(stepOf(res.body, 'submit').confirmHash, null);
    assert.equal(stepOf(res.body, 'submit').stepPhrase, 'submit com.acme.app 2.1');
    assert.equal(plan.confirmable, true);
    assert.equal(plan.irreversible, true);
    assert.deepEqual(plan.irreversibleSteps, ['submit']);
    assert.equal(plan.confirmation.phrase, 'publish Weather 2 steps');
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(plan.publishSteps, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(t.stores.ios.applyCalls, 0, 'a preview writes nothing');
    assert.equal(t.submitStores.ios.submitCalls, 0);
    assert.equal(await t.publishClaim(app), undefined);
    // Previewing again gives the same plan; changing what is staged gives another.
    assert.equal((await t.plan(app)).body.plan.planHash, plan.planHash);
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'keywords', from: 'local', value: 'x,y' }))
        .status,
      200,
    );
    assert.notEqual((await t.plan(app)).body.plan.planHash, plan.planHash);
  },
);

dbTest(
  'plan: nothing pending is not confirmable and has no hash; a requested step with nothing to do blocks the plan',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios');
    const res = await t.plan(app);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      [
        res.body.plan.included,
        res.body.plan.confirmable,
        res.body.plan.planHash,
        res.body.plan.confirmation,
      ],
      [0, false, null, null],
    );
    assert.ok((res.body.plan.steps as any[]).every((s) => s.availability === 'nothing_to_do'));
    const asked = await t.plan(app, [{ type: 'push_draft' }]);
    assert.equal(stepOf(asked.body, 'push_draft').availability, 'nothing_to_do');
    assert.equal(asked.body.plan.confirmable, false);
    const done = await t.publish(app, { planHash: HASH, steps: [{ type: 'push_draft' }] });
    assert.equal(done.status, 409);
    assert.equal(done.body.error, 'plan_blocked');
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal((await t.audit('pending.%')).length, 0, 'nothing happened: nothing is audited');
    assert.equal((await t.events('pending.published')).length, 0);
    assert.equal(await t.publishClaim(app), undefined);
    // A release with no track or share is input to ask for, not an error.
    const play = await t.addApp('android');
    const needs = await t.plan(play, [{ type: 'release' }]);
    assert.equal(stepOf(needs.body, 'release').availability, 'needs_input');
    assert.equal(needs.body.plan.confirmable, false);
    // Fields a step does not take, twice the same step and a rollout with no action are refused.
    const twice = await t.plan(app, [{ type: 'push_draft' }, { type: 'push_draft' }]);
    assert.deepEqual([twice.status, twice.body.error], [422, 'invalid_steps']);
    assert.equal(
      (await t.plan(app, [{ type: 'rollout' }])).status,
      400,
      'a rollout names its action',
    );
    assert.equal(
      (await t.plan(app, [{ type: 'push_draft', track: 'production' }])).status,
      400,
      'a field the step does not take',
    );
    assert.equal((await t.plan(app, [])).status, 400);
  },
);

// ----- publishing ------------------------------------------------------------------------------------------

dbTest(
  'publish: push then submit in one go, one phrase; each step ran through its own service; audited and emitted with ids and hashes only',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const { plan, publish } = await t.planAndPublish(app);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    const r = publish.body.result;
    assert.deepEqual(
      [r.completed, r.applied, r.skipped, r.failed, r.stoppedAt],
      [true, 2, 0, 0, null],
      JSON.stringify(r.steps).slice(0, 1500),
    );
    assert.deepEqual(
      (r.steps as any[]).map((s) => [s.type, s.status]),
      [
        ['push_draft', 'applied'],
        ['submit', 'applied'],
      ],
    );
    assert.equal(r.planHash, plan.body.plan.planHash);
    assert.equal(t.stores.ios.applyCalls, 1);
    assert.equal(
      t.stores.ios.texts.get('en-US\u0000description'),
      TEXT,
      'the staged text was pushed',
    );
    assert.equal(t.submitStores.ios.submitCalls, 1);
    assert.equal(t.submitStores.ios.submitted, true);
    assert.deepEqual(
      r.pending,
      { items: 0, actionable: 0, blocking: 0 },
      'nothing is pending any more',
    );
    assert.equal(await t.publishClaim(app), undefined);
    assert.equal(await t.claim(app), undefined, 'the claims of the steps are released too');
    assert.equal(await t.submitClaim(app), undefined);
    // The steps audit and emit as they always do; the batch adds its own entry.
    assert.equal((await t.audit('listing.submitted')).length, 1);
    const audit = (await t.audit('pending.published'))[0];
    assert.deepEqual(
      [audit?.actorType, audit?.detail.outcome, audit?.detail.applied, audit?.detail.hash],
      ['user', 'completed', 2, r.planHash],
    );
    const event = (await t.events('pending.published'))[0];
    assert.deepEqual(
      [event?.payload.appId, event?.payload.completed, event?.payload.applied],
      [app, true, 2],
    );
    assert.deepEqual(
      (event?.payload.steps as any[]).map((s) => [s.type, s.status]),
      [
        ['push_draft', 'applied'],
        ['submit', 'applied'],
      ],
    );
    for (const text of [JSON.stringify(audit), JSON.stringify(event)]) {
      assert.doesNotMatch(
        text,
        /secret|PRIVATE KEY|password|freshly written/i,
        'ids, hashes and outcomes only',
      );
    }
  },
);

dbTest(
  'publish: the phrase is checked before anything is read, covers exactly the plan, and is not needed for a push alone',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const p = (await t.plan(app)).body.plan;
    const body = { planHash: p.planHash, steps: p.publishSteps };
    for (const phrase of [
      undefined,
      '',
      'publish Weather 2 steps ',
      'publish Weather 1 step',
      'submit com.acme.app',
      'publish Other 2 steps',
    ]) {
      const res = await t.publish(app, { ...body, ...(phrase === undefined ? {} : { phrase }) });
      if (phrase === 'publish Weather 2 steps ') {
        // Surrounding spaces are trimmed: the same phrase.
        assert.equal(res.status, 200, res.text.slice(0, 300));
        break;
      }
      assert.equal(res.status, 422, `${phrase}`);
      assert.equal(res.body.error, 'confirmation_mismatch');
      assert.equal(res.body.phrase, 'publish Weather 2 steps');
      assert.equal(
        t.stores.ios.applyCalls + t.submitStores.ios.submitCalls,
        0,
        'nothing was written',
      );
    }
    assert.equal(t.submitStores.ios.submitCalls, 1);
    // A push alone is not irreversible: no phrase.
    const second = await t.addApp('android', 'Second');
    assert.equal(
      (await t.stageText(second, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' }))
        .status,
      200,
    );
    const push = await t.plan(second, [{ type: 'push_draft' }]);
    assert.equal(push.body.plan.confirmationRequired, false);
    assert.equal(push.body.plan.confirmation, null);
    const res = await t.publish(second, {
      planHash: push.body.plan.planHash,
      steps: push.body.plan.publishSteps,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual([res.body.result.completed, res.body.result.applied], [true, 1]);
  },
);

dbTest(
  'publish: with the step-up policy on, the person confirms with a passkey or password bound to the plan and types no phrase; a token still types it',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const policy = await t.call(t.owner, 'PUT', '/step-up/policy', { mode: 'hard_actions' });
    assert.equal(policy.status, 200, policy.text);
    const p = (await t.plan(app)).body.plan;
    assert.equal(p.confirmationRequired, false, 'no typed phrase');
    assert.equal(p.confirmation, null);
    assert.equal(p.irreversible, true, 'the steps are still said to be irreversible');
    const body = { planHash: p.planHash, steps: p.publishSteps };
    // Without a grant nothing is written.
    const missing = await t.publish(app, body);
    assert.equal(missing.status, 403, missing.text.slice(0, 200));
    assert.equal(missing.body.error, 'step_up_required');
    assert.equal(t.stores.ios.applyCalls + t.submitStores.ios.submitCalls, 0);
    // With a grant for this plan, no phrase is asked.
    const verified = await t.call(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'store.publish',
      target: { id: app, hash: p.planHash },
      password: PASSWORD,
    });
    assert.equal(verified.status, 200, verified.text);
    const raw = await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${app}/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: t.owner,
        'x-step-up-grant': verified.body.grant,
      },
      body: JSON.stringify(body),
    });
    assert.equal(raw.status, 200, (await raw.text()).slice(0, 300));
    assert.equal(t.submitStores.ios.submitCalls, 1);
  },
);

dbTest(
  'publish: a plan that is not the one previewed writes nothing (plan_changed, with the new plan)',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const p = (await t.plan(app)).body.plan;
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'keywords', from: 'local', value: 'x,y' }))
        .status,
      200,
    );
    const res = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'plan_changed');
    assert.notEqual(res.body.plan.planHash, p.planHash);
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal(await t.publishClaim(app), undefined, 'the claim is released');
    assert.equal((await t.audit('pending.%')).length, 0);
    // A hash that is not a hash is a bad request.
    assert.equal((await t.publish(app, { planHash: 'nope', steps: p.publishSteps })).status, 400);
  },
);

// ----- drift, failure and unknown outcomes -----------------------------------------------------------------

dbTest(
  'drift mid-batch: a deferred submit that no longer matches what the plan promised is skipped (plan_drifted), nothing is submitted',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const p = (await t.plan(app)).body.plan;
    // While the push runs, something else records one more pushed text for the same version: the submit would hand over more than promised.
    const store = t.stores.ios;
    const original = store.applyDraft.bind(store);
    store.applyDraft = async (input) => {
      const result = await original(input);
      store.texts.set('en-US\u0000keywords', 'a,b');
      const manifest = { v: 1, text: [textEntry('en-US', 'keywords', 'a,b')], assets: [] };
      await db.execute(
        "INSERT INTO store_draft_pushes (app_id, platform, workspace_id, version_id, version_string, confirm_hash, items, pushed_by, pushed_at, updated_at) VALUES (?, 'ios', ?, ?, ?, ?, ?, 'u', 1, 1)",
        [
          app,
          t.workspaceId,
          store.version?.id ?? null,
          store.version?.versionString ?? null,
          HASH,
          JSON.stringify(manifest),
        ],
      );
      return result;
    };
    const res = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    const r = res.body.result;
    assert.deepEqual(
      [r.completed, r.applied, r.skipped, r.failed, r.stoppedAt],
      [false, 1, 1, 0, 'submit'],
    );
    assert.equal(resultOf(res, 'push_draft').status, 'applied');
    assert.deepEqual(
      [resultOf(res, 'submit').status, resultOf(res, 'submit').reason],
      ['skipped', 'plan_drifted'],
      JSON.stringify(resultOf(res, 'submit')),
    );
    assert.equal(t.submitStores.ios.submitCalls, 0, 'nothing was submitted');
    const audit = (await t.audit('pending.published'))[0];
    assert.deepEqual(
      [audit?.detail.outcome, audit?.detail.applied, audit?.detail.skipped],
      ['partial', 1, 1],
    );
    assert.equal(
      (await t.events('pending.published'))[0]?.payload.completed,
      false,
      'what was applied is announced',
    );
    assert.equal(await t.publishClaim(app), undefined);
  },
);

dbTest(
  'drift in a step: the store changed under the push (state_changed) stops the batch; the later steps are skipped and nothing is retried',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const p = (await t.plan(app)).body.plan;
    const store = t.stores.ios;
    const original = store.applyDraft.bind(store);
    store.applyDraft = async (input) => {
      store.texts.set('en-US\u0000description', 'Somebody else wrote this in App Store Connect');
      return original(input);
    };
    const res = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    const r = res.body.result;
    assert.deepEqual(
      [r.completed, r.applied, r.skipped, r.failed, r.stoppedAt],
      [false, 0, 1, 1, 'push_draft'],
    );
    const push = resultOf(res, 'push_draft');
    assert.deepEqual(
      [push.status, push.error, push.httpStatus, push.outcome],
      ['failed', 'state_changed', 409, 'refused'],
    );
    assert.equal(resultOf(res, 'submit').reason, 'previous_step_not_applied');
    assert.equal(t.submitStores.ios.submitCalls, 0);
    assert.equal(
      store.texts.get('en-US\u0000description'),
      'Somebody else wrote this in App Store Connect',
      'the store was not overwritten',
    );
    assert.equal(store.writes.length, 0);
    const audit = (await t.audit('pending.published'))[0];
    assert.deepEqual(
      [audit?.detail.outcome, audit?.detail.applied, audit?.detail.failed],
      ['failed', 0, 1],
    );
    assert.equal((await t.events('pending.published')).length, 0, 'nothing was applied: no event');
    assert.equal(await t.publishClaim(app), undefined);
  },
);

dbTest(
  'partial failure: a refused submit stops the batch after the push; the release after it is skipped, the push stays applied',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    t.submitStores.ios.behavior = {
      kind: 'refuse',
      error: new StoreError(
        'appstoreconnect',
        'forbidden',
        'Apple refused the submission (403).',
        403,
      ),
    };
    const { plan, publish } = await t.planAndPublish(app, [
      { type: 'push_draft' },
      { type: 'submit' },
      { type: 'release' },
    ]);
    assert.equal(plan.body.plan.confirmation.phrase, 'publish Weather 3 steps');
    assert.deepEqual(plan.body.plan.irreversibleSteps, ['submit', 'release']);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    const r = publish.body.result;
    assert.deepEqual(
      [r.completed, r.applied, r.skipped, r.failed, r.stoppedAt],
      [false, 1, 1, 1, 'submit'],
    );
    assert.deepEqual(
      (r.steps as any[]).map((s) => [s.type, s.status]),
      [
        ['push_draft', 'applied'],
        ['submit', 'failed'],
        ['release', 'skipped'],
      ],
    );
    assert.equal(resultOf(publish, 'submit').error, 'store_forbidden');
    assert.equal(resultOf(publish, 'submit').outcome, 'refused');
    assert.equal(resultOf(publish, 'release').reason, 'previous_step_not_applied');
    assert.equal(t.releaseStores.ios.releaseCalls, 0, 'the release never ran');
    assert.equal(t.submitStores.ios.submitCalls, 1, 'the submit was not retried');
    assert.equal(t.stores.ios.texts.get('en-US\u0000description'), TEXT, 'the push stays applied');
    assert.deepEqual((await t.audit('pending.published'))[0]?.detail.outcome, 'partial');
    assert.equal((await t.events('pending.published'))[0]?.payload.applied, 1);
    // The batch does not hide the step's own audit of its failure.
    assert.equal((await t.audit('listing.submit_failed')).length, 1);
  },
);

dbTest(
  'unknown outcome: a submit whose answer was lost and cannot be read back is reported as unknown, never retried, and the lock is released',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    t.submitStores.ios.behavior = { kind: 'unknown', applied: true };
    t.submitStores.ios.readFailsAfterWrite = true;
    const { publish } = await t.planAndPublish(app);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    const submit = resultOf(publish, 'submit');
    assert.deepEqual(
      [submit.status, submit.error, submit.outcome],
      ['failed', 'outcome_unknown', 'unknown'],
    );
    assert.equal(publish.body.result.stoppedAt, 'submit');
    assert.equal(t.submitStores.ios.submitCalls, 1, 'not sent again');
    assert.equal(
      await t.publishClaim(app),
      undefined,
      'the batch lock is released; the step keeps its own unknown claim',
    );
    assert.equal(String((await t.submitClaim(app))?.status), 'unknown');
    // Previewing again does not guess: the step's own gate says look first.
    t.submitStores.ios.readError = undefined;
    const again = await t.plan(app, [{ type: 'submit' }]);
    assert.equal(again.status, 200);
    assert.equal(again.body.plan.confirmable, false);
    assert.equal(t.submitStores.ios.submitCalls, 1);
  },
);

// ----- one publish in flight per app -----------------------------------------------------------------------

dbTest(
  'in flight: a second publish of the same app is refused (publish_in_progress) while the first runs; another app is not held up',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios', 'Weather');
    const other = await t.addApp('ios', 'Other');
    let open!: () => void;
    t.releaseStores.ios.gate = new Promise<void>((resolve) => (open = resolve));
    const p = (await t.plan(app, [{ type: 'release' }])).body.plan;
    assert.equal(p.confirmable, true, JSON.stringify(p.steps).slice(0, 400));
    const body = { planHash: p.planHash, phrase: p.confirmation.phrase, steps: p.publishSteps };
    const first = t.publish(app, body);
    await until(() => t.releaseStores.ios.releaseCalls === 1);
    assert.equal(String((await t.publishClaim(app))?.status), 'writing');
    const second = await t.publish(app, body);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'publish_in_progress');
    assert.equal(t.releaseStores.ios.releaseCalls, 1);
    assert.equal(
      (await t.publish(other, { planHash: HASH, steps: [{ type: 'push_draft' }] })).status,
      409,
      'another app gets its own answer (plan_blocked), not the lock',
    );
    open();
    const done = await first;
    assert.equal(done.status, 200, done.text.slice(0, 400));
    assert.equal(done.body.result.completed, true);
    assert.equal(await t.publishClaim(app), undefined);
    assert.deepEqual(t.releaseStores.ios.released, ['v-next']);
  },
);

dbTest(
  'in flight: a batch lock that is old is not trusted (the steps decide); a fresh one blocks',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const p = (await t.plan(app, [{ type: 'push_draft' }])).body.plan;
    const body = { planHash: p.planHash, steps: p.publishSteps };
    await db.execute(
      "INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'publish', 'writing', 'u', ?)",
      [app, t.workspaceId, Date.now()],
    );
    const blocked = await t.publish(app, body);
    assert.equal(blocked.body.error, 'publish_in_progress');
    assert.equal(t.stores.ios.applyCalls, 0);
    await db.execute('UPDATE store_publish_claims SET claim_at = 1 WHERE app_id = ?', [app]);
    const res = await t.publish(app, body);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(await t.publishClaim(app), undefined);
  },
);

dbTest('deleting an app removes its publish claim', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  await db.execute(
    "INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'publish', 'writing', 'u', 1)",
    [app, t.workspaceId],
  );
  const res = await t.call(t.owner, 'DELETE', `/apps/${app}`);
  assert.ok(res.status === 200 || res.status === 204, res.text);
  assert.equal(await t.publishClaim(app), undefined);
});

// ----- tokens ----------------------------------------------------------------------------------------------

dbTest(
  'tokens: the batch right is explicit, and every step needs its own right; an app scope applies',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const other = await stageIos(t, 'Other');
    const steps = [{ type: 'push_draft' }, { type: 'submit' }];

    // No list never counts for the batch, and a step right is not the batch right.
    const everything = await t.mint({});
    assert.equal((await t.bearer(everything, 'POST', t.path(app, '/preview'), {})).status, 403);
    assert.equal(
      (await t.bearer(everything, 'POST', t.path(app), { planHash: HASH, steps })).status,
      403,
    );
    const stepsOnly = await t.mint({ actions: ['store.push_draft', 'store.submit', 'apps.read'] });
    assert.equal(
      (await t.bearer(stepsOnly, 'POST', t.path(app, '/preview'), { steps })).status,
      403,
      'the step rights are not the batch right',
    );
    noStoreIo(t);

    // The batch right without the step rights: the plan says forbidden, the publish refuses and names what is missing.
    const batchOnly = await t.mint({ actions: ['store.publish', 'apps.read'] });
    const plan = await t.bearer(batchOnly, 'POST', t.path(app, '/preview'), { steps });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual(
      (plan.body.plan.steps as any[])
        .filter((s) => s.requested)
        .map((s) => [s.type, s.availability, s.requires.allowed]),
      [
        ['push_draft', 'forbidden', false],
        ['submit', 'forbidden', false],
      ],
    );
    assert.equal(plan.body.plan.confirmable, false);
    const refused = await t.bearer(batchOnly, 'POST', t.path(app), {
      planHash: HASH,
      phrase: 'publish Weather 2 steps',
      steps,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'forbidden');
    assert.deepEqual(
      (refused.body.missing as any[]).map((m) => m.action),
      ['store.push_draft', 'store.submit'],
    );
    noStoreIo(t);

    // The batch right and the push right: a push alone works; adding the submit does not.
    const pusher = await t.mint({
      actions: ['store.publish', 'store.push_draft', 'apps.read'],
      appIds: [app],
    });
    const mixed = await t.bearer(pusher, 'POST', t.path(app), {
      planHash: HASH,
      phrase: 'publish Weather 2 steps',
      steps,
    });
    assert.equal(mixed.status, 403);
    assert.deepEqual(
      (mixed.body.missing as any[]).map((m) => m.step),
      ['submit'],
    );
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal(
      (await t.bearer(pusher, 'POST', t.path(other, '/preview'), {})).status,
      404,
      'another app',
    );
    const p = await t.bearer(pusher, 'POST', t.path(app, '/preview'), {
      steps: [{ type: 'push_draft' }],
    });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.plan.confirmable, true);
    const done = await t.bearer(pusher, 'POST', t.path(app), {
      planHash: p.body.plan.planHash,
      steps: p.body.plan.publishSteps,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 400));
    assert.equal(done.body.result.completed, true);
    assert.equal(
      (await t.audit('pending.published'))[0]?.actorType,
      'token',
      'a publish by a token is attributed to the token',
    );
    // A member's token cannot hold the rights at all.
    const tooLow = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'member',
      actions: ['store.publish'],
    });
    assert.equal(tooLow.status, 400);
    assert.equal(tooLow.body.error, 'action_above_role');
  },
);

// ----- Google Play and rollouts ----------------------------------------------------------------------------

dbTest(
  'Google Play: a push and the draft release after it; the release is previewed again after the push and runs only as promised',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' }))
        .status,
      200,
    );
    const steps = [
      { type: 'push_draft' },
      { type: 'release', track: 'production', userFraction: 0.1 },
    ];
    const plan = await t.plan(app, steps);
    assert.equal(plan.status, 200, plan.text.slice(0, 300));
    const release = stepOf(plan.body, 'release');
    assert.equal(release.included, true, JSON.stringify(release.problems));
    assert.equal(release.deferred, true);
    assert.equal(release.confirmHash, null);
    assert.equal(release.stepPhrase, 'release com.acme.app production 10%');
    assert.deepEqual(release.summary, {
      track: 'production',
      userFraction: 0.1,
      audience: 'percent',
    });
    const { publish } = await t.planAndPublish(app, steps);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    assert.deepEqual([publish.body.result.completed, publish.body.result.applied], [true, 2]);
    assert.deepEqual(t.releaseStores.android.released, ['production:241:0.1']);
    assert.equal(t.stores.android.applyCalls, 1);
  },
);

dbTest(
  'Google Play, release fields only: the default plan is ONE direct release step (no push, no submit); "a draft only" is the push alone; a push and a direct release cannot share a plan',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    t.releaseStores.android.releases = t.releaseStores.android.releases.filter(
      (r) => r.status !== 'draft',
    );
    for (const body of [
      { field: 'track', value: 'production' },
      { field: 'version_codes', value: '241' },
      { field: 'release_notes', locale: 'en-US', value: 'Bug fixes' },
      { field: 'user_fraction', value: '10%' },
    ])
      assert.equal((await t.stageField(app, body)).status, 200);

    const plan = await t.plan(app);
    assert.equal(plan.status, 200, plan.text.slice(0, 300));
    assert.equal(plan.body.plan.defaultedToDirect, true);
    assert.deepEqual(plan.body.plan.direct, {
      track: 'production',
      versionCodes: ['241'],
      stagedFraction: 0.1,
    });
    assert.deepEqual(
      plan.body.plan.steps.map((s: any) => [s.type, s.availability]),
      [
        ['push_draft', 'not_requested'],
        ['submit', 'not_requested'],
        ['release', 'needs_input'],
        ['rollout', 'not_requested'],
      ],
      'the share is never implied: it needs the person',
    );
    assert.equal(plan.body.plan.confirmable, false);

    const direct = { type: 'release', direct: true, track: 'production', userFraction: 0.1 };
    const typed = await t.plan(app, [direct]);
    const step = stepOf(typed.body, 'release');
    assert.equal(step.included, true, JSON.stringify(step.problems));
    assert.equal(step.deferred, false, 'nothing is pushed first, so nothing is deferred');
    assert.match(step.label, /^Release to production/);
    assert.equal(step.stepPhrase, 'release com.acme.app production 10%');
    assert.deepEqual(step.summary, {
      track: 'production',
      userFraction: 0.1,
      audience: 'percent',
      direct: true,
      creates: true,
      versionCodes: ['241'],
      notesLanguages: ['en-US'],
    });
    assert.equal(typed.body.plan.confirmation.phrase, 'publish Weather 1 step');

    // A push and a direct release in one plan: refused, with the reason.
    const both = await t.plan(app, [{ type: 'push_draft' }, direct]);
    assert.equal(stepOf(both.body, 'release').availability, 'blocked');
    assert.equal(both.body.plan.confirmable, false);

    // "Save as a draft only": the push alone, nothing sent for review.
    const draft = await t.planAndPublish(app, [{ type: 'push_draft' }]);
    assert.equal(draft.publish.status, 200, draft.publish.text.slice(0, 300));
    assert.equal(t.releaseStores.android.releaseCalls, 0);
    assert.equal(t.stores.android.applyCalls, 1);
  },
);

dbTest(
  'Google Play, direct release in a plan: one write to the store, the release is made from the staged fields, the plan and the single step keep the same gates',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    t.releaseStores.android.releases = t.releaseStores.android.releases.filter(
      (r) => r.status !== 'draft',
    );
    for (const body of [
      { field: 'track', value: 'production' },
      { field: 'version_codes', value: '241' },
      { field: 'release_notes', locale: 'en-US', value: 'Bug fixes' },
    ])
      assert.equal((await t.stageField(app, body)).status, 200);
    const direct = { type: 'release', direct: true, track: 'production', userFraction: 0.25 };
    const { publish } = await t.planAndPublish(app, [direct]);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    assert.deepEqual([publish.body.result.completed, publish.body.result.applied], [true, 1]);
    assert.deepEqual(t.releaseStores.android.released, ['production:241:0.25']);
    assert.equal(t.releaseStores.android.builds.length, 1);
    assert.equal(t.stores.android.applyCalls, 0, 'no draft was written');
    assert.equal((await t.audit('store.released'))[0]?.detail.direct, true);
  },
);

dbTest(
  'Google Play, direct release: with the release switch off the plan is the usual one and the release step is unavailable (feature_disabled); a viewer cannot plan',
  async (db) => {
    const t = await boot(db, { release: false });
    const app = await t.addApp('android', 'Weather');
    for (const body of [
      { field: 'track', value: 'production' },
      { field: 'version_codes', value: '241' },
    ])
      assert.equal((await t.stageField(app, body)).status, 200);
    const plan = await t.plan(app);
    assert.equal(plan.body.plan.defaultedToDirect, false);
    assert.equal(stepOf(plan.body, 'release').availability, 'feature_disabled');
    const direct = await t.plan(app, [
      { type: 'release', direct: true, track: 'production', userFraction: 0.1 },
    ]);
    assert.equal(stepOf(direct.body, 'release').availability, 'feature_disabled');
    assert.equal(direct.body.plan.confirmable, false);
    assert.equal(t.releaseStores.android.reads + t.releaseStores.android.releaseCalls, 0);
    const viewer = await t.addMember('viewer');
    assert.equal((await t.plan(app, undefined, viewer)).status, 403);
  },
);

dbTest(
  'rollout: a rollout step runs through its own service with its own right; it cannot share a batch with a release',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    const step = {
      type: 'rollout',
      action: 'set_fraction',
      track: 'production',
      versionCodes: ['240'],
      userFraction: 0.5,
    };
    const plan = await t.plan(app, [step]);
    assert.equal(plan.status, 200, plan.text.slice(0, 300));
    assert.equal(plan.body.plan.confirmable, true, JSON.stringify(plan.body.plan.steps));
    assert.equal(plan.body.plan.confirmation.phrase, 'publish Weather 1 step');
    assert.equal(stepOf(plan.body, 'rollout').irreversible, true);
    const both = await t.plan(app, [
      { type: 'release', track: 'production', userFraction: 0.1 },
      step,
    ]);
    assert.equal(stepOf(both.body, 'rollout').availability, 'blocked');
    assert.equal(both.body.plan.confirmable, false);
    const { publish } = await t.planAndPublish(app, [step]);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    assert.deepEqual(
      [publish.body.result.completed, resultOf(publish, 'rollout').status],
      [true, 'applied'],
    );
    assert.equal((t.rolloutStores.android.state as { userFraction: number }).userFraction, 0.5);
    assert.equal((await t.audit('pending.published'))[0]?.detail.applied, 1);
  },
);

// ----- a publish always ends, and says where it was ---------------------------------------------------------

dbTest(
  'a step that never answers does not hold the batch for ever: it ends as an unknown outcome, the lock is released and the log says where it stalled',
  async (db) => {
    const lines: string[] = [];
    const t = await boot(db, { stepTimeoutMs: 60, log: (line) => lines.push(line) });
    const app = await t.addApp('ios', 'Weather');
    let open!: () => void;
    t.releaseStores.ios.gate = new Promise<void>((resolve) => (open = resolve));
    const p = (await t.plan(app, [{ type: 'release' }])).body.plan;
    assert.equal(p.confirmable, true, JSON.stringify(p.steps).slice(0, 400));
    const answered = await Promise.race([
      t.publish(app, { planHash: p.planHash, phrase: p.confirmation.phrase, steps: p.publishSteps }),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5000)),
    ]);
    assert.notEqual(answered, 'hung', 'the publish request never answered');
    const done = answered as Awaited<ReturnType<typeof t.publish>>;
    assert.equal(done.status, 200, done.text.slice(0, 400));
    const release = resultOf(done, 'release');
    assert.deepEqual(
      [release.status, release.error, release.outcome, release.httpStatus],
      ['failed', 'step_timeout', 'unknown', 504],
    );
    assert.equal(done.body.result.completed, false);
    assert.equal(done.body.result.stoppedAt, 'release');
    assert.equal(await t.publishClaim(app), undefined, 'the batch lock is released');
    assert.ok(lines.some((l) => /step 1\/1 release started/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /step 1\/1 release did not finish within/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /finished after/.test(l)), lines.join('\n'));
    // Let the abandoned step end, so its own timer does not keep the test process waiting.
    open();
    await until(() => t.releaseStores.ios.releaseCalls >= 1);
  },
);

dbTest(
  'the log names every boundary of a two step publish (ids, step names and statuses only)',
  async (db) => {
    const lines: string[] = [];
    const t = await boot(db, { log: (line) => lines.push(line) });
    const app = await stageIos(t, 'Weather');
    const { publish } = await t.planAndPublish(app);
    assert.equal(publish.status, 200, publish.text.slice(0, 400));
    const text = lines.join('\n');
    assert.match(text, /steps push_draft,submit started/);
    assert.match(text, /plan built after/);
    assert.match(text, /step 1\/2 push_draft started/);
    assert.match(text, /step 1\/2 push_draft applied after/);
    assert.match(text, /step 2\/2 submit started/);
    assert.match(text, /step 2\/2 submit applied after/);
    assert.match(text, /finished after .*stopped at nothing/);
    assert.doesNotMatch(text, new RegExp(TEXT), 'never a staged text');
    assert.ok(lines.every((l) => l.startsWith('publish: ')));
  },
);

// ----- what a running publish looks like from outside (publishing.ts, migration 71) ---------------------------

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const publishingOf = async (t: Boot, app: string) =>
  (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending.publishing;

dbTest(
  'publishing: the claim shows in every listing while a step blocks on the store, step by step, and is gone after success',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const other = await t.addApp('ios', 'Other');
    const first = gate();
    const second = gate();
    t.stores.ios.gate = first.promise;
    t.submitStores.ios.gate = second.promise;
    assert.equal(await publishingOf(t, app), null, 'nothing runs before the publish');
    const p = (await t.plan(app)).body.plan;
    assert.equal(p.confirmable, true, JSON.stringify(p.steps).slice(0, 400));
    const before = Date.now();
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    assert.deepEqual(view.publishing.steps, ['push_draft', 'submit']);
    assert.equal(view.publishing.currentStep, 'push_draft');
    assert.ok(view.publishing.startedAt >= before && view.publishing.stepStartedAt >= before);
    assert.equal(typeof view.publishing.by.id, 'string');
    assert.equal(typeof view.publishing.by.name, 'string', 'the person who started it, by name');
    // The cart, the summary and the small poll read of the workspace say the same.
    const cart = (await t.call(t.owner, 'GET', `/apps/${app}/pending/cart`)).body.cart;
    assert.equal(cart.publishing.currentStep, 'push_draft');
    assert.ok(cart.items.length > 0, 'the items are still listed (they are being published)');
    const summary = (await t.call(t.owner, 'GET', '/pending/summary')).body;
    const line = summary.apps.find((a: any) => a.appId === app);
    assert.equal(line.publishing.currentStep, 'push_draft');
    const poll = await t.call(t.owner, 'GET', '/pending/publishing');
    assert.equal(poll.status, 200, poll.text);
    assert.deepEqual(
      poll.body.apps.map((a: any) => [a.appId, a.publishing.currentStep]),
      [[app, 'push_draft']],
      'only the app that publishes, and no staged text anywhere',
    );
    assert.doesNotMatch(poll.text, new RegExp(TEXT));
    assert.equal(await publishingOf(t, other), null, 'another app is not publishing');
    first.open();
    await until(() => t.submitStores.ios.submitCalls === 1);
    assert.equal((await publishingOf(t, app)).currentStep, 'submit', 'the next step is named');
    second.open();
    const done = await running;
    assert.equal(done.status, 200, done.text.slice(0, 400));
    assert.equal(done.body.result.completed, true);
    assert.equal(await publishingOf(t, app), null, 'cleared after success');
    assert.equal(await t.publishClaim(app), undefined);
    assert.deepEqual((await t.call(t.owner, 'GET', '/pending/publishing')).body.apps, []);
    const left = (await t.call(t.owner, 'GET', `/apps/${app}/pending/cart`)).body.cart;
    assert.deepEqual(left.items, [], 'what was published has left the cart by itself');
    assert.equal(left.publishing, null);
  },
);

dbTest(
  'publishing: cleared after a failed step too (and the step that failed was shown)',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    t.submitStores.ios.behavior = { kind: 'unknown', applied: true };
    t.submitStores.ios.readFailsAfterWrite = true;
    const p = (await t.plan(app)).body.plan;
    const running = t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    await until(() => t.stores.ios.applyCalls === 1);
    assert.equal((await publishingOf(t, app)).currentStep, 'push_draft');
    hold.open();
    const done = await running;
    assert.equal(done.status, 200, done.text.slice(0, 400));
    assert.equal(done.body.result.completed, false);
    assert.equal(done.body.result.stoppedAt, 'submit');
    assert.equal(await publishingOf(t, app), null, 'cleared after a failure');
    assert.equal(await t.publishClaim(app), undefined);
    // The push applied and the submit did not: what was pushed left the cart, and the draft waits for its submit.
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    assert.ok(
      view.platforms[0].items.some((i: any) => i.kind === 'pushed_draft'),
      'the pushed draft still waits for its submit',
    );
  },
);

dbTest(
  'publishing: a claim nobody has touched for the time to live is a dead process: not reported, not blocking; a heartbeat keeps an old claim alive',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const insert = (claimAt: number, stepAt: number | null) =>
      db.execute(
        `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at, steps, current_step, step_at)
         VALUES (?, 'ios', ?, 'publish', 'writing', 'u', ?, '["push_draft","submit"]', 'submit', ?)`,
        [app, t.workspaceId, claimAt, stepAt],
      );
    await insert(1, null);
    assert.equal(await publishingOf(t, app), null, 'stale: not reported');
    assert.deepEqual((await t.call(t.owner, 'GET', '/pending/publishing')).body.apps, []);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${app}/pending/cart`)).body.cart.publishing,
      null,
    );
    // A write is not refused for a dead process.
    const guarded = await t.call(t.owner, 'POST', `/apps/${app}/store-submit`, {});
    assert.notEqual(guarded.body.error, 'publish_in_progress');
    // Started long ago but a step began a moment ago: alive.
    await db.execute('DELETE FROM store_publish_claims WHERE app_id = ?', [app]);
    await insert(1, Date.now());
    const alive = await publishingOf(t, app);
    assert.equal(alive.startedAt, 1);
    assert.equal(alive.currentStep, 'submit');
    assert.deepEqual(alive.steps, ['push_draft', 'submit']);
    assert.equal(alive.by.id, 'u');
    assert.equal(alive.by.name, null, 'a person who is gone has no name');
    const blocked = await t.publish(app, { planHash: HASH, steps: [{ type: 'push_draft' }] });
    assert.equal(blocked.body.error, 'publish_in_progress', 'a live claim is not taken over');
  },
);

dbTest(
  'publishing: a second publish, and every write that would release or change the same app, is refused with publish_in_progress naming when it started',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t, 'Weather');
    const other = await t.addApp('ios', 'Other');
    const hold = gate();
    t.stores.ios.gate = hold.promise;
    const p = (await t.plan(app)).body.plan;
    const body = { planHash: p.planHash, phrase: p.confirmation.phrase, steps: p.publishSteps };
    const running = t.publish(app, body);
    await until(() => t.stores.ios.applyCalls === 1);
    const started = (await publishingOf(t, app)).startedAt as number;
    const since = `${new Date(started).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const refused: [string, string, unknown][] = [
      ['POST', `/apps/${app}/publish`, body],
      ['POST', `/apps/${app}/store-release`, {}],
      ['POST', `/apps/${app}/store-submit`, {}],
      ['POST', `/apps/${app}/rollout/apply`, {}],
      ['POST', `/apps/${app}/store-version`, {}],
      ['POST', `/apps/${app}/staged/push`, {}],
      ['DELETE', `/apps/${app}/staged`, undefined],
      ['POST', `/apps/${app}/pending/publish`, { items: [{ id: 'listing:x', version: 'v' }] }],
      ['POST', `/apps/${app}/pending/discard`, { ids: ['listing:x'] }],
    ];
    for (const [method, path, payload] of refused) {
      const res = await t.call(t.owner, method, path, payload);
      assert.equal(res.status, 409, `${method} ${path}: ${res.text.slice(0, 200)}`);
      assert.equal(res.body.error, 'publish_in_progress', `${method} ${path}`);
      assert.equal(res.body.code, 'publish.inProgress.since');
      assert.equal(res.body.startedAt, started);
      assert.ok(String(res.body.message).includes(since), res.body.message);
    }
    assert.equal(t.stores.ios.applyCalls, 1, 'nothing else reached the store');
    const free = await t.call(t.owner, 'POST', `/apps/${other}/store-release`, {});
    assert.notEqual(free.body.error, 'publish_in_progress', 'another app is not held up');
    hold.open();
    assert.equal((await running).status, 200);
    const after = await t.call(t.owner, 'POST', `/apps/${app}/store-release`, {});
    assert.notEqual(after.body.error, 'publish_in_progress', 'free again once it finished');
  },
);
