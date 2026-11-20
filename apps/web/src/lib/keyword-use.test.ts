import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultLocale,
  NOT_READ_TEXT,
  PLAY_DERIVED_NOTE,
  phrasesOf,
  rankText,
  searchFigures,
  usedKeywords,
  usedSummary,
  visitorsText,
} from './keyword-use.ts';

const ios = () =>
  usedKeywords({
    platform: 'ios',
    locales: [
      {
        locale: 'en-US',
        fields: {
          title: 'Water Tracker - Daily Hydration',
          subtitle: 'Drink more water',
          keywords: 'habit,sleep,water tracker',
        },
      },
      { locale: 'de-DE', fields: { title: 'Wasser', keywords: 'gewohnheit' } },
    ],
    tracked: [
      { id: 'k1', term: 'habit', country: 'us', locale: 'en-US', state: 'ranked', rank: 9 },
      { id: 'k2', term: 'sleep', country: 'us', locale: 'en-US', state: 'not_ranked', rank: null },
    ],
  });

test('App Store: keyword field entries come first, then phrases, then the words of the title and subtitle', () => {
  const en = ios()[0];
  assert.ok(en);
  assert.equal(en.derived, false);
  assert.equal(en.keywordField?.limit, 100);
  const kinds = en.keywords.map((k) => k.kind);
  assert.deepEqual(kinds.slice(0, 3), ['entry', 'entry', 'entry']);
  assert.ok(kinds.indexOf('phrase') > kinds.lastIndexOf('entry'));
  assert.ok(kinds.lastIndexOf('phrase') < kinds.indexOf('word'));
});

test('each keyword says where it appears, in words, and which listing fields to edit', () => {
  const en = ios()[0];
  const water = en?.keywords.find((k) => k.term === 'water tracker');
  assert.ok(water);
  // The keyword field entry "water tracker" is also the title phrase "Water Tracker".
  assert.equal(water.kind, 'entry');
  assert.match(water.where, /^In the /);
  assert.ok(water.fieldIds.indexOf('keywords') >= 0);
  const hydration = en?.keywords.find((k) => k.term === 'hydration');
  assert.equal(hydration?.where, 'In the title');
  assert.deepEqual(hydration?.fieldIds, ['name']);
});

test('tracked keywords show their rank; others say they are not tracked and can be tracked', () => {
  const en = ios()[0];
  assert.ok(en);
  const habit = en.keywords.find((k) => k.term === 'habit');
  assert.equal(habit?.tracked, true);
  assert.equal(habit?.rankText, 'Rank 9');
  const sleep = en.keywords.find((k) => k.term === 'sleep');
  assert.equal(sleep?.rankText, 'Not in the first 50 results');
  const hydration = en.keywords.find((k) => k.term === 'hydration');
  assert.equal(hydration?.rankText, 'Not tracked');
  assert.ok(en.untracked.some((k) => k.term === 'hydration'));
  assert.ok(en.untracked.every((k) => !k.tracked));
  assert.equal(en.trackedCount, 2);
  assert.match(usedSummary(en), /, 2 tracked$/);
});

test('rankText covers the four states and a custom depth', () => {
  assert.equal(rankText({ tracked: false, state: null, rank: null }), 'Not tracked');
  assert.equal(rankText({ tracked: true, state: null, rank: null }), 'Tracked, not checked yet');
  assert.equal(
    rankText({ tracked: true, state: 'not_ranked', rank: null }, 30),
    'Not in the first 30 results',
  );
  assert.equal(rankText({ tracked: true, state: 'ranked', rank: 3 }), 'Rank 3');
});

test('the editable fields of the locale carry their text, a counter against the limit and whether a draft push can write them', () => {
  const en = ios()[0];
  assert.ok(en);
  const byId = (id: string) => en.fields.find((f) => f.info.id === id);
  assert.equal(byId('keywords')?.meter.text, '25 of 100 bytes, 75 left');
  assert.equal(byId('keywords')?.info.stageable, true);
  assert.equal(
    byId('name')?.info.stageable,
    false,
    'the App Store name is not written by a draft push',
  );
  assert.equal(byId('subtitle')?.info.stageable, false);
  assert.equal(byId('name')?.text, 'Water Tracker - Daily Hydration');
  const de = ios()[1];
  assert.equal(de?.fields.find((f) => f.info.id === 'subtitle')?.text, '');
});

test('phrases are cut at dashes, bars and commas and keep two to four words', () => {
  assert.deepEqual(phrasesOf('Habit Tracker - Daily Routine', 'en'), [
    'Habit Tracker',
    'Daily Routine',
  ]);
  assert.deepEqual(
    phrasesOf('Tracker | Habits', 'en'),
    [],
    'single words are plain words, not phrases',
  );
  assert.deepEqual(
    phrasesOf('Plan, track and share your daily habits every day', 'en'),
    [],
    'a part of more than four words is a sentence, not a keyword phrase',
  );
  assert.deepEqual(phrasesOf('', 'en'), []);
  assert.deepEqual(phrasesOf(undefined, 'en'), []);
  assert.deepEqual(
    phrasesOf('Habit Tracker. Habit tracker!', 'en'),
    ['Habit Tracker'],
    'each once',
  );
});

