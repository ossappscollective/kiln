import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppStoreConnectConnector } from './apple/appstoreconnect.ts';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { GooglePlayConnector } from './google/googleplay.ts';
import * as fx from './store.fixtures.ts';
import * as lx from './store-listing.fixtures.ts';
import * as sx from './store-sections.fixtures.ts';
import {
  appleAgeRating,
  appleCategories,
  appleMediaSets,
  playDetails,
  playImageSet,
  playReleaseNotes,
  sectionWarning,
} from './store-sections.ts';

const appleKey = fx.appleKeyPem();
const googleKey = fx.googleKeyPem();
const APP = '100';

function appleSetup() {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'GET', match: lx.APPLE_PRIMARY_LOCALE_PATH, json: lx.applePrimaryLocale() });
  const connector = new AppStoreConnectConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: appleKey.privateKey },
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    sleep: async () => undefined,
  });
  return { fake, connector };
}

/** The routes of an extended read: the base ones, the app infos with `include`, and the media of both versions. */
function extendedRoutes(fake: fx.FakeFetch, infos: unknown = sx.appleAppInfosExtended) {
  fake
    .on({
      method: 'GET',
      match: `/v1/apps/${APP}/appStoreVersions?limit=200`,
      json: lx.appleListingVersions,
    })
    .on({ method: 'GET', match: /^\/v1\/apps\/100\/appInfos\?limit=200&include=/, json: infos })
    .on({ method: 'GET', match: `/v1/apps/${APP}/appInfos?limit=200`, json: lx.appleAppInfos })
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
    })
    .on({
      method: 'GET',
      match: /\/appStoreVersionLocalizations\/vl-en\/appScreenshotSets\?/,
      json: sx.screenshotSetsEn,
    })
    .on({
      method: 'GET',
      match: /\/appStoreVersionLocalizations\/vl-de\/appScreenshotSets\?/,
      json: sx.screenshotSetsDe,
    })
    .on({
      method: 'GET',
      match: /\/appStoreVersionLocalizations\/vl2-en\/appScreenshotSets\?/,
      json: sx.screenshotSetsDe,
    })
    .on({
      method: 'GET',
      match: /\/appStoreVersionLocalizations\/vl-en\/appPreviewSets\?/,
      json: sx.previewSetsEn,
    })
    .on({
      method: 'GET',
      match: /\/appStoreVersionLocalizations\/[^/]+\/appPreviewSets\?/,
      json: sx.previewSetsEmpty,
    });
}

// ---------------------------------------------------------------------------------------------
// App Store Connect

