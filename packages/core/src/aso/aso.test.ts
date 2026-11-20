import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeKeywordField,
  checkTerm,
  coverageGaps,
  decideSnapshot,
  defaultCountryFor,
  defaultLocaleFor,
  diffCompetitor,
  fitKeyword,
  isBigMove,
  listingFit,
  mineIdeas,
  normalizeCountry,
  normalizeLocale,
  rankChange,
  rankTrend,
  suggestCompetitors,
  termsAcrossMarkets,
  words,
} from './aso.ts';

test('checkTerm: one keyword however it is typed', () => {
  const a = checkTerm('  Habit-Tracker ');
  const b = checkTerm('habit   tracker');
  const c = checkTerm('Hàbit tracker');
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.ok && a.key, 'habit tracker');
  assert.equal(a.ok && b.ok && a.key, b.key);
  assert.equal(c.ok && c.key, 'habit tracker');
  // The shown form keeps the case and the accents, with white space collapsed.
  assert.equal(c.ok && c.term, 'Hàbit tracker');
  assert.equal(checkTerm("don't").ok && (checkTerm("don't") as { key: string }).key, 'dont');
});

test('checkTerm refuses what is not a keyword', () => {
  for (const bad of [
    '',
    '   ',
    '!!!',
    '😀',
    'a\u0000b',
    'a‮b',
    'x'.repeat(81),
    'a b c d e f g h i',
    5,
    null,
    undefined,
  ]) {
    assert.equal(checkTerm(bad).ok, false, String(bad));
  }
  assert.equal(checkTerm('x'.repeat(80)).ok, true);
  assert.equal(checkTerm('a b c d e f g h').ok, true);
});

test('country and locale normalization', () => {
  assert.equal(normalizeCountry(' DE '), 'de');
  for (const bad of ['deu', 'd', '1a', '', undefined, 4])
    assert.equal(normalizeCountry(bad), undefined);
  assert.equal(normalizeLocale('pt_br'), 'pt-BR');
  assert.equal(normalizeLocale('zh-hans-cn'), 'zh-Hans-CN');
  assert.equal(normalizeLocale('EN'), 'en');
  for (const bad of ['', 'e', 'en-US-x-y', 'en-123456789', 'x1'])
    assert.equal(normalizeLocale(bad), undefined, bad);
});

test('defaultLocaleFor', () => {
  assert.equal(defaultLocaleFor('DE'), 'de-DE');
  assert.equal(defaultLocaleFor('br'), 'pt-BR');
  assert.equal(defaultLocaleFor('zz'), 'en');
});

test('words splits on punctuation and keeps letters of every script', () => {
  assert.deepEqual(words('Fast, simple & free! Ünïcode — 3D ✨'), [
    'fast',
    'simple',
    'free',
    'ünïcode',
    '3d',
  ]);
  assert.deepEqual(words('Привет, мир'), ['привет', 'мир']);
});

test('rankChange, isBigMove and the edge rule', () => {
  const p = (rank: number | null, total = 50) => ({ rank, total });
  assert.deepEqual(rankChange(undefined, p(4)), { kind: 'first', from: null, to: 4 });
  assert.equal(rankChange(p(10), p(10)).kind, 'same');
  const up = rankChange(p(20), p(8));
  assert.deepEqual([up.kind, up.delta], ['up', 12]);
  const down = rankChange(p(8), p(20));
  assert.deepEqual([down.kind, down.delta], ['down', -12]);
  assert.equal(rankChange(p(null), p(7)).kind, 'entered');
  assert.equal(rankChange(p(7), p(null)).kind, 'dropped');
  assert.equal(rankChange(p(null), p(null)).kind, 'still_unranked');
  assert.equal(isBigMove(up, 10), true);
  assert.equal(isBigMove(up, 13), false);
  assert.equal(isBigMove(down, 12), true);
  assert.equal(isBigMove(rankChange(p(null), p(7)), 10), true, 'entering the top 10');
  assert.equal(isBigMove(rankChange(p(null), p(45)), 10), false, 'entering at 45 is not news');
  assert.equal(isBigMove(rankChange(p(48), p(null)), 10), false);
  assert.equal(isBigMove(rankChange(p(3), p(null)), 10), true);
  assert.equal(isBigMove(rankChange(undefined, p(3)), 1), false);
  assert.equal(isBigMove(rankChange(p(5), p(5)), 1), false);
});

