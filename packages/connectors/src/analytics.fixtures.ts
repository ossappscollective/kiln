import { gzipSync } from 'node:zlib';

/**
 * Fixtures for the analytics readers. The tables have the columns Apple and Google document (docs/research/analytics-apis.md) with
 * made-up numbers; the delimiter, the cell wording, the date format and the file names are UNVERIFIED guesses, which is why the
 * parsers read by header name and tests also feed them variants. No real account, token or URL is in here.
 */

export const tsv = (rows: string[][]): string => `${rows.map((r) => r.join('\t')).join('\n')}\n`;
export const csv = (rows: string[][]): string => `${rows.map((r) => r.join(',')).join('\r\n')}\r\n`;
export const gz = (value: string | Uint8Array): Uint8Array => new Uint8Array(gzipSync(typeof value === 'string' ? Buffer.from(value) : value));

/** UTF-16 little endian with a byte order mark, as Google's BigQuery note says some exports are. */
export const utf16le = (value: string): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]));
export const utf16leNoBom = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf16le'));

export const APPLE_APP_ID = '1234567890';

// ---- Apple Analytics Reports -----------------------------------------------------------------

export const DISCOVERY_HEADER = ['Date', 'Event', 'Page Type', 'Source Type', 'Engagement Type', 'Device', 'Platform Version', 'Territory', 'Counts', 'Unique Counts'];
export const DISCOVERY_TSV = tsv([
  DISCOVERY_HEADER,
  ['2026-11-10', 'Impression', 'Today tab', 'App Store Browse', 'Get', 'iPhone', '18.1', 'US', '1200', '900'],
  ['2026-11-10', 'Impression', 'Search result', 'App Store Search', 'Get', 'iPhone', '18.1', 'US', '3400', '2500'],
  ['2026-11-10', 'Impression', 'Search result', 'App Store Search', 'Get', 'iPad', '18.1', 'DE', '600', '450'],
  ['2026-11-10', 'Impression', 'Search result', 'App Store Search', 'Get', 'Mac', '15.1', 'US', '50', '40'],
  ['2026-11-10', 'Page view', 'Product page view', 'App Store Search', 'Open', 'iPhone', '18.1', 'US', '700', '520'],
  ['2026-11-10', 'Page view', 'Product page view', 'Web Referrer', 'Open', 'iPhone', '18.1', 'DE', '80', '70'],
  ['2026-11-10', 'Page view', 'Store sheet', 'Web Referrer', 'Open', 'iPhone', '18.1', 'DE', '30', '20'],
  ['2026-11-10', 'Tap', 'Product page view', 'App Store Search', 'Get', 'iPhone', '18.1', 'US', '10', '10'],
  ['2026-11-11', 'Impression', 'Search result', 'App Store Search', 'Get', 'iPhone', '18.1', 'US', '3500', '2600'],
  ['2026-11-11', 'Page view', 'Product page view', 'App Store Search', 'Open', 'iPhone', '18.1', 'US', '720', '530'],
]);

export const DOWNLOADS_HEADER = [
  'Date', 'App Name', 'App Apple Identifier', 'Download Type', 'App Version', 'Device', 'Platform Version', 'Source Type', 'Source Info',
  'Campaign', 'Page Type', 'Page Title', 'Pre-Order', 'Territory', 'Counts',
];
const dl = (date: string, type: string, version: string, device: string, source: string, territory: string, counts: string) => [
  date, 'Coffee', APPLE_APP_ID, type, version, device, '18.1', source, '', '', 'Product page view', '', 'No', territory, counts,
];
export const DOWNLOADS_TSV = tsv([
  DOWNLOADS_HEADER,
  dl('2026-11-10', 'First-time Download', '2.4.0', 'iPhone', 'App Store Search', 'US', '40'),
  dl('2026-11-10', 'First-time Download', '2.4.0', 'iPhone', 'Web Referrer', 'DE', '5'),
  dl('2026-11-10', 'Redownload', '2.4.0', 'iPhone', 'App Store Search', 'US', '12'),
  dl('2026-11-10', 'Auto-update', '2.4.0', 'iPhone', 'App Store Search', 'US', '900'),
  dl('2026-11-10', 'Manual Update', '2.4.0', 'iPhone', 'App Store Search', 'US', '30'),
  dl('2026-11-10', 'First-time Download', '2.4.0', 'Mac', 'App Store Search', 'US', '3'),
  dl('2026-11-11', 'First-time Download', '2.4.1', 'iPhone', 'App Store Search', 'US', '44'),
]);