test('App Store: an extended read has categories, age rating, privacy, details and media per channel', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  const read = await connector.readListing(APP, { extended: true });
  assert.deepEqual(read.warnings, []);
  const [live, editable] = read.channels;
  assert.deepEqual(live?.sections?.categories, {
    primary: 'GAMES',
    primarySubcategories: ['GAMES_CARD'],
    secondary: 'ENTERTAINMENT',
  });
  // The next app info has `data: null` everywhere: read, and empty.
  assert.deepEqual(editable?.sections?.categories, {});
  assert.equal(live?.sections?.ageRating?.rating, 'FOUR_PLUS');
  assert.equal(live?.sections?.ageRating?.answers.userGeneratedContent, true);
  assert.equal(live?.sections?.ageRating?.answers.gambling, false);
  assert.equal(live?.sections?.ageRating?.answers.profanityOrCrudeHumor, 'INFREQUENT_OR_MILD');
  assert.equal(
    live?.sections?.ageRating?.answers.someFutureQuestion,
    'FREQUENT',
    'an unknown question is kept',
  );
  assert.ok(
    !('weird' in (live?.sections?.ageRating?.answers ?? {})),
    'a non-scalar answer is ignored',
  );
  assert.ok(
    !('kidsAgeBand' in (live?.sections?.ageRating?.answers ?? {})),
    'null is not an answer',
  );
  assert.deepEqual(editable?.sections?.ageRating?.answers, {
    advertising: true,
    contests: 'NONE',
    gambling: false,
    userGeneratedContent: true,
  });
  assert.deepEqual(live?.sections?.privacy, {
    choicesUrls: { 'en-US': 'https://example.org/choices' },
  });
  assert.deepEqual(editable?.sections?.privacy, { choicesUrls: {} });
  // The App Store's primary locale is the default language (`GET /v1/apps/{id}`), as Google Play's `defaultLanguage`.
  assert.deepEqual(live?.sections?.details, { copyright: '2026 Coffee Co', defaultLanguage: 'en-US' });
  assert.equal(editable?.sections?.details?.defaultLanguage, 'en-US');

  // Media: counts, file names and asset states; per locale (the live version has en-US and de-DE).
  const media = live?.sections?.media;
  assert.deepEqual(media?.screenshots['de-DE'], []);
  assert.deepEqual(media?.screenshots['en-US'], [
    { type: 'APP_IPAD_PRO_3GEN_129', count: 1, names: ['ipad_1.png'], states: { COMPLETE: 1 } },
    {
      type: 'APP_IPHONE_67',
      count: 3,
      names: ['1_home.png', '2_brew.png', '3_timer.png'],
      states: { AWAITING_UPLOAD: 1, COMPLETE: 2 },
    },
  ]);
  assert.deepEqual(media?.previews?.['en-US'], [
    { type: 'IPHONE_67', count: 1, names: ['demo.mp4'], states: { COMPLETE: 1 } },
  ]);
  assert.equal(media?.truncated, undefined);
  assert.deepEqual(editable?.sections?.media?.screenshots, { 'en-US': [] });

  // Never kept: image URLs, upload operations, video URLs.
  const text = JSON.stringify(read);
  for (const forbidden of [
    'templateUrl',
    'upload.example',
    'mzstatic',
    'videoUrl',
    'v.example.invalid',
    'uploadOperations',
  ]) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not be in the result`);
  }
  assert.deepEqual(fake.unexpected, []);
});

test('App Store: every request of an extended read is a GET with parameters Apple documents, and no review detail is requested', async () => {
  // From the "Query Parameters" of each page (docs/spikes/store-api-conventions.md, 2026-11-18).
  const documented: Record<
    string,
    { params: string[]; include?: string[]; fields?: Record<string, string[]> }
  > = {
    [`/v1/apps/${APP}/appInfos`]: {
      params: ['limit', 'include'],
      include: [
        'primaryCategory',
        'primarySubcategoryOne',
        'primarySubcategoryTwo',
        'secondaryCategory',
        'secondarySubcategoryOne',
        'secondarySubcategoryTwo',
        'ageRatingDeclaration',
      ],
    },
    '/appScreenshotSets': {
      params: [
        'limit',
        'limit[appScreenshots]',
        'include',
        'fields[appScreenshotSets]',
        'fields[appScreenshots]',
      ],
      include: ['appScreenshots'],
      fields: {
        'fields[appScreenshotSets]': ['screenshotDisplayType', 'appScreenshots'],
        'fields[appScreenshots]': ['fileName', 'assetDeliveryState'],
      },
    },
    '/appPreviewSets': {
      params: [
        'limit',
        'limit[appPreviews]',
        'include',
        'fields[appPreviewSets]',
        'fields[appPreviews]',
      ],
      include: ['appPreviews'],
      fields: {
        'fields[appPreviewSets]': ['previewType', 'appPreviews'],
        'fields[appPreviews]': ['fileName', 'assetDeliveryState'],
      },
    },
  };
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  await connector.readListing(APP, { extended: true });
  assert.ok(
    fake.calls.every((c) => c.method === 'GET'),
    'every request is a GET',
  );
  let checked = 0;
  for (const call of fake.calls) {
    const path = call.url.pathname;
    assert.ok(
      !/reviewDetail|appStoreReviewDetail|reviewAttachment/i.test(path),
      `${path}: the review detail is never requested`,
    );
    const key = path.endsWith('/appScreenshotSets')
      ? '/appScreenshotSets'
      : path.endsWith('/appPreviewSets')
        ? '/appPreviewSets'
        : path;
    const rule = documented[key];
    if (!rule) continue;
    checked++;
    for (const [name, value] of call.url.searchParams) {
      assert.ok(rule.params.includes(name), `${path}: ${name} is not a documented parameter`);
      if (name === 'include')
        for (const v of value.split(','))
          assert.ok(rule.include?.includes(v), `${path}: include=${v}`);
      if (name === 'limit')
        assert.ok(Number(value) >= 1 && Number(value) <= 200, `limit=${value} (maximum 200)`);
      if (name.startsWith('limit['))
        assert.ok(Number(value) >= 1 && Number(value) <= 50, `${name}=${value} (maximum 50)`);
      const allowed = rule.fields?.[name];
      if (allowed) for (const v of value.split(',')) assert.ok(allowed.includes(v), `${name}=${v}`);
    }
  }
  // The app infos with include, then two requests (sets and previews) for each of the three localizations.
  assert.equal(checked, 1 + 3 * 2);
  assert.deepEqual(fake.unexpected, []);
});

test('App Store: without `extended` only the sections that come out of the same responses are present', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  const read = await connector.readListing(APP);
  const live = read.channels[0]?.sections;
  assert.deepEqual(Object.keys(live ?? {}).sort(), ['details', 'privacy']);
  assert.deepEqual(live?.privacy, { choicesUrls: { 'en-US': 'https://example.org/choices' } });
  assert.equal(fake.calls.length, 7, 'the same six requests as before, and the app for its primary locale');
  assert.ok(!fake.calls.some((c) => c.url.searchParams.has('include')));
});

test('App Store: a rejected include falls back to the plain list and says so, the texts are still read', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  fake.clear('GET', /^\/v1\/apps\/100\/appInfos\?limit=200&include=/);
  fake.on({
    method: 'GET',
    match: /^\/v1\/apps\/100\/appInfos\?limit=200&include=/,
    status: 400,
    json: fx.appleParameterError('include'),
  });
  const read = await connector.readListing(APP, { extended: true });
  assert.ok(read.warnings.some((w) => /Categories and the age rating were not read/.test(w)));
  assert.equal(read.channels[0]?.sections?.categories, undefined, 'not read is not empty');
  assert.equal(read.channels[0]?.sections?.ageRating, undefined);
  assert.equal(read.channels[0]?.listing.appStore?.locales['en-US']?.name, 'Coffee');
  assert.ok(read.channels[0]?.sections?.media, 'the media were still read');
});

test('App Store: an answer without any category linkage is "not read", with a warning, not "empty"', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake, sx.appleAppInfosNoLinkage);
  const read = await connector.readListing(APP, { extended: true });
  assert.equal(read.channels[0]?.sections?.categories, undefined);
  assert.equal(read.channels[0]?.sections?.ageRating, undefined);
  assert.ok(read.warnings.some((w) => /no category data/.test(w)));
  assert.ok(read.warnings.some((w) => /no age rating declaration/.test(w)));
});

test('App Store: the media endpoint failing (403, 404, 500) is a warning and the other sections stay', async () => {
  for (const status of [403, 404, 500]) {
    const { fake, connector } = appleSetup();
    extendedRoutes(fake);
    fake.clear('GET', /\/appStoreVersionLocalizations\/vl-en\/appScreenshotSets\?/);
    fake.on({
      method: 'GET',
      match: /appScreenshotSets/,
      status,
      json:
        status === 403
          ? fx.apple403
          : { errors: [{ status: String(status), code: 'X', title: 'No' }] },
    });
    const read = await connector.readListing(APP, { extended: true });
    assert.equal(read.channels[0]?.sections?.media, undefined, `${status}: not read`);
    assert.ok(
      read.warnings.some((w) =>
        /screenshots and previews of the live version could not be read/.test(w),
      ),
      `${status}: ${read.warnings.join('|')}`,
    );
    assert.equal(read.channels[0]?.sections?.categories?.primary, 'GAMES');
    assert.equal(read.channels[0]?.listing.appStore?.locales['en-US']?.name, 'Coffee');
  }
});

test('App Store: a rate limit while reading the media stops the whole read (it is not a warning)', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  fake.clear('GET', /\/appStoreVersionLocalizations\/vl-en\/appScreenshotSets\?/);
  fake.on({
    method: 'GET',
    match: /appScreenshotSets/,
    status: 429,
    json: fx.apple429,
    headers: { 'retry-after': '3600' },
  });
  await assert.rejects(
    connector.readListing(APP, { extended: true }),
    (e: unknown) => e instanceof StoreRateLimitError,
  );
});

test('App Store: a bad credential while reading the media stops the whole read', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  fake.clear('GET', /\/appStoreVersionLocalizations\/vl-en\/appScreenshotSets\?/);
  fake.on({
    method: 'GET',
    match: /appScreenshotSets/,
    status: 401,
    json: { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'x' }] },
  });
  await assert.rejects(
    connector.readListing(APP, { extended: true }),
    (e: unknown) => e instanceof StoreError && e.kind === 'auth',
  );
});

test('App Store: at most 30 locales per version are read for media, the rest are said to be left out', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  const locales = Array.from({ length: 33 }, (_, i) => `l${String(i).padStart(2, '0')}`);
  fake.clear('GET', '/v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200');
  fake.on({
    method: 'GET',
    match: '/v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200',
    json: {
      data: locales.map((l) => ({
        type: 'appStoreVersionLocalizations',
        id: `id-${l}`,
        attributes: { locale: l, description: 'A description.' },
      })),
    },
  });
  fake.on({ method: 'GET', match: /appScreenshotSets\?/, json: { data: [] } });
  const read = await connector.readListing(APP, { extended: true });
  const live = read.channels[0]?.sections?.media;
  assert.equal(Object.keys(live?.screenshots ?? {}).length, 30);
  assert.equal(live?.truncated, true);
  assert.ok(read.warnings.some((w) => /30 of 33 locales of the live version/.test(w)));
  const media = fake.calls.filter((c) =>
    /AppScreenshotSets|appScreenshotSets|appPreviewSets/.test(c.url.pathname),
  );
  assert.ok(media.length <= 2 * 30 + 2, `bounded: ${media.length} media requests`);
});

test('App Store: paging links of the app infos are followed on the API host only', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  fake.clear('GET', /^\/v1\/apps\/100\/appInfos\?limit=200&include=/);
  fake.on({
    method: 'GET',
    match: /^\/v1\/apps\/100\/appInfos\?limit=200&include=/,
    json: {
      ...sx.appleAppInfosExtended,
      data: [sx.appleAppInfosExtended.data[0]],
      links: { next: 'https://evil.example.invalid/next' },
    },
  });
  await assert.rejects(
    connector.readListing(APP, { extended: true }),
    (e: unknown) => e instanceof StoreError && e.kind === 'unexpected',
  );
});

// ---------------------------------------------------------------------------------------------
// The parsers on their own

test('parsers: partial and unexpected shapes never throw', () => {
  assert.equal(appleCategories({}), undefined);
  assert.equal(
    appleCategories({ relationships: { primaryCategory: {} } }),
    undefined,
    'no linkage: unknown',
  );
  assert.deepEqual(
    appleCategories({ relationships: { primaryCategory: { data: null } } }),
    {},
    'linkage null: empty',
  );
  assert.deepEqual(
    appleCategories({ relationships: { primaryCategory: { data: { id: 7 } } } }),
    {},
    'a bad id is ignored',
  );
  assert.equal(appleAgeRating({}, []), undefined);
  assert.equal(
    appleAgeRating(
      {
        relationships: {
          ageRatingDeclaration: { data: { type: 'ageRatingDeclarations', id: 'x' } },
        },
      },
      [],
    ),
    undefined,
    'declared but not included',
  );
  assert.deepEqual(
    appleAgeRating(
      {
        attributes: { appStoreAgeRating: 'NINE_PLUS' },
        relationships: { ageRatingDeclaration: { data: null } },
      },
      [],
    ),
    { rating: 'NINE_PLUS', answers: {} },
  );
  assert.deepEqual(appleMediaSets({}, 'screenshots'), []);
  assert.deepEqual(
    appleMediaSets(
      { data: [{ id: 'a' }, { id: 'b', attributes: { screenshotDisplayType: 'APP_DESKTOP' } }] },
      'screenshots',
    ),
    [{ type: 'APP_DESKTOP', count: 0 }],
  );
  // The relationship's own total wins over a cut linkage list.
  assert.equal(
    appleMediaSets(
      {
        data: [
          {
            id: 's',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
            relationships: {
              appScreenshots: { data: [{ id: 'a' }], meta: { paging: { total: 9 } } },
            },
          },
        ],
      },
      'screenshots',
    )[0]?.count,
    9,
  );
  assert.deepEqual(playImageSet('icon', undefined), { type: 'icon', count: 0 });
  assert.deepEqual(playImageSet('icon', { images: 'nope' }), { type: 'icon', count: 0 });
  assert.deepEqual(playImageSet('icon', { images: [{ id: 'a' }, {}, 3] }), {
    type: 'icon',
    count: 2,
    ids: ['a'],
  });
  assert.deepEqual(playDetails(undefined), {});
  assert.deepEqual(playDetails({ defaultLanguage: '', contactEmail: 4 }), {});
  assert.deepEqual(playReleaseNotes([{}, { track: 'production' }]), { tracks: {} });
});

test('parsers: the current release of a track is the live one with the highest version code', () => {
  const notes = playReleaseNotes(sx.googleTracks.tracks);
  assert.deepEqual(notes.tracks.production, {
    name: '2.0',
    status: 'inProgress',
    versionCodes: ['200', '201'],
    notes: { 'de-DE': 'Timer und Fehlerbehebungen', 'en-US': 'Timers and bug fixes' },
  });
  assert.deepEqual(notes.tracks.beta, { status: 'draft', versionCodes: ['210'], notes: {} });
  assert.ok(!('internal' in notes.tracks), 'a track without releases has nothing to show');
});

test('sectionWarning: a rate limit, a bad credential, the clock and the network are rethrown; the rest is a sentence', () => {
  const store = 'googleplay' as const;
  assert.throws(() => sectionWarning(new StoreRateLimitError(store, 5), 'x'), StoreRateLimitError);
  for (const kind of ['auth', 'clock_skew', 'network', 'edit_invalid'] as const) {
    assert.throws(() => sectionWarning(new StoreError(store, kind, 'm'), 'x'), StoreError, kind);
  }
  assert.match(
    sectionWarning(new StoreError(store, 'forbidden', 'No access.', 403), 'The app details'),
    /The app details could not be read \(forbidden HTTP 403\)/,
  );
  assert.throws(() => sectionWarning(new TypeError('bug'), 'x'), TypeError);
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
    .on({ method: 'DELETE', match: EDIT, json: {} })
    .on({ method: 'GET', match: `${EDIT}/listings`, json: lx.googleListingsFull })
    .on({ method: 'GET', match: `${EDIT}/details`, json: sx.googleDetails })
    .on({ method: 'GET', match: `${EDIT}/tracks`, json: sx.googleTracks });
  const connector = new GooglePlayConnector({
    serviceAccount: fx.serviceAccountJson(googleKey.privateKey),
    packages: [PKG],
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    sleep: async () => undefined,
  });
  return { fake, connector };
}

const IMAGE_TYPES = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
  'icon',
  'featureGraphic',
  'tvBanner',
];

function imageRoutes(fake: fx.FakeFetch) {
  fake
    .on({
      method: 'GET',
      match: `${EDIT}/listings/en-US/phoneScreenshots`,
      json: sx.googleImages(['p1', 'p2', 'p3']),
    })
    .on({ method: 'GET', match: `${EDIT}/listings/en-US/icon`, json: sx.googleImages(['i1']) })
    .on({
      method: 'GET',
      match: `${EDIT}/listings/en-US/featureGraphic`,
      json: sx.googleImages(['f1']),
    })
    .on({ method: 'GET', match: /\/listings\/[^/]+\/[A-Za-z]+$/, json: {} });
}

test('Google Play: an extended read adds details, release notes and image counts inside the same read-only edit', async () => {
  const { fake, connector } = playSetup();
  imageRoutes(fake);
  const read = await connector.readListing(PKG, { extended: true });
  assert.deepEqual(read.warnings, []);
  const sections = read.channels[0]?.sections;
  assert.deepEqual(sections?.details, {
    defaultLanguage: 'en-US',
    contactEmail: 'support@example.org',
    contactWebsite: 'https://example.org',
  });
  assert.equal(sections?.releaseNotes?.tracks.production?.notes['en-US'], 'Timers and bug fixes');
  const en = sections?.media?.screenshots['en-US'];
  assert.deepEqual(
    en?.map((s) => [s.type, s.count]),
    [
      ['phoneScreenshots', 3],
      ['sevenInchScreenshots', 0],
      ['tenInchScreenshots', 0],
      ['tvScreenshots', 0],
      ['wearScreenshots', 0],
    ],
  );
  assert.deepEqual(en?.[0]?.ids, ['p1', 'p2', 'p3']);
  assert.deepEqual(
    sections?.media?.graphics?.['en-US']?.map((s) => [s.type, s.count]),
    [
      ['icon', 1],
      ['featureGraphic', 1],
      ['tvBanner', 0],
    ],
  );
  // Never kept: the phone number, image URLs and hashes.
  const text = JSON.stringify(read);
  for (const forbidden of [
    'contactPhone',
    '+33',
    'play-lh.example',
    'sha1',
    'sha256',
    'aaaaaaaa',
  ]) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not be in the result`);
  }
  // Every request is inside the edit that is deleted at the end, none writes or commits.
  const calls = fake.calls.filter((c) => c.url.host !== 'oauth2.googleapis.com');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.url.pathname, EDITS);
  assert.equal(calls[calls.length - 1]?.method, 'DELETE');
  assert.deepEqual(
    calls.slice(1, -1).map((c) => c.method),
    calls.slice(1, -1).map(() => 'GET'),
  );
  assert.ok(
    calls.every((c) => !/:commit|:validate|deleteall|upload/i.test(c.url.pathname)),
    'no commit, validate, deleteall or upload',
  );
  for (const type of IMAGE_TYPES) {
    assert.equal(
      fake.called('GET', `${EDIT}/listings/en-US/${type}`).length,
      1,
      `${type} of en-US`,
    );
    assert.equal(
      fake.called('GET', `${EDIT}/listings/de-DE/${type}`).length,
      1,
      `${type} of de-DE`,
    );
  }
  assert.ok(
    calls.slice(1, -1).every((c) => c.url.search === ''),
    'no query parameter is sent',
  );
  assert.deepEqual(fake.unexpected, []);
});

