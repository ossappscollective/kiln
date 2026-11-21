import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  AnalyticsError,
  type AnalyticsPoint,
  type AppleAccessType,
  type AppleAnalyticsPort,
  type AppleInstanceRef,
  type AppleReportRef,
  type AppleReportRequest,
  type PlayEarningsPort,
  type PlayEarningsResult,
  type PlayReportsPort,
  type PlaySalesPort,
  type PlaySalesResult,
  type PlaySubscriptionsPort,
  type PlaySubscriptionsResult,
  type PlayReportsResult,
  type PlayVitalsPort,
  type PlayVitalsResult,
} from '@kiln/connectors';
import { addDays, dateToDay, type Platform } from '@kiln/core';
import type { Database } from '@kiln/db';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import type { AnalyticsConnectorFactory } from './sync.ts';

/** Shared by the analytics tests. Everything runs against fakes: no store, and no network, is ever contacted. */

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
export const ASC_SECRET = JSON.stringify({
  keyId: 'ABC123DEFG',
  issuerId: 'issuer-1',
  privateKey: PEM,
});
export const PLAY_SECRET = JSON.stringify({
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: PEM,
});
export const STORE_APP_ID = '1234567890';
export const BUCKET = 'pubsite_prod_rev_01234567890123456789';
/** What a pre-signed segment link looks like. It must never reach a response, an audit row or a stored row. */
export const SEGMENT_SECRET = 'X-Amz-Signature=SECRETSIGNATURE0123456789';

export const tsv = (rows: string[][]): string => `${rows.map((r) => r.join('\t')).join('\n')}\n`;
export const gz = (value: string): Uint8Array => new Uint8Array(gzipSync(Buffer.from(value)));

// ---- Apple report tables (the columns Apple documents; made-up numbers) -----------------------------------------------

export const discoveryTsv = (a: string, b = a): string =>
  tsv([
    [
      'Date',
      'Event',
      'Page Type',
      'Source Type',
      'Engagement Type',
      'Device',
      'Platform Version',
      'Territory',
      'Counts',
      'Unique Counts',
    ],
    [
      a,
      'Impression',
      'Today tab',
      'App Store Browse',
      'Get',
      'iPhone',
      '18.1',
      'US',
      '1200',
      '900',
    ],
    [
      a,
      'Impression',
      'Search result',
      'App Store Search',
      'Get',
      'iPhone',
      '18.1',
      'US',
      '3400',
      '2500',
    ],
    [
      a,
      'Impression',
      'Search result',
      'App Store Search',
      'Get',
      'iPad',
      '18.1',
      'DE',
      '600',
      '450',
    ],
    [
      a,
      'Page view',
      'Product page view',
      'App Store Search',
      'Open',
      'iPhone',
      '18.1',
      'US',
      '700',
      '520',
    ],
    [
      b,
      'Impression',
      'Search result',
      'App Store Search',
      'Get',
      'iPhone',
      '18.1',
      'US',
      '3500',
      '2600',
    ],
    [
      b,
      'Page view',
      'Product page view',
      'App Store Search',
      'Open',
      'iPhone',
      '18.1',
      'US',
      '720',
      '530',
    ],
  ]);

export const downloadsTsv = (a: string, counts = '40'): string =>
  tsv([
    [
      'Date',
      'App Name',
      'App Apple Identifier',
      'Download Type',
      'App Version',
      'Device',
      'Platform Version',
      'Source Type',
      'Source Info',
      'Campaign',
      'Page Type',
      'Page Title',
      'Pre-Order',
      'Territory',
      'Counts',
    ],
    [
      a,
      'Coffee',
      STORE_APP_ID,
      'First-time Download',
      '2.4.0',
      'iPhone',
      '18.1',
      'App Store Search',
      '',
      '',
      'Product page view',
      '',
      'No',
      'US',
      counts,
    ],
    [
      a,
      'Coffee',
      STORE_APP_ID,
      'Redownload',
      '2.4.0',
      'iPhone',
      '18.1',
      'App Store Search',
      '',
      '',
      'Product page view',
      '',
      'No',
      'US',
      '12',
    ],
    [
      a,
      'Coffee',
      STORE_APP_ID,
      'Auto-update',
      '2.4.0',
      'iPhone',
      '18.1',
      'App Store Search',
      '',
      '',
      'Product page view',
      '',
      'No',
      'US',
      '900',
    ],
  ]);