export const SESSIONS_TSV = tsv([
  ['Date', 'App Name', 'App Apple Identifier', 'App Version', 'Device', 'Platform Version', 'Sessions', 'Total Session Duration', 'Unique Devices'],
  ['2026-11-10', 'Coffee', APPLE_APP_ID, '2.4.0', 'iPhone', '18.1', '5200', '312000', '800'],
  ['2026-11-10', 'Coffee', APPLE_APP_ID, '2.4.1', 'iPhone', '18.1', '1800', '98000', '300'],
  ['2026-11-11', 'Coffee', APPLE_APP_ID, '2.4.1', 'iPhone', '18.1', '2600', '150000', '420'],
]);

export const CRASHES_TSV = tsv([
  ['Date', 'App Name', 'App Apple Identifier', 'App Version', 'Device', 'Platform Version', 'Crashes', 'Unique Devices'],
  ['2026-11-10', 'Coffee', APPLE_APP_ID, '2.4.0', 'iPhone', '18.1', '14', '9'],
  ['2026-11-10', 'Coffee', APPLE_APP_ID, '2.4.1', 'iPhone', '18.1', '3', '2'],
  ['2026-11-11', 'Coffee', APPLE_APP_ID, '2.4.1', 'iPhone', '18.1', '5', '4'],
]);

// ---- Apple Analytics Reports API (JSON:API) --------------------------------------------------

export const REQUEST_ID = 'req-0001';
export const requestJson = (id = REQUEST_ID, accessType = 'ONGOING', stopped = false) => ({
  type: 'analyticsReportRequests',
  id,
  attributes: { accessType, stoppedDueToInactivity: stopped },
});
export const reportJson = (id: string, name: string, category = 'APP_STORE_ENGAGEMENT') => ({ type: 'analyticsReports', id, attributes: { name, category } });
export const instanceJson = (id: string, processingDate: string, granularity = 'DAILY') => ({
  type: 'analyticsReportInstances',
  id,
  attributes: { granularity, processingDate },
});
export const segmentJson = (id: string, url: string, sizeInBytes = 1000) => ({
  type: 'analyticsReportSegments',
  id,
  attributes: { url, checksum: 'sha256-not-checked', sizeInBytes },
});
/** A pre-signed link as object storage hands them out; the query is the secret. */
export const SEGMENT_URL = 'https://analytics-segments.example-storage.test/reports/seg-1.csv.gz?X-Amz-Signature=SECRETSIGNATURE0123456789&X-Amz-Expires=300';

// ---- Apple Sales and Trends ------------------------------------------------------------------

export const SALES_HEADER = [
  'Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version', 'Product Type Identifier', 'Units', 'Developer Proceeds',
  'Begin Date', 'End Date', 'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier', 'Customer Price',
  'Promo Code', 'Parent Identifier', 'Subscription', 'Period', 'Category', 'CMB', 'Device', 'Supported Platforms',
];
const sale = (type: string, units: string, proceeds: string, date: string, country: string, currency: string, id: string, device = 'iPhone') => [
  'APPLE', 'US', 'coffee-sku', 'Acme', 'Coffee', '2.4.0', type, units, proceeds, date, date, currency, country, currency, id, proceeds, '', '', '', '', 'Food', '', device, 'iOS',
];
export const SALES_TSV = tsv([
  SALES_HEADER,
  sale('1', '10', '2.99', '11/10/2026', 'US', 'USD', APPLE_APP_ID),
  sale('1', '4', '2.49', '11/10/2026', 'DE', 'EUR', APPLE_APP_ID),
  sale('1', '-1', '2.99', '11/10/2026', 'US', 'USD', APPLE_APP_ID),
  sale('7', '500', '0', '11/10/2026', 'US', 'USD', APPLE_APP_ID),
  sale('IA1', '3', '0.99', '11/10/2026', 'US', 'USD', '987654321'),
  sale('1', '99', '1.00', '11/10/2026', 'US', 'USD', '5550001'),
  sale('F1', '2', '4.99', '11/10/2026', 'US', 'USD', APPLE_APP_ID, 'Desktop'),
]);

// ---- Google Play Developer Reporting API -----------------------------------------------------

