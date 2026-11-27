import assert from 'node:assert/strict';
import { STAGED_LIMITS } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { iosListing, playListing } from '../listing/test-helpers.ts';
import { bootStaged, IPHONE_65, jpeg, png } from './test-helpers.ts';

/**
 * Staging: collecting listing text and graphics per app, without touching a store (docs/api/staged-changes.md).
 * Everything runs against fakes.
 */

const SHOTS = 'fastlane/metadata/ios/screenshots/en-US';
const IMAGES = 'fastlane/metadata/android/en-US/images';

// ----- text --------------------------------------------------------------------------------------

dbTest(
  'a staged text is judged against the store DRAFT when there is one (before = draft, not live)',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const live = 'The live description, long enough to be a description of the app.';
    const draft = 'The draft description, long enough to be a description of the app.';
    t.readStores.ios.listing = {
      platform: 'ios',
      appStoreId: '1234567890',
      warnings: [],
      channels: [
        {
          channel: 'live',
          versionString: '1.0',
          listing: { appStore: { locales: { 'en-US': { name: 'Acme', description: live } } } },
        },
        {
          channel: 'editable',
          versionString: '1.1',
          listing: { appStore: { locales: { 'en-US': { name: 'Acme', description: draft } } } },
        },
      ],
    };
    assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/sync`)).status, 200);
    // The text of the draft is what a push would write unchanged: unchanged, whatever the live copy says.
    const same = await t.stageText(app, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: draft,
    });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.body.staged.text[0].before, draft);
    assert.equal(same.body.staged.text[0].status, 'unchanged');
    // The live text differs from the draft: a push would change the draft, so it is a change.
    const other = await t.stageText(app, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: live,
    });
    assert.equal(other.body.staged.text[0].before, draft);
    assert.equal(other.body.staged.text[0].status, 'changed');
  },
);

dbTest(
  'a typed text is staged, normalized, shown with its limit, and nothing is sent to a store',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const res = await t.stageText(app, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: 'Line one\r\nLine two   \n\n',
    });
    assert.equal(res.status, 200, res.text);
    const item = res.body.staged.text[0];
    assert.equal(
      item.value,
      'Line one\nLine two',
      'line breaks and trailing white space are normalized',
    );
    assert.deepEqual(
      [item.locale, item.field, item.source, item.label, item.limit, item.unit],
      ['en-US', 'description', 'local', 'Description', 4000, 'characters'],
    );
    assert.equal(item.status, 'changed');
    assert.equal(item.pushed, false);
    assert.equal(res.body.staged.valid, true);
    assert.deepEqual(res.body.staged.pushable.textFields, [
      'description',
      'keywords',
      'promotional_text',
      'release_notes',
      'marketing_url',
      'support_url',
    ]);
    assert.deepEqual(res.body.staged.limits, STAGED_LIMITS);
    assert.equal(t.built.length, 0, 'no connector was built');
    assert.equal(t.stores.ios.reads + t.stores.ios.applyCalls, 0);
    assert.equal(t.repo.readCalls.length, 0, 'no repository file was read');
    const row = (await t.rows(app))[0];
    assert.equal(row?.value_text, 'Line one\nLine two');
    assert.equal(row?.kind, 'listing_text');
    // Staging the same field again replaces it.
    const again = await t.stageText(app, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: 'Second',
    });
    assert.equal(again.body.staged.text.length, 1);
    assert.equal(again.body.staged.text[0].value, 'Second');
    assert.equal((await t.rows(app)).length, 1);
    const got = await t.call(t.owner, 'GET', t.sp(app));
    assert.equal(got.status, 200);
    assert.equal(got.body.staged.text[0].value, 'Second');
  },
);

dbTest(
  'what a push cannot write is refused when staging: the App Store name, subtitle and privacy URL; unknown fields; bad locales; empty and huge texts',
  async (db) => {
    const t = await bootStaged(db);
    const ios = await t.addApp('ios');
    const droid = await t.addApp('android');
    for (const field of ['name', 'subtitle', 'privacy_url']) {
      const res = await t.stageText(ios, { locale: 'en-US', field, from: 'local', value: 'x' });
      assert.equal(res.status, 422, field);
      assert.equal(res.body.error, 'field_not_pushable');
      assert.ok(res.body.allowed.includes('description'));
    }
    assert.equal(
      (await t.stageText(ios, { locale: 'en-US', field: 'title', from: 'local', value: 'x' })).body
        .error,
      'field_not_pushable',
      'a Google Play field is not an App Store field',
    );
    assert.equal(
      (await t.stageText(droid, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' }))
        .status,
      200,
    );
    assert.equal(
      (await t.stageText(droid, { locale: 'en_US', field: 'title', from: 'local', value: 'Acme' }))
        .status,
      200,
      'an underscore locale is accepted as the stores write it',
    );
    assert.equal(
      (
        await t.stageText(droid, {
          locale: 'english please',
          field: 'title',
          from: 'local',
          value: 'x',
        })
      ).body.error,
      'invalid_locale',
    );
    assert.equal(
      (await t.stageText(droid, { locale: 'de-DE', field: 'title', from: 'local', value: '  \n ' }))
        .body.error,
      'empty_text',
    );
    assert.equal(
      (await t.stageText(droid, { locale: 'de-DE', field: 'title', from: 'local' })).body.error,
      'invalid_staged',
    );
    assert.equal(
      (await t.stageText(droid, { locale: 'de-DE', field: 'title', from: 'repo', value: 'x' })).body
        .error,
      'invalid_staged',
      'a value is not taken together with a source',
    );
    const huge = await t.stageText(droid, {
      locale: 'de-DE',
      field: 'full_description',
      from: 'local',
      value: 'x'.repeat(STAGED_LIMITS.maxTextChars + 1),
    });
    assert.equal(huge.status, 422);
    assert.equal(huge.body.error, 'text_too_long');
    assert.equal(
      (
        await t.call(t.owner, 'PUT', t.sp(droid, '/text'), {
          locale: 'en-US',
          field: 'title',
          from: 'local',
          value: 'x',
          extra: 1,
        })
      ).status,
      400,
      'strict body',
    );
    assert.equal((await t.rows(ios)).length, 0);
  },
);

dbTest(
  'the limits of the listing apply to a staged text: too long is an error that blocks, other fields are not "missing"',
  async (db) => {
    const t = await bootStaged(db);
    const droid = await t.addApp('android');
    const res = await t.stageText(droid, {
      locale: 'en-US',
      field: 'title',
      from: 'local',
      value: 'T'.repeat(31),
    });
    assert.equal(
      res.status,
      200,
      'staging an over long text is allowed: the problem is shown, a push is refused',
    );
    const item = res.body.staged.text[0];
    assert.equal(item.status, 'invalid');
    assert.ok(
      item.problems.some(
        (p: { code: string; severity: string; limit: number }) =>
          p.code === 'too_long' && p.severity === 'error' && p.limit === 30,
      ),
      JSON.stringify(item.problems),
    );
    assert.equal(res.body.staged.valid, false);
    assert.ok(res.body.staged.totals.errors >= 1);
    const fixed = await t.stageText(droid, {
      locale: 'en-US',
      field: 'title',
      from: 'local',
      value: 'Acme',
    });
    assert.equal(fixed.body.staged.valid, true);
    assert.ok(
      !fixed.body.staged.text[0].problems.some(
        (p: { code: string }) => p.code === 'missing_required',
      ),
      'only the staged fields are checked',
    );
  },
);

dbTest(
  'a text can be staged from the repository snapshot or the store snapshot that were already stored (no new read)',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    // Nothing stored yet.
    const none = await t.stageText(app, { locale: 'en-US', field: 'title', from: 'repo' });
    assert.equal(none.status, 422);
    assert.equal(none.body.error, 'no_source_value');
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'store' })).body.error,
      'no_source_value',
    );
    // The repository snapshot, and the store snapshot of a sync.
    t.readStores.android.listing = playListing({
      'en-US': {
        title: 'Store title',
        short_description: 'Store short',
        full_description: 'Store full description that is long enough.',
      },
    });
    const synced = await t.call(t.owner, 'POST', `/apps/${app}/sync`);
    assert.equal(synced.status, 200, synced.text);
    assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/listing/repo-refresh`)).status, 200);
    const drift = (await t.call(t.owner, 'GET', `/apps/${app}/listing/drift`)).body;
    const field = drift.locales
      .find((l: { locale: string }) => l.locale === 'en-US')
      .fields.find((f: { field: string }) => f.field === 'title');
    const calls = {
      reads: t.stores.android.reads,
      repo: t.repo.readCalls.length,
      listCalls: t.repo.listCalls,
      store: t.readStores.android.calls.length,
    };

    const fromStore = await t.stageText(app, { locale: 'en-US', field: 'title', from: 'store' });
    assert.equal(fromStore.status, 200, fromStore.text);
    assert.equal(fromStore.body.staged.text[0].value, 'Store title');
    assert.equal(fromStore.body.staged.text[0].source, 'store');
    assert.equal(
      fromStore.body.staged.text[0].status,
      'unchanged',
      'the value is the one stored from the store',
    );
    assert.equal(fromStore.body.staged.text[0].before, 'Store title');
    if (field.repo.value !== null) {
      const fromRepo = await t.stageText(app, { locale: 'en-US', field: 'title', from: 'repo' });
      assert.equal(fromRepo.status, 200, fromRepo.text);
      assert.equal(fromRepo.body.staged.text[0].value, field.repo.value.replace(/\s+$/, ''));
      assert.equal(fromRepo.body.staged.text[0].source, 'repo');
    }
    assert.deepEqual(
      {
        reads: t.stores.android.reads,
        repo: t.repo.readCalls.length,
        listCalls: t.repo.listCalls,
        store: t.readStores.android.calls.length,
      },
      calls,
      'staging read nothing',
    );
    // iOS from the store, too.
    const ios = await t.addApp('ios');
    t.readStores.ios.listing = iosListing({
      'en-US': { name: 'Acme', subtitle: 'Sub', description: 'A description that is long enough.' },
    });
    assert.equal((await t.call(t.owner, 'POST', `/apps/${ios}/sync`)).status, 200);
    const iosStaged = await t.stageText(ios, {
      locale: 'en-US',
      field: 'description',
      from: 'store',
    });
    assert.equal(iosStaged.body.staged.text[0].value, 'A description that is long enough.');
  },
);

