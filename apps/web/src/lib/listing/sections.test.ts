import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListingSchedule, SectionDrift } from '../types.ts';
import {
  ageRatingLabel,
  ageRatingRows,
  categoryRows,
  cleanWarnings,
  detailRows,
  deviceLabel,
  humanize,
  intervalText,
  lastAttemptText,
  mediaRows,
  mediaSummary,
  orderedSections,
  PLAY_LIMITS_NOTE,
  privacyRows,
  READ_ONLY_NOTE,
  releaseNoteRows,
  scheduleView,
  sectionStatusExplanation,
  sectionStatusLabel,
  sectionStatusTone,
  sectionsSummary,
  timeAhead,
  valueRows,
} from './sections.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;

const section = (
  name: SectionDrift['name'],
  status: SectionDrift['compare']['status'],
): SectionDrift => ({
  name,
  store: null,
  storeObservedAt: null,
  repo: null,
  repoObservedAt: null,
  compare: { status, details: [] },
});

test('the status words say what they mean, and every status has a tone', () => {
  for (const status of [
    'identical',
    'differs',
    'missing-in-repo',
    'missing-in-store',
    'not-comparable',
    'not-read',
  ] as const) {
    assert.ok(sectionStatusLabel(status).length > 0);
    assert.ok(sectionStatusExplanation(status).length > 10);
    assert.ok(
      ['neutral', 'ok', 'bad', 'warn', 'info', 'accent'].includes(sectionStatusTone(status)),
    );
  }
  assert.equal(sectionStatusLabel('not-comparable'), 'Not comparable');
  assert.equal(sectionStatusTone('identical'), 'ok');
  // A status a newer server sends is shown as it is, not hidden.
  assert.equal(sectionStatusLabel('brand-new' as never), 'brand-new');
  assert.equal(sectionStatusTone('brand-new' as never), 'neutral');
});

test('the notes say read-only and never pulled, and that Google Play has no categories', () => {
  assert.match(READ_ONLY_NOTE, /read-only/i);
  assert.match(READ_ONLY_NOTE, /never pulled into the repository/);
  assert.match(READ_ONLY_NOTE, /nothing on this tab changes a store/);
  assert.match(PLAY_LIMITS_NOTE, /no categories or age rating/);
});

test('orderedSections puts the sections in reading order and keeps a name it does not know last', () => {
  const list = [
    section('media', 'identical'),
    section('details', 'differs'),
    section('categories', 'identical'),
    { ...section('categories', 'identical'), name: 'future' as never },
  ];
  assert.deepEqual(
    orderedSections(list).map((s) => s.name),
    ['categories', 'details', 'media', 'future'],
  );
  assert.deepEqual(orderedSections(undefined), []);
  assert.equal(list[0]?.name, 'media', 'the input is not reordered');
});

test('sectionsSummary: how many are read and how many differ', () => {
  assert.equal(sectionsSummary(undefined), 'No sections read yet');
  assert.equal(sectionsSummary([]), 'No sections read yet');
  assert.equal(
    sectionsSummary([section('categories', 'not-read'), section('media', 'not-read')]),
    'Not read yet',
  );
  assert.equal(
    sectionsSummary([section('categories', 'identical'), section('media', 'not-read')]),
    '1 of 2 read',
  );
  assert.equal(
    sectionsSummary([section('categories', 'differs'), section('media', 'identical')]),
    '2 of 2 read, 1 differs',
  );
  assert.equal(
    sectionsSummary([section('categories', 'differs'), section('media', 'differs')]),
    '2 of 2 read, 2 differ',
  );
});

test('humanize and the labels of ids', () => {
  assert.equal(humanize('FOOD_AND_DRINK'), 'Food and drink');
  assert.equal(humanize('violenceCartoonOrFantasy'), 'Violence cartoon or fantasy');
  assert.equal(humanize('NONE'), 'None');
  assert.equal(humanize(''), '');
  assert.equal(ageRatingLabel('FOUR_PLUS'), '4+');
  assert.equal(ageRatingLabel('SEVENTEEN_PLUS'), '17+');
  assert.equal(ageRatingLabel('SOMETHING_NEW'), 'Something new');
  assert.equal(ageRatingLabel(undefined), null);
  assert.equal(ageRatingLabel(''), null);
});

