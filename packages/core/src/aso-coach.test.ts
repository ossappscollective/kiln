import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CoachInput, type CoachKeyword, buildCoach, keywordFieldWaste, listingBudget, matchListingLocale, sameLocale, storefrontCombos, storefrontFor, untappedLocales, untrackedSetKeywords } from './aso-coach.ts';

const kw = (id: string, term: string, extra: Partial<CoachKeyword> = {}): CoachKeyword => ({
  id,
  term,
  country: 'us',
  locale: 'en-US',
  state: 'ranked',
  rank: 10,
  lastCheckedAt: 1000,
  change: null,
  ...extra,
});

test('keyword field: waste is exact, with a reason for each entry', () => {
  const w = keywordFieldWaste('habit, trackers ,tracker,Habit,,hydration', { title: 'Water Tracker', subtitle: 'Drink more water', language: 'en' });
  // "trackers" is the name's word (and "tracker" its variant), "Habit" repeats, the empty entry is a stray comma.
  assert.equal(w.compacted, 'habit,hydration');
  assert.equal(w.totalBytes, 'habit, trackers ,tracker,Habit,,hydration'.length - 'habit,hydration'.length);
  const reasons = w.items.map((i) => `${i.reason}:${i.text}`);
  assert.deepEqual(reasons, ['in_title_or_subtitle:trackers', 'plural_variant:tracker', 'repeated_entry:Habit', 'empty_entry:']);
});

test('keyword field: a space after a comma is a byte to give back', () => {
  const w = keywordFieldWaste('habit, hydration,  focus');
  assert.deepEqual(w.items.map((i) => [i.reason, i.text, i.bytes]), [['space', 'hydration', 1], ['space', 'focus', 2]]);
  assert.equal(w.compacted, 'habit,hydration,focus');
  assert.equal(w.totalBytes, 3);
});

test('keyword field: a plural of an earlier entry is a variant, an exact repeat is a repeat', () => {
  const w = keywordFieldWaste('habit,habits,habit', { language: 'en' });
  assert.deepEqual(w.items.map((i) => i.reason), ['plural_variant', 'repeated_entry']);
  assert.equal(w.compacted, 'habit');
  assert.equal(w.totalBytes, 'habit,habits,habit'.length - 'habit'.length);
  // Other languages are matched by exact word: no plural folding.
  assert.equal(keywordFieldWaste('hund,hunds', { language: 'de' }).compacted, 'hund,hunds');
});

test('keyword field: nothing to give back is zero, an empty field is zero', () => {
  assert.equal(keywordFieldWaste('habit,hydration').totalBytes, 0);
  assert.equal(keywordFieldWaste('').totalBytes, 0);
  assert.deepEqual(keywordFieldWaste('').items, []);
});

test('listingBudget (App Store): used against the limits, keywords by field, bytes for the keyword field', () => {
  const b = listingBudget({
    platform: 'ios',
    locale: 'en-US',
    fields: { title: 'Water Tracker', subtitle: 'Drink more water', keywords: 'habit,hydration' },
    keywords: [{ id: 'k1', term: 'water tracker' }, { id: 'k2', term: 'hydration' }, { id: 'k3', term: 'sleep' }],
  });
  assert.deepEqual(b.fields.map((f) => [f.field, f.used, f.limit, f.unit]), [
    ['title', 13, 30, 'characters'],
    ['subtitle', 16, 30, 'characters'],
    ['keywords', 15, 100, 'bytes'],
  ]);
  assert.deepEqual(b.fields[0]?.keywords.map((k) => k.id), ['k1']);
  assert.deepEqual(b.fields[2]?.keywords.map((k) => k.id), ['k2']);
  assert.deepEqual(b.missing.map((m) => m.term), ['sleep']);
  assert.equal(b.fields[0]?.percent, 43);
  assert.equal(b.fields[0]?.over, false);
});

test('listingBudget: bytes are not characters for the keyword field, and over the limit is said', () => {
  const b = listingBudget({ platform: 'ios', locale: 'de-DE', fields: { keywords: 'übung'.repeat(20) }, keywords: [] });
  const f = b.fields.find((x) => x.field === 'keywords');
  assert.equal(f?.used, 120);
  assert.equal(f?.over, true);
  assert.equal(f?.remaining, -20);
  assert.equal(f?.percent, 100);
});

