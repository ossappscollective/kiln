import { PLATFORM_META } from '@mrm/core';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';
import { StoreError, type StoreErrorDetail } from '../errors.ts';
import { APPLE_DRAFT_VERSION_STATES } from '../store-draft-types.ts';
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
 * App Store Connect: CREATE the next App Store version (`POST /v1/appStoreVersions`), so a build can be attached to it. A STORE
 * WRITE, but a reversible one: the new version starts in `PREPARE_FOR_SUBMISSION`, and App Store Connect lets a person delete a
 * version in that state. Only ever called by the server's version service (docs/adr/0031-create-app-store-version.md), after a
 * rights check, the draft switch, a preview, a confirmation hash and a re-read of the store. It writes nothing else: no text, no
 * build, no submission, no release.
 *
 * UNVERIFIED against a real account. The body follows Apple's documented `AppStoreVersionCreateRequest`:
 * `{ data: { type: 'appStoreVersions', attributes: { platform, versionString, releaseType? }, relationships: { app: { data: { type: 'apps', id } } } } }`
 * and any 2xx counts as created (Apple documents 201). The version attributes read back are `versionString`, `platform`,
 * `appVersionState` / `appStoreState` and `releaseType`, as the other App Store connectors read them.
 *
 * The platform is the record's (`IOS`, `MAC_OS`). A write never retries (also not a 429): a lost answer or a 5xx is
 * `VersionOutcomeUnknownError` and the caller reads the versions back. No message carries the key, a JWT or an address.
 */

export type AppleVersionConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** The Apple platform of the version: `ios` (default) or `macos` (`MAC_OS`). */
  platform?: 'ios' | 'macos';
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  apiBase?: string;
  pageSize?: number;
  maxPages?: number;
};

/** The release types a version can be created with from here. `SCHEDULED` needs a date, which nothing here sets. */
export const CREATABLE_RELEASE_TYPES = ['MANUAL', 'AFTER_APPROVAL'] as const;
export type CreatableReleaseType = (typeof CREATABLE_RELEASE_TYPES)[number];

export type StoreVersionRow = {
  id: string;
  versionString: string | null;
  /** Apple's state name, upper case (`PREPARE_FOR_SUBMISSION`, `READY_FOR_SALE`, ...). Empty when Apple gave none. */
  state: string;
  /** The version can still be edited (the states the draft push writes to). */
  editable: boolean;
};

/** Every version of the platform as the store lists it. */
export type VersionListState = {
  store: 'appstoreconnect';
  platform: 'ios' | 'macos';
  versions: StoreVersionRow[];
};

export type VersionCreateRequest = {
  versionString: string;
  releaseType?: CreatableReleaseType | undefined;
};

export type VersionCreateInput = {
  request: VersionCreateRequest;
  /** Called with the versions read right before the write; false writes nothing and throws `VersionDriftError`. */
  guard: (current: VersionListState) => boolean;
};

export type VersionCreateResult = {
  /** What the store showed right before the write (the state the guard accepted). */
  before: VersionListState;
  /** The version Apple created, as it answered (null when the answer carried no id). */
  version: { id: string; versionString: string | null; state: string } | null;
};

/** The store is not what the person confirmed: nothing was written. */
export class VersionDriftError extends Error {
  readonly current: VersionListState;
  constructor(current: VersionListState) {
    super('The store changed since the preview was made.');
    this.name = 'VersionDriftError';
    this.current = current;
  }
}

/** The create was sent and the store did not answer in a way that tells whether it was applied. Never retried. */
export class VersionOutcomeUnknownError extends StoreError {
  constructor(message: string, status?: number) {
    super('appstoreconnect', 'network', message, status);
    this.name = 'VersionOutcomeUnknownError';
  }
}

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_ERROR_DETAILS = 5;

export class AppleVersionConnector {
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

  constructor(options: AppleVersionConnectorOptions) {
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
    options: Omit<AppleVersionConnectorOptions, 'credential'>,
  ): AppleVersionConnector {
    return new AppleVersionConnector({
      ...options,
      credential: parseAppStoreConnectSecret(secret),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  async readVersions(): Promise<VersionListState> {
    const what = 'listing the App Store versions';
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const versions: StoreVersionRow[] = [];
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        if (!id || text(a.platform) !== this.#apple) continue;
        const state = (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase();
        versions.push({
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
    return { store: 'appstoreconnect', platform: this.platform, versions };
  }

  // -------------------------------------------------------------------------------------------
  // Creating

  async createVersion(input: VersionCreateInput): Promise<VersionCreateResult> {
    const before = await this.readVersions();
    if (!input.guard(before)) throw new VersionDriftError(before);
    const attributes: Record<string, string> = {
      platform: this.#apple,
      versionString: input.request.versionString,
    };
    if (input.request.releaseType !== undefined) attributes.releaseType = input.request.releaseType;
    const reply = await this.#write(`creating the ${this.#label} version`, {
      data: {
        type: 'appStoreVersions',
        attributes,
        relationships: { app: { data: { type: 'apps', id: this.#appId } } },
      },
    });
    const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : {};
    const a = isRecord(data.attributes) ? data.attributes : {};
    const id = text(data.id);
    return {
      before,
      version: id
        ? {
            id,
            versionString: text(a.versionString) ?? null,
            state: (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase(),
          }
        : null,
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

  /** The one write. No retries. A lost answer or a 5xx is `VersionOutcomeUnknownError`; a 4xx is a refusal and nothing was created. */
  async #write(what: string, json: unknown): Promise<StoreReply> {
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send('POST', `${this.#base}/v1/appStoreVersions`, {
        headers: { authorization: `Bearer ${this.#bearer()}` },
        json,
      });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'network') {
        throw new VersionOutcomeUnknownError(
          `The connection to App Store Connect failed while ${what}, so it is not known whether Apple applied it. ${error.message}`,
          error.status,
        );
      }
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    if (reply.status >= 500) {
      throw new VersionOutcomeUnknownError(
        `App Store Connect answered HTTP ${reply.status} while ${what}, so it is not known whether Apple applied it.`,
        reply.status,
      );
    }
    throw this.#fail(reply, what);
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
