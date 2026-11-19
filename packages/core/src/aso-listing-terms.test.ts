import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listingRows, listingTerms, significantWords, trackingOf } from './aso-listing-terms.ts';

const ios = (fields: Parameters<typeof listingTerms>[0]['fields'], locale = 'en-US') =>
  listingTerms({ platform: 'ios', locale, fields });
const find = (r: ReturnType<typeof ios>, term: string) => r.terms.find((t) => t.term === term);

test('significant words: no stop words, short words or numbers, each once, plurals folded', () => {
  assert.deepEqual(
    significantWords('The Water Tracker for 2 waters, and a Tracker', 'en').map((w) => w.term),
    ['water', 'tracker'],
  );
  assert.deepEqual(significantWords(undefined, 'en'), []);
  assert.deepEqual(
    significantWords('Wasser und Sport', 'de').map((w) => w.term),
    ['wasser', 'sport'],
  );
});

test('App Store: the keyword field split on commas, with bytes, then the words of name and subtitle', () => {
  const r = ios({
    title: 'Hydro Buddy',
    subtitle: 'Water reminder',
    keywords: 'habit, hydration,drink log',
  });
  assert.deepEqual(
    r.terms.map((t) => [t.term, t.sources.join('+'), t.set]),
    [
      ['habit', 'keywords', true],
      ['hydration', 'keywords', true],
      ['drink log', 'keywords', true],
      ['hydro', 'title', false],
      ['buddy', 'title', false],
      ['water', 'subtitle', false],
      ['reminder', 'subtitle', false],
    ],
  );
  assert.equal(r.extracted, false);
  assert.equal(r.keywordField?.bytes, 'habit, hydration,drink log'.length);
  assert.equal(r.keywordField?.limit, 100);
  assert.equal(r.keywordField?.remaining, 100 - 26);
  assert.equal(r.keywordField?.entries, 3);
  assert.equal(r.keywordField?.wastedBytes, 1, 'the space after a comma');
});

test('App Store: wasted entries use the keyword budget logic, repeats across fields are marked once', () => {
  const r = ios({
    title: 'Water Tracker',
    subtitle: 'Hydration notes',
    keywords: 'tracker, habit,habits,habit,hydration,sleep',
  });
  const tracker = find(r, 'tracker');
  assert.deepEqual(tracker?.sources, ['keywords', 'title']);
  assert.equal(tracker?.waste, 'in_title_or_subtitle');
  assert.equal(tracker?.duplicate, false, 'already waste, not marked twice');
  // `habits` and the second `habit` are one entry here, with the repeats counted.
  const habit = find(r, 'habit');
  assert.equal(habit?.entries, 3);
  assert.equal(habit?.waste, 'plural_variant');
  assert.equal(find(r, 'sleep')?.waste, null);
  // Hydration is in the subtitle and in the keyword field: waste (it is an entry the subtitle holds).
  assert.equal(find(r, 'hydration')?.waste, 'in_title_or_subtitle');
  // A word of the name and the subtitle that is not in the keyword field is a plain repeat across fields.
  const both = ios({ title: 'Water Tracker', subtitle: 'Water notes', keywords: 'sleep' });
  assert.equal(find(both, 'water')?.duplicate, true);
  assert.equal(find(both, 'water')?.waste, null);
});

test('App Store: without a keyword field there is no summary; with none of the fields there is no text', () => {
  const r = ios({ title: 'Hydro Buddy' });
  assert.equal(r.keywordField, null);
  assert.equal(r.hasText, true);
  assert.equal(ios({}).hasText, false);
  assert.equal(ios({ keywords: '' }).keywordField?.entries, 0);
});

test('bytes count characters outside ASCII as bytes', () => {
  const r = ios({ keywords: 'wasser,übung' }, 'de-DE');
  assert.equal(r.keywordField?.bytes, 'wasser,übung'.length + 1);
});

test('Google Play: no keyword field, terms are extracted from title and short description', () => {
  const r = listingTerms({
    platform: 'android',
    locale: 'en-US',
    fields: {
      title: 'Hydro Buddy: Water',
      shortDescription: 'Water reminder and habit log',
      description: 'Track water every day. Water goals, water stats, water log.',
    },
  });
  assert.equal(r.extracted, true);
  assert.equal(r.keywordField, null);
  assert.deepEqual(
    r.terms.map((t) => [t.term, t.sources.join('+')]),
    [
      ['hydro', 'title'],
      ['buddy', 'title'],
      ['water', 'title+shortDescription'],
      ['reminder', 'shortDescription'],
      ['habit', 'shortDescription'],
      ['log', 'shortDescription'],
    ],
  );
  assert.equal(r.terms.find((t) => t.term === 'water')?.duplicate, true);
  assert.equal(
    r.terms.every((t) => t.waste === null && !t.set),
    true,
    'no waste is claimed for Play',
  );
});