test('listingBudget: a word in the name and again in the subtitle or keyword field is a repeat with its cost', () => {
  const b = listingBudget({
    platform: 'ios',
    locale: 'en-US',
    fields: { title: 'Water Tracker', subtitle: 'Track water daily', keywords: 'water bottle,hydration' },
    keywords: [{ id: 'k1', term: 'water' }],
  });
  const water = b.repeated.find((r) => r.word === 'water');
  assert.deepEqual(water?.fields, ['title', 'subtitle', 'keywords']);
  assert.equal(water?.tracked, true);
  assert.equal(water?.severity, 'waste');
  // 5 characters in the subtitle, 5 and a comma in the keyword field.
  assert.equal(water?.wastedCharacters, 11);
  assert.equal(b.wastedTotal, b.repeated.reduce((n, r) => n + r.wastedCharacters, 0) + (b.keywordField?.totalBytes ?? 0));
});

test('listingBudget: an entry the keyword field wastes is not counted again as a repeated word', () => {
  const b = listingBudget({ platform: 'ios', locale: 'en-US', fields: { title: 'Water Tracker', subtitle: '', keywords: 'tracker,hydration' }, keywords: [] });
  assert.equal(b.keywordField?.totalBytes, 'tracker,'.length);
  assert.equal(b.repeated.length, 0);
  assert.equal(b.wastedTotal, 8);
});

test('listingBudget: terms that belong to no tracked keyword, only while something is tracked', () => {
  const fields = { title: 'Water Tracker', subtitle: 'Drink more water', keywords: 'hydration,reminder' };
  const none = listingBudget({ platform: 'ios', locale: 'en-US', fields, keywords: [] });
  assert.deepEqual(none.untracked, []);
  const some = listingBudget({ platform: 'ios', locale: 'en-US', fields, keywords: [{ id: 'k1', term: 'hydration' }] });
  const byField = Object.fromEntries(some.untracked.map((u) => [u.field, u.terms]));
  assert.deepEqual(byField.keywords, ['reminder']);
  assert.deepEqual(byField.title, ['water', 'tracker']);
  assert.equal(byField.subtitle?.includes('drink'), true);
});

test('listingBudget (Google Play): its own limits, repeats are information and cost nothing', () => {
  const b = listingBudget({
    platform: 'android',
    locale: 'en-US',
    fields: { title: 'Water Tracker', shortDescription: 'Track water and habits every day', description: 'x'.repeat(4001) },
    keywords: [{ id: 'k1', term: 'water' }],
  });
  assert.deepEqual(b.fields.map((f) => [f.field, f.limit]), [['title', 30], ['shortDescription', 80], ['description', 4000]]);
  assert.equal(b.fields[2]?.over, true);
  assert.equal(b.keywordField, null);
  assert.equal(b.wastedTotal, 0);
  assert.deepEqual(b.repeated.map((r) => [r.word, r.severity, r.wastedCharacters]), [['water', 'info', 0]]);
});

test('listingBudget: a tracked keyword in none of the searched fields is missing, one with some words is partial', () => {
  const b = listingBudget({
    platform: 'ios',
    locale: 'en-US',
    fields: { title: 'Water Tracker', subtitle: 'Drink more', keywords: 'habit' },
    keywords: [{ id: 'a', term: 'sleep sounds', priority: 3 }, { id: 'b', term: 'water reminder' }, { id: 'c', term: 'habit' }],
  });
  assert.deepEqual(b.missing.map((m) => m.id), ['a']);
  assert.deepEqual(b.partial.map((m) => m.id), ['b']);
});

test('sameLocale and matchListingLocale', () => {
  assert.equal(sameLocale('es_MX', 'es-mx'), true);
  assert.equal(sameLocale('it', 'it-IT'), true);
  assert.equal(sameLocale('es-MX', 'es-ES'), false);
  assert.equal(sameLocale('fr-CA', 'fr-FR'), false);
  const list = [{ locale: 'en-GB' }, { locale: 'de-DE' }];
  assert.equal(matchListingLocale(list, 'de-DE')?.locale, 'de-DE');
  assert.equal(matchListingLocale(list, 'en-US')?.locale, 'en-GB');
  assert.equal(matchListingLocale(list, 'fr-FR'), undefined);
});

test('storefrontCombos is marked UNVERIFIED and says what the listing has', () => {
  const us = storefrontCombos('US', ['en-US', 'es-MX']);
  assert.equal(us.unverified, true);
  assert.match(us.note, /UNVERIFIED/);
  assert.deepEqual(us.locales[0], { locale: 'en-US', kind: 'primary', present: true });
  assert.equal(us.locales.find((l) => l.locale === 'es-MX')?.present, true);
  assert.equal(us.locales.find((l) => l.locale === 'fr-FR')?.present, false);
  // A storefront that is not listed claims nothing beyond its own locale.
  assert.deepEqual(storefrontCombos('nz', []).locales.map((l) => l.kind), ['primary']);
});

