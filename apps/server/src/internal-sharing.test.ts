import assert from 'node:assert/strict';
import {
  InternalSharingOutcomeUnknownError,
  StoreError,
  StoreRateLimitError,
} from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { zip } from '../../../packages/connectors/src/play-search-terms.fixtures.ts';
import { bootCi } from './ci-test-helpers.ts';
import {
  AAB,
  art,
  bootSharing as boot,
  DAY,
  LINK,
  type SharingBoot,
  sha256,
  streamOf,
} from './internal-sharing-test-helpers.ts';
import { LINK_RETENTION_MS } from './services/internal-sharing.ts';

// Google Play internal app sharing (docs/api/internal-sharing.md, docs/adr/0020-play-internal-sharing.md). Everything runs against a fake
// GitHub, a fake artifact storage and a fake Google: no network.

const trail = async (t: SharingBoot) => JSON.stringify(await t.audit()) + (await t.events());

// ----- the kill switch and rights ---------------------------------------------------------------------------

dbTest(
  'flag off (the default): the config says so, every sharing route answers 409 internal_sharing_disabled, nothing is read or built',
  async (db) => {
    const t = await boot(db, { internalSharingEnabled: false });
    t.serve('1');
    const config = await t.send(t.owner, 'GET', '/builds/internal-sharing/config');
    assert.deepEqual(
      [
        config.status,
        config.body.enabled,
        config.body.envName,
        config.body.action,
        config.body.minimumRole,
        config.body.stepUpClass,
        config.body.canShare,
      ],
      [
        200,
        false,
        'MRM_PLAY_INTERNAL_SHARING_ENABLED',
        'builds.share',
        'admin',
        'internal_sharing',
        true,
      ],
    );
    for (const res of [
      await t.preview('1'),
      await t.apply('1', { confirmHash: 'a'.repeat(64), confirmation: 'x' }),
      await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares`),
      await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares/x/link`),
    ]) {
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.error, 'internal_sharing_disabled');
      assert.match(res.body.message, /MRM_PLAY_INTERNAL_SHARING_ENABLED=true/);
    }
    assert.equal(t.built.length, 0, 'no connector was built');
    assert.equal(
      t.fake.count('openArtifactDownload') + t.fake.count('listArtifacts'),
      0,
      'GitHub was not asked either',
    );
    assert.equal((await t.audit()).filter((a) => a.action.startsWith('build.share')).length, 0);
  },
);

dbTest('flag off is the default of a server booted with no option at all', async (db) => {
  const plain = await bootCi(db);
  assert.equal(
    (await plain.call(plain.owner, 'GET', '/builds/internal-sharing/config')).body.enabled,
    false,
  );
});

dbTest(
  'rights: owners and admins only; members see the config (canShare false); viewers cannot; the download switch does not matter',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    const member = await t.addMember('member');
    const viewer = await t.addMember('viewer');
    const admin = await t.addMember('admin');
    assert.equal(
      (await t.send(member, 'GET', '/builds/internal-sharing/config')).body.canShare,
      false,
    );
    assert.equal(
      (await t.send(viewer, 'GET', '/builds/internal-sharing/config')).status,
      403,
      'viewers cannot even read builds',
    );
    for (const cookie of [member, viewer]) {
      assert.equal((await t.preview('1', {}, cookie)).status, 403);
      assert.equal(
        (await t.apply('1', { confirmHash: 'a'.repeat(64), confirmation: 'x' }, cookie)).status,
        403,
      );
      assert.equal(
        (await t.send(cookie, 'GET', `/apps/${t.appId}/builds/internal-shares`)).status,
        403,
      );
      assert.equal(
        (await t.send(cookie, 'GET', `/apps/${t.appId}/builds/internal-shares/x/link`)).status,
        403,
      );
    }
    assert.equal(
      (await t.preview('1', {}, admin)).status,
      200,
      'downloads are off here and sharing still works: it has its own switch',
    );
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    assert.equal((await t.preview('1', {}, await t.addMember('owner', 'other'))).status, 404);
  },
);

