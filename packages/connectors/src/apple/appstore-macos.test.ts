import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import * as lx from '../store-listing.fixtures.ts';
import {
  APPLE_MAC_LOOKUP_ENTITY,
  APPLE_MAC_SEARCH_ENTITY,
  appleSearchUrl,
} from './apple-search.ts';
import { AppleDraftConnector } from './appstore-draft.ts';
import { AppleRolloutConnector } from './appstore-rollout.ts';
import { AppleSubmitConnector } from './appstore-submit.ts';
import { AppStoreConnectConnector } from './appstoreconnect.ts';
import { fetchRatingSummary, ITUNES_LOOKUP_URL, parseRatingSummary } from './itunes-rating.ts';

// macOS is a second Apple platform of the same App Store Connect app: the same requests, narrowed to the versions and
// builds whose `platform` attribute is MAC_OS. The iOS behavior must not change (the other test files hold that).

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();
const credential = { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey };
const APP = '10746822401';

const connector = (fake: fx.FakeFetch, platform?: 'ios' | 'macos') =>
  new AppStoreConnectConnector({
    credential,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
    ...(platform ? { platform } : {}),
  });

test('a macOS connector lists only the macOS versions, and says macos', async () => {
  const fake = new fx.FakeFetch();
  fake.on({
    method: 'GET',
    match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
    json: fx.appleVersions,
  });
  const mac = connector(fake, 'macos');
  assert.equal(mac.platform, 'macos');
  const versions = await mac.listVersions(APP);
  assert.deepEqual(
    versions.map((v) => [v.storeId, v.versionString, v.platform, v.rawState, v.lifecycleState]),
    [['v-mac', '2.1', 'macos', 'PREPARE_FOR_SUBMISSION', 'draft']],
  );
  assert.equal(connector(new fx.FakeFetch()).platform, 'ios');
});

test('a macOS connector lists the builds of macOS pre-release versions only; a build of unknown platform is never taken for macOS', async () => {
  const fake = new fx.FakeFetch();
  fake.on({
    method: 'GET',
    match:
      '/v1/builds?filter[app]=10746822401&include=preReleaseVersion&limit=200&sort=-uploadedDate',
    json: fx.appleBuilds,
  });
  const builds = await connector(fake, 'macos').listBuilds(APP);
  assert.deepEqual(
    builds.map((b) => [b.storeId, b.buildNumber, b.versionString, b.platform]),
    [['b-mac', '5', '9.0', 'macos']],
  );
  // The iOS connector, on the same answer, still takes the iOS builds and the build with no pre-release version.
  const fakeIos = new fx.FakeFetch();
  fakeIos.on({
    method: 'GET',
    match:
      '/v1/builds?filter[app]=10746822401&include=preReleaseVersion&limit=200&sort=-uploadedDate',
    json: fx.appleBuilds,
  });
  const ios = await connector(fakeIos).listBuilds(APP);
  assert.ok(
    ios.every((b) => b.platform === 'ios') &&
      !ios.some((b) => b.storeId === 'b-mac') &&
      ios.some((b) => b.storeId === 'b-nopre'),
  );
});

test('the macOS listing is read from the macOS versions, never from the iOS ones', async () => {
  const fake = new fx.FakeFetch();
  fake
    .on({
      method: 'GET',
      match: '/v1/apps/100/appStoreVersions?limit=200',
      json: lx.appleListingVersions,
    })
    .on({ method: 'GET', match: '/v1/apps/100/appInfos?limit=200', json: lx.appleAppInfosLiveOnly })
    .on({
      method: 'GET',
      match: '/v1/appInfos/info-live/appInfoLocalizations?limit=200',
      json: lx.appleInfoLocalizationsLive,
    })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-mac/appStoreVersionLocalizations?limit=200',
      json: { data: [], links: { self: '' } },
    });
  const read = await connector(fake, 'macos').readListing('100');
  assert.equal(read.platform, 'macos');
  // Only the macOS version (9.9, editable) is a channel; the iOS 2.0 and 2.1 are not read.
  assert.deepEqual(
    read.channels.map((c) => [c.channel, c.versionString]),
    [
      ['live', undefined],
      ['editable', '9.9'],
    ],
  );
  assert.ok(
    fake.calls.every(
      (c) => !c.url.pathname.includes('v-live') && !c.url.pathname.includes('v-next'),
    ),
    'no iOS version is read',
  );
});

