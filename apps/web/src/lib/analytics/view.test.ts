import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyticsOverview, AnalyticsStatus } from './analytics.ts';
import {
  androidOverview,
  androidSalesSeries,
  appleOverview,
  NOW,
  sourceOf,
  statusOf,
} from './fixtures.ts';
import {
  allSeries,
  appleCrashRate,
  buildCards,
  buildChips,
  buildStrip,
  cardCurrencies,
  cardFreshness,
  cardInfo,
  describePanel,
  hasStoredData,
  lastReadAt,
  noRatingHistory,
  overallState,
  pageNotes,
  panelsForCurrency,
  platformNotes,
  scheduleText,
  sourceRows,
  splitHeadline,
  syncLines,
  tableFor,
  tooltipFor,
} from './view.ts';

const without = (o: AnalyticsOverview, ...ids: string[]): AnalyticsOverview => ({
  ...o,
  series: o.series.filter((s) => ids.indexOf(s.id) < 0),
});

// ---- chips ----

test('the Apple chips show only what has data, each with its change against the previous period', () => {
  const chips = buildChips('ios', appleOverview(), appleOverview(), 28);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['impressions', 'product_page_views', 'downloads', 'conversion', 'crash_rate'],
  );
  const downloads = chips.find((c) => c.id === 'downloads');
  assert.ok(downloads);
  assert.match(downloads.value, /\d/);
  assert.equal(downloads.delta.kind, 'flat');
  assert.equal(downloads.line, 'About the same as the previous 28 days');
});

test('a chip without data is left out, not shown as zero', () => {
  const chips = buildChips(
    'ios',
    without(appleOverview(), 'sessions', 'crashes', 'impressions'),
    null,
    28,
  );
  const ids = chips.map((c) => c.id);
  assert.ok(!ids.includes('crash_rate'));
  assert.ok(!ids.includes('impressions'));
  assert.ok(chips.every((c) => c.value !== '0' && c.value !== ''));
  assert.deepEqual(buildChips('ios', appleOverview({ empty: true }), null, 28), []);
  assert.deepEqual(buildChips('ios', null, null, 28), []);
});

test('with no previous period a chip says nothing about change', () => {
  const chips = buildChips('ios', appleOverview(), null, 28);
  assert.ok(chips.length > 0);
  for (const c of chips) {
    assert.equal(c.delta.kind, 'none');
    assert.equal(c.line, '');
    assert.equal(c.tone, 'neutral');
  }
});

test('the Android chips use installs, conversion, vitals and the newest rating', () => {
  const chips = buildChips('android', androidOverview(), androidOverview(), 28);
  assert.deepEqual(
    chips.map((c) => c.id),
    ['downloads', 'product_page_views', 'conversion', 'crash_rate', 'anr_rate', 'rating'],
  );
  const rating = chips.find((c) => c.id === 'rating');
  assert.match(rating?.value ?? '', /^4\.\d\d$/);
});

test('Apple crash rate is crashes per session, derived here and labelled so', () => {
  const rate = appleCrashRate(appleOverview());
  assert.ok(rate);
  assert.equal(rate.derived, true);
  assert.ok(rate.coverage.notes.some((n) => n.code === 'derived'));
  assert.ok(rate.points.every((p) => p.value === null || (p.value > 0 && p.value < 1)));
  assert.equal(appleCrashRate(without(appleOverview(), 'sessions')), null);
  assert.equal(appleCrashRate(null), null);
  const chip = buildChips('ios', appleOverview(), null, 28).find((c) => c.id === 'crash_rate');
  assert.match(chip?.title ?? '', /Derived here/);
});

// ---- cards ----

test('Apple cards come in reading order and a card without data is not drawn', () => {
  assert.deepEqual(
    buildCards(appleOverview()).map((c) => c.id),
    ['reach', 'downloads', 'conversion', 'crashes', 'proceeds'],
  );
  assert.deepEqual(
    buildCards(without(appleOverview(), 'sales_proceeds:EUR', 'sales_proceeds:USD')).map(
      (c) => c.id,
    ),
    ['reach', 'downloads', 'conversion', 'crashes'],
  );
  assert.deepEqual(buildCards(appleOverview({ empty: true })), []);
  assert.deepEqual(buildCards(null), []);
});