test('deviceLabel knows the common device types and humanizes the rest', () => {
  assert.equal(deviceLabel('APP_IPHONE_67'), 'iPhone 6.7"');
  assert.equal(deviceLabel('IPHONE_65'), 'iPhone 6.5"');
  assert.equal(deviceLabel('APP_IPAD_PRO_3GEN_129'), 'iPad Pro 12.9"');
  assert.equal(deviceLabel('phoneScreenshots'), 'Phone');
  assert.equal(deviceLabel('tenInchScreenshots'), '10-inch tablet');
  assert.equal(deviceLabel('featureGraphic'), 'Feature graphic');
  assert.equal(deviceLabel('all'), 'All device types');
  assert.equal(deviceLabel('APP_WATCH_SERIES_7'), 'Watch series 7');
  assert.notEqual(deviceLabel('SOMETHING'), '');
});

test('categoryRows: the store beside the repository, compared the way the server compares', () => {
  const rows = categoryRows(
    { primary: 'PRODUCTIVITY', secondary: 'FOOD_AND_DRINK', primarySubcategories: ['GAMES_CARD'] },
    { primary: 'Productivity', secondary: 'Games' },
  );
  assert.deepEqual(
    rows.map((r) => [r.label, r.store, r.repo, r.differs]),
    [
      ['Primary category', 'Productivity', 'Productivity', false],
      ['Secondary category', 'Food and drink', 'Games', true],
      ['Primary subcategory 1', 'Games card', null, false],
    ],
  );
  assert.equal(rows[0]?.raw, 'PRODUCTIVITY');
  // "Food & Drink" and FOOD_AND_DRINK are one category.
  assert.equal(
    categoryRows({ primary: 'FOOD_AND_DRINK' }, { primary: 'Food & Drink' })[0]?.differs,
    false,
  );
  // No repository value (not read, or not expressible): nothing differs, the repository column is empty.
  const alone = categoryRows({ primary: 'GAMES' }, undefined);
  assert.deepEqual(
    alone.map((r) => [r.store, r.repo, r.differs]),
    [['Games', null, false]],
  );
  assert.deepEqual(categoryRows(undefined, undefined), []);
  assert.deepEqual(categoryRows({}, {}), []);
});

test("ageRatingRows: the rating, then each answer; fastlane's legacy numbers are read as the API words", () => {
  const rows = ageRatingRows(
    {
      rating: 'FOUR_PLUS',
      answers: {
        violenceCartoonOrFantasy: 'NONE',
        gambling: false,
        profanityOrCrudeHumor: 'INFREQUENT_OR_MILD',
      },
    },
    { answers: { violenceCartoonOrFantasy: '0', gambling: true, onlyInRepo: 'x' } },
  );
  assert.deepEqual(
    rows.map((r) => r.label),
    [
      'Rating',
      'Gambling',
      'Only in repo',
      'Profanity or crude humor',
      'Violence cartoon or fantasy',
    ],
  );
  const by = Object.fromEntries(rows.map((r) => [r.raw ?? r.label, r]));
  assert.equal(by.FOUR_PLUS?.store, '4+');
  assert.equal(by.gambling?.store, 'No');
  assert.equal(by.gambling?.repo, 'Yes');
  assert.equal(by.gambling?.differs, true);
  assert.equal(by.violenceCartoonOrFantasy?.differs, false, '0 is NONE');
  assert.equal(by.violenceCartoonOrFantasy?.repo, 'None');
  assert.equal(by.profanityOrCrudeHumor?.repo, null);
  assert.equal(by.onlyInRepo?.store, null);
  assert.equal(
    by.onlyInRepo?.differs,
    false,
    'a key the store does not report is not a difference',
  );
  assert.deepEqual(ageRatingRows(undefined, undefined), []);
  assert.deepEqual(ageRatingRows({ answers: {} }, undefined), []);
});

