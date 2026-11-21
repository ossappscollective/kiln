import assert from 'node:assert/strict';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { ASC_SECRET, bootStaged, PLAY_SECRET, type StagedBoot } from './test-helpers.ts';

/**
 * Submitting the pushed store draft for review (docs/api/submit.md, docs/adr/0010-store-submit.md). Everything runs
 * against fakes: no store and no GitHub is contacted.
 */

const TEXT = 'A freshly written description that nobody else would ever write';
const K = (locale: string, field: string) => `${locale}\u0000${field}`;
const HASH = 'a'.repeat(64);

/** An iOS app with a text and two screenshots staged AND pushed as a draft. */
async function pushedIos(t: StagedBoot) {
  const app = await t.addApp('ios');
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
  const pushed = await t.previewAndPush(app);
  assert.equal(pushed.push.status, 200, pushed.push.text.slice(0, 300));
  return app;
}
async function pushedAndroid(t: StagedBoot) {
  const app = await t.addApp('android');
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' }))
      .status,
    200,
  );
  assert.equal((await t.stageAssets(app, { locale: 'en-US', kind: 'icon' })).status, 200);
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'phone' })).status,
    200,
  );
  const pushed = await t.previewAndPush(app);
  assert.equal(pushed.push.status, 200, pushed.push.text.slice(0, 300));
  return app;
}
const noSubmitIo = (t: StagedBoot) => {
  for (const store of [t.submitStores.ios, t.submitStores.android])
    assert.equal(store.reads + store.submitCalls, 0);
  assert.equal(t.submitBuilt.length, 0, 'no submit connector was built');
};
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), 'the condition was not met in time');
};
const codes = (items: { code: string }[]) => items.map((i) => i.code);

// ----- the kill switch -----------------------------------------------------------------------------------

dbTest(
  'kill switch: with it off preview and submit answer 409 store_submit_disabled, no store is reached; the state still shows',
  async (db) => {
    const t = await bootStaged(db, { submit: { enabled: false } });
    const app = await pushedIos(t);
    const config = await t.call(t.owner, 'GET', '/store-submit/config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [
        config.body.enabled,
        config.body.envName,
        config.body.action,
        config.body.minimumRole,
        config.body.irreversible,
        config.body.releases,
      ],
      [false, 'MRM_STORE_SUBMIT_ENABLED', 'store.submit', 'admin', true, false],
    );
    for (const res of [
      await t.submitPreview(app),
      await t.submitApply(app, { confirmHash: HASH, confirmation: 'submit com.acme.app 2.1' }),
    ]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'store_submit_disabled');
      assert.match(res.body.message, /MRM_STORE_SUBMIT_ENABLED=true/);
    }
    noSubmitIo(t);
    const state = await t.submitState(app);
    assert.equal(state.status, 200);
    assert.equal(state.body.submit.enabled, false);
    assert.equal(state.body.submit.pushed, true, 'the push was recorded while the switch was off');
    assert.equal(await t.submitClaim(app), undefined);
    assert.equal((await t.audit('listing.submit%')).length, 0);
    // The rights check comes first: someone who may not submit learns nothing about the switch.
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.submitApply(app, { confirmHash: HASH, confirmation: 'x' }, viewer)).status,
      403,
    );
  },
);

