import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreListing } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import {
  bootListing,
  EN_US,
  iosListing,
  iosSections,
  type ListingBoot,
  playListing,
} from './test-helpers.ts';
import { operations } from '../../operations/registry.ts';

// The listing sections (categories, age rating, privacy, media, details, release notes) end to end:
// a sync of a fake store records them, the views show them, the drift compares them with the
// repository (fastlane files and Expo's store.config.json). Nothing here contacts a store or GitHub.
// The connector parsers are in packages/connectors, the pure comparison in packages/core.

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';

const sectionRows = (t: ListingBoot, id: string, where = '') =>
  t.rows(id, `AND locale = '_app' ${where}`);
const textRows = (t: ListingBoot, id: string, where = '') =>
  t.rows(id, `AND locale <> '_app' ${where}`);
const names = (rows: Record<string, unknown>[]) =>
  rows.map((r) => String(r.field).replace('section:', '')).sort();
const statuses = (body: { sections: { name: string; compare: { status: string } }[] }) =>
  Object.fromEntries(body.sections.map((s) => [s.name, s.compare.status]));

const PRIMARY = 'fastlane/metadata/primary_category.txt';
const SECONDARY = 'fastlane/metadata/secondary_category.txt';
const RATING = 'fastlane/app_rating_config.json';
const COPYRIGHT = 'fastlane/metadata/copyright.txt';

// ---------------------------------------------------------------------------------------------
// Recording

dbTest(
  'a sync records the sections of the live listing once, apart from the text history',
  async (db) => {
    const t = await bootListing(db);
    const id = await t.addIos();
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    assert.equal((await t.sync(id)).status, 200);

    // The read asks for the extended sections, and nothing else changes about the call.
    assert.deepEqual(t.stores.ios.options, [{ extended: true }]);
    const live = (await t.live(id)).body;
    assert.equal(live.channels.length, 1);
    assert.deepEqual(live.channels[0].sections.categories, {
      primary: 'PRODUCTIVITY',
      secondary: 'BUSINESS',
    });
    assert.equal(live.channels[0].sections.ageRating.rating, 'FOUR_PLUS');
    assert.equal(live.channels[0].sections.ageRating.answers.gambling, false);
    assert.deepEqual(live.channels[0].sections.privacy, {
      choicesUrls: { 'en-US': 'https://acme.example/choices' },
    });
    assert.deepEqual(live.channels[0].sections.details, { copyright: '2026 Acme' });
    assert.deepEqual(live.channels[0].sections.media.screenshots['en-US'], [
      { type: 'APP_IPHONE_67', count: 3, names: ['a.png', 'b.png', 'c.png'] },
    ]);
    // No image bytes, no URL of an image: counts and names only.
    assert.ok(
      !/https?:\/\/[^"]*\.(png|jpe?g)/i.test(JSON.stringify(live.channels[0].sections.media)),
    );

    assert.deepEqual(names(await sectionRows(t, id)), [
      'ageRating',
      'categories',
      'details',
      'media',
      'privacy',
    ]);
    assert.equal((await textRows(t, id)).length, 3);

    // The same read again records nothing at all.
    const before = (await t.rows(id)).length;
    await t.sync(id);
    assert.equal((await t.rows(id)).length, before);

    // The history is the history of the text fields: the sections are not in it.
    const history = await t.history(id);
    assert.equal(history.body.items.length, 3);
    assert.ok(!history.text.includes('section:') && !history.text.includes('_app'));
    t.noLeaks();
  },
);

dbTest('a changed section is a new snapshot, and only that section', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
  await t.sync(id);
  const before = (await sectionRows(t, id)).length;

  t.stores.ios.listing = iosListing(
    { 'en-US': EN_US },
    iosSections({ categories: { primary: 'GAMES', secondary: 'BUSINESS' } }),
  );
  await t.sync(id);
  const rows = await sectionRows(t, id);
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1]?.field, 'section:categories');
  assert.equal((await t.live(id)).body.channels[0].sections.categories.primary, 'GAMES');
  assert.equal((await textRows(t, id)).length, 3, 'the texts were not recorded again');
});

