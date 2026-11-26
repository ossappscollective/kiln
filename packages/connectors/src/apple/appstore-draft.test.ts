import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { FakeAppleDraftApi, md5Of, sha256 } from '../store-draft.fixtures.ts';
import {
  type DraftApplyInput,
  type DraftProgress,
  DraftDriftError,
  type DraftFile,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftSlot,
  sameDraftState,
} from '../store-draft-types.ts';
import { AppleDraftConnector } from './appstore-draft.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();
const APP = '10746822401';
const SLOT: DraftSlot = {
  locale: 'en-US',
  kind: 'screenshot',
  device: 'iphone_6_5',
  target: 'APP_IPHONE_65',
  width: 1242,
  height: 2688,
};
const GROUP = 'IPHONE_65_PROFILE';

const file = (name: string, seed: number, size = 11): DraftFile => {
  const bytes = new Uint8Array(size).map((_, i) => (seed + i) % 251);
  return { name, mime: 'image/png', bytes, md5: md5Of(bytes), sha256: sha256(bytes) };
};
const accept = () => true;

function setup(
  configure?: (api: FakeAppleDraftApi) => void,
  extra: Partial<ConstructorParameters<typeof AppleDraftConnector>[0]> = {},
) {
  const api = new FakeAppleDraftApi();
  configure?.(api);
  const connector = new AppleDraftConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
    ...extra,
  });
  return { api, connector };
}
const input = (over: Partial<DraftApplyInput> = {}): DraftApplyInput => ({
  text: [],
  assets: [],
  guard: accept,
  ...over,
});
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''} ${JSON.stringify((error as StoreError).details ?? [])}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
  assert.ok(!text.includes('blobstore.apple.com'), 'no upload URL');
}

/** Never anything that would submit, release or create a version. */
function assertNeverSubmits(api: FakeAppleDraftApi) {
  for (const s of api.seen) {
    assert.ok(
      !/submission|appStoreVersionSubmissions|reviewSubmission|phasedRelease|releaseRequest/i.test(
        s.path,
      ),
      `unexpected ${s.method} ${s.path}`,
    );
    // The deprecated set based resources are never used.
    assert.ok(!/appScreenshot/.test(s.path), `deprecated resource ${s.method} ${s.path}`);
    if (s.method === 'POST') {
      assert.ok(
        [
          '/v1/appStoreVersionLocalizations',
          '/v1/appAssetLibraryImages',
          '/v1/appAssetLibraryPlacements',
          '/v1/appAssetLibraryPlacementOrderingRequests',
        ].includes(s.path),
        `unexpected POST ${s.path}`,
      );
    }
  }
}

test('readDraft finds the one editable version and reports text and placements without writing', async () => {
  const { api, connector } = setup((a) => {
    a.addPlacements('loc-en', GROUP, [
      { name: 'one.png', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'two.png', bytes: new Uint8Array([4, 5, 6]), reference: false },
    ]);
  });
  const state = await connector.readDraft({
    text: [
      { locale: 'en-US', field: 'description' },
      { locale: 'en-US', field: 'release_notes' },
      { locale: 'de-DE', field: 'description' },
    ],
    assets: [
      SLOT,
      { ...SLOT, device: 'iphone_6_9', target: 'APP_IPHONE_67', width: 1290, height: 2796 },
      { ...SLOT, locale: 'de-DE' },
    ],
  });
  assert.equal(state.store, 'appstoreconnect');
  assert.deepEqual(state.version, {
    id: 'v-next',
    versionString: '2.1',
    state: 'PREPARE_FOR_SUBMISSION',
  });
  assert.deepEqual(state.text, [
    { locale: 'en-US', field: 'description', value: 'Old description', localeExists: true },
    { locale: 'en-US', field: 'release_notes', value: 'Old news', localeExists: true },
    { locale: 'de-DE', field: 'description', value: null, localeExists: false },
  ]);
  assert.equal(state.assets[0]?.setExists, true);
  assert.equal(state.assets[0]?.placementGroup, GROUP);
  // The placement id is the id of an item of the set; the checksum is what this server wrote into the reference name.
  assert.deepEqual(
    state.assets[0]?.images.map((i) => [i.name, i.checksum, i.checksumKind, i.state]),
    [
      [
        'one.png',
        sha256(new Uint8Array([1, 2, 3])).slice(0, 32),
        'sha256',
        'PREPARE_FOR_SUBMISSION',
      ],
      ['two.png', null, 'sha256', 'PREPARE_FOR_SUBMISSION'],
    ],
  );
  assert.ok(state.assets[0]?.images.every((i) => i.id.startsWith('pl-')));
  assert.equal(state.assets[1]?.setExists, false);
  assert.equal(state.assets[1]?.placementGroup, 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE');
  assert.equal(state.assets[2]?.setExists, false);
  assert.deepEqual(api.writes(), []);
  // The old resources are not read either.
  assert.ok(api.seen.every((s) => !/appScreenshot/.test(s.path)));
  const placements = api.seen.find((s) => /\/placements$/.test(s.path));
  assert.match(placements?.query ?? '', /filter\[placementType\]=APP_SCREENSHOT/);
  assert.match(placements?.query ?? '', /sort=placementGroupPosition/);
  assert.match(placements?.query ?? '', /include=image/);
});

test('the live version is never the one written to: no editable version is its own error', async () => {
  const { connector } = setup((a) => {
    a.versions = [
      { id: 'v-live', versionString: '2.0', state: 'READY_FOR_DISTRIBUTION' },
      { id: 'v-rev', versionString: '2.1', state: 'WAITING_FOR_REVIEW' },
    ];
  });
  await assert.rejects(
    connector.readDraft({ text: [], assets: [] }),
    (e: unknown) => e instanceof StoreError && e.kind === 'no_editable_version',
  );
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })),
    (e: unknown) => e instanceof StoreError && e.kind === 'no_editable_version',
  );
});

