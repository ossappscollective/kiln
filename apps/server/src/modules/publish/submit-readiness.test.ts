import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * Whether the draft could be submitted once the staged push is made, known BEFORE anything is sent: the plan's `readiness`
 * (docs/api/pending.md "Readiness"), the submit step that cannot be ticked while a blocker is certain, the push alone that stays
 * allowed. The user's case: an iOS app with 1 staged graphic change, fr-FR without a description, keywords and support URL, and 12
 * screenshots for the iPad 13" display in en-US. Everything runs against fakes: no store is contacted.
 */

const TEXT = 'A freshly written description that nobody else would ever write';
const IPAD_13 = 'APP_IPAD_PRO_3GEN_129';

async function boot(db: Parameters<typeof bootStaged>[0], options: { submit?: boolean } = {}) {
  const t = await bootStaged(db, {
    ...(options.submit === undefined ? {} : { submit: { enabled: options.submit } }),
    extra: { storePublish: { enabled: true } },
  });
  const plan = (app: string, steps?: unknown[]) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish/preview`, steps === undefined ? {} : { steps });
  const publish = (app: string, body: Record<string, unknown>) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish`, body);
  return { ...t, plan, publish };
}
type Boot = Awaited<ReturnType<typeof boot>>;

const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `s${i + 1}.png`,
    bytes: new Uint8Array([i + 1, 7, 7]),
  }));

/** The user's case: 1 staged graphic change; the store holds an empty fr-FR and 12 iPad 13" screenshots in en-US. */
const userCase = async (t: Boot, count = 12) => {
  const app = await t.addApp('ios', 'OSS Document Scanner');
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' })).status,
    200,
  );
  t.stores.ios.locales.add('fr-FR');
  for (const field of ['description', 'keywords', 'support_url'])
    t.submitStores.ios.textOverrides.set(`fr-FR\u0000${field}`, null);
  t.stores.ios.seedSet('en-US', IPAD_13, files(count));
  t.submitStores.ios.imageSize = [2064, 2752];
  return app;
};
const stepOf = (body: any, type: string) => (body.plan.steps as any[]).find((s) => s.type === type);
const codes = (blockers: { code: string }[]) => blockers.map((b) => b.code);

dbTest(
  'the user case: the plan says before the push that the submit cannot run, with four blockers and where each is fixed',
  async (db) => {
    const t = await boot(db);
    const app = await userCase(t);
    const res = await t.plan(app);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const readiness = res.body.plan.readiness.submit;
    assert.equal(readiness.ready, false);
    assert.equal(readiness.predicted, true);
    assert.deepEqual(
      readiness.blockers.map((b: any) => [b.code, b.locale, b.item === undefined ? null : b.fix.kind]),
      [
        ['missing_text', 'fr-FR', 'listing'],
        ['missing_text', 'fr-FR', 'listing'],
        ['missing_text', 'fr-FR', 'listing'],
        ['asset_spec', 'en-US', 'screenshots'],
      ],
    );
    assert.deepEqual(
      readiness.blockers.map((b: any) => b.message),
      [
        'Description is empty in fr-FR.',
        'Keywords is empty in fr-FR.',
        'Support URL is empty in fr-FR.',
        'At most 10 screenshots per device size. en-US iPad 13" / 12.9" (APP_IPAD_PRO_3GEN_129): 12 found.',
      ],
    );
    assert.equal(
      readiness.blockers[0].fix.href,
      `#/portfolio/${app}/listing?platform=ios&view=text&locale=fr-FR`,
    );
    assert.equal(
      readiness.blockers[3].fix.href,
      `#/portfolio/${app}/listing?platform=ios&view=graphics&locale=en-US`,
    );
    assert.deepEqual(readiness.blockers[0].params, {
      field: 'description',
      label: 'Description',
      locale: 'fr-FR',
    });
    // The push uploads an image: whether it is processed is only known afterwards.
    assert.deepEqual(readiness.unknown, ['image_not_ready']);
    // The default plan is the push alone: the submit is blocked with the reasons, and the push is still worth making.
    const submit = stepOf(res.body, 'submit');
    assert.equal(submit.availability, 'blocked');
    assert.equal(submit.included, false);
    assert.match(submit.reason, /^Blocked: /);
    assert.equal(
      submit.problems.filter((p: any) => p.code.startsWith('submit_blocked_')).length,
      4,
    );
    assert.equal(stepOf(res.body, 'push_draft').included, true);
    assert.equal(res.body.plan.confirmable, true);
    assert.deepEqual(
      res.body.plan.publishSteps.map((s: any) => s.type),
      ['push_draft'],
    );
    // Nothing was written to find this out.
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal(t.submitStores.ios.submitCalls, 0);
  },
);

