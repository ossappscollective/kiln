import { analyticsLimits } from '@mrm/core';
import { AnalyticsError } from '../analytics-types.ts';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';
import { decodeTableText, openFileBytes } from '../delimited.ts';
import { StoreError, type StoreErrorDetail } from '../errors.ts';
import {
  type BytesReply,
  enc,
  isRecord,
  type Json,
  num,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from '../store-http.ts';

/**
 * App Store Connect connector for ANALYTICS: the Analytics Reports API and Sales and Trends. Read only, except
 * `createRequest`, which creates a report request at Apple (the one write; the server calls it only from the explicit,
 * role-gated "enable analytics" action, docs/adr/0017-analytics-foundation.md). Endpoints are those of Apple's pages checked on
 * 2026-11-19 (docs/research/analytics-apis.md, section 2); anything the study marks UNVERIFIED is marked here too.
 *
 * - `POST /v1/analyticsReportRequests` `{ data: { type, attributes: { accessType }, relationships: { app } } }`. `accessType` is
 *   `ONGOING` or `ONE_TIME_SNAPSHOT`. Apple's role table: ADMIN may create. A 403 is `analytics_role_required`.
 * - `GET /v1/apps/{id}/analyticsReportRequests`: used to avoid a second request. What Apple answers to a duplicate is UNVERIFIED.
 * - `GET /v1/analyticsReportRequests/{id}/reports`: `name` and `category` (116 reports in Apple's example). Filter parameter
 *   names are UNVERIFIED, so every page is read and the names are matched here.
 * - `GET /v1/analyticsReports/{id}/instances?filter[granularity]=DAILY`: `granularity`, `processingDate`.
 * - `GET /v1/analyticsReportInstances/{id}/segments`: `url`, `checksum`, `sizeInBytes`. The URL is valid for 5 MINUTES. It is
 *   fetched at once, WITHOUT the bearer header (sending it is UNVERIFIED to break the download; it is not sent), never logged, never
 *   stored, and kept out of `JSON.stringify` and `console.log` (non-enumerable). The checksum algorithm is UNVERIFIED: not checked.
 * - `GET /v1/salesReports`: query parameters (`filter[vendorNumber]`, `filter[reportType]=SALES`, `filter[reportSubType]=SUMMARY`,
 *   `filter[frequency]=DAILY`, `filter[version]=1_0`, `filter[reportDate]`) and a gzip answer are UNVERIFIED on the fetched page.
 *   `INSTALLS` reports ended on 2026-11-04 and are never requested.
 *
 * Every size is capped (`analyticsLimits`): the compressed file when it is received, and the text while it is decompressed.
 */

export type AppleAnalyticsOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  /** Pages read for one list. Default 5. */
  maxPages?: number;
  /** Instances read for one report. Default 400. */
  maxInstances?: number;
};

export type AppleAccessType = 'ONGOING' | 'ONE_TIME_SNAPSHOT';

export type AppleReportRequest = {
  id: string;
  /** Apple's value, kept as sent. */
  accessType: string;
  stoppedDueToInactivity: boolean;
};

export type AppleReportRef = { id: string; name: string; category: string | null };
export type AppleInstanceRef = {
  id: string;
  granularity: string /** YYYY-MM-DD, or '' when Apple sent none. */;
  processingDate: string;
};

/** What a test double or the real connector offers to the server's sync. */
export interface AppleAnalyticsPort {
  listRequests(appStoreId: string): Promise<AppleReportRequest[]>;
  createRequest(appStoreId: string, accessType: AppleAccessType): Promise<AppleReportRequest>;
  listReports(requestId: string): Promise<AppleReportRef[]>;
  /** DAILY instances of a report, newest processing date first. */
  listInstances(reportId: string): Promise<AppleInstanceRef[]>;
  /** The text of every segment of an instance (downloaded at once, decompressed, decoded). */
  readInstance(instanceId: string): Promise<{ texts: string[]; segments: number; bytes: number }>;
  /** The daily Sales and Trends summary of a day (YYYY-MM-DD), as text; null when Apple has no report for it. */
  fetchSalesReport(input: { vendorNumber: string; date: string }): Promise<string | null>;
}

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_ERROR_DETAILS = 5;

const toDay = (value: unknown): string => {
  const raw = text(value);
  if (!raw) return '';
  const t = Date.parse(raw);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
};