test('two editable versions are refused rather than guessed', async () => {
  const { connector } = setup((a) => {
    a.versions.push({ id: 'v-other', versionString: '2.2', state: 'PREPARE_FOR_SUBMISSION' });
  });
  await assert.rejects(
    connector.readDraft({ text: [], assets: [] }),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
});

test('text: only the changed attributes are sent, in one PATCH per locale, and nothing is submitted', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({
      text: [
        { locale: 'en-US', field: 'description', value: 'New description' },
        { locale: 'en-US', field: 'keywords', value: 'old' },
        { locale: 'en-US', field: 'release_notes', value: 'New news' },
      ],
    }),
  );
  assert.equal(result.commit, 'none');
  assert.deepEqual(
    result.steps.map((s) => [s.target, s.outcome]),
    [
      ['description', 'applied'],
      ['keywords', 'already_same'],
      ['release_notes', 'applied'],
    ],
  );
  assert.deepEqual(api.writes(), ['PATCH /v1/appStoreVersionLocalizations/loc-en']);
  const patch = api.seen.find((s) => s.method === 'PATCH');
  assert.deepEqual(patch?.body, {
    data: {
      type: 'appStoreVersionLocalizations',
      id: 'loc-en',
      attributes: { description: 'New description', whatsNew: 'New news' },
    },
  });
  assert.equal(api.locs.get('loc-en')?.attributes.description, 'New description');
  assertNeverSubmits(api);
});

test('a text that already matches sends nothing at all', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({ text: [{ locale: 'en-US', field: 'description', value: 'Old description' }] }),
  );
  assert.deepEqual(result.steps, [
    { type: 'text', locale: 'en-US', target: 'description', outcome: 'already_same' },
  ]);
  assert.deepEqual(api.writes(), []);
});

test('a locale the draft does not have is created on the editable version', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({ text: [{ locale: 'de-DE', field: 'description', value: 'Neu' }] }),
  );
  assert.deepEqual(
    result.steps.map((s) => [s.type, s.locale, s.target]),
    [
      ['locale', 'de-DE', 'locale'],
      ['text', 'de-DE', 'description'],
    ],
  );
  assert.deepEqual(api.writes(), ['POST /v1/appStoreVersionLocalizations']);
  const post = api.seen.find((s) => s.method === 'POST');
  assert.deepEqual(post?.body, {
    data: {
      type: 'appStoreVersionLocalizations',
      attributes: { locale: 'de-DE', description: 'Neu' },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-next' } } },
    },
  });
  assertNeverSubmits(api);
});

