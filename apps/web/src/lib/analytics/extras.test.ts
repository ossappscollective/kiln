import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AnalyticsOverview, formatDay, freshnessLine, monthKey } from './analytics.ts';
import {
  buildEarningsCard,
  buildSubscriptionsCard,
  earningsRange,
  earningsWaitingLine,
  firstOfMonthBack,
  hasEarnings,
  hasSubscriptions,
  loadExtras,
  monthlySeries,
} from './extras.ts';
import { mkSeries, NOW, sourceOf, statusOf } from './fixtures.ts';
import { cardDates, cardFreshness, cardInfo, cardCurrencies, panelsForCurrency, tableFor } from './view.ts';

const MONTHS = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];

/** A monthly series as the API answers `granularity=month`: one point per month, dated the first of it. */
function monthly(id: string, metric: string, currency: string | null, values: (number | null)[], extra: Record<string, unknown> = {}) {
  const s = mkSeries({
    id,
    metric,
    label: id,
    unit: currency ? 'money' : 'count',
    source: 'play_earnings',
    delayDays: 40,
    currency,
    values,
    from: '2026-06-01',
    notes: ['play_earnings_monthly', 'play_earnings_net'],
    ...extra,
  });
  // mkSeries dates points a day apart: re-date them to the first of each month, as the API does for a monthly series.
  return { ...s, cadence: 'monthly' as const, points: s.points.map((p, i) => ({ date: MONTHS[i] as string, value: p.value })), coverage: { ...s.coverage, firstDay: '2026-06-01', lastDay: '2026-10-01' } };
}

const earningsOverview = (): AnalyticsOverview => ({
  appId: 'a',
  platform: 'android',
  from: '2025-12-01',
  to: '2026-11-19',
  granularity: 'month',
  notes: [],
  series: [
    monthly('earnings_net:EUR', 'earnings_net', 'EUR', [100, 120, null, 90, 130]),
    monthly('earnings_charges:EUR', 'earnings_charges', 'EUR', [150, 170, null, 130, 180]),
    monthly('earnings_net:USD', 'earnings_net', 'USD', [10, 12, 14, 9, 13]),
    monthly('earnings_orders', 'earnings_orders', null, [30, 31, null, 29, 40]),
  ],
});