dbTest(
  'kill switch: an app created without the option is off too (the default); drafts being on does not turn it on',
  async (db) => {
    const t = await bootRepoApp(db);
    const config = await t.call(t.owner, 'GET', '/store-submit/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.enabled, false);
    assert.equal((await t.call(t.owner, 'POST', '/apps/x/store-submit/preview', {})).status, 409);
    assert.equal(
      (
        await t.call(t.owner, 'POST', '/apps/x/store-submit', {
          confirmHash: HASH,
          confirmation: 'x',
        })
      ).status,
      409,
    );
  },
);

dbTest('kill switch: drafts being on does not turn submitting on', async (db) => {
  const t = await bootStaged(db, { draft: { enabled: true }, submit: { enabled: false } });
  assert.equal((await t.call(t.owner, 'GET', '/store-draft/config')).body.enabled, true);
  assert.equal((await t.call(t.owner, 'GET', '/store-submit/config')).body.enabled, false);
});

// ----- rights ---------------------------------------------------------------------------------------------

dbTest(
  'rights: only owners and admins see the state, preview or submit; non-members get 404',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    for (const cookie of [viewer, member]) {
      assert.equal((await t.submitState(app, cookie)).status, 403);
      assert.equal((await t.submitPreview(app, cookie)).status, 403);
      assert.equal(
        (await t.submitApply(app, { confirmHash: HASH, confirmation: 'x' }, cookie)).status,
        403,
      );
      assert.equal((await t.call(cookie, 'GET', '/store-submit/config')).status, 200);
    }
    noSubmitIo(t);
    assert.equal((await t.previewAndSubmit(app, admin)).submit.status, 200, 'an admin may');
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    for (const [method, path, body] of [
      ['GET', '/store-submit/config'],
      ['GET', t.sub(app)],
      ['POST', t.sub(app, '/preview'), {}],
      ['POST', t.sub(app), { confirmHash: HASH, confirmation: 'x' }],
    ] as const) {
      assert.equal((await t.call(outsider, method, path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal((await t.submitPreview('no-such-app')).status, 404);
    assert.equal(t.submitStores.ios.submitCalls, 1, 'only the admin’s submit reached the store');
  },
);

dbTest(
  'tokens: the action must be named (no list never counts), the ceiling still applies, an app limited token reaches only its apps',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const other = await t.addApp('ios');
    const mint = async (input: Record<string, unknown>) => {
      const res = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input });
      assert.equal(res.status, 201, res.text);
      return res.body.token as string;
    };
    const bearer = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    const everything = await mint({});
    assert.equal(
      (await bearer(everything, 'POST', t.sub(app, '/preview'), {})).status,
      403,
      'no list: never',
    );
    assert.equal(
      (await bearer(everything, 'POST', t.sub(app), { confirmHash: HASH, confirmation: 'x' }))
        .status,
      403,
    );
    const pushOnly = await mint({ actions: ['apps.read', 'store.push_draft'] });
    assert.equal(
      (await bearer(pushOnly, 'POST', t.sub(app), { confirmHash: HASH, confirmation: 'x' })).status,
      403,
      'push rights are not submit rights',
    );
    const tooLow = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'member',
      actions: ['store.submit'],
    });
    assert.equal(
      tooLow.status,
      400,
      'the ceiling still applies: a member token cannot be given the action',
    );
    assert.equal(tooLow.body.error, 'action_above_role');
    noSubmitIo(t);

    const scoped = await mint({ actions: ['store.submit', 'apps.read'], appIds: [app] });
    assert.equal(
      (await bearer(scoped, 'POST', t.sub(other, '/preview'), {})).status,
      404,
      'another app',
    );
    const fresh = await bearer(scoped, 'POST', t.sub(app, '/preview'), {});
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body).slice(0, 300));
    const done = await bearer(scoped, 'POST', t.sub(app), {
      confirmHash: fresh.body.preview.confirmHash,
      confirmation: fresh.body.preview.confirmation.phrase,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
    assert.equal(
      (await t.audit('listing.submitted'))[0]?.actorType,
      'token',
      'a submit by a token is attributed to the token',
    );
  },
);

// ----- the record of the push -----------------------------------------------------------------------------

dbTest(
  'nothing pushed: preview and submit are 409 nothing_pushed and no store is contacted',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const state = await t.submitState(app);
    assert.deepEqual([state.body.submit.pushed, state.body.submit.push], [false, null]);
    for (const res of [
      await t.submitPreview(app),
      await t.submitApply(app, { confirmHash: HASH, confirmation: 'submit com.acme.app' }),
    ]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'nothing_pushed');
    }
    noSubmitIo(t);
  },
);