test('rankTrend', () => {
  const p = (rank: number | null, total = 50) => ({ rank, total });
  assert.equal(rankTrend([]).direction, 'unknown');
  assert.equal(rankTrend([p(3)]).direction, 'unknown');
  const up = rankTrend([p(30), p(22), p(9)]);
  assert.deepEqual(
    [up.direction, up.delta, up.best, up.worst, up.latest, up.ranked],
    ['up', 21, 9, 30, 9, 3],
  );
  const down = rankTrend([p(5), p(null)]);
  assert.equal(down.direction, 'down');
  assert.equal(down.delta, -46);
  assert.equal(down.latest, null);
  assert.equal(rankTrend([p(null), p(null)]).direction, 'flat');
  assert.equal(rankTrend([p(null), p(null)]).best, null);
});

const IOS = {
  title: 'Habit Tracker: Daily Goals',
  subtitle: 'Build routines that stick',
  keywords: 'streak,reminder,planner',
  description: 'Our meditation timer helps you relax.',
};

test('fitKeyword on iOS: strong, covered, partial, description only, missing', () => {
  const fit = (term: string) => fitKeyword('ios', 'en-US', IOS, { id: term, term });
  assert.equal(fit('habit tracker').status, 'strong');
  assert.deepEqual(
    fit('habit tracker').where.map((w) => [w.field, w.phrase]),
    [['title', true]],
  );
  assert.equal(fit('build routines').status, 'strong');
  // Words spread over name, subtitle and keyword field: covered, not strong.
  assert.equal(fit('daily streak').status, 'covered');
  // Plural folding (English).
  assert.equal(fit('goals').status, 'strong');
  assert.equal(fit('reminders').status, 'covered');
  assert.equal(fit('habit meditation').status, 'partial');
  assert.deepEqual(fit('habit meditation').missingWords, ['meditation']);
  assert.equal(fit('meditation timer').status, 'description_only');
  assert.equal(fit('sleep sounds').status, 'missing');
});

test('fitKeyword on Android searches the descriptions too', () => {
  const fields = {
    title: 'Sleep Sounds',
    shortDescription: 'White noise for deep sleep',
    description: 'Rain, ocean and forest ambience. Timer included.',
  };
  const fit = (term: string) => fitKeyword('android', 'en', fields, { id: term, term });
  assert.equal(fit('sleep sounds').status, 'strong');
  assert.equal(fit('white noise').status, 'strong');
  assert.equal(fit('forest ambience').status, 'covered');
  assert.equal(fit('forest ambience').where[0]?.field, 'description');
  assert.equal(fit('yoga').status, 'missing');
});

test('matching ignores case and accents, and does not stem German', () => {
  const fields = { title: 'Küchen Planer', keywords: '' };
  assert.equal(
    fitKeyword('ios', 'de-DE', fields, { id: '1', term: 'KUCHEN planer' }).status,
    'strong',
  );
  // "Planers" is not folded in German.
  assert.equal(fitKeyword('ios', 'de-DE', fields, { id: '1', term: 'planers' }).status, 'missing');
});

