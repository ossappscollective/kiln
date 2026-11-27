import assert from 'node:assert/strict';
import { StoreError, StoreRateLimitError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { clearRepoSnapshots } from '../../services/repo-snapshot.ts';
import { clearAssetIndexes } from '../listing/asset-repo.ts';
import {
  ASC_SECRET,
  bootStaged,
  md5,
  PLAY_SECRET,
  type StagedBoot,
  sha256,
} from './test-helpers.ts';

/**
 * Pushing staged changes to a store as a DRAFT (docs/api/staged-changes.md, docs/adr/0009-staged-store-drafts.md).
 * Everything runs against fakes: no store and no GitHub is contacted.
 */

const TEXT = 'A freshly written description that nobody else would ever write';
const SHOTS = 'fastlane/metadata/ios/screenshots/en-US';
const K = (locale: string, field: string) => `${locale}\u0000${field}`;

/** An iOS app with a text and two screenshots staged. */
async function stagedIos(t: StagedBoot) {
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
  return app;
}
/** An Android app with a title, an icon and phone screenshots staged. */
async function stagedAndroid(t: StagedBoot) {
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
  return app;
}
const hashOf = async (t: StagedBoot, app: string): Promise<string> => {
  const res = await t.preview(app);
  assert.equal(res.status, 200, res.text.slice(0, 400));
  return res.body.preview.confirmHash as string;
};
const noStoreIo = (t: StagedBoot) => {
  for (const store of [t.stores.ios, t.stores.android])
    assert.equal(store.reads + store.applyCalls, 0);
  assert.equal(t.built.length, 0, 'no connector was built');
};

// ----- the kill switch -----------------------------------------------------------------------------

dbTest(
  'kill switch: with it off the push routes answer 409 store_draft_disabled, no store is reached, staging still works',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: false } });
    const app = await stagedIos(t);
    const config = await t.call(t.owner, 'GET', '/store-draft/config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [config.body.enabled, config.body.envName, config.body.submit.implemented],
      [false, 'KILN_STORE_DRAFT_WRITE_ENABLED', true],
    );
    assert.equal(config.body.submit.configRoute, '/store-submit/config');
    for (const [path, body] of [
      [t.sp(app, '/push/preview'), {}],
      [t.sp(app, '/push'), { confirmHash: 'a'.repeat(64) }],
    ] as const) {
      const res = await t.call(t.owner, 'POST', path, body);
      assert.equal(res.status, 409, path);
      assert.equal(res.body.error, 'store_draft_disabled');
      assert.match(res.body.message, /KILN_STORE_DRAFT_WRITE_ENABLED=true/);
    }
    noStoreIo(t);
    assert.equal((await t.call(t.owner, 'GET', t.sp(app))).status, 200, 'the staged view works');
    assert.equal((await t.audit('listing.draft_%')).length, 0);
    assert.equal(await t.claim(app), undefined);
    // The rights check comes first: someone who may not push learns nothing about the switch.
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.call(viewer, 'POST', t.sp(app, '/push'), { confirmHash: 'a'.repeat(64) })).status,
      403,
    );
  },
);

