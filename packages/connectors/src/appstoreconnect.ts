import {
  type AppStoreField,
  type ListingSections,
  type LocaleText,
  type MediaSet,
  PLATFORM_META,
  type Platform,
} from '@mrm/core';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { StoreError, type StoreErrorDetail } from './errors.ts';
import { mapAppStoreState } from './mappings.ts';
import {
  enc,
  isRecord,
  type Json,
  num,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  serverTime,
  text,
} from './store-http.ts';
import {
  APPLE_INFO_INCLUDES,
  appleAgeRating,
  appleCategories,
  appleMediaSets,
  sectionWarning,
} from './store-sections.ts';
import type {
  ListAppsOptions,
  ReadStoreListingOptions,
  StoreApp,
  StoreBuild,
  StoreConnector,
  StoreListing,
  StoreListingChannel,
  StoreVersion,
  TestFlightGroup,
  TestFlightLinksConnector,
} from './types.ts';

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
 * - Every request uses only query parameters that Apple's page for that endpoint lists (see
 *   docs/spikes/store-api-conventions.md). A 400 names the rejected parameter in the message and in
 *   `StoreError.details`, and `listBuilds` retries once with a minimal query when Apple rejects one.
 */

export type AppStoreConnectConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  /**
   * Items per page. Default 200, which is the documented maximum of `limit` on every list endpoint
   * used here (apps, appStoreVersions, builds, preReleaseVersions). Larger values are clamped.
   */
  pageSize?: number;
  /** A safety stop for runaway paging. Default 10 pages. Lists are newest first where sortable. */
  maxPages?: number;
  /**
   * Which Apple platform this connector reads: `ios` (default) or `macos` (Apple's `MAC_OS`). One App
   * Store Connect app can have both (universal purchase); versions, builds and the listing of the
   * other platform are left out, never mixed in.
   */
  platform?: 'ios' | 'macos';
};

/** What the cheapest authenticated read learned. Safe to show. */
export type AppStoreConnectAccess = {
  /** `meta.paging.total` of `GET /v1/apps`, when Apple sent it. */
  appCount?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const SKEW_TOLERANCE_SECONDS = 30;
/** The documented maximum of `limit` on the list endpoints this connector calls. */
const MAX_PAGE_SIZE = 200;
/** The documented maximum of `limit[builds]` (included builds per pre-release version). */
const MAX_INCLUDED_BUILDS = 50;
/** Groups whose builds are read for the public links (one request each). */
const MAX_LINK_GROUPS = 20;
/** `limit[appStoreVersions]` of the apps read that asks which platforms each app has (UNVERIFIED maximum; 50 is the builds one). */
const MAX_INCLUDED_VERSIONS = 50;
const MAX_ERROR_DETAILS = 5;
const MAX_ASSOCIATED_ERRORS = 8;
/**
 * Most locales whose screenshot and preview sets are read per channel (two requests each). Apple
 * allows about forty; the rest are left out and the media section says `truncated`.
 */
const MAX_MEDIA_LOCALES = 30;
/** The documented maximum of `limit[appScreenshots]` and `limit[appPreviews]` (Apple's pages). */
const MAX_MEDIA_PER_SET = 50;

// ---------------------------------------------------------------------------------------------
// Listing (localizations)

/**
 * App info localizations (`GET /v1/appInfos/{id}/appInfoLocalizations`): Apple attribute to the
 * `@mrm/core` field. `privacyChoicesUrl` has no field in the listing model: it is read into the
 * `privacy` section instead (see `choicesUrls`).
 */
const INFO_LOCALIZATION_FIELDS = {
  name: 'name',
  subtitle: 'subtitle',
  privacyPolicyUrl: 'privacy_url',
  privacyPolicyText: 'apple_tv_privacy_policy',
} as const satisfies Record<string, AppStoreField>;

/** Version localizations (`GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations`). */
const VERSION_LOCALIZATION_FIELDS = {
  description: 'description',
  keywords: 'keywords',
  marketingUrl: 'marketing_url',
  promotionalText: 'promotional_text',
  supportUrl: 'support_url',
  whatsNew: 'release_notes',
} as const satisfies Record<string, AppStoreField>;

/**
 * Which version is "live" and which is "editable". The names of the states are Apple's
 * (`AppVersionState`, `AppStoreVersionState`); that these are the ones in which the version is the
 * one on sale, or one a person can still change, is not on Apple's pages (they list the names
 * without descriptions). The editable set follows fastlane's `AppStoreVersion` model. A version in
 * review or waiting to be released is neither.
 */
const LIVE_VERSION_STATES = new Set(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE']);
const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
  'WAITING_FOR_REVIEW',
  'READY_FOR_REVIEW',
]);
/** `AppInfo.state` values (Apple's page lists them): the same split for the app info. */
const LIVE_INFO_STATES = new Set(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE']);
const EDITABLE_INFO_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'WAITING_FOR_REVIEW',
  'READY_FOR_REVIEW',
]);

