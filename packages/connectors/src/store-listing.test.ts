import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppStoreConnectConnector, isAppleParameterError } from './apple/appstoreconnect.ts';
import { StoreError } from './errors.ts';
import { GooglePlayConnector } from './google/googleplay.ts';
import * as fx from './store.fixtures.ts';
import * as lx from './store-listing.fixtures.ts';

const appleKey = fx.appleKeyPem();
const googleKey = fx.googleKeyPem();
const APP = '100';

function appleSetup(pageSize?: number) {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'GET', match: lx.APPLE_PRIMARY_LOCALE_PATH, json: lx.applePrimaryLocale() });
  const connector = new AppStoreConnectConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: appleKey.privateKey },
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    sleep: async () => undefined,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  return { fake, connector };
}

/** The routes of a typical app: a live version 2.0 and an editable version 2.1. */
function routes(fake: fx.FakeFetch, appInfos: unknown = lx.appleAppInfos) {
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
      json: lx.appleListingVersions,
    })
    .on({ method: 'GET', match: `/v1/apps/${APP}/appInfos?limit=200`, json: appInfos })
    .on({
      method: 'GET',
      match: '/v1/appInfos/info-live/appInfoLocalizations?limit=200',
      json: lx.appleInfoLocalizationsLive,
    })
    .on({
      method: 'GET',
      match: '/v1/appInfos/info-next/appInfoLocalizations?limit=200',
      json: lx.appleInfoLocalizationsNext,
    })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200',
      json: lx.appleVersionLocalizationsLive,
    })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=200',
      json: lx.appleVersionLocalizationsNext,
    });
}

// ---------------------------------------------------------------------------------------------
// App Store Connect

test('App Store: the live and the editable version are read into the shared listing model', async () => {
  const { fake, connector } = appleSetup();
  routes(fake);
  const read = await connector.readListing(APP);
  assert.equal(read.platform, 'ios');
  assert.equal(read.appStoreId, APP);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(
    read.channels.map((c) => [c.channel, c.versionString, c.versionRawState, c.infoRawState]),
    [
      ['live', '2.0', 'READY_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION'],
      ['editable', '2.1', 'PREPARE_FOR_SUBMISSION', 'PREPARE_FOR_SUBMISSION'],
    ],
  );
  const live = read.channels[0]?.listing.appStore?.locales;
  assert.deepEqual(live?.['en-US'], {
    name: 'Coffee',
    subtitle: 'Brew better',
    privacy_url: 'https://example.org/privacy',
    description: 'The best coffee app.',
    keywords: 'coffee,brew',
    marketing_url: 'https://example.org',
    promotional_text: 'Now with timers',
    support_url: 'https://example.org/support',
    release_notes: 'Bug fixes',
  });
  // null is "not set": absent, never an empty string. privacyChoicesUrl has no field in the model.
  assert.deepEqual(live?.['de-DE'], {
    name: 'Kaffee',
    description: 'Die beste Kaffee-App.',
    keywords: 'kaffee',
    support_url: 'https://example.org/hilfe',
  });
  assert.ok(!JSON.stringify(live).includes('choices'));
  const editable = read.channels[1]?.listing.appStore?.locales;
  assert.equal(editable?.['en-US']?.name, 'Coffee Pro');
  assert.equal(editable?.['en-US']?.keywords, 'coffee,brew,grinder');
  assert.equal(editable?.['en-US']?.release_notes, 'Grinder support');
  // de-DE exists only in the app info of the editable channel (no version localization).
  assert.deepEqual(editable?.['de-DE'], { name: 'Kaffee Pro', subtitle: 'Besser brühen' });
  assert.deepEqual(fake.unexpected, []);
  assert.ok(
    fake.calls.every((c) => c.method === 'GET'),
    'every request is a GET',
  );
});