// ----- graphics ----------------------------------------------------------------------------------

dbTest(
  'a set of screenshots is staged by reference: path, commit and blob id, in index order; no bytes are kept',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const res = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      from: 'repo',
    });
    assert.equal(res.status, 200, res.text);
    const set = res.body.staged.assets[0];
    assert.equal(set.id, 'en-US/screenshot:iphone_6_5');
    assert.deepEqual(set.slot, { kind: 'screenshot', device: 'iphone_6_5' });
    assert.equal(set.label, 'Screenshots, iPhone 6.5"');
    assert.deepEqual(
      set.files.map((f: { path: string }) => f.path),
      [`${SHOTS}/1_iphone65.png`, `${SHOTS}/2_iphone65.png`],
    );
    assert.deepEqual(
      set.files.map((f: { position: number }) => f.position),
      [0, 1],
    );
    assert.ok(
      set.files.every(
        (f: { commit: string; oid: string; format: string; width: number }) =>
          f.commit === 'd'.repeat(40) &&
          /^[0-9a-f]{40}$/.test(f.oid) &&
          f.format === 'png' &&
          f.width === 1242,
      ),
    );
    assert.equal(set.status, 'changed');
    assert.deepEqual(set.problems, []);
    const rows = await t.rows(app);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.value_text, null, 'no content is kept');
      assert.equal(row.source, 'repo');
      assert.equal(row.kind, 'asset');
    }
    // Only the index was read (headers), never a file in full.
    assert.ok(t.repo.readCalls.every((paths) => paths.length > 0));
  },
);

