import assert from 'node:assert/strict';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * Releasing an approved App Store version or starting a Google Play draft release (docs/api/releases-write.md,
 * docs/adr/0014-release-management.md). Everything runs against fakes: no store and no GitHub is contacted.
 */

const HASH = 'a'.repeat(64);
const codes = (items: { code: string }[]) => items.map((i) => i.code);
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), 'the condition was not met in time');
};
const noReleaseIo = (t: StagedBoot) => {
  for (const store of [t.releaseStores.ios, t.releaseStores.android, t.releaseStores.macos])
    assert.equal(store.reads + store.releaseCalls, 0);
  assert.equal(t.releaseBuilt.length, 0, 'no release connector was built');
};
const PLAY = { track: 'production', userFraction: 0.1 };

// ----- the kill switch -----------------------------------------------------------------------------------

dbTest(
  'kill switch: with it off preview and release answer 409 store_release_disabled, no store is reached; the state still shows',
  async (db) => {
    const t = await bootStaged(db, { release: { enabled: false } });
    const app = await t.addApp('ios');
    const config = await t.call(t.owner, 'GET', '/store-release/config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [
        config.body.enabled,
        config.body.envName,
        config.body.action,
        config.body.minimumRole,
        config.body.irreversible,
      ],
      [false, 'KILN_STORE_RELEASE_ENABLED', 'store.release', 'admin', true],
    );
    for (const res of [
      await t.releasePreview(app),
      await t.releaseApply(app, { confirmHash: HASH, confirmation: 'release com.acme.app 2.1' }),
    ]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'store_release_disabled');
      assert.match(res.body.message, /KILN_STORE_RELEASE_ENABLED=true/);
    }
    noReleaseIo(t);
    const state = await t.releaseState(app);
    assert.equal(state.status, 200);
    assert.equal(state.body.release.enabled, false);
    assert.equal(await t.releaseClaim(app), undefined);
    assert.equal((await t.audit('store.release%')).length, 0);
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.releaseApply(app, { confirmHash: HASH, confirmation: 'x' }, viewer)).status,
      403,
      'the rights check comes first',
    );
  },
);

dbTest(
  'kill switch: an app created without the option is off (the default); drafts and submit being on do not turn it on',
  async (db) => {
    const t = await bootRepoApp(db);
    assert.equal((await t.call(t.owner, 'GET', '/store-release/config')).body.enabled, false);
    assert.equal((await t.call(t.owner, 'POST', '/apps/x/store-release/preview', {})).status, 409);
    assert.equal(
      (
        await t.call(t.owner, 'POST', '/apps/x/store-release', {
          confirmHash: HASH,
          confirmation: 'x',
        })
      ).status,
      409,
    );
  },
);

dbTest('kill switch: drafts and submit being on do not turn releasing on', async (db) => {
  const on = await bootStaged(db, {
    draft: { enabled: true },
    submit: { enabled: true },
    release: { enabled: false },
  });
  assert.equal((await on.call(on.owner, 'GET', '/store-draft/config')).body.enabled, true);
  assert.equal((await on.call(on.owner, 'GET', '/store-release/config')).body.enabled, false);
});

// ----- rights ---------------------------------------------------------------------------------------------

dbTest(
  'rights: only owners and admins see the state, preview or release; non-members get 404',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    for (const cookie of [viewer, member]) {
      assert.equal((await t.releaseState(app, cookie)).status, 403);
      assert.equal((await t.releasePreview(app, {}, cookie)).status, 403);
      assert.equal(
        (await t.releaseApply(app, { confirmHash: HASH, confirmation: 'x' }, cookie)).status,
        403,
      );
      assert.equal((await t.call(cookie, 'GET', '/store-release/config')).status, 200);
    }
    noReleaseIo(t);
    assert.equal((await t.previewAndRelease(app, {}, admin)).release.status, 200, 'an admin may');
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    for (const [method, path, body] of [
      ['GET', '/store-release/config'],
      ['GET', t.rel(app)],
      ['POST', t.rel(app, '/preview'), {}],
      ['POST', t.rel(app), { confirmHash: HASH, confirmation: 'x' }],
    ] as const) {
      assert.equal((await t.call(outsider, method, path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal((await t.releasePreview('no-such-app')).status, 404);
    assert.equal(t.releaseStores.ios.releaseCalls, 1, 'only the admin’s release reached the store');
  },
);

dbTest(
  'tokens: the action must be named (no list never counts, a submit or push right is not a release right), the ceiling and the app scope apply',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
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
      (await bearer(everything, 'POST', t.rel(app, '/preview'), {})).status,
      403,
      'no list: never',
    );
    const other403 = await mint({ actions: ['apps.read', 'store.push_draft', 'store.submit'] });
    assert.equal(
      (await bearer(other403, 'POST', t.rel(app), { confirmHash: HASH, confirmation: 'x' })).status,
      403,
    );
    const tooLow = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'member',
      actions: ['store.release'],
    });
    assert.equal(tooLow.status, 400);
    assert.equal(tooLow.body.error, 'action_above_role');
    noReleaseIo(t);
    const scoped = await mint({ actions: ['store.release', 'apps.read'], appIds: [app] });
    assert.equal(
      (await bearer(scoped, 'POST', t.rel(other, '/preview'), {})).status,
      404,
      'another app',
    );
    const fresh = await bearer(scoped, 'POST', t.rel(app, '/preview'), {});
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body).slice(0, 300));
    const done = await bearer(scoped, 'POST', t.rel(app), {
      confirmHash: fresh.body.preview.confirmHash,
      confirmation: fresh.body.preview.confirmation.phrase,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
    assert.equal(
      (await t.audit('store.released'))[0]?.actorType,
      'token',
      'a release by a token is attributed to the token',
    );
  },
);

