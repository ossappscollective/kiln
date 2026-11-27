import {
  emptyReviewDetail,
  maskedReviewSummary,
  mergeReviewDetail,
  REVIEW_TEXT_FIELDS,
  type ReviewDetail,
  type ReviewDetailFacts,
  type ReviewSourceCandidate,
  type ReviewSummary,
  reviewDetailHasContent,
  reviewFactsOf,
  reviewSourceOrder,
} from '@kiln/core';
import { StoreError } from '../errors.ts';
import {
  enc,
  isRecord,
  type Json,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from '../store-http.ts';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';

/**
 * App Store Connect: the App Review Information of a version (`appStoreReviewDetails`: contact first and last name, phone number and
 * email address, demo account, notes). It belongs to ONE version, so a version created through the API starts without the one of the
 * previous version unless it is carried over (docs/api/review-information.md). Apple's documentation lists the attributes App Review
 * needs (https://developer.apple.com/documentation/appstoreconnectapi/app-store-review-details).
 *
 * UNVERIFIED against a real account (no network when this was written); the shapes follow Apple's JSON:API form of the resource:
 * - `GET /v1/appStoreVersions/{id}/appStoreReviewDetail`: the version's detail (404 or `data: null`: it has none);
 * - `POST /v1/appStoreReviewDetails` with `data.attributes` (the attributes below) and `data.relationships.appStoreVersion`;
 * - `PATCH /v1/appStoreReviewDetails/{id}` with the attributes to change.
 *
 * What this class does with it: it READS a detail (server side only), WRITES only attributes that are blank on the version (never over
 * a filled one: `mergeReviewDetail`), and gives back counts and a masked summary. A contact name, phone number, email address, demo
 * account or note never leaves this file in a result, an error or a message: every value read is added to the redaction set of the
 * HTTP client, and `readFacts` returns presence only. Attachments of the detail are not read and not copied.
 *
 * Writes never retry (not even a 429). Carrying over is idempotent (blank attributes only), so doing it again after a lost answer is safe.
 */

export type AppleReviewDetailOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  apiBase?: string;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';

/** What happened to the review information of a version. Counts and a masked summary only. */
export type ReviewCarryResult = {
  /**
   * `created`: the version had no detail and one was written; `merged`: its blank attributes were filled; `already_complete`: it already
   * holds everything the source holds; `no_source`: no other version has review information; `failed`: a read or a write did not work
   * (`code` is the kind of the failure); `not_read`: nothing was looked at.
   */
  outcome: 'created' | 'merged' | 'already_complete' | 'no_source' | 'failed' | 'not_read';
  /** The version the information comes from (its id and version string), null when there is none. */
  from: { id: string; versionString: string | null } | null;
  fieldsCopied: number;
  /** The SOURCE as a screen may show it: initials and yes/no. */
  summary: ReviewSummary | null;
  /** `failed`: the kind of the failure (`store_rejected`, `network`, ...). */
  code?: string;
  httpStatus?: number;
};

export type ReviewSource = {
  from: { id: string; versionString: string | null };
  detail: ReviewDetail;
};

export class AppleReviewDetailConnector {
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;

  constructor(options: AppleReviewDetailOptions) {
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#writeHttp = new StoreHttp({
      ...options,
      store: 'appstoreconnect',
      maxRateLimitRetries: 0,
    });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const pem = options.credential.privateKey;
    for (const http of [this.#http, this.#writeHttp]) {
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
    options: Omit<AppleReviewDetailOptions, 'credential'>,
  ): AppleReviewDetailConnector {
    return new AppleReviewDetailConnector({
      ...options,
      credential: parseAppStoreConnectSecret(secret),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  /** The detail of a version with its id, or null when the version has none. Server side only: it holds personal data. */
  async readDetail(versionId: string): Promise<{ id: string; detail: ReviewDetail } | null> {
    const what = 'reading the App Review information of a version';
    const reply = await this.#http.send(
      'GET',
      `${this.#base}/v1/appStoreVersions/${enc(versionId)}/appStoreReviewDetail`,
      { headers: { authorization: `Bearer ${this.#bearer()}` } },
    );
    if (reply.status === 404) return null;
    if (reply.status < 200 || reply.status >= 300) throw this.#fail(reply, what);
    const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : undefined;
    const id = data ? text(data.id) : undefined;
    if (!data || !id) return null;
    const a = isRecord(data.attributes) ? data.attributes : {};
    const detail = emptyReviewDetail();
    for (const field of REVIEW_TEXT_FIELDS) {
      const value = text(a[field]);
      detail.text[field] = value === undefined ? null : value;
      this.#know(value);
    }
    detail.demoAccountRequired =
      typeof a.demoAccountRequired === 'boolean' ? a.demoAccountRequired : null;
    return { id, detail };
  }

  /**
   * What the submit checks need: which values the version's detail holds, never the values. Null when it could not be read (a failed
   * read is "not known", never a blocker and never an error).
   */
  async readFacts(versionId: string): Promise<ReviewDetailFacts | null> {
    try {
      const found = await this.readDetail(versionId);
      return reviewFactsOf(found?.detail ?? null);
    } catch {
      return null;
    }
  }

  /**
   * The first of these versions (best first, `reviewSourceOrder`) whose detail holds anything, with that detail. Null when none does.
   * A version whose detail cannot be read is skipped; if none could be read and one failed, that failure is thrown.
   */
  async findSource(
    versions: readonly ReviewSourceCandidate[],
    targetId: string,
  ): Promise<ReviewSource | null> {
    let failure: unknown;
    let anyRead = false;
    for (const candidate of reviewSourceOrder(versions, targetId)) {
      try {
        const found = await this.readDetail(candidate.id);
        anyRead = true;
        if (found && reviewDetailHasContent(found.detail)) {
          return {
            from: { id: candidate.id, versionString: candidate.versionString },
            detail: found.detail,
          };
        }
      } catch (error) {
        failure = error;
      }
    }
    if (!anyRead && failure !== undefined) throw failure;
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Carrying over

  /** What carrying over would do, read only: the source and what it holds, masked. Never writes. `targetId` null: the version does not exist yet. */
  async previewCarry(
    versions: readonly ReviewSourceCandidate[],
    targetId: string | null,
  ): Promise<ReviewCarryResult> {
    try {
      const source = await this.findSource(versions, targetId ?? '');
      if (!source) return { outcome: 'no_source', from: null, fieldsCopied: 0, summary: null };
      // No target yet (a version about to be created): it will have no detail, so everything the source holds is copied.
      const target = targetId === null ? null : await this.readDetail(targetId);
      const merge = mergeReviewDetail(target?.detail ?? null, source.detail);
      return {
        outcome: merge.fieldsCopied === 0 ? 'already_complete' : target ? 'merged' : 'created',
        from: source.from,
        fieldsCopied: merge.fieldsCopied,
        summary: maskedReviewSummary(source.detail),
      };
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * Copies the review information of the best previous version onto `targetId`: a new detail when the version has none, else only its
   * blank attributes. A filled value of the target is never changed. Never throws: a failure is a result, so a version that was
   * created stays created.
   */
  async carryOver(
    versions: readonly ReviewSourceCandidate[],
    targetId: string,
  ): Promise<ReviewCarryResult> {
    try {
      const source = await this.findSource(versions, targetId);
      if (!source) return { outcome: 'no_source', from: null, fieldsCopied: 0, summary: null };
      const target = await this.readDetail(targetId);
      const merge = mergeReviewDetail(target?.detail ?? null, source.detail);
      const summary = maskedReviewSummary(source.detail);
      if (merge.fieldsCopied === 0)
        return { outcome: 'already_complete', from: source.from, fieldsCopied: 0, summary };
      if (target) await this.#patch(target.id, merge.attributes);
      else await this.#create(targetId, merge.attributes);
      return {
        outcome: target ? 'merged' : 'created',
        from: source.from,
        fieldsCopied: merge.fieldsCopied,
        summary,
      };
    } catch (error) {
      return failed(error);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Writing

  async #create(versionId: string, attributes: Record<string, string | boolean>): Promise<void> {
    await this.#write('POST', '/v1/appStoreReviewDetails', 'writing the App Review information', {
      data: {
        type: 'appStoreReviewDetails',
        attributes,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
  }

  async #patch(id: string, attributes: Record<string, string | boolean>): Promise<void> {
    await this.#write(
      'PATCH',
      `/v1/appStoreReviewDetails/${enc(id)}`,
      'writing the App Review information',
      { data: { type: 'appStoreReviewDetails', id, attributes } },
    );
  }

  async #write(method: 'POST' | 'PATCH', path: string, what: string, body: Json): Promise<void> {
    for (const value of Object.values((body.data as Json).attributes as Json))
      if (typeof value === 'string') this.#know(value);
    const reply = await this.#writeHttp.send(method, `${this.#base}${path}`, {
      headers: { authorization: `Bearer ${this.#bearer()}` },
      json: body,
    });
    if (reply.status >= 200 && reply.status < 300) return;
    throw this.#fail(reply, what);
  }

  // -------------------------------------------------------------------------------------------

  /** Every value read or written is a secret of the redaction set, so no message can carry it (Apple's errors may quote a value). */
  #know(value: string | undefined): void {
    if (value === undefined || value.trim().length < 3) return;
    for (const http of [this.#http, this.#writeHttp]) {
      http.known.add(value);
      http.known.add(value.trim());
    }
  }

  #bearer(): string {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    return token;
  }

  #fail(reply: StoreReply, what: string): StoreError {
    if (reply.status === 401) this.#tokens.invalidate();
    const error = appleError(reply, this.#http.now(), what);
    // Apple's own sentences are left out on purpose: they may quote the value that was refused.
    return new StoreError(
      'appstoreconnect',
      error.kind,
      `App Store Connect refused ${what}.`,
      error.status,
    );
  }
}

function failed(error: unknown): ReviewCarryResult {
  const base = { outcome: 'failed' as const, from: null, fieldsCopied: 0, summary: null };
  if (error instanceof StoreError)
    return {
      ...base,
      code: error.kind,
      ...(error.status !== undefined ? { httpStatus: error.status } : {}),
    };
  return { ...base, code: 'unexpected' };
}
