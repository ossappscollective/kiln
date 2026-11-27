import {
  classifyAppleScreenshot,
  missingContactFields,
  PLATFORM_META,
  type ReviewDetailFacts,
  type ReviewSourceCandidate,
} from '@kiln/core';
import { StoreError, type StoreErrorDetail } from '../errors.ts';
import {
  APPLE_DRAFT_VERSION_STATES,
  DraftOutcomeUnknownError,
  type DraftReadRequest,
} from '../store-draft-types.ts';
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
  APPLE_SUBMITTED_VERSION_STATES,
  type StoreSubmitConnector,
  type SubmitApplyInput,
  type SubmitAssetSet,
  SubmitDriftError,
  type SubmitLocale,
  SubmitOutcomeUnknownError,
  type SubmitResult,
  type SubmitState,
} from '../store-submit-types.ts';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { AppleDraftConnector } from './appstore-draft.ts';
import { AppleReviewDetailConnector } from './appstore-review-detail.ts';
import { appleError } from './appstoreconnect.ts';

/**
 * App Store Connect: submit the editable App Store version for REVIEW. A STORE WRITE that cannot be taken back from
 * here (an App Review submission can only be cancelled in App Store Connect). Only ever called by the server's
 * submit service, after a rights check, a preview, a confirmation hash, a typed confirmation and a re-read of the
 * store (docs/adr/0010-store-submit.md). It never releases a version, never changes the release type, never
 * creates a version and never writes a draft.
 *
 * Endpoints. What was verified on Apple's pages on 2026-11-18 is marked VERIFIED; Apple's pages for these resources
 * are nearly empty (titles, the relationship names and "platform is optional"), so the bodies are UNVERIFIED and follow
 * the JSON:API form of the other Apple resources:
 *
 * - `POST /v1/reviewSubmissions` ("Create a Review Submission", VERIFIED title; "platform is no longer required";
 *   its data wrapper holds "the resource type and app relationship", VERIFIED). Body UNVERIFIED:
 *   `{ data: { type: 'reviewSubmissions', relationships: { app: { data: { type: 'apps', id } } } } }`.
 * - `POST /v1/reviewSubmissionItems` ("Create a Review Submission Item", VERIFIED title; its relationships include
 *   `appStoreVersion` and `reviewSubmission`, VERIFIED). Body UNVERIFIED: `{ data: { type: 'reviewSubmissionItems',
 *   relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id } }, appStoreVersion: { data: { type: 'appStoreVersions', id } } } } }`.
 * - `PATCH /v1/reviewSubmissions/{id}` ("Modify a Review Submission", VERIFIED title). UNVERIFIED body:
 *   `{ data: { type: 'reviewSubmissions', id, attributes: { submitted: true } } }`: THIS is the request that hands the version to review.
 * - `GET /v1/appStoreVersions/{id}/build` ("Read the build information of an app store version", VERIFIED title); the
 *   attributes `version` (the build number), `processingState` and `expired` are UNVERIFIED.
 * - `GET /v1/apps/{id}/appStoreVersions` with `releaseType` (`MANUAL`, `AFTER_APPROVAL`, `SCHEDULED`: UNVERIFIED names).
 * - `GET /v1/apps/{id}/reviewSubmissions?filter[state]=READY_FOR_REVIEW` for unsubmitted submissions: UNVERIFIED
 *   filter and state names; a failed read is "unknown", never an error.
 *
 * Only the last request is irreversible. If the first or the second fails, nothing was submitted (an unsubmitted
 * review submission may be left in App Store Connect: the error says so and the next preview shows it). If the
 * last one is refused, nothing was submitted; if its answer is lost or it is a 5xx, the outcome is unknown
 * (`SubmitOutcomeUnknownError`) and the caller reads the version's state back: it is never sent again.
 *
 * Writes never retry (not even a 429). No message carries the key, a JWT or an address.
 */

export type AppleSubmitConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** The Apple platform of the version to submit: `ios` (default) or `macos` (`MAC_OS`). */
  platform?: 'ios' | 'macos';
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  apiBase?: string;
  pageSize?: number;
  maxPages?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_ERROR_DETAILS = 5;

type VersionRow = {
  id: string;
  versionString: string | null;
  state: string;
  releaseType: string | null;
};

/** The review information is missing something a check reports (so a source to copy from is worth looking for). */
const reviewMissing = (facts: ReviewDetailFacts): boolean =>
  missingContactFields(facts).length > 0 ||
  (facts.demoAccountRequired === true && (!facts.demoAccountName || !facts.demoAccountPassword));

