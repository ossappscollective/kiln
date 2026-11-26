import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { recommendationOf } from './store-publish.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * The plan says which step it recommends (`plan.recommended`), so a person is never left with an empty plan while a valid step
 * exists. A build staged for a track and nothing else is RELEASED (the direct release: one Play edit, committed without the
 * hold-back), never parked as a draft. Everything runs against fakes: no store is contacted.
 */

async function boot(db: Parameters<typeof bootStaged>[0], options: { release?: boolean } = {}) {
  const t = await bootStaged(db, {
    ...(options.release === undefined ? {} : { release: { enabled: options.release } }),
    extra: { storePublish: { enabled: true } },
  });
  const plan = (app: string, steps?: unknown[]) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish/preview`, steps === undefined ? {} : { steps });
  return { ...t, plan };
}

const stageBuild = async (t: StagedBoot, app: string, codes = '241') => {
  for (const body of [
    { field: 'track', value: 'production' },
    { field: 'version_codes', value: codes },
  ])
    assert.equal((await t.stageField(app, body)).status, 200);
};

const RELEASE = {
  types: ['release'],
  steps: [{ type: 'release', direct: true, track: 'production', versionCodes: ['241'] }],
  needsShare: true,
};

dbTest(
  'a promotion (only a build staged): recommended is the direct release, never an empty plan; the sync says where it comes from',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    await stageBuild(t, app);
    await db.execute(
      "INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, details_json, status_since, synced_at) VALUES ('r-1', ?, ?, 'android', '2.1', 'internal', 'live', 'completed', ?, 5, 5)",
      [app, t.workspaceId, JSON.stringify({ versionCodes: ['241'] })],
    );
    await db.execute(
      "INSERT INTO app_builds (app_id, platform, build_number, workspace_id, version, processing_state, first_seen_at, last_seen_at) VALUES (?, 'android', '241', ?, '2.1.0', 'processed', 5, 5)",
      [app, t.workspaceId],
    );
    const plan = (await t.plan(app)).body.plan;
    assert.deepEqual(plan.recommended, { ...RELEASE, why: 'promotion' });
    assert.deepEqual(plan.promotion, { from: 'internal', version: '2.1.0' });
    assert.equal(plan.defaultedToDirect, true);
    // The recommendation is a plan the server accepts as it is, with the person's share added.
    const asked = await t.plan(app, [{ ...plan.recommended.steps[0], userFraction: 1 }]);
    assert.equal(asked.body.plan.confirmable, true, JSON.stringify(asked.body.plan.steps));
    assert.deepEqual(asked.body.plan.recommended, { ...RELEASE, why: 'promotion' });
    // Asked for with only the draft push (the other way round) it is still offered.
    const draft = (await t.plan(app, [{ type: 'push_draft' }])).body.plan;
    assert.equal(draft.recommended.why, 'promotion');
  },
);

dbTest(
  'a build in no other track is a direct release; a release asked for without direct and without a draft is blocked with a reason, never silently idle',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    t.releaseStores.android.releases = t.releaseStores.android.releases.filter(
      (r) => r.status !== 'draft',
    );
    await stageBuild(t, app);
    const plan = (await t.plan(app)).body.plan;
    assert.equal(plan.recommended.why, 'direct_release');
    assert.equal(plan.promotion.from, null);
    const plain = (await t.plan(app, [{ type: 'release', track: 'production', userFraction: 1 }])).body
      .plan;
    const step = plain.steps.find((s: any) => s.type === 'release');
    assert.equal(step.availability, 'blocked', 'not "nothing to do"');
    assert.match(step.reason, /no draft release to start/);
    assert.equal(plain.confirmable, false);
    assert.equal(plain.recommended.types[0], 'release', 'and the direct release is what is recommended');
  },
);

dbTest(
  'texts staged and Google refused a draft: the push and the submit in one step is recommended and defaulted, never a build left as a draft',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' })).status,
      200,
    );
    assert.equal((await t.plan(app)).body.plan.recommended.why, 'draft');
    t.stores.android.draftRefused = true;
    const first = await t.call(t.owner, 'POST', `/apps/${app}/publish/preview`, {
      steps: [{ type: 'push_draft' }],
    });
    const run = await t.call(t.owner, 'POST', `/apps/${app}/publish`, {
      planHash: first.body.plan.planHash,
      steps: first.body.plan.publishSteps,
    });
    assert.equal(run.body.result.completed, false, run.text.slice(0, 300));
    const plan = (await t.plan(app)).body.plan;
    assert.deepEqual(plan.recommended, {
      types: ['push_and_submit'],
      steps: [{ type: 'push_and_submit' }],
      why: 'draft_refused',
      needsShare: false,
    });
    assert.equal(plan.combined.defaulted, true);
    assert.deepEqual(
      plan.publishSteps.map((x: { type: string }) => x.type),
      ['push_and_submit'],
    );
  },
);

dbTest(
  'a plain staged text change only: recommended is the draft push',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' })).status,
      200,
    );
    const plan = (await t.plan(app)).body.plan;
    assert.deepEqual(plan.recommended, {
      types: ['push_draft'],
      steps: [{ type: 'push_draft' }],
      why: 'draft',
      needsShare: false,
    });
    assert.equal(plan.promotion, null);
  },
);

dbTest(
  'the release switch is off: a build is never recommended as a release, the draft is',
  async (db) => {
    const t = await boot(db, { release: false });
    const app = await t.addApp('android', 'Mail');
    await stageBuild(t, app);
    const plan = (await t.plan(app)).body.plan;
    assert.equal(plan.recommended?.types.includes('release') ?? false, false);
    assert.equal(plan.recommended?.why, 'draft');
  },
);

type Facts = Parameters<typeof recommendationOf>[0];
const FACTS: Facts = {
  google: true,
  staged: { texts: 0, assets: 0, fields: 2 },
  direct: { track: 'production', versionCodes: ['90'] },
  from: 'internal',
  draftRefused: false,
  can: { push_draft: true, push_and_submit: true, submit: true, release: true, rollout: true },
  unavailable: {},
  included: [],
};

const rec = (patch: Partial<Facts>) => recommendationOf({ ...FACTS, ...patch });

dbTest('recommendationOf: the rules, one by one', async () => {
  assert.equal(rec({})?.why, 'promotion');
  assert.equal(rec({ from: null })?.why, 'direct_release');
  assert.equal(rec({ draftRefused: true })?.why, 'promotion', 'refused drafts never push a build to a draft');
  // The release cannot run: the build alone is a draft push; with drafts refused there is nothing to push as a draft with no text.
  assert.equal(rec({ can: { ...FACTS.can, release: false } })?.why, 'draft');
  assert.equal(rec({ unavailable: { release: true } })?.why, 'draft');
  // Texts staged: the draft push, or the combined step once Google refused a draft.
  const texts = { texts: 2, assets: 0, fields: 2 };
  assert.equal(rec({ staged: texts })?.why, 'draft');
  assert.equal(rec({ staged: texts, draftRefused: true })?.why, 'draft_refused');
  assert.deepEqual(rec({ staged: texts, draftRefused: true })?.types, ['push_and_submit']);
  assert.equal(
    rec({ staged: texts, draftRefused: true, unavailable: { push_and_submit: true } })?.why,
    'draft',
  );
  assert.equal(rec({ staged: texts, direct: null, can: { ...FACTS.can, push_draft: false } }), null);
  // Nothing staged: nothing to recommend. Another platform: the plan's own steps.
  assert.equal(rec({ staged: { texts: 0, assets: 0, fields: 0 }, direct: null }), null);
  assert.deepEqual(rec({ google: false, staged: null, included: ['push_draft', 'submit'] }), {
    types: ['push_draft', 'submit'],
    steps: [{ type: 'push_draft' }, { type: 'submit' }],
    why: 'default',
    needsShare: false,
  });
  assert.equal(rec({ google: false, staged: null }), null);
});