dbTest('kill switch: an app created without the option is off too (the default)', async (db) => {
  const t = await bootRepoApp(db);
  const config = await t.call(t.owner, 'GET', '/store-draft/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.enabled, false);
  assert.equal((await t.call(t.owner, 'POST', '/apps/x/staged/push/preview', {})).status, 409);
  assert.equal(
    (await t.call(t.owner, 'POST', '/apps/x/staged/push', { confirmHash: 'a'.repeat(64) })).status,
    409,
  );
});

// ----- rights ---------------------------------------------------------------------------------------------

dbTest('rights: only owners and admins preview or push; non-members get 404', async (db) => {
  const t = await bootStaged(db);
  const app = await stagedIos(t);
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  for (const cookie of [viewer, member]) {
    assert.equal((await t.preview(app, cookie)).status, 403);
    assert.equal((await t.push(app, 'a'.repeat(64), cookie)).status, 403);
    assert.equal((await t.call(cookie, 'GET', '/store-draft/config')).status, 200);
  }
  noStoreIo(t);
  const hash = await hashOf(t, app);
  assert.equal((await t.push(app, hash, admin)).status, 200, 'an admin may');
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const [method, path, body] of [
    ['GET', '/store-draft/config'],
    ['GET', t.sp(app)],
    ['POST', t.sp(app, '/push/preview'), {}],
    ['POST', t.sp(app, '/push'), { confirmHash: hash }],
  ] as const) {
    assert.equal((await t.call(outsider, method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await t.preview('no-such-app')).status, 404);
  assert.equal(t.stores.ios.applyCalls, 1, 'only the admin’s push reached the store');
});

dbTest(
  'tokens: the action must be named (no list never counts), the ceiling still applies, an app limited token reaches only its apps',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
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
    const hash = await hashOf(t, app);
    const everything = await mint({});
    assert.equal(
      (await bearer(everything, 'POST', t.sp(app, '/push'), { confirmHash: hash })).status,
      403,
      'no list: never',
    );
    assert.equal((await bearer(everything, 'POST', t.sp(app, '/push/preview'), {})).status, 403);
    const staging = await mint({ actions: ['apps.read', 'listing.read', 'changesets.write'] });
    assert.equal(
      (await bearer(staging, 'POST', t.sp(app, '/push'), { confirmHash: hash })).status,
      403,
      'staging rights are not push rights',
    );
    assert.equal(
      (
        await bearer(staging, 'PUT', t.sp(app, '/text'), {
          locale: 'en-US',
          field: 'keywords',
          from: 'local',
          value: 'a',
        })
      ).status,
      200,
    );
    const tooLow = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'member',
      actions: ['store.push_draft'],
    });
    assert.equal(
      tooLow.status,
      400,
      'the ceiling still applies: a member token cannot be given the action',
    );
    assert.equal(tooLow.body.error, 'action_above_role');
    assert.equal(t.stores.ios.applyCalls, 0);

    const scoped = await mint({ actions: ['store.push_draft', 'apps.read'], appIds: [app] });
    assert.equal(
      (await bearer(scoped, 'POST', t.sp(other, '/push/preview'), {})).status,
      404,
      'another app',
    );
    const fresh = await bearer(scoped, 'POST', t.sp(app, '/push/preview'), {});
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body).slice(0, 300));
    const done = await bearer(scoped, 'POST', t.sp(app, '/push'), {
      confirmHash: fresh.body.preview.confirmHash,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
    assert.equal(t.stores.ios.applyCalls, 1);
    assert.equal(
      (await t.audit('listing.draft_pushed'))[0]?.actorType,
      'token',
      'a push by a token is attributed to the token',
    );
  },
);

// ----- preview -----------------------------------------------------------------------------------------------

dbTest(
  'preview (App Store): the editable version, each item before and after, a hash; nothing is written',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    t.stores.ios.seedSet('en-US', 'APP_IPHONE_65', [
      { name: 'old.png', bytes: Buffer.from('old bytes') },
    ]);
    const res = await t.preview(app);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const p = res.body.preview;
    assert.deepEqual(p.version, {
      id: 'v-next',
      versionString: '2.1',
      state: 'PREPARE_FOR_SUBMISSION',
    });
    assert.equal(p.submits, false);
    assert.equal(p.app.platform, 'ios');
    assert.equal(p.text.length, 1);
    assert.deepEqual(
      [p.text[0].locale, p.text[0].field, p.text[0].before, p.text[0].after, p.text[0].status],
      ['en-US', 'description', 'Old text', TEXT, 'changed'],
    );
    assert.equal(p.assets.length, 1);
    const set = p.assets[0];
    assert.equal(set.id, 'en-US/screenshot:iphone_6_5');
    assert.equal(set.target, 'APP_IPHONE_65', 'the store’s own name of the set');
    assert.equal(set.before.setExists, true);
    assert.deepEqual(
      set.before.files.map((f: { name: string }) => f.name),
      ['old.png'],
    );
    assert.deepEqual(
      set.after.files.map((f: { name: string }) => f.name),
      ['1_iphone65.png', '2_iphone65.png'],
    );
    assert.ok(
      set.after.files.every(
        (f: { oid: string; bytes: number }) => /^[0-9a-f]{40}$/.test(f.oid) && f.bytes > 0,
      ),
    );
    assert.deepEqual([set.status, set.willUpload, set.willRemove], ['changed', 2, 1]);
    assert.deepEqual(p.summary, {
      textChanged: 1,
      textUnchanged: 0,
      assetSetsChanged: 1,
      assetSetsUnchanged: 0,
      filesToUpload: 2,
      filesToRemove: 1,
      fieldsChanged: 0,
      fieldsUnchanged: 0,
      nothingToDo: false,
    });
    assert.match(p.confirmHash, /^[0-9a-f]{64}$/);
    assert.ok(p.warnings.some((w: string) => /draft/i.test(w)));
    // A read, not a write.
    assert.equal(t.stores.ios.applyCalls, 0);
    assert.equal(t.stores.ios.reads, 1);
    assert.deepEqual(t.stores.ios.writes, []);
    assert.equal((await t.audit('listing.draft_%')).length, 0);
    assert.deepEqual(await t.events('listing.draft_pushed'), []);
    assert.equal(
      (await t.rows(app)).every((r) => r.pushed_at === null),
      true,
    );
    // Same inputs, same hash.
    assert.equal(await hashOf(t, app), p.confirmHash);
  },
);