// ----- the App Store -------------------------------------------------------------------------------------

dbTest(
  'App Store: preview shows what is released and cannot be undone; apply releases once, audited and emitted with ids only',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    t.releaseStores.ios.phased = { id: 'ph-1', state: 'INACTIVE' };
    const p = await t.releasePreview(app);
    assert.equal(p.status, 200, p.text.slice(0, 300));
    const pre = p.body.preview;
    assert.equal(pre.releases, true);
    assert.deepEqual(pre.version, {
      id: 'v-next',
      versionString: '2.1',
      state: 'PENDING_DEVELOPER_RELEASE',
      releaseType: 'MANUAL',
    });
    assert.equal(pre.build.buildNumber, '57');
    assert.equal(pre.audience.kind, 'phased');
    assert.equal(pre.checks.canRelease, true);
    assert.equal(pre.confirmation.phrase, 'release com.acme.app 2.1');
    assert.ok(pre.irreversible.length >= 2);
    assert.equal(t.releaseStores.ios.releaseCalls, 0, 'a preview releases nothing');
    assert.equal((await t.releaseState(app)).body.release.inFlight.release, false);

    const done = await t.releaseApply(app, {
      confirmHash: pre.confirmHash,
      confirmation: pre.confirmation.phrase,
    });
    assert.equal(done.status, 200, done.text.slice(0, 300));
    const r = done.body.result;
    assert.deepEqual(
      [r.released, r.via, r.confirmedByReread, r.version.versionString, r.audience.kind],
      [true, 'release_request', false, '2.1', 'phased'],
    );
    assert.ok(r.releaseRequestId);
    assert.deepEqual(t.releaseStores.ios.released, ['v-next']);
    assert.equal(t.releaseStores.ios.releaseCalls, 1);
    assert.equal(await t.releaseClaim(app), undefined, 'the claim is released');
    const audit = (await t.audit('store.released'))[0];
    assert.equal(audit?.actorType, 'user');
    assert.deepEqual(
      [audit?.detail.versionId, audit?.detail.via, audit?.detail.hash],
      ['v-next', 'release_request', pre.confirmHash],
    );
    const event = (await t.events('release.started'))[0];
    assert.equal(event?.payload.versionString, '2.1');
    assert.equal(event?.payload.confirmedByReread, false);
    for (const text of [JSON.stringify(audit), JSON.stringify(event)])
      assert.doesNotMatch(text, /secret|PRIVATE KEY|password/i);
    // Released: nothing waits any more, so a second preview refuses and no second request is made.
    const again = await t.releasePreview(app);
    assert.equal(again.body.preview.checks.canRelease, false);
    assert.deepEqual(codes(again.body.preview.checks.blocking), ['not_releasable']);
    assert.equal(again.body.preview.confirmHash, null);
    assert.equal(again.body.preview.confirmation, null);
    assert.equal(t.releaseStores.ios.releaseCalls, 1);
  },
);

dbTest(
  'App Store: nothing waiting for release, or more than one waiting, is refused with a reason and nothing is written',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const store = t.releaseStores.ios;
    store.versions = [
      {
        id: 'v-next',
        versionString: '2.1',
        state: 'PREPARE_FOR_SUBMISSION',
        releaseType: 'MANUAL',
      },
    ];
    let p = await t.releasePreview(app);
    assert.deepEqual(codes(p.body.preview.checks.blocking), ['not_releasable']);
    assert.match(p.body.preview.checks.blocking[0].message, /2\.1 \(PREPARE_FOR_SUBMISSION\)/);
    assert.equal(p.body.preview.confirmHash, null);
    let res = await t.releaseApply(app, {
      confirmHash: HASH,
      confirmation: 'release com.acme.app 2.1',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'blocked');
    assert.equal(store.releaseCalls, 0);

    store.versions = [
      {
        id: 'v-a',
        versionString: '2.1',
        state: 'PENDING_DEVELOPER_RELEASE',
        releaseType: 'MANUAL',
      },
      {
        id: 'v-b',
        versionString: '2.2',
        state: 'PENDING_DEVELOPER_RELEASE',
        releaseType: 'MANUAL',
      },
    ];
    p = await t.releasePreview(app);
    assert.deepEqual(codes(p.body.preview.checks.blocking), ['ambiguous_version']);
    const named = await t.previewAndRelease(app, { version: '2.2' });
    assert.equal(named.release.status, 200, named.release.text.slice(0, 300));
    assert.deepEqual(store.released, ['v-b']);
    assert.equal(
      (await t.audit('store.release_failed')).filter((a) => a.detail.code === 'blocked').length,
      1,
    );
    assert.equal(await t.releaseClaim(app), undefined);
    res = await t.releasePreview(app, { version: '9.9' });
    assert.deepEqual(codes(res.body.preview.checks.blocking), ['not_releasable']);
  },
);