export const SALES_HEADER = [
  'Provider',
  'Provider Country',
  'SKU',
  'Developer',
  'Title',
  'Version',
  'Product Type Identifier',
  'Units',
  'Developer Proceeds',
  'Begin Date',
  'End Date',
  'Customer Currency',
  'Country Code',
  'Currency of Proceeds',
  'Apple Identifier',
  'Customer Price',
  'Promo Code',
  'Parent Identifier',
  'Subscription',
  'Period',
  'Category',
  'CMB',
  'Device',
  'Supported Platforms',
];
export const salesTsv = (mmddyyyy: string): string => {
  const row = (
    type: string,
    units: string,
    proceeds: string,
    country: string,
    currency: string,
    id: string,
  ) => [
    'APPLE',
    'US',
    'coffee-sku',
    'Acme',
    'Coffee',
    '2.4.0',
    type,
    units,
    proceeds,
    mmddyyyy,
    mmddyyyy,
    currency,
    country,
    currency,
    id,
    proceeds,
    '',
    '',
    '',
    '',
    'Food',
    '',
    'iPhone',
    'iOS',
  ];
  return tsv([
    SALES_HEADER,
    row('1', '10', '2.99', 'US', 'USD', STORE_APP_ID),
    row('1', '4', '2.49', 'DE', 'EUR', STORE_APP_ID),
    row('7', '500', '0', 'US', 'USD', STORE_APP_ID),
    row('1', '99', '1.00', 'US', 'USD', '5550001'),
  ]);
};
export const mdy = (day: string): string =>
  `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;

// ---- Fakes -----------------------------------------------------------------------------------------------------------

export class FakeApple implements AppleAnalyticsPort {
  requests: AppleReportRequest[] = [];
  /** Thrown by listRequests (an AnalyticsError('analytics_role_required') is what a 403 gives). */
  listError: unknown;
  createError: unknown;
  created: { appStoreId: string; accessType: AppleAccessType }[] = [];
  reports = new Map<string, AppleReportRef[]>();
  instances = new Map<string, AppleInstanceRef[]>();
  /** The segment texts of an instance, or the error that reading it gives. */
  texts = new Map<string, string[] | Error>();
  sales = new Map<string, string | null | Error>();
  /** The subscription reports by `<kind>:<day>`. A day without an entry has no report (null). */
  subscriptions = new Map<string, string | null | Error>();
  subscriptionsAsked: string[] = [];
  reads: string[] = [];
  salesAsked: string[] = [];
  #n = 0;

  async listRequests(): Promise<AppleReportRequest[]> {
    if (this.listError) throw this.listError;
    return this.requests;
  }
  async createRequest(
    appStoreId: string,
    accessType: AppleAccessType,
  ): Promise<AppleReportRequest> {
    if (this.createError) throw this.createError;
    this.created.push({ appStoreId, accessType });
    const request = { id: `req-${++this.#n}`, accessType, stoppedDueToInactivity: false };
    this.requests.push(request);
    return request;
  }
  async listReports(requestId: string): Promise<AppleReportRef[]> {
    return this.reports.get(requestId) ?? [];
  }
  async listInstances(reportId: string): Promise<AppleInstanceRef[]> {
    return this.instances.get(reportId) ?? [];
  }
  async readInstance(
    instanceId: string,
  ): Promise<{ texts: string[]; segments: number; bytes: number }> {
    this.reads.push(instanceId);
    const got = this.texts.get(instanceId);
    if (got instanceof Error) throw got;
    const texts = got ?? [];
    return { texts, segments: texts.length, bytes: texts.reduce((n, t) => n + t.length, 0) };
  }
  async fetchSalesReport(input: { vendorNumber: string; date: string }): Promise<string | null> {
    this.salesAsked.push(`${input.vendorNumber}:${input.date}`);
    const got = this.sales.get(input.date);
    if (got instanceof Error) throw got;
    return got ?? null;
  }
  async fetchSubscriptionReport(input: {
    kind: 'subscription' | 'subscription_event';
    vendorNumber: string;
    date: string;
  }): Promise<string | null> {
    this.subscriptionsAsked.push(`${input.kind}:${input.date}`);
    const got = this.subscriptions.get(`${input.kind}:${input.date}`);
    if (got instanceof Error) throw got;
    return got ?? null;
  }
  /** An ongoing request whose DAILY report instances are given (id -> table text). */
  setUp(
    reportName: string,
    instanceId: string,
    processingDate: string,
    text: string,
    requestId = 'req-ongoing',
    reportId = `rep-${reportName}`,
  ) {
    if (!this.requests.some((r) => r.id === requestId))
      this.requests.push({ id: requestId, accessType: 'ONGOING', stoppedDueToInactivity: false });
    const reports = this.reports.get(requestId) ?? [];
    if (!reports.some((r) => r.id === reportId))
      reports.push({ id: reportId, name: reportName, category: 'APP_STORE_ENGAGEMENT' });
    this.reports.set(requestId, reports);
    const instances = this.instances.get(reportId) ?? [];
    instances.push({ id: instanceId, granularity: 'DAILY', processingDate });
    this.instances.set(reportId, instances);
    this.texts.set(instanceId, [text]);
  }
}