dbTest(
  'preview shows what already matches as unchanged and says when there is nothing to do; a new locale is marked',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    assert.equal(
      (
        await t.stageText(app, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: 'Old text',
        })
      ).status,
      200,
    );
    const res = await t.preview(app);
    assert.equal(res.body.preview.text[0].status, 'unchanged');
    assert.equal(res.body.preview.summary.nothingToDo, true);
    await t.stageText(app, { locale: 'de-DE', field: 'description', from: 'local', value: 'Neu' });
    const withNew = await t.preview(app);
    const german = withNew.body.preview.text.find((x: { locale: string }) => x.locale === 'de-DE');
    assert.deepEqual(
      [german.status, german.localeExists, german.before],
      ['new_locale', false, null],
    );
  },
);

dbTest(
  'preview refuses what cannot be pushed: nothing staged, items with errors, a store without an editable version',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const none = await t.preview(app);
    assert.equal(none.status, 422);
    assert.equal(none.body.error, 'nothing_staged');
    await t.stageText(app, {
      locale: 'en-US',
      field: 'keywords',
      from: 'local',
      value: 'k'.repeat(101),
    });
    const bad = await t.preview(app);
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, 'staged_invalid');
    assert.equal(bad.body.problems[0].item, 'en-US/keywords');
    assert.equal(
      (await t.push(app, 'a'.repeat(64))).body.error,
      'staged_invalid',
      'a push refuses the same',
    );
    noStoreIo(t);
    await t.stageText(app, { locale: 'en-US', field: 'keywords', from: 'local', value: 'fine' });
    t.stores.ios.readError = new StoreError(
      'appstoreconnect',
      'no_editable_version',
      'Create the next version first.',
      404,
    );
    const missing = await t.preview(app);
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error, 'no_editable_version');
  },
);

// ----- push ---------------------------------------------------------------------------------------------------

dbTest(
  'push (App Store): the draft is written once, nothing is submitted, audited and emitted with ids and hashes only',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const res = await t.previewAndPush(app);
    assert.equal(res.push.status, 200, res.push.text.slice(0, 400));
    const r = res.push.body.result;
    assert.equal(r.draft, true);
    assert.equal(r.submitted, false);
    assert.equal(r.commit, 'none');
    assert.equal(r.confirmedByReread, false);
    assert.deepEqual(r.version, {
      id: 'v-next',
      versionString: '2.1',
      state: 'PREPARE_FOR_SUBMISSION',
    });
    assert.deepEqual(r.counts, { applied: 2, alreadySame: 0, filesUploaded: 2, filesRemoved: 0 });
    assert.deepEqual(
      r.steps.map((s: { type: string; target: string; outcome: string }) => [
        s.type,
        s.target,
        s.outcome,
      ]),
      [
        ['text', 'description', 'applied'],
        ['asset', 'APP_IPHONE_65', 'applied'],
      ],
    );
    assert.match(r.note, /draft/i);
    assert.equal(t.stores.ios.texts.get(K('en-US', 'description')), TEXT);
    const sent = t.stores.ios.lastInput?.assets[0]?.files ?? [];
    assert.deepEqual(
      sent.map((f) => f.name),
      ['1_iphone65.png', '2_iphone65.png'],
    );
    for (const f of sent) {
      const original = t.repo.blobs.get(`${SHOTS}/${f.name.replace('_iphone65', '_iphone65')}`);
      assert.ok(
        original && Buffer.compare(Buffer.from(f.bytes), original) === 0,
        'the bytes are the repository’s',
      );
      assert.equal(f.md5, md5(f.bytes));
      assert.equal(f.sha256, sha256(f.bytes));
      assert.equal(f.mime, 'image/png');
    }
    assert.equal(t.stores.ios.applyCalls, 1);
    assert.equal(t.stores.ios.writes.length, 1);

    const view = await t.view(app);
    assert.equal(view.text[0]?.pushed, true);
    assert.equal(view.assets[0]?.pushed, true);
    const audit = (await t.audit('listing.draft_pushed'))[0];
    assert.equal(audit?.actorType, 'user');
    assert.deepEqual(
      [audit?.detail.appId, audit?.detail.platform, audit?.detail.commit, audit?.detail.versionId],
      [app, 'ios', 'none', 'v-next'],
    );
    assert.equal(audit?.detail.hash, res.preview.body.preview.confirmHash);
    assert.deepEqual(
      [
        audit?.detail.texts,
        audit?.detail.assetSets,
        audit?.detail.applied,
        audit?.detail.filesUploaded,
      ],
      [1, 1, 2, 2],
    );
    const events = await t.events('listing.draft_pushed');
    assert.equal(events.length, 1);
    const payload = events[0]?.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      'actor',
      'alreadySame',
      'appId',
      'applied',
      'assetSets',
      'commit',
      'confirmedByReread',
      'fields',
      'filesRemoved',
      'filesUploaded',
      'platform',
      'store',
      'submitted',
      'texts',
    ]);
    assert.equal(payload.submitted, false);
    assert.equal(payload.store, 'appstoreconnect');
    assert.equal(await t.claim(app), undefined, 'the claim was given back');
    assert.equal(t.built.length, 2, 'one connector for the preview and one for the push');
    assert.ok(
      t.built.every((b) => b.kind === 'app_store_connect' && b.storeAppId === '1234567890'),
    );
    const used = (await t.audit('credential.use')).filter(
      (a) => a.detail.purpose === 'store.draft_push',
    );
    assert.ok(used.length >= 2);
  },
);