test('privacyRows and detailRows', () => {
  const rows = privacyRows(
    { choicesUrls: { 'en-US': 'https://a.example/choices', 'de-DE': 'https://a.example/de' } },
    { choicesUrls: { 'en-US': ' https://a.example/choices ', 'fr-FR': 'https://a.example/fr' } },
  );
  assert.deepEqual(
    rows.map((r) => [r.label, r.store, r.repo, r.differs]),
    [
      ['de-DE', 'https://a.example/de', null, false],
      ['en-US', 'https://a.example/choices', ' https://a.example/choices ', false],
      ['fr-FR', null, 'https://a.example/fr', false],
    ],
  );
  assert.equal(
    privacyRows(
      { choicesUrls: { 'en-US': 'https://a' } },
      { choicesUrls: { 'en-US': 'https://b' } },
    )[0]?.differs,
    true,
  );
  assert.deepEqual(privacyRows({ choicesUrls: {} }, undefined), []);

  assert.deepEqual(
    detailRows(
      { copyright: '2026 Acme', defaultLanguage: 'en-US' },
      { copyright: '2025 Acme' },
    ).map((r) => [r.label, r.store, r.repo, r.differs]),
    [
      ['Copyright', '2026 Acme', '2025 Acme', true],
      ['Default language', 'en-US', null, false],
    ],
  );
  assert.deepEqual(detailRows({}, {}), []);
});

test('valueRows routes by section and ignores the ones that have their own shape', () => {
  assert.equal(valueRows('categories', { primary: 'GAMES' }, null).length, 1);
  assert.equal(valueRows('privacy', { choicesUrls: { 'en-US': 'u' } }, null).length, 1);
  assert.equal(valueRows('media', { screenshots: {} }, null).length, 0);
  assert.equal(valueRows('releaseNotes', { tracks: {} }, null).length, 0);
  assert.equal(valueRows('categories', null, null).length, 0);
});

test('mediaRows for iOS: sets per device type from the store, one compared total per locale', () => {
  const store = {
    screenshots: {
      'en-US': [
        { type: 'APP_IPHONE_67', count: 3 },
        { type: 'APP_IPAD_PRO_3GEN_129', count: 2 },
      ],
      'de-DE': [{ type: 'APP_IPHONE_67', count: 3 }],
    },
    previews: { 'en-US': [{ type: 'IPHONE_67', count: 1 }] },
  };
  const repo = {
    screenshots: { 'en-US': [{ type: 'all', count: 5 }], 'de-DE': [{ type: 'all', count: 2 }] },
  };
  const rows = mediaRows(store, repo, 'ios');
  const totals = rows.filter((r) => r.compared);
  assert.deepEqual(
    totals.map((r) => [r.locale, r.store, r.repo, r.differs]),
    [
      ['de-DE', 3, 2, true],
      ['en-US', 5, 5, false],
    ],
  );
  // The device rows are the store's alone: the repository does not say which device a file is for.
  const phone = rows.find((r) => r.locale === 'en-US' && r.type === 'APP_IPHONE_67');
  assert.equal(phone?.device, 'iPhone 6.7"');
  assert.equal(phone?.repo, null);
  assert.equal(phone?.compared, false);
  const preview = rows.find((r) => r.kind === 'Previews');
  assert.deepEqual([preview?.locale, preview?.store, preview?.compared], ['en-US', 1, false]);
});