test('screenshots: library, reserve, upload every part without the JWT, commit with uploaded alone, wait, place', async () => {
  // One file at a time, so the order of the requests is the one this test reads.
  const { api, connector } = setup(undefined, { uploadConcurrency: 1 });
  const a = file('01.png', 1, 11);
  const b = file('02.png', 50, 20);
  const result = await connector.applyDraft(input({ assets: [{ ...SLOT, files: [a, b] }] }));
  assert.deepEqual(result.steps, [
    {
      type: 'asset',
      locale: 'en-US',
      target: 'APP_IPHONE_65',
      outcome: 'applied',
      uploaded: 2,
      removed: 0,
    },
  ]);
  assert.equal(result.commit, 'none');

  const order = api.writes().map((w) => w.replace(/(img|pl)-\d+/g, '$1'));
  assert.deepEqual(order, [
    'POST /v1/appAssetLibraryImages',
    'PUT store-030.blobstore.apple.com/up/img',
    'PUT store-030.blobstore.apple.com/up/img',
    'PATCH /v1/appAssetLibraryImages/img',
    'POST /v1/appAssetLibraryImages',
    'PUT store-030.blobstore.apple.com/up/img',
    'PUT store-030.blobstore.apple.com/up/img',
    'PATCH /v1/appAssetLibraryImages/img',
    'POST /v1/appAssetLibraryPlacements',
    'POST /v1/appAssetLibraryPlacements',
  ]);
  // The reservation names the library, the category and the hash; the placement names the group.
  const reserve = api.seen.find(
    (s) => s.method === 'POST' && s.path === '/v1/appAssetLibraryImages',
  );
  assert.deepEqual(reserve?.body, {
    data: {
      type: 'appAssetLibraryImages',
      attributes: {
        fileName: '01.png',
        fileSize: 11,
        category: 'APP_SCREENSHOTS_AND_PREVIEWS',
        referenceName: `kiln:sha256:${a.sha256.slice(0, 32)}`,
      },
      relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: '10746822401' } } },
    },
  });
  const placing = api.seen.filter(
    (s) => s.method === 'POST' && s.path === '/v1/appAssetLibraryPlacements',
  );
  assert.deepEqual(
    (
      placing[0]?.body as {
        data: { attributes: unknown; relationships: { appStoreVersionLocalization: unknown } };
      }
    ).data.attributes,
    { placementType: 'APP_SCREENSHOT', placementGroup: GROUP },
  );
  assert.deepEqual(
    (placing[0]?.body as { data: { relationships: { appStoreVersionLocalization: unknown } } }).data
      .relationships.appStoreVersionLocalization,
    { data: { type: 'appStoreVersionLocalizations', id: 'loc-en' } },
  );
  // The parts are the byte ranges Apple asked for, with Apple's own headers, and carry no credential.
  const puts = api.seen.filter((s) => s.method === 'PUT');
  assert.equal(puts.length, 4);
  for (const p of puts) {
    assert.equal(p.headers.get('authorization'), null);
    assert.equal(p.headers.get('content-type'), 'image/png');
    assert.ok(p.headers.get('x-apple-part'));
  }
  const sent = new Uint8Array([...(puts[0]?.bytes ?? []), ...(puts[1]?.bytes ?? [])]);
  assert.deepEqual([...sent], [...a.bytes]);
  // The commit is `uploaded` alone: there is no checksum in the asset library.
  const commits = api.seen.filter(
    (s) => s.method === 'PATCH' && /appAssetLibraryImages\//.test(s.path),
  );
  assert.deepEqual((commits[0]?.body as { data: { attributes: unknown } }).data.attributes, {
    uploaded: true,
  });
  assert.deepEqual(api.groupFiles('loc-en', GROUP), ['01.png', '02.png']);
  // New placements are appended in order, so no ordering request is needed.
  assert.ok(!order.includes('POST /v1/appAssetLibraryPlacementOrderingRequests'));
  // The JWT only went to Apple's API.
  for (const s of api.seen)
    assert.equal(
      s.headers.get('authorization')?.startsWith('Bearer ') ?? false,
      s.host === 'api.appstoreconnect.apple.com',
    );
  assertNeverSubmits(api);
  // Read back as the next preview would: the same files, in order, are "the same".
  const state = await connector.readDraft({ text: [], assets: [SLOT] });
  assert.ok(setMatchesFiles(state.assets[0]?.images ?? [], [a, b]));
});

const setMatchesFiles = (
  images: { checksum: string | null; state: string | null }[],
  files: DraftFile[],
) =>
  images.length === files.length &&
  images.every(
    (i, n) =>
      i.checksum === (files[n] as DraftFile).sha256.slice(0, 32) &&
      i.state === 'PREPARE_FOR_SUBMISSION',
  );

test('a set that already holds exactly these files in this order is left alone (a repeated push adds nothing)', async () => {
  const { api, connector } = setup();
  const a = file('01.png', 1);
  const b = file('02.png', 9);
  const write = { ...SLOT, files: [a, b] };
  await connector.applyDraft(input({ assets: [write] }));
  const before = api.seen.length;
  const again = await connector.applyDraft(input({ assets: [write] }));
  assert.equal(again.steps[0]?.outcome, 'already_same');
  assert.deepEqual(
    api.seen.slice(before).filter((s) => s.method !== 'GET'),
    [],
  );
  assert.equal(api.images.size, 2);
  assert.equal(api.placements.size, 2);
});