test('listApps({ withPlatforms }) asks one request with the sparse include and reads the platforms; a 400 repeats it plain', async () => {
  const fake = new fx.FakeFetch();
  const withPlatforms = {
    data: [
      {
        type: 'apps',
        id: '1',
        attributes: { name: 'Both', bundleId: 'com.acme.both' },
        relationships: {
          appStoreVersions: {
            data: [
              { type: 'appStoreVersions', id: 'v1' },
              { type: 'appStoreVersions', id: 'v2' },
              { type: 'appStoreVersions', id: 'v3' },
            ],
          },
        },
      },
      {
        type: 'apps',
        id: '2',
        attributes: { name: 'Mac only', bundleId: 'com.acme.mac' },
        relationships: { appStoreVersions: { data: [{ type: 'appStoreVersions', id: 'v4' }] } },
      },
      {
        type: 'apps',
        id: '3',
        attributes: { name: 'Empty', bundleId: 'com.acme.empty' },
        relationships: { appStoreVersions: { data: [] } },
      },
    ],
    included: [
      { type: 'appStoreVersions', id: 'v1', attributes: { platform: 'IOS' } },
      { type: 'appStoreVersions', id: 'v2', attributes: { platform: 'MAC_OS' } },
      { type: 'appStoreVersions', id: 'v3', attributes: { platform: 'TV_OS' } },
      { type: 'appStoreVersions', id: 'v4', attributes: { platform: 'MAC_OS' } },
    ],
    links: { self: '' },
  };
  fake.on({
    method: 'GET',
    match:
      '/v1/apps?limit=200&include=appStoreVersions&fields[appStoreVersions]=platform&limit[appStoreVersions]=50',
    json: withPlatforms,
  });
  const apps = await connector(fake).listApps({ withPlatforms: true });
  assert.deepEqual(
    apps.map((a) => [a.storeId, a.platforms]),
    [
      ['1', ['ios', 'macos']],
      ['2', ['macos']],
      ['3', undefined],
    ],
  );
  assert.deepEqual(fake.unexpected, []);

  const rejected = new fx.FakeFetch();
  rejected
    .on({
      method: 'GET',
      match:
        '/v1/apps?limit=200&include=appStoreVersions&fields[appStoreVersions]=platform&limit[appStoreVersions]=50',
      status: 400,
      json: fx.apple400Sort,
    })
    .on({ method: 'GET', match: '/v1/apps?limit=200', json: fx.appleAppsPage2 });
  const plain = await connector(rejected).listApps({ withPlatforms: true });
  assert.ok(
    plain.length > 0 && plain.every((a) => a.platforms === undefined && a.platform === 'ios'),
  );
});

test('listPlatforms reads the Apple platforms an app has a version for', async () => {
  const fake = new fx.FakeFetch();
  fake.on({
    method: 'GET',
    match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
    json: fx.appleVersions,
  });
  assert.deepEqual(await connector(fake).listPlatforms(APP), ['ios', 'macos']);
});

const VERSIONS = `/v1/apps/${APP}/appStoreVersions?limit=200`;
const versionsDoc = {
  data: [
    {
      type: 'appStoreVersions',
      id: 'v-ios',
      attributes: { platform: 'IOS', versionString: '2.0', appVersionState: 'READY_FOR_SALE' },
    },
    {
      type: 'appStoreVersions',
      id: 'v-mac-a',
      attributes: { platform: 'MAC_OS', versionString: '2.0', appVersionState: 'READY_FOR_SALE' },
    },
    {
      type: 'appStoreVersions',
      id: 'v-mac-b',
      attributes: {
        platform: 'MAC_OS',
        versionString: '2.1',
        appVersionState: 'PREPARE_FOR_SUBMISSION',
        releaseType: 'MANUAL',
      },
    },
  ],
  links: { self: `${fx.APPLE_BASE}${VERSIONS}` },
};
const phased = {
  data: {
    type: 'appStoreVersionPhasedReleases',
    id: 'pr-9',
    attributes: { phasedReleaseState: 'ACTIVE', currentDayNumber: 2 },
  },
};

test('rollout: a macOS version is found by its version string among the macOS versions and its phased release is read', async () => {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'GET', match: VERSIONS, json: versionsDoc }).on({
    method: 'GET',
    match: '/v1/appStoreVersions/v-mac-a/appStoreVersionPhasedRelease',
    json: phased,
  });
  const rollout = new AppleRolloutConnector({
    credential,
    appStoreId: APP,
    platform: 'macos',
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  assert.equal(rollout.platform, 'macos');
  const state = await rollout.readState({ version: '2.0' });
  assert.ok(
    state.store === 'appstoreconnect' &&
      state.platform === 'macos' &&
      state.storeVersionId === 'v-mac-a' &&
      state.phasedReleaseState === 'ACTIVE',
  );
  assert.deepEqual(fake.unexpected, []);
});

