import { StoreError } from '../errors.ts';
import { isRecord, type Json, records, type StoreHttpOptions, text } from '../store-http.ts';
import {
  type BetaFeedbackKind,
  type BetaScreenshot,
  type BetaScreenshotLink,
  type ListBetaFeedbackResult,
  type StoreBetaFeedback,
  type StoreTestFlightFeedbackConnector,
} from '../testflight-feedback-types.ts';
import { mapLimit } from './appstore-products.ts';
import { AppleProductsHttp, seg } from './appstore-products-http.ts';

/**
 * App Store Connect: TestFlight beta feedback (screenshot submissions) and crash submissions, READ ONLY (docs/spikes/testflight-feedback.md has
 * every source). Endpoints, checked on Apple's pages (the JSON behind developer.apple.com/documentation, 2026-11-22); the pages list parameters,
 * allowed values and the names and types of attributes, never a real response, so what a response looks like is UNVERIFIED:
 *
 * - `GET /v1/apps/{id}/betaFeedbackScreenshotSubmissions` and `.../betaFeedbackCrashSubmissions` with `sort=-createdDate`, `limit` (max 200),
 *   `include=build` (the build number is `builds.version`), `filter[appPlatform]`. Attributes: `createdDate`, `comment`, `email`, `deviceModel`,
 *   `osVersion`, `locale`, `timeZone`, `architecture`, `connectionType`, `pairedAppleWatch`, `appUptimeInMilliseconds`, `diskBytesAvailable`,
 *   `diskBytesTotal`, `batteryPercentage`, `screenWidthInPoints`, `screenHeightInPoints`, `appPlatform`, `devicePlatform`, `deviceFamily`,
 *   `buildBundleId`, and `screenshots` (`url`, `width`, `height`, `expirationDate`) on screenshot submissions.
 * - `GET /v1/builds/{id}/preReleaseVersion` for the marketing version of a build (`fields[preReleaseVersions]=version,platform`).
 * - `GET /v1/betaFeedbackCrashSubmissions/{id}/crashLog` (`fields[betaCrashLogs]=logText`): the crash log text.
 * - `GET /v1/betaFeedbackScreenshotSubmissions/{id}`: one submission, for fresh screenshot links.
 *
 * The role of the key must be ADMIN, APP MANAGER or DEVELOPER. A list Apple refuses (403: the role; 404) is a warning and an empty list, never
 * a failed read, unless both lists are refused (then the error is thrown, so a wrong key is said). Any other failure fails the whole read: a
 * half-read answer never replaces a good copy. Unknown fields are ignored; every field may be missing. The read is capped and says so.
 */

export type AppleTestFlightFeedbackOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: import('./apple-auth.ts').AppStoreConnectKey;
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** `macos` asks for `MAC_OS` submissions, `ios` for `IOS`. Default `ios`. */
  scope?: 'ios' | 'macos';
  apiBase?: string;
  /** Most submissions of each kind read per sync. Default 400. */
  maxItems?: number;
  /** Pages (of 200) per list. Default 2. */
  maxPages?: number;
  /** Most distinct builds whose version is looked up. Default 30. */
  maxBuilds?: number;
  concurrency?: number;
};

const attrs = (r: Json): Json => (isRecord(r.attributes) ? r.attributes : {});
const id = (r: Json): string => text(r.id) ?? '';
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
const dateMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
};
const refused = (error: unknown): error is StoreError =>
  error instanceof StoreError && (error.kind === 'forbidden' || error.kind === 'not_found');

const relatedId = (resource: Json, name: string): string | null => {
  const rels = isRecord(resource.relationships) ? resource.relationships : {};
  const rel = rels[name];
  if (!isRecord(rel) || !isRecord(rel.data)) return null;
  return str(rel.data.id);
};

/** The screenshots of a submission as sizes; an entry that is not an object is skipped. */
export function screenshotSizes(value: unknown): BetaScreenshot[] {
  return records(value).map((s) => ({ width: int(s.width), height: int(s.height) }));
}