test('replacing a set uploads the new files first, then places them, deletes the old PLACEMENTS and keeps the library images', async () => {
  const { api, connector } = setup((a) => {
    a.addPlacements('loc-en', GROUP, [
      { name: 'old1.png', bytes: new Uint8Array([9, 9, 9]) },
      { name: 'old2.png', bytes: new Uint8Array([8, 8, 8]), reference: false },
    ]);
  });
  const n = file('new.png', 3);
  const result = await connector.applyDraft(input({ assets: [{ ...SLOT, files: [n] }] }));
  assert.deepEqual(result.steps[0], {
    type: 'asset',
    locale: 'en-US',
    target: 'APP_IPHONE_65',
    outcome: 'applied',
    uploaded: 1,
    removed: 2,
  });
  const order = api.writes().map((w) => w.replace(/(img|pl)-\d+/g, '$1'));
  const lastCommit = order
    .map((w, i) => (w.startsWith('PATCH /v1/appAssetLibraryImages/') ? i : -1))
    .reduce((x, y) => Math.max(x, y), -1);
  const firstDelete = order.findIndex((w) => w.startsWith('DELETE'));
  const placed = order.indexOf('POST /v1/appAssetLibraryPlacements');
  assert.ok(
    lastCommit < placed && placed < firstDelete,
    'upload, then the new placement, then the deletes',
  );
  assert.deepEqual(api.groupFiles('loc-en', GROUP), ['new.png']);
  assert.equal(api.placements.size, 1);
  // Only placements were deleted: an image of the library may be used elsewhere.
  assert.ok(order.every((w) => !w.startsWith('DELETE /v1/appAssetLibraryImages')));
  assert.equal(api.images.size, 3, 'the two old images stay in the library');
});

test('the same files in a new order: no upload, one ordering request that names every placement', async () => {
  const one = new Uint8Array([1, 1, 1]);
  const two = new Uint8Array([2, 2, 2]);
  const { api, connector } = setup((a) =>
    a.addPlacements('loc-en', GROUP, [
      { name: 'one.png', bytes: one },
      { name: 'two.png', bytes: two },
    ]),
  );
  const [first, second] = [...api.placements.keys()];
  const wrap = (name: string, bytes: Uint8Array): DraftFile => ({
    name,
    mime: 'image/png',
    bytes,
    md5: md5Of(bytes),
    sha256: sha256(bytes),
  });
  const result = await connector.applyDraft(
    input({ assets: [{ ...SLOT, files: [wrap('two.png', two), wrap('one.png', one)] }] }),
  );
  assert.deepEqual(result.steps[0], {
    type: 'asset',
    locale: 'en-US',
    target: 'APP_IPHONE_65',
    outcome: 'applied',
    uploaded: 0,
    removed: 0,
  });
  assert.deepEqual(api.writes(), ['POST /v1/appAssetLibraryPlacementOrderingRequests']);
  const body = api.seen.find((s) => s.method === 'POST')?.body as {
    data: { attributes: unknown; relationships: { orderedPlacements: { data: { id: string }[] } } };
  };
  assert.deepEqual(body.data.attributes, { placementGroup: GROUP });
  assert.deepEqual(
    body.data.relationships.orderedPlacements.data.map((d) => d.id),
    [second, first],
  );
  assert.deepEqual(api.groupFiles('loc-en', GROUP), ['two.png', 'one.png']);
});

