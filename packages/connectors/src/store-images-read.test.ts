import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppleDraftConnector } from './apple/appstore-draft.ts';
import { StoreError } from './errors.ts';
import { PlayDraftConnector } from './google/play-draft.ts';
import * as fx from './store.fixtures.ts';
import { FakeAppleDraftApi, FakePlayDraftApi, sha256 } from './store-draft.fixtures.ts';
import { isStoreImageReader } from './store-draft-types.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

const apple = (configure: (api: FakeAppleDraftApi) => void) => {
  const api = new FakeAppleDraftApi();
  configure(api);
  const connector = new AppleDraftConnector({
    credential: {
      keyId: fx.KEY_ID,
      issuerId: fx.ISSUER_ID,
      privateKey: fx.appleKeyPem().privateKey,
    },
    appStoreId: '10746822401',
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { api, connector };
};

test('App Store: readStoreImages lists the screenshots with their template url, size and own checksum, and writes nothing', async () => {
  const { api, connector } = apple((a) => {
    a.addPlacements('loc-en', 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE', [
      { name: 'one.png', bytes: new Uint8Array([1, 2, 3]), size: { width: 1320, height: 2868 } },
      {
        name: 'two.png',
        bytes: new Uint8Array([4, 5]),
        reference: false,
        size: { width: 1320, height: 2868 },
      },
      { name: 'odd.png', bytes: new Uint8Array([9]), size: { width: 999, height: 999 } },
    ]);
    a.addPlacements('loc-en', 'IPAD_PROFILE', [
      { name: 'pad.png', bytes: new Uint8Array([7]), size: { width: 2064, height: 2752 } },
    ]);
  });
  assert.ok(isStoreImageReader(connector));
  const read = await connector.readStoreImages();
  assert.deepEqual(read.version, {
    id: 'v-next',
    versionString: '2.1',
    state: 'PREPARE_FOR_SUBMISSION',
    editable: true,
  });
  assert.equal(read.unplaced, 1);
  assert.deepEqual(
    read.images.map((i) => [i.locale, i.device, i.position, i.name, i.width, i.bytes]),
    [
      ['en-US', 'iphone_6_9', 1, 'one.png', 1320, 3],
      ['en-US', 'iphone_6_9', 2, 'two.png', 1320, 2],
      ['en-US', 'ipad_13', 1, 'pad.png', 2064, 1],
    ],
  );
  assert.equal(read.images[0]?.checksum, sha256(new Uint8Array([1, 2, 3])).slice(0, 32));
  assert.equal(read.images[1]?.checksum, null, 'an image somebody else uploaded has no checksum');
  assert.equal(read.images[0]?.urlKind, 'apple_template');
  assert.match(
    read.images[0]?.url ?? '',
    /^https:\/\/is1\.mzstatic\.com\/image\/thumb\/.+\/\{w\}x\{h\}bb\.\{f\}$/,
  );
  assert.deepEqual(api.writes(), []);
});

test('App Store: with no editable version the live one is read and the note says so; with neither it is refused', async () => {
  const live = apple((a) => {
    a.versions = [{ id: 'v-live', versionString: '2.0', state: 'READY_FOR_SALE' }];
    a.locs.set('loc-live', {
      versionId: 'v-live',
      locale: 'en-US',
      attributes: { locale: 'en-US' },
    });
    a.locs.delete('loc-en');
    a.addPlacements('loc-live', 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE', [
      { name: 'a.png', bytes: new Uint8Array([1]), size: { width: 1320, height: 2868 } },
    ]);
  });
  const read = await live.connector.readStoreImages();
  assert.equal(read.version?.editable, false);
  assert.equal(read.version?.state, 'READY_FOR_SALE');
  assert.equal(read.images.length, 1);
  assert.match(read.notes.join(' '), /live version/);
  const none = apple((a) => {
    a.versions = [{ id: 'v-rev', versionString: '2.1', state: 'WAITING_FOR_REVIEW' }];
  });
  await assert.rejects(
    none.connector.readStoreImages(),
    (e: unknown) => e instanceof StoreError && e.kind === 'no_editable_version',
  );
});

test('App Store: the editable version and the live version are separate channels, each says which version it read', async () => {
  const { api, connector } = apple((a) => {
    // The default fake has the live 2.0 (READY_FOR_DISTRIBUTION, the name of `appVersionState`) and the editable 2.1.
    a.locs.set('loc-live', {
      versionId: 'v-live',
      locale: 'en-US',
      attributes: { locale: 'en-US' },
    });
    const size = { width: 1242, height: 2208 };
    a.addPlacements('loc-en', 'IPHONE_55_PROFILE', [{ name: 'draft.png', bytes: new Uint8Array([1]), size }]);
    a.addPlacements('loc-live', 'IPHONE_55_PROFILE', [
      { name: 'left1.png', bytes: new Uint8Array([2]), size },
      { name: 'left2.png', bytes: new Uint8Array([3]), size },
    ]);
  });
  const editable = await connector.readStoreImages();
  assert.deepEqual(
    [editable.version?.versionString, editable.version?.editable, editable.images.map((i) => i.name)],
    ['2.1', true, ['draft.png']],
  );
  const live = await connector.readStoreImages({ channel: 'live' });
  assert.deepEqual(
    [live.version?.versionString, live.version?.editable, live.images.map((i) => i.name)],
    ['2.0', false, ['left1.png', 'left2.png']],
  );
  // Deleting from the draft never touches the live version's placements.
  assert.deepEqual(api.writes(), []);
});

test('Google Play: readStoreImages reads every type of every language in a throwaway edit and commits nothing', async () => {
  const api = new FakePlayDraftApi();
  api.setImages('en-US', 'phoneScreenshots', [new Uint8Array([1, 2, 3]), new Uint8Array([4])]);
  api.setImages('en-US', 'icon', [new Uint8Array([9, 9])]);
  api.setImages('en-US', 'featureGraphic', [new Uint8Array([8])]);
  const connector = new PlayDraftConnector({
    serviceAccount: fx.serviceAccountJson(fx.googleKeyPem().privateKey),
    packageName: 'com.example.coffee',
    fetch: api.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  assert.ok(isStoreImageReader(connector));
  const read = await connector.readStoreImages();
  assert.equal(read.version, null);
  assert.deepEqual(
    read.images.map((i) => [i.kind, i.device, i.target, i.position, i.checksum?.slice(0, 8)]),
    [
      ['icon', null, 'icon', 1, sha256(new Uint8Array([9, 9])).slice(0, 8)],
      ['feature_graphic', null, 'featureGraphic', 1, sha256(new Uint8Array([8])).slice(0, 8)],
      ['screenshot', 'phone', 'phoneScreenshots', 1, sha256(new Uint8Array([1, 2, 3])).slice(0, 8)],
      ['screenshot', 'phone', 'phoneScreenshots', 2, sha256(new Uint8Array([4])).slice(0, 8)],
    ],
  );
  assert.equal(read.images[0]?.urlKind, 'play_url');
  assert.match(read.images[0]?.url ?? '', /^https:\/\/play-lh\.googleusercontent\.com\//);
  assert.deepEqual(
    api.writes().map((w) => w.split(' ')[0]),
    ['POST', 'DELETE'],
  );
  assert.equal(api.commits.length, 0);
});