test('listingFit orders the gaps by priority, then the worst fit, then the worse rank', () => {
  const fit = listingFit({
    platform: 'ios',
    locale: 'en-US',
    fields: IOS,
    keywords: [
      { id: 'a', term: 'habit tracker', priority: 3 },
      { id: 'b', term: 'sleep sounds', priority: 2, rank: 30 },
      { id: 'c', term: 'yoga', priority: 3, rank: null },
      { id: 'd', term: 'meditation timer', priority: 3 },
      { id: 'e', term: 'journal', priority: 2, rank: 4 },
    ],
  });
  assert.deepEqual(fit.counts, {
    strong: 1,
    covered: 0,
    partial: 0,
    description_only: 1,
    missing: 3,
  });
  assert.deepEqual(
    fit.gaps.map((g) => g.id),
    ['c', 'd', 'b', 'e'],
  );
  assert.ok(fit.assumptions.some((a) => a.startsWith('UNVERIFIED')));
});

test('keyword field: budget, duplicates, words already in the name, wasted spaces', () => {
  const report = analyzeKeywordField('streak, reminder ,Habit,reminder, planner,tracker', {
    title: 'Habit Tracker',
    subtitle: 'Daily goals',
    language: 'en',
  });
  assert.equal(report.max, 100);
  assert.deepEqual(report.terms, ['streak', 'reminder', 'Habit', 'reminder', 'planner', 'tracker']);
  assert.deepEqual(report.duplicates, ['reminder']);
  assert.deepEqual(report.inTitleOrSubtitle, ['Habit', 'tracker']);
  assert.equal(report.compacted, 'streak,reminder,planner');
  assert.equal(report.savedBytes, report.bytes - report.compactedBytes);
  assert.ok(report.separatorBytes >= 3);
  assert.equal(report.overBudget, false);
  const over = analyzeKeywordField('é'.repeat(60), {});
  assert.equal(over.bytes, 120);
  assert.equal(over.characters, 60);
  assert.equal(over.overBudget, true);
  assert.equal(over.remaining, -20);
  const listing = listingFit({ platform: 'ios', locale: 'en-US', fields: IOS, keywords: [] });
  assert.equal(listing.keywordField?.bytes, 'streak,reminder,planner'.length);
  assert.equal(
    listingFit({ platform: 'android', locale: 'en', fields: { title: 'x' }, keywords: [] })
      .keywordField,
    undefined,
  );
});

const TEXTS = [
  {
    id: 'c1',
    text: 'Habit tracker and daily planner. Track habits, build streaks with the habit tracker.',
  },
  { id: 'c2', text: 'The best habit tracker for goals. Daily planner and reminders.' },
  { id: 'c3', text: 'Sleep sounds for the night.' },
];

test('mineIdeas: n-grams, stop words, sources, no phrase that adds nothing', () => {
  const ideas = mineIdeas(TEXTS, { minOccurrences: 2 });
  const terms = ideas.map((i) => i.term);
  assert.ok(terms.includes('habit tracker'), terms.join('|'));
  assert.ok(terms.includes('daily planner'));
  // "habit" and "tracker" always come with each other: only the phrase is offered.
  assert.equal(terms.includes('tracker'), false);
  assert.equal(terms.includes('the'), false);
  assert.equal(terms.includes('and'), false);
  const tracker = ideas.find((i) => i.term === 'habit tracker');
  assert.deepEqual([tracker?.occurrences, tracker?.sources, tracker?.words], [3, 2, 2]);
  assert.equal(typeof tracker?.localScore, 'number');
  assert.equal(ideas[0]?.term, 'habit tracker');
  // Source minimum, exclusions, limit.
  assert.equal(mineIdeas(TEXTS, { minOccurrences: 1, minSources: 3 }).length, 0);
  assert.equal(
    mineIdeas(TEXTS, { exclude: ['Habit-Tracker'] }).some((i) => i.term === 'habit tracker'),
    false,
  );
  assert.equal(mineIdeas(TEXTS, { minOccurrences: 1, limit: 3 }).length, 3);
});