dbTest(
  'tokens: refused without the action named; with it the policy still needs a person when it covers the class',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    const mint = async (actions?: string[]) =>
      (
        await t.call(t.owner, 'POST', '/tokens', {
          name: 'CI',
          role: 'admin',
          ...(actions ? { actions } : {}),
        })
      ).body.token as string;
    const viaToken = (token: string, path: string, body: unknown) =>
      t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const none = await mint();
    const downloads = await mint(['builds.download', 'builds.read']);
    assert.equal(
      (await viaToken(none, `${t.base(t.appId)}/preview`, {})).status,
      403,
      'no list: never',
    );
    assert.equal(
      (await viaToken(downloads, `${t.base(t.appId)}/preview`, {})).status,
      403,
      'downloading is not sharing',
    );
    const named = await mint(['builds.share']);
    const p = await viaToken(named, `${t.base(t.appId)}/preview`, {});
    assert.equal(p.status, 200);
    const preview = (
      (await p.json()) as { preview: { confirmHash: string; confirmation: { phrase: string } } }
    ).preview;
    // Policy on and the class covered: a token cannot confirm.
    assert.equal(
      (await t.send(t.owner, 'PUT', '/step-up/policy', { mode: 'hard_actions' })).status,
      200,
    );
    const refused = await viaToken(named, t.base(t.appId), {
      confirmHash: preview.confirmHash,
      confirmation: preview.confirmation.phrase,
    });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, 'step_up_required_human');
    assert.equal(t.google.uploads.length, 0);
  },
);

// ----- preview ----------------------------------------------------------------------------------------------

dbTest(
  'preview: package, the file named by the artifact, sizes, the zip digest, a confirmHash and the phrase; no download, no Google, nothing written',
  async (db) => {
    const t = await boot(db);
    const archive = zip([{ name: 'app-release.aab', data: AAB }]);
    t.fake.artifacts = [art('1', 'app-release.aab.zip', { sizeInBytes: archive.length })];
    const res = await t.preview('1');
    assert.equal(res.status, 200, res.text);
    const p = res.body.preview;
    assert.deepEqual(p.app, {
      id: t.appId,
      name: 'Acme android',
      platform: 'android',
      identifier: 'com.acme.android',
    });
    assert.deepEqual(
      [p.artifact.id, p.artifact.kind, p.artifact.sizeBytes, p.artifact.zipSha256],
      ['1', 'aab', archive.length, 'd'.repeat(64)],
    );
    assert.deepEqual(p.upload, {
      packageName: 'com.acme.android',
      kind: 'bundle',
      fileName: 'app-release.aab',
      entry: null,
      versionCode: null,
      sha256: null,
      maxSizeBytes: 500 * 1024 * 1024,
    });
    assert.match(p.confirmHash, /^[0-9a-f]{64}$/);
    assert.equal(p.confirmation.phrase, 'SHARE com.acme.android');
    assert.equal(p.linkRetentionHours, 24);
    assert.ok(p.effects.some((e: string) => /secret/.test(e)));
    assert.deepEqual([p.checks.canShare, p.checks.blocking.length], [true, 0]);
    assert.equal(t.fake.count('openArtifactDownload'), 0);
    assert.equal(t.built.length, 0);
    assert.equal((await t.audit()).filter((a) => a.action.startsWith('build.')).length, 0);
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM play_internal_shares'))[0]?.n),
      0,
    );
    const again = await t.preview('1');
    assert.equal(
      again.body.preview.confirmHash,
      p.confirmHash,
      'the same artifact gives the same hash',
    );
    const named = await t.preview('1', { entry: 'out/app-release.aab' });
    assert.notEqual(
      named.body.preview.confirmHash,
      p.confirmHash,
      'the file named is part of what is confirmed',
    );
  },
);