const MAX_COMMENT = 5_000;
const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/** One submission resource as a `StoreBetaFeedback`; null when it has no id. `builds` are the included builds by id. */
export function parseSubmission(
  kind: BetaFeedbackKind,
  r: Json,
  builds: ReadonlyMap<string, Json>,
): StoreBetaFeedback | null {
  const sid = id(r);
  if (sid === '') return null;
  const a = attrs(r);
  const buildId = relatedId(r, 'build');
  const build = buildId === null ? undefined : builds.get(buildId);
  return {
    id: sid,
    kind,
    createdAt: dateMs(a.createdDate),
    comment: clip(typeof a.comment === 'string' ? a.comment : '', MAX_COMMENT),
    email: str(a.email),
    buildId,
    buildNumber: build ? str(attrs(build).version) : null,
    version: null,
    platform: str(a.appPlatform),
    bundleId: str(a.buildBundleId),
    deviceModel: str(a.deviceModel),
    deviceFamily: str(a.deviceFamily),
    osVersion: str(a.osVersion),
    locale: str(a.locale),
    timeZone: str(a.timeZone),
    architecture: str(a.architecture),
    connectionType: str(a.connectionType),
    pairedWatch: str(a.pairedAppleWatch),
    appUptimeMs: int(a.appUptimeInMilliseconds),
    diskFreeBytes: int(a.diskBytesAvailable),
    diskTotalBytes: int(a.diskBytesTotal),
    batteryPercent: int(a.batteryPercentage),
    screenWidth: int(a.screenWidthInPoints),
    screenHeight: int(a.screenHeightInPoints),
    screenshots: kind === 'feedback' ? screenshotSizes(a.screenshots) : [],
  };
}

export class AppleTestFlightFeedbackConnector implements StoreTestFlightFeedbackConnector {
  readonly store = 'appstoreconnect' as const;
  readonly #api: AppleProductsHttp;
  readonly #app: string;
  readonly #scope: 'ios' | 'macos';
  readonly #maxItems: number;
  readonly #maxPages: number;
  readonly #maxBuilds: number;
  readonly #concurrency: number;

