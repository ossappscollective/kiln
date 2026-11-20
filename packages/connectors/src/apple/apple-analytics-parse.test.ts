import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fx from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import {
  appleReportKindFromHeader,
  appleReportKindFromName,
  appleReportVariant,
  mapAppleSalesTable,
  mapAppleTable,
} from './apple-analytics-parse.ts';
import { parseTable } from '../delimited.ts';

const find = (
  points: {
    date: string;
    metric: string;
    value: number;
    dimension?: { type: string; value: string };
  }[],
  date: string,
  metric: string,
  dim?: string,
) =>
  points.find(
    (p) =>
      p.date === date &&
      p.metric === metric &&
      (p.dimension ? `${p.dimension.type}:${p.dimension.value}` : undefined) === dim,
  )?.value;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof AnalyticsError ? error.code : `other:${String(error)}`;
  }
  return 'no error';
};

test('report names map to the four reports; Standard and Detailed are told apart; look-alikes are refused', () => {
  assert.equal(
    appleReportKindFromName('App Store Discovery and Engagement Standard'),
    'discovery_engagement',
  );
  assert.equal(appleReportKindFromName('App Store Downloads Detailed'), 'downloads');
  assert.equal(appleReportKindFromName('App Sessions Standard'), 'sessions');
  assert.equal(appleReportKindFromName('App Crashes'), 'crashes');
  assert.equal(appleReportKindFromName('App Crashes Expanded'), undefined);
  assert.equal(appleReportKindFromName('App Sessions Context'), undefined);
  assert.equal(appleReportKindFromName('App Store Purchases Standard'), undefined);
  assert.equal(appleReportKindFromName('Bluetooth Usage'), undefined);
  assert.equal(appleReportVariant('App Store Downloads Detailed'), 'detailed');
  assert.equal(appleReportVariant('App Store Downloads Standard'), 'standard');
  assert.equal(appleReportVariant('App Store Downloads'), 'unknown');
});

test('a header alone identifies each report', () => {
  const kind = (tsv: string) => appleReportKindFromHeader(parseTable(tsv).header);
  assert.equal(kind(fx.DISCOVERY_TSV), 'discovery_engagement');
  assert.equal(kind(fx.DOWNLOADS_TSV), 'downloads');
  assert.equal(kind(fx.SESSIONS_TSV), 'sessions');
  assert.equal(kind(fx.CRASHES_TSV), 'crashes');
  assert.equal(kind('Date\tCount\tBuild\tRelease Type\n2026-11-10\t1\t5\tRelease\n'), undefined);
});

test('discovery and engagement: impressions and product page views, Counts only, other events and pages filtered', () => {
  const r = mapAppleTable(parseTable(fx.DISCOVERY_TSV), {
    platform: 'ios',
    reportName: 'App Store Discovery and Engagement Standard',
  });
  assert.equal(r.kind, 'discovery_engagement');
  assert.equal(r.variant, 'standard');
  // 11-10: iPhone 1200 + 3400 and iPad 600 = 5200; the Mac row is another platform.
  assert.equal(find(r.points, '2026-11-10', 'impressions'), 5200);
  assert.equal(find(r.points, '2026-11-10', 'impressions', 'source_type:App Store Search'), 4000);
  assert.equal(find(r.points, '2026-11-10', 'impressions', 'source_type:App Store Browse'), 1200);
  // Product page views: 700 + 80; the store sheet (30) and the tap (10) are not product page views.
  assert.equal(find(r.points, '2026-11-10', 'product_page_views'), 780);
  assert.equal(find(r.points, '2026-11-11', 'impressions'), 3500);
  assert.equal(find(r.points, '2026-11-11', 'product_page_views'), 720);
  assert.equal(r.dateFrom, '2026-11-10');
  assert.equal(r.dateTo, '2026-11-11');
  assert.equal(r.dates, 2);
  assert.equal(r.stats.rowsRead, 10);
  assert.equal(r.stats.rowsFiltered, 3, 'the Mac row, the store sheet and the tap');
  assert.equal(r.stats.rowsUnreadable, 0);
  assert.equal(
    r.points.some((p) => p.metric === ('unique_counts' as never)),
    false,
  );
});

test('the macOS record keeps the Mac rows, the iOS record the others', () => {
  const mac = mapAppleTable(parseTable(fx.DISCOVERY_TSV), { platform: 'macos' });
  assert.equal(find(mac.points, '2026-11-10', 'impressions'), 50);
  assert.equal(find(mac.points, '2026-11-10', 'product_page_views'), undefined);
  const downloads = mapAppleTable(parseTable(fx.DOWNLOADS_TSV), { platform: 'macos' });
  assert.equal(find(downloads.points, '2026-11-10', 'downloads_first_time'), 3);
});

test('downloads: first-time and redownloads only; updates are not downloads; split by source type and territory', () => {
  const r = mapAppleTable(parseTable(fx.DOWNLOADS_TSV), { platform: 'ios' });
  assert.equal(find(r.points, '2026-11-10', 'downloads_first_time'), 45);
  assert.equal(find(r.points, '2026-11-10', 'downloads_first_time', 'territory:US'), 40);
  assert.equal(find(r.points, '2026-11-10', 'downloads_first_time', 'territory:DE'), 5);
  assert.equal(find(r.points, '2026-11-10', 'downloads_first_time', 'source_type:Web Referrer'), 5);
  assert.equal(find(r.points, '2026-11-10', 'downloads_redownload'), 12);
  assert.equal(find(r.points, '2026-11-11', 'downloads_first_time'), 44);
  assert.equal(r.stats.rowsFiltered, 3, 'auto-update, manual update and the Mac row');
});