dbTest(
  'a successful push records hashes and ids only; a refused push records nothing; later pushes merge',
  async (db) => {
    const t = await bootStaged(db);
    const droid = await t.addApp('android');
    assert.equal(
      (await t.stageText(droid, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' }))
        .status,
      200,
    );
    t.stores.android.behavior = {
      kind: 'refuse',
      error: new StoreError('googleplay', 'forbidden', 'no', 403),
    };
    assert.equal((await t.previewAndPush(droid)).push.status, 422);
    assert.equal(await t.pushRecord(droid), undefined, 'a refused push is not recorded');
    assert.equal((await t.submitState(droid)).body.submit.pushed, false);
    t.stores.android.behavior = { kind: 'ok' };
    assert.equal((await t.previewAndPush(droid)).push.status, 200);
    const record = await t.pushRecord(droid);
    assert.ok(record);
    assert.equal(record?.platform, 'android');
    assert.equal(record?.version_id, null);
    const first = JSON.parse(String(record?.items));
    assert.deepEqual(
      first.text.map((x: { locale: string; field: string }) => [x.locale, x.field]),
      [['en-US', 'title']],
    );
    assert.ok(!String(record?.items).includes('Acme'), 'a text is kept as a hash, never as text');

    assert.equal(
      (
        await t.stageText(droid, {
          locale: 'en-US',
          field: 'short_description',
          from: 'local',
          value: 'Short text',
        })
      ).status,
      200,
    );
    assert.equal((await t.previewAndPush(droid)).push.status, 200);
    const merged = JSON.parse(String((await t.pushRecord(droid))?.items));
    assert.deepEqual(
      merged.text.map((x: { field: string }) => x.field).sort(),
      ['short_description', 'title'],
      'the record holds everything written since the last submit',
    );

    const app = await pushedIos(t);
    const ios = JSON.parse(String((await t.pushRecord(app))?.items));
    assert.ok(!JSON.stringify(ios).includes(TEXT));
    assert.deepEqual(Object.keys(ios.assets[0]).sort(), [
      'device',
      'files',
      'height',
      'key',
      'kind',
      'locale',
      'target',
      'width',
    ]);
    assert.deepEqual(Object.keys(ios.assets[0].files[0]).sort(), ['md5', 'sha256']);
    const state = (await t.submitState(app)).body.submit;
    assert.deepEqual(
      [state.pushed, state.push.versionString, state.push.texts, state.push.assetSets],
      [true, '2.1', 1, 1],
    );
  },
);

// ----- preview -----------------------------------------------------------------------------------------------

dbTest(
  'preview (App Store): what goes to review, version, build, what cannot be undone, the checks, a hash and the text to type; nothing is written',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const res = await t.submitPreview(app);
    assert.equal(res.status, 200, res.text.slice(0, 400));
    const p = res.body.preview;
    assert.deepEqual([p.app.id, p.app.platform, p.app.store], [app, 'ios', 'appstoreconnect']);
    assert.deepEqual(p.version, {
      id: 'v-next',
      versionString: '2.1',
      state: 'PREPARE_FOR_SUBMISSION',
      releaseType: 'MANUAL',
    });
    assert.deepEqual(p.build, {
      id: 'build-1',
      version: '45',
      processingState: 'VALID',
      expired: false,
    });
    assert.equal(p.submits, true);
    assert.equal(p.releases, false);
    assert.deepEqual(p.tracks, []);
    assert.equal(p.contents.pushed.texts, 1);
    assert.equal(p.contents.pushed.assetSets, 1);
    assert.equal(p.contents.includesChangesNotPushedHere, false);
    assert.equal(p.contents.locales[0].locale, 'en-US');
    assert.deepEqual(
      p.contents.locales[0].screenshotSets.map(
        (s: { target: string; device: string; images: number }) => [s.target, s.device, s.images],
      ),
      [['APP_IPHONE_65', 'iphone_6_5', 2]],
    );
    assert.ok(p.irreversible.length >= 2);
    assert.match(p.irreversible.join(' '), /cannot withdraw/);
    assert.match(p.irreversible.join(' '), /Nothing is released/);
    assert.deepEqual([p.checks.canSubmit, p.checks.blocking], [true, []]);
    assert.match(p.confirmHash, /^[0-9a-f]{64}$/);
    assert.equal(p.confirmation.phrase, 'submit com.acme.app 2.1');
    assert.match(p.confirmation.instruction, /submit com\.acme\.app 2\.1/);
    assert.equal(t.submitStores.ios.submitCalls, 0);
    assert.equal(t.submitStores.ios.submissions.length, 0);
    assert.equal(await t.submitClaim(app), undefined);
    assert.equal(
      JSON.stringify(res.body).includes(TEXT),
      false,
      'the preview carries no listing text',
    );
    assert.equal(
      (await t.submitPreview(app)).body.preview.confirmHash,
      p.confirmHash,
      'the same store gives the same hash',
    );
  },
);

dbTest(
  'preview (Google Play): the tracks are shown and never written, the warnings say what cannot be known',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedAndroid(t);
    t.submitStores.android.tracks = [
      {
        track: 'production',
        releases: [{ name: '1.4', status: 'inProgress', userFraction: 0.2, versionCodes: ['44'] }],
      },
    ];
    const res = await t.submitPreview(app);
    assert.equal(res.status, 200, res.text.slice(0, 400));
    const p = res.body.preview;
    assert.equal(p.version, null);
    assert.equal(p.build, null);
    assert.equal(p.contents.includesChangesNotPushedHere, true);
    assert.equal(p.tracks[0].releases[0].userFraction, 0.2);
    assert.equal(p.checks.canSubmit, true, JSON.stringify(p.checks).slice(0, 400));
    assert.ok(codes(p.checks.warnings).includes('play_review_state_unknown'));
    assert.ok(codes(p.checks.warnings).includes('play_pending_changes'));
    assert.ok(codes(p.checks.warnings).includes('play_rollout_in_progress'));
    assert.equal(p.confirmation.phrase, 'submit com.acme.app');
    assert.match(p.irreversible.join(' '), /No track and no rollout is changed/);
    assert.equal(t.submitStores.android.submitCalls, 0);
  },
);

// ----- the checks ---------------------------------------------------------------------------------------------