export class FakeVitals implements PlayVitalsPort {
  points: AnalyticsPoint[] = [];
  error: unknown;
  calls: { from: string; to: string }[] = [];
  async rates(input: { from: string; to: string }): Promise<PlayVitalsResult> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return { points: this.points, dataThrough: null, rows: this.points.length };
  }
}

export class FakeReports implements PlayReportsPort {
  /** By month (YYYYMM). A month without an entry has no file. */
  months = new Map<string, AnalyticsPoint[]>();
  error: unknown;
  asked: string[] = [];
  /** Whether the bucket holds any file of the package at all (false: the bucket of another Play account). */
  packageKnown = true;
  async hasPackage(): Promise<boolean> {
    return this.packageKnown;
  }
  async readMonth(month: string): Promise<PlayReportsResult> {
    this.asked.push(month);
    if (this.error) throw this.error;
    const points = this.months.get(month);
    if (!points) throw new AnalyticsError('reports_not_found');
    return {
      points,
      files: [
        { report: 'installs', name: `stats/installs/installs_com.acme.app1_${month}_overview.csv` },
      ],
      missing: [],
      unmapped: [],
      stats: {
        rowsRead: points.length,
        rowsUsed: points.length,
        rowsUnreadable: 0,
        rowsFiltered: 0,
      },
    };
  }
}

export class FakeEarnings implements PlayEarningsPort {
  /** By month (YYYYMM). A month without an entry has no file. */
  months = new Map<string, AnalyticsPoint[]>();
  error: unknown;
  asked: string[] = [];
  async readMonth(month: string): Promise<PlayEarningsResult> {
    this.asked.push(month);
    if (this.error) throw this.error;
    const points = this.months.get(month);
    if (!points) throw new AnalyticsError('reports_not_found');
    return {
      points,
      files: [`earnings/earnings_${month}.zip`],
      stats: { rowsRead: points.length, rowsUsed: points.length, rowsUnreadable: 0, rowsFiltered: 0 },
    };
  }
}

export class FakeSubscriptions implements PlaySubscriptionsPort {
  months = new Map<string, AnalyticsPoint[]>();
  error: unknown;
  asked: string[] = [];
  async readMonth(month: string): Promise<PlaySubscriptionsResult> {
    this.asked.push(month);
    if (this.error) throw this.error;
    const points = this.months.get(month);
    if (!points) throw new AnalyticsError('reports_not_found');
    return {
      points,
      files: [`financial-stats/subscriptions/subscriptions_x_${month}_country.csv`],
      products: 1,
      stats: { rowsRead: points.length, rowsUsed: points.length, rowsUnreadable: 0, rowsFiltered: 0 },
    };
  }
}

export class FakeSales implements PlaySalesPort {
  /** By month (YYYYMM). A month without an entry has no file. */
  months = new Map<string, AnalyticsPoint[]>();
  error: unknown;
  asked: string[] = [];
  async readMonth(month: string): Promise<PlaySalesResult> {
    this.asked.push(month);
    if (this.error) throw this.error;
    const points = this.months.get(month);
    if (!points) throw new AnalyticsError('reports_not_found');
    return {
      points,
      file: `sales/salesreport_${month}.zip`,
      stats: { rowsRead: points.length, rowsUsed: points.length, rowsUnreadable: 0, rowsFiltered: 0 },
    };
  }
}

export type BuiltInput = {
  kind: 'apple' | 'vitals' | 'reports' | 'sales' | 'earnings' | 'subscriptions';
  secret: string;
  packageName?: string;
  bucketId?: string;
};