test('untappedLocales: a tracked locale with no listing text, and locales with no keyword field text', () => {
  const out = untappedLocales({
    platform: 'ios',
    listingLocales: [
      { locale: 'en-US', fields: { keywords: 'habit' } },
      { locale: 'de-DE', fields: { keywords: '  ' } },
      { locale: 'fr-FR', fields: {} },
    ],
    tracked: [{ country: 'us', locale: 'en-US' }, { country: 'mx', locale: 'es-MX' }, { country: 'mx', locale: 'es-MX' }, { country: 'de', locale: 'de-DE' }],
  });
  assert.deepEqual(out.map((u) => [u.locale, u.kind, u.keywords, u.countries]), [
    ['es-MX', 'no_locale', 2, ['mx']],
    ['de-DE', 'empty_keyword_field', 1, ['de']],
    ['fr-FR', 'empty_keyword_field', 0, []],
  ]);
});

test('untappedLocales (Google Play) looks at the short description', () => {
  const out = untappedLocales({ platform: 'android', listingLocales: [{ locale: 'en-US', fields: { title: 'x', shortDescription: '' } }], tracked: [] });
  assert.deepEqual(out.map((u) => u.kind), ['empty_short_description']);
});

// ----- the coach

const NOW = 100 * 86_400_000;
const base = (over: Partial<CoachInput> = {}): CoachInput => ({
  platform: 'ios',
  now: NOW,
  keywords: [],
  competitors: [],
  competitorsAbove: [],
  listingLocales: [],
  lastCheckAt: null,
  rankMoveThreshold: 5,
  ...over,
});

test('coach: nothing tracked gives one clear first step and no invented follow-ups', () => {
  const out = buildCoach(base());
  assert.deepEqual(out.map((a) => a.kind), ['track_keywords']);
  assert.equal(out[0]?.position, 1);
  assert.deepEqual(out[0]?.link, { to: 'keywords_add', label: 'Add keywords' });
});

test('coach: keywords never checked ask for a first check before anything about ranks', () => {
  const out = buildCoach(base({ keywords: [kw('a', 'habit', { state: null, rank: null, lastCheckedAt: null }), kw('b', 'water', { state: null, rank: null, lastCheckedAt: null })] }));
  assert.equal(out[0]?.kind, 'check_ranks');
  assert.match(out[0]?.detail ?? '', /^2 tracked keywords have not been checked/);
});

test('coach: a stale check says how many days, a fresh one says nothing', () => {
  const k = [kw('a', 'habit')];
  const stale = buildCoach(base({ keywords: k, lastCheckAt: NOW - 9 * 86_400_000, competitors: [{ id: 'c', name: 'Rival' }] }));
  assert.equal(stale[0]?.kind, 'check_ranks');
  assert.equal(stale[0]?.title, 'Ranks were last checked 9 days ago');
  const fresh = buildCoach(base({ keywords: k, lastCheckAt: NOW - 86_400_000, competitors: [{ id: 'c', name: 'Rival' }] }));
  assert.equal(fresh.some((a) => a.kind === 'check_ranks'), false);
});

test('coach: only a drop past the threshold, or out of the top 10, is reported', () => {
  const k = [
    kw('a', 'habit', { change: { kind: 'down', delta: -7, from: 3, to: 10 } }),
    kw('b', 'water', { change: { kind: 'down', delta: -2, from: 3, to: 5 } }),
    kw('c', 'sleep', { change: { kind: 'dropped', from: 4, to: null }, state: 'not_ranked', rank: null }),
    kw('d', 'focus', { change: { kind: 'dropped', from: 40, to: null }, state: 'not_ranked', rank: null }),
  ];
  const out = buildCoach(base({ keywords: k, lastCheckAt: NOW, competitors: [{ id: 'c', name: 'R' }] }));
  const drop = out.find((a) => a.kind === 'rank_dropped');
  assert.equal(drop?.title, '2 keywords dropped in rank');
  // The one that left the results is first; the move is named in the line.
  assert.deepEqual(drop?.items, ['sleep (US): left the results (was 4)', 'habit (US): 3 to 10']);
});

