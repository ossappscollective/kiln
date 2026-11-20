import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api.ts';
import { attentionItems } from '../app-attention.ts';
import {
  type AsoCompetitor,
  type AsoConfig,
  type AsoKeyword,
  type AsoSummary,
  addItems,
  addSummaryText,
  asoErrorMessage,
  asoViewFromHash,
  asoViewHref,
  asoViews,
  bestRank,
  changeInfo,
  changeText,
  checkMarket,
  chunk,
  compareRows,
  configStates,
  countryForLocale,
  fieldCell,
  filterKeywords,
  isBigDrop,
  isMoreKeywordView,
  keywordMainViews,
  keywordMeter,
  keywordMoreViews,
  lastChangeText,
  localesOf,
  marketCell,
  marketColumns,
  overviewMovers,
  overviewStats,
  parsePastedTerms,
  parseThreshold,
  rankText,
  refreshText,
  resultWaitSeconds,
  sortKeywords,
  sparkline,
  withAsoView,
} from './aso.ts';

const kw = (over: Partial<AsoKeyword> = {}): AsoKeyword => ({
  id: 'k1',
  appId: 'a1',
  platform: 'ios',
  country: 'us',
  locale: 'en-US',
  term: 'water reminder',
  key: 'water reminder',
  tag: null,
  notes: null,
  priority: 2,
  createdAt: 1,
  updatedAt: 1,
  lastCheckedAt: 1000,
  state: 'ranked',
  rank: 12,
  total: 50,
  previous: null,
  change: null,
  error: null,
  ...over,
});

test('the sub-view lives in the address and Keywords is the default', () => {
  assert.equal(asoViewFromHash('#/portfolio/a1/aso'), 'keywords');
  assert.equal(asoViewFromHash('#/portfolio/a1/aso?view=gaps'), 'gaps');
  assert.equal(asoViewFromHash('#/portfolio/a1/aso?view=nope'), 'keywords');
  assert.equal(asoViewFromHash('#/portfolio/a1/aso?platform=ios&view=fit'), 'fit');
  assert.equal(
    withAsoView('#/portfolio/a1/aso?platform=ios', 'fit'),
    '#/portfolio/a1/aso?platform=ios&view=fit',
  );
  // Inside Insights, Keywords is written too (the default view of Insights is Overview).
  assert.equal(
    withAsoView('#/portfolio/a1/insights?view=fit&platform=ios', 'keywords'),
    '#/portfolio/a1/insights?view=keywords&platform=ios',
  );
  assert.equal(
    asoViewHref('a1', 'markets', 'android'),
    '#/portfolio/a1/insights?platform=android&view=markets',
  );
  assert.equal(asoViewHref('a1'), '#/portfolio/a1/insights?view=keywords');
});

test('a rank reads as a position, "50+" or a dash, and a change says its direction in words', () => {
  assert.equal(rankText(kw()).text, '12');
  assert.equal(rankText(kw({ state: 'not_ranked', rank: null })).text, '50+');
  assert.equal(rankText(kw({ state: null, rank: null, total: null })).text, '–');
  assert.deepEqual(changeInfo({ kind: 'up', delta: 3, from: 15, to: 12 }, true).text, '+3');
  assert.equal(changeInfo({ kind: 'down', delta: -4, from: 8, to: 12 }, true).text, '-4');
  assert.equal(changeInfo({ kind: 'down', delta: -4, from: 8, to: 12 }, true).tone, 'bad');
  assert.equal(changeInfo({ kind: 'entered', from: null, to: 9 }, true).text, 'Entered');
  assert.equal(changeInfo({ kind: 'dropped', from: 9, to: null }, true).text, 'Left');
  assert.equal(changeInfo(null, true).text, 'New');
  assert.equal(changeInfo(null, false).text, '–');
  assert.equal(changeInfo({ kind: 'same', delta: 0, from: 3, to: 3 }, true).text, '0');
});

