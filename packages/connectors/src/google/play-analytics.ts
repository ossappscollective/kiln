import { type AnalyticsMetric, addDays, analyticsLimits, normalizeBucketId } from '@mrm/core';
import { AnalyticsError, type AnalyticsPoint, type ParseStats } from '../analytics-types.ts';
import {
  columnIndex,
  decodeTableText,
  openFileBytes,
  parseDay,
  parseNumber,
  parseTable,
  type Table,
} from '../delimited.ts';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import {
  enc,
  isRecord,
  type Json,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from '../store-http.ts';
import {
  DEVSTORAGE_READ_ONLY_SCOPE,
  GoogleTokenProvider,
  PLAY_DEVELOPER_REPORTING_SCOPE,
  parseServiceAccount,
  type ServiceAccount,
} from './google-auth.ts';
import { googleError, isPlayPackageName } from './googleplay.ts';

/**
 * Google Play analytics, read only: Android vitals from the Play Developer Reporting API and the monthly CSV reports in the Cloud
 * Storage bucket of the developer account. Facts and unknowns follow docs/research/analytics-apis.md (sections 3.1 and 3.2).
 *
 * Reporting API (scope `playdeveloperreporting`, confirmed on the `query` reference page; one token per scope, the default
 * `androidpublisher` token is never sent here):
 * - `POST https://playdeveloperreporting.googleapis.com/v1beta1/apps/{package}/{crashRate|anrRate}MetricSet:query` with
 *   `timelineSpec` (DAILY, America/Los_Angeles only), `metrics`, `dimensions` (`versionCode`), `pageSize` (default 1000, max 10000).
 * - UNVERIFIED: the exact JSON field names of a row and of `freshnessInfo` (written from the reference as read, not from a real
 *   answer), the unit of `crashRate` (a fraction or a percentage; stored as sent), the depth of the history (a 2022 post says
 *   three years), the thresholds under which a small app gets no rows, and the exact Play Console permission name.
 *
 * Cloud Storage (scope `devstorage.read_only`; the bucket id is a new input and no API call to find it was found):
 * - list `GET https://storage.googleapis.com/storage/v1/b/{bucket}/o?prefix=` and read `...o/{object}?alt=media`.
 * - Files are monthly CSVs posted 3 to 7 days late. Names, the `overview` file, the `store_performance` columns, the encoding
 *   (UTF-16 is decoded when a byte order mark says so) and whether a month file is cumulative are UNVERIFIED. The current month
 *   is read again every time; a column that is not there is reported, never invented.
 * - Google states that the legacy CSV exports support only the original store listing metrics, and changed those metrics in
 *   June and July 2026: the `store_performance` series may be thin or empty (UNVERIFIED).
 */

export type PlayAnalyticsOptions = Omit<StoreHttpOptions, 'store'> & {
  serviceAccount: string | ServiceAccount;
  packageName: string;
  /** Defaults to https://playdeveloperreporting.googleapis.com. */
  reportingBase?: string;
  /** Defaults to https://storage.googleapis.com. */
  storageBase?: string;
  /** `pubsite_prod_rev_<number>`, with or without `gs://`. Needed for the reports only. */
  bucketId?: string;
};

export type PlayVitalsResult = {
  points: AnalyticsPoint[];
  /** The last day (YYYY-MM-DD, Pacific Time) the API says it has, or null when it did not say. UNVERIFIED shape. */
  dataThrough: string | null;
  rows: number;
};

export interface PlayVitalsPort {
  /** Daily crash and ANR rates, total and by version code, for the days `from` to `to` inclusive (YYYY-MM-DD). */
  rates(input: { from: string; to: string }): Promise<PlayVitalsResult>;
}

export type PlayReportFile = { report: 'installs' | 'ratings' | 'store_performance'; name: string };
export type PlayReportsResult = {
  points: AnalyticsPoint[];
  files: PlayReportFile[];
  /** Reports with no file in the bucket for the month. */
  missing: ('installs' | 'ratings' | 'store_performance')[];
  /** Reports whose file was there but had none of the columns this server maps. */
  unmapped: ('installs' | 'ratings' | 'store_performance')[];
  stats: ParseStats;
};

export interface PlayReportsPort {
  /** Whether the bucket holds any report file of the package, whatever the month. Optional: a port without it cannot tell. */
  hasPackage?(): Promise<boolean>;
  /** The reports of one month (`YYYYMM`). */
  readMonth(month: string): Promise<PlayReportsResult>;
}

const REPORTING_BASE = 'https://playdeveloperreporting.googleapis.com';
const STORAGE_BASE = 'https://storage.googleapis.com';
const MAX_VITALS_PAGES = 20;

const metricOf: Record<string, AnalyticsMetric> = { crashRate: 'crash_rate', anrRate: 'anr_rate' };

/** The date of a `{ year, month, day }` object, as YYYY-MM-DD. */
function dateOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const y = Number(value.year);
  const m = Number(value.month);
  const d = Number(value.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  const day = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return parseDay(day);
}

/**
 * Rows of a `...MetricSet:query` answer as points. Field names are UNVERIFIED (see above). A row without a date, a metric this
 * server maps or a number is skipped. The `versionCode` dimension becomes the `app_version` dimension.
 */
export function parseVitalsRows(json: unknown): {
  points: AnalyticsPoint[];
  rows: number;
  skipped: number;
} {
  const body = isRecord(json) ? json : {};
  const points: AnalyticsPoint[] = [];
  let skipped = 0;
  const rows = records(body.rows);
  for (const row of rows) {
    const date = dateOf(row.startTime);
    if (!date) {
      skipped++;
      continue;
    }
    let version: string | undefined;
    for (const dim of records(row.dimensions)) {
      if (text(dim.dimension) === 'versionCode') {
        const raw = dim.stringValue ?? dim.int64Value;
        version =
          typeof raw === 'string' || typeof raw === 'number'
            ? String(raw).slice(0, analyticsLimits.maxDimensionLength)
            : undefined;
      }
    }
    for (const m of records(row.metrics)) {
      const metric = metricOf[text(m.metric) ?? ''];
      const decimal = isRecord(m.decimalValue) ? m.decimalValue.value : m.decimalValue;
      const value =
        typeof decimal === 'number'
          ? decimal
          : parseNumber(typeof decimal === 'string' ? decimal : undefined);
      if (!metric || value === undefined) {
        skipped++;
        continue;
      }
      points.push({
        date,
        metric,
        value,
        ...(version !== undefined
          ? { dimension: { type: 'app_version' as const, value: version } }
          : {}),
      });
    }
  }
  return { points, rows: rows.length, skipped };
}

function makeHttp(options: PlayAnalyticsOptions): { http: StoreHttp; account: ServiceAccount } {
  const account =
    typeof options.serviceAccount === 'string'
      ? parseServiceAccount(options.serviceAccount)
      : options.serviceAccount;
  if (!isPlayPackageName(options.packageName)) {
    throw new StoreError(
      'googleplay',
      'invalid_input',
      `Not a valid Android package name: ${JSON.stringify(options.packageName.slice(0, 80))}.`,
    );
  }
  return { http: new StoreHttp({ ...options, store: 'googleplay' }), account };
}

export class PlayVitalsConnector implements PlayVitalsPort {
  readonly #http: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #package: string;
  readonly #projectId: string | undefined;

  constructor(options: PlayAnalyticsOptions) {
    const { http, account } = makeHttp(options);
    this.#http = http;
    this.#package = options.packageName;
    this.#projectId = account.projectId;
    this.#base = (options.reportingBase ?? REPORTING_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(account, http, PLAY_DEVELOPER_REPORTING_SCOPE);
  }

  async rates(input: { from: string; to: string }): Promise<PlayVitalsResult> {
    const points: AnalyticsPoint[] = [];
    let rows = 0;
    let dataThrough: string | null = null;
    for (const set of ['crashRate', 'anrRate'] as const) {
      // The documented rule: the freshness value "can be used directly as the endpoint in a query time range". An end time
      // newer than the data the store has is refused (HTTP 400), so the end is never later than the freshness.
      const latestEnd = await this.#freshness(set);
      if (latestEnd !== undefined) {
        const through = addDays(latestEnd, -1);
        if (dataThrough === null || through > dataThrough) dataThrough = through;
      }
      const end =
        latestEnd !== undefined && latestEnd < addDays(input.to, 1)
          ? latestEnd
          : addDays(input.to, 1);
      if (end <= input.from) continue; // the store has no day in the range yet
      for (const dimensions of [[], ['versionCode']]) {
        const read = await this.#query(set, { from: input.from, endExclusive: end }, dimensions);
        points.push(...read.points);
        rows += read.rows;
      }
    }
    return { points, dataThrough, rows };
  }

  /** The exclusive end (YYYY-MM-DD, Pacific Time) of the newest DAILY data the metric set has, or undefined when it did not say. */
  async #freshness(set: string): Promise<string | undefined> {
    try {
      const json = await this.#call(
        'GET',
        `${this.#base}/v1beta1/apps/${enc(this.#package)}/${set}MetricSet`,
        `reading the freshness of ${set}`,
      );
      const info = isRecord(json.freshnessInfo) ? json.freshnessInfo : {};
      for (const f of records(info.freshnesses)) {
        if (text(f.aggregationPeriod) === 'DAILY') return dateOf(f.latestEndTime);
      }
    } catch (error) {
      // Freshness is a hint. A refusal of the setup (code) or a rate limit is reported now; anything else by the query that follows.
      if (error instanceof AnalyticsError || error instanceof StoreRateLimitError) throw error;
    }
    return undefined;
  }

  async #query(
    set: string,
    range: { from: string; endExclusive: string },
    dimensions: string[],
  ): Promise<{ points: AnalyticsPoint[]; rows: number }> {
    // DAILY needs the hours, minutes, seconds and nanos unset and the only supported time zone is America/Los_Angeles.
    const day = (iso: string) => ({
      year: Number(iso.slice(0, 4)),
      month: Number(iso.slice(5, 7)),
      day: Number(iso.slice(8, 10)),
      timeZone: { id: 'America/Los_Angeles' },
    });
    const points: AnalyticsPoint[] = [];
    let rows = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_VITALS_PAGES; page++) {
      const json = await this.#call(
        'POST',
        `${this.#base}/v1beta1/apps/${enc(this.#package)}/${set}MetricSet:query`,
        `reading ${set} for ${this.#package}`,
        {
          timelineSpec: {
            aggregationPeriod: 'DAILY',
            startTime: day(range.from),
            endTime: day(range.endExclusive),
          },
          metrics: [set],
          dimensions,
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
        },
      );
      const parsed = parseVitalsRows(json);
      points.push(...parsed.points);
      rows += parsed.rows;
      pageToken = text(json.nextPageToken) || undefined;
      if (!pageToken) break;
    }
    return { points, rows };
  }

  async #call(method: 'GET' | 'POST', url: string, what: string, json?: unknown): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      const reply = await this.#http.send(method, url, {
        headers: { authorization: `Bearer ${token}` },
        ...(json !== undefined ? { json } : {}),
      });
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) {
        if (reply.malformed || !isRecord(reply.json)) {
          throw new StoreError(
            'googleplay',
            'unexpected',
            `Google answered ${what} with a response that could not be read.`,
            reply.status,
          );
        }
        return reply.json;
      }
      throw playAnalyticsError(
        reply,
        what,
        { packageName: this.#package, projectId: this.#projectId },
        'vitals',
        this.#http,
      );
    }
  }
}