test('App Store: an app with only a live version has no editable channel', async () => {
  const { fake, connector } = appleSetup();
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
      json: { data: lx.appleListingVersions.data.filter((v) => v.id === 'v-live') },
    })
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appInfos?limit=200`,
      json: lx.appleAppInfosLiveOnly,
    })
    .on({ method: 'GET', match: /appInfoLocalizations/, json: lx.appleInfoLocalizationsLive })
    .on({
      method: 'GET',
      match: /appStoreVersionLocalizations/,
      json: lx.appleVersionLocalizationsLive,
    });
  const read = await connector.readListing(APP);
  assert.deepEqual(
    read.channels.map((c) => c.channel),
    ['live'],
  );
  assert.deepEqual(read.warnings, []);
});

test('App Store: an editable version without its own app info reads name and subtitle from the live one, and says so', async () => {
  const { fake, connector } = appleSetup();
  routes(fake, lx.appleAppInfosLiveOnly);
  const read = await connector.readListing(APP);
  const editable = read.channels.find((c) => c.channel === 'editable');
  assert.equal(editable?.infoRawState, 'READY_FOR_DISTRIBUTION');
  assert.equal(editable?.listing.appStore?.locales['en-US']?.name, 'Coffee');
  assert.equal(editable?.listing.appStore?.locales['en-US']?.keywords, 'coffee,brew,grinder');
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0] ?? '', /no app info of its own/);
  // The live app info is read once even though two channels use it.
  assert.equal(
    fake.called('GET', '/v1/appInfos/info-live/appInfoLocalizations?limit=200').length,
    1,
  );
});

test('App Store: the deprecated state fields are the fallback', async () => {
  const { fake, connector } = appleSetup();
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
      json: {
        data: [
          {
            type: 'appStoreVersions',
            id: 'v-live',
            attributes: { platform: 'IOS', versionString: '1.0', appStoreState: 'READY_FOR_SALE' },
          },
        ],
      },
    })
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appInfos?limit=200`,
      json: lx.appleAppInfosOldState,
    })
    .on({ method: 'GET', match: /appInfoLocalizations/, json: lx.appleInfoLocalizationsLive })
    .on({
      method: 'GET',
      match: /appStoreVersionLocalizations/,
      json: lx.appleVersionLocalizationsLive,
    });
  const read = await connector.readListing(APP);
  assert.deepEqual(
    read.channels.map((c) => [c.channel, c.versionRawState, c.infoRawState]),
    [['live', 'READY_FOR_SALE', 'READY_FOR_SALE']],
  );
});

test('App Store: a new app with no live or editable version reads what exists and warns', async () => {
  const { fake, connector } = appleSetup();
  fake
    .on({ method: 'GET', match: `/v1/apps/${APP}/appStoreVersions?limit=200`, json: { data: [] } })
    .on({ method: 'GET', match: `/v1/apps/${APP}/appInfos?limit=200`, json: { data: [] } });
  const read = await connector.readListing(APP);
  assert.deepEqual(read.channels, []);
  assert.equal(read.warnings.length, 2);
});

test('App Store: localizations follow links.next', async () => {
  const { fake, connector } = appleSetup();
  const next = `${fx.APPLE_BASE}/v1/appStoreVersions/v-live/appStoreVersionLocalizations?cursor=AoJ4&limit=200`;
  const [first, second] = lx.appleVersionLocalizationsLive.data;
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
      json: { data: [lx.appleListingVersions.data[0]] },
    })
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appInfos?limit=200`,
      json: lx.appleAppInfosLiveOnly,
    })
    .on({ method: 'GET', match: /appInfoLocalizations/, json: { data: [] } })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200',
      json: { data: [first], links: { next } },
    })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-live/appStoreVersionLocalizations?cursor=AoJ4&limit=200',
      json: { data: [second] },
    });
  const read = await connector.readListing(APP);
  assert.deepEqual(Object.keys(read.channels[0]?.listing.appStore?.locales ?? {}).sort(), [
    'de-DE',
    'en-US',
  ]);
  assert.deepEqual(fake.unexpected, []);
});

test('App Store: a localization with every attribute null is kept (fr-FR on the draft), next to fr-CA, and the live version keeps its own list', async () => {
  const { fake, connector } = appleSetup(1);
  const loc = (id: string, attributes: Record<string, unknown>) => ({
    type: 'appStoreVersionLocalizations',
    id,
    attributes,
  });
  const base = `${fx.APPLE_BASE}/v1/appStoreVersions/v-next/appStoreVersionLocalizations`;
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=1`,
      json: lx.appleListingVersions,
    })
    .on({ method: 'GET', match: `/v1/apps/${APP}/appInfos?limit=1`, json: lx.appleAppInfos })
    .on({ method: 'GET', match: /appInfoLocalizations/, json: { data: [] } })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=1',
      json: { data: [loc('l-en', { locale: 'en-US', description: 'Live' })] },
    })
    // Page 1 of the draft: en-US; page 2: fr-FR with nothing set; page 3: fr-CA (a distinct language).
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=1',
      json: {
        data: [loc('n-en', { locale: 'en-US', description: 'Draft' })],
        links: { next: `${base}?cursor=p2&limit=1` },
      },
    })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-next/appStoreVersionLocalizations?cursor=p2&limit=1',
      json: {
        data: [
          loc('n-fr', {
            locale: 'fr-FR',
            description: null,
            keywords: null,
            supportUrl: null,
            marketingUrl: null,
            promotionalText: null,
            whatsNew: null,
          }),
        ],
        links: { next: `${base}?cursor=p3&limit=1` },
      },
    })
    .on({
      method: 'GET',
      match: '/v1/appStoreVersions/v-next/appStoreVersionLocalizations?cursor=p3&limit=1',
      json: { data: [loc('n-ca', { locale: 'fr-CA', description: 'Texte' })] },
    });
  const read = await connector.readListing(APP);
  const live = read.channels.find((c) => c.channel === 'live')?.listing.appStore?.locales;
  const draft = read.channels.find((c) => c.channel === 'editable')?.listing.appStore?.locales;
  assert.deepEqual(Object.keys(live ?? {}), ['en-US'], 'the live version has no French');
  assert.deepEqual(Object.keys(draft ?? {}).sort(), ['en-US', 'fr-CA', 'fr-FR']);
  assert.deepEqual(draft?.['fr-FR'], {}, 'Apple sends null: the locale exists with no field');
  assert.deepEqual(draft?.['fr-CA'], { description: 'Texte' });
  assert.deepEqual(fake.unexpected, []);
});