test('Google Play: without `extended` there is no section and no extra request', async () => {
  const { fake, connector } = playSetup();
  const read = await connector.readListing(PKG);
  assert.equal(read.channels[0]?.sections, undefined);
  assert.deepEqual(
    fake.calls
      .filter((c) => c.url.host !== 'oauth2.googleapis.com')
      .map((c) => `${c.method} ${c.url.pathname}`),
    [`POST ${EDITS}`, `GET ${EDIT}/listings`, `DELETE ${EDIT}`],
  );
});

test('Google Play: a failing optional part is a warning and only that section is left out', async () => {
  const { fake, connector } = playSetup();
  fake.clear('GET', `${EDIT}/details`);
  fake.on({ method: 'GET', match: `${EDIT}/details`, status: 403, json: fx.google403Forbidden });
  fake.on({
    method: 'GET',
    match: /\/listings\/[^/]+\/[A-Za-z]+$/,
    status: 404,
    json: fx.google404Package,
  });
  const read = await connector.readListing(PKG, { extended: true });
  const sections = read.channels[0]?.sections;
  assert.equal(sections?.details, undefined, 'not read');
  assert.equal(sections?.media, undefined, 'not read');
  assert.ok(sections?.releaseNotes, 'the tracks were read');
  assert.equal(read.warnings.length, 2);
  assert.match(read.warnings[0] ?? '', /app details could not be read \(forbidden HTTP 403\)/);
  assert.match(read.warnings[1] ?? '', /images could not be read/);
  assert.equal(read.channels[0]?.listing.googlePlay?.locales['en-US']?.title, 'Coffee');
  assert.equal(fake.called('DELETE', EDIT).length, 1, 'the edit is deleted');
});