const insertDraftClaim = async (t: StagedBoot, app: string, status: string) => {
  await t.db.execute(
    "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', ?, 'u', ?)",
    [app, t.workspaceId, status, Date.now()],
  );
};
type Break = {
  name: string;
  code: string;
  arrange: (t: StagedBoot, app: string) => void | Promise<void>;
};
const breaks: Break[] = [
  {
    name: 'a release type that could not be read',
    code: 'release_not_manual',
    arrange: (t) => void (t.submitStores.ios.releaseType = null),
  },
  { name: 'no build', code: 'no_build', arrange: (t) => void (t.submitStores.ios.build = null) },
  {
    name: 'an expired build',
    code: 'build_expired',
    arrange: (t) =>
      void (t.submitStores.ios.build = {
        id: 'b',
        version: '1',
        processingState: 'VALID',
        expired: true,
      }),
  },
  {
    name: 'a build still processing',
    code: 'build_not_valid',
    arrange: (t) =>
      void (t.submitStores.ios.build = {
        id: 'b',
        version: '1',
        processingState: 'PROCESSING',
        expired: false,
      }),
  },
  {
    name: 'a version already in review',
    code: 'already_submitted',
    arrange: (t) => void (t.submitStores.ios.submitted = true),
  },
  {
    name: 'a draft text changed in the store',
    code: 'draft_differs',
    arrange: (t) =>
      void t.stores.ios.texts.set(K('en-US', 'description'), 'changed by someone else'),
  },
  {
    name: 'a screenshot set changed in the store',
    code: 'draft_differs',
    arrange: (t) =>
      t.stores.ios.seedSet('en-US', 'APP_IPHONE_65', [
        { name: 'x.png', bytes: new Uint8Array([1, 2, 3]) },
      ]),
  },
  {
    name: 'another editable version',
    code: 'version_changed',
    arrange: (t) =>
      void (t.stores.ios.version = {
        id: 'v-other',
        versionString: '2.2',
        state: 'PREPARE_FOR_SUBMISSION',
      }),
  },
  { name: 'no locale', code: 'no_locales', arrange: (t) => t.stores.ios.locales.clear() },
  {
    name: 'a required text that is empty',
    code: 'missing_text',
    arrange: (t) => void t.submitStores.ios.textOverrides.set(K('en-US', 'keywords'), null),
  },
  {
    name: 'an image that is not processed',
    code: 'image_not_ready',
    arrange: (t) => void (t.submitStores.ios.imageState = 'FAILED'),
  },
  {
    name: 'a screenshot of no documented size',
    code: 'asset_spec',
    arrange: (t) => void (t.submitStores.ios.imageSize = [1000, 1000]),
  },
  {
    name: 'a push in progress',
    code: 'push_in_progress',
    arrange: (t, app) => insertDraftClaim(t, app, 'writing'),
  },
  {
    name: 'a push whose outcome is unknown',
    code: 'push_outcome_unknown',
    arrange: (t, app) => insertDraftClaim(t, app, 'unknown'),
  },
];

for (const [type, code] of [
  ['AFTER_APPROVAL', 'releases_after_approval'],
  ['SCHEDULED', 'releases_by_itself'],
] as const) {
  dbTest(
    `a version set to release ${type} can be submitted: a warning says it goes live by itself, nothing else changes`,
    async (db) => {
      const t = await bootStaged(db);
      const app = await pushedIos(t);
      t.submitStores.ios.releaseType = type;
      const done = await t.previewAndSubmit(app);
      assert.deepEqual(codes(done.preview.body.preview.checks.blocking), []);
      assert.ok(codes(done.preview.body.preview.checks.warnings).includes(code));
      assert.equal(done.preview.body.preview.releases, false, 'this server still releases nothing');
      assert.equal(done.submit.status, 200, done.submit.text.slice(0, 300));
      assert.equal(t.submitStores.ios.submitCalls, 1);
    },
  );
}

for (const item of breaks) {
  dbTest(
    `blocking check: ${item.name}: the preview says so and gives no hash; a submit confirmed earlier is refused and writes nothing`,
    async (db) => {
      const t = await bootStaged(db);
      const app = await pushedIos(t);
      const before = await t.submitPreview(app);
      assert.equal(before.body.preview.checks.canSubmit, true);
      await item.arrange(t, app);
      const res = await t.submitPreview(app);
      assert.equal(res.status, 200, res.text.slice(0, 400));
      const p = res.body.preview;
      assert.equal(p.checks.canSubmit, false);
      assert.ok(
        codes(p.checks.blocking).includes(item.code),
        `${item.code} in ${JSON.stringify(codes(p.checks.blocking))}`,
      );
      assert.equal(p.confirmHash, null);
      assert.equal(p.confirmation, null);
      const submitted = await t.submitApply(app, {
        confirmHash: before.body.preview.confirmHash,
        confirmation: before.body.preview.confirmation.phrase,
      });
      assert.equal(submitted.status, 409, submitted.text.slice(0, 300));
      if (item.code === 'push_in_progress') assert.equal(submitted.body.error, 'write_in_progress');
      else if (item.code === 'push_outcome_unknown')
        assert.equal(submitted.body.error, 'push_outcome_unknown');
      else {
        assert.equal(submitted.body.error, 'blocked');
        assert.ok(codes(submitted.body.checks.blocking).includes(item.code));
        assert.equal((await t.audit('listing.submit_failed'))[0]?.detail.outcome, 'refused');
      }
      assert.equal(t.submitStores.ios.submitCalls, 0, 'nothing was submitted');
      assert.equal(await t.submitClaim(app), undefined, 'the claim was given back');
      assert.ok(await t.pushRecord(app), 'the record of the push stays');
      assert.equal((await t.audit('listing.submitted')).length, 0);
    },
  );
}

dbTest(
  'warnings do not stop a submit: a locale without screenshots, an open review submission',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    t.stores.ios.locales.add('de-DE');
    t.submitStores.ios.openReviewSubmissions = 2;
    const p = (await t.submitPreview(app)).body.preview;
    assert.equal(p.checks.canSubmit, true, JSON.stringify(p.checks.blocking).slice(0, 300));
    assert.ok(codes(p.checks.warnings).includes('locale_without_screenshots'));
    assert.ok(codes(p.checks.warnings).includes('open_review_submission'));
    assert.equal(
      p.checks.warnings.find((w: { code: string }) => w.code === 'locale_without_screenshots')
        .locale,
      'de-DE',
    );
    const done = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(done.status, 200, done.text.slice(0, 300));
  },
);

