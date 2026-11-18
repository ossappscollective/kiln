import type { Platform } from '@mrm/core';
import { StoreError, type StoreName } from './errors.ts';

/**
 * What a store tells us about one customer review, normalized across the two stores. Review text
 * and display names are third-party personal data that the store itself shows publicly: only
 * what the store returns is kept here, nothing is looked up or joined from elsewhere.
 *
 * What each store provides (docs/api/reviews.md has the sources):
 *
 * - App Store Connect: rating, title, body, reviewer nickname, created date, territory (three
 *   letter code) and the developer response. No app version, no device, no edit time.
 * - Google Play: author name, star rating, text (title and body are one string), the time the
 *   comment was last modified (there is no creation time), reviewer language, device codename, app
 *   version code and name, and the developer comment. No territory.
 */
export type StoreReview = {
  store: StoreName;
  platform: Platform;
  /** The store's own review id. Unique per app. */
  storeReviewId: string;
  /** A whole number from 1 to 5. A review without a usable rating is skipped, never guessed. */
  rating: number;
  title?: string;
  /** Plain text. Untrusted: never render it as HTML. Empty when the reviewer wrote no text. */
  body: string;
  authorName?: string;
  /** App Store: the three letter territory code, as sent (`USA`). */
  territory?: string;
  /** Google Play: the reviewer's language code, from the device settings (may not be the review's language). */
  language?: string;
  /** Google Play: `appVersionName`. */
  appVersion?: string;
  /** Google Play: `appVersionCode`. */
  buildNumber?: string;
  /** Google Play: the device codename. */
  device?: string;
  /** Epoch milliseconds. Play has no creation time: this is the last modification time there. */
  createdAt: number;
  /** Epoch milliseconds. Equal to `createdAt` where the store sends no edit time (App Store). */
  updatedAt: number;
  /** Google Play with `translationLanguage`: the text translated by Google; `body` stays the original. */
  translatedBody?: string;
  developerResponse?: {
    body: string;
    /** App Store: the id of the `customerReviewResponses` resource (needed to delete it), when sent. */
    storeResponseId?: string;
    /** Epoch milliseconds, when the store said. */
    at?: number;
    /** App Store: the response's own state (`PUBLISHED`, `PENDING_PUBLISH`), verbatim. UNVERIFIED values. */
    state?: string;
  };
};

export type ListReviewsOptions = {
  /**
   * Epoch milliseconds. Reviews created (App Store) or modified (Google Play) before it are left
   * out, and App Store paging stops once a whole page is older. Pass a time somewhat before the
   * last sync to catch edits and new developer responses on recent reviews.
   */
  since?: number;
  /** Continue where an earlier read stopped (`nextCursor` of that read). App Store only. */
  cursor?: string;
  /** Most reviews this read returns. Default 200, at most 1000. */
  limit?: number;
  /** Google Play only: a language code; the store translates the text (`translatedBody`). */
  translationLanguage?: string;
};

export type ListReviewsResult = {
  /** Newest first on the App Store; in the store's own order on Google Play (not documented). */
  reviews: StoreReview[];
  /** Set when there is more to read than this call's limits allowed. App Store only. */
  nextCursor?: string;
  /** False when the read stopped before the end (a limit, the page cap or the rate-limit reserve). */
  complete: boolean;
  /** Things a person should know. Safe to show. */
  warnings: string[];
  /** Entries the store sent that were left out for lack of an id or a rating. */
  skipped: number;
  /** App Store: requests left this hour, from `X-Rate-Limit`, when the store said. */
  rateLimitRemaining?: number;
};

/**
 * The read side of a store connector for reviews. The write side (answering a review) is the
 * separate `StoreReviewReplyConnector` below, so a caller that only reads cannot reply by accident.
 */
export interface StoreReviewConnector {
  readonly store: StoreName;
  readonly platform: Platform;
  listReviews(options?: ListReviewsOptions): Promise<ListReviewsResult>;
}

export const DEFAULT_REVIEWS_LIMIT = 200;
export const MAX_REVIEWS_LIMIT = 1000;

const MAX_TITLE = 500;
const MAX_BODY = 20_000;
const MAX_NAME = 200;
const MAX_SHORT = 100;

/** Control characters other than tab and line breaks, which have no business in review text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A string from the store, cleaned of control characters and cut to `max`; undefined when empty or not text. */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL, '');
  if (cleaned.trim() === '') return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export const cleanTitle = (value: unknown) => cleanText(value, MAX_TITLE);
export const cleanBody = (value: unknown) => cleanText(value, MAX_BODY);
export const cleanName = (value: unknown) => cleanText(value, MAX_NAME);
export const cleanShort = (value: unknown) => cleanText(value, MAX_SHORT);