dbTest(
  'preview: only Android apps; an Apple build blocks; a report is a warning; a bad entry, a bad id, an unknown or expired artifact',
  async (db) => {
    const t = await boot(db);
    t.fake.artifacts = [
      art('1', 'ios-build.ipa'),
      art('2', 'test-report'),
      art('3', 'x.aab', { expired: true }),
      art('4', 'y.aab', { runId: '999' }),
    ];
    const ipa = await t.preview('1');
    assert.equal(ipa.body.preview.checks.canShare, false);
    assert.equal(ipa.body.preview.checks.blocking[0].code, 'not_an_android_build');
    assert.equal(ipa.body.preview.confirmHash, null);
    assert.equal(ipa.body.preview.confirmation, null);
    const report = await t.preview('2');
    assert.deepEqual(
      [report.body.preview.checks.canShare, report.body.preview.checks.warnings[0].code],
      [true, 'not_obviously_a_build'],
    );
    assert.equal((await t.preview('3')).status, 410);
    assert.equal((await t.preview('4')).status, 404, "another run's artifact");
    assert.equal((await t.preview('777')).status, 404);
    assert.equal((await t.preview('x1')).status, 400);
    assert.equal((await t.preview('2', { entry: '../evil.aab' })).body.error, 'invalid_entry');
    assert.equal((await t.preview('2', { entry: 'notes.txt' })).body.error, 'invalid_entry');
    assert.equal((await t.preview('2', { extra: 1 })).status, 400, 'strict body');
    const ios = await t.seedApp('ios', [{ version: '1', build: '1' }]);
    const notAndroid = await t.send(
      t.owner,
      'POST',
      `/apps/${ios}/builds/artifacts/1/internal-share/preview`,
      {},
    );
    assert.deepEqual([notAndroid.status, notAndroid.body.error], [422, 'not_android']);
  },
);

// ----- apply ------------------------------------------------------------------------------------------------

dbTest(
  'apply: reads the zip, uploads the .aab once to the right package, keeps the link encrypted, audits ids only, never logs the link',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    const { res } = await t.share('1');
    assert.equal(res.status, 200, res.text);
    const { result } = res.body;
    assert.equal(result.downloadUrl, LINK);
    assert.equal(result.checksumMatches, true);
    assert.deepEqual(
      [
        result.share.kind,
        result.share.fileName,
        result.share.sizeBytes,
        result.share.sha256,
        result.share.packageName,
        result.share.certificateFingerprint,
        result.share.hasLink,
      ],
      ['bundle', 'app-release.aab', AAB.length, sha256(AAB), 'com.acme.android', 'AA:BB:CC', true],
    );
    assert.equal(result.share.expiresAt - result.share.createdAt, LINK_RETENTION_MS);
    assert.deepEqual(
      t.google.uploads,
      [{ kind: 'bundle', size: AAB.length, sha: sha256(AAB) }],
      'the bytes of the file inside the zip, once',
    );
    assert.deepEqual(
      t.built,
      [{ packageName: 'com.acme.android', hasSecret: true }],
      'the Google credential of the app',
    );
    assert.equal(await t.claim(), undefined, 'the claim is released');

    // The link is encrypted at rest and appears in no audit row, event or list.
    const row = (await db.query('SELECT url_secret FROM play_internal_shares'))[0];
    assert.match(String(row?.url_secret), /^v1\./);
    assert.equal(String(row?.url_secret).includes('play.google.com'), false);
    const actions = (await t.audit()).map((a) => a.action);
    for (const expected of ['credential.use', 'build.download', 'build.shared'])
      assert.ok(actions.includes(expected), expected);
    const everything = await trail(t);
    for (const secret of [LINK, 'SECRETLINKTOKEN', 'app-release', 'client_email', 'PRIVATE KEY'])
      assert.equal(
        everything.includes(secret),
        false,
        `${secret} is not in the audit or the events`,
      );
    assert.match(
      (await t.audit()).find((a) => a.action === 'build.shared')?.detail ?? '',
      /shareId/,
    );
    assert.match(
      (await t.audit()).find((a) => a.action === 'build.download')?.detail ?? '',
      /"via":"share"/,
    );

    const list = await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares`);
    assert.equal(list.status, 200);
    assert.equal(list.body.shares.length, 1);
    assert.equal(list.body.shares[0].hasLink, true);
    assert.equal(
      list.text.includes('play.google.com') || list.text.includes('SECRETLINKTOKEN'),
      false,
      'a list never carries a link',
    );
    const link = await t.send(
      t.owner,
      'GET',
      `/apps/${t.appId}/builds/internal-shares/${result.share.id}/link`,
    );
    assert.equal(link.body.downloadUrl, LINK);
    assert.equal(link.headers.get('cache-control'), 'no-store');
    assert.equal(
      (await t.audit()).some((a) => a.action === 'build.share_link_read'),
      true,
    );
    assert.equal((await trail(t)).includes(LINK), false);
    assert.equal(
      (await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares/nope/link`)).status,
      404,
    );
    assert.equal(
      (await t.send(t.owner, 'GET', `/apps/nope/builds/internal-shares/${result.share.id}/link`))
        .status,
      404,
      'a link is only read through its own app',
    );
  },
);