test('Google Play: a rate limit in an optional part stops the read, and the edit is still deleted', async () => {
  const { fake, connector } = playSetup();
  fake.clear('GET', `${EDIT}/tracks`);
  fake.on({ method: 'GET', match: `${EDIT}/tracks`, status: 429, json: fx.google429Quota });
  await assert.rejects(
    connector.readListing(PKG, { extended: true }),
    (e: unknown) => e instanceof StoreRateLimitError,
  );
  assert.equal(fake.called('DELETE', EDIT).length, 1);
});

test('Google Play: at most 25 languages have their images read, the default language first', async () => {
  const { fake, connector } = playSetup();
  const languages = Array.from({ length: 28 }, (_, i) => `a${String(i).padStart(2, '0')}`);
  fake.clear('GET', `${EDIT}/listings`);
  fake.on({
    method: 'GET',
    match: `${EDIT}/listings`,
    json: { listings: languages.map((language) => ({ language, title: 'T' })) },
  });
  fake.clear('GET', `${EDIT}/details`);
  fake.on({ method: 'GET', match: `${EDIT}/details`, json: { defaultLanguage: 'a27' } });
  fake.on({ method: 'GET', match: /\/listings\/[^/]+\/[A-Za-z]+$/, json: {} });
  const read = await connector.readListing(PKG, { extended: true });
  const media = read.channels[0]?.sections?.media;
  assert.equal(Object.keys(media?.screenshots ?? {}).length, 25);
  assert.ok('a27' in (media?.screenshots ?? {}), 'the default language is in');
  assert.equal(media?.truncated, true);
  assert.ok(read.warnings.some((w) => /25 of 28 languages/.test(w)));
  assert.equal(
    fake.calls.filter((c) => /\/listings\/[^/]+\/[A-Za-z]+$/.test(c.url.pathname)).length,
    25 * 8,
  );
});