/** A Google error as an `AnalyticsError` (a fixed code) where analytics has one, else the usual `StoreError`. */
function playAnalyticsError(
  reply: StoreReply,
  what: string,
  context: { packageName: string; projectId: string | undefined },
  api: 'vitals' | 'storage',
  http: StoreHttp,
): Error {
  const error = googleError(reply, what, {
    packageName: context.packageName,
    ...(context.projectId ? { projectId: context.projectId } : {}),
  });
  if (error instanceof StoreRateLimitError) return error;
  if (api === 'vitals') {
    if (error.kind === 'api_disabled')
      return new AnalyticsError('play_reporting_not_enabled', undefined, reply.status);
    if (error.kind === 'forbidden')
      return new AnalyticsError('play_permission_missing', undefined, reply.status);
    if (error.kind === 'not_found')
      return new AnalyticsError('play_app_not_found', undefined, reply.status);
    // 400 INVALID_ARGUMENT: the query itself was refused (a fault of this server), never shown with Google's text.
    if (reply.status === 400)
      return new AnalyticsError('play_vitals_bad_request', undefined, reply.status);
  } else {
    if (error.kind === 'forbidden' || error.kind === 'api_disabled')
      return new AnalyticsError('bucket_forbidden', undefined, reply.status);
    if (error.kind === 'not_found')
      return new AnalyticsError('bucket_not_found', undefined, reply.status);
  }
  return new StoreError('googleplay', error.kind, http.redact(error.message), error.status);
}

