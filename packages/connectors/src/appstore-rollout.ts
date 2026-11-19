import { PLATFORM_META } from '@mrm/core';
import {
  AppStoreConnectTokenProvider,
  type AppStoreConnectKey,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';
import { StoreError, type StoreErrorDetail } from './errors.ts';
import {
  type AppleRolloutChange,
  type AppleRolloutState,
  type AppleRolloutTarget,
  isMarketingVersion,
  planAppleRollout,
  RolloutDriftError,
  RolloutOutcomeUnknownError,
  type RolloutApplyInput,
  type RolloutApplyResult,
  type RolloutState,
  type RolloutTarget,
  type StoreRolloutConnector,
} from './rollout-types.ts';
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
 * App Store Connect: pause, resume or end the phased release of an App Store version. A STORE
 * WRITE: it changes who can get the update. Only ever called by the server's rollout service, after
 * a rights check, a preview, a confirmation hash and a re-read of the live state
 * (docs/adr/0008-store-rollout-writes.md). It is never retried.
 *
 * Apple decides the share per day (1, 2, 5, 10, 20, 50, 100 percent over seven days:
 * https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases,
 * verified 2026-11-18, with "up to 30 days" of pause in total). There is no way to set a share, so
 * the only changes are pause, resume and "release to all users now".
 *
 * Endpoints (Apple's reference pages are JavaScript-only: what could be read of them on 2026-11-18 is
 * stated, the rest is marked UNVERIFIED):
 *
 * - `GET /v1/apps/{id}/appStoreVersions` (the connector's usual list; `limit` only) to find the
 *   version by its marketing version string. VERIFIED, used by the read-only connector.
 * - `GET /v1/appStoreVersions/{id}/appStoreVersionPhasedRelease`: "Read the phased release status and
 *   configuration for a version with phased release enabled" (title and description VERIFIED on
 *   https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversions-_id_-appstoreversionphasedrelease).
 *   UNVERIFIED: what a version WITHOUT a phased release answers: this connector accepts a 404 and a
 *   200 with `data: null` as "none".
 * - `PATCH /v1/appStoreVersionPhasedReleases/{id}`: "Pause or resume a phased release, or
 *   immediately release an app" (VERIFIED, https://developer.apple.com/documentation/appstoreconnectapi/patch-v1-appstoreversionphasedreleases-_id_).
 *   UNVERIFIED (the page body did not render): the exact body. This connector sends the JSON:API
 *   document `{ data: { type: 'appStoreVersionPhasedReleases', id, attributes: { phasedReleaseState } } }`
 *   with `ACTIVE` (resume), `PAUSED` (pause) or `COMPLETE` (release to all), as the object page
 *   `AppStoreVersionPhasedReleaseUpdateRequest` (data element) and third-party descriptions say; the
 *   success status (200 expected) is UNVERIFIED: any 2xx counts.
 * - Attributes of the resource, UNVERIFIED (the attributes page lists none): `phasedReleaseState`,
 *   `startDate`, `totalPauseDuration`, `currentDayNumber`. `PhasedReleaseState` (a string type) is
 *   documented without values; `INACTIVE`, `ACTIVE`, `PAUSED`, `COMPLETE` are the values reported
 *   elsewhere. A state this connector does not know is kept verbatim and never changed.
 * - A change may be refused with HTTP 409 when the version's own state does not allow it (a
 *   developer forum report: "You cannot change the state of a phased release in the current version
 *   state"). It is reported as a refusal, nothing was changed.
 * - Which API key role may do it is UNVERIFIED (App Manager or Admin is assumed; see docs/credentials.md).
 *
 * The write never retries, not even a 429 (a second PATCH after a lost answer could act on a state
 * that has moved on): the connector keeps a second `StoreHttp` with no rate-limit waits. A timeout, a
 * cut connection or a 5xx is a `RolloutOutcomeUnknownError`; the caller reads the state back. The
 * state is a single field of a single resource, so a read-back settles it.
 *
 * No message carries the key or a JWT.
 */

export type AppleRolloutConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** The Apple platform of the version: `ios` (default) or `macos` (`MAC_OS`; phased release exists on macOS too, per Apple's help page). */
  platform?: 'ios' | 'macos';
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  /** Versions per request when looking the version up. Default 200, the documented maximum. */
  pageSize?: number;
  /** A safety stop for the lookup. Default 10 pages. */
  maxPages?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_ERROR_DETAILS = 5;

const stateOf = (value: string | undefined): string | null => (value === undefined ? null : value.trim().toUpperCase());
const dateMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** One `appStoreVersionPhasedReleases` resource (`data`) as fields; tolerant: a missing field is null. */
export function parseApplePhasedRelease(data: unknown): {
  id: string | null;
  state: string | null;
  currentDayNumber: number | null;
  startDate: number | null;
  totalPauseDays: number | null;
} {
  const one = isRecord(data) ? data : {};
  const a = isRecord(one.attributes) ? one.attributes : {};
  return {
    id: text(one.id) ?? null,
    state: stateOf(text(a.phasedReleaseState)),
    currentDayNumber: num(a.currentDayNumber) ?? null,
    startDate: dateMs(a.startDate),
    totalPauseDays: num(a.totalPauseDuration) ?? null,
  };
}

export class AppleRolloutConnector implements StoreRolloutConnector {
  readonly store = 'appstoreconnect' as const;
  readonly platform: 'ios' | 'macos';
  readonly #apple: string;
  readonly #label: string;
  readonly #http: StoreHttp;
  /** For writes: the same settings, but a 429 is never waited out and retried. */
  readonly #writeHttp: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #appId: string;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: AppleRolloutConnectorOptions) {
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
    this.#writeHttp = new StoreHttp({ ...options, store: 'appstoreconnect', maxRateLimitRetries: 0 });
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

  /** Builds a connector from the stored secret (core `buildSecret` JSON for `app_store_connect`). */
  static fromSecret(secret: string, options: Omit<AppleRolloutConnectorOptions, 'credential'>): AppleRolloutConnector {
    return new AppleRolloutConnector({ ...options, credential: parseAppStoreConnectSecret(secret) });
  }

  #target(target: RolloutTarget): AppleRolloutTarget {
    if (!('version' in target) || typeof target.version !== 'string' || !isMarketingVersion(target.version)) {
      throw new StoreError('appstoreconnect', 'invalid_input', 'Not a valid App Store version.');
    }
    return { version: target.version };
  }

  /** The version and its phased release as Apple has them now. Changes nothing. */
  async readState(target: RolloutTarget): Promise<RolloutState> {
    const wanted = this.#target(target);
    const version = await this.#findVersion(wanted.version);
    const phased = await this.#readPhased(version.id);
    return this.#state(wanted.version, version, phased);
  }

  /**
   * Re-reads the state, `guard`s it, and PATCHes the phased release once. `RolloutDriftError`
   * (nothing sent) when the guard refuses. See the file comment for the unknown outcome.
   */
  async applyChange(input: RolloutApplyInput): Promise<RolloutApplyResult> {
    const wanted = this.#target(input.target);
    const change = input.change as AppleRolloutChange;
    const state = change.action === 'pause' ? 'PAUSED' : change.action === 'resume' ? 'ACTIVE' : change.action === 'release_to_all' ? 'COMPLETE' : undefined;
    if (state === undefined) throw new StoreError('appstoreconnect', 'invalid_input', 'Not a rollout change App Store Connect knows.');
    const version = await this.#findVersion(wanted.version);
    const phased = await this.#readPhased(version.id);
    const before = this.#state(wanted.version, version, phased);
    if (!input.guard(before)) throw new RolloutDriftError(before);
    const plan = planAppleRollout(before, change);
    if (!plan.ok) throw new StoreError('appstoreconnect', 'invalid_input', plan.message);
    const phasedId = before.phasedReleaseId as string;
    const reply = await this.#write(
      'PATCH',
      `${this.#base}/v1/appStoreVersionPhasedReleases/${enc(phasedId)}`,
      `changing the phased release of version ${wanted.version}`,
      { data: { type: 'appStoreVersionPhasedReleases', id: phasedId, attributes: { phasedReleaseState: state } } },
    );
    // What Apple answered, when it said, else what was asked.
    const answered = isRecord(reply.json) ? parseApplePhasedRelease(reply.json.data) : undefined;
    const proposed = plan.proposed as AppleRolloutState;
    const after: AppleRolloutState = {
      ...proposed,
      ...(answered?.state ? { phasedReleaseState: answered.state } : {}),
      ...(answered?.currentDayNumber !== null && answered?.currentDayNumber !== undefined ? { currentDayNumber: answered.currentDayNumber } : {}),
      ...(answered?.totalPauseDays !== null && answered?.totalPauseDays !== undefined ? { totalPauseDays: answered.totalPauseDays } : {}),
    };
    return { before, after };
  }

  // -------------------------------------------------------------------------------------------

  #state(
    version: string,
    found: { id: string; state: string | null },
    phased: ReturnType<typeof parseApplePhasedRelease> | undefined,
  ): AppleRolloutState {
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version,
      storeVersionId: found.id,
      versionState: found.state,
      phasedReleaseId: phased?.id ?? null,
      phasedReleaseState: phased ? (phased.state ?? 'UNKNOWN') : null,
      currentDayNumber: phased?.currentDayNumber ?? null,
      startDate: phased?.startDate ?? null,
      totalPauseDays: phased?.totalPauseDays ?? null,
    };
  }

  /** The iOS version with this marketing version string. More than one is refused: never guess which. */
  async #findVersion(version: string): Promise<{ id: string; state: string | null }> {
    const what = `looking up version ${version}`;
    let url: string | undefined = `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const matches: { id: string; state: string | null }[] = [];
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        if (!id || text(a.versionString) !== version || text(a.platform) !== this.#apple) continue;
        matches.push({ id, state: text(a.appVersionState) ?? text(a.appStoreState) ?? null });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    if (matches.length === 0) {
      throw new StoreError('appstoreconnect', 'not_found', `App Store Connect has no ${this.#label} version ${version} for this app.`, 404);
    }
    if (matches.length > 1) {
      throw new StoreError('appstoreconnect', 'invalid_input', `App Store Connect lists more than one ${this.#label} version ${version}; this server will not guess which one to change.`);
    }
    return matches[0] as { id: string; state: string | null };
  }

  /** The phased release of a version, or undefined when it has none (a 404, or `data: null`). */
  async #readPhased(versionId: string): Promise<ReturnType<typeof parseApplePhasedRelease> | undefined> {
    try {
      const { json } = await this.#get(
        `${this.#base}/v1/appStoreVersions/${enc(versionId)}/appStoreVersionPhasedRelease`,
        'reading the phased release',
      );
      if (!isRecord(json.data)) return undefined;
      const parsed = parseApplePhasedRelease(json.data);
      return parsed.id === null ? undefined : parsed;
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return undefined;
      throw error;
    }
  }

  #fail(reply: StoreReply, what: string): StoreError {
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
    return new StoreError('appstoreconnect', error.kind, this.#http.redact(error.message), error.status, details);
  }

  async #get(url: string, what: string): Promise<{ json: Json }> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    const reply = await this.#http.send('GET', url, { headers: { authorization: `Bearer ${token}` } });
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.malformed || !isRecord(reply.json)) {
        throw new StoreError('appstoreconnect', 'unexpected', `App Store Connect answered ${what} with a response that could not be read.`, reply.status);
      }
      return { json: reply.json };
    }
    throw this.#fail(reply, what);
  }

  /** The one write. No retries. A lost answer or a 5xx is `RolloutOutcomeUnknownError`; a 4xx is a refusal. */
  async #write(method: 'PATCH', url: string, what: string, json: unknown): Promise<StoreReply> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, url, { headers: { authorization: `Bearer ${token}` }, json });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'network') {
        throw new RolloutOutcomeUnknownError(
          'appstoreconnect',
          `The connection to App Store Connect failed while ${what}, so it is not known whether Apple applied it. ${error.message}`,
          error.status,
        );
      }
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    if (reply.status >= 500) {
      throw new RolloutOutcomeUnknownError(
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
        'Apple refused the change (403). The key may not be allowed to manage releases (an App Manager or Admin key is assumed to be needed, UNVERIFIED). See docs/credentials.md.',
        403,
        error.details,
      );
    }
    if (reply.status === 405) {
      throw new StoreError('appstoreconnect', 'unsupported', 'Apple answered 405 (not allowed) to a phased release change. The key may not be allowed to do this (UNVERIFIED).', 405, error.details);
    }
    throw error;
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
      throw new StoreError('appstoreconnect', 'unexpected', `Apple sent a paging link to another host while ${what}. It was not followed.`);
    }
    return target.toString();
  }
}