dbTest(
  'push (Google Play): one edit committed held back from review; nothing is sent for review',
  async (db) => {
    const t = await bootStaged(db);
    t.stores.android.sets.clear(); // a store listing with no graphics yet (the default fixture holds two screenshots)
    const app = await stagedAndroid(t);
    const res = await t.previewAndPush(app);
    assert.equal(res.push.status, 200, res.push.text.slice(0, 400));
    const r = res.push.body.result;
    assert.equal(r.commit, 'not_sent_for_review');
    assert.equal(r.submitted, false);
    assert.equal(r.version, null);
    assert.deepEqual(r.counts, { applied: 3, alreadySame: 0, filesUploaded: 3, filesRemoved: 0 });
    assert.equal(t.stores.android.texts.get(K('en-US', 'title')), 'Acme');
    const phone = t.stores.android.lastInput?.assets.find((a) => a.kind === 'screenshot');
    assert.deepEqual(
      phone?.files.map((f) => f.name),
      ['1.png', '2.png'],
    );
    const icon = t.stores.android.lastInput?.assets.find((a) => a.kind === 'icon');
    assert.deepEqual(
      icon?.files.map((f) => f.name),
      ['icon.png'],
    );
    assert.equal((await t.audit('listing.draft_pushed'))[0]?.detail.commit, 'not_sent_for_review');
    assert.equal(
      (await t.events('listing.draft_pushed'))[0]?.payload.commit,
      'not_sent_for_review',
    );
    assert.ok(t.built.every((b) => b.kind === 'google_play' && b.identifier === 'com.acme.app'));
  },
);

dbTest(
  'push is idempotent: a second push of the same items writes nothing and says so',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    assert.equal((await t.previewAndPush(app)).push.status, 200);
    const preview = await t.preview(app);
    assert.equal(preview.body.preview.summary.nothingToDo, true);
    assert.deepEqual(
      [preview.body.preview.text[0].status, preview.body.preview.assets[0].status],
      ['unchanged', 'unchanged'],
    );
    const second = await t.push(app, preview.body.preview.confirmHash);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.result.counts, {
      applied: 0,
      alreadySame: 2,
      filesUploaded: 0,
      filesRemoved: 0,
    });
    assert.equal(second.body.result.commit, 'none');
  },
);

dbTest(
  'the push needs the hash of a preview: a wrong one writes nothing and returns a new preview; a malformed one is 400',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    const wrong = await t.push(app, 'b'.repeat(64));
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'state_changed');
    assert.equal(wrong.body.preview.confirmHash, hash, 'the new preview carries the right hash');
    assert.equal(t.stores.ios.writes.length, 0, 'nothing was written');
    assert.equal((await t.audit('listing.draft_push_failed'))[0]?.detail.code, 'state_changed');
    assert.equal(await t.claim(app), undefined);
    for (const bad of ['', 'nope', 'A'.repeat(64), 'a'.repeat(63)]) {
      assert.equal((await t.push(app, bad)).status, 400, `hash ${JSON.stringify(bad)}`);
    }
    assert.equal((await t.call(t.owner, 'POST', t.sp(app, '/push'), {})).status, 400);
    // The hash of another app's preview does not fit.
    const other = await stagedIos(t);
    assert.equal((await t.push(other, hash)).status, 409);
    assert.equal(t.stores.ios.writes.length, 0);
    assert.equal((await t.push(app, hash)).status, 200);
  },
);