export class AppleAnalyticsConnector implements AppleAnalyticsPort {
  readonly #http: StoreHttp;
  /** The pre-signed download links go to another host: a separate instance, so no token can be attached by mistake. */
  readonly #downloads: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #maxPages: number;
  readonly #maxInstances: number;

  constructor(options: AppleAnalyticsOptions) {
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#downloads = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#maxPages = Math.max(1, options.maxPages ?? 5);
    this.#maxInstances = Math.max(1, options.maxInstances ?? 400);
    const pem = options.credential.privateKey;
    for (const http of [this.#http, this.#downloads]) {
      http.known.add(pem);
      http.known.add(pem.trim());
      for (const line of pem.split(/\r?\n/)) {
        if (line && !line.startsWith('-----')) http.known.add(line.trim());
      }
    }
    this.#tokens = new AppStoreConnectTokenProvider(options.credential, this.#http.now);
  }

  static fromSecret(
    secret: string,
    options: Omit<AppleAnalyticsOptions, 'credential'>,
  ): AppleAnalyticsConnector {
    return new AppleAnalyticsConnector({
      ...options,
      credential: parseAppStoreConnectSecret(secret),
    });
  }

  #appId(value: string): string {
    if (!/^[0-9]{1,20}$/.test(value)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the app is missing or not a number. Sync the app first.',
      );
    }
    return value;
  }

  #id(value: string): string {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
      throw new StoreError('appstoreconnect', 'invalid_input', 'Not a valid id.');
    }
    return value;
  }

  async listRequests(appStoreId: string): Promise<AppleReportRequest[]> {
    const id = this.#appId(appStoreId);
    const items = await this.#list(
      `${this.#base}/v1/apps/${enc(id)}/analyticsReportRequests?limit=200`,
      `listing the analytics report requests of app ${id}`,
      { forbidden: 'analytics_role_required' },
    );
    return items.flatMap((item) => {
      const rid = text(item.id);
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      if (!rid) return [];
      return [
        {
          id: rid,
          accessType: text(attributes.accessType) ?? '',
          stoppedDueToInactivity: attributes.stoppedDueToInactivity === true,
        },
      ];
    });
  }

  /**
   * Creates a report request at Apple. A STORE WRITE (a request that keeps producing reports). A 403 is `analytics_role_required`
   * (Apple's table: Admin). Never retried on a 429: a second POST could create a second request.
   */
  async createRequest(
    appStoreId: string,
    accessType: AppleAccessType,
  ): Promise<AppleReportRequest> {
    const id = this.#appId(appStoreId);
    const json = await this.#call(
      'POST',
      `${this.#base}/v1/analyticsReportRequests`,
      `creating an analytics report request for app ${id}`,
      {
        data: {
          type: 'analyticsReportRequests',
          attributes: { accessType },
          relationships: { app: { data: { type: 'apps', id } } },
        },
      },
      { forbidden: 'analytics_role_required' },
    );
    const data = isRecord(json.data) ? json.data : {};
    const rid = text(data.id);
    if (!rid) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'Apple answered the creation of the report request with a response that could not be read.',
      );
    }
    const attributes = isRecord(data.attributes) ? data.attributes : {};
    return {
      id: rid,
      accessType: text(attributes.accessType) ?? accessType,
      stoppedDueToInactivity: attributes.stoppedDueToInactivity === true,
    };
  }

  async listReports(requestId: string): Promise<AppleReportRef[]> {
    const id = this.#id(requestId);
    const items = await this.#list(
      `${this.#base}/v1/analyticsReportRequests/${enc(id)}/reports?limit=200`,
      `listing the analytics reports of request ${id}`,
      { forbidden: 'analytics_role_required', notFound: 'analytics_request_missing' },
    );
    return items.flatMap((item) => {
      const rid = text(item.id);
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const name = text(attributes.name);
      if (!rid || !name) return [];
      return [{ id: rid, name: name.slice(0, 200), category: text(attributes.category) ?? null }];
    });
  }

  async listInstances(reportId: string): Promise<AppleInstanceRef[]> {
    const id = this.#id(reportId);
    const items = await this.#list(
      `${this.#base}/v1/analyticsReports/${enc(id)}/instances?filter[granularity]=DAILY&limit=200`,
      `listing the instances of analytics report ${id}`,
      { forbidden: 'analytics_role_required', notFound: 'analytics_request_missing' },
      Math.ceil(this.#maxInstances / 200),
    );
    const found = items.flatMap((item) => {
      const iid = text(item.id);
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      if (!iid) return [];
      return [
        {
          id: iid,
          granularity: text(attributes.granularity) ?? '',
          processingDate: toDay(attributes.processingDate),
        },
      ];
    });
    // Only DAILY files are read (a weekly or monthly file carries the first day of a period in its Date column).
    return found
      .filter((i) => i.granularity === '' || i.granularity === 'DAILY')
      .sort((a, b) => b.processingDate.localeCompare(a.processingDate))
      .slice(0, this.#maxInstances);
  }

  /** The segments of an instance with their pre-signed links (valid about 5 minutes). The link is not enumerable. */
  async #segments(
    instanceId: string,
  ): Promise<{ id: string; sizeInBytes: number | undefined; url: string }[]> {
    const id = this.#id(instanceId);
    const items = await this.#list(
      `${this.#base}/v1/analyticsReportInstances/${enc(id)}/segments?limit=200`,
      `listing the segments of analytics instance ${id}`,
      { forbidden: 'analytics_role_required', notFound: 'analytics_request_missing' },
    );
    const out: { id: string; sizeInBytes: number | undefined; url: string }[] = [];
    for (const item of items) {
      const sid = text(item.id);
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const url = text(attributes.url);
      if (!sid || !url) continue;
      const segment = { id: sid, sizeInBytes: num(attributes.sizeInBytes) } as {
        id: string;
        sizeInBytes: number | undefined;
        url: string;
      };
      // Not enumerable: a log line, an error report or JSON.stringify of a segment shows no link.
      Object.defineProperty(segment, 'url', { value: url, enumerable: false });
      out.push(segment);
    }
    return out;
  }

  async readInstance(
    instanceId: string,
  ): Promise<{ texts: string[]; segments: number; bytes: number }> {
    // The links expire after about 5 minutes. They are used at once; a link that is already dead is asked for again, once.
    for (let attempt = 0; ; attempt++) {
      const segments = await this.#segments(instanceId);
      try {
        const texts: string[] = [];
        let bytes = 0;
        for (const segment of segments) {
          if (
            segment.sizeInBytes !== undefined &&
            segment.sizeInBytes > analyticsLimits.maxFileBytes
          ) {
            throw new AnalyticsError('segment_too_large');
          }
          const raw = await this.#download(segment.url);
          bytes += raw.byteLength;
          const opened = await openFileBytes(raw, { tooLarge: 'segment_too_large' });
          texts.push(decodeTableText(opened));
        }
        return { texts, segments: segments.length, bytes };
      } catch (error) {
        if (error instanceof AnalyticsError && error.code === 'segment_expired' && attempt === 0)
          continue;
        throw error;
      }
    }
  }

  async #download(url: string): Promise<Uint8Array> {
    let reply: BytesReply;
    try {
      // No headers: the link is pre-signed, and no token goes to the storage host.
      reply = await this.#downloads.sendBytes('GET', url, {
        maxBytes: analyticsLimits.maxFileBytes,
      });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'too_large')
        throw new AnalyticsError('segment_too_large');
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300) return reply.bytes;
    // A dead link answers 400, 403, 404 or 410, depending on the storage service (UNVERIFIED which): all mean "ask again".
    if (
      reply.status === 400 ||
      reply.status === 403 ||
      reply.status === 404 ||
      reply.status === 410
    ) {
      throw new AnalyticsError('segment_expired', undefined, reply.status);
    }
    throw new StoreError(
      'appstoreconnect',
      reply.status >= 500 ? 'server' : 'unexpected',
      `The storage host of the analytics report answered HTTP ${reply.status}.`,
      reply.status,
    );
  }

  async fetchSalesReport(input: { vendorNumber: string; date: string }): Promise<string | null> {
    if (!/^[0-9]{5,12}$/.test(input.vendorNumber))
      throw new AnalyticsError('vendor_number_invalid');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
      throw new StoreError('appstoreconnect', 'invalid_input', 'Not a valid date.');
    const query = [
      'filter[frequency]=DAILY',
      `filter[reportDate]=${input.date}`,
      'filter[reportSubType]=SUMMARY',
      'filter[reportType]=SALES',
      `filter[vendorNumber]=${input.vendorNumber}`,
      'filter[version]=1_0',
    ].join('&');
    const token = this.#tokens.token();
    this.#http.known.add(token);
    const reply = await this.#http.sendBytes('GET', `${this.#base}/v1/salesReports?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      accept: 'application/a-gzip, application/json',
      maxBytes: analyticsLimits.maxFileBytes,
    });
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.bytes.byteLength === 0) return null;
      return decodeTableText(await openFileBytes(reply.bytes));
    }
    // No report for the day (nothing sold, or not published yet) is a 404 in the reports Apple documents; UNVERIFIED for this endpoint.
    if (reply.status === 404) return null;
    if (reply.status === 401) this.#tokens.invalidate();
    if (reply.status === 403) throw new AnalyticsError('sales_forbidden', undefined, 403);
    throw this.#mapError(this.#toStoreReply(reply), 'reading the Sales and Trends report');
  }

  // ---- plumbing -----------------------------------------------------------------------------

  #toStoreReply(reply: BytesReply): StoreReply {
    let json: unknown;
    let malformed = false;
    const body = new TextDecoder().decode(reply.bytes).trim();
    if (body !== '') {
      try {
        json = JSON.parse(body);
      } catch {
        malformed = true;
      }
    }
    return { status: reply.status, headers: reply.headers, json, malformed };
  }

  #mapError(reply: StoreReply, what: string): StoreError {
    const error = appleError(reply, this.#http.now(), what);
    const redact = (value: string | undefined) =>
      value === undefined ? undefined : this.#http.redact(value);
    const details = (error.details ?? []).slice(0, MAX_ERROR_DETAILS).map((d) => {
      const fields = {
        code: redact(d.code),
        title: redact(d.title),
        detail: redact(d.detail),
        parameter: redact(d.parameter),
        pointer: redact(d.pointer),
      };
      return Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      ) as StoreErrorDetail;
    });
    return new StoreError(
      'appstoreconnect',
      error.kind,
      this.#http.redact(error.message),
      error.status,
      details,
    );
  }

  async #call(
    method: 'GET' | 'POST',
    url: string,
    what: string,
    json: unknown,
    codes: { forbidden?: 'analytics_role_required'; notFound?: 'analytics_request_missing' } = {},
  ): Promise<Json> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    const reply = await this.#http.send(method, url, {
      headers: { authorization: `Bearer ${token}` },
      ...(json !== undefined ? { json } : {}),
    });
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.malformed || !isRecord(reply.json)) {
        throw new StoreError(
          'appstoreconnect',
          'unexpected',
          `App Store Connect answered ${what} with a response that could not be read.`,
          reply.status,
        );
      }
      return reply.json;
    }
    if (reply.status === 401) this.#tokens.invalidate();
    if (reply.status === 403 && codes.forbidden) {
      // A 403 that says the key itself is bad (NOT_AUTHORIZED) is a credential problem, handled by `appleError`.
      const mapped = this.#mapError(reply, what);
      if (mapped.kind === 'forbidden') throw new AnalyticsError(codes.forbidden, undefined, 403);
      throw mapped;
    }
    if (reply.status === 404 && codes.notFound)
      throw new AnalyticsError(codes.notFound, undefined, 404);
    throw this.#mapError(reply, what);
  }

  /** Every `data` entry of a paged list. A paging link is followed only on the API host. */
  async #list(
    first: string,
    what: string,
    codes: { forbidden?: 'analytics_role_required'; notFound?: 'analytics_request_missing' },
    maxPages = this.#maxPages,
  ): Promise<Json[]> {
    const out: Json[] = [];
    let url: string | undefined = first;
    for (let page = 0; url && page < maxPages; page++) {
      const json = await this.#call('GET', url, what, undefined, codes);
      out.push(...records(json.data));
      const links = isRecord(json.links) ? json.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    return out;
  }

  #checkNext(next: string, what: string): string {
    let target: URL;
    try {
      target = new URL(next, this.#base);
    } catch {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `Apple sent a paging link that could not be read while ${what}.`,
      );
    }
    if (target.origin !== new URL(this.#base).origin) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `Apple sent a paging link to another host while ${what}. It was not followed.`,
      );
    }
    return target.toString();
  }
}