dbTest(
  'the order of a set can be chosen with paths; re-staging replaces the whole set',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const reversed = [`${SHOTS}/2_iphone65.png`, `${SHOTS}/1_iphone65.png`];
    const res = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: reversed,
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      res.body.staged.assets[0].files.map((f: { path: string }) => f.path),
      reversed,
    );
    const one = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: [reversed[1]],
    });
    assert.equal(one.body.staged.assets[0].files.length, 1);
    assert.equal((await t.rows(app)).length, 1, 'the earlier rows of the set are gone');
    assert.equal(
      (
        await t.stageAssets(app, {
          locale: 'en-US',
          kind: 'screenshot',
          device: 'iphone_6_5',
          paths: [reversed[0], reversed[0]],
        })
      ).body.error,
      'invalid_staged',
      'a path twice',
    );
    const foreign = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: ['package.json'],
    });
    assert.equal(foreign.status, 422);
    assert.equal(
      foreign.body.error,
      'not_in_index',
      'only files the asset index lists can be staged',
    );
    const traversal = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: ['../../etc/passwd'],
    });
    assert.equal(traversal.body.error, 'not_in_index');
  },
);

dbTest('Google Play graphics: icon, feature graphic and screenshots by device', async (db) => {
  const t = await bootStaged(db, {
    files: {
      [`${IMAGES}/icon.png`]: png(512, 512, { alpha: true, seed: 1 }),
      [`${IMAGES}/featureGraphic.png`]: png(1024, 500, { seed: 2 }),
      [`${IMAGES}/phoneScreenshots/1.png`]: png(1080, 1920, { seed: 3 }),
      [`${IMAGES}/phoneScreenshots/2.png`]: png(1080, 1920, { seed: 4 }),
      [`${IMAGES}/tenInchScreenshots/1.png`]: png(1600, 2560, { seed: 5 }),
      'fastlane/metadata/android/en-US/title.txt': 'Acme\n',
    },
  });
  const app = await t.addApp('android');
  for (const [kind, device] of [
    ['icon', null],
    ['feature_graphic', null],
    ['screenshot', 'phone'],
    ['screenshot', 'tablet_10'],
  ] as const) {
    const res = await t.stageAssets(app, { locale: 'en-US', kind, device });
    assert.equal(res.status, 200, `${kind} ${device}: ${res.text}`);
  }
  const view = await t.view(app);
  assert.deepEqual(view.assets.map((a) => a.slotKey).sort(), [
    'feature_graphic',
    'icon',
    'screenshot:phone',
    'screenshot:tablet_10',
  ]);
  assert.equal(view.totals.assetSets, 4);
  assert.equal(view.totals.assetFiles, 5);
  assert.equal(view.assets.find((a) => a.slotKey === 'icon')?.label, 'Store icon');
  assert.equal(view.assets.find((a) => a.slotKey === 'screenshot:phone')?.files.length, 2);
  assert.equal(
    view.assets.find((a) => a.slotKey === 'icon')?.problems.filter((p) => p.severity === 'error')
      .length,
    0,
  );
  assert.equal(view.pushable.textFields.join(), 'title,short_description,full_description,video');
});