// ---------------------------------------------------------------------------------------------
// Cloud Storage reports

type Mapping = {
  column: string[];
  metric: AnalyticsMetric /** `sum` adds rows of a day (a breakdown file), `last` keeps one value. */;
  combine: 'sum' | 'last';
}[];

const installsMapping: Mapping = [
  { column: ['daily user installs'], metric: 'installs_user', combine: 'sum' },
  { column: ['daily device installs'], metric: 'installs_device', combine: 'sum' },
  { column: ['daily device uninstalls'], metric: 'uninstalls_device', combine: 'sum' },
  { column: ['active device installs'], metric: 'active_installs_device', combine: 'last' },
];
const ratingsMapping: Mapping = [
  { column: ['daily average rating'], metric: 'rating_average_daily', combine: 'last' },
  { column: ['total average rating'], metric: 'rating_average_total', combine: 'last' },
];
// Columns UNVERIFIED (the help page read does not list them): the likely names are accepted.
const performanceMapping: Mapping = [
  {
    column: ['store listing visitors', 'visitors', 'store listing visitor'],
    metric: 'store_listing_visitors',
    combine: 'sum',
  },
  {
    column: ['store listing acquisitions', 'acquisitions', 'store listing acquisition'],
    metric: 'store_listing_acquisitions',
    combine: 'sum',
  },
];