dbTest(
  'a spec finding carries its rule and source; one whose number no official page confirms is only a warning',
  async (db) => {
    const t = await bootStaged(db);
    const droid = await pushedAndroid(t);
    t.submitStores.android.imageSize = [200, 200];
    const play = (await t.submitPreview(droid)).body.preview;
    const finding = [...play.checks.blocking, ...play.checks.warnings].find(
      (c: { code: string }) => c.code === 'asset_spec',
    );
    assert.ok(finding, JSON.stringify(play.checks).slice(0, 400));
    assert.match(finding.rule, /^play\./);
    assert.match(finding.source, /^https:/);
    assert.equal(typeof finding.verified, 'boolean');
    assert.equal(finding.severity === 'blocking', finding.verified === true);
  },
);

// ----- submitting ----------------------------------------------------------------------------------------------

dbTest(
  'submit (App Store): the version is handed to review once; audit and event carry ids and hashes only; the record is spent; nothing is released',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const res = await t.previewAndSubmit(app);
    assert.equal(res.submit.status, 200, res.submit.text.slice(0, 400));
    const r = res.submit.body.result;
    assert.deepEqual(r.version, { id: 'v-next', versionString: '2.1' });
    assert.deepEqual(r.submission, { id: 'sub-1', state: 'WAITING_FOR_REVIEW' });
    assert.deepEqual(
      [r.via, r.submitted, r.released, r.confirmedByReread],
      ['review_submission', true, false, false],
    );
    assert.match(r.note, /not be released by this server/);
    assert.equal(t.submitStores.ios.submitCalls, 1);
    assert.deepEqual(t.submitStores.ios.submissions, ['v-next']);
    assert.equal(await t.pushRecord(app), undefined, 'what was pushed is with review now');
    assert.equal(await t.submitClaim(app), undefined);
    assert.equal((await t.submitState(app)).body.submit.pushed, false);

    const audit = (await t.audit('listing.submitted'))[0];
    assert.equal(audit?.actorType, 'user');
    assert.deepEqual(Object.keys(audit?.detail ?? {}).sort(), [
      'appId',
      'buildId',
      'confirmedByReread',
      'hash',
      'platform',
      'store',
      'submissionId',
      'versionId',
      'via',
    ]);
    assert.equal(audit?.detail.hash, res.preview.body.preview.confirmHash);
    assert.deepEqual(
      [audit?.detail.versionId, audit?.detail.buildId, audit?.detail.submissionId],
      ['v-next', 'build-1', 'sub-1'],
    );
    const events = await t.events('listing.submitted');
    assert.equal(events.length, 1);
    const payload = events[0]?.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      'actor',
      'appId',
      'confirmedByReread',
      'platform',
      'released',
      'store',
      'submissionId',
      'versionString',
      'via',
    ]);
    assert.equal(payload.released, false);
    assert.equal(payload.versionString, '2.1');
    const used = (await t.audit('credential.use')).filter(
      (a) => a.detail.purpose === 'store.submit',
    );
    assert.ok(
      used.length >= 2,
      'the credential was used for the preview and the submit, under its own purpose',
    );
    assert.ok(
      t.submitBuilt.every((b) => b.kind === 'app_store_connect' && b.storeAppId === '1234567890'),
    );

    const again = await t.previewAndSubmit(app);
    assert.equal(
      again.preview.status,
      409,
      'the record is spent: another submit needs another push',
    );
    assert.equal(again.preview.body.error, 'nothing_pushed');
    assert.equal(t.submitStores.ios.submitCalls, 1);
  },
);

dbTest(
  'submit (Google Play): the changes are sent once; no submission id; no track is touched',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedAndroid(t);
    const res = await t.previewAndSubmit(app);
    assert.equal(res.submit.status, 200, res.submit.text.slice(0, 400));
    const r = res.submit.body.result;
    assert.deepEqual(
      [r.version, r.submission, r.via, r.submitted, r.released],
      [null, null, 'edit_commit', true, false],
    );
    assert.match(r.note, /No track or rollout was changed/);
    assert.equal(t.submitStores.android.submitCalls, 1);
    assert.equal(await t.pushRecord(app), undefined);
    const payload = (await t.events('listing.submitted'))[0]?.payload as Record<string, unknown>;
    assert.equal(payload.store, 'googleplay');
    assert.equal('submissionId' in payload, false);
    assert.equal('versionString' in payload, false);
  },
);