dbTest(
  'drift: the store’s draft changed after the preview: nothing is written, the answer carries a new preview',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    t.stores.ios.texts.set(K('en-US', 'description'), 'Somebody edited this in App Store Connect');
    const res = await t.push(app, hash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'state_changed');
    assert.equal(res.body.preview.text[0].before, 'Somebody edited this in App Store Connect');
    assert.notEqual(res.body.preview.confirmHash, hash);
    assert.equal(t.stores.ios.writes.length, 0);
    assert.equal(
      t.stores.ios.texts.get(K('en-US', 'description')),
      'Somebody edited this in App Store Connect',
      'their edit survived',
    );
    assert.equal((await t.push(app, res.body.preview.confirmHash)).status, 200);
    assert.equal(t.stores.ios.texts.get(K('en-US', 'description')), TEXT);
  },
);

dbTest('drift: the staged items changed after the preview: nothing is written', async (db) => {
  const t = await bootStaged(db);
  const app = await stagedIos(t);
  const hash = await hashOf(t, app);
  await t.stageText(app, {
    locale: 'en-US',
    field: 'description',
    from: 'local',
    value: 'A different text',
  });
  const res = await t.push(app, hash);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'state_changed');
  assert.equal(res.body.preview.text[0].after, 'A different text');
  assert.equal(t.stores.ios.writes.length, 0);
  const again = await hashOf(t, app);
  assert.equal((await t.unstage(app, 'en-US/screenshot:iphone_6_5')).status, 200);
  assert.equal((await t.push(app, again)).status, 409);
  assert.equal(t.stores.ios.writes.length, 0);
});

dbTest(
  'the files are read from the staged commit and held to the staged blob id: a changed or vanished file writes nothing',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const path = `${SHOTS}/1_iphone65.png`;
    const hash = await hashOf(t, app);
    t.repo.swapped.set(path, Buffer.from(t.repo.blobs.get(path) ?? []).fill(1, 20, 30));
    clearAssetIndexes();
    clearRepoSnapshots();
    const changed = await t.push(app, hash);
    assert.equal(changed.status, 422, changed.text.slice(0, 300));
    assert.equal(changed.body.error, 'asset_changed');
    assert.equal(t.stores.ios.applyCalls, 0, 'nothing reached the store');
    t.repo.swapped.clear();
    t.repo.blobs.delete(path);
    clearAssetIndexes();
    clearRepoSnapshots();
    const readsBefore = t.stores.ios.reads;
    const gone = await t.preview(app);
    assert.equal(gone.status, 422);
    assert.equal(gone.body.error, 'asset_changed');
    assert.equal(t.stores.ios.applyCalls, 0, 'nothing reached the store');
    assert.equal(t.stores.ios.reads, readsBefore, 'the store was not even read');
    assert.equal(await t.claim(app), undefined);
  },
);

// ----- one write in flight ---------------------------------------------------------------------------------------

dbTest(
  'one write in flight per app: a second push meanwhile is 409 write_in_progress; another app is not blocked',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    let open!: () => void;
    t.stores.ios.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = t.push(app, hash);
    while (t.stores.ios.writes.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      (await db.query('SELECT status, action FROM store_draft_claims')).map((c) => [
        c.status,
        c.action,
      ]),
      [['writing', 'push_draft']],
    );
    const second = await t.push(app, hash);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'write_in_progress');
    const droid = await stagedAndroid(t);
    assert.equal(
      (await t.previewAndPush(droid)).push.status,
      200,
      'another app (and platform) is its own claim',
    );
    open();
    assert.equal((await first).status, 200);
    assert.equal(t.stores.ios.writes.length, 1, 'only the first reached the store');
    assert.deepEqual(await db.query('SELECT app_id FROM store_draft_claims'), []);
  },
);

dbTest(
  'a claim that expired is taken over (the re-read and the hash still decide); one marked unknown blocks until a preview reads the store',
  async (db) => {
    const t = await bootStaged(db, { draft: { claimTtlMs: 60_000 } });
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    const old = Date.now() - 10 * 60_000;
    const insert = (status: string) =>
      db.execute(
        "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', ?, 'u', ?)",
        [app, t.workspaceId, status, old],
      );
    await insert('writing');
    assert.equal((await t.push(app, hash)).status, 200, 'a dead write does not block for ever');
    await insert('unknown');
    const hash2 = await hashOf(t, app);
    assert.deepEqual(
      await db.query('SELECT app_id FROM store_draft_claims'),
      [],
      'a preview read the store, so the unknown outcome is settled',
    );
    await insert('unknown');
    const blocked = await t.push(app, hash2);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(t.stores.ios.writes.length, 1);
    await t.preview(app);
    assert.equal((await t.push(app, hash2)).status, 200);
  },
);

// ----- an unknown outcome -------------------------------------------------------------------------------------------

