import { PLATFORM_META } from '@mrm/core';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';
import { StoreError, type StoreErrorDetail } from '../errors.ts';
import {
  APPLE_RELEASABLE_STATE,
  type ReleaseApplyInput,
  ReleaseDriftError,
  ReleaseOutcomeUnknownError,
  type ReleaseRequest,
  type ReleaseResult,
  type ReleaseState,
  type StoreReleaseConnector,
} from '../release-types.ts';
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

/**
 * App Store Connect: RELEASE an approved App Store version. A STORE WRITE that cannot be taken back (Apple: "Send this request
 * only when you're ready to publish your version. You can't cancel this request."). Only ever called by the server's release
 * service, after a rights check, a preview, a confirmation hash, a typed confirmation and a re-read of the store
 * (docs/adr/0014-release-management.md). It never edits a version, never submits one, never creates one.
 *
 * VERIFIED on Apple's pages (read 2026-11-19): the title "Manually release an app store approved version of your app" for
 * `POST /v1/appStoreVersionReleaseRequests` and its text: "When you submit your app for review, if it's approved and the status
 * changes to Pending Developer Release, then you can release a version." Everything else is UNVERIFIED (the page is nearly empty):
 *
 * - the body `{ data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id } } } } }`
 *   (the relationship name follows Apple's other resources) and the success status (any 2xx counts);
 * - that the API name of "Pending Developer Release" is `PENDING_DEVELOPER_RELEASE` (the read connector's lifecycle table uses it);
 * - the version attributes `appVersionState` / `appStoreState`, `releaseType` and `versionString`, the build attributes
 *   (`GET /v1/appStoreVersions/{id}/build`) and the phased release read (`GET /v1/appStoreVersions/{id}/appStoreVersionPhasedRelease`).
 *   A phased release that exists (state `INACTIVE`) starts when the version is released; one that does not exist means
 *   everybody gets the version at once (Apple's help page; not an API fact).
 *
 * The version is chosen among the platform's versions only (`MAC_OS` for macOS). The version that waits for release is the one that
 * is in `PENDING_DEVELOPER_RELEASE`; with more than one the caller must name the marketing version, else `ambiguous` is true and
 * nothing is released. A write never retries (also not a 429): a lost answer or a 5xx is `ReleaseOutcomeUnknownError` and the
 * caller reads the version's state back. No message carries the key, a JWT or an address.
 */

export type AppleReleaseConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** The Apple platform of the version: `ios` (default) or `macos` (`MAC_OS`). */
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

export class AppleReleaseConnector implements StoreReleaseConnector {
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

  constructor(options: AppleReleaseConnectorOptions) {
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
  }

  static fromSecret(
    secret: string,
    options: Omit<AppleReleaseConnectorOptions, 'credential'>,
  ): AppleReleaseConnector {
    return new AppleReleaseConnector({
      ...options,
      credential: parseAppStoreConnectSecret(secret),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  async readReleaseState(request: ReleaseRequest): Promise<ReleaseState> {
    return this.#state(request, await this.#versions());
  }

  async #versions(): Promise<VersionRow[]> {
    const what = 'listing the App Store versions';
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const out: VersionRow[] = [];
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
          releaseType: text(a.releaseType) ?? null,
        });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    return out;
  }

  async #state(request: ReleaseRequest, versions: VersionRow[]): Promise<ReleaseState> {
    const named =
      request.version !== undefined && request.version !== '' ? request.version : undefined;
    const pool =
      named === undefined
        ? versions.filter((v) => v.state === APPLE_RELEASABLE_STATE)
        : versions.filter((v) => v.versionString === named);
    const waiting = pool.filter((v) => v.state === APPLE_RELEASABLE_STATE);
    let chosen: VersionRow | null = null;
    let ambiguous = false;
    if (waiting.length === 1) chosen = waiting[0] as VersionRow;
    else if (waiting.length > 1) ambiguous = true;
    else if (named !== undefined && pool.length === 1) chosen = pool[0] as VersionRow;
    const build = chosen ? await this.#build(chosen.id) : null;
    const phasedRelease = chosen ? await this.#phased(chosen.id) : null;
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version: chosen,
      releasable: chosen !== null && chosen.state === APPLE_RELEASABLE_STATE,
      ambiguous,
      build,
      phasedRelease,
      versions: versions.map((v) => ({ versionString: v.versionString, state: v.state })),
    };
  }

  async #build(versionId: string): Promise<{
    id: string;
    buildNumber: string | null;
    processingState: string | null;
    expired: boolean | null;
  } | null> {
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
      buildNumber: text(a.version) ?? null,
      processingState: text(a.processingState) ?? null,
      expired: typeof a.expired === 'boolean' ? a.expired : null,
    };
  }

  async #phased(versionId: string): Promise<{ id: string; state: string | null } | null> {
    const reply = await this.#http.send(
      'GET',
      `${this.#base}/v1/appStoreVersions/${enc(versionId)}/appStoreVersionPhasedRelease`,
      { headers: { authorization: `Bearer ${this.#bearer()}` } },
    );
    if (reply.status === 404) return null;
    if (reply.status < 200 || reply.status >= 300)
      throw this.#fail(reply, 'reading the phased release');
    const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : undefined;
    const id = data ? text(data.id) : undefined;
    if (!data || !id) return null;
    const a = isRecord(data.attributes) ? data.attributes : {};
    return { id, state: text(a.phasedReleaseState) ?? null };
  }

  // -------------------------------------------------------------------------------------------
  // Releasing

  async release(input: ReleaseApplyInput): Promise<ReleaseResult> {
    const before = await this.#state(input.request, await this.#versions());
    if (!input.guard(before)) throw new ReleaseDriftError(before);
    if (before.store !== 'appstoreconnect' || before.version === null || !before.releasable) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `No ${this.#label} version is waiting for release (Pending Developer Release), so nothing was released.`,
      );
    }
    const reply = await this.#write(
      'POST',
      '/v1/appStoreVersionReleaseRequests',
      'releasing the version',
      {
        data: {
          type: 'appStoreVersionReleaseRequests',
          relationships: {
            appStoreVersion: { data: { type: 'appStoreVersions', id: before.version.id } },
          },
        },
      },
    );
    const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : {};
    return { before, releaseRequestId: text(data.id) ?? null, via: 'release_request' };
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

  /** The one write. No retries. A lost answer or a 5xx is `ReleaseOutcomeUnknownError`; a 4xx is a refusal and nothing was released. */
  async #write(method: string, path: string, what: string, json: unknown): Promise<StoreReply> {
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, `${this.#base}${path}`, {
        headers: { authorization: `Bearer ${this.#bearer()}` },
        json,
      });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'network') {
        throw new ReleaseOutcomeUnknownError(
          'appstoreconnect',
          `The connection to App Store Connect failed while ${what}, so it is not known whether Apple applied it. ${error.message}`,
          error.status,
        );
      }
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    if (reply.status >= 500) {
      throw new ReleaseOutcomeUnknownError(
        'appstoreconnect',
        `App Store Connect answered HTTP ${reply.status} while ${what}, so it is not known whether Apple applied it.`,
        reply.status,
      );
    }
    const error = this.#fail(reply, what);
    if (reply.status === 403 && error.kind === 'forbidden') {
      throw new StoreError(
        'appstoreconnect',
        'forbidden',
        'Apple refused to release (403). The key may not be allowed to release a version (an App Manager or Admin key is assumed to be needed, UNVERIFIED). See docs/credentials.md.',
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