  constructor(options: AppleTestFlightFeedbackOptions) {
    if (!/^[0-9]{1,20}$/.test(options.appStoreId)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the app is missing or not a number. Sync the app first.',
      );
    }
    this.#app = options.appStoreId;
    this.#api = new AppleProductsHttp(options);
    this.#scope = options.scope ?? 'ios';
    this.#maxItems = Math.max(1, options.maxItems ?? 400);
    this.#maxPages = Math.max(1, options.maxPages ?? 2);
    this.#maxBuilds = Math.max(1, options.maxBuilds ?? 30);
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
  }

  /** Builds a connector from the stored secret (core `buildSecret` JSON for `app_store_connect`). */
  static fromSecret(
    secret: string,
    options: Omit<AppleTestFlightFeedbackOptions, 'credential'>,
  ): AppleTestFlightFeedbackConnector {
    return new AppleTestFlightFeedbackConnector({
      ...options,
      credential: AppleProductsHttp.credentialOf(secret),
    });
  }

  async listFeedback(): Promise<ListBetaFeedbackResult> {
    const warnings: string[] = [];
    const result: ListBetaFeedbackResult = {
      items: [],
      complete: true,
      warnings,
      feedbackRead: false,
      crashesRead: false,
    };
    let firstRefusal: StoreError | undefined;
    let refusals = 0;
    for (const kind of ['feedback', 'crash'] as const) {
      try {
        const read = await this.#list(kind);
        result.items.push(...read.items);
        if (kind === 'feedback') result.feedbackRead = true;
        else result.crashesRead = true;
        if (read.truncated) {
          result.complete = false;
          warnings.push(
            `The list of ${kind === 'feedback' ? 'feedback' : 'crash'} submissions was cut at its limit: Apple may have older ones.`,
          );
        }
      } catch (error) {
        if (!refused(error)) throw error;
        firstRefusal ??= error;
        refusals++;
        warnings.push(
          `App Store Connect did not give the ${kind === 'feedback' ? 'feedback' : 'crash'} submissions of this app (the key needs the Admin, App Manager or Developer role, and the app needs TestFlight builds).`,
        );
      }
    }
    if (firstRefusal && refusals >= 2) throw firstRefusal;
    await this.#versions(result.items, warnings);
    return result;
  }

  async #list(kind: BetaFeedbackKind): Promise<{ items: StoreBetaFeedback[]; truncated: boolean }> {
    const resource =
      kind === 'feedback' ? 'betaFeedbackScreenshotSubmissions' : 'betaFeedbackCrashSubmissions';
    const platform = this.#scope === 'macos' ? 'MAC_OS' : 'IOS';
    const list = await this.#api.list(
      `/v1/apps/${seg(this.#app)}/${resource}?sort=-createdDate&limit=200&include=build&fields[builds]=version,preReleaseVersion&filter[appPlatform]=${platform}`,
      kind === 'feedback' ? 'reading the TestFlight feedback' : 'reading the TestFlight crashes',
      { maxPages: this.#maxPages },
    );
    const builds = new Map<string, Json>(
      list.included
        .filter((r) => text(r.type) === 'builds' || text(r.type) === undefined)
        .map((r) => [id(r), r]),
    );
    const items: StoreBetaFeedback[] = [];
    const seen = new Set<string>();
    for (const row of list.data) {
      const item = parseSubmission(kind, row, builds);
      if (!item || seen.has(item.id)) continue;
      // The platform is an attribute: a submission of another platform is not this app record's. One with no platform is kept.
      const p = (item.platform ?? '').toUpperCase();
      if (p !== '' && p !== platform) continue;
      seen.add(item.id);
      items.push(item);
    }
    const truncated = list.truncated || items.length > this.#maxItems;
    return { items: items.slice(0, this.#maxItems), truncated };
  }

  /** Fills `version` from the prerelease version of each distinct build. A build whose version cannot be read keeps null (never a failed read). */
  async #versions(items: StoreBetaFeedback[], warnings: string[]): Promise<void> {
    const buildIds = [
      ...new Set(items.map((i) => i.buildId).filter((b): b is string => b !== null)),
    ];
    const wanted = buildIds.slice(0, this.#maxBuilds);
    if (buildIds.length > wanted.length) {
      warnings.push('Some builds are not named by version: too many distinct builds in one read.');
    }
    const versions = new Map<string, string | null>();
    await mapLimit(wanted, this.#concurrency, async (buildId) => {
      try {
        const body = await this.#api.get(
          `/v1/builds/${seg(buildId)}/preReleaseVersion?fields[preReleaseVersions]=version,platform`,
          'reading the version of a build',
          true,
        );
        const data = body && isRecord(body.data) ? body.data : undefined;
        versions.set(buildId, data ? str(attrs(data).version) : null);
      } catch (error) {
        // Rate limits and the like fail the read; a refusal only leaves the version unknown.
        if (!refused(error)) throw error;
        versions.set(buildId, null);
      }
    });
    for (const item of items) {
      if (item.buildId !== null) item.version = versions.get(item.buildId) ?? null;
    }
  }

  async readCrashLog(submissionId: string): Promise<string | null> {
    const body = await this.#api.get(
      `/v1/betaFeedbackCrashSubmissions/${seg(submissionId)}/crashLog?fields[betaCrashLogs]=logText`,
      'reading a TestFlight crash log',
      true,
    );
    const data = body && isRecord(body.data) ? body.data : undefined;
    return data ? str(attrs(data).logText) : null;
  }

  async readScreenshots(submissionId: string): Promise<BetaScreenshotLink[]> {
    const body = await this.#api.get(
      `/v1/betaFeedbackScreenshotSubmissions/${seg(submissionId)}?fields[betaFeedbackScreenshotSubmissions]=screenshots`,
      'reading the screenshots of a TestFlight feedback',
      true,
    );
    const data = body && isRecord(body.data) ? body.data : undefined;
    if (!data) return [];
    const out: BetaScreenshotLink[] = [];
    for (const s of records(attrs(data).screenshots)) {
      const url = str(s.url);
      if (url === null) continue;
      // Only a plain https address is ever handed on.
      let ok = false;
      try {
        ok = new URL(url).protocol === 'https:';
      } catch {
        ok = false;
      }
      if (ok)
        out.push({
          url,
          width: int(s.width),
          height: int(s.height),
          expiresAt: dateMs(s.expirationDate),
        });
    }
    return out;
  }
}
