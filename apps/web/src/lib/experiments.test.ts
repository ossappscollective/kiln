import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appStoreConnectUrl,
  assetsText,
  dateRangeText,
  type ExperimentLocale,
  localesText,
  type NoteInput,
  noteDateText,
  playListingUrl,
  runningByDates,
  stateBadge,
  sumAssets,
  syncLine,
  trafficText,
  treatmentLine,
  validateNote,
} from './experiments.ts';

const NOW = Date.UTC(2026, 10, 22, 12);
const locale = (code: string, screenshots: number, previews = 0): ExperimentLocale => ({
  locale: code,
  ref: code,
  assets: { screenshots, previews, other: 0, screenshotSets: 0 },
  hasPromotionalText: null,
});

test('every state has a word and a tone; unknown stays neutral', () => {
  assert.deepEqual(stateBadge('approved'), { label: 'Approved', tone: 'ok' });
  assert.deepEqual(stateBadge('in_review'), { label: 'In review', tone: 'info' });
  assert.deepEqual(stateBadge('rejected'), { label: 'Rejected', tone: 'bad' });
  assert.equal(stateBadge('stopped').tone, 'warn');
  assert.equal(stateBadge('unknown').label, 'Unknown');
  assert.equal(stateBadge('whatever' as never).tone, 'neutral');
});

test('an approved test is running only inside its dates', () => {
  const day = 86_400_000;
  assert.equal(runningByDates({ state: 'approved', startsAt: NOW - day, endsAt: null }, NOW), true);
  assert.equal(
    runningByDates({ state: 'approved', startsAt: NOW - 2 * day, endsAt: NOW - day }, NOW),
    false,
  );
  assert.equal(
    runningByDates({ state: 'approved', startsAt: NOW + day, endsAt: null }, NOW),
    false,
  );
  assert.equal(runningByDates({ state: 'approved', startsAt: null, endsAt: null }, NOW), false);
  assert.equal(runningByDates({ state: 'stopped', startsAt: NOW - day, endsAt: null }, NOW), false);
});

test('dates, traffic and media are said in words', () => {
  assert.equal(dateRangeText({ startsAt: null, endsAt: null }), 'Not started');
  assert.match(dateRangeText({ startsAt: Date.UTC(2026, 9, 1, 12), endsAt: null }), /^Since /);
  assert.match(
    dateRangeText({ startsAt: Date.UTC(2026, 9, 1, 12), endsAt: Date.UTC(2026, 11, 30, 12) }),
    / to /,
  );
  assert.equal(trafficText(30), '30%');
  assert.equal(trafficText(null), 'Unknown');
  assert.equal(
    assetsText({ screenshots: 0, previews: 0, other: 0, screenshotSets: 0 }),
    'No media read',
  );
  assert.equal(
    assetsText({ screenshots: 1, previews: 2, other: 5, screenshotSets: 0 }),
    '1 screenshot, 2 previews',
  );
  assert.equal(
    assetsText({ screenshots: 0, previews: 0, other: 2, screenshotSets: 3 }),
    '2 other assets',
  );
  assert.equal(
    assetsText({ screenshots: 0, previews: 0, other: 0, screenshotSets: 1 }),
    '1 screenshot set',
  );
  assert.deepEqual(sumAssets([locale('en-US', 2, 1), locale('fr-FR', 3)]), {
    screenshots: 5,
    previews: 1,
    other: 0,
    screenshotSets: 0,
  });
  assert.equal(
    treatmentLine({
      id: 't',
      name: 'B',
      iconName: 'blue',
      promotedAt: null,
      locales: [locale('en-US', 2)],
    }),
    'icon blue · 1 language · 2 screenshots',
  );
  assert.equal(
    treatmentLine({ id: 't', name: 'B', iconName: null, promotedAt: null, locales: [] }),
    '0 languages',
  );
  assert.equal(localesText([]), 'None');
  assert.equal(localesText([{ locale: 'en-US' }, { locale: 'fr-FR' }]).includes('en-US'), true);
  assert.match(
    localesText([
      { locale: 'a' },
      { locale: 'b' },
      { locale: 'c' },
      { locale: 'd' },
      { locale: 'e' },
    ]),
    /and 2 more$/,
  );
});

test('the sync line says never, failed with and without a copy, partial and read', () => {
  const base = {
    lastAttemptAt: 1,
    lastSyncedAt: NOW - 60_000,
    lastError: null,
    failures: 0,
    experimentCount: 1,
    pageCount: 1,
    complete: true,
    warnings: [],
  };
  assert.equal(syncLine(null, NOW).tone, 'neutral');
  assert.match(syncLine(null, NOW).text, /^Not read yet/);
  assert.equal(syncLine({ ...base, lastSyncedAt: null, lastError: 'boom' }, NOW).tone, 'bad');
  assert.match(
    syncLine({ ...base, lastError: 'boom' }, NOW).text,
    /Showing what was read .* boom$/,
  );
  assert.equal(syncLine({ ...base, complete: false }, NOW).tone, 'warn');
  assert.match(syncLine(base, NOW).text, /^Read /);
});

test('addresses are built only from valid parts', () => {
  assert.equal(
    appStoreConnectUrl('1234567890'),
    'https://appstoreconnect.apple.com/apps/1234567890',
  );
  assert.equal(appStoreConnectUrl(null), null);
  assert.equal(appStoreConnectUrl('12a'), null);
  assert.equal(
    playListingUrl('com.acme.app', 'spring-2026'),
    'https://play.google.com/store/apps/details?id=com.acme.app&listing=spring-2026',
  );
  assert.equal(playListingUrl('com.acme.app', 'Bad Value'), null);
  assert.equal(playListingUrl('com.acme.app', null), null);
  assert.equal(playListingUrl('', 'ok'), null);
});

test('a note date keeps its day whatever the time zone', () => {
  assert.equal(noteDateText(null), null);
  assert.match(noteDateText('2026-11-01') ?? '', /1/);
  assert.match(noteDateText('2026-11-01') ?? '', /2026/);
  assert.equal(noteDateText('soon'), 'soon');
});

test('a note is checked as the server checks it', () => {
  const ok: NoteInput = {
    kind: 'experiment',
    name: 'Icon',
    status: 'planned',
    startedOn: null,
    endedOn: null,
    url: null,
    listing: null,
    note: '',
  };
  assert.deepEqual(validateNote(ok), {});
  assert.ok(validateNote({ ...ok, name: '  ' }).name);
  assert.ok(validateNote({ ...ok, name: 'x'.repeat(121) }).name);
  assert.ok(validateNote({ ...ok, startedOn: '2026-11-05', endedOn: '2026-11-01' }).endedOn);
  assert.deepEqual(validateNote({ ...ok, startedOn: '2026-11-01', endedOn: '2026-11-01' }), {});
  assert.ok(validateNote({ ...ok, url: 'javascript:alert(1)' }).url);
  assert.ok(validateNote({ ...ok, url: 'not a url' }).url);
  assert.deepEqual(validateNote({ ...ok, url: 'https://play.google.com/console/' }), {});
  assert.ok(validateNote({ ...ok, listing: 'Has Capitals' }).listing);
  assert.deepEqual(validateNote({ ...ok, listing: 'spring_2026.v1~x' }), {});
  assert.ok(validateNote({ ...ok, note: 'x'.repeat(2001) }).note);
});