test('App Store: only parameters that Apple documents for each endpoint are sent', async () => {
  // From the "Query Parameters" of each page, read 2026-11-18 (docs/spikes/store-api-conventions.md).
  const documented: Record<string, { params: string[]; include?: string[] }> = {
    [`/v1/apps/${APP}/appStoreVersions`]: {
      params: [
        'limit',
        'include',
        'filter[platform]',
        'filter[appVersionState]',
        'filter[id]',
        'filter[versionString]',
      ],
    },
    [`/v1/apps/${APP}/appInfos`]: {
      params: ['limit', 'limit[appInfoLocalizations]', 'include', 'fields[appInfos]'],
    },
    '/v1/appInfos/info-live/appInfoLocalizations': {
      params: ['limit', 'include', 'filter[locale]', 'fields[appInfoLocalizations]'],
      include: ['appInfo'],
    },
    '/v1/appInfos/info-next/appInfoLocalizations': {
      params: ['limit', 'include', 'filter[locale]', 'fields[appInfoLocalizations]'],
      include: ['appInfo'],
    },
    '/v1/appStoreVersions/v-live/appStoreVersionLocalizations': {
      params: [
        'limit',
        'include',
        'filter[locale]',
        'fields[appStoreVersionLocalizations]',
        'limit[appScreenshotSets]',
        'limit[appPreviewSets]',
      ],
      include: ['appStoreVersion', 'appScreenshotSets', 'appPreviewSets', 'searchKeywords'],
    },
    '/v1/appStoreVersions/v-next/appStoreVersionLocalizations': {
      params: [
        'limit',
        'include',
        'filter[locale]',
        'fields[appStoreVersionLocalizations]',
        'limit[appScreenshotSets]',
        'limit[appPreviewSets]',
      ],
      include: ['appStoreVersion', 'appScreenshotSets', 'appPreviewSets', 'searchKeywords'],
    },
    // The app's primary locale: one attribute, asked with a sparse field set.
    '/v1/apps/100': { params: ['fields[apps]'], include: [] },
  };
  const { fake, connector } = appleSetup(5000);
  routes(fake);
  await connector.readListing(APP);
  assert.equal(fake.calls.length, 7);
  for (const call of fake.calls) {
    const rule = documented[call.url.pathname];
    assert.ok(rule, `no documented endpoint ${call.url.pathname}`);
    for (const [name, value] of call.url.searchParams) {
      assert.ok(
        rule.params.includes(name),
        `${call.url.pathname}: ${name} is not a documented parameter`,
      );
      if (name === 'include')
        assert.ok(rule.include?.includes(value), `${call.url.pathname}: include=${value}`);
      if (name === 'limit')
        assert.ok(
          Number(value) >= 1 && Number(value) <= 200,
          `limit=${value} (documented maximum 200)`,
        );
    }
    // Neither sort nor include is documented for these paths; the connector sends neither.
    assert.ok(!call.url.searchParams.has('sort') && !call.url.searchParams.has('include'));
  }
  assert.deepEqual(fake.unexpected, []);
});