test('mediaRows: a repository that cannot say, or that has no media at all, is not a difference', () => {
  const store = { screenshots: { 'en-US': [{ type: 'APP_IPHONE_67', count: 3 }] } };
  const unknown = mediaRows(store, undefined, 'ios');
  assert.ok(unknown.every((r) => r.repo === null && !r.differs && !r.compared));
  const empty = mediaRows(store, { screenshots: {} }, 'ios');
  assert.deepEqual(
    empty.filter((r) => r.compared).map((r) => [r.store, r.repo, r.differs]),
    [[3, 0, false]],
  );
  assert.deepEqual(mediaRows(undefined, undefined, 'ios'), []);
  // The repository only: a locale the store does not have.
  const repoOnly = mediaRows(
    { screenshots: {} },
    { screenshots: { 'fr-FR': [{ type: 'all', count: 2 }] } },
    'ios',
  );
  assert.deepEqual(
    repoOnly.map((r) => [r.locale, r.store, r.repo, r.differs]),
    [['fr-FR', 0, 2, false]],
  );
});

test('mediaRows for Android: each image type is compared; graphics too', () => {
  const store = {
    screenshots: {
      'en-US': [
        { type: 'phoneScreenshots', count: 4 },
        { type: 'tenInchScreenshots', count: 1 },
      ],
    },
    graphics: { 'en-US': [{ type: 'icon', count: 1 }] },
  };
  const repo = {
    screenshots: {
      'en-US': [
        { type: 'phoneScreenshots', count: 3 },
        { type: 'sevenInchScreenshots', count: 2 },
      ],
    },
    graphics: { 'en-US': [{ type: 'icon', count: 1 }] },
  };
  const rows = mediaRows(store, repo, 'android');
  const by = Object.fromEntries(rows.map((r) => [r.type, r]));
  assert.deepEqual(
    [by.phoneScreenshots?.store, by.phoneScreenshots?.repo, by.phoneScreenshots?.differs],
    [4, 3, true],
  );
  assert.deepEqual(
    [by.tenInchScreenshots?.store, by.tenInchScreenshots?.repo, by.tenInchScreenshots?.differs],
    [1, 0, true],
  );
  assert.deepEqual(
    [
      by.sevenInchScreenshots?.store,
      by.sevenInchScreenshots?.repo,
      by.sevenInchScreenshots?.differs,
    ],
    [0, 2, true],
  );
  assert.deepEqual([by.icon?.kind, by.icon?.differs, by.icon?.device], ['Graphics', false, 'Icon']);
  assert.ok(rows.every((r) => r.compared));
  // No repository media: counts of the store, nothing marked.
  const alone = mediaRows(store, undefined, 'android');
  assert.ok(alone.every((r) => r.repo === null && !r.differs));
});

test('mediaSummary: counts in words, and says when the read was cut short', () => {
  assert.equal(mediaSummary(undefined), 'Not read yet');
  assert.equal(
    mediaSummary({
      screenshots: { 'en-US': [{ type: 'a', count: 3 }], 'de-DE': [{ type: 'a', count: 1 }] },
      previews: { 'en-US': [{ type: 'p', count: 1 }] },
    }),
    '4 screenshots, 1 preview in 2 locales',
  );
  assert.equal(
    mediaSummary({ screenshots: { 'en-US': [{ type: 'phoneScreenshots', count: 1 }] } }),
    '1 screenshot in 1 locale',
  );
  assert.match(
    mediaSummary({ screenshots: {}, truncated: true }),
    /left out to stay within the read limits/,
  );
});

test('releaseNoteRows: per track, with the notes per language, long notes cut', () => {
  assert.deepEqual(releaseNoteRows(undefined), []);
  const rows = releaseNoteRows({
    tracks: {
      production: {
        versionCodes: ['42', '43'],
        status: 'completed',
        notes: { 'en-US': 'Bug fixes', 'de-DE': 'x'.repeat(500) },
      },
      beta: { name: 'Open beta', versionCodes: [], notes: {} },
    },
  });
  assert.deepEqual(
    rows.map((r) => r.track),
    ['beta', 'production'],
  );
  assert.equal(rows[0]?.meta, 'Open beta');
  assert.equal(rows[1]?.meta, 'Completed · version 42, 43');
  assert.deepEqual(
    rows[1]?.notes.map((n) => n.language),
    ['de-DE', 'en-US'],
  );
  assert.equal(rows[1]?.notes[0]?.text.length, 401);
  assert.ok(rows[1]?.notes[0]?.text.endsWith('…'));
});