export async function bootAnalytics(
  db: Database,
  extra: {
    limiter?: ReturnType<typeof import('../../services/credential-tests.ts').createTestLimiter>;
  } = {},
) {
  const apple = new FakeApple();
  const vitals = new FakeVitals();
  const reports = new FakeReports();
  const sales = new FakeSales();
  const earnings = new FakeEarnings();
  const subscriptions = new FakeSubscriptions();
  const built: BuiltInput[] = [];
  const connectors: AnalyticsConnectorFactory = {
    apple: (input) => (built.push({ kind: 'apple', secret: input.secret }), apple),
    playVitals: (input) => (
      built.push({ kind: 'vitals', secret: input.secret, packageName: input.packageName }), vitals
    ),
    playReports: (input) => (
      built.push({
        kind: 'reports',
        secret: input.secret,
        packageName: input.packageName,
        bucketId: input.bucketId,
      }),
      reports
    ),
    playSales: (input) => (
      built.push({
        kind: 'sales',
        secret: input.secret,
        packageName: input.packageName,
        bucketId: input.bucketId,
      }),
      sales
    ),
    playEarnings: (input) => (
      built.push({
        kind: 'earnings',
        secret: input.secret,
        packageName: input.packageName,
        bucketId: input.bucketId,
      }),
      earnings
    ),
    playSubscriptions: (input) => (
      built.push({
        kind: 'subscriptions',
        secret: input.secret,
        packageName: input.packageName,
        bucketId: input.bucketId,
      }),
      subscriptions
    ),
  };
  // The fixed point of the clock is "today"; every table the tests make is dated relative to it.
  const masterKey = randomBytes(32);
  let clock = Date.now();
  const now = () => ++clock;
  const today = () => dateToDay(clock);
  const day = (ago: number) => addDays(today(), -ago);
  const t = await bootRepoApp(db, undefined, {
    masterKey,
    now,
    analytics: {
      connectors,
      intervalMinutes: 360,
      ...(extra.limiter ? { limiter: extra.limiter } : {}),
    },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let appCount = 0;
  const addApp = async (platform: Platform, name?: string) => {
    appCount++;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: `com.acme.app${appCount}`,
      credentialId: platform === 'android' ? playCredential : iosCredential,
      name: name ?? `App ${appCount}`,
    });
    const id = res.body.app.id as string;
    if (platform !== 'android')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', [STORE_APP_ID, id]);
    return id;
  };
  const setSettings = (values: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'PUT', '/settings', values);
  const enable = () => setSettings({ 'analytics.enabled': true });
  /** A request with the file as the raw body. */
  const upload = async (
    cookie: string,
    path: string,
    body: Uint8Array | string,
    workspace = t.workspaceId,
  ) => {
    const res = await t.app.request(`/api/workspaces/${workspace}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie },
      body: typeof body === 'string' ? body : Buffer.from(body),
    });
    const text = await res.text();
    t.texts.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as any };
  };
  const rows = async (
    sql = 'SELECT COUNT(*) AS n FROM analytics_daily',
    params: (string | number)[] = [],
  ) => db.query(sql, params);
  const events = async (type = 'analytics.synced') =>
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200&type=${type}`)).body.events as {
      type: string;
      payload: Record<string, any>;
    }[];
  /** A token (made by the owner's session) and a request made with it. */
  const makeToken = async (
    input: { role?: string; actions?: string[]; appIds?: string[] } = {},
  ) => {
    const res = await t.call(t.owner, 'POST', '/tokens', {
      name: 'Analytics test',
      role: 'admin',
      ...input,
    });
    return res.body?.token as string;
  };
  const bearer = async (
    token: string,
    method: string,
    path: string,
    body?: unknown | Uint8Array,
  ) => {
    const raw = body instanceof Uint8Array;
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
      },
      ...(body === undefined ? {} : { body: raw ? Buffer.from(body) : JSON.stringify(body) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };
  return {
    ...t,
    masterKey,
    connectors,
    apple,
    vitals,
    reports,
    sales,
    earnings,
    subscriptions,
    built,
    now,
    today,
    day,
    addApp,
    setSettings,
    enable,
    upload,
    rows,
    events,
    makeToken,
    bearer,
    iosCredential,
    playCredential,
  };
}
export type AnalyticsBoot = Awaited<ReturnType<typeof bootAnalytics>>;