test('Google Play: frequent words of the full description only when asked', () => {
  const fields = {
    title: 'Hydro Buddy',
    shortDescription: 'Reminder',
    description: 'Track water every day. Water goals, water stats, sleep log, sleep goals.',
  };
  const base = { platform: 'android' as const, locale: 'en-US', fields };
  assert.equal(
    listingTerms(base).terms.some((t) => t.sources.includes('description')),
    false,
  );
  const more = listingTerms({ ...base, options: { includeDescription: true } });
  const water = more.terms.find((t) => t.term === 'water');
  assert.deepEqual(water?.sources, ['description']);
  assert.equal(water?.occurrences, 3);
  assert.equal(
    more.terms.some((t) => t.term === 'sleep'),
    false,
    'twice is not frequent',
  );
  // The App Store does not search the description, so the option does nothing there.
  assert.equal(
    listingTerms({
      platform: 'ios',
      locale: 'en-US',
      fields,
      options: { includeDescription: true },
    }).terms.some((t) => t.sources.includes('description')),
    false,
  );
});

test('tracking: matched by locale, storefront and folded words; the rank is the one today', () => {
  const tracked = [
    { id: 'a', term: 'Habit', country: 'us', locale: 'en-US', state: 'ranked' as const, rank: 7 },
    {
      id: 'b',
      term: 'sleep',
      country: 'us',
      locale: 'en',
      state: 'not_ranked' as const,
      rank: null,
    },
    { id: 'c', term: 'water', country: 'gb', locale: 'en-GB', state: 'ranked' as const, rank: 2 },
  ];
  assert.deepEqual(trackingOf({ key: 'habit' }, 'en-US', 'us', tracked), {
    tracked: true,
    keywordId: 'a',
    state: 'ranked',
    rank: 7,
  });
  assert.deepEqual(trackingOf({ key: 'habit' }, 'en-US', 'US', tracked).tracked, true);
  assert.deepEqual(trackingOf({ key: 'sleep' }, 'en-US', 'us', tracked), {
    tracked: true,
    keywordId: 'b',
    state: 'not_ranked',
    rank: null,
  });
  assert.equal(
    trackingOf({ key: 'water' }, 'en-US', 'us', tracked).tracked,
    false,
    'tracked in another storefront',
  );
  assert.equal(trackingOf({ key: 'habit' }, 'de-DE', 'de', tracked).tracked, false);
});

test('rows: one per locale, the storefront of rank tracking, untracked terms the API accepts', () => {
  const rows = listingRows({
    platform: 'ios',
    locales: [
      { locale: 'en-US', fields: { title: 'Hydro Buddy', keywords: 'habit,hydration' } },
      { locale: 'de-DE', fields: { title: 'Wasser Buddy', keywords: 'gewohnheit' } },
      { locale: 'ja', fields: { keywords: 'みず' } },
    ],
    tracked: [
      { id: 'a', term: 'habit', country: 'us', locale: 'en-US', state: 'ranked', rank: 4 },
      { id: 'b', term: 'hydration', country: 'ca', locale: 'en-US', state: null, rank: null },
      { id: 'c', term: 'hydration', country: 'ca', locale: 'en-US', state: null, rank: null },
    ],
  });
  const us = rows[0];
  // Two keywords in CA against one in US: the storefront with the most is the one in use.
  assert.equal(us?.country, 'ca');
  assert.deepEqual(us?.storefronts, ['ca', 'us']);
  assert.deepEqual(
    us?.untracked.map((t) => t.term),
    ['habit', 'hydro', 'buddy'],
  );
  assert.equal(rows[1]?.country, 'de');
  assert.equal(rows[2]?.country, 'jp');
  assert.equal(rows[2]?.trackable, true);
  const picked = listingRows({
    platform: 'ios',
    locales: [{ locale: 'en-US', fields: { keywords: 'habit' } }],
    tracked: [
      { id: 'a', term: 'habit', country: 'us', locale: 'en-US', state: 'ranked', rank: 4 },
      { id: 'b', term: 'x1', country: 'ca', locale: 'en-US' },
    ],
    countries: { 'en-US': 'ca' },
  });
  assert.equal(picked[0]?.country, 'ca');
  assert.equal(picked[0]?.untracked.length, 1);
  assert.equal(
    listingRows({ platform: 'ios', locales: [{ locale: 'x', fields: {} }], tracked: [] })[0]
      ?.trackable,
    false,
  );
});