dbTest(
  'App Store: the typed phrase and the hash are both needed; a store that changed since the preview writes nothing',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const store = t.releaseStores.ios;
    const p = (await t.releasePreview(app)).body.preview;
    const wrong = await t.releaseApply(app, {
      confirmHash: p.confirmHash,
      confirmation: 'release com.acme.app 2.0',
    });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error, 'confirmation_mismatch');
    assert.equal(wrong.body.phrase, 'release com.acme.app 2.1');
    // An empty confirmation is a wrong one (it may be left out when the person's own confirmation stands in for it).
    assert.equal(
      (await t.releaseApply(app, { confirmHash: p.confirmHash, confirmation: '' })).status,
      422,
    );
    const badHash = await t.releaseApply(app, {
      confirmHash: HASH,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(badHash.status, 409);
    assert.equal(badHash.body.error, 'state_changed');
    assert.ok(badHash.body.preview.confirmHash, 'the new preview can be confirmed');
    assert.equal(
      (await t.releaseApply(app, { confirmHash: p.confirmHash, confirmation: 'x', extra: 1 }))
        .status,
      400,
    );
    store.phased = { id: 'ph-9', state: 'INACTIVE' };
    const drift = await t.releaseApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(drift.status, 409);
    assert.equal(drift.body.error, 'state_changed');
    assert.equal(drift.body.preview.audience.kind, 'phased');
    assert.equal(store.releaseCalls, 0, 'nothing was written');
    assert.equal(await t.releaseClaim(app), undefined);
    assert.equal(
      (await t.audit('store.release_failed')).filter((a) => a.detail.outcome === 'refused').length,
      4, // the wrong phrase, the empty one, the wrong hash, the drift
    );
    const ok = await t.releaseApply(app, {
      confirmHash: drift.body.preview.confirmHash,
      confirmation: drift.body.preview.confirmation.phrase,
    });
    assert.equal(ok.status, 200);
  },
);

dbTest(
  'App Store: track, versionCodes and userFraction are for Google Play; a macOS app releases the macOS version',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    for (const extra of [
      { track: 'production' },
      { versionCodes: ['241'] },
      { userFraction: 0.5 },
    ]) {
      const res = await t.releasePreview(app, extra);
      assert.equal(res.status, 422, res.text.slice(0, 200));
      assert.equal(res.body.error, 'not_applicable');
    }
    assert.equal((await t.releasePreview(app, { userFraction: 5 })).status, 400);
    noReleaseIo(t);

    const mac = await t.addApp('macos', 'Mac', { credentialId: t.iosCredential });
    await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', mac]);
    const done = await t.previewAndRelease(mac);
    assert.equal(done.release.status, 200, done.release.text.slice(0, 300));
    assert.equal(t.releaseStores.macos.releaseCalls, 1);
    assert.equal(t.releaseStores.ios.releaseCalls, 0);
    assert.equal(t.releaseBuilt[0]?.platform, 'macos');
  },
);

// ----- Google Play ---------------------------------------------------------------------------------------

dbTest(
  'Google Play: the track and the share are required and explicit; the share is part of the confirmation',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    const refused = async (body: Record<string, unknown>, error: string, status = 422) => {
      const res = await t.releasePreview(app, body);
      assert.equal(res.status, status, res.text.slice(0, 200));
      assert.equal(res.body.error, error);
    };
    await refused({}, 'track_required');
    await refused({ track: 'production' }, 'user_fraction_required');
    await refused({ track: 'production', userFraction: 0 }, 'invalid_request', 400);
    await refused({ track: 'production', userFraction: 1.2 }, 'invalid_request', 400);
    await refused({ track: 'production', userFraction: 0.12345 }, 'invalid_user_fraction');
    await refused({ version: '2.1', ...PLAY }, 'not_applicable');
    noReleaseIo(t);

    const p = (await t.releasePreview(app, PLAY)).body.preview;
    assert.equal(p.confirmation.phrase, 'release com.acme.app production 10%');
    assert.equal(p.audience.kind, 'percent');
    assert.equal(p.audience.userFraction, 0.1);
    assert.deepEqual(
      [p.track, p.release.status, p.release.versionCodes],
      ['production', 'draft', ['241']],
    );
    assert.equal(p.others.length, 1);
    assert.equal(p.checks.canRelease, true);
    assert.ok(codes(p.checks.warnings).includes('play_review_state_unknown'));
    // The same hash does not confirm another share.
    const other = await t.releaseApply(app, {
      track: 'production',
      userFraction: 0.5,
      confirmHash: p.confirmHash,
      confirmation: 'release com.acme.app production 50%',
    });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'state_changed');
    assert.equal(t.releaseStores.android.releaseCalls, 0);
    // A typed phrase for another share is refused before the store is read.
    const readsBefore = t.releaseStores.android.reads;
    const wrong = await t.releaseApply(app, {
      ...PLAY,
      confirmHash: p.confirmHash,
      confirmation: 'release com.acme.app production 100%',
    });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error, 'confirmation_mismatch');
    assert.equal(t.releaseStores.android.reads, readsBefore, 'no store was read');
    const ok = await t.releaseApply(app, {
      ...PLAY,
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    assert.deepEqual(
      [
        ok.body.result.via,
        ok.body.result.track,
        ok.body.result.request.userFraction,
        ok.body.result.releaseRequestId,
      ],
      ['edit_commit', 'production', 0.1, null],
    );
    const started = t.releaseStores.android.releases.find((r) => r.name === '2.1');
    assert.deepEqual([started?.status, started?.userFraction], ['inProgress', 0.1]);
    assert.deepEqual(t.releaseStores.android.released, ['production:241:0.1']);
    const audit = (await t.audit('store.released'))[0];
    assert.deepEqual(
      [audit?.detail.track, audit?.detail.userFraction, audit?.detail.versionCodes],
      ['production', 0.1, ['241']],
    );
    assert.equal((await t.events('release.started'))[0]?.payload.userFraction, 0.1);
  },
);