dbTest(
  'not read is not empty: a read without a section keeps what is known, an empty section is remembered',
  async (db) => {
    const t = await bootListing(db);
    const id = await t.addIos();
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    await t.sync(id);
    const before = (await sectionRows(t, id)).length;

    // The connector could not say (a warning, no sections): nothing is erased, nothing is added.
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, undefined, [
      'Age rating could not be read (HTTP 403).',
    ]);
    await t.sync(id);
    assert.equal((await sectionRows(t, id)).length, before);
    const kept = (await t.live(id)).body;
    assert.equal(kept.channels[0].sections.categories.primary, 'PRODUCTIVITY');
    assert.deepEqual(kept.warnings, ['Age rating could not be read (HTTP 403).']);

    // A section the connector says is empty is a different thing: it was read, and has nothing.
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, { privacy: { choicesUrls: {} } });
    await t.sync(id);
    const empty = (await t.live(id)).body.channels[0].sections;
    assert.deepEqual(empty.privacy, { choicesUrls: {} });
    assert.equal(
      empty.categories.primary,
      'PRODUCTIVITY',
      'the sections that were not in this read are untouched',
    );
    assert.equal((await sectionRows(t, id)).length, before + 1);
    const d = (await t.drift(id)).body;
    assert.equal(
      statuses(d).privacy,
      'not-comparable',
      'read and empty, but the repository has not been read',
    );
    assert.equal(
      d.sections.find((s: { name: string }) => s.name === 'privacy').store.choicesUrls['en-US'],
      undefined,
    );
  },
);

dbTest(
  'an upgrade is quiet: a listing recorded before sections existed does not look changed',
  async (db) => {
    const t = await bootListing(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    // What an older server recorded and read: texts only, no section rows.
    t.stores.ios.listing = iosListing({ 'en-US': EN_US });
    await t.sync(id);
    await t.refresh(id);
    const old = (await t.drift(id)).body;
    assert.equal(old.summary.identical, 3);
    assert.equal(old.summary.diverged + old.summary['repo-ahead'] + old.summary['store-ahead'], 0);
    assert.equal(
      (await sectionRows(t, id, "AND source = 'store'")).length,
      0,
      'the store has no section row yet',
    );
    const liveOld = (await t.live(id)).body;
    assert.equal(
      'sections' in liveOld.channels[0],
      false,
      'a channel that never had sections does not claim any',
    );
    for (const s of old.sections) {
      assert.equal(s.store, null);
      assert.equal(s.storeObservedAt, null);
      assert.equal(s.compare.status, 'not-read', s.name);
    }
    const textBefore = await textRows(t, id);
    const historyBefore = (await t.history(id)).body.items.length;

    // The first read that has sections adds only section rows: no text field looks changed.
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    await t.sync(id);
    assert.deepEqual(await textRows(t, id), textBefore);
    assert.equal((await t.history(id)).body.items.length, historyBefore);
    const upgraded = (await t.drift(id)).body;
    assert.deepEqual(upgraded.summary, old.summary);
    assert.equal(
      statuses(upgraded).categories,
      'missing-in-repo',
      'the repository has no category file',
    );
    assert.equal(statuses(upgraded).privacy, 'not-comparable');
  },
);

dbTest('a channel that disappears marks its sections removed, once', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
  await t.sync(id);
  assert.equal((await sectionRows(t, id, "AND channel = 'live'")).length, 5);

  // The version went to the editable copy only (the live one is gone).
  const editableOnly: StoreListing = {
    platform: 'ios',
    appStoreId: '1234567890',
    warnings: [],
    channels: [
      {
        channel: 'editable',
        versionString: '2.1',
        listing: { appStore: { locales: { 'en-US': EN_US } } },
        sections: { privacy: { choicesUrls: {} } },
      },
    ],
  };
  t.stores.ios.listing = editableOnly;
  await t.sync(id);
  const live = await sectionRows(t, id, "AND channel = 'live'");
  assert.equal(live.length, 10, 'five sections read, five marked removed');
  assert.equal(live.filter((r) => r.value === null).length, 5);
  await t.sync(id);
  assert.equal((await sectionRows(t, id, "AND channel = 'live'")).length, 10, 'removed once');
  const body = (await t.live(id)).body;
  assert.deepEqual(
    body.channels.map((c: { channel: string }) => c.channel),
    ['editable'],
  );
  assert.deepEqual(body.channels[0].sections, { privacy: { choicesUrls: {} } });
});