dbTest('what cannot be pushed is refused when staging a set, with the reason', async (db) => {
  const t = await bootStaged(db);
  const ios = await t.addApp('ios');
  const droid = await t.addApp('android');
  const cases: [string, Record<string, unknown>, string, RegExp?][] = [
    [
      ios,
      { locale: 'en-US', kind: 'preview', device: 'iphone_6_5' },
      'slot_not_pushable',
      /previews/i,
    ],
    [ios, { locale: 'en-US', kind: 'app_icon' }, 'slot_not_pushable', /icon/i],
    [ios, { locale: 'en-US', kind: 'icon' }, 'slot_not_pushable'],
    [
      ios,
      { locale: 'en-US', kind: 'screenshot', device: 'imessage:ipad_13' },
      'slot_not_pushable',
      /display type/,
    ],
    [ios, { locale: 'en-US', kind: 'screenshot', device: 'watch' }, 'slot_not_pushable'],
    [droid, { locale: 'en-US', kind: 'promo_graphic' }, 'slot_not_pushable', /promo/i],
    [ios, { locale: 'en-US', kind: 'screenshot' }, 'invalid_staged', /device is required/],
    [droid, { locale: 'en-US', kind: 'icon', device: 'phone' }, 'invalid_staged'],
    [
      ios,
      { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5', from: 'store' },
      'source_not_supported',
      /assets\/pull/,
    ],
    [
      ios,
      { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5', from: 'local' },
      'source_not_supported',
    ],
    [
      ios,
      { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5', commit: 'main' },
      'invalid_staged',
      /full commit hash/,
    ],
    [ios, { locale: 'fr-FR', kind: 'screenshot', device: 'iphone_6_5' }, 'no_assets'],
    [ios, { locale: 'en-US', kind: 'screenshot', device: 'ipad_13' }, 'no_assets'],
    [ios, { locale: 'nope nope', kind: 'screenshot', device: 'iphone_6_5' }, 'invalid_locale'],
  ];
  for (const [app, body, error, message] of cases) {
    const res = await t.stageAssets(app, body);
    assert.equal(res.status, 422, `${JSON.stringify(body)}: ${res.text}`);
    assert.equal(res.body.error, error, JSON.stringify(body));
    if (message) assert.match(res.body.message, message);
  }
  assert.equal(
    (
      await t.call(t.owner, 'PUT', t.sp(ios, '/assets'), {
        locale: 'en-US',
        kind: 'banana',
        device: null,
      })
    ).status,
    400,
  );
  assert.equal((await t.rows(ios)).length + (await t.rows(droid)).length, 0);
  // An app with no linked repository has nothing to take files from.
  const lonely = await t.call(t.owner, 'POST', '/apps', {
    platform: 'ios',
    identifier: 'com.acme.lonely',
    credentialId: t.iosCredential,
    name: 'Lonely',
  });
  const none = await t.stageAssets(lonely.body.app.id, {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
  });
  assert.equal(none.status, 422);
  assert.equal(none.body.error, 'no_repository');
});

dbTest(
  'files a push cannot upload are refused: not PNG or JPEG, over the cap, not opened',
  async (db) => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(32),
    ]);
    const t = await bootStaged(db, {
      files: {
        [`${SHOTS}/1_iphone65.png`]: png(...IPHONE_65, { seed: 1 }),
        [`${SHOTS}/2_iphone65.webp`]: webp,
        [`${SHOTS}/3_iphone65.png`]: png(...IPHONE_65, {
          seed: 3,
          pad: STAGED_LIMITS.maxAssetFileBytes + 1,
        }),
        [`${SHOTS}/4_iphone65.jpg`]: jpeg(...IPHONE_65),
        'fastlane/metadata/ios/en-US/description.txt': 'x\n',
      },
    });
    const app = await t.addApp('ios');
    const index = (await t.call(t.owner, 'GET', `/apps/${app}/assets`)).body;
    const listed = index.assets.map((a: { path: string }) => a.path);
    assert.ok(listed.includes(`${SHOTS}/3_iphone65.png`), JSON.stringify(listed));
    const big = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: [`${SHOTS}/3_iphone65.png`],
    });
    assert.equal(big.status, 422, big.text);
    assert.equal(big.body.error, 'asset_not_pushable');
    assert.match(big.body.message, /larger than the 8 MB/);
    if (listed.includes(`${SHOTS}/2_iphone65.webp`)) {
      const odd = await t.stageAssets(app, {
        locale: 'en-US',
        kind: 'screenshot',
        device: 'iphone_6_5',
        paths: [`${SHOTS}/2_iphone65.webp`],
      });
      assert.equal(odd.body.error, 'asset_not_pushable');
    }
    // A JPEG is fine.
    const jpg = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: [`${SHOTS}/4_iphone65.jpg`, `${SHOTS}/1_iphone65.png`],
    });
    assert.equal(jpg.status, 200, jpg.text);
    assert.deepEqual(
      jpg.body.staged.assets[0].files.map((f: { format: string }) => f.format),
      ['jpeg', 'png'],
    );
    // The whole index of the slot includes the oversize file: staging every file refuses it by name.
    const all = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
    });
    assert.equal(all.status, 422);
    assert.equal(all.body.error, 'asset_not_pushable');
    assert.match(all.body.message, /3_iphone65\.png/);
  },
);

