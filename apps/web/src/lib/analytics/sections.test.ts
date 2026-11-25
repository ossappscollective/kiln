import assert from 'node:assert/strict';
import { test } from 'node:test';
import { railEntries, resolveRailSection } from '../section-rail.ts';
import {
  cardPart,
  cardsOfPart,
  failedSourceCount,
  INSIGHTS_PARTS,
  insightsGroups,
  latestRead,
  platformColumns,
  revenueHost,
  withoutHeadline,
  worstState,
} from './sections.ts';

const card = (id: string) => ({ id });
const all = [
  'installs',
  'listing',
  'conversion',
  'vitals',
  'ratings',
  'sales',
  'reach',
  'downloads',
  'crashes',
  'proceeds',
  'subscriptions',
  'earnings',
];

test('every chart card is in exactly one part', () => {
  const parts = ['acquisition', 'quality', 'revenue'] as const;
  const cards = all.map(card) as never[];
  const seen = parts.flatMap((p) => cardsOfPart(cards, p).map((c) => (c as { id: string }).id));
  assert.deepEqual([...seen].sort(), [...all].sort());
  assert.equal(cardPart(card('crashes')), 'quality');
  assert.equal(cardPart(card('proceeds')), 'revenue');
  assert.equal(cardPart(card('something-new')), 'acquisition');
});

test('the headline chart is left out of the rest of its part', () => {
  const cards = ['downloads', 'reach'].map(card) as never[];
  assert.deepEqual(
    withoutHeadline(cards, 'downloads').map((c) => (c as { id: string }).id),
    ['reach'],
  );
  assert.equal(withoutHeadline(cards, null).length, 2);
});

test('platforms sit side by side from two on', () => {
  assert.equal(platformColumns(1), 1);
  assert.equal(platformColumns(2), 2);
  assert.equal(platformColumns(3), 2);
});

test('the RevenueCat block has one host for the scope: the first linked record', () => {
  assert.equal(
    revenueHost([
      { id: 'a', linked: false },
      { id: 'b', linked: true },
      { id: 'c', linked: true },
    ])?.id,
    'b',
  );
  assert.equal(revenueHost([{ id: 'a', linked: false }]), null);
  assert.equal(revenueHost([]), null);
});

test('the rail has every part, hides Next steps without the right, and flags failed sources', () => {
  const counts = { acquisition: 3, quality: 2, revenue: 0, failedSources: 2 };
  assert.deepEqual(
    railEntries(insightsGroups(counts, true)).map((e) => e.id),
    [...INSIGHTS_PARTS],
  );
  assert.equal(
    railEntries(insightsGroups(counts, false)).some((e) => e.id === 'next'),
    false,
  );
  const sources = railEntries(insightsGroups(counts, true)).find((e) => e.id === 'sources');
  assert.equal(sources?.count, 2);
  assert.equal(
    railEntries(insightsGroups({ ...counts, failedSources: 0 }, true)).find(
      (e) => e.id === 'sources',
    )?.count,
    null,
  );
});

test('?section= opens a part and anything else opens Overview', () => {
  const ids = railEntries(
    insightsGroups({ acquisition: 0, quality: 0, revenue: 0, failedSources: null }, true),
  ).map((e) => e.id);
  assert.equal(resolveRailSection('#/portfolio/a/insights?section=sources', ids), 'sources');
  assert.equal(resolveRailSection('#/portfolio/a/insights?range=28', ids), 'overview');
});

test('one state for the scope: the worst platform wins, off only when all are off', () => {
  assert.equal(worstState(['ready', 'error']), 'error');
  assert.equal(worstState(['ready', 'waiting']), 'waiting');
  assert.equal(worstState(['off', 'ready']), 'ready');
  assert.equal(worstState(['off', 'off']), 'off');
  assert.equal(worstState([]), 'off');
});

test('failed sources are counted across platforms and the newest read wins', () => {
  assert.equal(
    failedSourceCount([
      { sources: [{ state: 'error' }, { state: 'ready' }] },
      { sources: [{ state: 'error' }] },
    ]),
    2,
  );
  assert.equal(latestRead([null, 5, 9, 2]), 9);
  assert.equal(latestRead([null]), null);
});
