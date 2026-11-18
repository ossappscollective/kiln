import { StoreError, StoreRateLimitError } from './errors.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName } from './googleplay.ts';
import {
  checkReplyText,
  cleanBody,
  cleanName,
  cleanShort,
  cleanTitle,
  clampLimit,
  type ListReviewsOptions,
  type ListReviewsResult,
  PLAY_REPLY_LIMIT,
  parseRating,
  ReplyOutcomeUnknownError,
  type ReplyToReviewInput,
  type ReplyToReviewResult,
  type StoreReview,
  type StoreReviewReplyConnector,
} from './review-types.ts';
import {
  enc,
  isRecord,
  type Json,
  num,
  records,
  type StoreHttpOptions,
  StoreHttp,
  type StoreReply,
  text,
} from './store-http.ts';

/**
 * Google Play connector for user reviews. The reads are GETs. `replyToReview` (`reviews.reply`) is
 * a STORE WRITE: the text is published publicly on the store page. It is only ever called by the
 * server's reply service, after a draft, a rights check and an explicit confirmation
 * (docs/adr/0007-review-replies.md); it is never retried.
 *
 * It reuses the service-account token provider, the HTTP plumbing and the error mapping of
 * `googleplay.ts`. Unlike the other Play reads it needs no edit.
 *
 * Endpoints (checked against Google's pages on 2026-11-18, see docs/api/reviews.md):
 *
 * - `GET /androidpublisher/v3/applications/{packageName}/reviews` (`reviews.list`)
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/list
 *   Query: `maxResults`, `token`, `startIndex`, `translationLanguage`. Response: `reviews[]`,
 *   `tokenPagination.nextPageToken`, `pageInfo`.
 *   https://developers.google.com/android-publisher/reply-to-reviews says: only reviews created or
 *   modified within the last week are returned; 10 per page by default and at most 100 with
 *   `maxResults`; only reviews with a comment (a bare star rating is not available); only
 *   production versions of the app; quota of 200 GET requests per hour per app.
 * - `GET /androidpublisher/v3/applications/{packageName}/reviews/{reviewId}` (`reviews.get`)
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/get
 * - Review, Comment, UserComment, DeveloperComment, Timestamp:
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/reviews
 *
 * - `POST /androidpublisher/v3/applications/{packageName}/reviews/{reviewId}:reply` (`reviews.reply`)
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/reply
 *   Body `{ "replyText": string }`, answer `{ "result": { "replyText", "lastEdited": Timestamp } }`,
 *   scope `https://www.googleapis.com/auth/androidpublisher`. VERIFIED on
 *   https://developers.google.com/android-publisher/reply-to-reviews (2026-11-18): `replyText` is at
 *   most 350 characters (400 when too long or missing; 404 for an unknown review id); a review can
 *   be replied to as many times as wanted and a new reply replaces the old one; only the first
 *   reply to a created or modified review notifies the user; well formed HTML tags are stripped
 *   (plain text is recommended: this server refuses HTML-looking text so what is published is what
 *   was confirmed); replies are public; automated replies are discouraged; quota per app: 2000
 *   POST requests a day (and 200 GET an hour); the service account needs the Play Console permission
 *   "Reply to reviews" (the same guide). The reply window follows the review window: only reviews
 *   created or modified in the last week can be read back (`reviews.get` of an older review is
 *   a 404; whether `reviews.reply` still works on one is UNVERIFIED).
 *
 * Writes never retry, not even a 429, and use their own `StoreHttp` with no rate-limit waits. A
 * timeout, a cut connection or a 5xx is a `ReplyOutcomeUnknownError`.
 *
 * UNVERIFIED: the order of `reviews.list` (not documented, so nothing here relies on it), what
 * `tokenPagination` holds beyond `nextPageToken` (its page was not retrievable), how long a page
 * token stays valid (so no token is stored between syncs), and which Play Console permission a
 * read-only service account needs: Google's guide names "Reply to reviews" (see docs/credentials.md).
 *
 * The parsers are tolerant: a missing or unknown field never throws; an entry without an id or a
 * rating from 1 to 5 is counted in `skipped` and left out.
 */