dbTest('Google Play: a share of 1 completes the release and warns', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  const p = (await t.releasePreview(app, { track: 'production', userFraction: 1 })).body.preview;
  assert.ok(codes(p.checks.warnings).includes('full_rollout'));
  assert.equal(p.audience.kind, 'all');
  assert.equal(p.confirmation.phrase, 'release com.acme.app production 100%');
  const ok = await t.previewAndRelease(app, { track: 'production', userFraction: 1 });
  assert.equal(ok.release.status, 200);
  assert.equal(t.releaseStores.android.releases.find((r) => r.name === '2.1')?.status, 'completed');
});

dbTest(
  'Google Play: nothing to start, codes not uploaded, a rollout already running and an ambiguous track are blocked with reasons',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    const store = t.releaseStores.android;
    const blockers = async (body: Record<string, unknown> = PLAY) =>
      codes((await t.releasePreview(app, body)).body.preview.checks.blocking);

    store.uploaded.delete('241');
    assert.deepEqual(await blockers(), ['version_codes_not_uploaded']);
    store.uploaded.add('241');

    store.releases.push({
      name: '2.0.1',
      status: 'inProgress',
      userFraction: 0.5,
      versionCodes: ['200'],
      notes: 0,
    });
    assert.deepEqual(await blockers(), ['rollout_in_progress']);
    store.releases.pop();

    store.releases.push({
      name: '2.2',
      status: 'draft',
      userFraction: null,
      versionCodes: ['242'],
      notes: 0,
    });
    assert.deepEqual(await blockers(), ['ambiguous_release']);
    const named = await blockers({ ...PLAY, versionCodes: ['241'] });
    assert.deepEqual(named, []);
    assert.deepEqual(await blockers({ ...PLAY, versionCodes: ['999'] }), ['no_draft_release']);
    store.releases = store.releases.filter((r) => r.status !== 'draft');
    assert.deepEqual(await blockers(), ['no_draft_release']);

    const res = await t.releaseApply(app, {
      ...PLAY,
      confirmHash: HASH,
      confirmation: 'release com.acme.app production 10%',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'blocked');
    assert.deepEqual(codes(res.body.checks.blocking), ['no_draft_release']);
    assert.equal(store.releaseCalls, 0);
    assert.equal(await t.releaseClaim(app), undefined);
  },
);

dbTest(
  'Google Play: staged release fields that were not pushed, and a different staged share, are warnings',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    await t.stageField(app, { field: 'track', value: 'production' });
    await t.stageField(app, { field: 'release_name', value: 'Spring' });
    await t.stageField(app, { field: 'user_fraction', value: 0.25 });
    const p = (await t.releasePreview(app, PLAY)).body.preview;
    const warnings = codes(p.checks.warnings);
    assert.ok(warnings.includes('unpushed_release_fields'));
    assert.ok(warnings.includes('fraction_differs_from_staged'));
    assert.match(
      p.checks.warnings.find((w: { code: string }) => w.code === 'unpushed_release_fields').message,
      /2 staged release fields are not written/,
    );
    assert.equal(p.checks.canRelease, true, 'warnings never stop a release');
    assert.equal(
      p.request.userFraction,
      0.1,
      'the share asked here is the one used, never the staged one',
    );
  },
);

// ----- in flight, and what blocks ------------------------------------------------------------------------

dbTest(
  'one release at a time per app and platform; a push or a submit in flight blocks it',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const other = await t.addApp('ios');
    let open!: () => void;
    t.releaseStores.ios.gate = new Promise<void>((resolve) => (open = resolve));
    const p = (await t.releasePreview(app)).body.preview;
    const first = t.releaseApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    await until(() => t.releaseStores.ios.releaseCalls === 1);
    assert.equal((await t.releaseState(app)).body.release.inFlight.release, true);
    const second = await t.releaseApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'write_in_progress');
    assert.equal(t.releaseStores.ios.releaseCalls, 1);
    open();
    assert.equal((await first).status, 200);
    assert.equal(await t.releaseClaim(app), undefined);

    // Another app is not held up, and a push or a submit in flight blocks a release of its own app.
    const now = Date.now();
    t.releaseStores.ios.versions[1]!.state = 'PENDING_DEVELOPER_RELEASE';
    await db.execute(
      "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', 'writing', 'u', ?)",
      [other, t.workspaceId, now],
    );
    const blocked = await t.releasePreview(other);
    assert.deepEqual(codes(blocked.body.preview.checks.blocking), ['push_in_progress']);
    assert.equal(
      (
        await t.releaseApply(other, {
          confirmHash: HASH,
          confirmation: 'release com.acme.app2 2.1',
        })
      ).status,
      409,
    );
    await db.execute('DELETE FROM store_draft_claims WHERE app_id = ?', [other]);
    await db.execute(
      "INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'submit', 'unknown', 'u', 1)",
      [other, t.workspaceId],
    );
    assert.deepEqual(codes((await t.releasePreview(other)).body.preview.checks.blocking), [
      'submit_outcome_unknown',
    ]);
    const unknown = await t.releaseApply(other, {
      confirmHash: HASH,
      confirmation: 'release com.acme.app2 2.1',
    });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error, 'submit_outcome_unknown');
  },
);