dbTest(
  'problems of a staged set: the asset specs, a set over its size, files of two display types',
  async (db) => {
    const t = await bootStaged(db, {
      files: {
        'fastlane/metadata/ios/screenshots/en-US/01.png': png(1290, 2796, { seed: 1 }),
        'fastlane/metadata/ios/screenshots/en-US/02.png': png(1320, 2868, { seed: 2 }),
        ...Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [
            `fastlane/metadata/ios/screenshots/en-US/${String(i + 10)}_iphone65.png`,
            png(...IPHONE_65, { seed: 30 + i }),
          ]),
        ),
        'fastlane/metadata/ios/en-US/description.txt': 'x\n',
      },
    });
    const app = await t.addApp('ios');
    const mixed = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_9',
    });
    assert.equal(mixed.status, 200, mixed.text);
    const set = mixed.body.staged.assets[0];
    assert.equal(set.status, 'invalid');
    assert.ok(
      set.problems.some(
        (p: { code: string; severity: string }) =>
          p.code === 'mixed_display_types' && p.severity === 'error',
      ),
      JSON.stringify(set.problems),
    );
    assert.equal(mixed.body.staged.valid, false);
    // An 11th screenshot for a size that takes 10 is refused when it is staged, with the documented sentence (not found out after a push).
    const big = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
    });
    assert.equal(big.status, 422, big.text);
    assert.equal(big.body.error, 'set_too_large');
    assert.equal(big.body.limit, 10);
    assert.equal(big.body.actual, 11);
    assert.equal(big.body.rule, 'apple.screenshot.count');
    assert.match(
      big.body.message,
      /^At most 10 screenshots per device size\. iPhone .*: 11 would be staged\.$/,
    );
    assert.equal(big.body.code, 'staged.setTooLarge');
    assert.deepEqual(
      [big.body.params.max, big.body.params.count],
      [10, 11],
      JSON.stringify(big.body.params),
    );
    const tenPaths = Array.from(
      { length: 10 },
      (_, i) => `fastlane/metadata/ios/screenshots/en-US/${String(i + 10)}_iphone65.png`,
    );
    const ten = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      paths: tenPaths,
    });
    assert.equal(ten.status, 200, ten.text);
    // Only the single size of the first set stays valid once it is fixed.
    const fixed = await t.stageAssets(app, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_9',
      paths: ['fastlane/metadata/ios/screenshots/en-US/01.png'],
    });
    assert.equal(
      fixed.body.staged.assets.find(
        (a: { slotKey: string }) => a.slotKey === 'screenshot:iphone_6_9',
      ).status,
      'changed',
    );
  },
);