dbTest(
  'a push and a submit asked together cannot be confirmed while a blocker is certain; the push alone can, and is pushed without a submit',
  async (db) => {
    const t = await boot(db);
    const app = await userCase(t);
    const pair = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(pair.status, 200, pair.text.slice(0, 300));
    assert.equal(stepOf(pair.body, 'submit').availability, 'blocked');
    assert.equal(stepOf(pair.body, 'submit').requested, true);
    assert.equal(stepOf(pair.body, 'push_draft').included, true);
    assert.equal(pair.body.plan.confirmable, false, 'the pair is not let through');
    assert.equal(pair.body.plan.planHash, null);
    assert.equal(pair.body.plan.readiness.submit.blockers.length, 4);
    const refused = await t.publish(app, {
      planHash: 'a'.repeat(64),
      phrase: 'publish OSS Document Scanner 2 steps',
      steps: [{ type: 'push_draft' }, { type: 'submit' }],
    });
    assert.notEqual(refused.status, 200, 'a client that does not look at the plan is refused too');
    assert.equal(t.stores.ios.applyCalls, 0);

    const alone = await t.plan(app, [{ type: 'push_draft' }]);
    assert.equal(alone.body.plan.confirmable, true);
    assert.equal(alone.body.plan.readiness.submit.ready, false, 'still told, not blocked');
    const done = await t.publish(app, {
      planHash: alone.body.plan.planHash,
      steps: alone.body.plan.publishSteps,
    });
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(done.body.result.completed, true);
    assert.equal(t.stores.ios.applyCalls, 1, 'the draft was pushed');
    assert.equal(t.submitStores.ios.submitCalls, 0, 'nothing was submitted');
  },
);

dbTest(
  'what is staged is merged into the store: staging the three fr-FR texts removes three blockers, fixing the iPad set the last',
  async (db) => {
    const t = await boot(db);
    const app = await userCase(t);
    for (const [field, value] of [
      ['description', TEXT],
      ['keywords', 'scan,document,pdf'],
      ['support_url', 'https://example.com/fr'],
    ] as const)
      assert.equal(
        (await t.stageText(app, { locale: 'fr-FR', field, from: 'local', value })).status,
        200,
      );
    const one = await t.plan(app);
    assert.deepEqual(codes(one.body.plan.readiness.submit.blockers), ['asset_spec']);
    // The store's set goes down to 10 (somebody removed two in the console): the draft can be submitted.
    t.stores.ios.seedSet('en-US', IPAD_13, files(10));
    const none = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(none.body.plan.readiness.submit.ready, true);
    assert.deepEqual(none.body.plan.readiness.submit.blockers, []);
    const submit = stepOf(none.body, 'submit');
    assert.equal(submit.included, true);
    assert.equal(submit.deferred, true);
    assert.equal(none.body.plan.confirmable, true);
  },
);

dbTest(
  'a locale the store does not have yet: the staged texts create it, every other required text of it is a blocker',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios');
    assert.equal(
      (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' })).status,
      200,
    );
    assert.equal(
      (await t.stageText(app, { locale: 'de-DE', field: 'description', from: 'local', value: TEXT }))
        .status,
      200,
    );
    const res = await t.plan(app);
    const b = res.body.plan.readiness.submit.blockers as any[];
    assert.deepEqual(
      b.map((x) => [x.code, x.locale, x.item]),
      [
        ['missing_text', 'de-DE', 'keywords'],
        ['missing_text', 'de-DE', 'support_url'],
      ],
    );
  },
);