/** A rating that is a whole number from 1 to 5 (a number, or a string of one digit), else undefined. */
export function parseRating(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^[1-5]$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

/** The limit of a read, clamped to 1..MAX_REVIEWS_LIMIT. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_REVIEWS_LIMIT;
  return Math.min(MAX_REVIEWS_LIMIT, Math.max(1, Math.trunc(limit)));
}

// ---------------------------------------------------------------------------------------------
// Replying to a review (a STORE WRITE: public, in the store, under the developer's name)

/**
 * Longest reply this server sends to each store, in UTF-16 code units (`string.length`, a safe
 * over-count for emoji).
 *
 * - Google Play: 350. "replyText can be at most 350 characters"; longer replies are rejected with
 *   400 (https://developers.google.com/android-publisher/reply-to-reviews, verified 2026-11-18).
 * - App Store Connect: Apple's pages (the endpoint reference, the "Respond to reviews" help page)
 *   state NO limit. 5000 is a conservative limit of this server and is UNVERIFIED: Apple may accept
 *   more or fewer; a response over Apple's real limit comes back as a 4xx and is shown as is.
 */
export const APPLE_REPLY_LIMIT = 5000;
export const PLAY_REPLY_LIMIT = 350;

export type ReplyProblem = 'empty' | 'too_long' | 'control_characters' | 'markup';

/**
 * The text of a reply as it is stored, hashed and sent: line breaks are `\n`, leading and trailing
 * white space is gone. A reply is always normalized before it is hashed, so the hash the person
 * confirms is the hash of what goes to the store.
 */
export const normalizeReplyText = (value: string): string => value.replace(/\r\n?/g, '\n').trim();

// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const REPLY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
/** Something that looks like an HTML tag. Google strips well formed tags, so the text would change. */
const REPLY_MARKUP = /<\/?[A-Za-z!][^>]*>/;

/**
 * Whether `value` may be sent as a reply: plain text, not empty after trimming, at most `limit`
 * characters, and no control characters other than a line break (a tab, a carriage return, the
 * invisible direction overrides and the like are refused). HTML-looking tags are refused too,
 * because Google strips them (so what is published would differ from what was confirmed) and the
 * reply is plain text. Does not change the text: normalize it first (`normalizeReplyText`).
 */
export function checkReplyText(
  value: unknown,
  limit: number,
): { ok: true; text: string } | { ok: false; problem: ReplyProblem; message: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, problem: 'empty', message: 'The reply is empty.' };
  }
  if (REPLY_CONTROL.test(value)) {
    return {
      ok: false,
      problem: 'control_characters',
      message: 'The reply has a character that is not allowed in plain text (only line breaks are).',
    };
  }
  if (REPLY_MARKUP.test(value)) {
    return { ok: false, problem: 'markup', message: 'The reply looks like it contains HTML tags. Replies are plain text.' };
  }
  if (value.length > limit) {
    return { ok: false, problem: 'too_long', message: `The reply is ${value.length} characters; this store allows at most ${limit}.` };
  }
  return { ok: true, text: value };
}

export type ReplyToReviewInput = {
  /** The store's own review id (`StoreReview.storeReviewId`). */
  reviewId: string;
  /** Already normalized plain text; sent exactly as given. */
  text: string;
};

export type ReplyToReviewResult = {
  /** App Store: the id of the response resource, when the store said (needed to delete it). */
  storeResponseId?: string;
  /** App Store: `PENDING_PUBLISH` or `PUBLISHED`, verbatim. UNVERIFIED whether others occur. */
  state?: string;
  /** Epoch milliseconds, when the store said (Google: `lastEdited`; Apple: `lastModifiedDate`). */
  repliedAt?: number;
};

/**
 * A reply was sent and the store did not answer in a way that tells whether it was applied (a
 * timeout, a cut connection, a 5xx). The reply may or may not be published: nothing here retries
 * it, because a repeat could double post or overwrite a newer reply. The caller reads the review
 * back to find out.
 */
export class ReplyOutcomeUnknownError extends StoreError {
  constructor(store: StoreName, message: string, status?: number) {
    super(store, 'network', message, status);
    this.name = 'ReplyOutcomeUnknownError';
  }
}

/** The write side of a store connector for reviews. Each call can publish text in the store. */
export interface StoreReviewReplyConnector extends StoreReviewConnector {
  /** Longest reply, see `APPLE_REPLY_LIMIT` and `PLAY_REPLY_LIMIT`. */
  readonly replyLimit: number;
  /**
   * Publishes (or, if a reply exists, replaces) the reply. Never retried: a timeout or a 5xx is a
   * `ReplyOutcomeUnknownError`; a store refusal is a `StoreError` and means nothing was published.
   */
  replyToReview(input: ReplyToReviewInput): Promise<ReplyToReviewResult>;
  /** One review by the store's id, or undefined when the store has none (Google: past its window). */
  getReview(reviewId: string): Promise<StoreReview | undefined>;
}