export type PlayReviewsConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  /** The service account JSON key file (as stored), or its parsed fields. */
  serviceAccount: string | ServiceAccount;
  /** The package name (application id) of the app. */
  packageName: string;
  /** Defaults to https://androidpublisher.googleapis.com. */
  apiBase?: string;
  /** Reviews per request. Default 100, the documented maximum of `maxResults`. */
  pageSize?: number;
  /** Requests per read. Default 5, a fraction of the 200 an hour Google allows per app. */
  maxPages?: number;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';
const MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Google's review window: only reviews created or modified within this time are returned. */
export const PLAY_REVIEW_WINDOW_MS = 7 * DAY_MS;

/** A protobuf `Timestamp` as JSON: `{ seconds: "1731900000", nanos: 5000000 }` (seconds is a string). */
export function parsePlayTimestamp(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const seconds = typeof value.seconds === 'string' ? Number(value.seconds) : num(value.seconds);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const nanos = num(value.nanos);
  return Math.floor(seconds * 1000 + (nanos !== undefined && nanos >= 0 && nanos < 1e9 ? Math.floor(nanos / 1e6) : 0));
}

const codeText = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^[0-9]{1,12}$/.test(value)) return value;
  return undefined;
};

/** The newest comment of one kind (`userComment` or `developerComment`) of a review. */
function latest(comments: Json[], kind: 'userComment' | 'developerComment'): Json | undefined {
  let best: Json | undefined;
  let bestAt = -1;
  for (const entry of comments) {
    const comment = isRecord(entry[kind]) ? entry[kind] : undefined;
    if (!comment) continue;
    const at = parsePlayTimestamp(comment.lastModified) ?? 0;
    if (best === undefined || at >= bestAt) {
      best = comment;
      bestAt = at;
    }
  }
  return best;
}

/**
 * One Play `Review` as a `StoreReview`, or undefined when it has no id, no user comment, no
 * rating from 1 to 5 or no modification time. Exported for tests.
 *
 * `text` holds the title and the body in one string, separated by a tab, when the reviewer wrote
 * both (Google's page): the part before the first tab is the title.
 */