test('keywords sort by rank, move, term and check time; unchecked ones go last', () => {
  const a = kw({
    id: 'a',
    term: 'b term',
    rank: 5,
    change: { kind: 'up', delta: 2, from: 7, to: 5 },
  });
  const b = kw({
    id: 'b',
    term: 'a term',
    rank: 30,
    change: { kind: 'dropped', from: 9, to: null },
  });
  const c = kw({ id: 'c', term: 'c term', state: null, rank: null, lastCheckedAt: null });
  const d = kw({ id: 'd', term: 'd term', state: 'not_ranked', rank: null });
  assert.deepEqual(
    sortKeywords([c, d, b, a], 'rank').map((k) => k.id),
    ['a', 'b', 'd', 'c'],
  );
  assert.deepEqual(
    sortKeywords([a, b, c], 'move').map((k) => k.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    sortKeywords([a, b, c], 'term').map((k) => k.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    sortKeywords([c, a], 'checked').map((k) => k.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    filterKeywords([a, b], 'A TERM').map((k) => k.id),
    ['b'],
  );
  assert.deepEqual(
    filterKeywords([a, b], 'b ter').map((k) => k.id),
    ['a'],
  );
  assert.deepEqual(
    filterKeywords([a, b], 'us ').map((k) => k.id),
    ['a', 'b'],
  );
});

test('the sparkline puts rank 1 at the top, "not ranked" at the bottom and one check as a dot', () => {
  const s = sparkline(
    [
      { rank: 1, total: 50 },
      { rank: 10, total: 50 },
      { rank: null, total: 50 },
    ],
    60,
    20,
    2,
  );
  assert.equal(s.samples, 3);
  assert.ok(s.path.startsWith('M2 2'));
  assert.ok(s.path.endsWith('L58 18'));
  assert.deepEqual(s.last, { x: 58, y: 18 });
  const one = sparkline([{ rank: 4, total: 50 }]);
  assert.equal(one.path, 'M36 10');
  assert.equal(sparkline([]).path, '');
  const flat = sparkline([
    { rank: 3, total: 50 },
    { rank: 3, total: 50 },
  ]);
  assert.ok(flat.path.includes('10'));
  assert.equal(bestRank([{ rank: null }, { rank: 9 }, { rank: 4 }]), 4);
  assert.equal(bestRank([{ rank: null }]), null);
});

test('pasted keywords split on lines, commas and semicolons and drop repeats and bad ones', () => {
  const p = parsePastedTerms(
    `Water  Reminder\nwater-reminder, habit tracker;;  \n!!!\n${'x'.repeat(100)}`,
  );
  assert.deepEqual(
    p.terms.map((t) => t.term),
    ['Water Reminder', 'habit tracker'],
  );
  assert.equal(p.duplicates, 1);
  assert.equal(p.invalid.length, 2);
  assert.equal(parsePastedTerms('  \n ').terms.length, 0);
});

test('a market is a two letter country and a locale that follows it when blank', () => {
  assert.deepEqual(checkMarket('US', ''), { country: 'us', locale: 'en-US' });
  assert.deepEqual(checkMarket('de', 'de_AT'), { country: 'de', locale: 'de-AT' });
  assert.equal(checkMarket('usa', ''), null);
  assert.equal(checkMarket('us', 'not a locale'), null);
});

test('add items are one per market and term, and long lists are chunked', () => {
  const items = addItems(
    [{ term: 'a' }, { term: 'b' }],
    [
      { country: 'us', locale: 'en-US' },
      { country: 'de', locale: 'de-DE' },
    ],
    { tag: ' core ', priority: 3 },
  );
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], {
    term: 'a',
    country: 'us',
    locale: 'en-US',
    tag: 'core',
    priority: 3,
  });
  assert.equal(
    addItems([{ term: 'a' }], [{ country: 'us', locale: 'en-US' }], { priority: 2 })[0]?.priority,
    undefined,
  );
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(
    addSummaryText({ created: 8, exists: 2, invalid: 1, limit: 3 }, 50),
    'Added 8 keywords. 2 already tracked, 1 not accepted, 3 over the limit of 50.',
  );
  assert.equal(
    addSummaryText({ created: 0, exists: 1, invalid: 0, limit: 0 }),
    'Nothing was added. 1 already tracked.',
  );
  assert.equal(addSummaryText({ created: 1, exists: 0, invalid: 0, limit: 0 }), 'Added 1 keyword.');
});

const result = (over: Record<string, unknown> = {}) =>
  ({
    at: 1,
    keywords: { due: 40, checked: 25, ranked: 12, notRanked: 13, failed: 0, cached: 3, moved: 2 },
    competitors: { due: 3, checked: 3, changed: 1, notFound: 0, failed: 0 },
    deferred: true,
    stoppedBecause: 'cap',
    errors: [],
    warnings: [],
    ...over,
  }) as Parameters<typeof refreshText>[0];

test('a refresh says what it did and what stopped it; a store limit gives a wait', () => {
  assert.equal(
    refreshText(result()),
    'Checked 25 of 40 keywords and 3 of 3 competitors. 2 keywords moved. The rest is left for the next check.',
  );
  const limited = result({ stoppedBecause: 'rate_limit', retryAfterSeconds: 90 });
  assert.match(refreshText(limited), /try again in 2 minutes/);
  assert.equal(resultWaitSeconds(limited), 90);
  assert.equal(resultWaitSeconds(result()), null);
  assert.equal(
    refreshText(
      result({
        deferred: false,
        competitors: { due: 0, checked: 0, changed: 0, notFound: 0, failed: 0 },
        keywords: { due: 1, checked: 1, ranked: 1, notRanked: 0, failed: 0, cached: 0, moved: 0 },
      }),
    ),
    'Checked 1 of 1 keyword.',
  );
});

test('errors become sentences, and a limit says when to try again', () => {
  assert.match(
    asoErrorMessage(new ApiError(429, 'rate_limited', 'x', 30)),
    /Try again in 30 seconds/,
  );
  assert.match(asoErrorMessage(new ApiError(429, 'rate_limited', 'x')), /Try again in a minute/);
  assert.match(asoErrorMessage(new ApiError(409, 'play_unofficial_disabled', 'x')), /switched off/);
  assert.match(asoErrorMessage(new ApiError(409, 'refresh_in_progress', 'x')), /already running/);
  assert.match(asoErrorMessage(new ApiError(422, 'not_found', 'x')), /no app with that id/);
  assert.match(
    asoErrorMessage(new ApiError(502, 'refresh_failed', 'x')),
    /Nothing was recorded as not ranked/,
  );
  assert.equal(asoErrorMessage(new Error('boom'), 'Fallback.'), 'Fallback.');
});

const comp = (over: Partial<AsoCompetitor> = {}): AsoCompetitor => ({
  id: 'c1',
  appId: 'a1',
  store: 'app_store',
  externalId: '1500000002',
  country: 'us',
  name: 'Habit App 2',
  addedBy: 'u',
  addedAt: 1,
  lastCheckedAt: 5,
  state: 'ok',
  error: null,
  latest: {
    id: 's1',
    checkedAt: 5,
    kind: 'change',
    version: '2.1',
    rating: 4.6,
    ratingCount: 1200,
    price: 'Free',
    currency: 'USD',
    title: 'Habit App 2',
    subtitle: null,
    descriptionExcerpt: null,
    screenshotCount: 5,
    changes: [{ field: 'version', from: '2.0', to: '2.1' }],
  },
  ...over,
});

test('competitor changes read as plain sentences', () => {
  assert.equal(changeText({ field: 'version', from: '2.0', to: '2.1' }), 'Version 2.0 to 2.1');
  assert.equal(changeText({ field: 'description' }), 'Description changed');
  assert.equal(
    changeText({ field: 'ratingCount', from: 1000, to: 1200 }),
    'Rating count 1,000 to 1,200',
  );
  assert.equal(changeText({ field: 'price', from: null, to: '$1.99' }), 'Price none to $1.99');
  const day = 86_400_000;
  assert.equal(
    lastChangeText(
      {
        diff: {
          from: null,
          to: 's',
          at: 10 * day,
          changes: [
            { field: 'version', from: '1', to: '2' },
            { field: 'price', from: 'a', to: 'b' },
          ],
        },
      },
      comp(),
      12 * day,
    ),
    'Version 1 to 2 and 1 more, 2 days ago',
  );
  assert.equal(lastChangeText(null, comp(), 5), 'Version 2.0 to 2.1, today');
  assert.equal(
    lastChangeText(
      null,
      comp({
        latest: { ...(comp().latest as NonNullable<AsoCompetitor['latest']>), changes: null },
      }),
      5,
    ),
    'No change seen since the first look',
  );
  assert.equal(
    lastChangeText(null, comp({ state: 'not_found', latest: null }), 5),
    'No longer in the store',
  );
});

test('the side by side shows a dash for what we do not hold', () => {
  const rows = compareRows({ version: '3.0', rating: null, ratingCount: null }, [
    comp(),
    comp({ id: 'c2', latest: null }),
  ]);
  assert.deepEqual(rows[0], { label: 'Version', ours: '3.0', theirs: ['2.1', '–'] });
  assert.deepEqual(rows[1], { label: 'Rating', ours: '–', theirs: ['4.6', '–'] });
  assert.deepEqual(rows[2], { label: 'Ratings', ours: '–', theirs: ['1,200', '–'] });
  assert.deepEqual(rows[3]?.theirs, ['Free', '–']);
});

test('the market matrix shows the best rank per country and what is not tracked', () => {
  const term = {
    key: 'water reminder',
    term: 'water reminder',
    bestRank: 3,
    markets: [
      { country: 'de', locale: 'de-DE', id: 'k1', rank: 3, state: 'ranked' as const, checkedAt: 1 },
      {
        country: 'us',
        locale: 'en-US',
        id: 'k2',
        rank: null,
        state: 'not_ranked' as const,
        checkedAt: 1,
      },
      { country: 'us', locale: 'es-US', id: 'k3', rank: 9, state: 'ranked' as const, checkedAt: 1 },
      { country: 'fr', locale: 'fr-FR', id: 'k4', rank: null, state: null, checkedAt: null },
    ],
  };
  assert.deepEqual(marketColumns([term]), ['de', 'fr', 'us']);
  assert.equal(marketCell(term, 'de').text, '3');
  assert.equal(marketCell(term, 'de').best, true);
  assert.equal(marketCell(term, 'us').text, '9');
  assert.equal(marketCell(term, 'us').best, false);
  assert.match(marketCell(term, 'us').title, /en-US: not in the results; es-US: position 9/);
  assert.equal(marketCell(term, 'fr').text, '–');
  assert.equal(marketCell(term, 'jp').text, '');
  assert.equal(
    marketCell({ ...term, markets: [term.markets[1] as (typeof term.markets)[number]] }, 'us').text,
    'not ranked',
  );
});

const cfg = (over: Partial<AsoConfig> = {}): AsoConfig => ({
  apple: { enabled: true, source: 'iTunes Search API', documentedCallsPerMinute: 20 },
  play: { enabled: false, unofficial: true, notice: 'Unofficial.', howToEnable: 'Set the flag.' },
  schedule: { intervalMinutes: 0 },
  retentionDays: 365,
  limits: {
    maxKeywordsPerApp: 50,
    maxCompetitorsPerApp: 10,
    maxChecksPerRun: 25,
    rankDepth: 50,
    maxKeywordsPerRequest: 50,
  },
  rankMoveThreshold: 5,
  ...over,
});

test('configuration states are one pill, and nothing when all is on', () => {
  const both = configStates(cfg(), true);
  assert.equal(both?.label, 'Google Play reads off, automatic checks off');
  assert.equal(both?.items.length, 2);
  assert.equal(configStates(cfg(), false)?.label, 'Automatic checks off');
  assert.equal(configStates(cfg({ schedule: { intervalMinutes: 60 } }), false), null);
  assert.equal(
    configStates(
      cfg({
        play: { enabled: true, unofficial: true, notice: '', howToEnable: '' },
        schedule: { intervalMinutes: 60 },
      }),
      true,
    ),
    null,
  );
  assert.equal(configStates(null, true), null);
});

test('the keyword field meter warns near the budget and says so when over', () => {
  assert.deepEqual(keywordMeter(40, 100), {
    percent: 40,
    tone: 'ok',
    text: '40 of 100 bytes, 60 left',
  });
  assert.equal(keywordMeter(95, 100).tone, 'warn');
  const over = keywordMeter(104, 100);
  assert.equal(over.tone, 'bad');
  assert.equal(over.percent, 100);
  assert.equal(over.text, '104 of 100 bytes, 4 over');
});

test('fit cells tell a phrase from some words', () => {
  const k = {
    term: 'water reminder',
    where: [
      { field: 'title', phrase: true, wordsPresent: 2, occurrences: 1 },
      { field: 'description', phrase: false, wordsPresent: 1, occurrences: 0 },
    ],
  };
  assert.equal(fieldCell(k, 'title').mark, 'phrase');
  assert.deepEqual(fieldCell(k, 'description'), {
    mark: 'words',
    text: '1/2',
    title: '1 of 2 words are in this field, not as a phrase',
  });
  assert.equal(fieldCell(k, 'subtitle').mark, 'none');
});

test('the country of an idea follows a tracked market, else the region', () => {
  assert.equal(countryForLocale('en-GB', [{ country: 'ie', locale: 'en-GB' }]), 'ie');
  assert.equal(countryForLocale('de-AT', []), 'at');
  assert.equal(countryForLocale('de', []), '');
  assert.equal(countryForLocale('zh-Hans', []), '');
  assert.deepEqual(localesOf([{ locale: 'de-DE' }, { locale: 'en-US' }, { locale: 'en-US' }]), [
    'en-US',
    'de-DE',
  ]);
});

const summary = (over: Partial<AsoSummary> = {}): AsoSummary => ({
  app: { id: 'a1', platform: 'ios', store: 'app_store' },
  keywords: { total: 10, ranked: 6, notRanked: 3, unchecked: 1, failing: 0, top3: 1, top10: 4 },
  movers: [
    {
      keywordId: 'k1',
      term: 'water reminder',
      country: 'us',
      locale: 'en-US',
      kind: 'down',
      from: 8,
      to: 21,
      delta: -13,
    },
    {
      keywordId: 'k2',
      term: 'habit',
      country: 'us',
      locale: 'en-US',
      kind: 'up',
      from: 20,
      to: 4,
      delta: 16,
    },
    {
      keywordId: 'k3',
      term: 'hydrate',
      country: 'de',
      locale: 'de-DE',
      kind: 'dropped',
      from: 6,
      to: null,
      delta: null,
    },
    {
      keywordId: 'k4',
      term: 'tiny',
      country: 'us',
      locale: 'en-US',
      kind: 'down',
      from: 30,
      to: 32,
      delta: -2,
    },
  ],
  competitors: { total: 3, notFound: 0, changedRecently: 1 },
  state: {
    lastAttemptAt: 1,
    lastSuccessAt: 1,
    lastError: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    lastResult: null,
  },
  ...over,
});

test('big drops are a move down past the threshold or leaving the results from the top 10', () => {
  assert.equal(isBigDrop({ kind: 'down', from: 8, delta: -13 }), true);
  assert.equal(isBigDrop({ kind: 'down', from: 30, delta: -2 }), false);
  assert.equal(isBigDrop({ kind: 'down', from: 30, delta: -2 }, 2), true);
  assert.equal(isBigDrop({ kind: 'dropped', from: 6, delta: null }), true);
  assert.equal(isBigDrop({ kind: 'dropped', from: 40, delta: null }), false);
  assert.equal(isBigDrop({ kind: 'up', from: 20, delta: 16 }), false);
});

test('the overview orders moves across apps and leaves apps with nothing out of the totals', () => {
  const rows = [
    { name: 'One', appId: 'a1', platform: 'ios' as const, summary: summary() },
    {
      name: 'Two',
      appId: 'a2',
      platform: 'android' as const,
      summary: summary({
        keywords: {
          total: 0,
          ranked: 0,
          notRanked: 0,
          unchecked: 0,
          failing: 0,
          top3: 0,
          top10: 0,
        },
        competitors: { total: 0, notFound: 0, changedRecently: 0 },
        movers: [],
      }),
    },
  ];
  const m = overviewMovers(rows);
  assert.deepEqual(
    m.gains.map((x) => x.term),
    ['habit'],
  );
  assert.deepEqual(
    m.drops.map((x) => x.term),
    ['hydrate', 'water reminder', 'tiny'],
  );
  assert.deepEqual(overviewStats(rows), {
    apps: 1,
    keywords: 10,
    ranked: 6,
    top10: 4,
    competitors: 3,
    competitorChanges: 1,
    failing: 0,
  });
  assert.equal(parseThreshold('5'), 5);
  assert.equal(parseThreshold(' 100 '), 100);
  assert.equal(parseThreshold('0'), null);
  assert.equal(parseThreshold('101'), null);
  assert.equal(parseThreshold('2.5'), null);
});

test('Needs attention gets big drops and competitor changes from the summary, and nothing without one', () => {
  const base = {
    apps: [{ id: 'a1', platform: 'ios' as const, lastSyncError: null }],
    scope: null,
    newReviews: {},
    builds: {},
    driftLocales: {},
    stagedUnpushed: {},
    plans: {},
  };
  assert.deepEqual(attentionItems(base), []);
  assert.deepEqual(
    attentionItems({
      ...base,
      aso: {
        a1: summary({ movers: [], competitors: { total: 1, notFound: 0, changedRecently: 0 } }),
      },
    }),
    [],
  );
  const items = attentionItems({ ...base, aso: { a1: summary() } });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.text, '2 keywords dropped in the store search');
  assert.equal(items[0]?.detail, '“water reminder” 8 to 21 and 1 more');
  assert.equal(items[0]?.href, '#/portfolio/a1/insights?view=keywords');
  assert.equal(items[1]?.text, '1 competitor changed recently');
  assert.equal(items[1]?.href, '#/portfolio/a1/insights?view=competitors');
});