dbTest(
  'Google Play: details, image counts and release notes; no categories and no age rating',
  async (db) => {
    const t = await bootListing(db);
    const id = await t.addAndroid();
    t.stores.android.listing = playListing(
      { 'en-US': { title: 'Acme Play', shortDescription: 'Short play text' } },
      {
        details: { defaultLanguage: 'en-US', contactEmail: 'help@acme.example' },
        media: {
          screenshots: { 'en-US': [{ type: 'phoneScreenshots', count: 2, ids: ['s1', 's2'] }] },
          graphics: { 'en-US': [{ type: 'icon', count: 1, ids: ['i1'] }] },
        },
        releaseNotes: {
          tracks: {
            production: {
              versionCodes: ['42'],
              status: 'completed',
              notes: { 'en-US': 'Bug fixes' },
            },
          },
        },
      },
    );
    assert.equal((await t.sync(id)).status, 200);
    const live = (await t.live(id)).body;
    assert.deepEqual(Object.keys(live.channels[0].sections).sort(), [
      'details',
      'media',
      'releaseNotes',
    ]);
    assert.equal(
      live.channels[0].sections.releaseNotes.tracks.production.notes['en-US'],
      'Bug fixes',
    );
    const d = (await t.drift(id)).body;
    assert.deepEqual(
      d.sections.map((s: { name: string }) => s.name),
      ['details', 'media', 'releaseNotes'],
    );
    assert.equal(
      statuses(d).releaseNotes,
      'not-comparable',
      'release notes are shown, not compared',
    );
    // Not even the contact phone number is stored: it is not in the model.
    assert.ok(!JSON.stringify(live).includes('contactPhone'));
  },
);

// ---------------------------------------------------------------------------------------------
// The views: warnings and the schedule

dbTest(
  'the live view carries the connector warnings (redacted) and the scheduled read state',
  async (db) => {
    const t = await bootListing(db);
    const id = await t.addIos();
    assert.deepEqual((await t.live(id)).body.warnings, []);
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections(), [
      'Screenshots of en-GB could not be read (HTTP 500).',
      `Age rating failed ${KEY_LINE}`,
    ]);
    await t.sync(id);
    const liveRes = await t.live(id);
    const live = liveRes.body;
    assert.equal(live.warnings.length, 2);
    assert.equal(live.warnings[0], 'Screenshots of en-GB could not be read (HTTP 500).');
    assert.ok(!liveRes.text.includes(KEY_LINE), 'a secret in a warning is redacted');
    assert.equal(live.schedule.enabled, true);
    assert.equal(live.schedule.intervalMinutes, 60);
    assert.equal(live.schedule.failures, 0);
    assert.equal(typeof live.schedule.lastAttemptAt, 'number');
    assert.equal(live.schedule.nextReadAt, live.schedule.lastAttemptAt + 60 * 60_000);

    // A warning-free read clears the warnings.
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    await t.sync(id);
    assert.deepEqual((await t.live(id)).body.warnings, []);

    // A failed read: the failure is counted, the next read is pushed out (double the interval), and the last good read stays.
    t.stores.ios.error = new Error('boom');
    await t.sync(id);
    const failed = (await t.live(id)).body;
    assert.equal(failed.schedule.failures, 1);
    assert.equal(failed.schedule.nextReadAt, failed.schedule.lastAttemptAt + 2 * 60 * 60_000);
    assert.equal(failed.channels[0].sections.categories.primary, 'PRODUCTIVITY');
    t.stores.ios.error = undefined;
    await t.sync(id);
    assert.equal((await t.live(id)).body.schedule.failures, 0);
    t.noLeaks();
  },
);

// ---------------------------------------------------------------------------------------------
// Drift against the repository