export function parsePlayReview(review: unknown): StoreReview | undefined {
  if (!isRecord(review)) return undefined;
  const id = text(review.reviewId);
  const comments = records(review.comments);
  const user = latest(comments, 'userComment');
  if (!id || !user) return undefined;
  const rating = parseRating(user.starRating);
  const modified = parsePlayTimestamp(user.lastModified);
  if (rating === undefined || modified === undefined) return undefined;

  // With `translationLanguage`, `text` is the translation and `originalText` the original.
  const original = typeof user.originalText === 'string' && user.originalText.trim() !== '' ? user.originalText : undefined;
  const shown = typeof user.text === 'string' ? user.text : '';
  const source = original ?? shown;
  const tab = source.indexOf('\t');
  const title = tab > 0 ? cleanTitle(source.slice(0, tab)) : undefined;
  const body = cleanBody(tab >= 0 ? source.slice(tab + 1) : source) ?? '';
  const translated = original !== undefined ? cleanBody(shown.includes('\t') ? shown.slice(shown.indexOf('\t') + 1) : shown) : undefined;

  const metadata = isRecord(user.deviceMetadata) ? user.deviceMetadata : {};
  const device = cleanShort(user.device) ?? cleanShort(metadata.productName);
  const authorName = cleanName(review.authorName);
  const language = cleanShort(user.reviewerLanguage);
  const appVersion = cleanShort(user.appVersionName);
  const buildNumber = codeText(user.appVersionCode);

  const developer = latest(comments, 'developerComment');
  const reply = developer ? cleanBody(developer.text) : undefined;
  const replyAt = developer ? parsePlayTimestamp(developer.lastModified) : undefined;
  return {
    store: 'googleplay',
    platform: 'android',
    storeReviewId: id,
    rating,
    ...(title !== undefined ? { title } : {}),
    body,
    ...(authorName !== undefined ? { authorName } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(appVersion !== undefined ? { appVersion } : {}),
    ...(buildNumber !== undefined ? { buildNumber } : {}),
    ...(device !== undefined ? { device } : {}),
    // Google sends no creation time: the last modification time is all there is.
    createdAt: modified,
    updatedAt: modified,
    ...(translated !== undefined ? { translatedBody: translated } : {}),
    ...(reply !== undefined ? { developerResponse: { body: reply, ...(replyAt !== undefined ? { at: replyAt } : {}) } } : {}),
  };
}

export function parsePlayReviews(page: unknown): { reviews: StoreReview[]; skipped: number; nextToken?: string } {
  const body = isRecord(page) ? page : {};
  const reviews: StoreReview[] = [];
  let skipped = 0;
  for (const item of Array.isArray(body.reviews) ? body.reviews : []) {
    const parsed = parsePlayReview(item);
    if (parsed) reviews.push(parsed);
    else skipped++;
  }
  const pagination = isRecord(body.tokenPagination) ? body.tokenPagination : {};
  const nextToken = text(pagination.nextPageToken);
  return { reviews, skipped, ...(nextToken ? { nextToken } : {}) };
}

/** What Google answers to `reviews.reply`: `{ result: { replyText, lastEdited } }`. Tolerant: all optional. */
export function parsePlayReplyResult(json: unknown): ReplyToReviewResult {
  const result = isRecord(json) && isRecord(json.result) ? json.result : {};
  const repliedAt = parsePlayTimestamp(result.lastEdited);
  return repliedAt !== undefined ? { repliedAt } : {};
}

export class PlayReviewsConnector implements StoreReviewReplyConnector {
  readonly store = 'googleplay' as const;
  readonly platform = 'android' as const;
  readonly packageName: string;
  readonly replyLimit = PLAY_REPLY_LIMIT;
  readonly #http: StoreHttp;
  /** For writes: the same settings, but a 429 is never waited out and retried. */
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: PlayReviewsConnectorOptions) {
    this.#account =
      typeof options.serviceAccount === 'string' ? parseServiceAccount(options.serviceAccount) : options.serviceAccount;
    if (!isPlayPackageName(options.packageName)) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        `Not a valid Android package name: ${JSON.stringify(options.packageName.slice(0, 80))}.`,
      );
    }
    this.packageName = options.packageName;
    this.#http = new StoreHttp({ ...options, store: 'googleplay' });
    this.#writeHttp = new StoreHttp({ ...options, store: 'googleplay', maxRateLimitRetries: 0 });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(this.#account, this.#http);
    const wanted = options.pageSize ?? MAX_PAGE_SIZE;
    this.#pageSize = Number.isFinite(wanted) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(wanted))) : MAX_PAGE_SIZE;
    this.#maxPages = Math.max(1, options.maxPages ?? 5);
  }

  /**
   * The reviews Google still serves (created or modified in the last week, with a comment). Pages
   * are followed by `tokenPagination.nextPageToken` until the end, the limit or the page cap.
   * `cursor` is not used: a page token's lifetime is not documented, so a read always starts at
   * the first page, and a read that was cut says so in `warnings` instead of offering a cursor.
   */
  async listReviews(options: ListReviewsOptions = {}): Promise<ListReviewsResult> {
    const limit = clampLimit(options.limit);
    const language = options.translationLanguage && /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(options.translationLanguage)
      ? `&translationLanguage=${enc(options.translationLanguage)}`
      : '';
    const reviews: StoreReview[] = [];
    const warnings: string[] = [];
    let skipped = 0;
    let token: string | undefined;
    let complete = false;
    for (let page = 1; ; page++) {
      const size = Math.min(this.#pageSize, limit - reviews.length);
      const url = `${this.#url('')}?maxResults=${size}${token ? `&token=${enc(token)}` : ''}${language}`;
      const reply = await this.#call(url, 'reading the reviews');
      const parsed = parsePlayReviews(reply.json);
      skipped += parsed.skipped;
      const since = options.since;
      reviews.push(...(since === undefined ? parsed.reviews : parsed.reviews.filter((r) => r.updatedAt >= since)));
      token = parsed.nextToken;
      if (token === undefined) {
        complete = true;
        break;
      }
      if (reviews.length >= limit) {
        warnings.push('Stopped at the limit of this read; reviews beyond it are read by the next sync if they are still in Google’s one week window.');
        break;
      }
      if (page >= this.#maxPages) {
        warnings.push(
          `Stopped after ${this.#maxPages} pages (Google allows 200 requests an hour per app). Reviews beyond them are read by the next sync if they are still in Google’s one week window.`,
        );
        break;
      }
    }
    if (skipped > 0) {
      warnings.push(`${skipped} review${skipped === 1 ? '' : 's'} without an id, a user comment, a rating or a time were left out.`);
    }
    return { reviews, complete, warnings, skipped };
  }

  /** One review by id (`reviews.get`), or undefined when Google has none (it is past the one week window). */
  async getReview(reviewId: string, options: { translationLanguage?: string } = {}): Promise<StoreReview | undefined> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(reviewId)) {
      throw new StoreError('googleplay', 'invalid_input', 'Not a valid review id.');
    }
    const language = options.translationLanguage && /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(options.translationLanguage)
      ? `?translationLanguage=${enc(options.translationLanguage)}`
      : '';
    try {
      const reply = await this.#call(`${this.#url(`/${enc(reviewId)}`)}${language}`, 'reading a review');
      return parsePlayReview(reply.json);
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return undefined;
      throw error;
    }
  }

  /**
   * Publishes `text` as the developer reply to a review, replacing an existing one (Google's
   * documented behaviour). A STORE WRITE, never retried (a 401 once, with a new token: Google
   * rejected the token before it looked at the request). `ReplyOutcomeUnknownError` when the
   * outcome is unknown; any other `StoreError` means Google refused and nothing was published.
   */
  async replyToReview(input: ReplyToReviewInput): Promise<ReplyToReviewResult> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.reviewId)) {
      throw new StoreError('googleplay', 'invalid_input', 'Not a valid review id.');
    }
    const checked = checkReplyText(input.text, this.replyLimit);
    if (!checked.ok) throw new StoreError('googleplay', 'invalid_input', checked.message);
    // The documented method is `reviews/{reviewId}:reply`: the id is escaped, the `:reply` is not.
    const url = `${this.#url(`/${enc(input.reviewId)}`)}:reply`;
    const what = 'answering a review';
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      let reply: StoreReply;
      try {
        reply = await this.#writeHttp.send('POST', url, {
          headers: { authorization: `Bearer ${token}` },
          json: { replyText: input.text },
        });
      } catch (error) {
        if (error instanceof StoreError && error.kind === 'network') {
          throw new ReplyOutcomeUnknownError(
            'googleplay',
            `The connection to Google Play failed while ${what}, so it is not known whether Google applied it. ${error.message}`,
            error.status,
          );
        }
        throw error;
      }
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return parsePlayReplyResult(reply.json);
      if (reply.status >= 500) {
        throw new ReplyOutcomeUnknownError(
          'googleplay',
          `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google applied it.`,
          reply.status,
        );
      }
      const error = googleError(reply, what, {
        packageName: this.packageName,
        ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
      });
      if (error instanceof StoreRateLimitError) throw error;
      if (reply.status === 403 && error.kind === 'forbidden') {
        throw new StoreError(
          'googleplay',
          'forbidden',
          'Google Play refused the reply (403). The service account needs the Play Console permission "Reply to reviews" for this app. See docs/credentials.md.',
          403,
        );
      }
      throw new StoreError('googleplay', error.kind, this.#http.redact(error.message), error.status);
    }
  }

  #url(suffix: string): string {
    return `${this.#base}/androidpublisher/v3/applications/${enc(this.packageName)}/reviews${suffix}`;
  }

  async #call(url: string, what: string): Promise<StoreReply> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      const reply = await this.#http.send('GET', url, { headers: { authorization: `Bearer ${token}` } });
      if (reply.status === 401 && attempt === 0) {
        // A cached token can be revoked early. Mint a new one once.
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) {
        if (reply.malformed) {
          throw new StoreError(
            'googleplay',
            'unexpected',
            `Google Play answered ${what} with a response that could not be read.`,
            reply.status,
          );
        }
        return reply;
      }
      const error = googleError(reply, what, {
        packageName: this.packageName,
        ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
      });
      if (error instanceof StoreRateLimitError) throw error;
      throw new StoreError('googleplay', error.kind, this.#http.redact(error.message), error.status);
    }
  }
}