test('sessions and crashes: by app version, with the sample note', () => {
  const s = mapAppleTable(parseTable(fx.SESSIONS_TSV), { platform: 'ios' });
  assert.equal(find(s.points, '2026-11-10', 'sessions'), 7000);
  assert.equal(find(s.points, '2026-11-10', 'sessions', 'app_version:2.4.1'), 1800);
  assert.ok(s.notes.some((n) => /chose to share data/.test(n)));
  const c = mapAppleTable(parseTable(fx.CRASHES_TSV), { platform: 'ios' });
  assert.equal(find(c.points, '2026-11-10', 'crashes'), 17);
  assert.equal(find(c.points, '2026-11-10', 'crashes', 'app_version:2.4.0'), 14);
  assert.equal(find(c.points, '2026-11-11', 'crashes', 'app_version:2.4.1'), 5);
});

test('a Detailed report says so; a comma file and a quoted file with other casing still map', () => {
  const detailed = mapAppleTable(parseTable(fx.DOWNLOADS_TSV), {
    platform: 'ios',
    reportName: 'App Store Downloads Detailed',
  });
  assert.equal(detailed.variant, 'detailed');
  assert.ok(detailed.notes.some((n) => /Detailed/.test(n)));
  const comma =
    'DATE,download_type,COUNTS\n2026-11-10,"First-time Download","7"\n2026-11-10,Redownload,2\n';
  const r = mapAppleTable(parseTable(comma), {});
  assert.equal(find(r.points, '2026-11-10', 'downloads_first_time'), 7);
  assert.equal(find(r.points, '2026-11-10', 'downloads_redownload'), 2);
  assert.ok(
    r.points.every((p) => !p.dimension),
    'no breakdown columns, no breakdown points',
  );
});

test('errors are fixed codes: unknown report, missing columns, no usable rows', () => {
  assert.equal(
    codeOf(() => mapAppleTable(parseTable('Foo\tBar\n1\t2\n'))),
    'unknown_report',
  );
  // A name this server does not know falls back to the header, which here is a downloads table.
  assert.equal(
    codeOf(() =>
      mapAppleTable(parseTable(fx.DOWNLOADS_TSV), { reportName: 'App Store Purchases Standard' }),
    ),
    'no error',
  );
  assert.equal(
    codeOf(() =>
      mapAppleTable(parseTable('Date\tEvent\n2026-11-10\tImpression\n'), {
        reportName: 'App Store Discovery and Engagement',
      }),
    ),
    'missing_columns',
  );
  assert.equal(
    codeOf(() =>
      mapAppleTable(
        parseTable(
          'Date\tDownload Type\tCounts\nnot a date\tRedownload\t5\n2026-11-10\tRedownload\tmany\n',
        ),
      ),
    ),
    'no_rows',
  );
  assert.equal(
    codeOf(() =>
      mapAppleTable(parseTable('Date\tDownload Type\tCounts\n2026-11-10\tAuto-update\t5\n')),
    ),
    'no_rows',
  );
});

test('sales: units and proceeds for the app only; refunds are negative; updates, in-app purchases and other apps are left out', () => {
  const r = mapAppleSalesTable(parseTable(fx.SALES_TSV), {
    appleId: fx.APPLE_APP_ID,
    platform: 'ios',
  });
  // 10 + 4 - 1 units of the app (type 1); the update (7), the in-app purchase, another app and the Mac row are excluded.
  assert.equal(find(r.points, '2026-11-10', 'sales_units'), 13);
  assert.equal(find(r.points, '2026-11-10', 'sales_units', 'territory:US'), 9);
  assert.equal(find(r.points, '2026-11-10', 'sales_units', 'territory:DE'), 4);
  // USD: 10 * 2.99 - 1 * 2.99; EUR: 4 * 2.49. Never converted, never added together.
  assert.ok(
    Math.abs((find(r.points, '2026-11-10', 'sales_proceeds', 'currency:USD') ?? 0) - 26.91) < 1e-9,
  );
  assert.ok(
    Math.abs((find(r.points, '2026-11-10', 'sales_proceeds', 'currency:EUR') ?? 0) - 9.96) < 1e-9,
  );
  assert.equal(
    find(r.points, '2026-11-10', 'sales_proceeds'),
    undefined,
    'no total of mixed currencies',
  );
  assert.equal(r.stats.rowsFiltered, 4);
  const mac = mapAppleSalesTable(parseTable(fx.SALES_TSV), {
    appleId: fx.APPLE_APP_ID,
    platform: 'macos',
  });
  assert.equal(find(mac.points, '2026-11-10', 'sales_units'), 2);
});

test('sales: a missing column is refused, a day without rows for the app is an empty success', () => {
  assert.equal(
    codeOf(() =>
      mapAppleSalesTable(parseTable('Units\tBegin Date\n1\t11/10/2026\n'), { appleId: '1' }),
    ),
    'missing_columns',
  );
  const none = mapAppleSalesTable(parseTable(fx.SALES_TSV), { appleId: '42' });
  assert.deepEqual(none.points, []);
  assert.equal(none.stats.rowsFiltered, 7);
});