dbTest('a release claim that is old is not trusted as in flight; the store decides', async (db) => {
  const t = await bootStaged(db, { release: { claimTtlMs: 1000 } });
  const app = await t.addApp('ios');
  await db.execute(
    "INSERT INTO store_release_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'release', 'writing', 'u', 1)",
    [app, t.workspaceId],
  );
  const done = await t.previewAndRelease(app);
  assert.equal(done.release.status, 200, done.release.text.slice(0, 300));
  assert.equal(await t.releaseClaim(app), undefined);
  const fresh = await t.addApp('ios');
  t.releaseStores.ios.versions[1]!.state = 'PENDING_DEVELOPER_RELEASE';
  await db.execute(
    "INSERT INTO store_release_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'release', 'writing', 'u', ?)",
    [fresh, t.workspaceId, Date.now()],
  );
  const p = (await t.releasePreview(fresh)).body.preview;
  const res = await t.releaseApply(fresh, {
    confirmHash: p.confirmHash,
    confirmation: p.confirmation.phrase,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'write_in_progress');
});

// ----- failures and unknown outcomes ----------------------------------------------------------------------

dbTest(
  'a store refusal is an answer, audited without a secret; the claim is released and nothing is retried',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const store = t.releaseStores.ios;
    store.behavior = {
      kind: 'refuse',
      error: new StoreError('appstoreconnect', 'forbidden', 'Apple refused to release (403).', 403),
    };
    const res = (await t.previewAndRelease(app)).release;
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'store_forbidden');
    assert.equal(store.releaseCalls, 1);
    assert.equal(await t.releaseClaim(app), undefined);
    const failed = (await t.audit('store.release_failed'))[0];
    assert.deepEqual([failed?.detail.code, failed?.detail.outcome], ['store_forbidden', 'failed']);
    assert.equal((await t.audit('store.released')).length, 0);
    assert.equal((await t.events('release.started')).length, 0);
    store.behavior = { kind: 'ok' };
    assert.equal((await t.previewAndRelease(app)).release.status, 200, 'a refusal blocks nothing');
  },
);

dbTest(
  'a store that cannot be reached is reported; a preview of a store that does not answer changes nothing',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    t.releaseStores.ios.readError = new StoreError(
      'appstoreconnect',
      'server',
      'Apple answered HTTP 503',
      503,
    );
    const res = await t.releasePreview(app);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'store_unavailable');
    assert.equal(await t.releaseClaim(app), undefined);
  },
);