test('the earnings card: one panel per currency with net and charges as two series of that currency, never summed; months, not days', () => {
  const card = buildEarningsCard(earningsOverview());
  assert.ok(card);
  assert.equal(card.title, 'Earnings (net, monthly)');
  assert.deepEqual(cardCurrencies(card), ['EUR', 'USD'], 'biggest first; the chart card picks the locale default');
  const eur = panelsForCurrency(card, 'EUR');
  assert.deepEqual(eur.map((p) => p.id), ['earnings:EUR', 'earnings_orders']);
  assert.deepEqual(eur[0]?.series.map((s) => s.series.id), ['earnings_net:EUR', 'earnings_charges:EUR']);
  assert.match(eur[0]?.series[0]?.label ?? '', /^Net, after Google's fees and taxes \(EUR\)$/);
  assert.ok(!card.panels.some((p) => p.series.some((s) => s.series.currency === 'EUR') && p.series.some((s) => s.series.currency === 'USD')), 'no panel mixes currencies');
  assert.deepEqual(cardDates(card), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(formatDay('2026-10'), 'Oct 2026');
  assert.equal(formatDay('2026-10', true), 'Oct 2026');
  const table = tableFor(card);
  assert.equal(table.rows[0]?.date, 'Jun 2026');
  assert.equal(table.rows[2]?.cells[0], 'No data', 'a month without a report is missing, not zero');
});

test('the freshness and coverage lines of a monthly series name months', () => {
  const card = buildEarningsCard(earningsOverview());
  assert.ok(card);
  assert.match(cardFreshness(card)[0] ?? '', /^Data up to Oct 2026\./);
  assert.match(cardFreshness(card)[0] ?? '', /in the first days of the next month/);
  const info = cardInfo(card);
  assert.ok(info.every((i) => /months? with data/.test(i.coverage)), info.map((i) => i.coverage).join('|'));
  assert.equal(
    freshnessLine({ source: 'play_earnings', delayDays: 40, cadence: 'monthly', coverage: { state: 'complete', firstDay: null, lastDay: '2026-10-01', days: 1, gapDays: 0, notes: [] } }),
    freshnessLine(monthlySeries(monthly('x', 'earnings_net', 'EUR', [1, 2, 3, 4, 5]))),
  );
  assert.equal(monthKey('2026-10-01'), '2026-10');
});

test('without earnings the card is not drawn, and a currency series without data is left out', () => {
  assert.equal(buildEarningsCard(null), null);
  assert.equal(buildEarningsCard({ ...earningsOverview(), series: [] }), null);
  const only = { ...earningsOverview(), series: [monthly('earnings_net:EUR', 'earnings_net', 'EUR', [null, null, null, null, null])] };
  assert.equal(buildEarningsCard(only), null);
});

test('the earnings read covers twelve months and is monthly whatever the page range is', async () => {
  assert.deepEqual(earningsRange('2026-11-19'), { from: '2025-12-01', to: '2026-11-19' });
  assert.equal(firstOfMonthBack('2026-02-10', 3), '2025-11-01');
  const asked: Record<string, string | undefined>[] = [];
  const api = {
    analyticsOverview: async (_w: string, _a: string, q: Record<string, string | undefined> = {}) => {
      asked.push(q);
      return earningsOverview();
    },
  };
  const status = statusOf({
    platform: 'android',
    sources: [sourceOf({ source: 'play_vitals' }), sourceOf({ source: 'play_earnings' }), sourceOf({ source: 'play_subscriptions' })],
  });
  const range = { from: '2026-10-22', to: '2026-11-18', days: 28 } as never;
  const got = await loadExtras(api, 'w', { id: 'a', platform: 'android' }, status, range, NOW);
  assert.ok(got.earnings && got.subscriptions);
  assert.deepEqual(asked.map((q) => [q.granularity, q.from, q.breakdown]), [
    ['month', '2025-12-01', undefined],
    ['day', '2026-10-22', 'product'],
  ]);
  // Nothing stored for these sources: no read at all.
  asked.length = 0;
  const none = await loadExtras(api, 'w', { id: 'a', platform: 'android' }, statusOf({ platform: 'android' }), range, NOW);
  assert.deepEqual([none.earnings, none.subscriptions, asked.length], [null, null, 0]);
  // A failed read drops that card only.
  const failing = { analyticsOverview: async () => Promise.reject(new Error('x')) };
  assert.deepEqual(await loadExtras(failing, 'w', { id: 'a', platform: 'android' }, status, range, NOW), { earnings: null, subscriptions: null });
});

test('a set-up earnings source with no month yet says "not available yet", and says nothing when it has data or is not set up', () => {
  const waiting = statusOf({ platform: 'android', sources: [sourceOf({ source: 'play_earnings', state: 'waiting', lastDay: null, firstDay: null })] });
  assert.match(earningsWaitingLine(waiting), /^Google Play earnings are not available yet/);
  assert.equal(hasEarnings(waiting), false);
  const ready = statusOf({ platform: 'android', sources: [sourceOf({ source: 'play_earnings' })] });
  assert.equal(earningsWaitingLine(ready), '');
  assert.equal(hasEarnings(ready), true);
  const needs = statusOf({ platform: 'android', sources: [sourceOf({ source: 'play_earnings', state: 'needs_setup', lastDay: null, firstDay: null })] });
  assert.equal(earningsWaitingLine(needs), '');
  const failed = statusOf({ platform: 'android', sources: [sourceOf({ source: 'play_earnings', state: 'error', lastDay: null, firstDay: null })] });
  assert.equal(earningsWaitingLine(failed), '', 'the sources panel says what failed');
  assert.equal(earningsWaitingLine(null), '');
});

const subsOverview = (family: 'apple' | 'google'): AnalyticsOverview => {
  const p = family === 'apple' ? '' : 'play_';
  const src = family === 'apple' ? 'apple_subscriptions' : 'play_subscriptions';
  const s = (id: string, values: (number | null)[], breakdown?: { dimension: string; items: { value: string; total: number }[] }) =>
    mkSeries({ id: `${p}${id}`, label: id, unit: 'count', source: src, values, aggregation: id.endsWith('active') || id.endsWith('trial') ? 'mean' : 'sum', ...(breakdown ? { breakdown } : {}) });
  return {
    appId: 'a',
    platform: family === 'apple' ? 'ios' : 'android',
    from: '2026-10-22',
    to: '2026-10-26',
    granularity: 'day',
    notes: [],
    series: [
      s('subscriptions_active', [50, 51, 52], { dimension: 'product', items: [{ value: 'pro_monthly', total: 40 }, { value: 'pro_yearly', total: 11 }] }),
      s('subscriptions_active_trial', [5, 5, 6]),
      s('subscriptions_new', [4, 3, 5]),
      s('subscriptions_cancelled', [1, 2, 1]),
    ],
  };
};

test('the subscriptions card: counts only, active (with trials), new and cancelled, and the active ones by product', () => {
  const fixed = subsOverview('apple');
  const card = buildSubscriptionsCard(fixed);
  assert.ok(card, 'apple card');
  assert.equal(card.title, 'Subscriptions');
  assert.deepEqual(card.panels.map((p) => p.title), ['Active subscriptions', 'New subscriptions', 'Cancelled subscriptions']);
  assert.ok(card.panels.every((p) => p.unit === 'count' && p.currency === null), 'no money, no currency');
  assert.deepEqual(card.panels[0]?.series.map((s) => s.label), ['subscriptions_active', 'Active free trials']);
  assert.equal(card.versions[0]?.title, 'Active subscriptions by product');
  assert.deepEqual(card.versions[0]?.items.map((i) => i.value), ['pro_monthly', 'pro_yearly']);
  assert.equal(buildSubscriptionsCard(null), null);
  assert.equal(buildSubscriptionsCard({ ...fixed, series: [] }), null);
  assert.equal(hasSubscriptions(statusOf({ sources: [sourceOf({ source: 'apple_subscriptions' })] })), true);
  assert.equal(hasSubscriptions(statusOf()), false);
});

test('Google Play subscription statistics are a separate family: no trial series, their own product breakdown', () => {
  const o = subsOverview('google');
  assert.ok(o.series.every((x) => x.id.startsWith('play_subscriptions_')));
  const card = buildSubscriptionsCard(o);
  assert.ok(card);
  assert.equal(card.panels[0]?.series.length, 1, 'only the active ones: Google reports no trials here');
  assert.equal(card.versions[0]?.id, 'play_subscriptions_by_product');
});