test('a placement that already shows a wanted file is kept: no upload, no new placement, only the order is set', async () => {
  const keep = new Uint8Array([7, 7, 7, 7]);
  const { api, connector } = setup((a) =>
    a.addPlacements('loc-en', GROUP, [
      { name: 'a.png', bytes: new Uint8Array([1, 1]) },
      { name: 'keep.png', bytes: keep },
    ]),
  );
  const [first, second] = [...api.placements.keys()];
  const result = await connector.applyDraft(
    input({
      assets: [
        {
          ...SLOT,
          files: [
            {
              name: 'keep.png',
              mime: 'image/png',
              bytes: keep,
              md5: md5Of(keep),
              sha256: sha256(keep),
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(result.steps[0], {
    type: 'asset',
    locale: 'en-US',
    target: 'APP_IPHONE_65',
    outcome: 'applied',
    uploaded: 0,
    removed: 1,
  });
  assert.deepEqual(
    api.writes(),
    [`DELETE /v1/appAssetLibraryPlacements/${first}`],
    'the kept placement is not touched and one is already in place',
  );
  assert.deepEqual([...api.placements.keys()], [second]);
});

test('an image that already is in the library (found by its reference name) is placed without uploading again', async () => {
  const bytes = new Uint8Array([4, 4, 4, 4, 4]);
  const { api, connector } = setup((a) => {
    // Uploaded by an earlier, interrupted push: processed, not placed anywhere.
    a.addPlacements('loc-en', 'SOMEWHERE_ELSE', [{ name: 'again.png', bytes }]);
    for (const [id] of a.placements) a.placements.delete(id);
    a.order.clear();
    a.defaultSpec = 'spec-65';
  });
  const result = await connector.applyDraft(
    input({
      assets: [
        {
          ...SLOT,
          files: [
            {
              name: 'again.png',
              mime: 'image/png',
              bytes,
              md5: md5Of(bytes),
              sha256: sha256(bytes),
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(result.steps[0], {
    type: 'asset',
    locale: 'en-US',
    target: 'APP_IPHONE_65',
    outcome: 'applied',
    uploaded: 0,
    removed: 0,
  });
  assert.deepEqual(
    api.writes().map((w) => w.replace(/(img|pl)-\d+/g, '$1')),
    ['POST /v1/appAssetLibraryPlacements'],
  );
  assert.equal(api.images.size, 1);
  assert.equal(
    api.seen.some((s) => s.method === 'POST' && s.path === '/v1/appAssetLibraryImages'),
    false,
    'nothing was uploaded',
  );
});

test('a group with no room for both gets its old placements removed first', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    name: `o${i}.png`,
    bytes: new Uint8Array([i + 1, 2, 3]),
  }));
  const { api, connector } = setup((a) => a.addPlacements('loc-en', GROUP, many));
  await connector.applyDraft(
    input({ assets: [{ ...SLOT, files: [file('a.png', 1), file('b.png', 2), file('c.png', 3)] }] }),
  );
  const order = api.writes();
  const firstPlacement = order.findIndex((w) => w.startsWith('POST /v1/appAssetLibraryPlacements'));
  assert.equal(
    order
      .slice(0, firstPlacement)
      .filter((w) => w.startsWith('DELETE /v1/appAssetLibraryPlacements')).length,
    8,
  );
  assert.deepEqual(api.groupFiles('loc-en', GROUP), ['a.png', 'b.png', 'c.png']);
});

test('a screenshot for a locale the draft lacks creates the locale first', async () => {
  const { api, connector } = setup();
  const result = await connector.applyDraft(
    input({ assets: [{ ...SLOT, locale: 'fr-FR', files: [file('f.png', 4)] }] }),
  );
  assert.deepEqual(
    result.steps.map((s) => s.type),
    ['locale', 'asset'],
  );
  assert.ok(api.writes().includes('POST /v1/appStoreVersionLocalizations'));
  assert.ok(
    api.writes().indexOf('POST /v1/appStoreVersionLocalizations') <
      api.writes().indexOf('POST /v1/appAssetLibraryPlacements'),
  );
});

test('the placement group comes from the reference data and the size, never a guess', async () => {
  const { api, connector } = setup();
  // A size with no group.
  await assert.rejects(
    connector.readDraft({ text: [], assets: [{ ...SLOT, width: 100, height: 100 }] }),
    (e: unknown) =>
      e instanceof StoreError && e.kind === 'invalid_input' && /100x100/.test(e.message),
  );
  // No size known.
  await assert.rejects(
    connector.readDraft({ text: [], assets: [{ ...SLOT, width: null, height: null }] }),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  // Two groups of the same family take this size: not guessed, and nothing is written.
  const ipad: DraftSlot = {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'ipad_13',
    target: 'APP_IPAD_PRO_3GEN_129',
    width: 2064,
    height: 2752,
  };
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...ipad, files: [file('i.png', 1)] }] })),
    (e: unknown) => e instanceof StoreError && /will not guess/.test(e.message),
  );
  assert.deepEqual(api.writes(), []);
  // A new device family appears in the reference data: it is picked up without a code change.
  api.refData.placementProfileGroups.push({
    placementProfileGroupId: 'IPHONE_NEW_PROFILE',
    platform: 'IPHONE_APP_STORE',
    displayClassId: 'IPHONE_NEW_DISPLAY',
  });
  api.refData.imageSpecs.push({
    ...(api.refData.imageSpecs[0] as (typeof api.refData.imageSpecs)[number]),
    specId: 'spec-new',
    dimensions: { minWidth: 1320, maxWidth: 1320, minHeight: 2868, maxHeight: 2868 },
  });
  api.refData.placementTypes[0]?.specMappings.push({
    placementGroupId: 'IPHONE_NEW_PROFILE',
    specs: ['spec-new'],
  });
  const fresh = new AppleDraftConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: APP,
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  const state = await fresh.readDraft({
    text: [],
    assets: [{ ...SLOT, device: 'iphone_6_9', target: 'APP_IPHONE_69', width: 1320, height: 2868 }],
  });
  assert.equal(state.assets[0]?.placementGroup, 'IPHONE_NEW_PROFILE');
});

test('the reference data is read once per connector', async () => {
  const { api, connector } = setup();
  await connector.readDraft({ text: [], assets: [SLOT] });
  await connector.readDraft({ text: [], assets: [SLOT] });
  assert.equal(api.seen.filter((s) => s.path === '/v1/appAssetLibraryRefData').length, 1);
});

test('the guard sees the freshest read and a refusal writes nothing', async () => {
  const { api, connector } = setup();
  let seenState: unknown;
  await assert.rejects(
    connector.applyDraft(
      input({
        text: [{ locale: 'en-US', field: 'description', value: 'x' }],
        guard: (current) => {
          seenState = current;
          return false;
        },
      }),
    ),
    (e: unknown) => e instanceof DraftDriftError && e.current.version?.id === 'v-next',
  );
  assert.ok(seenState);
  assert.deepEqual(api.writes(), []);
});

test('sameDraftState ignores the order of the request and sees a changed text', async () => {
  const { api, connector } = setup();
  const request = {
    text: [
      { locale: 'en-US', field: 'description' },
      { locale: 'en-US', field: 'keywords' },
    ],
    assets: [],
  };
  const first = await connector.readDraft(request);
  const second = await connector.readDraft({ ...request, text: [...request.text].reverse() });
  assert.ok(sameDraftState(first, second));
  const loc = api.locs.get('loc-en');
  if (loc) loc.attributes.description = 'Someone edited this in App Store Connect';
  assert.ok(!sameDraftState(first, await connector.readDraft(request)));
});

test('a refusal before anything was applied is the plain store error', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PATCH'
        ? reply(409, {
            errors: [
              {
                status: '409',
                code: 'STATE_ERROR',
                title: 'Not editable',
                detail: 'The version is not editable.',
              },
            ],
          })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.ok(!(e instanceof DraftPartialError));
      assertNoSecrets(e);
      return true;
    },
  );
});

test('a refusal after a step was applied is a DraftPartialError that lists what was written', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'POST' && s.path === '/v1/appAssetLibraryImages'
        ? reply(422, { errors: [{ status: '422', code: 'ENTITY_ERROR', title: 'Bad image' }] })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(
      input({
        text: [{ locale: 'en-US', field: 'description', value: 'New' }],
        assets: [{ ...SLOT, files: [file('a.png', 1)] }],
      }),
    ),
    (e: unknown) => {
      assert.ok(e instanceof DraftPartialError);
      assert.deepEqual(
        e.completed.map((s) => [s.type, s.target, s.outcome]),
        [['text', 'description', 'applied']],
      );
      assert.deepEqual(e.failed, { type: 'asset', locale: 'en-US', target: 'APP_IPHONE_65' });
      assertNoSecrets(e);
      return true;
    },
  );
  assert.equal(api.locs.get('loc-en')?.attributes.description, 'New');
});