dbTest(
  'App Store: a lost answer is read back: released is confirmedByReread, still waiting is a 502, an unreadable store is unknown',
  async (db) => {
    const t = await bootStaged(db);
    const store = t.releaseStores.ios;

    const a = await t.addApp('ios');
    store.behavior = { kind: 'unknown', applied: true };
    const ok = await t.previewAndRelease(a);
    assert.equal(ok.release.status, 200, ok.release.text.slice(0, 300));
    assert.equal(ok.release.body.result.confirmedByReread, true);
    assert.equal(store.releaseCalls, 1, 'never sent again');
    assert.equal((await t.audit('store.released'))[0]?.detail.confirmedByReread, true);
    assert.equal(await t.releaseClaim(a), undefined);

    const b = await t.addApp('ios');
    store.versions[1]!.state = 'PENDING_DEVELOPER_RELEASE';
    store.behavior = { kind: 'unknown', applied: false };
    const lost = await t.previewAndRelease(b);
    assert.equal(lost.release.status, 502);
    assert.equal(lost.release.body.error, 'write_failed');
    assert.equal(lost.release.body.outcome, 'not_applied');
    assert.equal(await t.releaseClaim(b), undefined);
    assert.equal(store.releaseCalls, 2);

    const c = await t.addApp('ios');
    store.readFailsAfterWrite = true;
    const dark = await t.previewAndRelease(c);
    assert.equal(dark.release.status, 409);
    assert.equal(dark.release.body.error, 'outcome_unknown');
    assert.equal(String((await t.releaseClaim(c))?.status), 'unknown');
    assert.equal((await t.releaseState(c)).body.release.unknownOutcome.release, true);
    // Blocked until a successful read: a preview settles it.
    store.readError = undefined;
    store.behavior = { kind: 'ok' };
    const blocked = await t.releaseApply(c, {
      confirmHash: HASH,
      confirmation: 'release com.acme.app3 2.1',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(store.releaseCalls, 3);
    await t.releasePreview(c);
    assert.equal(
      await t.releaseClaim(c),
      undefined,
      'a successful read settles the unknown outcome',
    );
  },
);

dbTest(
  'Google Play: a lost answer shows the release when the track does, and stays unknown when it does not',
  async (db) => {
    const t = await bootStaged(db);
    const store = t.releaseStores.android;

    const a = await t.addApp('android');
    store.behavior = { kind: 'unknown', applied: true };
    const ok = await t.previewAndRelease(a, PLAY);
    assert.equal(ok.release.status, 200, ok.release.text.slice(0, 300));
    assert.equal(ok.release.body.result.confirmedByReread, true);
    assert.equal(store.releaseCalls, 1);
    assert.equal(store.releases.find((r) => r.name === '2.1')?.status, 'inProgress');

    const b = await t.addApp('android');
    store.releases = [
      { name: '2.2', status: 'draft', userFraction: null, versionCodes: ['241'], notes: 1 },
    ];
    store.behavior = { kind: 'unknown', applied: false };
    const lost = await t.previewAndRelease(b, PLAY);
    assert.equal(
      lost.release.status,
      409,
      'a commit can be slow to show: the old draft is not proof',
    );
    assert.equal(lost.release.body.error, 'outcome_unknown');
    assert.equal(String((await t.releaseClaim(b))?.status), 'unknown');
    assert.equal(store.releaseCalls, 2);
    const stuck = await t.releaseApply(b, {
      ...PLAY,
      confirmHash: HASH,
      confirmation: 'release com.acme.app2 production 10%',
    });
    assert.equal(stuck.status, 409);
    assert.equal(stuck.body.error, 'outcome_unknown');
    assert.equal(store.releaseCalls, 2, 'never sent again');
    assert.equal(
      (await t.audit('store.release_failed')).filter((x) => x.detail.outcome === 'unknown').length,
      1,
    );
  },
);

dbTest(
  'a release that takes longer than the timeout is an unknown outcome that is read back',
  async (db) => {
    const t = await bootStaged(db, { release: { timeoutMs: 50 } });
    const app = await t.addApp('ios');
    const p = (await t.releasePreview(app)).body.preview;
    t.releaseStores.ios.gate = new Promise<void>(() => undefined);
    const res = await t.releaseApply(app, {
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(res.status, 502, res.text.slice(0, 300));
    assert.equal(res.body.error, 'write_failed', 'the store shows the version still waiting');
    assert.equal(await t.releaseClaim(app), undefined);
  },
);

dbTest('deleting an app removes its release claim', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  await db.execute(
    "INSERT INTO store_release_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'release', 'unknown', 'u', 1)",
    [app, t.workspaceId],
  );
  const res = await t.call(t.owner, 'DELETE', `/apps/${app}`);
  assert.ok(res.status === 200 || res.status === 204, res.text);
  assert.equal(await t.releaseClaim(app), undefined);
});

// ----- Google Play: the direct release (docs/adr/0029-direct-play-release.md) -------------------------------

const stageDirect = async (t: StagedBoot, app: string) => {
  for (const body of [
    { field: 'track', value: 'production' },
    { field: 'version_codes', value: '241' },
    { field: 'release_name', value: '2.1 (241)' },
    { field: 'release_notes', locale: 'en-US', value: 'Secret notes about the new release' },
    { field: 'release_notes', locale: 'de-DE', value: 'Geheime Notizen' },
  ])
    assert.equal((await t.stageField(app, body)).status, 200);
};
const DIRECT = { direct: true, userFraction: 0.1 };

dbTest(
  'direct: with no draft in the track the release is made from the staged fields; the preview says it in words, shows no note, binds the notes and the phrase is the release phrase',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    const store = t.releaseStores.android;
    store.releases = store.releases.filter((r) => r.status !== 'draft');
    await stageDirect(t, app);

    const p = (await t.releasePreview(app, DIRECT)).body.preview;
    assert.equal(p.checks.canRelease, true, JSON.stringify(p.checks));
    assert.equal(p.request.track, 'production', 'the staged track is used when none is named');
    assert.deepEqual(p.request.versionCodes, ['241']);
    assert.equal(p.request.build, undefined, 'the notes are not repeated in the answer');
    assert.equal(
      p.request.direct,
      true,
      'so that the request of the preview can be sent back as it is',
    );
    assert.deepEqual(
      [p.direct.creates, p.direct.versionCodes, p.direct.name, p.direct.notesLanguages],
      [true, ['241'], '2.1 (241)', ['de-DE', 'en-US']],
    );
    assert.match(
      p.direct.summary,
      /version code 241 to the production track for 10% of users, with release notes in de-DE, en-US\. Google reviews this release before users get it; it cannot be undone from here\./,
    );
    assert.doesNotMatch(JSON.stringify(p), /Secret notes|Geheime/);
    assert.ok(codes(p.checks.warnings).includes('direct_release'));
    assert.ok(
      !codes(p.checks.warnings).includes('unpushed_release_fields'),
      'a direct release uses the staged fields itself',
    );
    assert.equal(p.confirmation.phrase, 'release com.acme.app production 10%');
    assert.ok(p.irreversible.some((l: string) => /Google reviews it before users get it/.test(l)));

    // The notes are bound by the hash: a changed note needs a new preview.
    assert.equal(
      (await t.stageField(app, { field: 'release_notes', locale: 'en-US', value: 'Other notes' }))
        .status,
      200,
    );
    const stale = await t.releaseApply(app, {
      ...DIRECT,
      confirmHash: p.confirmHash,
      confirmation: p.confirmation.phrase,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'state_changed');
    assert.equal(store.releaseCalls, 0);

    const again = (await t.releasePreview(app, DIRECT)).body.preview;
    const wrong = await t.releaseApply(app, {
      ...DIRECT,
      confirmHash: again.confirmHash,
      confirmation: 'release com.acme.app production 100%',
    });
    assert.equal(wrong.status, 422);
    const ok = await t.releaseApply(app, {
      ...DIRECT,
      confirmHash: again.confirmHash,
      confirmation: again.confirmation.phrase,
    });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    assert.doesNotMatch(JSON.stringify(ok.body), /Other notes|Geheime/);
    assert.deepEqual(store.released, ['production:241:0.1']);
    assert.deepEqual(store.builds, [
      {
        name: '2.1 (241)',
        notes: [
          { locale: 'de-DE', text: 'Geheime Notizen' },
          { locale: 'en-US', text: 'Other notes' },
        ],
      },
    ]);
    const made = store.releases.find((r) => r.name === '2.1 (241)');
    assert.deepEqual([made?.status, made?.userFraction, made?.notes], ['inProgress', 0.1, 2]);
    const audit = (await t.audit('store.released'))[0];
    assert.deepEqual(
      [audit?.detail.direct, audit?.detail.created, audit?.detail.userFraction],
      [true, true, 0.1],
    );
    assert.doesNotMatch(JSON.stringify(audit), /Other notes|Geheime/, 'ids and counts only');
    // The staged release fields were used by this release: nothing of them waits any more.
    const waiting = await db.query(
      "SELECT target FROM staged_changes WHERE app_id = ? AND kind = 'release_field' AND (pushed_hash IS NULL OR pushed_hash <> value_hash)",
      [app],
    );
    assert.deepEqual(waiting, [], 'no staged release field is left unpushed');
    // The release list says this server sent it to Google (Google Play does not report the review).
    const { listAppReleases } = await import('../../services/apps.ts');
    const row = (version: string, codes: string[]) =>
      db.execute(
        `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json, store_updated_at, synced_at, status_since)
         VALUES (?, ?, ?, 'android', ?, 'production', NULL, 'live', 'completed', ?, NULL, 1, 1)`,
        [`rel-${version}`, app, t.workspaceId, version, JSON.stringify({ versionCodes: codes })],
      );
    await row('2.1', ['241']);
    await row('2.0', ['200']);
    const list = await listAppReleases(db, t.workspaceId, app);
    assert.equal(
      typeof list.find((r) => r.version === '2.1')?.sentForReviewAt,
      'number',
      'the release sent from here says so',
    );
    assert.equal(
      list.find((r) => r.version === '2.0')?.sentForReviewAt,
      undefined,
      'an older release does not',
    );
    assert.equal(
      list.find((r) => r.version === '2.1')?.status,
      'in_review',
      'Google calls it live; here it reads in review',
    );
    assert.equal(
      list.find((r) => r.version === '2.0')?.status,
      'live',
      'an older release stays as Google says',
    );
    // The same on the release pipeline the screens draw (the Next step card), but never for the release watch.
    const { appPipeline, loadPipelineFacts } = await import('../planning/release-pipeline.ts');
    const screen = await appPipeline(db, {
      workspaceId: t.workspaceId,
      appId: app,
      now: Date.now(),
    });
    const seen = screen?.pipeline.latest.version;
    assert.equal(seen?.status, 'in_review', 'the Next step card sees the release as in review');
    const watch = await loadPipelineFacts(db, {
      workspaceId: t.workspaceId,
      appIds: [app],
      now: Date.now(),
    });
    assert.equal(
      watch.facts[0]?.versions.find((v) => v.version === '2.1')?.status,
      'live',
      'the release watch keeps Google’s state',
    );
  },
);

dbTest(
  'direct: a draft with the codes that exists is released as it is; 100% completes; staged codes are needed; the App Store has no direct release',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    const store = t.releaseStores.android;
    await stageDirect(t, app);
    const p = (await t.releasePreview(app, DIRECT)).body.preview;
    assert.equal(p.direct.creates, false);
    assert.ok(codes(p.checks.warnings).includes('draft_used_as_is'));
    const ok = await t.previewAndRelease(app, DIRECT);
    assert.equal(ok.release.status, 200, ok.release.text.slice(0, 300));
    assert.equal(store.builds.length, 0, 'nothing was made: the draft was started');
    assert.deepEqual(store.released, ['production:241:0.1']);

    const ios = await t.addApp('ios', 'Other');
    const refused = await t.releasePreview(ios, { direct: true });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'not_applicable');
  },
);

dbTest('direct: staged version codes are needed, and 100% completes the release', async (db) => {
  const t2 = await bootStaged(db);
  const app2 = await t2.addApp('android');
  t2.releaseStores.android.releases = [];
  await t2.stageField(app2, { field: 'track', value: 'production' });
  const none = await t2.releasePreview(app2, DIRECT);
  assert.equal(none.status, 422);
  assert.equal(none.body.error, 'version_codes_required');
  await stageDirect(t2, app2);
  const full = await t2.previewAndRelease(app2, { direct: true, userFraction: 1 });
  assert.equal(full.release.status, 200, full.release.text.slice(0, 300));
  assert.equal(
    t2.releaseStores.android.releases.find((r) => r.name === '2.1 (241)')?.status,
    'completed',
  );
});

dbTest(
  'direct: codes that a release of the track already holds, or Play does not list, block; with the switch off nothing is read',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    const store = t.releaseStores.android;
    store.releases = [
      { name: '2.1', status: 'completed', userFraction: null, versionCodes: ['241'], notes: 1 },
    ];
    await stageDirect(t, app);
    assert.deepEqual(codes((await t.releasePreview(app, DIRECT)).body.preview.checks.blocking), [
      'codes_already_in_track',
    ]);
    store.releases = [];
    store.uploaded.delete('241');
    assert.deepEqual(codes((await t.releasePreview(app, DIRECT)).body.preview.checks.blocking), [
      'version_codes_not_uploaded',
    ]);
    assert.equal(store.releaseCalls, 0);
  },
);