test('proceeds are one panel per currency and never added together', () => {
  const proceeds = buildCards(appleOverview()).find((c) => c.id === 'proceeds');
  assert.ok(proceeds);
  assert.equal(proceeds.panels.length, 2);
  assert.deepEqual(
    proceeds.panels.map((p) => p.currency),
    ['EUR', 'USD'],
  );
  assert.ok(proceeds.panels.every((p) => p.series.length === 1));
  const only = buildCards(without(appleOverview(), 'sales_proceeds:USD')).find(
    (c) => c.id === 'proceeds',
  );
  assert.equal(only?.panels.length, 1);
  assert.equal(only?.panels[0]?.title, 'EUR');
});

test('downloads stack first-time and redownloads in two colors; a lone panel is named by its card', () => {
  const downloads = buildCards(appleOverview()).find((c) => c.id === 'downloads');
  const panel = downloads?.panels[0];
  assert.equal(panel?.kind, 'stacked');
  assert.equal(panel?.title, null);
  assert.deepEqual(
    panel?.series.map((s) => s.color),
    [1, 2],
  );
  const reach = buildCards(appleOverview()).find((c) => c.id === 'reach');
  assert.deepEqual(
    reach?.panels.map((p) => p.title),
    ['Impressions', 'Product page views'],
  );
});

test('crashes by version come from the app_version breakdown', () => {
  const crashes = buildCards(appleOverview()).find((c) => c.id === 'crashes');
  assert.equal(crashes?.versions.length, 1);
  assert.deepEqual(
    crashes?.versions[0]?.items.map((i) => i.value),
    ['2.4.1', '2.4.0', '2.3.9'],
  );
  const none = buildCards(without(appleOverview(), 'crashes')).find((c) => c.id === 'crashes');
  assert.equal(none?.versions.length ?? 0, 0);
});

test('Android cards: crash and ANR share a chart in two colors and the rating axis follows the data', () => {
  const cards = buildCards(androidOverview());
  assert.deepEqual(
    cards.map((c) => c.id),
    ['installs', 'listing', 'conversion', 'vitals', 'ratings'],
  );
  const vitals = cards.find((c) => c.id === 'vitals');
  assert.deepEqual(
    vitals?.panels[0]?.series.map((s) => s.color),
    [1, 2],
  );
  assert.equal(vitals?.versions.length, 1);
  assert.equal(cards.find((c) => c.id === 'ratings')?.panels[0]?.domain, 'tight');
  assert.equal(vitals?.panels[0]?.domain, 'zero');
});

test('Apple has no rating history and says so; Android does', () => {
  assert.equal(noRatingHistory('ios'), true);
  assert.equal(noRatingHistory('macos'), true);
  assert.equal(noRatingHistory('android'), false);
  assert.ok(!buildCards(appleOverview()).some((c) => c.id === 'ratings'));
  assert.match(platformNotes(appleOverview())[0] ?? '', /\S/);
});

// ---- honesty ----

test('every card names its sources with how late they can be, once per source', () => {
  const reach = buildCards(appleOverview()).find((c) => c.id === 'reach');
  assert.ok(reach);
  const lines = cardFreshness(reach);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^Data up to Nov 17\. Apple reports can lag up to 3 days\.$/);
  const proceeds = buildCards(appleOverview()).find((c) => c.id === 'proceeds');
  assert.match(cardFreshness(proceeds as never)[0] ?? '', /Sales and Trends/);
});

test('the about-this-data info lists source, coverage with gaps, lag and notes per series', () => {
  const card = buildCards(appleOverview({ gap: true })).find((c) => c.id === 'reach');
  assert.ok(card);
  const info = cardInfo(card);
  assert.deepEqual(
    info.map((i) => i.id),
    ['impressions', 'product_page_views'],
  );
  assert.equal(info[0]?.source, 'App Store analytics reports');
  assert.match(info[0]?.coverage ?? '', /2 days missing between the first and the last/);
  assert.ok((info[0]?.notes.length ?? 0) >= 1);
  const derived = cardInfo(buildCards(appleOverview()).find((c) => c.id === 'conversion') as never);
  assert.match(derived[0]?.source ?? '', /derived here/);
});

test('page notes list each limit once, only for the data that is there', () => {
  const notes = pageNotes(appleOverview());
  assert.equal(new Set(notes).size, notes.length);
  assert.ok(notes.length >= 2);
  assert.deepEqual(pageNotes(appleOverview({ empty: true })), []);
  assert.deepEqual(pageNotes(null), []);
});

