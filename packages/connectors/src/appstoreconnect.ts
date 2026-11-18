import type { Platform } from '@mrm/core';
import {
  AppStoreConnectTokenProvider,
  type AppStoreConnectKey,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { StoreError } from './errors.ts';
import { mapAppStoreState } from './mappings.ts';
import {
  enc,
  isRecord,
  type Json,
  num,
  records,
  type StoreHttpOptions,
  StoreHttp,
  type StoreReply,
  serverTime,
  text,
} from './store-http.ts';
import type { StoreApp, StoreBuild, StoreConnector, StoreVersion } from './types.ts';

/**
 * Read-only App Store Connect API connector. Nothing here writes: every request is a GET.
 *
 * Apple models the release as separate resources (versions, builds, localizations, review
 * submissions), so this connector lists them as separate calls and leaves joining to the caller.
 *
 * - Auth is an ES256 JWT, cached and renewed a minute before it expires (see apple-auth.ts).
 * - Lists follow `links.next` until it is absent (or `maxPages` is reached).
 * - A 429 is waited out for a bounded time, then thrown as `StoreRateLimitError`. Apple documents
 *   no `Retry-After`; its limit is a rolling hour per key (`X-Rate-Limit: user-hour-lim:..;
 *   user-hour-rem:..;`).
 * - No message carries the key or a JWT (see `redactSecrets`).
 */

export type AppStoreConnectConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  /** Items per page. Default 200, which is the documented maximum for most list endpoints. */
  pageSize?: number;
  /** A safety stop for runaway paging. Default 10 pages. Lists are newest first where sortable. */
  maxPages?: number;
};