type Lines = { term: string; visitors: number | null; installs: number | null }[];
const play = (extra: { searchTerms?: Lines } = {}) =>
  usedKeywords({
    platform: 'android',
    locales: [
      {
        locale: 'en-US',
        fields: {
          title: 'Water Tracker',
          shortDescription: 'Remind me to drink water and build a hydration habit',
          description:
            'Hydration matters. Track your hydration every day. A hydration reminder keeps you on track. Reminder and streak.',
        },
      },
    ],
    tracked: [
      { id: 'p1', term: 'water tracker', country: 'us', locale: 'en-US', state: 'ranked', rank: 4 },
    ],
    ...extra,
  });

test('Google Play: no keyword field, terms are derived from the title, short description and full description', () => {
  const l = play()[0];
  assert.ok(l);
  assert.equal(l.derived, true);
  assert.equal(l.keywordField, null);
  assert.match(PLAY_DERIVED_NOTE, /no keyword field/);
  const hydration = l.keywords.find((k) => k.term === 'hydration');
  assert.ok(hydration, 'a frequent word of the full description');
  assert.ok(hydration.sources.indexOf('description') >= 0);
  assert.ok(hydration.fieldIds.indexOf('full_description') >= 0);
  assert.equal(hydration.where.indexOf('description') > 0, true);
  const phrase = l.keywords.find((k) => k.term === 'Water Tracker');
  assert.equal(phrase?.tracked, true, 'the title as a phrase matches the tracked keyword');
  assert.equal(phrase?.rankText, 'Rank 4');
  assert.deepEqual(
    l.fields.map((f) => f.info.id),
    ['title', 'short_description', 'full_description'],
  );
  assert.ok(l.fields.every((f) => f.info.stageable));
});

test('imported search terms add visitors to a used keyword by its words (plurals and case ignored)', () => {
  const l = play({
    searchTerms: [
      { term: 'Hydration', visitors: 120, installs: 14 },
      { term: 'hydrations', visitors: 5, installs: null },
      { term: 'unrelated', visitors: 9, installs: 1 },
    ],
  })[0];
  const hydration = l?.keywords.find((k) => k.term === 'hydration');
  assert.deepEqual(hydration?.search, { visitors: 125, installs: 14 });
  assert.equal(visitorsText(hydration?.search ?? null), '125');
  const reminder = l?.keywords.find((k) => k.term === 'reminder');
  assert.equal(reminder?.search, null);
  assert.equal(visitorsText(null), '');
  assert.equal(
    play()[0]?.keywords.every((k) => k.search === null),
    true,
    'nothing imported: no figures, never zeros',
  );
});

test('searchFigures keeps a null when a file has no number', () => {
  const map = searchFigures([{ term: 'a b', visitors: null, installs: null }], 'en');
  assert.deepEqual(map.get('a b'), { visitors: null, installs: null });
});

test('a locale with no text is reported as having none (the empty state of the view)', () => {
  const l = usedKeywords({
    platform: 'ios',
    locales: [{ locale: 'fr-FR', fields: {} }],
    tracked: [],
  })[0];
  assert.equal(l?.hasText, false);
  assert.deepEqual(l?.keywords, []);
  assert.match(NOT_READ_TEXT, /changes nothing in the store/);
});

test('the view opens on the locale with most tracked keywords, else the first', () => {
  const locales = [{ locale: 'de-DE' }, { locale: 'en-US' }];
  assert.equal(defaultLocale(locales, []), 'de-DE');
  const tracked = [{ locale: 'en-US' }, { locale: 'en-us' }, { locale: 'de-DE' }];
  assert.equal(defaultLocale(locales, tracked), 'en-US');
  assert.equal(defaultLocale([], []), null);
});

test('storeTextOf reads a field by its listing id on either store', async () => {
  const { storeTextOf } = await import('./keyword-use.ts');
  const f = { title: 'T', subtitle: 'S', keywords: 'k', shortDescription: 'sd', description: 'd' };
  assert.equal(storeTextOf(f, 'name'), 'T');
  assert.equal(storeTextOf(f, 'title'), 'T');
  assert.equal(storeTextOf(f, 'short_description'), 'sd');
  assert.equal(storeTextOf(f, 'full_description'), 'd');
  assert.equal(storeTextOf(f, 'description'), 'd');
  assert.equal(storeTextOf(f, 'promotional_text'), '');
  assert.equal(storeTextOf({}, 'keywords'), '');
});