dbTest(
  'an unknown outcome that was applied: the draft is read back and the push is confirmed, never written twice',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    const res = await t.push(app, hash);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.result.confirmedByReread, true);
    assert.deepEqual(res.body.result.counts, {
      applied: 2,
      alreadySame: 0,
      filesUploaded: 2,
      filesRemoved: 0,
    });
    assert.equal(t.stores.ios.applyCalls, 1, 'never sent again');
    assert.equal((await t.events('listing.draft_pushed'))[0]?.payload.confirmedByReread, true);
    assert.equal((await t.audit('listing.draft_pushed'))[0]?.detail.via, 'reread');
    assert.equal((await t.view(app)).text[0]?.pushed, true);
    assert.equal(await t.claim(app), undefined);
    const droid = await stagedAndroid(t);
    const droidHash = await hashOf(t, droid);
    t.stores.android.behavior = { kind: 'unknown', applied: true };
    const play = await t.push(droid, droidHash);
    assert.equal(play.status, 200);
    assert.deepEqual(
      [play.body.result.confirmedByReread, play.body.result.commit],
      [true, 'not_sent_for_review'],
    );
  },
);

dbTest(
  'an unknown outcome that was not applied: the App Store says so (502 write_failed); Google Play cannot be sure, so it asks for a new preview',
  async (db) => {
    const t = await bootStaged(db);
    const ios = await stagedIos(t);
    const hash = await hashOf(t, ios);
    t.stores.ios.behavior = { kind: 'unknown', applied: false };
    const failed = await t.push(ios, hash);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'write_failed');
    assert.equal(failed.body.outcome, 'not_applied');
    assert.equal(t.stores.ios.applyCalls, 1, 'not written again');
    assert.equal(await t.claim(ios), undefined);
    assert.equal((await t.events('listing.draft_pushed')).length, 0, 'no event for a failed push');
    assert.equal((await t.audit('listing.draft_push_failed'))[0]?.detail.code, 'not_applied');
    assert.equal((await t.view(ios)).text[0]?.pushed, false);

    const droid = await stagedAndroid(t);
    const droidHash = await hashOf(t, droid);
    t.stores.android.behavior = { kind: 'unknown', applied: false };
    const play = await t.push(droid, droidHash);
    assert.equal(play.status, 409);
    assert.equal(play.body.error, 'outcome_unknown');
    assert.equal((await t.claim(droid))?.status, 'unknown');
    t.stores.android.behavior = { kind: 'ok' };
    assert.equal(
      (await t.push(droid, droidHash)).body.error,
      'outcome_unknown',
      'blocked until the store is read again',
    );
    const fresh = await hashOf(t, droid);
    assert.equal(await t.claim(droid), undefined);
    assert.equal((await t.push(droid, fresh)).status, 200);
  },
);

dbTest(
  'an unknown outcome that cannot be read back is outcome_unknown and blocks; a draft that holds only some of the changes is draft_partial',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    t.stores.ios.readFailsAfterWrite = true;
    const res = await t.push(app, hash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outcome_unknown');
    assert.equal((await t.claim(app))?.status, 'unknown');
    assert.equal((await t.audit('listing.draft_push_failed'))[0]?.detail.outcome, 'unknown');
    t.stores.ios.readError = undefined;
    t.stores.ios.readFailsAfterWrite = false;
    t.stores.ios.behavior = { kind: 'ok' };
    await t.preview(app);
    assert.equal(await t.claim(app), undefined);

    // The first change was applied, then the store stopped answering.
    t.stores.ios.sets.clear();
    const other = await t.addApp('ios');
    await t.stageText(other, {
      locale: 'en-US',
      field: 'keywords',
      from: 'local',
      value: 'one, two',
    });
    await t.stageAssets(other, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
    const otherHash = await hashOf(t, other);
    t.stores.ios.behavior = { kind: 'unknown', applied: 'first' };
    const partial = await t.push(other, otherHash);
    assert.equal(partial.status, 409, partial.text.slice(0, 300));
    assert.equal(partial.body.error, 'draft_partial');
    assert.deepEqual(
      partial.body.items.text.map((i: { matches: boolean }) => i.matches),
      [true],
    );
    assert.deepEqual(
      partial.body.items.assets.map((i: { matches: boolean }) => i.matches),
      [false],
    );
    assert.equal(
      await t.claim(other),
      undefined,
      'the draft could be read, so the push can be retried',
    );
  },
);

dbTest(
  'a refusal part way (App Store) is draft_partial with what was written; what was written is marked pushed; a second push finishes the rest',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    t.stores.ios.behavior = {
      kind: 'partial',
      after: 1,
      error: new StoreError(
        'appstoreconnect',
        'invalid_input',
        'That display type is not allowed here.',
        409,
      ),
    };
    const res = await t.push(app, hash);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'draft_partial');
    assert.deepEqual(
      res.body.completed.map((s: { type: string; target: string }) => [s.type, s.target]),
      [['text', 'description']],
    );
    assert.deepEqual([res.body.failed.type, res.body.failed.target], ['asset', 'APP_IPHONE_65']);
    assert.equal(res.body.storeError.code, 'store_rejected');
    assert.equal(
      t.stores.ios.texts.get(K('en-US', 'description')),
      TEXT,
      'what was written stays written',
    );
    const view = await t.view(app);
    assert.deepEqual([view.text[0]?.pushed, view.assets[0]?.pushed], [true, false]);
    assert.equal(await t.claim(app), undefined);
    assert.equal((await t.audit('listing.draft_push_failed'))[0]?.detail.code, 'partial');
    assert.equal((await t.events('listing.draft_pushed')).length, 0);
    t.stores.ios.behavior = { kind: 'ok' };
    const second = await t.previewAndPush(app);
    assert.equal(second.preview.body.preview.summary.textChanged, 0, 'the text already matches');
    assert.equal(second.push.status, 200);
    assert.deepEqual(second.push.body.result.counts, {
      applied: 1,
      alreadySame: 1,
      filesUploaded: 2,
      filesRemoved: 0,
    });
    const done = await t.view(app);
    assert.deepEqual([done.text[0]?.pushed, done.assets[0]?.pushed], [true, true]);
  },
);