import { asoViewsFor, availableAsoView } from './aso.ts';

test('Search terms is offered for Google Play apps only; the others keep their place', () => {
  assert.equal(
    asoViewsFor(false).some((v) => v.id === 'terms'),
    false,
  );
  assert.equal(
    asoViewsFor(true).some((v) => v.id === 'terms'),
    true,
  );
  assert.deepEqual(
    asoViewsFor(true)
      .slice(0, 7)
      .map((v) => v.id),
    ['keywords', 'listing', 'competitors', 'ideas', 'fit', 'gaps', 'markets'],
  );
  assert.equal(
    availableAsoView('terms', false),
    'keywords',
    'an address naming a view this app does not have falls back to Keywords',
  );
  assert.equal(availableAsoView('terms', true), 'terms');
  assert.equal(availableAsoView('rank', false), 'rank');
  assert.equal(asoViewFromHash('#/portfolio/a1/aso?view=rank'), 'rank');
  assert.equal(asoViewFromHash('#/portfolio/a1/aso?view=terms'), 'terms');
});

test('every ASO view stays reachable: two in the switch, the rest behind More, Search terms on its own', () => {
  const placed = [
    ...keywordMainViews.map((v) => v.id),
    ...keywordMoreViews.map((v) => v.id),
    'terms',
  ].sort();
  assert.deepEqual(placed, asoViews.map((v) => v.id).sort());
  assert.deepEqual(
    keywordMainViews.map((v) => v.id),
    ['keywords', 'rank'],
  );
  assert.equal(isMoreKeywordView('fit'), true);
  assert.equal(isMoreKeywordView('rank'), false);
  assert.equal(isMoreKeywordView('terms'), false);
  for (const v of keywordMoreViews) assert.ok(v.hint.length > 0, v.id);
});