dbTest(
  'the typed confirmation: a wrong one is 422 and nothing is read or written; a malformed body is 400',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const p = (await t.submitPreview(app)).body.preview;
    const reads = t.submitStores.ios.reads;
    for (const wrong of ['', 'submit', 'SUBMIT com.acme.app 2.1', 'submit com.acme.app', 'yes']) {
      const res = await t.submitApply(app, { confirmHash: p.confirmHash, confirmation: wrong });
      // An empty one is a wrong one too: it may be left out only when the person's own confirmation stands in for it.
      assert.equal(res.status, 422, wrong);
      assert.equal(res.body.error, 'confirmation_mismatch');
      assert.equal(res.body.phrase, 'submit com.acme.app 2.1');
    }
    assert.equal(
      (await t.submitApply(app, { confirmHash: p.confirmHash })).status,
      422,
      'the confirmation is required (a missing one is a wrong one)',
    );
    assert.equal(
      (await t.submitApply(app, { confirmation: p.confirmation.phrase })).status,
      400,
      'the hash is required',
    );
    assert.equal(
      (await t.submitApply(app, { confirmHash: 'xyz', confirmation: p.confirmation.phrase }))
        .status,
      400,
    );
    assert.equal(
      (
        await t.submitApply(app, {
          confirmHash: p.confirmHash,
          confirmation: p.confirmation.phrase,
          extra: 1,
        })
      ).status,
      400,
    );
    assert.equal(t.submitStores.ios.reads, reads, 'the store was not read');
    assert.equal(t.submitStores.ios.submitCalls, 0);
    assert.equal(await t.submitClaim(app), undefined);
    assert.equal(
      (
        await t.submitApply(app, {
          confirmHash: p.confirmHash,
          confirmation: `  ${p.confirmation.phrase}  `,
        })
      ).status,
      200,
      'surrounding spaces do not matter',
    );
  },
);

dbTest(
  'the submit needs the hash of a preview: a hash of another state is 409 state_changed with a new preview and nothing is submitted',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const wrong = await t.submitApply(app, {
      confirmHash: HASH,
      confirmation: 'submit com.acme.app 2.1',
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'state_changed');
    assert.equal(wrong.body.preview.checks.canSubmit, true);
    assert.equal(t.submitStores.ios.submitCalls, 0);

    const p = (await t.submitPreview(app)).body.preview;
    t.submitStores.ios.build = {
      id: 'build-2',
      version: '46',
      processingState: 'VALID',
      expired: false,
    };
    const drift = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(drift.status, 409, 'the store changed after the preview');
    assert.equal(drift.body.error, 'state_changed');
    assert.equal(drift.body.preview.build.id, 'build-2');
    assert.notEqual(drift.body.preview.confirmHash, p.confirmHash);
    assert.equal(t.submitStores.ios.submitCalls, 0);
    assert.equal(await t.submitClaim(app), undefined);
    const failedAudit = await t.audit('listing.submit_failed');
    assert.equal(failedAudit[failedAudit.length - 1]?.detail.code, 'state_changed');
    const ok = await t.submitApply(app, {
      confirmHash: drift.body.preview.confirmHash,
      confirmation: drift.body.preview.confirmation.phrase,
    });
    assert.equal(ok.status, 200);
    assert.equal(t.submitStores.ios.submitCalls, 1);
  },
);

dbTest('a change of a track (Google Play) is part of what is confirmed', async (db) => {
  const t = await bootStaged(db);
  const app = await pushedAndroid(t);
  const p = (await t.submitPreview(app)).body.preview;
  t.submitStores.android.tracks = [
    {
      track: 'production',
      releases: [{ name: null, status: 'inProgress', userFraction: 0.5, versionCodes: ['9'] }],
    },
  ];
  const res = await t.submitApply(app, {
    confirmHash: p.confirmHash,
    confirmation: p.confirmation.phrase,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'state_changed');
  assert.equal(t.submitStores.android.submitCalls, 0);
});

// ----- one in flight ---------------------------------------------------------------------------------------------

dbTest(
  'one submit in flight per app: a second one meanwhile is 409 write_in_progress; the first finishes once',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const p = (await t.submitPreview(app)).body.preview;
    let open!: () => void;
    t.submitStores.ios.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    await until(() => t.submitStores.ios.submitCalls === 1);
    assert.equal((await t.submitState(app)).body.submit.inFlight.submit, true);
    const second = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'write_in_progress');
    open();
    assert.equal((await first).status, 200);
    assert.equal(t.submitStores.ios.submitCalls, 1);
    assert.equal(t.submitStores.ios.submissions.length, 1);
  },
);

dbTest(
  'a claim that expired is taken over; one marked unknown blocks until a preview reads the store',
  async (db) => {
    const t = await bootStaged(db, { submit: { claimTtlMs: 60_000 } });
    const app = await pushedIos(t);
    const old = Date.now() - 10 * 60_000;
    const insert = (status: string) =>
      db.execute(
        "INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'submit', ?, 'u', ?)",
        [app, t.workspaceId, status, old],
      );
    await insert('writing');
    const p = (await t.submitPreview(app)).body.preview;
    assert.equal(
      (
        await t.submitApply(app, {
          confirmHash: p.confirmHash,
          confirmation: p.confirmation.phrase,
        })
      ).status,
      200,
      'a dead submit does not block for ever',
    );

    const app2 = await pushedIos(t);
    await db.execute(
      "INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'submit', 'unknown', 'u', ?)",
      [app2, t.workspaceId, old],
    );
    const blockedFirst = await t.submitApply(app2, {
      confirmHash: HASH,
      confirmation: 'submit com.acme.app2 2.1',
    });
    assert.equal(blockedFirst.status, 409);
    assert.equal(blockedFirst.body.error, 'outcome_unknown');
    const p2 = await t.submitPreview(app2);
    assert.equal(
      await t.submitClaim(app2),
      undefined,
      'a preview read the store, so the unknown outcome is settled',
    );
    assert.equal(p2.status, 200);
  },
);