test('coach: tracked keywords that are not in the listing name the locale to open', () => {
  const out = buildCoach(
    base({
      keywords: [kw('a', 'sleep sounds', { priority: 3 }), kw('b', 'water')],
      lastCheckAt: NOW,
      competitors: [{ id: 'c', name: 'R' }],
      listingLocales: [{ locale: 'en-US', fields: { title: 'Water Tracker', subtitle: 'Drink more water', keywords: 'habit,hydration' } }],
    }),
  );
  const miss = out.find((a) => a.kind === 'not_in_listing');
  assert.equal(miss?.title, '1 tracked keyword is not in the listing');
  assert.deepEqual(miss?.items, ['sleep sounds (en-US)']);
  assert.deepEqual(miss?.link, { to: 'listing', locale: 'en-US', label: 'Open en-US in the listing' });
});

test('coach: a competitor above you, with both ranks from the data', () => {
  const out = buildCoach(
    base({
      keywords: [kw('a', 'habit tracker', { rank: 12 }), kw('b', 'water', { state: 'not_ranked', rank: null })],
      lastCheckAt: NOW,
      competitors: [{ id: 'c', name: 'Rival' }],
      competitorsAbove: [
        { keywordId: 'a', competitorId: 'c', competitorName: 'Rival', competitorRank: 3 },
        { keywordId: 'b', competitorId: 'c', competitorName: 'Rival', competitorRank: 8 },
      ],
    }),
  );
  const above = out.find((a) => a.kind === 'competitor_above');
  assert.equal(above?.title, '2 followed competitors rank above you');
  assert.deepEqual(above?.items, ['Rival is 3 for habit tracker; you are 12', 'Rival is 8 for water; you are not in the results']);
  assert.equal(above?.link.to, 'competitors');
});

test('coach: keyword field waste, unused characters and an untapped locale, in that order', () => {
  const out = buildCoach(
    base({
      keywords: [kw('a', 'water'), kw('m', 'agua', { country: 'mx', locale: 'es-MX' })],
      lastCheckAt: NOW,
      competitors: [{ id: 'c', name: 'R' }],
      listingLocales: [
        { locale: 'en-US', fields: { title: 'Water Tracker', subtitle: 'Drink water', keywords: 'tracker, hydration' } },
        { locale: 'de-DE', fields: { title: 'Wasser', subtitle: 'x', keywords: '' } },
      ],
    }),
  );
  const kinds = out.map((a) => a.kind);
  assert.deepEqual(kinds.filter((k) => ['keyword_field_waste', 'unused_characters', 'untapped_locale'].includes(k)), ['keyword_field_waste', 'unused_characters', 'untapped_locale']);
  const waste = out.find((a) => a.kind === 'keyword_field_waste');
  assert.deepEqual(waste?.items, ['en-US: 9 bytes']);
  const unused = out.find((a) => a.kind === 'unused_characters');
  // An empty keyword field of de-DE is the untapped locale's business, not listed twice.
  assert.equal(unused?.items.some((l) => l.startsWith('de-DE keyword field')), false);
  assert.equal(unused?.items.includes('en-US name: 13 of 30 characters used'), true);
  const untapped = out.find((a) => a.kind === 'untapped_locale');
  assert.deepEqual(untapped?.items, ['es-MX: no listing text (tracked in MX)', 'de-DE: the keyword field is empty']);
  assert.deepEqual(untapped?.link, { to: 'listing', label: 'Open the listing' });
  assert.match(untapped?.detail ?? '', /UNVERIFIED/);
});

test('coach: follow a competitor only when keywords are tracked and none is followed', () => {
  assert.equal(buildCoach(base({ keywords: [kw('a', 'habit')], lastCheckAt: NOW })).some((a) => a.kind === 'follow_competitors'), true);
  assert.equal(buildCoach(base({ keywords: [kw('a', 'habit')], lastCheckAt: NOW, competitors: [{ id: 'c', name: 'R' }] })).some((a) => a.kind === 'follow_competitors'), false);
});

test('coach: ranked in the fixed order, numbered from 1, items capped with the rest counted', () => {
  const many = Array.from({ length: 8 }, (_, i) => kw(`k${i}`, `term${i}`, { change: { kind: 'down', delta: -(10 + i), from: 1, to: 11 + i } }));
  const out = buildCoach(
    base({
      keywords: many,
      lastCheckAt: NOW - 20 * 86_400_000,
      listingLocales: [{ locale: 'en-US', fields: { title: 'Alpha', subtitle: '', keywords: '' } }],
    }),
  );
  assert.deepEqual(out.map((a) => a.position), out.map((_, i) => i + 1));
  assert.deepEqual(out.map((a) => a.kind).slice(0, 3), ['check_ranks', 'rank_dropped', 'not_in_listing']);
  const drop = out.find((a) => a.kind === 'rank_dropped');
  assert.equal(drop?.items.length, 5);
  assert.equal(drop?.more, 3);
  assert.equal(buildCoach(base({ keywords: many, lastCheckAt: NOW - 20 * 86_400_000, limit: 2 })).length, 2);
});