test('Google Play: the package name and language are encoded into the image paths', async () => {
  const { fake, connector } = playSetup();
  fake.clear('GET', `${EDIT}/listings`);
  fake.on({
    method: 'GET',
    match: `${EDIT}/listings`,
    json: { listings: [{ language: 'x/../y', title: 'T' }] },
  });
  fake.on({ method: 'GET', match: /.*/, json: {} });
  await connector.readListing(PKG, { extended: true });
  assert.ok(fake.calls.some((c) => c.url.pathname.includes('/listings/x%2F..%2Fy/icon')));
});

test('App Store: a refused read of the primary locale is a warning; the texts and the other sections are still read', async () => {
  const { fake, connector } = appleSetup();
  extendedRoutes(fake);
  fake.clear('GET', lx.APPLE_PRIMARY_LOCALE_PATH);
  fake.on({ method: 'GET', match: lx.APPLE_PRIMARY_LOCALE_PATH, status: 403, json: fx.google403Forbidden });
  const read = await connector.readListing(APP);
  assert.equal(read.channels[0]?.sections?.details?.defaultLanguage, undefined);
  assert.deepEqual(read.channels[0]?.sections?.details, { copyright: '2026 Coffee Co' });
  assert.ok(read.channels[0]?.listing.appStore?.locales['en-US']);
  assert.match(read.warnings.join(' '), /primary locale of the app could not be read/);
});