// ----- an unknown outcome ------------------------------------------------------------------------------------------

dbTest(
  'App Store, unknown outcome that was applied: the version is read back, the submit is confirmed and never sent twice',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const p = (await t.submitPreview(app)).body.preview;
    t.submitStores.ios.behavior = { kind: 'unknown', applied: true };
    const res = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.equal(res.body.result.confirmedByReread, true);
    assert.equal(
      res.body.result.submission,
      null,
      'the submission id is not known when the answer was lost',
    );
    assert.equal(t.submitStores.ios.submitCalls, 1, 'never sent again');
    assert.equal(await t.pushRecord(app), undefined);
    assert.equal(await t.submitClaim(app), undefined);
    assert.equal((await t.audit('listing.submitted'))[0]?.detail.confirmedByReread, true);
    assert.equal(
      ((await t.events('listing.submitted'))[0]?.payload as Record<string, unknown>)
        .confirmedByReread,
      true,
    );
  },
);

dbTest(
  'App Store, unknown outcome that was not applied: 502 write_failed (not_applied), the claim is given back, the record stays, nothing is sent twice',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const p = (await t.submitPreview(app)).body.preview;
    t.submitStores.ios.behavior = { kind: 'unknown', applied: false };
    const res = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'write_failed');
    assert.equal(res.body.outcome, 'not_applied');
    assert.equal(t.submitStores.ios.submitCalls, 1);
    assert.equal(await t.submitClaim(app), undefined);
    assert.ok(await t.pushRecord(app));
    const failedAudit = await t.audit('listing.submit_failed');
    assert.equal(failedAudit[failedAudit.length - 1]?.detail.code, 'not_applied');
    assert.equal((await t.audit('listing.submitted')).length, 0);
  },
);

dbTest(
  'App Store, unknown outcome that cannot be read back: outcome_unknown, blocks until a preview reads the store',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const p = (await t.submitPreview(app)).body.preview;
    t.submitStores.ios.behavior = { kind: 'unknown', applied: true };
    t.submitStores.ios.readFailsAfterWrite = true;
    const res = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outcome_unknown');
    assert.equal(String((await t.submitClaim(app))?.status), 'unknown');
    assert.equal((await t.submitState(app)).body.submit.unknownOutcome.submit, true);
    const blocked = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(t.submitStores.ios.submitCalls, 1, 'not sent again');
    t.submitStores.ios.readError = undefined;
    const after = await t.submitPreview(app);
    assert.equal(after.status, 200);
    assert.equal(after.body.preview.checks.canSubmit, false, 'the version is in review now');
    assert.ok(codes(after.body.preview.checks.blocking).includes('already_submitted'));
    assert.equal(await t.submitClaim(app), undefined, 'the preview settled the unknown outcome');
  },
);

dbTest(
  'Google Play, unknown outcome: reading cannot settle it, so it stays unknown and nothing is sent again',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedAndroid(t);
    const p = (await t.submitPreview(app)).body.preview;
    t.submitStores.android.behavior = { kind: 'unknown', applied: false };
    const readsBefore = t.submitStores.android.reads;
    const res = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outcome_unknown');
    assert.match(res.body.message, /Play Console/);
    assert.equal(
      t.submitStores.android.reads,
      readsBefore + 1,
      'only the read before the write: no read-back that could mislead',
    );
    assert.equal(String((await t.submitClaim(app))?.status), 'unknown');
    assert.ok(await t.pushRecord(app), 'the record stays: it was not confirmed');
    const again = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(again.body.error, 'outcome_unknown');
    assert.equal(t.submitStores.android.submitCalls, 1);
    assert.equal((await t.submitPreview(app)).status, 200, 'a preview is the way out');
    assert.equal(await t.submitClaim(app), undefined);
  },
);

dbTest(
  'a submit that outlives the timeout is read back, not repeated; a read that outlives it answers 504',
  async (db) => {
    const t = await bootStaged(db, { submit: { timeoutMs: 80 } });
    const app = await pushedIos(t);
    const p = (await t.submitPreview(app)).body.preview;
    let open!: () => void;
    t.submitStores.ios.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const res = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 502, res.text.slice(0, 300));
    assert.equal(res.body.outcome, 'not_applied');
    assert.equal(t.submitStores.ios.submitCalls, 1);
    open();
    t.submitStores.ios.readSubmitState = () => new Promise<never>(() => undefined);
    const read = await t.submitPreview(app);
    assert.equal(read.status, 504);
    assert.equal(read.body.error, 'timeout');
  },
);

// ----- refusals by the store ----------------------------------------------------------------------------------------