test('mineIdeas: stop words per language', () => {
  const de = mineIdeas(
    [{ id: 'a', text: 'Die beste Küchen App für die Küchen Planung. Küchen Planung ist einfach.' }],
    { language: 'de-AT', minOccurrences: 2 },
  );
  const terms = de.map((i) => i.term);
  assert.ok(terms.includes('küchen planung'), terms.join('|'));
  assert.equal(terms.includes('die'), false);
  assert.equal(terms.includes('für'), false);
  // A language without a list is still mined, filtering only short words and numbers.
  const ja = mineIdeas([{ id: 'a', text: 'bla bla bla 2024 2024 of of of' }], {
    language: 'xx',
    minOccurrences: 2,
  });
  const jaTerms = ja.map((i) => i.term);
  assert.ok(jaTerms.includes('bla'));
  assert.equal(jaTerms.includes('2024'), false);
  assert.equal(jaTerms.includes('of'), false);
});

test('diffCompetitor and decideSnapshot', () => {
  const base = {
    version: '1.0',
    ratingMilli: 4500,
    ratingCount: 1000,
    price: '0',
    title: 'Habit',
    subtitle: 'Goals',
    textHash: 't1',
    descriptionHash: 'd1',
    screenshotCount: 5,
    mediaHash: 'm1',
  };
  assert.deepEqual(diffCompetitor(undefined, base), { changes: [], notable: false });
  assert.deepEqual(diffCompetitor(base, { ...base }), { changes: [], notable: false });
  // Count drift is not a change; a big jump is, but not notable.
  assert.deepEqual(diffCompetitor(base, { ...base, ratingCount: 1010 }).changes, []);
  const drift = diffCompetitor(base, { ...base, ratingCount: 1100 });
  assert.deepEqual(drift.changes, [{ field: 'ratingCount', from: 1000, to: 1100 }]);
  assert.equal(drift.notable, false);
  const small = diffCompetitor(base, { ...base, ratingMilli: 4460 });
  assert.deepEqual(small.changes, []);
  const rating = diffCompetitor(base, { ...base, ratingMilli: 4420 });
  assert.equal(rating.changes[0]?.field, 'rating');
  assert.equal(rating.notable, false);
  assert.equal(diffCompetitor(base, { ...base, ratingMilli: 4200 }).notable, true);
  const release = diffCompetitor(base, {
    ...base,
    version: '1.1',
    title: 'Habit Pro',
    textHash: 't2',
  });
  assert.deepEqual(release.changes, [
    { field: 'version', from: '1.0', to: '1.1' },
    { field: 'title', from: 'Habit', to: 'Habit Pro' },
  ]);
  assert.equal(release.notable, true);
  assert.deepEqual(
    diffCompetitor(base, { ...base, textHash: 't3', descriptionHash: 'd3' }).changes,
    [{ field: 'description' }],
  );
  assert.deepEqual(
    diffCompetitor(base, { ...base, mediaHash: 'm2', screenshotCount: 6 }).changes.map(
      (c) => c.field,
    ),
    ['media', 'screenshots'],
  );

  const day = 24 * 3_600_000;
  const stored = { ...base, checkedAt: 1000 };
  assert.deepEqual(decideSnapshot(undefined, base, 5000, 7 * day), {
    store: true,
    kind: 'first',
    changes: [],
    notable: false,
  });
  assert.equal(decideSnapshot(stored, base, 1000 + day, 7 * day).store, false);
  assert.equal(decideSnapshot(stored, base, 1000 + 7 * day, 7 * day).kind, 'heartbeat');
  const change = decideSnapshot(stored, { ...base, version: '2.0' }, 1000 + day, 7 * day);
  assert.deepEqual([change.store, change.kind, change.notable], [true, 'change', true]);
});