type ListingResource = {
  id: string;
  rawState: string;
  versionString?: string;
  createdAt?: number;
  /** `AppStoreVersion.copyright` (a version attribute; Apple's AppStoreVersion Attributes page). */
  copyright?: string;
};

/** The privacy choices URL of each locale (`privacyChoicesUrl`, AppInfoLocalization Attributes page). */
function choicesUrls(items: Json[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const item of items) {
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const locale = text(attributes.locale);
    const url = text(attributes.privacyChoicesUrl);
    if (locale && url !== undefined && url !== '') found[locale] = url;
  }
  return found;
}

/** Locale to the id of its version localization, in locale order. */
function localizationIds(items: Json[]): [string, string][] {
  const found = new Map<string, string>();
  for (const item of items) {
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const locale = text(attributes.locale);
    const id = text(item.id);
    if (locale && id) found.set(locale, id);
  }
  return [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The newest by creation time (when sent), else the last one listed. */
function newest(items: ListingResource[]): ListingResource | undefined {
  return items.reduce<ListingResource | undefined>(
    (best, item) =>
      best === undefined || (item.createdAt ?? 0) >= (best.createdAt ?? 0) ? item : best,
    undefined,
  );
}

function localizedTexts<F extends string>(
  items: Json[],
  fields: Record<string, F>,
  into: Record<string, LocaleText<F>>,
): void {
  for (const item of items) {
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const locale = text(attributes.locale);
    if (!locale) continue;
    const target = (into[locale] ??= {});
    for (const [attribute, field] of Object.entries(fields)) {
      // Apple sends null for a value that is not set: the field is then absent.
      const value = text(attributes[attribute]);
      if (value !== undefined) target[field] = value;
    }
  }
}

/** The marketing version and platform of a pre-release version (Apple's `preReleaseVersions`). */
type PreRelease = { version?: string; platform?: string };

function preReleaseById(included: Json[]): Map<string, PreRelease> {
  const found = new Map<string, PreRelease>();
  for (const entry of included) {
    if (text(entry.type) !== 'preReleaseVersions') continue;
    const id = text(entry.id);
    const attributes = isRecord(entry.attributes) ? entry.attributes : {};
    const version = text(attributes.version);
    const platform = text(attributes.platform);
    if (!id) continue;
    found.set(id, {
      ...(version !== undefined ? { version } : {}),
      ...(platform !== undefined ? { platform } : {}),
    });
  }
  return found;
}

/** Apple's `platform` attribute of the platforms this tool manages. tvOS, visionOS and others are left out. */
const asPlatform = (apple: string | undefined): 'ios' | 'macos' | undefined =>
  apple === 'IOS' ? 'ios' : apple === 'MAC_OS' ? 'macos' : undefined;

const clip = (value: string | undefined, max: number): string | undefined =>
  value === undefined ? undefined : value.length > max ? `${value.slice(0, max)}…` : value;

/**
 * Apple's `errors[]` (an `ErrorResponse`), reduced to the fields that are safe to show: `code`,
 * `title`, `detail`, and `source.parameter` or `source.pointer`, which name what was rejected.
 */
export function appleErrorDetails(json: unknown): StoreErrorDetail[] {
  if (!isRecord(json)) return [];
  const found: StoreErrorDetail[] = [];
  for (const entry of records(json.errors).slice(0, MAX_ERROR_DETAILS)) {
    const source = isRecord(entry.source) ? entry.source : {};
    const code = clip(text(entry.code), 100);
    const title = clip(text(entry.title), 200);
    const detail = clip(text(entry.detail), 300);
    const parameter = clip(text(source.parameter), 100);
    const pointer = clip(text(source.pointer), 200);
    const one: StoreErrorDetail = {
      ...(code !== undefined ? { code } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(parameter !== undefined ? { parameter } : {}),
      ...(pointer !== undefined ? { pointer } : {}),
    };
    if (Object.keys(one).length > 0) found.push(one);
    // A 409 STATE_ERROR on a version says "check associated errors": the reasons are in `meta.associatedErrors`, keyed by the
    // resource path (`/v1/ageRatingDeclarations/<id>`). They are what the person has to fix, so they are kept (the kind of resource
    // and Apple's own sentence; the ids are dropped).
    const associated =
      isRecord(entry.meta) && isRecord(entry.meta.associatedErrors)
        ? entry.meta.associatedErrors
        : {};
    let more = 0;
    for (const [path, list] of Object.entries(associated)) {
      const kind =
        clip(
          path
            .split('/')
            .filter((x) => /^[A-Za-z]+$/.test(x) && x !== 'v1')
            .pop(),
          60,
        ) ?? 'resource';
      for (const e of records(list)) {
        if (more >= MAX_ASSOCIATED_ERRORS) break;
        const src = isRecord(e.source) ? e.source : {};
        const sentence = clip(text(e.detail) ?? text(e.title), 300);
        const aCode = clip(text(e.code), 100);
        const aPointer = clip(text(src.pointer), 200);
        if (sentence === undefined && aCode === undefined) continue;
        more++;
        found.push({
          ...(aCode !== undefined ? { code: aCode } : {}),
          detail: `${kind}: ${sentence ?? ''}`.trim(),
          ...(aPointer !== undefined ? { pointer: aPointer } : {}),
        });
      }
    }
  }
  return found;
}

/** Apple's first error object, as short safe text: `CODE: title`. */
function describeApple(details: StoreErrorDetail[]): { code?: string; summary: string } {
  const first = details[0];
  if (!first) return { summary: '' };
  const summary = [first.code, first.title].filter(Boolean).join(': ');
  return first.code === undefined ? { summary } : { code: first.code, summary };
}

/**
 * Every error object with what it objected to: `CODE: title - detail (parameter: sort)`. Used for
 * the answers that are not credential problems, where naming the parameter is the whole point.
 */
function describeAppleFully(details: StoreErrorDetail[]): string {
  return details
    .map((d) => {
      const head = [d.code, d.title].filter(Boolean).join(': ');
      const named = [
        d.parameter !== undefined ? `parameter: ${d.parameter}` : '',
        d.pointer !== undefined ? `pointer: ${d.pointer}` : '',
      ].filter(Boolean);
      return [
        head,
        d.detail ? ` - ${d.detail}` : '',
        named.length > 0 ? ` (${named.join(', ')})` : '',
      ]
        .join('')
        .trim();
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * What the person can do about the reasons Apple lists, when we know: the age rating questionnaire (Apple adds questions, and a
 * version cannot be reviewed until every one is answered) lives in App Information, not in the version.
 */
export function appleFixHint(details: StoreErrorDetail[]): string {
  const text = details.map((d) => `${d.detail ?? ''} ${d.pointer ?? ''}`).join(' ');
  return /ageRatingDeclarations/i.test(text)
    ? ' To fix it: in App Store Connect open the app, App Information, Age Rating, answer every question (Apple adds new ones from time to time) and save, then try again.'
    : '';
}

/** True for a 400 whose body says a query parameter is wrong (`PARAMETER_ERROR.*`, or a named one). */
export function isAppleParameterError(error: unknown): boolean {
  return (
    error instanceof StoreError &&
    error.store === 'appstoreconnect' &&
    error.status === 400 &&
    (error.details ?? []).some(
      (d) => d.code?.startsWith('PARAMETER_ERROR') === true || d.parameter !== undefined,
    )
  );
}

/**
 * Turns an unsuccessful App Store Connect reply into a typed error whose message says what to do.
 * Exported for the verifier. `nowMs` is our clock, to compare with Apple's `Date` header.
 */
export function appleError(reply: StoreReply, nowMs: number, what: string): StoreError {
  const details = appleErrorDetails(reply.json);
  const { code, summary } = describeApple(details);
  const tail = summary ? ` (${summary.slice(0, 200)})` : '';
  const status = reply.status;
  const fully = describeAppleFully(details);
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
        details,
      );
    }
    return new StoreError(
      'appstoreconnect',
      'auth',
      `Apple rejected the credentials (401)${tail}. The Key ID, the Issuer ID or the private key is wrong, or they do not belong together: the Key ID must be the one of this .p8 file (AuthKey_<KeyID>.p8), and the Issuer ID is the team's, shown above the keys list.`,
      status,
      details,
    );
  }
  if (status === 403) {
    if (code?.startsWith('NOT_AUTHORIZED')) {
      return new StoreError(
        'appstoreconnect',
        'auth',
        `Apple does not accept this key (403)${tail}. It may be revoked, or the token is malformed.`,
        status,
        details,
      );
    }
    return new StoreError(
      'appstoreconnect',
      'forbidden',
      `Apple refused ${what} (403)${tail}. The key was understood but is not allowed to do this: the key may have been revoked, or its role (for example Marketing or Sales) gives no access to apps. Use a key with the App Manager role or higher.`,
      status,
      details,
    );
  }
  if (status === 404) {
    return new StoreError(
      'appstoreconnect',
      'not_found',
      `Apple has no such resource for ${what} (404)${tail}. Check the app's Apple ID, and that this key's team owns the app.`,
      status,
      details,
    );
  }
  if (status >= 500) {
    return new StoreError(
      'appstoreconnect',
      'server',
      `App Store Connect failed while ${what} (HTTP ${status}). Try again in a few minutes.`,
      status,
      details,
    );
  }
  return new StoreError(
    'appstoreconnect',
    'unexpected',
    `App Store Connect answered ${what} with HTTP ${status}${fully || summary ? ` (${(fully || summary).slice(0, 1500)})` : ''}.${appleFixHint(details)}`,
    status,
    details,
  );
}

export class AppStoreConnectConnector implements StoreConnector, TestFlightLinksConnector {
  readonly platform: 'ios' | 'macos';
  readonly #http: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: AppStoreConnectConnectorOptions) {
    this.platform = options.platform ?? 'ios';
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const wanted = options.pageSize ?? MAX_PAGE_SIZE;
    this.#pageSize = Number.isFinite(wanted)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(wanted)))
      : MAX_PAGE_SIZE;
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

  async listApps(options: ListAppsOptions = {}): Promise<StoreApp[]> {
    const apps: StoreApp[] = [];
    if (options.withPlatforms === true) {
      // UNVERIFIED: that `include=appStoreVersions` with sparse `fields[appStoreVersions]=platform` and
      // `limit[appStoreVersions]` is accepted on this endpoint (Apple's page for it, as fetched, did not list
      // the query parameters). A 400 that names a parameter repeats the read without it: platforms unknown.
      try {
        return await this.#listAppsWithPlatforms();
      } catch (error) {
        if (!isAppleParameterError(error)) throw error;
      }
    }
    for await (const item of this.#pages(`/v1/apps?limit=${this.#pageSize}`, 'listing apps')) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const bundleId = text(attributes.bundleId);
      if (!id || !bundleId) continue;
      // The App resource has no platform: an app can have iOS, macOS, tvOS and visionOS versions.
      // Without `withPlatforms` every app is reported as this connector's platform (iOS by default).
      apps.push({
        storeId: id,
        platform: this.platform,
        name: text(attributes.name) ?? bundleId,
        bundleId,
      });
    }
    return apps;
  }

  async #listAppsWithPlatforms(): Promise<StoreApp[]> {
    const apps: StoreApp[] = [];
    const versionPlatforms = new Map<string, 'ios' | 'macos' | undefined>();
    const path = `/v1/apps?limit=${this.#pageSize}&include=appStoreVersions&fields[appStoreVersions]=platform&limit[appStoreVersions]=${MAX_INCLUDED_VERSIONS}`;
    const items: Json[] = [];
    for await (const item of this.#pages(path, 'listing apps', (more) => {
      for (const entry of more) {
        if (text(entry.type) !== 'appStoreVersions') continue;
        const id = text(entry.id);
        const attributes = isRecord(entry.attributes) ? entry.attributes : {};
        if (id) versionPlatforms.set(id, asPlatform(text(attributes.platform)));
      }
    })) {
      items.push(item);
    }
    for (const item of items) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const bundleId = text(attributes.bundleId);
      if (!id || !bundleId) continue;
      const relationships = isRecord(item.relationships) ? item.relationships : {};
      const link = isRecord(relationships.appStoreVersions) ? relationships.appStoreVersions : {};
      const refs = Array.isArray(link.data) ? link.data.filter(isRecord) : undefined;
      const found = new Set<Platform>();
      for (const ref of refs ?? []) {
        const platform = versionPlatforms.get(text(ref.id) ?? '');
        if (platform) found.add(platform);
      }
      apps.push({
        storeId: id,
        platform: this.platform,
        name: text(attributes.name) ?? bundleId,
        bundleId,
        // Only when Apple sent the relationship data: an app with no versions yet has `[]` and is not "known".
        ...(refs !== undefined && found.size > 0
          ? { platforms: (['ios', 'macos'] as const).filter((p) => found.has(p)) }
          : {}),
      });
    }
    return apps;
  }

  /**
   * The Apple platforms (iOS, macOS) an app has at least one version for, from the version list that
   * `listVersions` already reads (documented attribute `platform`). Used to check that a macOS record
   * points at an app that has a macOS version.
   */
  async listPlatforms(appStoreId: string): Promise<Platform[]> {
    const found = new Set<Platform>();
    const path = `/v1/apps/${enc(appStoreId)}/appStoreVersions?limit=${this.#pageSize}`;
    for await (const item of this.#pages(path, `listing the platforms of app ${appStoreId}`)) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const platform = asPlatform(text(attributes.platform));
      if (platform) found.add(platform);
    }
    return (['ios', 'macos'] as const).filter((p) => found.has(p));
  }

  async listVersions(appStoreId: string): Promise<StoreVersion[]> {
    const versions: StoreVersion[] = [];
    const path = `/v1/apps/${enc(appStoreId)}/appStoreVersions?limit=${this.#pageSize}`;
    for await (const item of this.#pages(path, `listing the versions of app ${appStoreId}`)) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const versionString = text(attributes.versionString);
      const platform = asPlatform(text(attributes.platform));
      // Versions of the other platform (and tvOS, visionOS) are left out: this connector reads one.
      if (!id || !versionString || platform !== this.platform) continue;
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

  /**
   * Which build each version uses, as Apple links them: `GET /v1/apps/{id}/appStoreVersions?include=build` fills the
   * `build` relationship of each version. The link is the truth; the build's own pre-release version string is not,
   * because a version can be created under another name than the build's (build 170 of 3.02.0 attached to 3.1.1).
   * UNVERIFIED against the live API: an answer Apple rejects gives an empty map, never an error.
   */
  async listVersionBuilds(appStoreId: string): Promise<Map<string, string>> {
    const links = new Map<string, string>();
    try {
      const path = `/v1/apps/${enc(appStoreId)}/appStoreVersions?include=build&fields[appStoreVersions]=versionString&limit=${this.#pageSize}`;
      for await (const item of this.#pages(path, `reading the builds of the versions of app ${appStoreId}`)) {
        const id = text(item.id);
        const relationships = isRecord(item.relationships) ? item.relationships : {};
        const link = isRecord(relationships.build) ? relationships.build : {};
        const data = isRecord(link.data) ? link.data : undefined;
        const buildId = data ? text(data.id) : undefined;
        if (id && buildId) links.set(id, buildId);
      }
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
    }
    return links;
  }

  /**
   * The builds of an app, newest first, with the marketing version joined in.
   *
   * `GET /v1/apps/{id}/builds` cannot be used for this: Apple's page for it lists only `limit` and
   * `fields[builds]`, so `sort` and `include` are rejected with `400 PARAMETER_ERROR.ILLEGAL`. The
   * top-level `GET /v1/builds` lists `filter[app]`, `sort` (`-uploadedDate`), `include`
   * (`preReleaseVersion`) and `limit` (max 200), so one filtered request gives builds and versions.
   *
   * If Apple still answers a 400 that names a parameter, the read is repeated with the minimal
   * documented query (`limit` only, on the app-scoped endpoint) and the marketing versions are read
   * from `GET /v1/preReleaseVersions?filter[app]=<id>&include=builds`. The result has the same shape.
   */
  async listBuilds(appStoreId: string): Promise<StoreBuild[]> {
    const what = `listing the builds of app ${appStoreId}`;
    const id = enc(appStoreId);
    // Newest first, so a `maxPages` cut drops the oldest builds.
    const primary = `/v1/builds?filter[app]=${id}&include=preReleaseVersion&limit=${this.#pageSize}&sort=-uploadedDate`;
    let found: Json[];
    let preRelease: Map<string, PreRelease>;
    let byBuild = new Map<string, PreRelease>();
    try {
      const read = await this.#collect(primary, what);
      found = read.items;
      preRelease = preReleaseById(read.included);
    } catch (error) {
      if (!isAppleParameterError(error)) throw error;
      const read = await this.#collect(`/v1/apps/${id}/builds?limit=${this.#pageSize}`, what);
      found = read.items;
      preRelease = new Map();
      byBuild = await this.#preReleaseByBuild(appStoreId);
    }
    const builds: StoreBuild[] = [];
    for (const item of found) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const buildId = text(item.id);
      const buildNumber = text(attributes.version);
      if (!buildId || !buildNumber) continue;
      const relationships = isRecord(item.relationships) ? item.relationships : {};
      const link = isRecord(relationships.preReleaseVersion) ? relationships.preReleaseVersion : {};
      const data = isRecord(link.data) ? link.data : undefined;
      const pre = (data ? preRelease.get(text(data.id) ?? '') : undefined) ?? byBuild.get(buildId);
      // Builds of other platforms are not this platform's builds. A build whose platform is not known is
      // taken for iOS only (the behavior before macOS), never for macOS.
      if (
        pre?.platform !== undefined
          ? pre.platform !== PLATFORM_META[this.platform].applePlatform
          : this.platform !== 'ios'
      )
        continue;
      const raw = text(attributes.processingState);
      const uploaded = Date.parse(text(attributes.uploadedDate) ?? '');
      builds.push({
        storeId: buildId,
        appStoreId,
        platform: this.platform,
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

  /**
   * The external TestFlight beta groups of an app with their public links. READ ONLY: no group is created, enabled,
   * disabled or edited, and no tester is touched. Requests (all GET):
   * - `GET /v1/betaGroups?filter[app]={id}&filter[isInternalGroup]=false&fields[betaGroups]=...&limit=200`
   *   (documented on https://developer.apple.com/documentation/appstoreconnectapi/get-v1-betagroups; the value format of
   *   `filter[isInternalGroup]` is UNVERIFIED, so a parameter error falls back to the same list without it and the
   *   internal groups are dropped here by their `isInternalGroup` attribute);
   * - for each group that has a public link (at most MAX_LINK_GROUPS), `GET /v1/betaGroups/{id}/builds?fields[builds]=version&limit=200`
   *   (https://developer.apple.com/documentation/appstoreconnectapi/get-v1-betagroups-_id_-builds): the build numbers in it.
   * `GET /v1/builds/{id}/betaGroups` is NOT used: its page could not be read when this was written (UNVERIFIED).
   * Whether Apple returns `publicLink` while `publicLinkEnabled` is false is UNVERIFIED; both are passed on as they are.
   */
  async listTestFlightGroups(appStoreId: string): Promise<TestFlightGroup[]> {
    const what = `listing the TestFlight groups of app ${appStoreId}`;
    const id = enc(appStoreId);
    const fields =
      'fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLinkLimitEnabled,publicLinkLimit,publicLink';
    let found: Json[];
    try {
      found = (
        await this.#collect(
          `/v1/betaGroups?filter[app]=${id}&filter[isInternalGroup]=false&${fields}&limit=${this.#pageSize}`,
          what,
        )
      ).items;
    } catch (error) {
      if (!isAppleParameterError(error)) throw error;
      found = (
        await this.#collect(`/v1/apps/${id}/betaGroups?${fields}&limit=${this.#pageSize}`, what)
      ).items;
    }
    const groups: TestFlightGroup[] = [];
    for (const item of found) {
      const a = isRecord(item.attributes) ? item.attributes : {};
      const groupId = text(item.id);
      if (!groupId || a.isInternalGroup === true) continue;
      const link = text(a.publicLink) ?? null;
      const limit = a.publicLinkLimitEnabled === true ? num(a.publicLinkLimit) : undefined;
      groups.push({
        id: groupId,
        name: text(a.name) ?? '',
        publicLink: link,
        publicLinkEnabled: a.publicLinkEnabled === true,
        publicLinkLimit: limit ?? null,
        allBuilds: a.hasAccessToAllBuilds === true,
        buildNumbers: [],
      });
    }
    let read = 0;
    for (const group of groups) {
      if (group.publicLink === null && !group.publicLinkEnabled) continue;
      if (group.allBuilds || read++ >= MAX_LINK_GROUPS) continue;
      const { items } = await this.#collect(
        `/v1/betaGroups/${enc(group.id)}/builds?fields[builds]=version&limit=${this.#pageSize}`,
        `listing the builds of TestFlight group ${group.id}`,
      );
      group.buildNumbers = items.flatMap((b) => {
        const n = text(isRecord(b.attributes) ? b.attributes.version : undefined);
        return n ? [n] : [];
      });
    }
    return groups;
  }

  /**
   * The localized listing: the app info localizations (name, subtitle, privacy policy URL and text)
   * and the version localizations (description, keywords, promotional text, what's new, marketing
   * and support URL) of the app's live version and of its editable version, when it has them.
   *
   * Four kinds of request, all GET, each with only the parameters Apple documents for it:
   * `GET /v1/apps/{id}/appStoreVersions?limit`, `GET /v1/apps/{id}/appInfos?limit`,
   * `GET /v1/appInfos/{id}/appInfoLocalizations?limit` and
   * `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations?limit`.
   *
   * An editable version without an editable app info (Apple creates a second app info when a name
   * or subtitle is to be changed) reads its name and subtitle from the live app info, which is what
   * the store would show; a warning says so.
   *
   * Sections beyond the texts (`StoreListingChannel.sections`), all GET and read-only:
   * - always, out of the responses above: `details.copyright` (the version's `copyright`
   *   attribute, https://developer.apple.com/documentation/appstoreconnectapi/appstoreversion/attributes-data.dictionary)
   *   and `privacy.choicesUrls` (`privacyChoicesUrl`,
   *   https://developer.apple.com/documentation/appstoreconnectapi/appinfolocalization/attributes-data.dictionary);
   * - with `options.extended`: `categories` and `ageRating` from the same app info request with
   *   `include=` the six category relationships and `ageRatingDeclaration` (documented values of
   *   https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-appinfos; the
   *   declaration's attributes are on
   *   https://developer.apple.com/documentation/appstoreconnectapi/ageratingdeclaration/attributes-data.dictionary),
   *   and `media`: per version localization `GET /v1/appStoreVersionLocalizations/{id}/appScreenshotSets`
   *   (https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversionlocalizations-_id_-appscreenshotsets;
   *   Apple marks it deprecated since API 4.5 in favour of the asset library placements, so it can
   *   disappear: then the failure is a warning and the section stays "not read") and
   *   `GET .../appPreviewSets`
   *   (https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversionlocalizations-_id_-apppreviewsets),
   *   each with `include` of the assets, `limit[...]` 50 and sparse `fields[...]` (file name and
   *   delivery state only: no image asset, template URL or upload operation is requested).
   *
   * Never read, on purpose: the app store review detail (`appStoreReviewDetails`: contact name,
   * email and phone number, demo-account user name and password): it is personal data and secrets,
   * so the resource is not requested at all.
   *
   * A failure of an optional section is a warning and the section is left out ("not read"); only a
   * rate limit, a bad credential, a clock problem or the network stop the read.
   */
  async readListing(
    appStoreId: string,
    options: ReadStoreListingOptions = {},
  ): Promise<StoreListing> {
    const what = `reading the listing of app ${appStoreId}`;
    const id = enc(appStoreId);
    const warnings: string[] = [];
    const extended = options.extended === true;

    const versions: ListingResource[] = [];
    for await (const item of this.#pages(
      `/v1/apps/${id}/appStoreVersions?limit=${this.#pageSize}`,
      what,
    )) {
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      const versionId = text(item.id);
      // Same rule as `listVersions`: the new state field first, the deprecated one as fallback.
      const rawState = text(attributes.appVersionState) ?? text(attributes.appStoreState);
      if (
        !versionId ||
        rawState === undefined ||
        asPlatform(text(attributes.platform)) !== this.platform
      )
        continue;
      const versionString = text(attributes.versionString);
      const created = Date.parse(text(attributes.createdDate) ?? '');
      const copyright = text(attributes.copyright);
      versions.push({
        id: versionId,
        rawState: rawState.toUpperCase(),
        ...(versionString !== undefined ? { versionString } : {}),
        ...(Number.isNaN(created) ? {} : { createdAt: created }),
        ...(copyright !== undefined ? { copyright } : {}),
      });
    }
    const infos: ListingResource[] = [];
    const infoItems = new Map<string, Json>();
    let infoIncluded: Json[] = [];
    let withRelations = extended;
    const readInfos = async (path: string) => {
      const collected: ListingResource[] = [];
      const found = new Map<string, Json>();
      const read = await this.#collect(path, what);
      for (const item of read.items) {
        const attributes = isRecord(item.attributes) ? item.attributes : {};
        const infoId = text(item.id);
        // `appStoreState` of an app info is deprecated in favour of `state` (Apple's AppInfo page).
        const rawState = text(attributes.state) ?? text(attributes.appStoreState);
        if (!infoId || rawState === undefined) continue;
        collected.push({ id: infoId, rawState: rawState.toUpperCase() });
        found.set(infoId, item);
      }
      return { collected, found, included: read.included };
    };
    {
      const base = `/v1/apps/${id}/appInfos?limit=${this.#pageSize}`;
      let read: Awaited<ReturnType<typeof readInfos>>;
      if (extended) {
        try {
          read = await readInfos(`${base}&include=${APPLE_INFO_INCLUDES}`);
        } catch (error) {
          // Apple rejects an `include` value it does not know with a 400 that names the parameter:
          // read the plain list (the texts must not depend on the optional sections).
          if (!isAppleParameterError(error)) throw error;
          warnings.push(
            'Categories and the age rating were not read: Apple rejected the include parameter.',
          );
          withRelations = false;
          read = await readInfos(base);
        }
      } else {
        read = await readInfos(base);
      }
      infos.push(...read.collected);
      for (const [key, value] of read.found) infoItems.set(key, value);
      infoIncluded = read.included;
    }

    const liveVersion = newest(versions.filter((v) => LIVE_VERSION_STATES.has(v.rawState)));
    const editableVersion = newest(versions.filter((v) => EDITABLE_VERSION_STATES.has(v.rawState)));
    const liveInfo = newest(infos.filter((i) => LIVE_INFO_STATES.has(i.rawState)));
    const editableInfo = newest(infos.filter((i) => EDITABLE_INFO_STATES.has(i.rawState)));
    if (!liveVersion && !editableVersion) {
      warnings.push(
        'No App Store version is live or editable, so no version texts (description, keywords, ...) were read.',
      );
    }

    // Each resource is read once, even when two channels use it.
    const infoTexts = new Map<string, Record<string, LocaleText<AppStoreField>>>();
    const infoChoices = new Map<string, Record<string, string>>();
    const versionTexts = new Map<string, Record<string, LocaleText<AppStoreField>>>();
    const versionLocalizations = new Map<string, [string, string][]>();
    const readInfo = async (info: ListingResource) => {
      let locales = infoTexts.get(info.id);
      if (!locales) {
        locales = {};
        const items: Json[] = [];
        const path = `/v1/appInfos/${enc(info.id)}/appInfoLocalizations?limit=${this.#pageSize}`;
        for await (const item of this.#pages(path, what)) items.push(item);
        localizedTexts(items, INFO_LOCALIZATION_FIELDS, locales);
        infoChoices.set(info.id, choicesUrls(items));
        infoTexts.set(info.id, locales);
      }
      return locales;
    };
    const readVersion = async (version: ListingResource) => {
      let locales = versionTexts.get(version.id);
      if (!locales) {
        locales = {};
        const items: Json[] = [];
        const path = `/v1/appStoreVersions/${enc(version.id)}/appStoreVersionLocalizations?limit=${this.#pageSize}`;
        for await (const item of this.#pages(path, what)) items.push(item);
        localizedTexts(items, VERSION_LOCALIZATION_FIELDS, locales);
        versionLocalizations.set(version.id, localizationIds(items));
        versionTexts.set(version.id, locales);
      }
      return locales;
    };
    /** Screenshot and preview sets of every locale of a version, as metadata. Undefined: not read. */
    const readMedia = async (
      version: ListingResource,
      label: string,
    ): Promise<ListingSections['media']> => {
      const wanted = versionLocalizations.get(version.id) ?? [];
      const screenshots: Record<string, MediaSet[]> = {};
      const previews: Record<string, MediaSet[]> = {};
      const sets = `limit=200&limit[%ITEMS%]=${MAX_MEDIA_PER_SET}&include=%ITEMS%`;
      try {
        for (const [locale, localizationId] of wanted.slice(0, MAX_MEDIA_LOCALES)) {
          const base = `/v1/appStoreVersionLocalizations/${enc(localizationId)}`;
          const shots = await this.#get(
            `${base}/appScreenshotSets?${sets.replaceAll('%ITEMS%', 'appScreenshots')}&fields[appScreenshotSets]=screenshotDisplayType,appScreenshots&fields[appScreenshots]=fileName,assetDeliveryState`,
            what,
          );
          const prev = await this.#get(
            `${base}/appPreviewSets?${sets.replaceAll('%ITEMS%', 'appPreviews')}&fields[appPreviewSets]=previewType,appPreviews&fields[appPreviews]=fileName,assetDeliveryState`,
            what,
          );
          screenshots[locale] = appleMediaSets(shots as Json, 'screenshots');
          previews[locale] = appleMediaSets(prev as Json, 'previews');
        }
      } catch (error) {
        warnings.push(
          sectionWarning(error, `The screenshots and previews of the ${label} version`),
        );
        return undefined;
      }
      const truncated = wanted.length > MAX_MEDIA_LOCALES;
      if (truncated) {
        warnings.push(
          `Screenshots and previews were read for ${MAX_MEDIA_LOCALES} of ${wanted.length} locales of the ${label} version.`,
        );
      }
      return { screenshots, previews, ...(truncated ? { truncated: true } : {}) };
    };

    const channels: StoreListingChannel[] = [];
    const build = async (
      channel: 'live' | 'editable',
      version: ListingResource | undefined,
      info: ListingResource | undefined,
    ) => {
      if (!version && !info) return;
      const locales: Record<string, LocaleText<AppStoreField>> = {};
      for (const source of [
        info ? await readInfo(info) : {},
        version ? await readVersion(version) : {},
      ]) {
        for (const [locale, texts] of Object.entries(source)) {
          locales[locale] = { ...locales[locale], ...texts };
        }
      }
      const sections: ListingSections = {};
      if (info) {
        sections.privacy = { choicesUrls: infoChoices.get(info.id) ?? {} };
        const item = infoItems.get(info.id);
        if (withRelations && item) {
          const categories = appleCategories(item);
          if (categories) sections.categories = categories;
          else
            warnings.push(
              `Apple sent no category data for the ${channel} app info, so categories were not read.`,
            );
          const ageRating = appleAgeRating(item, infoIncluded);
          if (ageRating) sections.ageRating = ageRating;
          else
            warnings.push(
              `Apple sent no age rating declaration for the ${channel} app info, so the age rating was not read.`,
            );
        }
      }
      if (version) {
        sections.details = version.copyright !== undefined ? { copyright: version.copyright } : {};
        if (extended) {
          const media = await readMedia(version, channel);
          if (media) sections.media = media;
        }
      }
      channels.push({
        channel,
        ...(version?.versionString !== undefined ? { versionString: version.versionString } : {}),
        ...(version ? { versionRawState: version.rawState } : {}),
        ...(info ? { infoRawState: info.rawState } : {}),
        listing: { appStore: { locales } },
        ...(Object.keys(sections).length > 0 ? { sections } : {}),
      });
    };
    await build('live', liveVersion, liveInfo);
    if (editableVersion) {
      if (!editableInfo && liveInfo) {
        warnings.push(
          'The editable version has no app info of its own: its name and subtitle are those of the live app info.',
        );
      }
      await build('editable', editableVersion, editableInfo ?? liveInfo);
    } else if (editableInfo) {
      await build('editable', undefined, editableInfo);
    }
    if (!liveInfo && !editableInfo) {
      warnings.push('No app info was found, so name, subtitle and privacy policy were not read.');
    }
    return { platform: this.platform, appStoreId, channels, warnings };
  }

  /**
   * The fallback of `listBuilds`: which pre-release version (marketing version and platform) each
   * build belongs to, from `GET /v1/preReleaseVersions?filter[app]=<id>&include=builds`. Apple caps
   * the included builds at 50 per version (`limit[builds]`), so a version with more builds leaves
   * the older ones without a `versionString`. If Apple rejects this query too, the builds are
   * returned without versions rather than failing the sync.
   */
  async #preReleaseByBuild(appStoreId: string): Promise<Map<string, PreRelease>> {
    const path = `/v1/preReleaseVersions?filter[app]=${enc(appStoreId)}&include=builds&limit=${this.#pageSize}&limit[builds]=${MAX_INCLUDED_BUILDS}`;
    const byBuild = new Map<string, PreRelease>();
    try {
      const { items } = await this.#collect(
        path,
        `listing the pre-release versions of app ${appStoreId}`,
      );
      for (const item of items) {
        const attributes = isRecord(item.attributes) ? item.attributes : {};
        const version = text(attributes.version);
        const platform = text(attributes.platform);
        const relationships = isRecord(item.relationships) ? item.relationships : {};
        const builds = isRecord(relationships.builds) ? relationships.builds : {};
        const pre: PreRelease = {
          ...(version !== undefined ? { version } : {}),
          ...(platform !== undefined ? { platform } : {}),
        };
        for (const ref of Array.isArray(builds.data) ? builds.data.filter(isRecord) : []) {
          const id = text(ref.id);
          if (id) byBuild.set(id, pre);
        }
      }
    } catch (error) {
      if (!isAppleParameterError(error)) throw error;
    }
    return byBuild;
  }

  async #collect(path: string, what: string): Promise<{ items: Json[]; included: Json[] }> {
    const items: Json[] = [];
    const included: Json[] = [];
    for await (const item of this.#pages(path, what, (more) => included.push(...more)))
      items.push(item);
    return { items, included };
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
    const redact = (value: string | undefined) =>
      value === undefined ? undefined : this.#http.redact(value);
    const details = (error.details ?? []).map((d) => {
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
    throw new StoreError(
      'appstoreconnect',
      error.kind,
      this.#http.redact(error.message),
      error.status,
      details,
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