/** Daily points of a Play CSV by header name. A column of the mapping that is absent is skipped; none present is `mapped: false`. */
export function mapPlayTable(
  table: Table,
  mapping: Mapping,
): { points: AnalyticsPoint[]; mapped: boolean; stats: ParseStats } {
  const cols = columnIndex(table.header);
  const dateAt = cols.get('date');
  const usable = mapping.flatMap((m) => {
    const index = m.column.map((c) => cols.get(c)).find((i) => i !== undefined);
    return index === undefined ? [] : [{ ...m, index }];
  });
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  if (dateAt === undefined || usable.length === 0) return { points: [], mapped: false, stats };
  const acc = new Map<string, AnalyticsPoint>();
  for (const row of table.rows) {
    const date = parseDay(row[dateAt]);
    if (!date) {
      stats.rowsUnreadable++;
      continue;
    }
    let used = false;
    for (const m of usable) {
      const value = parseNumber(row[m.index]);
      if (value === undefined) continue;
      used = true;
      const key = `${date}\u0000${m.metric}`;
      const found = acc.get(key);
      if (found && m.combine === 'sum') found.value += value;
      else acc.set(key, { date, metric: m.metric, value });
    }
    if (used) stats.rowsUsed++;
    else stats.rowsUnreadable++;
  }
  const points = [...acc.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.metric.localeCompare(b.metric),
  );
  return { points, mapped: true, stats };
}