dbTest(
  'apply: an .apk goes as an apk; a zip with several builds needs the one you name; a zip with none is refused',
  async (db) => {
    const t = await boot(db);
    t.serve('1', [{ name: 'app/build/app-release.apk', data: AAB }]);
    const apk = await t.share('1');
    assert.equal(apk.res.status, 200, apk.res.text);
    assert.deepEqual(
      [apk.res.body.result.share.kind, apk.res.body.result.share.fileName],
      ['apk', 'app-release.apk'],
    );
    assert.equal(t.google.uploads[0]?.kind, 'apk');

    t.serve('2', [
      { name: 'a/app-release.aab', data: AAB },
      { name: 'b/app-debug.apk', data: new Uint8Array([9, 9, 9]) },
      { name: '__MACOSX/b/._app-debug.apk', data: new Uint8Array([1]) },
    ]);
    const many = await t.share('2');
    assert.equal(many.res.status, 422);
    assert.equal(many.res.body.error, 'entry_required');
    assert.deepEqual(many.res.body.entries, ['a/app-release.aab', 'b/app-debug.apk']);
    assert.equal(t.google.uploads.length, 1, 'nothing was uploaded');
    assert.equal(await t.claim(), undefined);

    t.serve('2', [
      { name: 'a/app-release.aab', data: AAB },
      { name: 'b/app-debug.apk', data: new Uint8Array([9, 9, 9]) },
    ]);
    const chosen = await t.share('2', {}, t.owner, {}, 'b/app-debug.apk');
    assert.equal(chosen.res.status, 200, chosen.res.text);
    assert.deepEqual(t.google.uploads[1], {
      kind: 'apk',
      size: 3,
      sha: sha256(new Uint8Array([9, 9, 9])),
    });

    t.serve('2', [{ name: 'a/app-release.aab', data: AAB }]);
    const missing = await t.share('2', {}, t.owner, {}, 'nope.apk');
    assert.deepEqual([missing.res.status, missing.res.body.error], [422, 'entry_not_found']);

    t.serve('3', [{ name: 'README.txt', data: new Uint8Array([1]) }]);
    assert.equal((await t.share('3')).res.body.error, 'no_android_build');
    t.fake.artifacts.push(art('4', 'android-bad'));
    t.fake.storage.set('4', {
      status: 'ok',
      body: streamOf(new Uint8Array([1, 2, 3, 4, 5])),
      contentLength: 5,
    });
    assert.equal((await t.share('4')).res.body.error, 'bad_zip');
    assert.equal(t.google.uploads.length, 2, 'only the two good ones');
  },
);