dbTest(
  'App Store: when the set read back still lists images that were to go, the push is applied_with_differences, the set stays staged, and nothing is claimed as done',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    // The store holds four screenshots; the staged set has fewer, so a push removes some.
    t.stores.ios.seedSet(
      'en-US',
      'APP_IPHONE_65',
      [1, 2, 3, 4].map((n) => ({ name: `left${n}.png`, bytes: new Uint8Array([n, 9, 9]) })),
    );
    t.stores.ios.ghostRemovals = true;
    const hash = await hashOf(t, app);
    const res = await t.push(app, hash);
    assert.equal(res.status, 409, res.text.slice(0, 400));
    assert.equal(res.body.error, 'applied_with_differences');
    assert.match(res.body.message, /still listed: left3\.png, left4\.png/);
    assert.deepEqual(
      res.body.differences.map((d: { stillPresent: { name: string }[] }) =>
        d.stillPresent.map((f) => f.name),
      ),
      [['left3.png', 'left4.png']],
    );
    const view = await t.view(app);
    assert.deepEqual(
      [view.text[0]?.pushed, view.assets[0]?.pushed],
      [true, false],
      'the text is done; the set whose removals did not show stays pending',
    );
    assert.equal(await t.claim(app), undefined);
    assert.equal(
      (await t.audit('listing.draft_push_failed'))[0]?.detail.code,
      'applied_with_differences',
    );
    assert.equal((await t.events('listing.draft_pushed')).length, 0, 'no success was announced');
  },
);

dbTest(
  'a push that outlives the timeout is read back, not repeated; a read that outlives it answers 504',
  async (db) => {
    const t = await bootStaged(db, { draft: { timeoutMs: 80 } });
    const app = await stagedIos(t);
    const hash = await hashOf(t, app);
    let open!: () => void;
    t.stores.ios.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const res = await t.push(app, hash);
    assert.equal(res.status, 502, res.text.slice(0, 300));
    assert.equal(res.body.error, 'write_failed');
    assert.equal(res.body.outcome, 'not_applied');
    assert.equal(t.stores.ios.applyCalls, 1);
    open();
    t.stores.ios.readDraft = () => new Promise<never>(() => undefined);
    const read = await t.preview(app);
    assert.equal(read.status, 504);
    assert.equal(read.body.error, 'timeout');
  },
);

// ----- refusals by the store ---------------------------------------------------------------------------------------