dbTest('caps: at most 100 files and 64 MiB are staged for one push, and 600 items', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  const base = Date.now();
  const insertFiles = async (count: number, bytes: number, locale: string, offset = 0) => {
    for (let i = 0; i < count; i++) {
      await db.execute(
        "INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit, asset_bytes, asset_width, asset_height, asset_format, created_by, created_at, updated_at) VALUES (?, ?, ?, 'ios', 'asset', ?, 'screenshot:ipad_13', ?, 'repo', ?, ?, ?, ?, 2048, 2732, 'png', 'u', ?, ?)",
        [
          `f${locale}${offset + i}`,
          t.workspaceId,
          app,
          locale,
          offset + i,
          `oid${locale}${offset + i}`,
          `p/${offset + i}.png`,
          'd'.repeat(40),
          bytes,
          base,
          base,
        ],
      );
    }
  };
  // 99 files are staged already (other locales and sets); two more make 101.
  await insertFiles(99, 1000, 'de-DE');
  const files = await t.stageAssets(app, {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
  });
  assert.equal(files.status, 422, files.text.slice(0, 300));
  assert.equal(files.body.error, 'too_many_files');
  assert.equal(files.body.limit, STAGED_LIMITS.maxAssetFilesPerPush);
  assert.equal((await t.rows(app)).length, 99, 'nothing of the refused set was kept');
  const one = await t.stageAssets(app, {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
    paths: [`${SHOTS}/1_iphone65.png`],
  });
  assert.equal(one.status, 200, 'exactly 100 files is allowed');
  assert.equal((await t.view(app)).totals.assetFiles, 100);
  // Replacing the set that is already staged is not adding to it.
  assert.equal(
    (
      await t.stageAssets(app, {
        locale: 'en-US',
        kind: 'screenshot',
        device: 'iphone_6_5',
        paths: [`${SHOTS}/2_iphone65.png`],
      })
    ).status,
    200,
  );

  const heavy = t;
  const id = await heavy.addApp('ios');
  for (let i = 0; i < 7; i++) {
    await db.execute(
      "INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit, asset_bytes, created_by, created_at, updated_at) VALUES (?, ?, ?, 'ios', 'asset', 'de-DE', 'screenshot:ipad_13', ?, 'repo', ?, ?, ?, ?, 'u', ?, ?)",
      [
        `h${i}`,
        heavy.workspaceId,
        id,
        i,
        `o${i}`,
        `p/${i}.png`,
        'd'.repeat(40),
        8 * 1024 * 1024 - 1,
        base,
        base,
      ],
    );
  }
  const over = await heavy.stageAssets(id, {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
  });
  assert.equal(over.status, 200, 'the files of the two small screenshots still fit under 64 MiB');
  await db.execute('UPDATE staged_changes SET asset_bytes = ? WHERE app_id = ? AND locale = ?', [
    8 * 1024 * 1024,
    id,
    'de-DE',
  ]);
  await db.execute(
    "INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit, asset_bytes, created_by, created_at, updated_at) VALUES ('h7', ?, ?, 'ios', 'asset', 'de-DE', 'screenshot:ipad_13', 7, 'repo', 'o7', 'p/7.png', ?, ?, 'u', ?, ?)",
    [heavy.workspaceId, id, 'd'.repeat(40), 8 * 1024 * 1024, base, base],
  );
  const tooMuch = await heavy.stageAssets(id, {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
  });
  assert.equal(tooMuch.status, 422, tooMuch.text.slice(0, 300));
  assert.equal(tooMuch.body.error, 'too_many_bytes');

  // The item cap holds for texts, too.
  const many = t;
  const manyApp = await many.addApp('ios');
  for (let i = 0; i < STAGED_LIMITS.maxItems; i++) {
    await db.execute(
      "INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, 'ios', 'listing_text', ?, 'description', 0, 'local', 'x', 'h', 'u', ?, ?)",
      [`r${i}`, many.workspaceId, manyApp, `xx-${String(i).padStart(3, '0')}`, base, base],
    );
  }
  const full = await many.stageText(manyApp, {
    locale: 'en-US',
    field: 'description',
    from: 'local',
    value: 'one too many',
  });
  assert.equal(full.status, 422);
  assert.equal(full.body.error, 'too_many_items');
  assert.equal(
    (
      await many.stageText(manyApp, {
        locale: 'xx-001',
        field: 'description',
        from: 'local',
        value: 'a replacement',
      })
    ).status,
    200,
    'replacing an item is not adding one',
  );
});