/** What the cheapest authenticated read learned. Safe to show. */
export type AppStoreConnectAccess = {
  /** `meta.paging.total` of `GET /v1/apps`, when Apple sent it. */
  appCount?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const SKEW_TOLERANCE_SECONDS = 30;

const asPlatform = (apple: string | undefined): Platform | undefined =>
  apple === 'IOS' ? 'ios' : undefined;

/** Apple's first error object, as short safe text: `CODE: title`. */
function describeApple(json: unknown): { code?: string; summary: string } {
  const first = isRecord(json) ? records(json.errors)[0] : undefined;
  if (!first) return { summary: '' };
  const code = text(first.code);
  const title = text(first.title);
  const summary = [code, title].filter(Boolean).join(': ');
  return code === undefined ? { summary } : { code, summary };
}

/**
 * Turns an unsuccessful App Store Connect reply into a typed error whose message says what to do.
 * Exported for the verifier. `nowMs` is our clock, to compare with Apple's `Date` header.
 */
export function appleError(reply: StoreReply, nowMs: number, what: string): StoreError {
  const { code, summary } = describeApple(reply.json);
  const tail = summary ? ` (${summary.slice(0, 200)})` : '';
  const status = reply.status;
  if (status === 401) {
    const server = serverTime(reply.headers);
    const skew = server === undefined ? undefined : Math.round((nowMs - server) / 1000);
    if (skew !== undefined && Math.abs(skew) > SKEW_TOLERANCE_SECONDS) {
      return new StoreError(
        'appstoreconnect',
        'clock_skew',
        `Apple rejected the token (401) and this server's clock differs from Apple's by about ${Math.abs(
          skew,
        )} seconds (${skew > 0 ? 'ahead' : 'behind'}). Apple refuses tokens issued in the future or already expired. Synchronize the server clock (NTP) and try again.`,
        status,
      );
    }
    return new StoreError(
      'appstoreconnect',
      'auth',
      `Apple rejected the credentials (401)${tail}. The Key ID, the Issuer ID or the private key is wrong, or they do not belong together: the Key ID must be the one of this .p8 file (AuthKey_<KeyID>.p8), and the Issuer ID is the team's, shown above the keys list.`,
      status,
    );
  }
  if (status === 403) {
    if (code?.startsWith('NOT_AUTHORIZED')) {
      return new StoreError(
        'appstoreconnect',
        'auth',
        `Apple does not accept this key (403)${tail}. It may be revoked, or the token is malformed.`,
        status,
      );
    }
    return new StoreError(
      'appstoreconnect',
      'forbidden',
      `Apple refused ${what} (403)${tail}. The key was understood but is not allowed to do this: the key may have been revoked, or its role (for example Marketing or Sales) gives no access to apps. Use a key with the App Manager role or higher.`,
      status,
    );
  }
  if (status === 404) {
    return new StoreError(
      'appstoreconnect',
      'not_found',
      `Apple has no such resource for ${what} (404)${tail}. Check the app's Apple ID, and that this key's team owns the app.`,
      status,
    );
  }
  if (status >= 500) {
    return new StoreError(
      'appstoreconnect',
      'server',
      `App Store Connect failed while ${what} (HTTP ${status}). Try again in a few minutes.`,
      status,
    );
  }
  return new StoreError(
    'appstoreconnect',
    'unexpected',
    `App Store Connect answered ${what} with HTTP ${status}${tail}.`,
    status,
  );
}

export class AppStoreConnectConnector implements StoreConnector {
  readonly platform = 'ios' as const;
  readonly #http: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: AppStoreConnectConnectorOptions) {
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#pageSize = options.pageSize ?? 200;
    this.#maxPages = options.maxPages ?? 10;
    // Everything that must never appear in a message: the key and each of its lines.
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
    options: Omit<AppStoreConnectConnectorOptions, 'credential'> = {},
  ): AppStoreConnectConnector {
    return new AppStoreConnectConnector({
      ...options,
      credential: parseAppStoreConnectSecret(secret),
    });
  }

  /**
   * The cheapest harmless authenticated call: `GET /v1/apps?limit=1`. Throws a `StoreError`
   * that says what is wrong; returns what it learned otherwise.
   */
  async checkAccess(): Promise<AppStoreConnectAccess> {
    const reply = await this.#get('/v1/apps?limit=1', 'listing apps');
    const meta = isRecord(reply) ? reply.meta : undefined;
    const paging = isRecord(meta) ? meta.paging : undefined;
    const total = isRecord(paging) ? num(paging.total) : undefined;
    return total === undefined ? {} : { appCount: total };
  }

  async verifyCredentials(): Promise<void> {
    await this.checkAccess();
  }

  async listApps(): Promise<StoreApp[]> {
    const apps: StoreApp[] = [];
    for await (const item of this.#pages(`/v1/apps?limit=${this.#pageSize}`, 'listing apps')) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const bundleId = text(attributes.bundleId);
      if (!id || !bundleId) continue;
      // The App resource has no platform: an app can have iOS, macOS, tvOS and visionOS versions.
      // This connector is the iOS one, so every app is reported as iOS.
      apps.push({
        storeId: id,
        platform: 'ios',
        name: text(attributes.name) ?? bundleId,
        bundleId,
      });
    }
    return apps;
  }

  async listVersions(appStoreId: string): Promise<StoreVersion[]> {
    const versions: StoreVersion[] = [];
    const path = `/v1/apps/${enc(appStoreId)}/appStoreVersions?limit=${this.#pageSize}`;
    for await (const item of this.#pages(path, `listing the versions of app ${appStoreId}`)) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const versionString = text(attributes.versionString);
      const platform = asPlatform(text(attributes.platform));
      // Versions for macOS, tvOS and visionOS do not fit `Platform` and are left out.
      if (!id || !versionString || !platform) continue;
      // `appStoreState` is deprecated in favour of `appVersionState` (API 3.3 and later). Read the
      // new one first and fall back, so both old and new API behaviour work.
      const newer = text(attributes.appVersionState);
      const older = text(attributes.appStoreState);
      const rawState = newer ?? older ?? 'UNKNOWN';
      const lifecycleState = mapAppStoreState(newer) ?? mapAppStoreState(older);
      versions.push({
        storeId: id,
        appStoreId,
        platform,
        versionString,
        rawState,
        ...(lifecycleState ? { lifecycleState } : {}),
      });
    }
    return versions;
  }

  async listBuilds(appStoreId: string): Promise<StoreBuild[]> {
    const builds: StoreBuild[] = [];
    // `include=preReleaseVersion` brings the marketing version (the build's own `version` is the
    // build number). Newest first, so a `maxPages` cut drops the oldest builds.
    const query = `limit=${this.#pageSize}&sort=-uploadedDate&include=preReleaseVersion`;
    const path = `/v1/apps/${enc(appStoreId)}/builds?${query}`;
    const preRelease = new Map<string, { version?: string; platform?: string }>();
    const found: Json[] = [];
    const remember = (included: Json[]) => {
      for (const entry of included) {
        if (text(entry.type) !== 'preReleaseVersions') continue;
        const id = text(entry.id);
        const attributes = isRecord(entry.attributes) ? entry.attributes : {};
        const version = text(attributes.version);
        const platform = text(attributes.platform);
        if (!id) continue;
        preRelease.set(id, {
          ...(version !== undefined ? { version } : {}),
          ...(platform !== undefined ? { platform } : {}),
        });
      }
    };
    const what = `listing the builds of app ${appStoreId}`;
    for await (const item of this.#pages(path, what, remember)) found.push(item);
    for (const item of found) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const buildNumber = text(attributes.version);
      if (!id || !buildNumber) continue;
      const relationships = isRecord(item.relationships) ? item.relationships : {};
      const link = isRecord(relationships.preReleaseVersion) ? relationships.preReleaseVersion : {};
      const data = isRecord(link.data) ? link.data : undefined;
      const pre = data ? preRelease.get(text(data.id) ?? '') : undefined;
      // Builds of other platforms (macOS, tvOS, ...) are not iOS builds.
      if (pre?.platform !== undefined && pre.platform !== 'IOS') continue;
      const raw = text(attributes.processingState);
      const uploaded = Date.parse(text(attributes.uploadedDate) ?? '');
      builds.push({
        storeId: id,
        appStoreId,
        platform: 'ios',
        buildNumber,
        ...(pre?.version ? { versionString: pre.version } : {}),
        processing: processing(raw),
        ...(raw !== undefined ? { rawProcessingState: raw } : {}),
        ...(Number.isNaN(uploaded) ? {} : { uploadedAt: uploaded }),
        ...(typeof attributes.expired === 'boolean' ? { expired: attributes.expired } : {}),
      });
    }
    return builds;
  }

  // -------------------------------------------------------------------------------------------

  async #request(url: string, what: string): Promise<unknown> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    const reply = await this.#http.send('GET', url, {
      headers: { authorization: `Bearer ${token}` },
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
    const error = appleError(reply, this.#http.now(), what);
    // Apple's own error text is included in the message: make sure it cannot carry a secret.
    throw new StoreError(
      'appstoreconnect',
      error.kind,
      this.#http.redact(error.message),
      error.status,
    );
  }

  async #get(path: string, what: string): Promise<unknown> {
    return this.#request(`${this.#base}${path}`, what);
  }

  /**
   * Yields every item of a list, following `links.next`. The next link is only followed when it
   * stays on the API host: the token is never sent anywhere else.
   */
  async *#pages(
    path: string,
    what: string,
    onIncluded?: (included: Json[]) => void,
  ): AsyncGenerator<Json> {
    let url: string | undefined = `${this.#base}${path}`;
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#request(url, what)) as Json;
      onIncluded?.(records(body.included));
      for (const item of records(body.data)) yield item;
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
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

function processing(raw: string | undefined): StoreBuild['processing'] {
  switch (raw) {
    case 'VALID':
      return 'processed';
    case 'FAILED':
    case 'INVALID':
      return 'invalid';
    default:
      // PROCESSING, and any state added later: not usable yet, so not "processed".
      return 'processing';
  }
}