test('coach: Google Play has no keyword field to waste and uses its own fields for room and missing words', () => {
  const out = buildCoach(
    base({
      platform: 'android',
      keywords: [kw('a', 'water tracker')],
      lastCheckAt: NOW,
      competitors: [{ id: 'c', name: 'R' }],
      listingLocales: [{ locale: 'en-US', fields: { title: 'Pocket', shortDescription: 'Short', description: 'A long text about sleep.' } }],
    }),
  );
  const kinds = out.map((a) => a.kind);
  assert.equal(kinds.includes('keyword_field_waste'), false);
  assert.deepEqual(kinds.slice(0, 2), ['not_in_listing', 'unused_characters']);
  assert.match(out[0]?.detail ?? '', /title, short or full description/);
});

test('coach: keywords set in the keyword field that are not tracked, with the locale to open', () => {
  const out = buildCoach(
    base({
      keywords: [kw('a', 'habit')],
      lastCheckAt: NOW,
      competitors: [{ id: 'c', name: 'R' }],
      listingLocales: [
        { locale: 'en-US', fields: { title: 'Water Tracker', subtitle: 'Drink more water', keywords: 'habit, hydration,sleep' } },
        { locale: 'de-DE', fields: { title: 'Wasser', keywords: 'gewohnheit' } },
      ],
    }),
  );
  const step = out.find((a) => a.kind === 'untracked_set_keywords');
  assert.equal(step?.title, '3 set keywords are not tracked');
  assert.deepEqual(step?.items, ['en-US (US): hydration, sleep', 'de-DE (DE): gewohnheit']);
  assert.deepEqual(step?.link, { to: 'listing_keywords', locale: 'en-US', label: 'See them in the listing' });
  const kinds = out.map((a) => a.kind);
  assert.ok(kinds.indexOf('untracked_set_keywords') > kinds.indexOf('not_in_listing') || kinds.indexOf('not_in_listing') < 0);
});

test('coach: set keywords are matched in the storefront in use, nothing is asked of Google Play', () => {
  const listing = [{ locale: 'en-US', fields: { title: 'Water', keywords: 'habit,sleep' } }];
  // `habit` is tracked in the one storefront that has keywords of the locale: only `sleep` is left.
  const some = buildCoach(base({ keywords: [kw('a', 'Habits', { country: 'ca' })], lastCheckAt: NOW, listingLocales: listing }));
  assert.deepEqual(some.find((a) => a.kind === 'untracked_set_keywords')?.items, ['en-US (CA): sleep']);
  const none = buildCoach(base({ keywords: [kw('a', 'habit'), kw('b', 'sleep')], lastCheckAt: NOW, listingLocales: listing }));
  assert.equal(none.some((a) => a.kind === 'untracked_set_keywords'), false);
  const play = buildCoach(base({ platform: 'android', keywords: [kw('a', 'habit')], lastCheckAt: NOW, listingLocales: [{ locale: 'en-US', fields: { title: 'Pocket', shortDescription: 'Short' } }] }));
  assert.equal(play.some((a) => a.kind === 'untracked_set_keywords'), false);
  // Nothing tracked at all: the first step is still to track, and the set keywords are named too.
  const first = buildCoach(base({ keywords: [], lastCheckAt: null, listingLocales: listing }));
  assert.deepEqual(first.map((a) => a.kind).slice(0, 2), ['track_keywords', 'untracked_set_keywords']);
});

test('storefrontFor and untrackedSetKeywords: the storefront with most keywords, else the usual one', () => {
  assert.deepEqual(storefrontFor('en-US', []), { country: 'us', tracked: [], options: ['us'] });
  assert.deepEqual(storefrontFor('de-AT', [{ country: 'de', locale: 'de-AT' }, { country: 'de', locale: 'de-AT' }, { country: 'at', locale: 'de-AT' }]), { country: 'de', tracked: ['de', 'at'], options: ['de', 'at'] });
  assert.deepEqual(storefrontFor('fr', []).country, 'fr');
  assert.deepEqual(untrackedSetKeywords({ platform: 'ios', listingLocales: [{ locale: 'en-US', fields: { keywords: 'habit,,Habit,this is a way too long entry of far more than eight words in it all' } }], tracked: [] }), [{ locale: 'en-US', country: 'us', terms: ['habit'] }]);
});