dbTest(
  'a refusal by the store: nothing submitted, a clear code, the claim given back, the record kept, an audit entry, no secret in the answer',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const droid = await pushedAndroid(t);
    const p = (await t.submitPreview(app)).body.preview;
    t.submitStores.ios.behavior = {
      kind: 'refuse',
      error: new StoreError('appstoreconnect', 'forbidden', `not allowed for ${ASC_SECRET}`, 403),
    };
    const res = await t.submitApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'store_forbidden');
    assert.ok(!res.text.includes(ASC_SECRET));
    assert.equal(await t.submitClaim(app), undefined);
    assert.ok(await t.pushRecord(app));
    const failedAudit = await t.audit('listing.submit_failed');
    const failed = failedAudit[failedAudit.length - 1];
    assert.deepEqual([failed?.detail.code, failed?.detail.outcome], ['store_forbidden', 'failed']);

    const q = (await t.submitPreview(droid)).body.preview;
    t.submitStores.android.behavior = {
      kind: 'refuse',
      error: new StoreError(
        'googleplay',
        'changes_in_review',
        'Changes are already in review.',
        400,
      ),
    };
    const inReview = await t.submitApply(droid, {
      confirmHash: q.confirmHash,
      confirmation: q.confirmation.phrase,
    });
    assert.equal(inReview.status, 409);
    assert.equal(inReview.body.error, 'changes_in_review');
    assert.ok(await t.pushRecord(droid));
    assert.equal((await t.audit('listing.submitted')).length, 0);
  },
);

dbTest('credential problems stop before any store call and give the claim back', async (db) => {
  const t = await bootStaged(db);
  const app = await pushedIos(t);
  const p = (await t.submitPreview(app)).body.preview;
  const built = t.submitBuilt.length;
  await db.execute("UPDATE credentials SET kind = 'github_token' WHERE id = ?", [t.iosCredential]);
  const res = await t.submitApply(app, {
    confirmHash: p.confirmHash,
    confirmation: p.confirmation.phrase,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'credential_kind');
  assert.equal(t.submitBuilt.length, built, 'no connector was built');
  assert.equal(await t.submitClaim(app), undefined);
  assert.equal((await t.submitPreview(app)).status, 422);
});

// ----- what is kept ---------------------------------------------------------------------------------------------------

dbTest(
  'audit, events and answers never hold a credential or a text; deleting the app removes its claim and its record',
  async (db) => {
    const t = await bootStaged(db);
    const app = await pushedIos(t);
    const droid = await pushedAndroid(t);
    await t.previewAndSubmit(app);
    t.submitStores.android.behavior = {
      kind: 'refuse',
      error: new StoreError('googleplay', 'forbidden', `no ${PLAY_SECRET}`, 403),
    };
    await t.previewAndSubmit(droid);
    for (const table of [
      'audit_events',
      'events',
      'jobs',
      'store_draft_pushes',
      'store_submit_claims',
    ]) {
      const text = JSON.stringify(await db.query(`SELECT * FROM ${table}`).catch(() => []));
      assert.ok(!text.includes(ASC_SECRET), `${table} has a credential`);
      assert.ok(!text.includes(PLAY_SECRET), `${table} has a credential`);
      assert.ok(!text.includes(TEXT), `${table} holds a staged text`);
    }
    for (const text of t.texts) {
      assert.ok(!text.includes(ASC_SECRET), text.slice(0, 200));
      assert.ok(!text.includes(PLAY_SECRET), text.slice(0, 200));
    }
    await db.execute(
      "INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'submit', 'unknown', 'u', 1)",
      [app, t.workspaceId],
    );
    assert.ok(await t.pushRecord(droid));
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${app}`)).status, 204);
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${droid}`)).status, 204);
    assert.equal(await t.submitClaim(app), undefined);
    assert.equal(await t.pushRecord(droid), undefined);
  },
);

// ----- the registry ---------------------------------------------------------------------------------------------------

dbTest(
  'the API description lists the submit routes with their action and risk; the submit is destructive; the event type is known',
  async (db) => {
    const t = await bootStaged(db);
    const res = await t.app.request('/api/openapi.json', { headers: { cookie: t.owner } });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const at = (path: string, method: string) =>
      doc.paths[`/api/workspaces/{workspaceId}${path}`]?.[method];
    assert.equal(at('/store-submit/config', 'get')?.['x-mrm-action'], 'apps.read');
    for (const [path, method, action, risk] of [
      ['/apps/{id}/store-submit', 'get', 'store.submit', 'read'],
      ['/apps/{id}/store-submit/preview', 'post', 'store.submit', 'read'],
      ['/apps/{id}/store-submit', 'post', 'store.submit', 'destructive'],
    ] as const) {
      assert.equal(at(path, method)?.['x-mrm-action'], action, `${method} ${path}`);
      assert.equal(at(path, method)?.['x-mrm-risk'], risk, `${method} ${path}`);
    }
    const app = await pushedIos(t);
    await t.previewAndSubmit(app);
    const listed = await t.call(t.owner, 'GET', '/events?since=0&limit=50&type=listing.submitted');
    assert.equal(listed.status, 200, 'the event type can be filtered on');
    assert.equal(listed.body.events.length, 1);
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.call(viewer, 'GET', '/events?since=0&limit=50&type=listing.submitted')).body.events
        .length,
      1,
      'whoever can read listings sees it',
    );
  },
);