dbTest(
  'apply: a wrong phrase, a missing or stale hash, and an artifact that changed since the preview all stop before anything is read',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    const p = await t.preview('1');
    const good = {
      confirmHash: p.body.preview.confirmHash,
      confirmation: 'SHARE com.acme.android',
    };
    const wrong = await t.apply('1', { ...good, confirmation: 'share com.acme.android' });
    assert.deepEqual(
      [wrong.status, wrong.body.error, wrong.body.phrase],
      [422, 'confirmation_mismatch', 'SHARE com.acme.android'],
    );
    assert.equal(
      (await t.apply('1', { ...good, confirmation: 'SHARE com.other.app' })).status,
      422,
    );
    assert.equal(
      (await t.apply('1', { confirmation: good.confirmation })).status,
      400,
      'the hash is required',
    );
    assert.equal((await t.apply('1', { ...good, confirmHash: 'xyz' })).status, 400);
    assert.equal(
      (await t.apply('1', { ...good, confirmHash: 'f'.repeat(64) })).body.error,
      'state_changed',
    );
    // The artifact is another one now (a new run): the hash no longer fits.
    t.serve('1', [{ name: 'app-release.aab', data: AAB }], { digest: `sha256:${'e'.repeat(64)}` });
    const drift = await t.apply('1', good);
    assert.equal(drift.status, 409);
    assert.equal(drift.body.error, 'state_changed');
    assert.notEqual(
      drift.body.preview.confirmHash,
      good.confirmHash,
      'a new preview comes with the answer',
    );
    assert.equal(drift.body.preview.artifact.zipSha256, 'e'.repeat(64));
    assert.equal(t.fake.count('openArtifactDownload'), 0, 'nothing was downloaded');
    assert.equal(t.google.uploads.length, 0);
    assert.equal(t.built.length, 0);
    const failures = (await t.audit())
      .filter((a) => a.action === 'build.share_failed')
      .map((a) => JSON.parse(a.detail).code);
    assert.deepEqual([...failures].sort(), [
      'confirmation_mismatch',
      'confirmation_mismatch',
      'state_changed',
      'state_changed',
    ]);
    // The new hash works.
    t.serve('1', [{ name: 'app-release.aab', data: AAB }], { digest: `sha256:${'e'.repeat(64)}` });
    assert.equal(
      (
        await t.apply('1', {
          confirmHash: drift.body.preview.confirmHash,
          confirmation: good.confirmation,
        })
      ).status,
      200,
    );
  },
);

dbTest(
  'apply: an Apple build is refused; the zip limit is the download limit, for the zip, the file inside it and a stream that lies',
  async (db) => {
    const t = await boot(db, { maxDownloadBytes: 2000 });
    t.fake.artifacts = [
      art('1', 'ios-build.ipa'),
      art('2', 'android-release', { sizeInBytes: 5000 }),
    ];
    const p = await t.preview('1');
    assert.equal(p.body.preview.confirmHash, null);
    const blocked = await t.apply('1', {
      confirmHash: 'a'.repeat(64),
      confirmation: 'SHARE com.acme.android',
    });
    assert.deepEqual(
      [blocked.status, blocked.body.error, blocked.body.checks.blocking[0].code],
      [409, 'blocked', 'not_an_android_build'],
    );
    const big = await t.preview('2');
    assert.deepEqual([big.status, big.body.error], [413, 'artifact_too_large']);
    // An entry larger than the limit inside a small zip.
    const bomb = new Uint8Array(3000).fill(7);
    t.serve('3', [{ name: 'app-release.aab', data: bomb }]);
    assert.ok(
      (t.fake.artifacts.find((a) => a.id === '3')?.sizeInBytes ?? 0) < 2000,
      'the zip itself is small',
    );
    const inflated = await t.share('3');
    assert.deepEqual([inflated.res.status, inflated.res.body.error], [413, 'artifact_too_large']);
    assert.equal(t.google.uploads.length, 0);
    assert.equal(await t.claim(), undefined);
    // A stream that is longer than it said.
    t.fake.artifacts.push(art('5', 'android-liar', { sizeInBytes: 10 }));
    t.fake.storage.set('5', {
      status: 'ok',
      body: streamOf(new Uint8Array(3000)),
      contentLength: null,
    });
    assert.equal((await t.share('5')).res.body.error, 'artifact_too_large');
  },
);

// ----- step-up ----------------------------------------------------------------------------------------------