dbTest(
  'a refusal by the store: nothing changed, a clear code, the claim given back, an audit entry, no secret in the answer',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const cases: [StoreError, number, string][] = [
      [
        new StoreError('appstoreconnect', 'forbidden', `no ${ASC_SECRET}`, 403),
        422,
        'store_forbidden',
      ],
      [new StoreError('appstoreconnect', 'auth', 'bad key', 401), 422, 'store_auth'],
      [new StoreError('appstoreconnect', 'not_found', 'gone', 404), 422, 'store_not_found'],
      [
        new StoreError(
          'googleplay',
          'draft_not_allowed',
          'Google would not hold the changes back.',
          400,
        ),
        409,
        'draft_not_allowed',
      ],
      [
        new StoreError('googleplay', 'changes_in_review', 'Changes are in review.', 400),
        409,
        'changes_in_review',
      ],
      [new StoreError('appstoreconnect', 'server', 'down', 503), 502, 'store_unavailable'],
      [new StoreError('appstoreconnect', 'unexpected', 'refused', 409), 422, 'store_rejected'],
      [new StoreRateLimitError('appstoreconnect', 120), 429, 'rate_limited'],
    ];
    for (const [error, status, code] of cases) {
      const hash = await hashOf(t, app);
      t.stores.ios.behavior = { kind: 'refuse', error };
      const res = await t.push(app, hash);
      assert.equal(res.status, status, code);
      assert.equal(res.body.error, code);
      if (code === 'rate_limited') assert.equal(res.headers.get('retry-after'), '120');
      assert.ok(!res.text.includes(ASC_SECRET), 'no secret in the answer');
      assert.equal(await t.claim(app), undefined, `${code}: the claim was given back`);
    }
    assert.equal((await t.audit('listing.draft_push_failed')).length, cases.length);
    assert.equal((await t.events('listing.draft_pushed')).length, 0);
    assert.equal(t.stores.ios.texts.get(K('en-US', 'description')), 'Old text');
    t.stores.ios.readError = new StoreError(
      'appstoreconnect',
      'network',
      'Could not reach api.appstoreconnect.apple.com.',
    );
    const down = await t.preview(app);
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'store_unavailable');
  },
);

dbTest('credential problems stop before any store call and give the claim back', async (db) => {
  const t = await bootStaged(db);
  const droid = await stagedAndroid(t);
  const ios = await stagedIos(t);
  const hash = await hashOf(t, droid);
  const iosHash = await hashOf(t, ios);
  const built = t.built.length;
  await db.execute('UPDATE apps SET store_app_id = NULL WHERE id = ?', [ios]);
  const unsynced = await t.push(ios, iosHash);
  assert.equal(unsynced.status, 422);
  assert.equal(unsynced.body.error, 'app_not_synced');
  await db.execute("UPDATE credentials SET kind = 'github_token' WHERE id = ?", [t.playCredential]);
  assert.equal((await t.push(droid, hash)).body.error, 'credential_kind');
  await db.execute(
    "UPDATE credentials SET kind = 'google_play', ciphertext = 'garbage' WHERE id = ?",
    [t.playCredential],
  );
  const unreadable = await t.push(droid, hash);
  assert.equal(unreadable.status, 422);
  assert.equal(unreadable.body.error, 'credential_unreadable');
  assert.equal(t.built.length, built);
  assert.equal(t.stores.android.applyCalls + t.stores.ios.applyCalls, 0);
  assert.deepEqual(await db.query('SELECT app_id FROM store_draft_claims'), []);
});

// ----- nothing sensitive is stored --------------------------------------------------------------------------------------

dbTest(
  'audit, events and answers never hold a credential or a text; deleting the app removes its claim and its staged rows',
  async (db) => {
    const t = await bootStaged(db);
    const app = await stagedIos(t);
    const droid = await stagedAndroid(t);
    await t.previewAndPush(app);
    t.stores.android.behavior = {
      kind: 'refuse',
      error: new StoreError('googleplay', 'forbidden', `no ${PLAY_SECRET}`, 403),
    };
    await t.previewAndPush(droid);
    for (const table of ['audit_events', 'events', 'jobs']) {
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
      "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', 'unknown', 'u', 1)",
      [app, t.workspaceId],
    );
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${app}`)).status, 204);
    assert.equal(await t.claim(app), undefined);
    assert.deepEqual(await t.rows(app), []);
  },
);

// ----- the registry --------------------------------------------------------------------------------------------------------

dbTest(
  'the API description lists the staged routes with their action and risk; the push is destructive',
  async (db) => {
    const t = await bootStaged(db);
    const res = await t.app.request('/api/openapi.json', { headers: { cookie: t.owner } });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const at = (path: string, method: string) =>
      doc.paths[`/api/workspaces/{workspaceId}${path}`]?.[method];
    assert.equal(at('/store-draft/config', 'get')?.['x-kiln-action'], 'apps.read');
    for (const [path, method, action, risk] of [
      ['/apps/{id}/staged', 'get', 'listing.read', 'read'],
      ['/apps/{id}/staged/text', 'put', 'changesets.write', 'write'],
      ['/apps/{id}/staged/assets', 'put', 'changesets.write', 'write'],
      ['/apps/{id}/staged/push/preview', 'post', 'store.push_draft', 'read'],
      ['/apps/{id}/staged/push', 'post', 'store.push_draft', 'destructive'],
    ] as const) {
      assert.equal(at(path, method)?.['x-kiln-action'], action, `${method} ${path}`);
      assert.equal(at(path, method)?.['x-kiln-risk'], risk, `${method} ${path}`);
    }
  },
);