test('rollout: a macOS version that does not exist is not_found even when the iOS one does, and the message says macOS', async () => {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'GET', match: VERSIONS, json: versionsDoc });
  const rollout = new AppleRolloutConnector({
    credential,
    appStoreId: APP,
    platform: 'macos',
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  await assert.rejects(rollout.readState({ version: '1.0' }), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'not_found');
    assert.match(error.message, /no macOS version 1\.0/);
    return true;
  });
  const ios = new AppleRolloutConnector({
    credential,
    appStoreId: APP,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  await assert.rejects(ios.readState({ version: '2.1' }), /no iOS version 2\.1/);
});

test('submit: the version to submit is the editable macOS version, and the iOS one is never touched', async () => {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'GET', match: VERSIONS, json: versionsDoc })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-mac-b/build',
      status: 404,
      json: { errors: [{ status: '404', code: 'NOT_FOUND', title: 'x', detail: 'x' }] },
    })
    .on({
      method: 'GET',
      match:
        '/v1/apps/10746822401/reviewSubmissions?filter[state]=READY_FOR_REVIEW&filter[platform]=MAC_OS&limit=20',
      json: { data: [], links: { self: '' } },
    });
  const submit = new AppleSubmitConnector({
    credential,
    appStoreId: APP,
    platform: 'macos',
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  assert.equal(submit.platform, 'macos');
  // The read goes on to the version's listing, which this test does not serve: what matters is which version and which
  // platform it asked for first.
  await submit.readSubmitState({ text: [], assets: [] }).catch(() => undefined);
  assert.ok(fake.calls.some((c) => c.url.pathname.includes('/v1/appStoreVersions/v-mac-b')));
  assert.ok(
    !fake.calls.some((c) => c.url.pathname.includes('v-ios')),
    'the iOS version is never touched',
  );
  assert.ok(!fake.calls.some((c) => c.url.search.includes('filter[platform]=IOS')));
});

test('draft: the editable version of a macOS record is the macOS one; with none the message says macOS', async () => {
  const fake = new fx.FakeFetch();
  fake.on({
    method: 'GET',
    match: VERSIONS,
    json: {
      data: [
        {
          type: 'appStoreVersions',
          id: 'v-ios',
          attributes: {
            platform: 'IOS',
            versionString: '2.1',
            appVersionState: 'PREPARE_FOR_SUBMISSION',
          },
        },
      ],
      links: { self: '' },
    },
  });
  const draft = new AppleDraftConnector({
    credential,
    appStoreId: APP,
    platform: 'macos',
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  assert.equal(draft.platform, 'macos');
  await assert.rejects(draft.readDraft({ text: [], assets: [] }), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'no_editable_version');
    assert.match(error.message, /no macOS version/);
    return true;
  });
});

test('iTunes: a macOS rating asks the Mac entity and takes the entry that says mac-software; the search names the Mac entity', async () => {
  const seen: string[] = [];
  const answer = {
    resultCount: 2,
    results: [
      { trackId: 77, kind: 'software', averageUserRating: 3, userRatingCount: 5 },
      { trackId: 77, kind: 'mac-software', averageUserRating: 4.5, userRatingCount: 40 },
    ],
  };
  const summary = await fetchRatingSummary({
    appStoreId: '77',
    country: 'US',
    platform: 'macos',
    fetch: async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  });
  assert.equal(seen[0], `${ITUNES_LOOKUP_URL}?id=77&country=us&entity=${APPLE_MAC_LOOKUP_ENTITY}`);
  assert.deepEqual(summary, {
    appStoreId: '77',
    country: 'US',
    platform: 'macos',
    averageRating: 4.5,
    ratingCount: 40,
  });
  assert.equal(
    parseRatingSummary(answer, '77', 'US')?.averageRating,
    3,
    'the iOS reading is unchanged',
  );
  assert.equal(
    parseRatingSummary(
      { results: [{ trackId: 5, averageUserRating: 4, userRatingCount: 1 }] },
      '77',
      'US',
      'macos',
    ),
    undefined,
    'no entry for this id: no summary',
  );
  assert.match(
    appleSearchUrl({ term: 'notes', country: 'US', macos: true }),
    new RegExp(`entity=${APPLE_MAC_SEARCH_ENTITY}`),
  );
  assert.match(appleSearchUrl({ term: 'notes', country: 'US' }), /entity=software/);
});