test('a 5xx or a cut connection on a write is an unknown outcome and is never retried', async () => {
  for (const mode of ['5xx', 'cut'] as const) {
    const { api, connector } = setup((a) => {
      a.hook = (s) => {
        if (s.method !== 'PATCH') return undefined;
        return mode === '5xx'
          ? reply(503, { errors: [{ status: '503', code: 'UNAVAILABLE', title: 'x' }] })
          : new TypeError('socket hang up');
      };
    });
    await assert.rejects(
      connector.applyDraft(
        input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] }),
      ),
      (e: unknown) => {
        assert.ok(e instanceof DraftOutcomeUnknownError, mode);
        assertNoSecrets(e);
        return true;
      },
    );
    assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 1, `${mode}: one attempt`);
  }
});

test('a 429 on a write is not waited out or retried', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PATCH'
        ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })),
    (e: unknown) => e instanceof StoreError && e.kind === 'rate_limited',
  );
  assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 1);
});

test('an unknown outcome part way keeps the steps that finished', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'POST' && s.path === '/v1/appAssetLibraryImages' ? reply(502) : undefined;
  });
  await assert.rejects(
    connector.applyDraft(
      input({
        text: [{ locale: 'en-US', field: 'description', value: 'New' }],
        assets: [{ ...SLOT, files: [file('a.png', 1)] }],
      }),
    ),
    (e: unknown) =>
      e instanceof DraftOutcomeUnknownError &&
      e.completed.length === 1 &&
      e.completed[0]?.target === 'description',
  );
});