// ---- tooltip, description, table ----

test('the tooltip gives exact numbers, says No data for a gap and marks provisional days', () => {
  const overview = appleOverview({ gap: true });
  const reach = buildCards(overview).find((c) => c.id === 'reach');
  const panel = reach?.panels[0];
  assert.ok(panel);
  const mid = tooltipFor(panel, 5, '2026-11-19');
  assert.equal(mid?.heading, 'Oct 27, 2026');
  assert.match(mid?.rows[0]?.text ?? '', /^[\d,]+$/);
  assert.equal(mid?.provisional, false);
  const gap = tooltipFor(panel, 12, '2026-11-19');
  assert.equal(gap?.rows[0]?.text, 'No data');
  assert.equal(gap?.rows[0]?.missing, true);
  const recent = tooltipFor(panel, 26, '2026-11-19');
  assert.equal(recent?.provisional, true);
  assert.equal(tooltipFor(panel, 99, '2026-11-19'), null);
});

test('a stacked tooltip adds a total row without a swatch', () => {
  const panel = buildCards(appleOverview()).find((c) => c.id === 'downloads')?.panels[0];
  assert.ok(panel);
  const tip = tooltipFor(panel, 3, '2026-11-19');
  assert.deepEqual(
    tip?.rows.map((r) => r.label),
    ['First-time downloads', 'Redownloads', 'Total'],
  );
  assert.equal(tip?.rows[2]?.color, 0);
  const a = Number((tip?.rows[0]?.text ?? '').replace(/,/g, ''));
  const b = Number((tip?.rows[1]?.text ?? '').replace(/,/g, ''));
  assert.equal(tip?.rows[2]?.text, String(a + b).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
});

test('the chart description gives the latest, lowest and highest value and the days with no data', () => {
  const card = buildCards(appleOverview({ gap: true })).find((c) => c.id === 'reach');
  const text = describePanel(card?.panels[0] as never, 'Impressions and product page views');
  assert.match(
    text,
    /^Impressions\. Impressions: latest [\d.,KM]+, lowest [\d.,KM]+, highest [\d.,KM]+, 3 days with no data\.$/,
  );
});

test('the table twin has a row per day, a column per series, and No data for a gap', () => {
  const card = buildCards(appleOverview({ gap: true })).find((c) => c.id === 'reach');
  assert.ok(card);
  const table = tableFor(card);
  assert.deepEqual(table.columns, ['Date', 'Impressions', 'Product page views']);
  assert.equal(table.rows.length, 28);
  assert.equal(table.rows[0]?.date, 'Oct 22, 2026');
  assert.deepEqual(table.rows[12]?.cells, ['No data', 'No data']);
  assert.equal(table.rows[27]?.cells[0], 'No data');
});

test('a Play rate of unverified unit is shown as percent and also as sent', () => {
  const card = buildCards(androidOverview()).find((c) => c.id === 'vitals');
  assert.ok(card);
  const table = tableFor(card);
  assert.deepEqual(table.columns, [
    'Date',
    'Crash rate',
    'Crash rate, as sent',
    'ANR rate',
    'ANR rate, as sent',
  ]);
  const row = table.rows[0]?.cells ?? [];
  assert.match(row[0] ?? '', /%$/);
  assert.match(row[1] ?? '', /^0\.\d+$/);
  assert.equal(allSeries(card).length, 2);
});

// ---- status to next step ----

test('analytics off is the state "off"', () => {
  assert.equal(overallState(statusOf({ enabled: false })), 'off');
});

test('the worst required state wins; an optional setup does not count', () => {
  const ready = sourceOf({ source: 'apple_analytics' });
  assert.equal(overallState(statusOf({ sources: [ready] })), 'ready');
  const optional = sourceOf({
    source: 'apple_sales',
    state: 'needs_setup',
    setup: {
      code: 'vendor_number_missing',
      nextStep: 'set_vendor_number',
      alternatives: [],
      optional: true,
      message: 'x',
    },
  });
  assert.equal(overallState(statusOf({ sources: [ready, optional] })), 'ready');
  const waiting = sourceOf({ source: 'apple_analytics', state: 'waiting' });
  assert.equal(overallState(statusOf({ sources: [waiting, optional] })), 'waiting');
  const failed = sourceOf({
    source: 'apple_sales',
    state: 'error',
    lastError: { code: 'sync_failed', message: 'x' },
  });
  assert.equal(overallState(statusOf({ sources: [waiting, failed] })), 'error');
});

test('a source that needs the role offers enabling, with importing a file as the alternative, and says it in plain words', () => {
  const status: AnalyticsStatus = statusOf({
    apple: { mode: 'off', requests: [], vendorNumberSet: false },
    sources: [
      sourceOf({
        source: 'apple_analytics',
        state: 'needs_setup',
        lastOkAt: null,
        lastAttemptAt: null,
        firstDay: null,
        lastDay: null,
        setup: {
          code: 'create_report_request',
          nextStep: 'enable_apple_analytics',
          alternatives: ['import_apple_report', 'wait'],
          optional: false,
          message: 'server text',
        },
      }),
    ],
  });
  const [row] = sourceRows(status, NOW);
  assert.ok(row);
  assert.equal(row.state, 'needs_setup');
  assert.equal(row.stateLabel, 'Needs setup');
  assert.equal(row.action?.kind, 'enable_apple');
  assert.deepEqual(
    row.alternatives.map((a) => a.kind),
    ['import'],
  );
  assert.match(row.message, /report request/);
  assert.equal(row.message.includes('server text'), false);
  assert.equal(row.lastRead, 'Not read yet');
  assert.equal(row.range, null);
});

test('a ready source says its range and when it was read; a failed read is a fixed sentence with Sync now as the step', () => {
  const rows = sourceRows(
    statusOf({
      sources: [
        sourceOf({ source: 'apple_analytics', firstDay: '2026-10-25', lastDay: '2026-11-16' }),
        sourceOf({
          source: 'apple_sales',
          state: 'error',
          lastError: { code: 'google_permission_denied', message: 'RAW STORE TEXT' },
        }),
      ],
    }),
    NOW,
  );
  assert.equal(rows[0]?.message, 'Data from Oct 25, 2026 to Nov 16, 2026.');
  assert.match(rows[0]?.lastRead ?? '', /^Last read /);
  assert.equal(rows[1]?.action?.kind, 'sync');
  assert.ok(rows[1]?.error);
  assert.equal(rows[1]?.error?.includes('RAW STORE TEXT'), false);
});

test('stored data, last read and the schedule are plain facts', () => {
  const status = statusOf();
  assert.equal(hasStoredData(status), true);
  assert.equal(
    hasStoredData(statusOf({ sources: [sourceOf({ source: 'apple_analytics', lastDay: null })] })),
    false,
  );
  assert.equal(hasStoredData(null), false);
  assert.equal(lastReadAt(status), NOW - 3_600_000);
  assert.equal(lastReadAt(statusOf({ sources: [] })), null);
  assert.equal(scheduleText(statusOf()), 'Synced every 6 hours.');
  assert.equal(
    scheduleText(statusOf({ schedule: { intervalMinutes: 1440 } })),
    'Synced every day.',
  );
  assert.equal(
    scheduleText(statusOf({ schedule: { intervalMinutes: 45 } })),
    'Synced every 45 minutes.',
  );
  assert.match(scheduleText(statusOf({ schedule: { intervalMinutes: 0 } })), /no scheduled sync/);
  assert.match(scheduleText(statusOf({ enabled: false })), /off while analytics is off/);
});

test('a manual sync is reported per source in fixed words', () => {
  const lines = syncLines({
    at: NOW,
    pointsWritten: 12,
    sources: [
      {
        source: 'apple_analytics',
        status: 'ok',
        points: 12,
        dayFrom: '2026-11-10',
        dayTo: '2026-11-16',
      },
      { source: 'apple_sales', status: 'ok', points: 0 },
      {
        source: 'play_vitals',
        status: 'failed',
        errorCode: 'google_permission_denied',
        transient: true,
      },
      { source: 'play_reports', status: 'skipped', setup: 'bucket_id_missing' },
    ],
  });
  assert.equal(lines[0]?.text, 'Read 12 values for Nov 10 to Nov 16.');
  assert.equal(lines[1]?.text, 'Nothing new.');
  assert.match(lines[2]?.text ?? '', /The next sync tries again\.$/);
  assert.equal(lines[2]?.tone, 'bad');
  assert.match(lines[3]?.text ?? '', /^Skipped\. Add the Cloud Storage bucket/);
});

// ---- strip ----

test('the dashboard strip has downloads, conversion and crash rate with their sparkline data, or nothing', () => {
  const strip = buildStrip(appleOverview());
  assert.deepEqual(
    strip?.items.map((i) => i.id),
    ['downloads', 'conversion', 'crash_rate'],
  );
  assert.equal(strip?.items[0]?.points.length, 28);
  assert.equal(strip?.items[0]?.dates.length, 28);
  assert.match(strip?.freshness ?? '', /^Data up to /);
  assert.equal(buildStrip(appleOverview({ empty: true })), null);
  assert.equal(buildStrip(null), null);
  const android = buildStrip(androidOverview());
  assert.deepEqual(
    android?.items.map((i) => i.label),
    ['Installs', 'Conversion', 'Crash rate'],
  );
});

test('the Insights overview draws one chart open: downloads or installs, the rest behind "More charts"', () => {
  const apple = splitHeadline(buildCards(appleOverview()));
  assert.equal(apple.headline?.id, 'downloads');
  assert.deepEqual(
    apple.rest.map((c) => c.id),
    ['reach', 'conversion', 'crashes', 'proceeds'],
  );
  const google = splitHeadline(buildCards(androidOverview()));
  assert.equal(google.headline?.id, 'installs');
  assert.equal(google.rest.length, buildCards(androidOverview()).length - 1);
  assert.deepEqual(splitHeadline([]), { headline: null, rest: [] });
  const odd = [
    { id: 'x', title: 'X', panels: [], versions: [] },
    { id: 'y', title: 'Y', panels: [], versions: [] },
  ];
  assert.equal(
    splitHeadline(odd).headline?.id,
    'x',
    'without a downloads or installs card, the first one',
  );
});

test('Android sales are their own card, named as buyer-paid estimates, one panel per currency and never called proceeds', () => {
  const base = androidOverview();
  assert.ok(!buildCards(base).some((c) => c.id === 'sales'), 'no sales data, no card');
  const cards = buildCards({ ...base, series: [...base.series, ...androidSalesSeries()] });
  const sales = cards.find((c) => c.id === 'sales');
  assert.ok(sales);
  assert.equal(sales.title, 'Sales (buyer-paid, estimated)');
  assert.ok(!cards.some((c) => c.id === 'proceeds'));
  assert.deepEqual(
    sales.panels.map((p) => p.id),
    ['sales_gross:EUR', 'sales_gross:USD', 'sales_refunds:EUR', 'sales_orders'],
  );
  assert.deepEqual(
    sales.panels.map((p) => p.currency),
    ['EUR', 'USD', 'EUR', null],
  );
  assert.ok(sales.panels.every((p) => p.series.every((s) => !/proceeds/i.test(s.label))));
  assert.ok(sales.panels.filter((p) => p.currency !== null).every((p) => p.series.length === 1));
  // The honesty lines of the page carry the buyer-paid limit.
  const notes = pageNotes({ ...base, series: [...base.series, ...androidSalesSeries()] });
  assert.ok(notes.some((t) => /what buyers paid/i.test(t)));
  assert.ok(notes.every((t) => !/server text/.test(t)));
});

test('a card with several currencies shows one at a time, the biggest first, and never adds them', () => {
  const base = androidOverview();
  const sales = buildCards({ ...base, series: [...base.series, ...androidSalesSeries()] }).find((c) => c.id === 'sales');
  assert.ok(sales);
  const currencies = cardCurrencies(sales);
  assert.deepEqual([...currencies].sort(), ['EUR', 'USD']);
  const first = currencies[0] ?? '';
  const shown = panelsForCurrency(sales, first);
  assert.ok(shown.every((p) => p.currency === null || p.currency === first), 'only that currency, plus orders');
  assert.ok(shown.some((p) => p.id === 'sales_orders'), 'a panel without a currency stays');
  assert.ok(shown.filter((p) => p.currency === first).every((p) => p.title !== first), 'the tab names the currency');
  const other = currencies[1] ?? '';
  assert.ok(panelsForCurrency(sales, other).every((p) => p.currency !== first));
  // One currency: nothing to choose.
  const apple = buildCards(without(appleOverview(), 'sales_proceeds:USD')).find((c) => c.id === 'proceeds');
  assert.ok(apple);
  assert.deepEqual(cardCurrencies(apple), ['EUR']);
});