test('App Store: a rejected parameter is surfaced with its name (source.parameter)', async () => {
  const { fake, connector } = appleSetup();
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
      json: lx.appleListingVersions,
    })
    .on({ method: 'GET', match: `/v1/apps/${APP}/appInfos?limit=200`, json: lx.appleAppInfos })
    .on({
      method: 'GET',
      match: /appInfoLocalizations/,
      status: 400,
      json: fx.appleParameterError('limit'),
    });
  let caught: unknown;
  try {
    await connector.readListing(APP);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StoreError);
  assert.equal(caught.status, 400);
  assert.equal(caught.details?.[0]?.code, 'PARAMETER_ERROR.ILLEGAL');
  assert.equal(caught.details?.[0]?.parameter, 'limit');
  assert.match(caught.message, /parameter: limit/);
  assert.match(caught.message, /reading the listing of app 100/);
  assert.ok(isAppleParameterError(caught));
});

test('App Store: a 403 on the listing is a forbidden error, not a retry', async () => {
  const { fake, connector } = appleSetup();
  fake.on({ method: 'GET', match: /.*/, status: 403, json: fx.apple403 });
  await assert.rejects(
    connector.readListing(APP),
    (e: unknown) => e instanceof StoreError && e.kind === 'forbidden',
  );
  assert.equal(fake.calls.length, 1);
});

test('App Store: ids are encoded into the paths', async () => {
  const { fake, connector } = appleSetup();
  fake.on({ method: 'GET', match: /.*/, json: { data: [] } });
  await connector.readListing('1/../2');
  assert.ok(
    fake.calls.every(
      (c) => c.url.pathname.startsWith('/v1/apps/1%2F..%2F2/') || c.url.pathname === '/v1/apps/1%2F..%2F2',
    ),
  );
});

// ---------------------------------------------------------------------------------------------
// Google Play

const PKG = 'com.example.coffee';
const EDITS = `/androidpublisher/v3/applications/${PKG}/edits`;
const EDIT = `${EDITS}/${fx.googleEdit.id}`;

function playSetup() {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({ method: 'POST', match: EDITS, json: fx.googleEdit })
    .on({ method: 'DELETE', match: EDIT, json: {} });
  const connector = new GooglePlayConnector({
    serviceAccount: fx.serviceAccountJson(googleKey.privateKey),
    packages: [PKG],
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    sleep: async () => undefined,
  });
  return { fake, connector };
}

test('Google Play: listings are read in a read-only edit that is deleted and never committed', async () => {
  const { fake, connector } = playSetup();
  fake.on({ method: 'GET', match: `${EDIT}/listings`, json: lx.googleListingsFull });
  const read = await connector.readListing(PKG);
  const sequence = fake.calls
    .filter((c) => c.url.host !== 'oauth2.googleapis.com')
    .map((c) => `${c.method} ${c.url.pathname}`);
  assert.deepEqual(sequence, [`POST ${EDITS}`, `GET ${EDIT}/listings`, `DELETE ${EDIT}`]);
  assert.ok(
    fake.calls.every((c) => !/:commit|:validate/.test(c.url.pathname)),
    'no commit or validate',
  );
  assert.equal(fake.calls.find((c) => c.url.pathname === `${EDIT}/listings`)?.url.search, '');
  assert.equal(read.platform, 'android');
  assert.deepEqual(
    read.channels.map((c) => c.channel),
    ['live'],
  );
  assert.deepEqual(read.channels[0]?.listing.googlePlay, {
    locales: {
      'en-US': {
        title: 'Coffee',
        short_description: 'Brew better',
        full_description: 'The best coffee app.',
        video: 'https://www.youtube.com/watch?v=abc',
      },
      'de-DE': {
        title: 'Kaffee',
        short_description: 'Besser brühen',
        full_description: 'Die beste Kaffee-App.',
      },
    },
    changelogs: {},
  });
  assert.equal(read.channels[0]?.listing.appStore, undefined);
});

test('Google Play: the edit is deleted even when the listings read fails', async () => {
  const { fake, connector } = playSetup();
  fake.on({ method: 'GET', match: `${EDIT}/listings`, status: 403, json: fx.google403Forbidden });
  await assert.rejects(
    connector.readListing(PKG),
    (e: unknown) => e instanceof StoreError && e.kind === 'forbidden',
  );
  assert.equal(fake.called('DELETE', EDIT).length, 1);
});

test('Google Play: no listings means no locales, not an error', async () => {
  const { fake, connector } = playSetup();
  fake.on({ method: 'GET', match: `${EDIT}/listings`, json: { listings: [] } });
  const read = await connector.readListing(PKG);
  assert.deepEqual(read.channels[0]?.listing.googlePlay?.locales, {});
});

test('Google Play: an invalid package name never reaches a URL', async () => {
  const { fake, connector } = playSetup();
  await assert.rejects(
    connector.readListing('../x'),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  assert.equal(fake.calls.length, 0);
});