type ReportKind = PlayReportFile['report'];
const reportDefs: {
  report: ReportKind;
  dir: string /** File suffixes in order of preference. */;
  suffixes: string[];
  mapping: Mapping;
}[] = [
  {
    report: 'installs',
    dir: 'installs',
    suffixes: ['overview', 'country'],
    mapping: installsMapping,
  },
  { report: 'ratings', dir: 'ratings', suffixes: ['overview'], mapping: ratingsMapping },
  {
    report: 'store_performance',
    dir: 'store_performance',
    suffixes: ['country', 'overview', 'traffic_source'],
    mapping: performanceMapping,
  },
];

/**
 * A Play Console statistics CSV read by hand (Download reports > Statistics, or a file out of the reports bucket), for an app whose
 * service account cannot read the bucket. It is the SAME table as the bucket's monthly file, so it is read with the same column
 * mappings, BY NAME. The report is told by which of its columns are present (installs, ratings, or store listing performance). When
 * the file has a package name column, rows of another package are left out (an account-wide export holds every app).
 */
export function mapPlayConsoleFile(
  table: Table,
  packageName: string,
): { report: PlayReportFile['report']; points: AnalyticsPoint[]; stats: ParseStats } | undefined {
  const cols = columnIndex(table.header);
  const packageAt = cols.get('package name');
  let rows = table.rows;
  let filtered = 0;
  if (packageAt !== undefined) {
    rows = table.rows.filter(
      (r) =>
        (r[packageAt] ?? '').trim().toLowerCase() === packageName.toLowerCase() ||
        (r[packageAt] ?? '').trim() === '',
    );
    filtered = table.rows.length - rows.length;
  }
  const matched = (mapping: Mapping) =>
    mapping.filter((m) => m.column.some((c) => cols.has(c))).length;
  const candidates = reportDefs
    .map((def) => ({ def, n: matched(def.mapping) }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n);
  const best = candidates[0];
  if (!best) return undefined;
  const mapped = mapPlayTable({ ...table, rows }, best.def.mapping);
  if (!mapped.mapped) return undefined;
  return {
    report: best.def.report,
    points: mapped.points,
    stats: { ...mapped.stats, rowsFiltered: mapped.stats.rowsFiltered + filtered },
  };
}

export class PlayReportsConnector implements PlayReportsPort {
  readonly #http: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #package: string;
  readonly #bucket: string;
  readonly #projectId: string | undefined;

  constructor(options: PlayAnalyticsOptions) {
    const { http, account } = makeHttp(options);
    const bucket = options.bucketId === undefined ? undefined : normalizeBucketId(options.bucketId);
    if (!bucket) throw new AnalyticsError(options.bucketId ? 'bucket_invalid' : 'bucket_missing');
    this.#http = http;
    this.#package = options.packageName;
    this.#bucket = bucket;
    this.#projectId = account.projectId;
    this.#base = (options.storageBase ?? STORAGE_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(account, http, DEVSTORAGE_READ_ONLY_SCOPE);
  }

  async hasPackage(): Promise<boolean> {
    for (const def of reportDefs)
      if ((await this.#list(`stats/${def.dir}/${def.dir}_${this.#package}_`, 1)).length > 0)
        return true;
    return false;
  }

  async readMonth(month: string): Promise<PlayReportsResult> {
    if (!/^\d{6}$/.test(month))
      throw new StoreError('googleplay', 'invalid_input', 'Not a valid month.');
    const points: AnalyticsPoint[] = [];
    const files: PlayReportFile[] = [];
    const missing: PlayReportsResult['missing'] = [];
    const unmapped: PlayReportsResult['unmapped'] = [];
    const stats: ParseStats = { rowsRead: 0, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 };
    for (const def of reportDefs) {
      const prefix = `stats/${def.dir}/${def.dir}_${this.#package}_${month}`;
      const names = await this.#list(prefix);
      const wanted = def.suffixes.map((s) => `${prefix}_${s}.csv`).find((n) => names.includes(n));
      if (!wanted) {
        missing.push(def.report);
        continue;
      }
      const raw = await this.#download(wanted);
      const table = parseTable(decodeTableText(await openFileBytes(raw)));
      const mapped = mapPlayTable(table, def.mapping);
      files.push({ report: def.report, name: wanted });
      stats.rowsRead += mapped.stats.rowsRead;
      stats.rowsUsed += mapped.stats.rowsUsed;
      stats.rowsUnreadable += mapped.stats.rowsUnreadable;
      if (!mapped.mapped) unmapped.push(def.report);
      else points.push(...mapped.points);
    }
    return { points, files, missing, unmapped, stats };
  }

  /**
   * Object names under a prefix of the account's bucket, for readers of OTHER folders of the same bucket (the sales reports,
   * docs/adr/0038-sales-analytics.md). Same token, limits and error mapping as the statistics reports.
   */
  listObjects(prefix: string): Promise<string[]> {
    return this.#list(prefix);
  }

  /** The bytes of one object of the bucket (`reports_not_found` when it is not there). */
  downloadObject(name: string): Promise<Uint8Array> {
    return this.#download(name);
  }

  async #list(prefix: string, maxResults = 100): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url =
        `${this.#base}/storage/v1/b/${enc(this.#bucket)}/o?prefix=${enc(prefix)}&maxResults=${maxResults}&fields=${enc('items(name),nextPageToken')}` +
        (pageToken ? `&pageToken=${enc(pageToken)}` : '');
      const reply = await this.#authed(url, `listing the Play Console reports of ${this.#package}`);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(reply));
      } catch {
        throw new StoreError(
          'googleplay',
          'unexpected',
          'Google Cloud Storage answered a listing with a response that could not be read.',
        );
      }
      const body = isRecord(json) ? json : {};
      for (const item of records(body.items)) {
        const name = text(item.name);
        if (name) names.push(name);
      }
      pageToken = text(body.nextPageToken) || undefined;
      if (!pageToken || (maxResults === 1 && names.length > 0)) break;
    }
    return names;
  }

  async #download(name: string): Promise<Uint8Array> {
    return this.#authed(
      `${this.#base}/storage/v1/b/${enc(this.#bucket)}/o/${enc(name)}?alt=media`,
      `reading a Play Console report of ${this.#package}`,
      true,
    );
  }

  async #authed(url: string, what: string, media = false): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      let reply: { status: number; headers: Headers; bytes: Uint8Array };
      try {
        reply = await this.#http.sendBytes('GET', url, {
          headers: { authorization: `Bearer ${token}` },
          maxBytes: media ? analyticsLimits.maxFileBytes : 1024 * 1024,
          accept: media ? '*/*' : 'application/json',
        });
      } catch (error) {
        if (error instanceof StoreError && error.kind === 'too_large')
          throw new AnalyticsError('file_too_large');
        throw error;
      }
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return reply.bytes;
      let json: unknown;
      let malformed = false;
      try {
        json = JSON.parse(new TextDecoder().decode(reply.bytes));
      } catch {
        malformed = true;
      }
      // A missing object is a missing report; a missing bucket is a wrong id. Cloud Storage uses the same status for both.
      if (reply.status === 404 && media)
        throw new AnalyticsError('reports_not_found', undefined, 404);
      throw playAnalyticsError(
        { status: reply.status, headers: reply.headers, json, malformed },
        what,
        { packageName: this.#package, projectId: this.#projectId },
        'storage',
        this.#http,
      );
    }
  }
}