// ----- taking items out -------------------------------------------------------------------------------

dbTest(
  'a text (its id) or a set (locale/slot) can be removed, everything can be cleared, and unknown items are 404',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const other = await t.addApp('ios');
    await t.stageText(app, { locale: 'en-US', field: 'description', from: 'local', value: 'One' });
    await t.stageText(app, { locale: 'de-DE', field: 'keywords', from: 'local', value: 'a,b' });
    await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
    await t.stageText(other, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: 'Other app',
    });
    let view = await t.view(app);
    const textId = view.text.find((x) => x.field === 'keywords')?.id ?? '';
    const removedText = await t.unstage(app, textId);
    assert.equal(removedText.status, 200);
    assert.deepEqual(
      removedText.body.staged.text.map((x: { field: string }) => x.field),
      ['description'],
    );
    assert.equal((await t.unstage(app, textId)).status, 404, 'already gone');
    assert.equal((await t.unstage(app, 'nope')).status, 404);
    const removedSet = await t.unstage(app, 'en-US/screenshot:iphone_6_5');
    assert.equal(removedSet.status, 200);
    assert.equal(removedSet.body.staged.assets.length, 0);
    assert.equal((await t.unstage(app, 'en-US/screenshot:iphone_6_5')).status, 404);
    // An item of another app is not reachable through this one.
    const otherId = (await t.view(other)).text[0]?.id ?? '';
    assert.equal((await t.unstage(app, otherId)).status, 404);
    await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
    const cleared = await t.clear(app);
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.body.staged.text.length, cleared.body.staged.assets.length], [0, 0]);
    assert.equal((await t.view(other)).text.length, 1, 'another app is untouched');
    view = await t.view(app);
    assert.equal(view.totals.errors, 0);
    const actions = (await t.audit('staged.%')).map((a) => a.action);
    for (const action of [
      'staged.text_set',
      'staged.assets_set',
      'staged.item_removed',
      'staged.cleared',
    ])
      assert.ok(actions.includes(action), action);
  },
);