test('suggestCompetitors: apps in the top results of several keywords', () => {
  const results = [
    { keywordId: 'k1', ids: ['own', 'a', 'b', 'c', 'known'] },
    { keywordId: 'k2', ids: ['b', 'a', 'own', 'd'] },
    { keywordId: 'k3', ids: ['e', 'b', 'b', 'f', 'known'] },
  ];
  const out = suggestCompetitors(results, { ownId: 'own', exclude: ['known'] });
  assert.deepEqual(
    out.map((o) => [o.externalId, o.keywordCount, o.bestRank, o.averageRank]),
    [
      ['b', 3, 1, 2],
      ['a', 2, 2, 2],
    ],
  );
  assert.deepEqual(out[0]?.keywordIds, ['k1', 'k2', 'k3']);
  assert.equal(suggestCompetitors(results, { minKeywords: 1, topN: 2 }).length, 4);
  assert.deepEqual(suggestCompetitors([], {}), []);
});

test('coverageGaps: what competitors name that our listing does not', () => {
  const gaps = coverageGaps({
    platform: 'ios',
    locale: 'en-US',
    ours: IOS,
    tracked: [
      { id: '1', term: 'habit tracker' },
      { id: '2', term: 'water reminder' },
      { id: '3', term: 'yoga' },
    ],
    competitors: [
      {
        id: 'c1',
        title: 'Water Reminder: Drink More',
        subtitle: 'Hydration tracker',
        description: 'Includes yoga breaks.',
      },
      {
        id: 'c2',
        title: 'Hydro Water Reminder',
        subtitle: 'Hydration tracker',
        description: 'A habit tracker too.',
      },
      { id: 'c3', title: 'Calm Yoga', description: 'yoga' },
    ],
  });
  const terms = gaps.map((g) => g.term);
  assert.equal(terms.includes('habit tracker'), false, 'we have it');
  const water = gaps.find((g) => g.term === 'water reminder');
  assert.deepEqual(water?.inTitle, ['c1', 'c2']);
  assert.equal(water?.origin, 'tracked');
  assert.equal(
    water?.ourStatus,
    'partial',
    'the reminder is in the keyword field, the water is nowhere',
  );
  const idea = gaps.find((g) => g.origin === 'idea');
  assert.ok(idea, 'a phrase two competitors share becomes an idea');
  assert.equal(terms[0], 'water reminder');
  assert.deepEqual(gaps.find((g) => g.term === 'yoga')?.inTitle, ['c3']);
  assert.deepEqual(gaps.find((g) => g.term === 'yoga')?.inDescription, ['c1']);
});

test('termsAcrossMarkets groups one term over countries and locales', () => {
  const m = (id: string, key: string, country: string, locale: string, rank: number | null) => ({
    id,
    term: key,
    key,
    country,
    locale,
    rank,
    state: rank === null ? ('not_ranked' as const) : ('ranked' as const),
    checkedAt: 1,
  });
  const rows = termsAcrossMarkets([
    m('1', 'habit', 'us', 'en-US', 12),
    m('2', 'habit', 'de', 'de-DE', null),
    m('3', 'habit', 'gb', 'en-GB', 4),
    m('4', 'water', 'us', 'en-US', null),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.key, r.bestRank, r.markets.map((x) => x.country)]),
    [
      ['habit', 4, ['de', 'gb', 'us']],
      ['water', null, ['us']],
    ],
  );
});

test('defaultCountryFor: the storefront of a listing locale, the reverse of defaultLocaleFor', () => {
  assert.equal(defaultCountryFor('en-US'), 'us');
  assert.equal(defaultCountryFor('pt_BR'), 'br');
  assert.equal(defaultCountryFor('fr-CA'), 'ca', 'the region of the tag');
  assert.equal(defaultCountryFor('ja'), 'jp');
  assert.equal(defaultCountryFor('zh-Hans'), 'cn');
  assert.equal(defaultCountryFor('zh-Hant'), 'tw');
  assert.equal(defaultCountryFor('no'), 'no');
  assert.equal(defaultCountryFor('en'), 'us');
  assert.equal(defaultCountryFor('xx'), '');
  assert.equal(defaultCountryFor(''), '');
});