dbTest(
  'direct: with the release switch off nothing is read and no connector is built',
  async (db) => {
    const off = await bootStaged(db, { release: { enabled: false } });
    const offApp = await off.addApp('android');
    await stageDirect(off, offApp);
    const res = await off.releasePreview(offApp, DIRECT);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'store_release_disabled');
    noReleaseIo(off);
  },
);

// ----- per-app Google Play release settings (default share, staged rollout) ---------------------------------

dbTest(
  'release settings: defaults, a partial update with validation and an audit of old and new values, the right of an admin, Google Play only, removed with the app',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    const path = `/apps/${app}/release-settings`;
    const first = await t.call(t.owner, 'GET', path);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body.settings, { defaultSharePercent: null, stagedRollout: 'auto' });
    assert.equal(
      first.body.earlierProductionRelease,
      false,
      'a first release in production: no staged rollout in auto',
    );
    const row = (id: string, track: string, status: string) =>
      db.execute(
        "INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, details_json, status_since, synced_at) VALUES (?, ?, ?, 'android', ?, ?, ?, 'x', '{}', 5, 5)",
        [id, app, t.workspaceId, `v-${id}`, track, status],
      );
    await row('r-1', 'production', 'draft');
    await row('r-2', 'internal', 'live');
    assert.equal((await t.call(t.owner, 'GET', path)).body.earlierProductionRelease, false);
    await row('r-3', 'production', 'live');
    assert.equal((await t.call(t.owner, 'GET', path)).body.earlierProductionRelease, true);

    const set = await t.call(t.owner, 'PUT', path, {
      defaultSharePercent: 10,
      stagedRollout: 'never',
    });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body.settings, { defaultSharePercent: 10, stagedRollout: 'never' });
    assert.deepEqual(set.body.changed.sort(), ['defaultSharePercent', 'stagedRollout']);
    assert.deepEqual((await t.call(t.owner, 'GET', path)).body.settings, {
      defaultSharePercent: 10,
      stagedRollout: 'never',
    });
    const audit = (await t.audit('app.release_settings_update'))[0];
    assert.deepEqual(audit?.detail.changes, [
      { key: 'defaultSharePercent', from: null, to: 10 },
      { key: 'stagedRollout', from: 'auto', to: 'never' },
    ]);

    // Partial: only what is sent changes; null removes the default; nothing changed writes no audit.
    const part = await t.call(t.owner, 'PUT', path, { defaultSharePercent: null });
    assert.deepEqual(part.body.settings, { defaultSharePercent: null, stagedRollout: 'never' });
    const same = await t.call(t.owner, 'PUT', path, { defaultSharePercent: null });
    assert.deepEqual(same.body.changed, []);
    assert.equal((await t.audit('app.release_settings_update')).length, 2);

    for (const body of [
      { defaultSharePercent: 0 },
      { defaultSharePercent: 101 },
      { defaultSharePercent: 2.555 },
      { stagedRollout: 'sometimes' },
      { other: 1 },
    ]) {
      const bad = await t.call(t.owner, 'PUT', path, body);
      assert.ok([400, 422].includes(bad.status), `${JSON.stringify(body)} -> ${bad.status}`);
    }
    assert.deepEqual((await t.call(t.owner, 'GET', path)).body.settings, {
      defaultSharePercent: null,
      stagedRollout: 'never',
    });

    const member = await t.addMember('member');
    assert.equal((await t.call(member, 'GET', path)).status, 200);
    assert.equal((await t.call(member, 'PUT', path, { defaultSharePercent: 5 })).status, 403);

    const ios = await t.addApp('ios', 'Other');
    const refused = await t.call(t.owner, 'PUT', `/apps/${ios}/release-settings`, {
      defaultSharePercent: 5,
    });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'not_applicable');
    assert.equal((await t.call(t.owner, 'GET', '/apps/nope/release-settings')).status, 404);

    const del = await t.call(t.owner, 'DELETE', `/apps/${app}`);
    assert.ok(del.status === 200 || del.status === 204, del.text);
    const left = await db.query("SELECT key FROM workspace_settings WHERE key LIKE 'app.%'");
    assert.equal(left.length, 0);
  },
);