dbTest(
  'unstaging a language removes everything staged for it, for this app only, and is idempotent',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const other = await t.addApp('ios');
    for (const a of [app, other]) {
      await t.stageText(a, { locale: 'fr-FR', field: 'description', from: 'local', value: 'Bonjour' });
      await t.stageText(a, { locale: 'en-US', field: 'description', from: 'local', value: 'Hello' });
      await t.stageAssets(a, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
    }
    assert.equal((await t.unstageLocale(app, 'not a locale!')).status, 400);
    const done = await t.unstageLocale(app, 'en-US');
    assert.equal(done.status, 200);
    assert.ok(done.body.removed >= 2, 'its text and its set');
    assert.deepEqual(
      done.body.staged.text.map((x: { locale: string }) => x.locale),
      ['fr-FR'],
    );
    assert.equal(done.body.staged.assets.length, 0);
    const again = await t.unstageLocale(app, 'en-US');
    assert.equal(again.status, 200, 'idempotent');
    assert.equal(again.body.removed, 0);
    const kept = await t.view(other);
    assert.equal(kept.text.length, 2, 'another app is untouched');
    assert.equal(kept.assets.length, 1);
    assert.ok((await t.audit('staged.locale_removed')).length === 1);
  },
);

dbTest('deleting an app removes what was staged for it and its draft claim', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  await t.stageText(app, { locale: 'en-US', field: 'description', from: 'local', value: 'One' });
  await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
  await db.execute(
    "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', 'unknown', 'u', 1)",
    [app, t.workspaceId],
  );
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${app}`)).status, 204);
  assert.deepEqual(await t.rows(app), []);
  assert.equal(await t.claim(app), undefined);
});

// ----- rights, audit ----------------------------------------------------------------------------------

dbTest(
  'rights: staging needs changesets.write, reading the staged view needs listing.read, non-members get 404',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    const body = { locale: 'en-US', field: 'description', from: 'local', value: 'Hi' };
    assert.equal((await t.stageText(app, body, viewer)).status, 403, 'a viewer may not stage');
    assert.equal(
      (
        await t.stageAssets(
          app,
          { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' },
          viewer,
        )
      ).status,
      403,
    );
    assert.equal((await t.unstage(app, 'x', viewer)).status, 403);
    assert.equal((await t.clear(app, viewer)).status, 403);
    assert.equal((await t.call(viewer, 'GET', t.sp(app))).status, 200, 'a viewer reads');
    assert.equal((await t.stageText(app, body, member)).status, 200, 'a member stages');
    assert.equal((await t.stageText(app, { ...body, value: 'Admin' }, admin)).status, 200);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    for (const [method, path, payload] of [
      ['GET', t.sp(app)],
      ['PUT', t.sp(app, '/text'), body],
      ['PUT', t.sp(app, '/assets'), { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' }],
      ['DELETE', t.sp(app, '/items?id=x')],
      ['DELETE', t.sp(app)],
    ] as const) {
      assert.equal(
        (await t.call(outsider, method, path, payload)).status,
        404,
        `${method} ${path}`,
      );
      assert.equal(
        (await t.call(outsider, method, path, payload, 'other')).status,
        404,
        `${method} ${path} (their own workspace)`,
      );
    }
    assert.equal((await t.call(t.owner, 'GET', t.sp('nope'))).status, 404);
    assert.equal((await t.stageText('nope', body)).status, 404);
  },
);

dbTest(
  'audit: staging records ids and hashes, never the text; no event is emitted and no store is contacted',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const secret = 'A very particular promotional sentence nobody else would write';
    await t.stageText(app, {
      locale: 'en-US',
      field: 'promotional_text',
      from: 'local',
      value: secret,
    });
    await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
    const entries = await t.audit('staged.%');
    assert.deepEqual(
      entries.map((e) => e.action),
      ['staged.text_set', 'staged.assets_set'],
    );
    assert.match(String(entries[0]?.detail.valueHash), /^[0-9a-f]{64}$/);
    assert.equal(entries[0]?.detail.field, 'promotional_text');
    assert.equal(entries[1]?.detail.files, 2);
    assert.equal((entries[1]?.detail.oids as string[]).length, 2);
    for (const table of ['audit_events', 'events', 'jobs']) {
      assert.ok(
        !JSON.stringify(await db.query(`SELECT * FROM ${table}`)).includes(secret),
        `${table} holds the text`,
      );
    }
    assert.deepEqual(await t.events(), [], 'staging emits no event');
    assert.equal(t.built.length, 0);
  },
);