dbTest(
  'step-up: with the policy on a grant for internal_sharing, this app and this hash is needed, once; nothing is read without it',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    assert.equal(
      (await t.send(t.owner, 'PUT', '/step-up/policy', { mode: 'hard_actions' })).status,
      200,
    );
    const p = await t.preview('1');
    assert.equal(p.status, 200, 'previews stay free');
    const body = {
      confirmHash: p.body.preview.confirmHash,
      confirmation: p.body.preview.confirmation.phrase,
    };
    const missing = await t.apply('1', body);
    assert.deepEqual(
      [
        missing.status,
        missing.body.error,
        missing.body.action,
        missing.body.target,
        missing.body.reason,
      ],
      [403, 'step_up_required', 'internal_sharing', t.appId, 'missing'],
    );
    assert.equal(
      t.fake.count('openArtifactDownload') + t.google.uploads.length,
      0,
      'nothing was read or uploaded',
    );
    assert.equal(await t.claim(), undefined);
    // A grant for another hash, or another action, does not fit.
    const otherHash = await t.grantFor('internal_sharing', { id: t.appId, hash: 'b'.repeat(64) });
    assert.equal(
      (await t.apply('1', body, t.owner, { 'x-step-up-grant': otherHash })).body.reason,
      'mismatch',
    );
    const otherAction = await t.grantFor('store.release', { id: t.appId, hash: body.confirmHash });
    assert.equal(
      (await t.apply('1', body, t.owner, { 'x-step-up-grant': otherAction })).body.reason,
      'mismatch',
    );
    const grant = await t.grantFor('internal_sharing', { id: t.appId, hash: body.confirmHash });
    const done = await t.apply('1', body, t.owner, { 'x-step-up-grant': grant });
    assert.equal(done.status, 200, done.text);
    assert.equal(t.google.uploads.length, 1);
    t.serve('1');
    const reuse = await t.apply('1', body, t.owner, { 'x-step-up-grant': grant });
    assert.equal(reuse.body.reason, 'used', 'one use');
    assert.equal(t.google.uploads.length, 1);
  },
);

dbTest(
  'step-up: the switch comes first (a disabled server asks for no confirmation); a class the policy does not cover is free; no way to confirm is told where to add one',
  async (db) => {
    const off = await boot(db, { internalSharingEnabled: false });
    assert.equal(
      (await off.send(off.owner, 'PUT', '/step-up/policy', { mode: 'hard_actions' })).status,
      200,
    );
    assert.equal(
      (await off.apply('1', { confirmHash: 'a'.repeat(64), confirmation: 'x' })).body.error,
      'internal_sharing_disabled',
    );
  },
);

dbTest(
  'step-up: a class the policy does not cover is free; a person with no way to confirm is told where to add one',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    assert.equal(
      (
        await t.send(t.owner, 'PUT', '/step-up/policy', {
          mode: 'hard_actions',
          actions: ['store.release'],
        })
      ).status,
      200,
    );
    assert.equal((await t.share('1')).res.status, 200, 'internal_sharing is not on the list');
    const grant = await t.grantFor('step_up.manage', {});
    assert.equal(
      (
        await t.send(
          t.owner,
          'PUT',
          '/step-up/policy',
          { mode: 'hard_actions', actions: ['internal_sharing'] },
          { 'x-step-up-grant': grant },
        )
      ).status,
      200,
    );
    const admin = await t.addMember('admin');
    t.serve('2');
    const noWay = await t.share('2', {}, admin);
    assert.equal(noWay.res.body.error, 'step_up_not_enrolled');
    assert.equal(t.google.uploads.length, 1);
  },
);

// ----- the upload: errors, unknown outcome, one in flight -----------------------------------------------------