test('an image Apple fails to process is removed again and reported without secrets', async () => {
  const { api, connector } = setup((a) => a.failProcessing.add('bad.png'));
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('bad.png', 1)] }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, 'invalid_input');
      assert.match(e.message, /bad\.png/);
      assert.match(e.message, /not acceptable/);
      assertNoSecrets(e);
      return true;
    },
  );
  assert.equal(api.images.size, 0, 'the failed image has no placement and was deleted');
  assert.equal(api.placements.size, 0);
});

test('a file Apple matches to a specification the group does not take is removed and nothing is placed', async () => {
  const { api, connector } = setup((a) => a.specByFile.set('wrong.png', 'spec-67'));
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('wrong.png', 1)] }] })),
    (e: unknown) =>
      e instanceof StoreError && e.kind === 'invalid_input' && /specification/.test(e.message),
  );
  assert.equal(api.images.size, 0);
  assert.equal(api.placements.size, 0);
});

test('processing that never finishes stops after the polls, and the error says so', async () => {
  const { connector } = setup((a) => {
    a.pollsBeforeComplete = 1000;
  });
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('slow.png', 1)] }] })),
    /had not finished processing slow\.png/,
  );
});

test("an upload address that is not Apple's is never used", async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) => {
      if (s.method === 'POST' && s.path === '/v1/appAssetLibraryImages') {
        return reply(201, {
          data: {
            type: 'appAssetLibraryImages',
            id: 'img-x',
            attributes: {
              uploadOperations: [
                {
                  method: 'PUT',
                  url: 'https://evil.example.com/steal',
                  offset: 0,
                  length: 11,
                  requestHeaders: [],
                },
              ],
            },
          },
        });
      }
      return undefined;
    };
  });
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('a.png', 1)] }] })),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes('evil.example.com'));
      return true;
    },
  );
  assert.equal(api.seen.filter((s) => s.host === 'evil.example.com').length, 0);
});

test('a failed upload part is a refusal that names no address, and nothing is committed', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PUT' ? reply(403, { message: 'Request has expired' }) : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('a.png', 1)] }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assertNoSecrets(e);
      return true;
    },
  );
  assert.equal(api.seen.filter((s) => s.method === 'PATCH').length, 0);
});

test('an 401 or 403 message never carries the key', async () => {
  const { connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'PATCH'
        ? reply(403, {
            errors: [
              {
                status: '403',
                code: 'FORBIDDEN_ERROR',
                title: 'Forbidden',
                detail: `no ${key.privateKey}`,
              },
            ],
          })
        : undefined;
  });
  await assert.rejects(
    connector.applyDraft(input({ text: [{ locale: 'en-US', field: 'description', value: 'x' }] })),
    (e: unknown) => {
      assert.ok(e instanceof StoreError && e.kind === 'forbidden');
      assertNoSecrets(e);
      return true;
    },
  );
});

test('a paging link to another host is not followed with the token', async () => {
  const { api, connector } = setup((a) => {
    a.hook = (s) =>
      s.method === 'GET' && s.path.endsWith('/appStoreVersions')
        ? reply(200, { data: [], links: { next: 'https://evil.example.com/next' } })
        : undefined;
  });
  await assert.rejects(
    connector.readDraft({ text: [], assets: [] }),
    (e: unknown) => e instanceof StoreError && e.kind === 'unexpected',
  );
  assert.equal(api.seen.filter((s) => s.host === 'evil.example.com').length, 0);
});

test('a bad App Store id is refused when the connector is built', () => {
  assert.throws(
    () =>
      new AppleDraftConnector({
        credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
        appStoreId: '12; DROP',
      }),
    /not a number/,
  );
});