test('intervalText and timeAhead', () => {
  assert.equal(intervalText(30), '30 minutes');
  assert.equal(intervalText(60), 'hour');
  assert.equal(intervalText(180), '3 hours');
  assert.equal(intervalText(1440), 'day');
  assert.equal(intervalText(2880), '2 days');
  assert.equal(timeAhead(NOW + 10_000, NOW), 'in under a minute');
  assert.equal(timeAhead(NOW - 10_000, NOW), 'in under a minute');
  assert.equal(timeAhead(NOW + 12 * MINUTE, NOW), 'in 12 minutes');
  assert.equal(timeAhead(NOW + 60 * MINUTE, NOW), 'in 1 hour');
  assert.equal(timeAhead(NOW + 3 * HOUR, NOW), 'in 3 hours');
  assert.equal(timeAhead(NOW + 72 * HOUR, NOW), 'in 3 days');
});

test('scheduleView: unknown, off, on, and backing off after failures', () => {
  assert.equal(scheduleView(undefined, NOW).state, 'unknown');
  const off: ListingSchedule = {
    enabled: false,
    intervalMinutes: 0,
    lastAttemptAt: null,
    failures: 0,
    nextReadAt: null,
  };
  const offView = scheduleView(off, NOW);
  assert.equal(offView.state, 'off');
  assert.equal(offView.headline, 'Scheduled reads are off');
  assert.match(offView.detail, /KILN_LISTING_INTERVAL_MINUTES/);
  assert.match(offView.detail, /synced or refreshed/);

  const on: ListingSchedule = {
    enabled: true,
    intervalMinutes: 60,
    lastAttemptAt: NOW - HOUR,
    failures: 0,
    nextReadAt: NOW + 20 * MINUTE,
  };
  assert.deepEqual(scheduleView(on, NOW), {
    state: 'on',
    headline: 'Read automatically every hour',
    detail: 'Next read: in 20 minutes.',
  });
  assert.equal(
    scheduleView({ ...on, nextReadAt: null }, NOW).detail,
    'Next read: the next scheduler pass.',
  );
  assert.equal(
    scheduleView({ ...on, nextReadAt: NOW - MINUTE }, NOW).detail,
    'Next read: the next scheduler pass.',
  );

  const failing = scheduleView({ ...on, failures: 3, nextReadAt: NOW + 4 * HOUR }, NOW);
  assert.equal(failing.state, 'backing-off');
  assert.match(failing.detail, /last 3 attempts failed/);
  assert.match(failing.detail, /in 4 hours/);
  assert.match(scheduleView({ ...on, failures: 1 }, NOW).detail, /last attempt failed/);
});

test('lastAttemptText', () => {
  assert.equal(lastAttemptText(undefined, NOW), null);
  assert.equal(
    lastAttemptText(
      { enabled: false, intervalMinutes: 0, lastAttemptAt: null, failures: 0, nextReadAt: null },
      NOW,
    ),
    null,
  );
  assert.match(
    lastAttemptText(
      {
        enabled: true,
        intervalMinutes: 60,
        lastAttemptAt: NOW - 5 * MINUTE,
        failures: 0,
        nextReadAt: null,
      },
      NOW,
    ) ?? '',
    /5/,
  );
});

test('cleanWarnings: no blanks, no repeats, at most twenty, nothing that is not text', () => {
  assert.deepEqual(cleanWarnings(undefined), []);
  assert.deepEqual(cleanWarnings(['  a  ', 'a', '', '   ', 'b', 5 as never]), ['a', 'b']);
  assert.equal(cleanWarnings(Array.from({ length: 50 }, (_, i) => `w${i}`)).length, 20);
});