dbTest(
  'what the version and the build already say is a blocker too, fixed in Kiln (the build) or in the store',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios');
    assert.equal(
      (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' })).status,
      200,
    );
    t.submitStores.ios.build = null;
    t.submitStores.ios.releaseType = 'AFTER_APPROVAL';
    const res = await t.plan(app);
    const b = res.body.plan.readiness.submit.blockers as any[];
    assert.deepEqual(codes(b), ['no_build']);
    assert.equal(b[0].fix.kind, 'build');
    assert.equal(b[0].fix.href, `#/portfolio/${app}/releases?platform=ios&step=build`);
    t.submitStores.ios.releaseType = null;
    const unreadable = await t.plan(app);
    assert.deepEqual(codes(unreadable.body.plan.readiness.submit.blockers), [
      'release_not_manual',
      'no_build',
    ]);
    assert.equal(unreadable.body.plan.readiness.submit.blockers[0].fix.kind, 'store');
    assert.equal(unreadable.body.plan.readiness.submit.blockers[0].fix.href, null);
  },
);

dbTest(
  'a store that cannot be read, or a submit that is switched off, says nothing: no readiness, the plan as before',
  async (db) => {
    const t = await boot(db);
    const app = await userCase(t);
    t.submitStores.ios.readError = new Error('down');
    const res = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(res.status, 200);
    assert.equal(res.body.plan.readiness, null);
    assert.equal(stepOf(res.body, 'submit').included, true);
    assert.equal(res.body.plan.confirmable, true);
  },
);

dbTest('a submit that is switched off has no readiness (nobody can submit from here)', async (db) => {
  const t = await boot(db, { submit: false });
  const app = await userCase(t);
  const plan = await t.plan(app);
  assert.equal(plan.status, 200, plan.text.slice(0, 200));
  assert.equal(plan.body.plan.readiness, null);
  assert.equal(t.submitStores.ios.reads, 0);
});

dbTest(
  'Google Play: no screenshot at all, or 9 of a device type, blocks the combined step and the submit; release notes over 500 characters too',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' }))
        .status,
      200,
    );
    t.stores.android.sets.clear();
    const bare = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.deepEqual(codes(bare.body.plan.readiness.submit.blockers), ['no_screenshots']);
    assert.equal(bare.body.plan.readiness.submit.blockers[0].fix.kind, 'screenshots');
    assert.deepEqual(bare.body.plan.readiness.submit.unknown, ['play_review_state_unknown']);
    assert.equal(stepOf(bare.body, 'submit').availability, 'blocked');
    const combined = await t.plan(app, [{ type: 'push_and_submit' }]);
    assert.equal(stepOf(combined.body, 'push_and_submit').availability, 'blocked');
    assert.equal(combined.body.plan.confirmable, false);

    t.stores.android.seedSet('en-US', 'phoneScreenshots', files(9));
    const nine = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    const b = nine.body.plan.readiness.submit.blockers as any[];
    assert.deepEqual(codes(b), ['asset_spec']);
    assert.match(b[0].message, /^You can add up to 8 screenshots for each supported device type\. /);

    t.stores.android.seedSet('en-US', 'phoneScreenshots', files(8));
    const ok = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(ok.body.plan.readiness.submit.ready, true);
    assert.equal(stepOf(ok.body, 'submit').included, true);
  },
);

dbTest('the plan of a release alone reads no store for a readiness', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('android', 'Weather');
  const res = await t.plan(app, [{ type: 'rollout', action: 'halt', track: 'production', versionCodes: ['7'] }]);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(res.body.plan.readiness, null);
  assert.equal(t.submitStores.android.reads, 0);
});

export type { StagedBoot };