test('files of one set are uploaded a few at a time, and the placements keep the wanted order', async () => {
  const { api, connector } = setup();
  const files = [1, 2, 3, 4, 5].map((n) => file(`0${n}.png`, n * 20, 11 + n));
  const result = await connector.applyDraft(input({ assets: [{ ...SLOT, files }] }));
  assert.equal((result.steps[0] as { uploaded?: number }).uploaded, 5);
  assert.deepEqual(api.groupFiles('loc-en', GROUP), ['01.png', '02.png', '03.png', '04.png', '05.png']);
  // The first three reservations are made before the first commit: they overlap.
  const writes = api.writes().map((w) => w.replace(/(img|pl)-\d+/g, '$1'));
  const firstCommit = writes.indexOf('PATCH /v1/appAssetLibraryImages/img');
  assert.ok(
    writes.slice(0, firstCommit).filter((w) => w === 'POST /v1/appAssetLibraryImages').length >= 2,
  );
});

test('progress: the push says which phase it is in and how many files are through', async () => {
  const seen: DraftProgress[] = [];
  const { connector } = setup();
  await connector.applyDraft(
    input({
      text: [{ locale: 'en-US', field: 'description', value: 'New description' }],
      assets: [{ ...SLOT, files: [file('01.png', 1), file('02.png', 50, 20)] }],
      progress: (p) => seen.push({ ...p }),
    }),
  );
  assert.deepEqual(seen[0], { phase: 'writing_texts', done: 0, total: 1 });
  const phases = new Set(seen.map((p) => p.phase));
  for (const phase of ['uploading_images', 'processing_images', 'placing_images'])
    assert.ok(phases.has(phase as DraftProgress['phase']), phase);
  const placing = seen.find((p) => p.phase === 'placing_images');
  assert.deepEqual(placing, { phase: 'placing_images', done: 2, total: 2 });
  for (const p of seen) assert.equal(Object.keys(p).sort().join(), 'done,phase,total');
});

test('a progress callback that throws never changes the push', async () => {
  const { api, connector } = setup();
  await connector.applyDraft(
    input({
      assets: [{ ...SLOT, files: [file('01.png', 1)] }],
      progress: () => {
        throw new Error('boom');
      },
    }),
  );
  assert.deepEqual(api.groupFiles('loc-en', GROUP), ['01.png']);
});

test('processing that never finishes: bounded polls, a coded error, and the image is kept for the next push', async () => {
  const sleeps: number[] = [];
  const { api, connector } = setup(
    (a) => {
      a.pollsBeforeComplete = 100_000;
    },
    { maxPolls: 4, pollIntervalMs: 500, sleep: async (ms) => void sleeps.push(ms) },
  );
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('slow.png', 1)] }] })),
    (e: unknown) =>
      e instanceof StoreError &&
      e.kind === 'server' &&
      e.code === 'store.apple.processingSlow' &&
      e.params?.checks === 4 &&
      /push again to use it/.test(e.message),
  );
  assert.deepEqual(sleeps, [500, 500, 500, 500], 'one wait per check, never more');
  const checks = api.seen.filter((s) => s.method === 'GET' && /appAssetLibraryImages\/img/.test(s.path));
  assert.equal(checks.length, 4);
  assert.equal(api.placements.size, 0, 'nothing was placed');
  assert.equal(api.images.size, 1, 'the uploaded file stays in the library, never discarded');
});

test('a poll answered with a long 429 is reported, not slept for an hour', async () => {
  const sleeps: number[] = [];
  const { connector } = setup(
    (a) => {
      a.hook = (s) =>
        s.method === 'GET' && /appAssetLibraryImages\/img-/.test(s.path)
          ? new Response('{}', { status: 429, headers: { 'retry-after': '3600' } })
          : undefined;
    },
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  await assert.rejects(
    connector.applyDraft(input({ assets: [{ ...SLOT, files: [file('01.png', 1)] }] })),
    (e: unknown) => e instanceof StoreError && e.kind === 'rate_limited',
  );
  assert.ok(
    sleeps.every((ms) => ms <= 10_000),
    `waited ${sleeps.join()}`,
  );
});

test('a paging list that never ends is read up to maxPages and no further', async () => {
  let pages = 0;
  const { connector } = setup(
    (a) => {
      a.hook = (s) => {
        if (s.method === 'GET' && s.path.endsWith('/appStoreVersions')) {
          pages++;
          return reply(200, {
            data: [],
            links: { next: `https://api.appstoreconnect.apple.com${s.path}?cursor=${pages}` },
          });
        }
        return undefined;
      };
    },
    { maxPages: 3 },
  );
  await assert.rejects(connector.readDraft({ text: [], assets: [] }), StoreError);
  assert.equal(pages, 3);
});