const day = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)), timeZone: { id: 'America/Los_Angeles' } });
export const vitalsRow = (date: string, metric: string, value: string, versionCode?: string) => ({
  aggregationPeriod: 'DAILY',
  startTime: day(date),
  metrics: [{ metric, decimalValue: { value } }],
  dimensions: versionCode === undefined ? [] : [{ dimension: 'versionCode', int64Value: versionCode }],
});
export const crashRateTotals = { rows: [vitalsRow('2026-11-10', 'crashRate', '0.0123'), vitalsRow('2026-11-11', 'crashRate', '0.0101')] };
export const crashRateByVersion = {
  rows: [
    vitalsRow('2026-11-10', 'crashRate', '0.02', '241'),
    vitalsRow('2026-11-10', 'crashRate', '0.004', '242'),
    vitalsRow('2026-11-11', 'crashRate', '0.003', '242'),
  ],
};
export const anrRateTotals = { rows: [vitalsRow('2026-11-10', 'anrRate', '0.0031')] };
export const anrRateByVersion = { rows: [vitalsRow('2026-11-10', 'anrRate', '0.005', '241')] };
export const freshness = { name: 'apps/x/crashRateMetricSet', freshnessInfo: { freshnesses: [{ aggregationPeriod: 'DAILY', latestEndTime: day('2026-11-12') }] } };

// ---- Google Play Cloud Storage reports -------------------------------------------------------

export const PACKAGE = 'com.example.coffee';
export const BUCKET = 'pubsite_prod_rev_01234567890123456789';
export const INSTALLS_CSV = csv([
  ['Date', 'Package Name', 'Daily Device Installs', 'Daily Device Uninstalls', 'Daily Device Upgrades', 'Total User Installs', 'Daily User Installs', 'Daily User Uninstalls', 'Active Device Installs'],
  ['2026-11-10', PACKAGE, '120', '30', '400', '9000', '110', '25', '7000'],
  ['2026-11-11', PACKAGE, '130', '28', '420', '9110', '121', '22', '7100'],
]);
export const RATINGS_CSV = csv([
  ['Date', 'Package Name', 'Daily Average Rating', 'Total Average Rating'],
  ['2026-11-10', PACKAGE, '4.5', '4.31'],
  ['2026-11-11', PACKAGE, '4.2', '4.30'],
]);
// Columns UNVERIFIED.
export const PERFORMANCE_CSV = csv([
  ['Date', 'Package Name', 'Country', 'Store Listing Visitors', 'Store Listing Acquisitions'],
  ['2026-11-10', PACKAGE, 'US', '1000', '90'],
  ['2026-11-10', PACKAGE, 'DE', '200', '15'],
  ['2026-11-11', PACKAGE, 'US', '1100', '99'],
]);

// ---- A fake fetch that answers bytes and decides by predicate --------------------------------

export type Call = { method: string; url: URL; headers: Headers; body: string | undefined };
export type Answer = { status?: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; throws?: Error };
export type Route = { method: string; test: (url: URL) => boolean; answer: Answer | ((n: number, call: Call) => Answer); used?: number };

export class RouteFetch {
  readonly calls: Call[] = [];
  readonly unexpected: string[] = [];
  readonly routes: Route[] = [];

  /** `test`: a function, a RegExp over `host + path + search`, or a string equal to the path (or `host + path`). */
  on(method: string, test: string | RegExp | ((url: URL) => boolean), answer: Route['answer']): this {
    const fn =
      typeof test === 'function'
        ? test
        : typeof test === 'string'
          ? (url: URL) => url.pathname === test || url.host + url.pathname === test
          : (url: URL) => test.test(url.host + url.pathname + url.search);
    this.routes.push({ method, test: fn, answer, used: 0 });
    return this;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const call: Call = { method, url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && r.test(url));
    if (!route) {
      this.unexpected.push(`${method} ${url.host}${url.pathname}`);
      return new Response('{"error":"no route"}', { status: 599 });
    }
    route.used = (route.used ?? 0) + 1;
    const answer = typeof route.answer === 'function' ? route.answer(route.used, call) : route.answer;
    if (answer.throws) throw answer.throws;
    const body = answer.bytes ?? (answer.json === undefined ? '' : JSON.stringify(answer.json));
    return new Response(body as ConstructorParameters<typeof Response>[0], {
      status: answer.status ?? 200,
      headers: { ...(answer.bytes ? {} : { 'content-type': 'application/json' }), ...answer.headers },
    });
  };
}