dbTest(
  'upload errors have a vocabulary, mean nothing was stored, release the claim, are audited without the Google text, and are never retried',
  async (db) => {
    const t = await boot(db);
    const cases: [Error, number, string][] = [
      [
        new StoreError('googleplay', 'auth', 'Google rejected the access token (401).', 401),
        422,
        'store_auth',
      ],
      [
        new StoreError('googleplay', 'forbidden', 'The service account has no access (403).', 403),
        422,
        'store_forbidden',
      ],
      [
        new StoreError('googleplay', 'api_disabled', 'The API is not enabled.', 403),
        422,
        'store_forbidden',
      ],
      [
        new StoreError(
          'googleplay',
          'not_found',
          'Google Play has no app com.acme.android (404).',
          404,
        ),
        422,
        'store_not_found',
      ],
      [
        new StoreError(
          'googleplay',
          'invalid_input',
          'Google Play did not accept the file (400).',
          400,
        ),
        422,
        'artifact_rejected',
      ],
      [
        new StoreError(
          'googleplay',
          'too_large',
          'Google Play refused the file because it is too large (413).',
          413,
        ),
        413,
        'artifact_too_large',
      ],
      [new StoreRateLimitError('googleplay', 42), 429, 'rate_limited'],
      [new Error('boom with PRIVATE KEY inside'), 502, 'upload_failed'],
    ];
    let n = 0;
    for (const [error, status, code] of cases) {
      const id = String(++n);
      t.serve(id);
      t.google.next = async () => {
        throw error;
      };
      const { res } = await t.share(id);
      assert.deepEqual([res.status, res.body.error], [status, code], error.message);
      assert.equal(res.text.includes('PRIVATE KEY'), false);
      assert.equal(await t.claim(), undefined, 'the claim is released');
      if (code === 'rate_limited') assert.equal(res.headers.get('retry-after'), '42');
    }
    assert.equal(t.google.uploads.length, cases.length, 'one upload per attempt: no retry');
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM play_internal_shares'))[0]?.n),
      0,
      'no share is recorded for a failure',
    );
    const failed = (await t.audit())
      .filter((a) => a.action === 'build.share_failed')
      .map((a) => JSON.parse(a.detail));
    assert.equal(failed.length, cases.length);
    assert.ok(failed.every((f) => f.outcome === 'failed' && f.hash && !('message' in f)));
    assert.equal(
      (await trail(t)).includes('Google rejected'),
      false,
      'no Google text in an audit row',
    );
  },
);

