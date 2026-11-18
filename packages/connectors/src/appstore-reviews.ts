import {
  AppStoreConnectTokenProvider,
  type AppStoreConnectKey,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';
import { StoreError, type StoreErrorDetail } from './errors.ts';
import {
  cleanBody,
  cleanName,
  cleanShort,
  cleanTitle,
  clampLimit,
  type ListReviewsOptions,
  type ListReviewsResult,
  parseRating,
  type StoreReview,
  type StoreReviewConnector,
} from './review-types.ts';
import {
  enc,
  isRecord,
  type Json,
  records,
  type StoreHttpOptions,
  StoreHttp,
  text,
} from './store-http.ts';

/**
 * Read-only App Store Connect connector for customer reviews. Every request is a GET; there is no
 * method that answers a review (`POST /v1/customerReviewResponses` is a store write and is not
 * called anywhere in this repository).
 *
 * It reuses the key handling, the HTTP plumbing (timeout, redaction, bounded wait on 429) and the
 * error mapping of `appstoreconnect.ts`, and only adds the review endpoints.
 *
 * Endpoints (checked against Apple's pages on 2026-11-18, see docs/api/reviews.md):
 *
 * - `GET /v1/apps/{id}/customerReviews`
 *   https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviews
 *   Query parameters used: `limit` (maximum 200), `sort` (`-createdDate`), `include` (`response`),
 *   `cursor` (from `links.next`). The page also lists `filter[rating]`, `filter[territory]`,
 *   `exists[publishedResponse]` and `fields[...]`; they are not needed here. It documents no filter
 *   on the date, so "since" is applied by sorting newest first and stopping.
 *   The page names no required role (see docs/credentials.md).
 * - Included `customerReviewResponses` (`attributes.responseBody`, `lastModifiedDate`, `state`):
 *   https://developer.apple.com/documentation/appstoreconnectapi/get-v1-customerreviews-_id_-response
 *   The field names are taken from the `fields[customerReviewResponses]` values of that page; the
 *   values of `state` are UNVERIFIED (kept verbatim).
 * - `GET /v1/apps/{id}/customerReviewSummarizations` (App Store Connect API 4.0 and later)
 *   https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviewsummarizations
 *   `filter[platform]` is required. Apple describes the result as AI-generated summaries per
 *   territory. UNVERIFIED: the attribute names (the page lists `text`, `createdDate`, `locale`,
 *   `platform`, `territory` as fields), and which key role may read it.
 *
 * Every parser is tolerant: a missing or unknown field never throws; an entry without an id or a
 * rating from 1 to 5 is counted in `skipped` and left out.
 */

export type AppStoreReviewsConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  /** Items per request. Default 200, the documented maximum of `limit`. */
  pageSize?: number;
  /** Requests per read. Default 10 (2000 reviews at most). */
  maxPages?: number;
  /**
   * Stop paging when Apple says this few requests are left this hour (`X-Rate-Limit`). Default 25,
   * so a review read never uses the whole budget the app sync and the listing read share.
   */
  rateLimitReserve?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_PAGE_SIZE = 200;
const MAX_ERROR_DETAILS = 5;

/** `user-hour-rem:500;` from `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:500;`. */
export function parseAppleRateRemaining(header: string | null): number | undefined {
  if (!header) return undefined;
  const found = /user-hour-rem:\s*(\d{1,9})/.exec(header);
  return found ? Number(found[1]) : undefined;
}

const toMs = (value: unknown): number | undefined => {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** One App Store developer response, as found in an `included` list. */
type AppleResponse = { body: string; at?: number; state?: string };

function responsesById(included: Json[]): Map<string, AppleResponse> {
  const found = new Map<string, AppleResponse>();
  for (const entry of included) {
    if (text(entry.type) !== 'customerReviewResponses') continue;
    const id = text(entry.id);
    const attributes = isRecord(entry.attributes) ? entry.attributes : {};
    const body = cleanBody(attributes.responseBody);
    if (!id || body === undefined) continue;
    const at = toMs(attributes.lastModifiedDate);
    const state = cleanShort(attributes.state);
    found.set(id, {
      body,
      ...(at !== undefined ? { at } : {}),
      ...(state !== undefined ? { state } : {}),
    });
  }
  return found;
}

/**
 * Turns one page of `GET /v1/apps/{id}/customerReviews?include=response` into reviews. Exported
 * for tests. Never throws: anything unreadable is counted in `skipped`.
 */
export function parseAppleReviews(page: unknown): { reviews: StoreReview[]; skipped: number } {
  const body = isRecord(page) ? page : {};
  const responses = responsesById(records(body.included));
  const reviews: StoreReview[] = [];
  let skipped = 0;
  for (const item of records(body.data)) {
    const id = text(item.id);
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const rating = parseRating(attributes.rating);
    const createdAt = toMs(attributes.createdDate);
    if (!id || rating === undefined || (text(item.type) !== undefined && text(item.type) !== 'customerReviews')) {
      skipped++;
      continue;
    }
    const relationships = isRecord(item.relationships) ? item.relationships : {};
    const link = isRecord(relationships.response) ? relationships.response : {};
    const data = isRecord(link.data) ? link.data : undefined;
    const response = data ? responses.get(text(data.id) ?? '') : undefined;
    const title = cleanTitle(attributes.title);
    const authorName = cleanName(attributes.reviewerNickname);
    const territory = cleanShort(attributes.territory);
    // A review without a date still has a place: "now" is not invented here, the caller decides.
    // It is skipped, because the inbox sorts and filters by date.
    if (createdAt === undefined) {
      skipped++;
      continue;
    }
    reviews.push({
      store: 'appstoreconnect',
      platform: 'ios',
      storeReviewId: id,
      rating,
      ...(title !== undefined ? { title } : {}),
      body: cleanBody(attributes.body) ?? '',
      ...(authorName !== undefined ? { authorName } : {}),
      ...(territory !== undefined ? { territory } : {}),
      createdAt,
      updatedAt: createdAt,
      ...(response ? { developerResponse: response } : {}),
    });
  }
  return { reviews, skipped };
}

/** One territory's summary of the reviews (App Store Connect `customerReviewSummarizations`). */
export type AppleReviewSummarization = {
  /** Three letter territory code, when sent. */
  territory?: string;
  platform?: string;
  locale?: string;
  /** Apple's generated summary text. Untrusted text: never render it as HTML. */
  text: string;
  createdAt?: number;
};

export function parseAppleSummarizations(page: unknown): AppleReviewSummarization[] {
  const body = isRecord(page) ? page : {};
  const found: AppleReviewSummarization[] = [];
  for (const item of records(body.data)) {
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const summary = cleanBody(attributes.text);
    if (summary === undefined) continue;
    const territory = cleanShort(attributes.territory);
    const platform = cleanShort(attributes.platform);
    const locale = cleanShort(attributes.locale);
    const createdAt = toMs(attributes.createdDate);
    found.push({
      text: summary,
      ...(territory !== undefined ? { territory } : {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
  }
  return found;
}

export class AppStoreReviewsConnector implements StoreReviewConnector {
  readonly store = 'appstoreconnect' as const;
  readonly platform = 'ios' as const;
  readonly #http: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #appId: string;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #reserve: number;

  constructor(options: AppStoreReviewsConnectorOptions) {
    if (!/^[0-9]{1,20}$/.test(options.appStoreId)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the app is missing or not a number. Sync the app first.',
      );
    }
    this.#appId = options.appStoreId;
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const wanted = options.pageSize ?? MAX_PAGE_SIZE;
    this.#pageSize = Number.isFinite(wanted) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(wanted))) : MAX_PAGE_SIZE;
    this.#maxPages = Math.max(1, options.maxPages ?? 10);
    this.#reserve = Math.max(0, options.rateLimitReserve ?? 25);
    const pem = options.credential.privateKey;
    this.#http.known.add(pem);
    this.#http.known.add(pem.trim());
    for (const line of pem.split(/\r?\n/)) {
      if (line && !line.startsWith('-----')) this.#http.known.add(line.trim());
    }
    this.#tokens = new AppStoreConnectTokenProvider(options.credential, this.#http.now);
  }

  /** Builds a connector from the stored secret (core `buildSecret` JSON for `app_store_connect`). */
  static fromSecret(
    secret: string,
    options: Omit<AppStoreReviewsConnectorOptions, 'credential'>,
  ): AppStoreReviewsConnector {
    return new AppStoreReviewsConnector({ ...options, credential: parseAppStoreConnectSecret(secret) });
  }

  /**
   * Reviews of the app, newest first, with their developer responses. Pages are followed until the
   * limit, the page cap, the rate-limit reserve, a page older than `since`, or the end. Reviews
   * the store has not changed are cheap to read again: the caller upserts by id.
   */
  async listReviews(options: ListReviewsOptions = {}): Promise<ListReviewsResult> {
    const what = `listing the reviews of app ${this.#appId}`;
    const limit = clampLimit(options.limit);
    const build = (cursor: string | undefined, size: number) =>
      `${this.#base}/v1/apps/${enc(this.#appId)}/customerReviews?limit=${size}&sort=-createdDate&include=response${
        cursor ? `&cursor=${enc(cursor)}` : ''
      }`;
    let url = build(options.cursor, Math.min(this.#pageSize, limit));
    const reviews: StoreReview[] = [];
    const warnings: string[] = [];
    let skipped = 0;
    let remaining: number | undefined;
    let nextCursor: string | undefined;
    let complete = false;
    for (let page = 1; ; page++) {
      const reply = await this.#get(url, what);
      remaining = reply.remaining ?? remaining;
      const parsed = parseAppleReviews(reply.json);
      skipped += parsed.skipped;
      // Newest first: a page with a review older than `since` is the last one that matters.
      const since = options.since;
      const kept = since === undefined ? parsed.reviews : parsed.reviews.filter((r) => r.createdAt >= since);
      const reachedOld = kept.length < parsed.reviews.length;
      reviews.push(...kept);
      const links = isRecord(reply.json.links) ? reply.json.links : {};
      const link = text(links.next);
      const cursor = link === undefined ? undefined : this.#cursorOf(this.#checkNext(link, what));
      if (link === undefined || reachedOld) {
        complete = true;
        break;
      }
      if (cursor === undefined) {
        warnings.push('Apple sent a paging link without a cursor, so the read could not continue.');
        break;
      }
      if (reviews.length >= limit) {
        nextCursor = cursor;
        break;
      }
      if (page >= this.#maxPages) {
        warnings.push(`Stopped after ${this.#maxPages} pages; the next sync continues.`);
        nextCursor = cursor;
        break;
      }
      if (remaining !== undefined && remaining <= this.#reserve) {
        warnings.push(
          `Stopped early: App Store Connect reports ${remaining} requests left this hour. The next sync continues.`,
        );
        nextCursor = cursor;
        break;
      }
      url = build(cursor, Math.min(this.#pageSize, limit - reviews.length));
    }
    if (skipped > 0) {
      warnings.push(`${skipped} review${skipped === 1 ? '' : 's'} without an id, a rating or a date were left out.`);
    }
    return {
      reviews,
      complete,
      warnings,
      skipped,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(remaining !== undefined ? { rateLimitRemaining: remaining } : {}),
    };
  }

  /**
   * Apple's generated summaries of the reviews, per territory (`customerReviewSummarizations`,
   * API 4.0 and later). Read only and optional: it is not part of the review sync.
   */
  async listSummarizations(
    options: { platform?: 'IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS'; territory?: string } = {},
  ): Promise<AppleReviewSummarization[]> {
    const what = `reading the review summaries of app ${this.#appId}`;
    const territory = options.territory && /^[A-Z]{3}$/.test(options.territory) ? `&filter[territory]=${options.territory}` : '';
    const url = `${this.#base}/v1/apps/${enc(this.#appId)}/customerReviewSummarizations?filter[platform]=${
      options.platform ?? 'IOS'
    }&limit=${MAX_PAGE_SIZE}${territory}`;
    return parseAppleSummarizations((await this.#get(url, what)).json);
  }

  async #get(url: string, what: string): Promise<{ json: Json; remaining?: number }> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    const reply = await this.#http.send('GET', url, { headers: { authorization: `Bearer ${token}` } });
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.malformed || !isRecord(reply.json)) {
        throw new StoreError(
          'appstoreconnect',
          'unexpected',
          `App Store Connect answered ${what} with a response that could not be read.`,
          reply.status,
        );
      }
      const remaining = parseAppleRateRemaining(reply.headers.get('x-rate-limit'));
      return { json: reply.json, ...(remaining !== undefined ? { remaining } : {}) };
    }
    if (reply.status === 401) this.#tokens.invalidate();
    const error = appleError(reply, this.#http.now(), what);
    const redact = (value: string | undefined) => (value === undefined ? undefined : this.#http.redact(value));
    const details = (error.details ?? []).slice(0, MAX_ERROR_DETAILS).map((d) => {
      const fields = {
        code: redact(d.code),
        title: redact(d.title),
        detail: redact(d.detail),
        parameter: redact(d.parameter),
        pointer: redact(d.pointer),
      };
      return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as StoreErrorDetail;
    });
    throw new StoreError('appstoreconnect', error.kind, this.#http.redact(error.message), error.status, details);
  }

  #cursorOf(url: string): string | undefined {
    try {
      return new URL(url).searchParams.get('cursor') ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** A paging link is followed only when it stays on the API host: the token is sent nowhere else. */
  #checkNext(next: string, what: string): string {
    let target: URL;
    try {
      target = new URL(next, this.#base);
    } catch {
      throw new StoreError('appstoreconnect', 'unexpected', `Apple sent a paging link that could not be read while ${what}.`);
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