export class AppleSubmitConnector implements StoreSubmitConnector {
  readonly store = 'appstoreconnect' as const;
  readonly platform: 'ios' | 'macos';
  readonly #apple: string;
  readonly #label: string;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #appId: string;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #draft: AppleDraftConnector;
  readonly #review: AppleReviewDetailConnector;

  constructor(options: AppleSubmitConnectorOptions) {
    if (!/^[0-9]{1,20}$/.test(options.appStoreId)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the app is missing or not a number. Sync the app first.',
      );
    }
    this.#appId = options.appStoreId;
    this.platform = options.platform ?? 'ios';
    this.#apple = PLATFORM_META[this.platform].applePlatform ?? 'IOS';
    this.#label = PLATFORM_META[this.platform].label;
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#writeHttp = new StoreHttp({
      ...options,
      store: 'appstoreconnect',
      maxRateLimitRetries: 0,
    });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const wanted = options.pageSize ?? 200;
    this.#pageSize = Number.isFinite(wanted) ? Math.min(200, Math.max(1, Math.trunc(wanted))) : 200;
    this.#maxPages = Math.max(1, options.maxPages ?? 10);
    const pem = options.credential.privateKey;
    for (const http of [this.#http, this.#writeHttp]) {
      http.known.add(pem);
      http.known.add(pem.trim());
      for (const line of pem.split(/\r?\n/)) {
        if (line && !line.startsWith('-----')) http.known.add(line.trim());
      }
    }
    this.#tokens = new AppStoreConnectTokenProvider(options.credential, this.#http.now);
    // Reads only: the draft connector reads the listing and the draft; nothing here calls its `applyDraft`.
    this.#draft = new AppleDraftConnector(options);
    // Reads the presence of the review information (never a value); nothing here writes it.
    this.#review = new AppleReviewDetailConnector(options);
  }

  static fromSecret(
    secret: string,
    options: Omit<AppleSubmitConnectorOptions, 'credential'>,
  ): AppleSubmitConnector {
    return new AppleSubmitConnector({ ...options, credential: parseAppStoreConnectSecret(secret) });
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  async readSubmitState(request: DraftReadRequest): Promise<SubmitState> {
    const version = await this.#version();
    return this.#stateOf(request, version);
  }

  async #stateOf(request: DraftReadRequest, version: VersionRow): Promise<SubmitState> {
    const alreadySubmitted = APPLE_SUBMITTED_VERSION_STATES.includes(version.state);
    const build = await this.#build(version.id);
    const listing = await this.#draft.readListing(version.id);
    const locales: SubmitLocale[] = listing.map((l) => {
      const assets: SubmitAssetSet[] = l.groups.map((g) => {
        const first = g.images.find((i) => i.width !== null && i.height !== null);
        const device = first
          ? classifyAppleScreenshot(first.width as number, first.height as number)
          : null;
        return { kind: 'screenshot' as const, device, target: g.group, images: g.images };
      });
      return { locale: l.locale, text: l.text, assets };
    });
    const draft = alreadySubmitted ? null : await this.#draft.readDraft(request);
    // App Review Information: presence only. Not read for a version already in review (nothing to fix), and a failed read is "not known".
    const reviewDetail = alreadySubmitted ? null : await this.#review.readFacts(version.id);
    const reviewSource =
      reviewDetail !== null && reviewMissing(reviewDetail) ? await this.#reviewSource(version.id) : null;
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version,
      build,
      alreadySubmitted,
      openReviewSubmissions: await this.#openSubmissions(),
      tracks: [],
      locales,
      draft,
      reviewDetail,
      reviewSource,
    };
  }

  /** The previous version whose review information could be copied (its id and version string), or null (none, or not found out). */
  async #reviewSource(targetId: string): Promise<{ id: string; versionString: string | null } | null> {
    try {
      const found = await this.#review.findSource(await this.#candidates(), targetId);
      return found ? found.from : null;
    } catch {
      return null;
    }
  }

  /** Every version of the platform, in the shape the carry-over reads. */
  async #candidates(): Promise<ReviewSourceCandidate[]> {
    const what = 'listing the App Store versions';
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const out: ReviewSourceCandidate[] = [];
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        if (!id || text(a.platform) !== this.#apple) continue;
        const state = (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase();
        out.push({
          id,
          versionString: text(a.versionString) ?? null,
          state,
          editable: APPLE_DRAFT_VERSION_STATES.includes(state),
        });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    return out;
  }

  /** The version that would go to review: the one editable version, else the one that is already in review (so a re-read after a submit can see it). */
  async #version(): Promise<VersionRow> {
    const what = 'looking for the App Store version to submit';
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const editable: VersionRow[] = [];
    const submitted: VersionRow[] = [];
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        const state = (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase();
        if (!id || text(a.platform) !== this.#apple) continue;
        const row = {
          id,
          versionString: text(a.versionString) ?? null,
          state,
          releaseType: text(a.releaseType) ?? null,
        };
        if (APPLE_DRAFT_VERSION_STATES.includes(state)) editable.push(row);
        else if (
          [
            'READY_FOR_REVIEW',
            'WAITING_FOR_REVIEW',
            'IN_REVIEW',
            'PENDING_APPLE_RELEASE',
            'PENDING_DEVELOPER_RELEASE',
            'PROCESSING_FOR_APP_STORE',
            'WAITING_FOR_EXPORT_COMPLIANCE',
          ].includes(state)
        )
          submitted.push(row);
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    if (editable.length > 1)
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `App Store Connect has more than one editable ${this.#label} version; this server will not guess which one to submit.`,
      );
    if (editable.length === 1) return editable[0] as VersionRow;
    if (submitted.length > 0) return submitted[0] as VersionRow;
    throw new StoreError(
      'appstoreconnect',
      'no_editable_version',
      `App Store Connect has no ${this.#label} version that can be submitted (one in "Prepare for Submission"). This server does not create versions.`,
      404,
    );
  }

  async #build(versionId: string): Promise<SubmitState['build']> {
    const reply = await this.#http.send(
      'GET',
      `${this.#base}/v1/appStoreVersions/${enc(versionId)}/build`,
      { headers: { authorization: `Bearer ${this.#bearer()}` } },
    );
    if (reply.status === 404) return null;
    if (reply.status < 200 || reply.status >= 300)
      throw this.#fail(reply, 'reading the build of the version');
    const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : undefined;
    const id = data ? text(data.id) : undefined;
    if (!data || !id) return null;
    const a = isRecord(data.attributes) ? data.attributes : {};
    return {
      id,
      version: text(a.version) ?? null,
      processingState: text(a.processingState) ?? null,
      expired: typeof a.expired === 'boolean' ? a.expired : null,
    };
  }

  async #openSubmissions(): Promise<number | null> {
    try {
      const body = (
        await this.#get(
          `${this.#base}/v1/apps/${enc(this.#appId)}/reviewSubmissions?filter[state]=READY_FOR_REVIEW&filter[platform]=${this.#apple}&limit=20`,
          'looking for unsubmitted review submissions',
        )
      ).json;
      return records(body.data).length;
    } catch {
      return null;
    }
  }

  /** The id of an unsubmitted review submission of this platform that holds no item (left by an earlier failed try), else null. */
  async #emptySubmission(): Promise<string | null> {
    try {
      const body = (
        await this.#get(
          `${this.#base}/v1/apps/${enc(this.#appId)}/reviewSubmissions?filter[state]=READY_FOR_REVIEW&filter[platform]=${this.#apple}&limit=20`,
          'looking for unsubmitted review submissions',
        )
      ).json;
      for (const r of records(body.data)) {
        const id = text(r.id);
        if (!id) continue;
        const items = (
          await this.#get(
            `${this.#base}/v1/reviewSubmissions/${enc(id)}/items?limit=1`,
            'looking at the items of a review submission',
          )
        ).json;
        if (records(items.data).length === 0) return id;
      }
    } catch {
      // Not found out: a new one is created, as before.
    }
    return null;
  }

  /** Cancels a review submission this call created and could not fill. Never throws: the original failure is what the person needs. */
  async #cancelEmpty(id: string): Promise<void> {
    try {
      await this.#write(
        'PATCH',
        `/v1/reviewSubmissions/${enc(id)}`,
        'cancelling the empty review submission',
        { data: { type: 'reviewSubmissions', id, attributes: { canceled: true } } },
      );
    } catch {
      // The submission stays as an empty draft in App Store Connect; the next try reuses it.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Submitting

  async submit(input: SubmitApplyInput): Promise<SubmitResult> {
    const version = await this.#version();
    const before = await this.#stateOf(input.request, version);
    if (!input.guard(before)) throw new SubmitDriftError(before);
    if (before.alreadySubmitted || before.version === null) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store version is already in review or past it, so it cannot be submitted again.',
      );
    }

    let submissionId = '';
    // A submission this call created (an empty one is left behind when adding the version fails, so it is cancelled then),
    // as opposed to an empty one found waiting, which is the person's and is only reused.
    let createdHere = false;
    try {
      const reusable = await this.#emptySubmission();
      if (reusable !== null) {
        submissionId = reusable;
      } else {
        const created = await this.#write(
          'POST',
          '/v1/reviewSubmissions',
          'creating the review submission',
          {
            data: {
              type: 'reviewSubmissions',
              relationships: { app: { data: { type: 'apps', id: this.#appId } } },
            },
          },
        );
        const id = idOf(created);
        if (!id)
          throw new StoreError(
            'appstoreconnect',
            'unexpected',
            'App Store Connect created a review submission but sent no id.',
            created.status,
          );
        submissionId = id;
        createdHere = true;
      }
      await this.#write(
        'POST',
        '/v1/reviewSubmissionItems',
        'adding the version to the review submission',
        {
          data: {
            type: 'reviewSubmissionItems',
            relationships: {
              reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
              appStoreVersion: { data: { type: 'appStoreVersions', id: before.version.id } },
            },
          },
        },
      );
    } catch (error) {
      // Nothing was handed to review yet; a lost answer here is not the irreversible case. A submission created by this call
      // and left empty would pile up in App Store Connect with every retry, so it is cancelled (best effort).
      if (createdHere && submissionId !== '') await this.#cancelEmpty(submissionId);
      if (error instanceof DraftOutcomeUnknownError || error instanceof SubmitOutcomeUnknownError) {
        throw new StoreError(
          'appstoreconnect',
          'server',
          `${error.message} Nothing was submitted for review. An unsubmitted review submission may have been left in App Store Connect: look at it there before trying again.`,
          error.status,
        );
      }
      if (error instanceof StoreError) {
        throw new StoreError(
          error.store,
          error.kind,
          `${error.message} Nothing was submitted for review.`,
          error.status,
          error.details,
        );
      }
      throw error;
    }

    let done: StoreReply;
    try {
      done = await this.#write(
        'PATCH',
        `/v1/reviewSubmissions/${enc(submissionId)}`,
        'submitting the version for review',
        {
          data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
        },
      );
    } catch (error) {
      if (error instanceof DraftOutcomeUnknownError)
        throw new SubmitOutcomeUnknownError('appstoreconnect', error.message, error.status);
      if (error instanceof StoreError) {
        throw new StoreError(
          error.store,
          error.kind,
          `${error.message} The version was not submitted; a review submission that is ready but not submitted may remain in App Store Connect.`,
          error.status,
          error.details,
        );
      }
      throw error;
    }
    const data = isRecord(done.json) && isRecord(done.json.data) ? done.json.data : {};
    const a = isRecord(data.attributes) ? data.attributes : {};
    return {
      before,
      submissionId,
      submissionState: text(a.state) ?? null,
      via: 'review_submission',
    };
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

  #bearer(): string {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    return token;
  }

  #fail(reply: StoreReply, what: string): StoreError {
    if (reply.status === 401) this.#tokens.invalidate();
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

  async #get(url: string, what: string): Promise<{ json: Json }> {
    const reply = await this.#http.send('GET', url, {
      headers: { authorization: `Bearer ${this.#bearer()}` },
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
      return { json: reply.json };
    }
    throw this.#fail(reply, what);
  }

  /** One write. No retries. A lost answer or a 5xx is `DraftOutcomeUnknownError` (the caller decides what it means); a 4xx is a refusal. */
  async #write(method: string, path: string, what: string, json?: unknown): Promise<StoreReply> {
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, `${this.#base}${path}`, {
        headers: { authorization: `Bearer ${this.#bearer()}` },
        ...(json !== undefined ? { json } : {}),
      });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'network') {
        throw new DraftOutcomeUnknownError(
          'appstoreconnect',
          `The connection to App Store Connect failed while ${what}, so it is not known whether Apple applied it. ${error.message}`,
          [],
          error.status,
        );
      }
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    if (reply.status >= 500) {
      throw new DraftOutcomeUnknownError(
        'appstoreconnect',
        `App Store Connect answered HTTP ${reply.status} while ${what}, so it is not known whether Apple applied it.`,
        [],
        reply.status,
      );
    }
    const error = this.#fail(reply, what);
    if (reply.status === 403 && error.kind === 'forbidden') {
      throw new StoreError(
        'appstoreconnect',
        'forbidden',
        'Apple refused to submit (403). The key may not be allowed to submit for review (an App Manager or Admin key is assumed to be needed, UNVERIFIED). See docs/credentials.md.',
        403,
        error.details,
      );
    }
    throw error;
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

function idOf(reply: StoreReply): string | undefined {
  const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : {};
  return text(data.id);
}