dbTest(
  'an unknown outcome is reported, never retried; it blocks until a preview clears it',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    t.google.next = async () => {
      throw new InternalSharingOutcomeUnknownError(
        'Google Play answered HTTP 503 while uploading, so it is not known whether Google stored the file.',
        503,
      );
    };
    const first = await t.share('1');
    assert.equal(first.res.status, 409);
    assert.equal(first.res.body.error, 'outcome_unknown');
    assert.equal(t.google.uploads.length, 1, 'not sent again');
    assert.equal((await t.claim())?.status, 'unknown');
    const state = await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares`);
    assert.deepEqual(
      [state.body.shares.length, state.body.unknownOutcome, state.body.inFlight],
      [0, true, false],
    );
    const audited = (await t.audit())
      .filter((a) => a.action === 'build.share_failed')
      .map((a) => JSON.parse(a.detail));
    assert.deepEqual([audited[0].outcome, audited[0].code], ['unknown', 'network']);

    // Another apply, with the old hash, is refused without a call to Google.
    t.serve('1');
    const blocked = await t.apply('1', {
      confirmHash: first.preview.body.preview.confirmHash,
      confirmation: 'SHARE com.acme.android',
    });
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(t.google.uploads.length, 1);
    // A preview tells the person and clears it; the next upload is a new, confirmed one.
    const again = await t.preview('1');
    assert.equal(again.body.preview.checks.warnings[0].code, 'previous_upload_unknown');
    assert.equal(await t.claim(), undefined);
    t.google.next = undefined;
    t.serve('1');
    assert.equal(
      (
        await t.apply('1', {
          confirmHash: again.body.preview.confirmHash,
          confirmation: again.body.preview.confirmation.phrase,
        })
      ).status,
      200,
    );
    assert.equal(t.google.uploads.length, 2);
  },
);

dbTest('a timeout is an unknown outcome too, and the upload is abandoned', async (db) => {
  const t = await boot(db, { internalSharingTimeoutMs: 30 });
  t.serve('1');
  t.google.next = () => new Promise(() => undefined);
  const { res } = await t.share('1');
  assert.deepEqual([res.status, res.body.error], [409, 'outcome_unknown']);
  assert.equal((await t.claim())?.status, 'unknown');
  assert.equal(
    JSON.parse(
      (await t.audit()).filter((a) => a.action === 'build.share_failed')[0]?.detail ?? '{}',
    ).code,
    'timeout',
  );
});

dbTest(
  'one upload in flight per app: a second one waits (409 write_in_progress); a dead claim is not trusted after its time',
  async (db) => {
    const t = await boot(db, { internalSharingClaimTtlMs: 60_000 });
    t.serve('1');
    t.serve('2');
    const p1 = await t.preview('1');
    const p2 = await t.preview('2');
    let release: (() => void) | undefined;
    t.google.next = () =>
      new Promise((resolve) => {
        release = () => resolve({ downloadUrl: LINK, certificateFingerprint: null, sha256: null });
      });
    const first = t.apply('1', {
      confirmHash: p1.body.preview.confirmHash,
      confirmation: p1.body.preview.confirmation.phrase,
    });
    for (let i = 0; i < 200 && release === undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(release, 'the first upload is waiting for Google');
    assert.equal((await t.claim())?.status, 'writing');
    const second = await t.apply('2', {
      confirmHash: p2.body.preview.confirmHash,
      confirmation: p2.body.preview.confirmation.phrase,
    });
    assert.deepEqual(
      [second.status, second.body.error],
      [409, 'blocked'],
      'the check sees the upload in flight',
    );
    assert.equal((await t.preview('2')).body.preview.checks.blocking[0].code, 'share_in_progress');
    release?.();
    const done = await first;
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.result.checksumMatches, null, 'Google gave no hash');
    assert.equal(await t.claim(), undefined);

    // A claim left by a process that died: blocking while young, taken over after its time (an extra upload is harmless).
    await db.execute(
      "INSERT INTO play_internal_share_claims (app_id, workspace_id, status, claimed_by, claim_at) VALUES (?, ?, 'writing', 'u', ?)",
      [t.appId, t.workspaceId, t.clock.now],
    );
    t.google.next = undefined;
    t.serve('2');
    assert.equal(
      (
        await t.apply('2', {
          confirmHash: p2.body.preview.confirmHash,
          confirmation: p2.body.preview.confirmation.phrase,
        })
      ).body.error,
      'blocked',
    );
    t.clock.now += 61_000;
    t.serve('2');
    const later = await t.share('2');
    assert.equal(later.res.status, 200, later.res.text);
  },
);

dbTest(
  'the link is kept 24 hours: after that the list has no link, the link route is 410 and the secret is cleared from the row',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    const { res } = await t.share('1');
    const id = res.body.result.share.id as string;
    t.clock.now += LINK_RETENTION_MS - 1000;
    assert.equal(
      (await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares/${id}/link`)).status,
      200,
    );
    t.clock.now += 2000;
    const list = await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares`);
    assert.equal(list.body.shares[0].hasLink, false);
    assert.equal(list.body.shares[0].sha256, sha256(AAB), 'the record stays, without its link');
    const gone = await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares/${id}/link`);
    assert.deepEqual([gone.status, gone.body.error], [410, 'link_expired']);
    assert.equal(
      (await db.query('SELECT url_secret FROM play_internal_shares'))[0]?.url_secret,
      null,
    );
    await db.execute('UPDATE play_internal_shares SET created_at = ?', [t.clock.now - 31 * DAY]);
    assert.equal(
      (await t.send(t.owner, 'GET', `/apps/${t.appId}/builds/internal-shares`)).body.shares.length,
      0,
      'old records go',
    );
  },
);

dbTest(
  'a ciphertext copied to another row does not decrypt (it is bound to its workspace and row)',
  async (db) => {
    const t = await boot(db);
    t.serve('1');
    const first = (await t.share('1')).res.body.result.share.id as string;
    t.serve('2');
    const second = (await t.share('2')).res.body.result.share.id as string;
    const [row] = await db.query('SELECT url_secret FROM play_internal_shares WHERE id = ?', [
      first,
    ]);
    await db.execute('UPDATE play_internal_shares SET url_secret = ? WHERE id = ?', [
      String(row?.url_secret),
      second,
    ]);
    const bad = await t.send(
      t.owner,
      'GET',
      `/apps/${t.appId}/builds/internal-shares/${second}/link`,
    );
    assert.deepEqual([bad.status, bad.body.error], [410, 'link_unreadable']);
    assert.equal(bad.text.includes('play.google.com'), false);
  },
);