dbTest(
  'drift with fastlane: categories, age rating, copyright and screenshot counts, never by content',
  async (db) => {
    const t = await bootListing(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    await t.sync(id);
    await t.refresh(id);

    // Nothing about the sections is in the repository yet.
    let s = statuses((await t.drift(id)).body);
    assert.equal(s.categories, 'missing-in-repo');
    assert.equal(s.media, 'missing-in-repo');
    assert.equal(s.details, 'missing-in-repo');
    assert.equal(s.privacy, 'not-comparable', 'fastlane has no file for the privacy choices URL');

    // The repository says the same, in fastlane's own spelling.
    t.repo.files.set(PRIMARY, 'Productivity\n');
    t.repo.files.set(SECONDARY, 'BUSINESS\n');
    t.repo.files.set(RATING, '{ "violenceCartoonOrFantasy": 0, "gambling": false }\n');
    t.repo.files.set(COPYRIGHT, '2026 Acme\n');
    for (const n of ['1', '2', '3'])
      t.repo.files.set(`fastlane/screenshots/en-US/${n}.png`, 'not read');
    await t.refresh(id);
    let d = (await t.drift(id)).body;
    s = statuses(d);
    assert.deepEqual(s, {
      categories: 'identical',
      ageRating: 'identical',
      privacy: 'not-comparable',
      details: 'identical',
      media: 'identical',
    });
    assert.equal(
      d.sections.find((x: { name: string }) => x.name === 'media').repo.screenshots['en-US'][0]
        .count,
      3,
    );
    assert.equal(d.summary.identical, 3, 'the text fields are as before');

    // A difference in each: a category, an answer and the number of screenshots.
    t.repo.files.set(PRIMARY, 'Games\n');
    t.repo.files.set(RATING, '{ "violenceCartoonOrFantasy": 2, "gambling": false }\n');
    t.repo.files.delete('fastlane/screenshots/en-US/3.png');
    await t.refresh(id);
    d = (await t.drift(id)).body;
    s = statuses(d);
    assert.equal(s.categories, 'differs');
    assert.equal(s.ageRating, 'differs');
    assert.equal(s.media, 'differs');
    const media = d.sections.find((x: { name: string }) => x.name === 'media');
    assert.ok(
      media.compare.details.some((line: string) => /en-US: store 3, repository 2/.test(line)),
    );
    const rating = d.sections.find((x: { name: string }) => x.name === 'ageRating');
    assert.ok(
      rating.compare.details.some((line: string) =>
        /violenceCartoonOrFantasy: store NONE, repository 2/.test(line),
      ),
    );

    // The store side is shown as the store has it, whatever the repository says.
    assert.equal(
      d.sections.find((x: { name: string }) => x.name === 'categories').store.primary,
      'PRODUCTIVITY',
    );
  },
);

dbTest(
  'drift with Expo: categories, advisory answers and the privacy choices URL come from store.config.json',
  async (db) => {
    const t = await bootListing(db);
    t.repo.files = new Map(
      Object.entries({
        'package.json': '{ "name": "acme", "dependencies": { "expo": "^52.0.0" } }\n',
        'app.json': '{ "expo": { "name": "Acme", "slug": "acme" } }\n',
        'store.config.json': JSON.stringify({
          configVersion: 0,
          apple: {
            copyright: '2026 Acme',
            categories: ['PRODUCTIVITY', 'BUSINESS'],
            advisory: { gambling: false, violenceCartoonOrFantasy: 'NONE' },
            info: {
              'en-US': {
                title: 'Acme App',
                subtitle: 'Old subtitle',
                description: 'A description that is long enough.',
                privacyChoicesUrl: 'https://acme.example/choices',
              },
            },
          },
        }),
      }),
    );
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    await t.sync(id);
    assert.equal((await t.refresh(id)).body.found, true);
    let s = statuses((await t.drift(id)).body);
    assert.deepEqual(s, {
      categories: 'identical',
      ageRating: 'identical',
      privacy: 'identical',
      details: 'identical',
      media: 'not-comparable',
    });

    // The advisory answers differ: a difference, and the media still cannot be compared (EAS Metadata has no screenshots).
    const text = String(t.repo.files.get('store.config.json')).replace(
      '"gambling":false',
      '"gambling":true',
    );
    t.repo.files.set('store.config.json', text);
    await t.refresh(id);
    s = statuses((await t.drift(id)).body);
    assert.equal(s.ageRating, 'differs');
    assert.equal(s.media, 'not-comparable');
  },
);

dbTest('Google Play drift compares image counts per type from the supply folders', async (db) => {
  const t = await bootListing(db);
  t.repo.files = new Map(
    Object.entries({
      'fastlane/Fastfile': 'lane :release do\n  upload_to_play_store\nend\n',
      'fastlane/metadata/android/en-US/title.txt': 'Acme Play\n',
      'fastlane/metadata/android/en-US/short_description.txt': 'Short play text\n',
      'fastlane/metadata/android/en-US/images/phoneScreenshots/1.png': 'x',
      'fastlane/metadata/android/en-US/images/phoneScreenshots/2.png': 'x',
      'fastlane/metadata/android/en-US/images/icon.png': 'x',
    }),
  );
  const { repositoryId } = await t.connect();
  const id = await t.addAndroid({ repositoryId });
  t.stores.android.listing = playListing(
    { 'en-US': { title: 'Acme Play', shortDescription: 'Short play text' } },
    {
      media: {
        screenshots: { 'en-US': [{ type: 'phoneScreenshots', count: 2 }] },
        graphics: { 'en-US': [{ type: 'icon', count: 1 }] },
      },
    },
  );
  await t.sync(id);
  await t.refresh(id);
  assert.equal(statuses((await t.drift(id)).body).media, 'identical');
  t.repo.files.set('fastlane/metadata/android/en-US/images/phoneScreenshots/3.png', 'x');
  await t.refresh(id);
  const d = (await t.drift(id)).body;
  assert.equal(statuses(d).media, 'differs');
  assert.ok(
    d.sections
      .find((x: { name: string }) => x.name === 'media')
      .compare.details.some((l: string) => /phoneScreenshots: store 2, repository 3/.test(l)),
  );
});

// ---------------------------------------------------------------------------------------------
// Pull stays text only

dbTest(
  'pulling a store listing into the repository never touches categories, the age rating or screenshots',
  async (db) => {
    const t = await bootListing(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.repo.files.set(PRIMARY, 'Games\n');
    t.repo.files.set(RATING, '{ "gambling": true }\n');
    t.repo.files.set('fastlane/screenshots/en-US/1.png', 'x');
    t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
    await t.sync(id);
    await t.refresh(id);
    // The store changes a text and every section; the pull is a draft of the text only.
    t.stores.ios.listing = iosListing(
      { 'en-US': { ...EN_US, subtitle: 'Fresh from the store' } },
      iosSections({
        categories: { primary: 'FINANCE' },
        ageRating: { rating: 'NINE_PLUS', answers: { gambling: false } },
      }),
    );
    await t.sync(id);
    const res = await t.call(t.owner, 'POST', `/apps/${id}/listing/pull`, {});
    assert.equal(res.status, 201, res.text);
    const paths = res.body.changeSet.files.map((f: { path: string }) => f.path);
    assert.deepEqual(paths, ['fastlane/metadata/en-US/subtitle.txt']);
    assert.ok(!paths.some((p: string) => /category|rating|screenshots|copyright/i.test(p)));
    assert.ok(
      !JSON.stringify(res.body).includes('FINANCE'),
      'a section value is nowhere in the draft',
    );

    // A section cannot be asked for either.
    const asked = await t.call(t.owner, 'POST', `/apps/${id}/listing/pull`, {
      fields: ['categories', 'ageRating', 'media'],
    });
    assert.equal(asked.status, 422, asked.text);
    assert.equal(asked.body.error, 'invalid_field');
    const askedItem = await t.call(t.owner, 'POST', `/apps/${id}/listing/pull`, {
      items: [{ locale: 'en-US', field: 'categories' }],
    });
    assert.equal(askedItem.status, 422, askedItem.text);
    assert.equal(askedItem.body.error, 'invalid_field');
  },
);

// ---------------------------------------------------------------------------------------------
// Rights, isolation, the registry

dbTest('every role reads the sections; another workspace sees nothing of them', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
  await t.sync(id);
  const viewer = await t.addMember('viewer');
  for (const cookie of [viewer, t.owner]) {
    const live = await t.live(id, cookie);
    assert.equal(live.status, 200);
    assert.equal(live.body.channels[0].sections.categories.primary, 'PRODUCTIVITY');
    const d = await t.drift(id, cookie);
    assert.equal(d.status, 200);
    assert.equal(d.body.sections.length, 5);
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const path of ['live', 'drift']) {
    const mine = await t.call(outsider, 'GET', `/apps/${id}/listing/${path}`, undefined, 'other');
    assert.equal(mine.status, 404);
    const foreign = await t.call(outsider, 'GET', `/apps/${id}/listing/${path}`);
    assert.equal(foreign.status, 404);
    assert.ok(!foreign.text.includes('PRODUCTIVITY') && !mine.text.includes('PRODUCTIVITY'));
  }
  // No route writes sections: the views take no body and nothing else is offered.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await t.call(t.owner, method, `/apps/${id}/listing/sections`);
    assert.ok([404, 405].includes(res.status), `${method} is ${res.status}`);
  }
});

dbTest('deleting an app deletes its section snapshots too', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
  await t.sync(id);
  assert.ok((await sectionRows(t, id)).length > 0);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${id}`)).status, 204);
  assert.equal((await t.rows(id)).length, 0);
  assert.equal(
    (await db.query('SELECT app_id FROM app_listing_status WHERE app_id = ?', [id])).length,
    0,
  );
});

test('the API registry describes the new fields of the read-only listing operations', () => {
  const live = operations.find((o) => o.id === 'getLiveListing');
  const drift = operations.find((o) => o.id === 'getListingDrift');
  assert.ok(live && drift);
  assert.equal(live.risk, 'read');
  assert.equal(drift.risk, 'read');
  assert.match(live.description ?? '', /warnings/);
  assert.match(live.description ?? '', /schedule/);
  assert.match(live.description ?? '', /sections/);
  assert.match(live.description ?? '', /never pulled into a repository/i);
  assert.match(drift.description ?? '', /not-comparable/);
});
