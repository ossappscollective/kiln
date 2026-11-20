import {
  APPLE_VERSION_LOCALIZATION_ATTRIBUTES,
  classifyAppleScreenshot,
  normalizeReleaseValue,
  PLATFORM_META,
} from '@mrm/core';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError, isAppleParameterError } from './appstoreconnect.ts';
import { StoreError, type StoreErrorDetail } from '../errors.ts';
import { appleBuildEligibility } from '../release-eligibility.ts';
import {
  type BuildCandidate,
  type BuildTestNotes,
  type EditableRelease,
  MAX_BUILDS_WITH_NOTES,
  MAX_NOTE_CHARS,
  MAX_NOTE_LOCALES,
  MAX_NOTES_HISTORY_VERSIONS,
  type NotesHistoryEntry,
  type NotesHistoryRead,
  type ReleaseCandidates,
  type StoreNotesHistoryReader,
  type StoreReleaseReader,
} from '../release-types.ts';
import {
  APPLE_DRAFT_VERSION_STATES,
  DRAFT_IMAGE_READY_STATES,
  type DraftApplyInput,
  type DraftApplyResult,
  type DraftAssetState,
  type DraftAssetWrite,
  DraftDriftError,
  type DraftFieldFacts,
  type DraftFieldState,
  type DraftFieldWrite,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftReadRequest,
  type DraftSlot,
  type DraftState,
  type DraftStep,
  type DraftTextState,
  type StoreDraftConnector,
  type StoreImageReader,
  type StoreImageRecord,
  type StoreImagesRead,
  setMatches,
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

/**
 * App Store Connect: write listing text and screenshots into the EDITABLE App Store version, as a
 * draft. A STORE WRITE. Only ever called by the server's draft service, after a rights check, a
 * preview, a confirmation hash and a re-read of the draft (docs/adr/0009-staged-store-drafts.md).
 * It never submits the version for review, never creates a version and never releases anything.
 *
 * The version it writes to is the one whose state is in `APPLE_DRAFT_VERSION_STATES`
 * (`PREPARE_FOR_SUBMISSION` and the rejected states; the names are Apple's, that these are the states
 * in which a listing can be edited is not on Apple's pages: UNVERIFIED, as for the read connector). A
 * version waiting for or in review is never written. No such version: `no_editable_version`. More than one:
 * `invalid_input`, never a guess.
 *
 * Endpoints. VERIFIED means read on Apple's pages on 2026-11-18; Apple's field pages are mostly empty,
 * so request bodies are JSON:API as the read side and Apple's articles show them.
 *
 * - `GET /v1/apps/{id}/appStoreVersions`, `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations`
 *   (used by the read connector). VERIFIED.
 * - `PATCH /v1/appStoreVersionLocalizations/{id}` ("Modify an app store version localization",
 *   VERIFIED title). UNVERIFIED: the body, assumed to be `{ data: { type, id, attributes } }` with the
 *   attributes `description`, `keywords`, `marketingUrl`, `promotionalText`, `supportUrl`, `whatsNew`
 *   (the names the read connector parses).
 * - `POST /v1/appStoreVersionLocalizations` to add a locale: UNVERIFIED body (`attributes.locale`, relationship
 *   `appStoreVersion`).
 * - Screenshots: the APP ASSET LIBRARY (App Store Connect API 4.5.0, "Understanding the App Asset Library",
 *   https://developer.apple.com/documentation/appstoreconnectapi/understanding-the-app-asset-library; Apple
 *   DEPRECATED the set based `appScreenshotSets` / `appScreenshots` in 4.5.1 and this connector no longer
 *   touches them: https://developer.apple.com/documentation/appstoreconnectapi/migrating-to-the-app-asset-library).
 *   VERIFIED on Apple's pages on 2026-11-18, with request bodies as Apple's examples show them:
 *   1. `GET /v1/apps/{id}/assetLibrary`: the library id (`appAssetLibraries`), stable for the life of the app;
 *   2. `GET /v1/appAssetLibraryRefData`: reference data (`features`, `placementProfileGroups`, `imageSpecs`,
 *      `placementTypes` with `specMappings` per `placementGroupId`, `displayClasses`). Placement group ids
 *      (`IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE`) are NOT an enumeration: this connector finds the group of a set
 *      by the pixel size of its files (the group whose `APP_SCREENSHOT` specs have exactly that size, narrowed
 *      by the device family when several do) and refuses a set it cannot place unambiguously;
 *   3. `POST /v1/appAssetLibraryImages` (`fileName`, `fileSize`, `category: APP_SCREENSHOTS_AND_PREVIEWS`,
 *      `referenceName`, relationship `assetLibrary`): `AWAITING_UPLOAD` and `uploadOperations`;
 *   4. every operation: the bytes `offset` to `offset + length` to `url`, no JWT (unauthenticated, time limited);
 *   5. `PATCH /v1/appAssetLibraryImages/{id}` with `uploaded: true` ALONE (no checksum: Apple checks the bytes
 *      against the declared `fileSize`), then `UPLOAD_COMPLETE`;
 *   6. read the image until `state` is `PREPARE_FOR_SUBMISSION` (processed; `specId` and `imageAsset` are set) or
 *      `FAILED` (`stateDetails`; delete it and reserve again). `specId` is compared with the specs of the group
 *      ("a file that matches a different specification limits which groups accept it");
 *   7. `POST /v1/appAssetLibraryPlacements` (`placementType: APP_SCREENSHOT`, `placementGroup`, relationships `image`
 *      and `appStoreVersionLocalization`): only while the version is editable; at most 10 per group
 *      (`features[].placementPolicies[].groupLimits[].maxCount`, read from the reference data);
 *   8. `POST /v1/appAssetLibraryPlacementOrderingRequests` (`placementGroup`, `orderedPlacements`, the localization)
 *      sets the display order of ONE group of ONE localization;
 *   9. read: `GET /v1/appStoreVersionLocalizations/{id}/placements?filter[placementType]=APP_SCREENSHOT&sort=placementGroupPosition&include=image`
 *      (the order of the answer is the display order);
 *   10. a placement cannot be changed, only deleted (`DELETE /v1/appAssetLibraryPlacements/{id}`, 204); deleting a
 *      library image that still has placements is `409 STATE_ERROR.ASSET_HAS_PLACEMENTS`.
 *   UNVERIFIED: the checksum. The library has none, so the SHA-256 (first 32 hex characters) of every file this
 *   connector uploads is written into the image's `referenceName` (`mrm:sha256:<hex>`) and read back from there to
 *   tell "the same file" (idempotent pushes, reuse of an image that is already in the library); whether Apple
 *   accepts that text and length, the `filter[referenceName]` semantics of `GET /v1/appAssetLibraries/{id}/images`,
 *   the `limit` and `fields` parameters of the placements list, the `deviceFamily` strings of the display
 *   classes, and the success statuses (any 2xx counts). Images of the library are never deleted by this connector
 *   except one that failed processing here: replacing a set deletes PLACEMENTS only (the library is shared with
 *   custom product pages and may hold the image elsewhere; an unused image is harmless).
 *
 * Replacing a set: the images it needs are found in the library (by their reference name) or uploaded and processed
 * FIRST (nothing visible changes), then the placements: new ones are created before the old ones are deleted when
 * the group has room for both (at most 10), else the old ones first (a failure in between leaves the group short:
 * the step list says so); a placement whose image already is the wanted file is kept. Finally the order is set.
 * A set that already holds exactly the new files in the new order is left alone, so a repeated push does not
 * duplicate anything.
 *
 * Writes never retry, not even a 429 or a part upload (a half finished reservation is replaced by the next
 * push). Every request changes the draft at once, there is no transaction: a refusal after some steps is a
 * `DraftPartialError` that lists what was written. A timeout, a cut connection or a 5xx on a write is
 * `DraftOutcomeUnknownError`; the caller reads the draft back.
 *
 * No message carries the key, a JWT or an upload URL.
 */

export type AppleDraftConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  pageSize?: number;
  maxPages?: number;
  /** The Apple platform whose version is read and written: `ios` (default) or `macos` (`MAC_OS`). */
  platform?: 'ios' | 'macos';
  /** Time between two looks at an uploaded file's processing state. Default 2000. */
  pollIntervalMs?: number;
  /** Looks at the processing state before giving up. Default 20. */
  maxPolls?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const DEFAULT_BUILD_CANDIDATES = 10;
const MAX_ERROR_DETAILS = 5;
const MAX_SET_FILES = 10;
/** An upload URL is only used when it is an https address of Apple's. */
const UPLOAD_HOST = /(^|\.)apple\.com$/i;

type LocalizationRef = { id: string; attributes: Json };
/** The editable version, with the attributes of the list answer (release type, earliest release date, copyright). */
type AttachedBuild = {
  id: string;
  buildNumber: string | null;
  processingState: string | null;
  expired: boolean | null;
};
type VersionRef = { id: string; versionString: string | null; state: string; attrs: Json };
/** App Store version attribute of a release field (`version_string` is written as `versionString`). */
const VERSION_ATTRIBUTES: Readonly<Record<string, string>> = {
  version_string: 'versionString',
  release_type: 'releaseType',
  earliest_release_date: 'earliestReleaseDate',
  copyright: 'copyright',
};

/** A placement of the editable version's localization, with the library image behind it. */
type PlacementRef = { id: string; group: string; imageId: string | null; image: Json };
type Dims = { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number };
type RefData = {
  /** placement group -> the ids of the image specs its `APP_SCREENSHOT` placements accept. */
  screenshotSpecs: Map<string, Set<string>>;
  specs: Map<string, Dims>;
  groups: Map<string, { platform: string | null; displayClass: string | null }>;
  displayClasses: Map<string, { family: string | null; screens: string[] }>;
  /** placement group -> most screenshots per group (default `MAX_SET_FILES`). */
  maxCount: Map<string, number>;
};

const REFERENCE_PREFIX = 'mrm:sha256:';
const REFERENCE_HEX = 32;
const referenceName = (sha256: string): string =>
  `${REFERENCE_PREFIX}${sha256.slice(0, REFERENCE_HEX)}`;
const hashOfReference = (name: string | undefined): string | null => {
  if (name === undefined || !name.startsWith(REFERENCE_PREFIX)) return null;
  const hex = name.slice(REFERENCE_PREFIX.length).toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
};
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** The family keyword of a device id of this server's (`iphone_6_5` is an IPHONE display, and so on). */
const familyOf = (device: string | null): string | null => {
  if (device === null) return null;
  if (device.startsWith('iphone')) return 'IPHONE';
  if (device.startsWith('ipad')) return 'IPAD';
  if (device === 'mac') return 'MAC';
  if (device === 'apple_tv') return 'TV';
  return null;
};
const screenOf = (device: string | null): string | null => {
  const m = device === null ? null : /^i(?:phone|pad)_(\d+)_(\d+)$/.exec(device);
  return m ? `${m[1]}.${m[2]}` : null;
};

const attr = (field: string): string => APPLE_VERSION_LOCALIZATION_ATTRIBUTES[field] ?? '';

/** At most MAX_NOTE_CHARS characters, never cutting a surrogate pair in two. */
function capText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_NOTE_CHARS) return { text: value, truncated: false };
  let end = MAX_NOTE_CHARS;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: value.slice(0, end), truncated: true };
}

export class AppleDraftConnector
  implements StoreDraftConnector, StoreImageReader, StoreReleaseReader, StoreNotesHistoryReader
{
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
  readonly #pollMs: number;
  readonly #maxPolls: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #library: string | undefined;
  #ref: RefData | undefined;

  constructor(options: AppleDraftConnectorOptions) {
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
    this.#pollMs = options.pollIntervalMs ?? 2000;
    this.#maxPolls = Math.max(1, options.maxPolls ?? 20);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
  static fromSecret(
    secret: string,
    options: Omit<AppleDraftConnectorOptions, 'credential'>,
  ): AppleDraftConnector {
    return new AppleDraftConnector({ ...options, credential: parseAppStoreConnectSecret(secret) });
  }

  async readDraft(request: DraftReadRequest): Promise<DraftState> {
    const version = await this.#editableVersion();
    const locs = await this.#localizations(version.id);
    return (await this.#read(request, version, locs)).state;
  }

  /**
   * READ ONLY, for the submit connector: the listing of a version (any state): every locale's texts (the fields of
   * the version localization) and the facts of every screenshot placement group. Writes nothing.
   */
  async readListing(versionId: string): Promise<
    {
      locale: string;
      text: Record<string, string | null>;
      groups: {
        group: string;
        images: {
          id: string;
          checksum: string | null;
          width: number | null;
          height: number | null;
          state: string | null;
        }[];
      }[];
    }[]
  > {
    const locs = await this.#localizations(versionId);
    const out = [];
    for (const [locale, ref] of locs) {
      const text_: Record<string, string | null> = {};
      for (const field of Object.keys(APPLE_VERSION_LOCALIZATION_ATTRIBUTES))
        text_[field] = text(ref.attributes[attr(field)]) ?? null;
      const groups = new Map<
        string,
        {
          id: string;
          checksum: string | null;
          width: number | null;
          height: number | null;
          state: string | null;
        }[]
      >();
      for (const p of await this.#placements(ref.id)) {
        const a = isRecord(p.image.attributes) ? p.image.attributes : {};
        const asset = isRecord(a.imageAsset) ? a.imageAsset : {};
        const list = groups.get(p.group) ?? [];
        list.push({
          id: p.id,
          checksum: hashOfReference(text(a.referenceName)),
          width: num(asset.width) ?? null,
          height: num(asset.height) ?? null,
          state: text(a.state) ?? null,
        });
        groups.set(p.group, list);
      }
      out.push({
        locale,
        text: text_,
        groups: [...groups].map(([group, images]) => ({ group, images })),
      });
    }
    return out;
  }

  /**
   * READ ONLY: every screenshot of every localization of the editable version (else the live one) with the facts of its library
   * image: `imageAsset.templateUrl`, width and height, `fileSize`, and the checksum this server wrote into `referenceName`
   * (none for an image somebody else uploaded). Apple's `ImageAsset` has `templateUrl`, `width` and `height`
   * (VERIFIED, "Uploading and managing image assets" and "Read an app asset library image", read 2026-11-18); that the
   * template, filled with the image's own width, height and `png`, serves the ORIGINAL bytes is UNVERIFIED (Apple's page
   * says "to render a thumbnail"), so a pulled file is compared by size and never taken as byte for byte the uploaded file.
   * The device of an image is worked out from its pixel size; an image of an unknown size is counted in `unplaced`.
   */
  async readStoreImages(): Promise<StoreImagesRead> {
    const notes: string[] = [];
    const version = await this.#readableVersion(notes);
    const locs = await this.#localizations(version.id);
    const images: StoreImageRecord[] = [];
    let unplaced = 0;
    for (const [locale, ref] of locs) {
      const counters = new Map<string, number>();
      for (const p of await this.#placements(ref.id)) {
        const a = isRecord(p.image.attributes) ? p.image.attributes : {};
        const asset = isRecord(a.imageAsset) ? a.imageAsset : {};
        const width = num(asset.width) ?? null;
        const height = num(asset.height) ?? null;
        const device =
          width !== null && height !== null ? classifyAppleScreenshot(width, height) : null;
        if (device === null) {
          unplaced++;
          continue;
        }
        const position = (counters.get(device) ?? 0) + 1;
        counters.set(device, position);
        const hash = hashOfReference(text(a.referenceName));
        const url = text(asset.templateUrl) ?? null;
        images.push({
          locale,
          kind: 'screenshot',
          device,
          target: p.group,
          position,
          id: p.id,
          name: text(a.fileName) ?? null,
          width,
          height,
          bytes: num(a.fileSize) ?? null,
          checksum: hash,
          checksumKind: hash === null ? null : 'sha256',
          state: text(a.state) ?? null,
          url,
          urlKind: url === null ? null : 'apple_template',
        });
      }
    }
    return { version, images, unplaced, notes };
  }

  /** The editable iOS version, else the one that is live (`READY_FOR_SALE`, UNVERIFIED name), else a refusal. */
  async #readableVersion(
    notes: string[],
  ): Promise<{ id: string; versionString: string | null; state: string; editable: boolean }> {
    try {
      const v = await this.#editableVersion();
      return { id: v.id, versionString: v.versionString, state: v.state, editable: true };
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'no_editable_version') throw error;
    }
    const what = 'looking for the live App Store version';
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        const state = (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase();
        if (id && text(a.platform) === this.#apple && state === 'READY_FOR_SALE') {
          notes.push('There is no editable version, so the images of the live version were read.');
          return { id, versionString: text(a.versionString) ?? null, state, editable: false };
        }
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    throw new StoreError(
      'appstoreconnect',
      'no_editable_version',
      `App Store Connect has no editable and no live ${this.#label} version to read the screenshots of.`,
      404,
    );
  }

  async applyDraft(input: DraftApplyInput): Promise<DraftApplyResult> {
    const request: DraftReadRequest = {
      text: input.text.map((t) => ({ locale: t.locale, field: t.field })),
      assets: input.assets.map((a) => ({
        locale: a.locale,
        kind: a.kind,
        device: a.device,
        target: a.target,
        width: a.width ?? null,
        height: a.height ?? null,
      })),
      ...(input.fields !== undefined && input.fields.length > 0 ? { fields: input.fields } : {}),
    };
    const version = await this.#editableVersion();
    const locs = await this.#localizations(version.id);
    const read = await this.#read(request, version, locs);
    const before = read.state;
    if (!input.guard(before)) throw new DraftDriftError(before);

    const steps: DraftStep[] = [];
    let at: { type: DraftStep['type']; locale: string; target: string } = {
      type: 'text',
      locale: '',
      target: '',
    };
    try {
      // Texts, one request per locale (all of its changed fields together), then the sets.
      const byLocale = new Map<string, Map<string, string>>();
      for (const t of input.text) {
        const fields = byLocale.get(t.locale) ?? new Map<string, string>();
        fields.set(t.field, t.value);
        byLocale.set(t.locale, fields);
      }
      const localeIds = new Map<string, string>();
      for (const [locale, ref] of locs) localeIds.set(locale, ref.id);
      for (const [locale, fields] of byLocale) {
        const known = locs.get(locale);
        const wanted: Record<string, string> = {};
        for (const [field, value] of fields) wanted[attr(field)] = value;
        at = { type: 'text', locale, target: [...fields.keys()].join(',') };
        if (known) {
          const changed: Record<string, string> = {};
          for (const [key, value] of Object.entries(wanted)) {
            if (typeof known.attributes[key] !== 'string' || known.attributes[key] !== value)
              changed[key] = value;
          }
          if (Object.keys(changed).length === 0) {
            for (const field of fields.keys())
              steps.push({ type: 'text', locale, target: field, outcome: 'already_same' });
            continue;
          }
          await this.#write(
            'PATCH',
            `/v1/appStoreVersionLocalizations/${enc(known.id)}`,
            `changing the ${locale} texts`,
            {
              data: { type: 'appStoreVersionLocalizations', id: known.id, attributes: changed },
            },
          );
          for (const field of fields.keys()) {
            const changedHere = attr(field) in changed;
            steps.push({
              type: 'text',
              locale,
              target: field,
              outcome: changedHere ? 'applied' : 'already_same',
            });
          }
        } else {
          const created = await this.#write(
            'POST',
            '/v1/appStoreVersionLocalizations',
            `adding the ${locale} locale`,
            {
              data: {
                type: 'appStoreVersionLocalizations',
                attributes: { locale, ...wanted },
                relationships: {
                  appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
                },
              },
            },
          );
          const id = idOf(created);
          if (!id)
            throw new StoreError(
              'appstoreconnect',
              'unexpected',
              `App Store Connect created the ${locale} locale but sent no id.`,
              created.status,
            );
          localeIds.set(locale, id);
          steps.push({ type: 'locale', locale, target: 'locale', outcome: 'applied' });
          for (const field of fields.keys())
            steps.push({ type: 'text', locale, target: field, outcome: 'applied' });
        }
      }
      if (input.fields !== undefined && input.fields.length > 0) {
        at = { type: 'field', locale: '', target: 'version' };
        steps.push(
          ...(await this.#applyFields(
            version.id,
            input.fields,
            before.fields ?? [],
            (target) => (at = { type: 'field', locale: '', target }),
          )),
        );
      }
      for (const write of input.assets) {
        at = { type: 'asset', locale: write.locale, target: write.target };
        let locId = localeIds.get(write.locale);
        if (!locId) {
          at = { type: 'locale', locale: write.locale, target: 'locale' };
          const created = await this.#write(
            'POST',
            '/v1/appStoreVersionLocalizations',
            `adding the ${write.locale} locale`,
            {
              data: {
                type: 'appStoreVersionLocalizations',
                attributes: { locale: write.locale },
                relationships: {
                  appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
                },
              },
            },
          );
          locId = idOf(created);
          if (!locId)
            throw new StoreError(
              'appstoreconnect',
              'unexpected',
              `App Store Connect created the ${write.locale} locale but sent no id.`,
              created.status,
            );
          localeIds.set(write.locale, locId);
          steps.push({
            type: 'locale',
            locale: write.locale,
            target: 'locale',
            outcome: 'applied',
          });
          at = { type: 'asset', locale: write.locale, target: write.target };
        }
        const state = before.assets.find(
          (a) => a.locale === write.locale && a.target === write.target,
        );
        const group = state?.placementGroup ?? (await this.#groupFor(write));
        steps.push(
          await this.#replaceSet(
            locId,
            write,
            group,
            state,
            read.placements.get(`${write.locale}\u0000${group}`) ?? [],
          ),
        );
      }
    } catch (error) {
      throw this.#settle(error, steps, at);
    }
    return { before, steps, commit: 'none' };
  }

  /** A failure after some steps is partial, a lost answer is unknown; a failure before any step is just the failure. */
  #settle(
    error: unknown,
    steps: DraftStep[],
    at: { type: DraftStep['type']; locale: string; target: string },
  ): unknown {
    if (error instanceof DraftOutcomeUnknownError) {
      return new DraftOutcomeUnknownError(
        'appstoreconnect',
        error.message,
        [...steps],
        error.status,
      );
    }
    if (error instanceof StoreError && steps.some((s) => s.outcome === 'applied')) {
      return new DraftPartialError(error, [...steps], at);
    }
    return error;
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  async #editableVersion(): Promise<VersionRef> {
    const what = 'looking for the editable App Store version';
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const found: VersionRef[] = [];
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        const state = (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase();
        if (!id || text(a.platform) !== this.#apple || !APPLE_DRAFT_VERSION_STATES.includes(state))
          continue;
        found.push({ id, versionString: text(a.versionString) ?? null, state, attrs: a });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    if (found.length === 0) {
      throw new StoreError(
        'appstoreconnect',
        'no_editable_version',
        `App Store Connect has no ${this.#label} version whose listing can still be edited (a version in "Prepare for Submission"). Create the next version in App Store Connect first: this server does not create versions.`,
        404,
      );
    }
    if (found.length > 1) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `App Store Connect has more than one editable ${this.#label} version; this server will not guess which one to write to.`,
      );
    }
    return found[0] as VersionRef;
  }

  async #localizations(versionId: string): Promise<Map<string, LocalizationRef>> {
    const what = 'reading the localizations of the editable version';
    const out = new Map<string, LocalizationRef>();
    let url: string | undefined =
      `${this.#base}/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=${this.#pageSize}`;
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        const locale = text(a.locale);
        if (id && locale) out.set(locale, { id, attributes: a });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    return out;
  }

  async #read(
    request: DraftReadRequest,
    version: VersionRef,
    locs: Map<string, LocalizationRef>,
  ): Promise<{ state: DraftState; placements: Map<string, PlacementRef[]> }> {
    const textState: DraftTextState[] = request.text.map((t) => {
      const ref = locs.get(t.locale);
      const value = ref ? text(ref.attributes[attr(t.field)]) : undefined;
      return {
        locale: t.locale,
        field: t.field,
        value: value ?? null,
        localeExists: ref !== undefined,
      };
    });
    const read = new Map<string, PlacementRef[]>();
    for (const locale of new Set(request.assets.map((a) => a.locale))) {
      const ref = locs.get(locale);
      if (ref) read.set(locale, await this.#placements(ref.id));
    }
    const placements = new Map<string, PlacementRef[]>();
    const assets: DraftAssetState[] = [];
    for (const slot of request.assets) {
      const group = await this.#groupFor(slot);
      const mine = (read.get(slot.locale) ?? []).filter((p) => p.group === group);
      placements.set(`${slot.locale}\u0000${group}`, mine);
      assets.push({
        locale: slot.locale,
        kind: slot.kind,
        device: slot.device,
        target: slot.target,
        placementGroup: group,
        setExists: mine.length > 0,
        images: mine.map((p) => {
          const a = isRecord(p.image.attributes) ? p.image.attributes : {};
          const hash = hashOfReference(text(a.referenceName));
          return {
            id: p.id,
            name: text(a.fileName) ?? null,
            checksum: hash,
            checksumKind: 'sha256' as const,
            state: text(a.state) ?? null,
          };
        }),
      });
    }
    const fields =
      request.fields !== undefined && request.fields.length > 0
        ? await this.#readFields(request.fields, version)
        : undefined;
    return {
      state: {
        store: 'appstoreconnect',
        platform: this.platform,
        version: { id: version.id, versionString: version.versionString, state: version.state },
        text: textState,
        assets,
        ...(fields !== undefined ? { fields } : {}),
      },
      placements,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Release fields of the editable version (docs/api/releases-write.md). Names UNVERIFIED unless said.

  /** The build attached to a version, or null. `GET /v1/appStoreVersions/{id}/build` (title VERIFIED; the attributes are UNVERIFIED). */
  async #attachedBuild(versionId: string): Promise<AttachedBuild | null> {
    try {
      const { json } = await this.#get(
        `${this.#base}/v1/appStoreVersions/${enc(versionId)}/build`,
        'reading the build of the version',
      );
      const data = isRecord(json.data) ? json.data : undefined;
      const id = data ? text(data.id) : undefined;
      if (!data || !id) return null;
      const a = isRecord(data.attributes) ? data.attributes : {};
      return {
        id,
        buildNumber: text(a.version) ?? null,
        processingState: text(a.processingState) ?? null,
        expired: typeof a.expired === 'boolean' ? a.expired : null,
      };
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  /** The phased release of a version, or null when it has none (404 and `data: null` both mean none). */
  async #phasedRelease(versionId: string): Promise<{ id: string; state: string | null } | null> {
    try {
      const { json } = await this.#get(
        `${this.#base}/v1/appStoreVersions/${enc(versionId)}/appStoreVersionPhasedRelease`,
        'reading the phased release',
      );
      const data = isRecord(json.data) ? json.data : undefined;
      const id = data ? text(data.id) : undefined;
      if (!data || !id) return null;
      const a = isRecord(data.attributes) ? data.attributes : {};
      return { id, state: text(a.phasedReleaseState) ?? null };
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  /** One build by id (`GET /v1/builds/{id}`), or null when Apple does not know it. */
  async #buildById(buildId: string): Promise<AttachedBuild | null> {
    try {
      const { json } = await this.#get(
        `${this.#base}/v1/builds/${enc(buildId)}`,
        'looking up the build',
      );
      const data = isRecord(json.data) ? json.data : undefined;
      const id = data ? text(data.id) : undefined;
      if (!data || !id) return null;
      const a = isRecord(data.attributes) ? data.attributes : {};
      return {
        id,
        buildNumber: text(a.version) ?? null,
        processingState: text(a.processingState) ?? null,
        expired: typeof a.expired === 'boolean' ? a.expired : null,
      };
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  /** What the store holds for the wanted release fields, in the canonical text of `@mrm/core`. */
  async #readFields(
    wanted: readonly DraftFieldWrite[],
    version: VersionRef,
  ): Promise<DraftFieldState[]> {
    const out: DraftFieldState[] = [];
    let attached: AttachedBuild | null | undefined;
    for (const w of wanted) {
      switch (w.field) {
        case 'version_string':
          out.push({ field: w.field, locale: '', value: version.versionString });
          break;
        case 'release_type':
          out.push({
            field: w.field,
            locale: '',
            value: (text(version.attrs.releaseType) ?? '').toUpperCase() || null,
          });
          break;
        case 'earliest_release_date': {
          const raw = text(version.attrs.earliestReleaseDate);
          out.push({
            field: w.field,
            locale: '',
            value:
              raw === undefined || raw === ''
                ? null
                : normalizeReleaseValue('earliest_release_date', raw),
          });
          break;
        }
        case 'copyright':
          out.push({ field: w.field, locale: '', value: text(version.attrs.copyright) ?? null });
          break;
        case 'build': {
          if (attached === undefined) attached = await this.#attachedBuild(version.id);
          const facts: DraftFieldFacts = { currentNumber: attached?.buildNumber ?? null };
          if (w.value !== (attached?.id ?? '')) {
            const found = await this.#buildById(w.value);
            facts.wantedFound = found !== null;
            facts.wantedNumber = found?.buildNumber ?? null;
            facts.wantedProcessingState = found?.processingState ?? null;
            facts.wantedExpired = found?.expired ?? null;
          } else {
            facts.wantedFound = attached !== null;
            facts.wantedNumber = attached?.buildNumber ?? null;
            facts.wantedProcessingState = attached?.processingState ?? null;
            facts.wantedExpired = attached?.expired ?? null;
          }
          out.push({ field: w.field, locale: '', value: attached?.id ?? null, facts });
          break;
        }
        case 'phased_release': {
          const phased = await this.#phasedRelease(version.id);
          out.push({
            field: w.field,
            locale: '',
            value: phased ? 'on' : 'off',
            facts: {
              phasedReleaseId: phased?.id ?? null,
              phasedReleaseState: phased?.state ?? null,
            },
          });
          break;
        }
        default:
          out.push({ field: w.field, locale: w.locale, value: null });
      }
    }
    return out;
  }

  /**
   * Writes the release fields of the editable version: ONE `PATCH /v1/appStoreVersions/{id}` for the version's own fields and the
   * build (`relationships.build`, UNVERIFIED that the update request takes it; the attributes are UNVERIFIED too), then the
   * phased release (`POST /v1/appStoreVersionPhasedReleases` to switch it on, `DELETE /v1/appStoreVersionPhasedReleases/{id}` to
   * switch it off). Only what differs from the store is sent. Never retried.
   */
  async #applyFields(
    versionId: string,
    fields: readonly DraftFieldWrite[],
    current: readonly DraftFieldState[],
    at: (target: string) => void,
  ): Promise<DraftStep[]> {
    const steps: DraftStep[] = [];
    const now = (field: string) => current.find((c) => c.field === field);
    const attributes: Record<string, string> = {};
    const sent: string[] = [];
    let buildId: string | undefined;
    const done: DraftStep[] = [];
    for (const f of fields) {
      const same = now(f.field)?.value === f.value;
      if (f.field === 'phased_release') continue;
      if (f.field === 'build') {
        if (!same) buildId = f.value;
      } else {
        const name = VERSION_ATTRIBUTES[f.field];
        if (name === undefined) continue;
        if (!same) attributes[name] = f.value;
      }
      if (!same) sent.push(f.field);
      else done.push({ type: 'field', locale: '', target: f.field, outcome: 'already_same' });
    }
    if (sent.length > 0) {
      at('version');
      await this.#write('PATCH', `/v1/appStoreVersions/${enc(versionId)}`, 'changing the version', {
        data: {
          type: 'appStoreVersions',
          id: versionId,
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          ...(buildId !== undefined
            ? { relationships: { build: { data: { type: 'builds', id: buildId } } } }
            : {}),
        },
      });
      for (const field of sent)
        steps.push({ type: 'field', locale: '', target: field, outcome: 'applied' });
    }
    steps.push(...done);
    const phased = fields.find((f) => f.field === 'phased_release');
    if (phased) {
      const state = now('phased_release');
      if (state?.value === phased.value) {
        steps.push({
          type: 'field',
          locale: '',
          target: 'phased_release',
          outcome: 'already_same',
        });
      } else if (phased.value === 'on') {
        at('phased_release');
        await this.#write(
          'POST',
          '/v1/appStoreVersionPhasedReleases',
          'switching phased release on',
          {
            data: {
              type: 'appStoreVersionPhasedReleases',
              attributes: { phasedReleaseState: 'INACTIVE' },
              relationships: {
                appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
              },
            },
          },
        );
        steps.push({ type: 'field', locale: '', target: 'phased_release', outcome: 'applied' });
      } else {
        const id = state?.facts?.phasedReleaseId;
        if (typeof id !== 'string' || id === '') {
          steps.push({
            type: 'field',
            locale: '',
            target: 'phased_release',
            outcome: 'already_same',
          });
        } else {
          at('phased_release');
          await this.#write(
            'DELETE',
            `/v1/appStoreVersionPhasedReleases/${enc(id)}`,
            'switching phased release off',
            undefined,
            [404],
          );
          steps.push({ type: 'field', locale: '', target: 'phased_release', outcome: 'applied' });
        }
      }
    }
    return steps;
  }

  // -------------------------------------------------------------------------------------------
  // Release reads (StoreReleaseReader): changes nothing

  /**
   * The builds of the app for this platform, newest upload first: `GET /v1/builds?filter[app]=<id>&filter[preReleaseVersion.platform]=<IOS|MAC_OS>
   * &include=preReleaseVersion&sort=-uploadedDate`. The resource and the build attributes (`version`, `uploadedDate`,
   * `processingState`, `expired`) are Apple's (the page "List builds" is VERIFIED to exist; the filters, `sort`, `include` and the
   * attribute names are UNVERIFIED because Apple's page lists none). The platform and the version are filtered here too, from
   * the pre release version Apple includes, so a Mac build never shows in an iOS list even if a filter is ignored.
   */
  async listReleaseCandidates(input: {
    /** Not a filter: a build made as another marketing version can be attached too (see release-eligibility.ts). */
    version?: string;
    track?: string;
    /** How many of the newest builds to read (default 10, at most 200): one small page is quick. */
    limit?: number;
  }): Promise<ReleaseCandidates> {
    const pageLimit = Math.min(
      200,
      Math.max(
        1,
        Math.trunc(
          Number.isFinite(input.limit) ? (input.limit as number) : DEFAULT_BUILD_CANDIDATES,
        ),
      ),
    );
    let editable: VersionRef | undefined;
    try {
      editable = await this.#editableVersion();
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'no_editable_version') throw error;
    }
    const attached = editable ? await this.#attachedBuild(editable.id) : null;
    const what = 'listing the builds';
    // `usesNonExemptEncryption` (export compliance) is UNVERIFIED as an attribute of a build: when Apple rejects the field list the
    // read is repeated without it and the compliance of every build is `unknown`.
    const queryOf = (withCompliance: boolean) =>
      [
        `filter[app]=${enc(this.#appId)}`,
        `filter[preReleaseVersion.platform]=${this.#apple}`,
        'include=preReleaseVersion',
        'sort=-uploadedDate',
        `fields[builds]=version,uploadedDate,processingState,expired,preReleaseVersion${withCompliance ? ',usesNonExemptEncryption' : ''}`,
        'fields[preReleaseVersions]=version,platform',
        `limit=${pageLimit}`,
      ].join('&');
    let url: string | undefined = `${this.#base}/v1/builds?${queryOf(true)}`;
    let withCompliance = true;
    const builds: BuildCandidate[] = [];
    let truncatedAt: number | null = null;
    for (let page = 0; url !== undefined; page++) {
      if (page >= 1) {
        truncatedAt = builds.length;
        break;
      }
      let body: Json;
      try {
        body = (await this.#get(url, what)).json;
      } catch (error) {
        if (!withCompliance || page > 0 || !isAppleParameterError(error)) throw error;
        withCompliance = false;
        url = `${this.#base}/v1/builds?${queryOf(false)}`;
        body = (await this.#get(url, what)).json;
      }
      const pre = new Map<string, Json>();
      for (const item of records(body.included)) {
        const id = text(item.id);
        if (id && text(item.type) === 'preReleaseVersions')
          pre.set(id, isRecord(item.attributes) ? item.attributes : {});
      }
      for (const item of records(body.data)) {
        const id = text(item.id);
        if (!id) continue;
        const a = isRecord(item.attributes) ? item.attributes : {};
        const rels = isRecord(item.relationships) ? item.relationships : {};
        const rel = isRecord(rels.preReleaseVersion) ? rels.preReleaseVersion : {};
        const preId = isRecord(rel.data) ? text(rel.data.id) : undefined;
        const preAttrs = preId ? pre.get(preId) : undefined;
        const platform = preAttrs ? text(preAttrs.platform) : undefined;
        if (platform !== undefined && platform !== this.#apple) continue;
        const version = preAttrs ? (text(preAttrs.version) ?? null) : null;
        const processingState = text(a.processingState) ?? null;
        const expired = typeof a.expired === 'boolean' ? a.expired : null;
        const ready = processingState === 'VALID' && expired !== true;
        const exportCompliance: BuildCandidate['exportCompliance'] =
          !withCompliance || !('usesNonExemptEncryption' in a)
            ? 'unknown'
            : typeof a.usesNonExemptEncryption === 'boolean'
              ? 'answered'
              : 'missing';
        const isAttached = attached !== null && attached.id === id;
        const buildNumber = text(a.version) ?? null;
        builds.push({
          id,
          buildNumber,
          version,
          uploadedDate: text(a.uploadedDate) ?? null,
          processingState,
          expired,
          selectable: ready,
          reason: ready
            ? null
            : expired === true
              ? 'The build has expired.'
              : processingState === null
                ? 'Apple did not say whether the build is processed.'
                : `The build is not processed (${processingState}).`,
          attached: isAttached,
          eligibility: appleBuildEligibility(
            {
              buildNumber,
              version,
              processingState,
              expired,
              exportCompliance,
              attached: isAttached,
            },
            editable ? { versionString: editable.versionString } : null,
          ),
          exportCompliance,
          testNotes: { read: false, locales: [] },
        });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    await this.#attachTestNotes(builds);
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version: editable
        ? { id: editable.id, versionString: editable.versionString, state: editable.state }
        : null,
      builds,
      attachedBuildId: attached?.id ?? null,
      truncatedAt,
    };
  }

  /**
   * "What to Test" of the newest processed builds, `GET /v1/builds/{id}/betaBuildLocalizations`. The resource and the endpoint are
   * on Apple's pages (read 2026-11-19); the attributes `locale` and `whatsNew`, the `fields[betaBuildLocalizations]` filter and the
   * limits are UNVERIFIED. At most MAX_BUILDS_WITH_NOTES builds are read, four at a time, each failing on its own: one build that
   * cannot be read never hides the others. Every text is cut at MAX_NOTE_CHARS and every build keeps at most MAX_NOTE_LOCALES
   * languages. A note is data for a person: it is never logged and no error carries it.
   */
  async #attachTestNotes(builds: BuildCandidate[]): Promise<void> {
    const wanted = builds
      .filter((b) => b.processingState === 'VALID' && b.expired !== true)
      .slice(0, MAX_BUILDS_WITH_NOTES);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < wanted.length; i = next++) {
        const build = wanted[i] as BuildCandidate;
        build.testNotes = await this.#testNotesOf(build.id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));
  }

  async #testNotesOf(buildId: string): Promise<BuildTestNotes> {
    try {
      const url = `${this.#base}/v1/builds/${enc(buildId)}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale,whatsNew&limit=${MAX_NOTE_LOCALES + 1}`;
      const body = (await this.#get(url, 'reading the TestFlight notes of a build')).json;
      const locales: BuildTestNotes['locales'] = [];
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const locale = text(a.locale);
        const notes = text(a.whatsNew);
        if (!locale || notes === undefined || notes.trim() === '') continue;
        if (locales.length >= MAX_NOTE_LOCALES) break;
        const capped = capText(notes);
        locales.push({ locale, text: capped.text, truncated: capped.truncated });
      }
      return { read: true, locales };
    } catch (error) {
      const kind = error instanceof StoreError ? error.kind : undefined;
      return {
        read: false,
        locales: [],
        error:
          kind === 'forbidden' || kind === 'auth'
            ? 'forbidden'
            : kind === 'rate_limited'
              ? 'rate_limited'
              : kind === 'not_found'
                ? 'not_found'
                : 'unavailable',
      };
    }
  }

  /**
   * What earlier versions of the app said was new, newest first (`StoreNotesHistoryReader`): the versions of this platform from
   * `GET /v1/apps/{id}/appStoreVersions` and the localizations of the newest ones. The attribute `createdDate` of a version (used
   * for the date and the order) is UNVERIFIED; without it the order is the version string, newest first, and `at` is null. At most
   * MAX_NOTES_HISTORY_VERSIONS versions are read, four at a time. A version that cannot be read is skipped and counted in `failed`;
   * when none can be read the first error is thrown. Texts are cut at MAX_NOTE_CHARS and are never logged.
   */
  async readNotesHistory(
    input: { locale?: string; maxVersions?: number } = {},
  ): Promise<NotesHistoryRead> {
    const what = 'listing the versions of the app';
    const limit = Math.min(
      Math.max(Math.trunc(input.maxVersions ?? MAX_NOTES_HISTORY_VERSIONS), 1),
      MAX_NOTES_HISTORY_VERSIONS,
    );
    const wantedLocale =
      input.locale === undefined || input.locale === ''
        ? undefined
        : input.locale.toLowerCase().replace(/_/g, '-');
    type Listed = { id: string; version: string | null; state: string | null; at: number | null };
    const listed: Listed[] = [];
    let url: string | undefined =
      `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        if (!id || text(a.platform) !== this.#apple) continue;
        const created = text(a.createdDate);
        const at = created === undefined ? NaN : Date.parse(created);
        listed.push({
          id,
          version: text(a.versionString) ?? null,
          state: (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase() || null,
          at: Number.isFinite(at) ? at : null,
        });
      }
      const links = isRecord(body.links) ? body.links : {};
      const nextLink = text(links.next);
      url = nextLink === undefined ? undefined : this.#checkNext(nextLink, what);
    }
    listed.sort(
      (a, b) =>
        (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY) ||
        (b.version ?? '').localeCompare(a.version ?? '', 'en', { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
    const chosen = listed.slice(0, limit);
    const perVersion: (NotesHistoryEntry[] | Error)[] = new Array(chosen.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < chosen.length; i = next++) {
        const v = chosen[i] as Listed;
        try {
          const out: NotesHistoryEntry[] = [];
          const locs = await this.#localizations(v.id);
          for (const [locale, ref] of locs) {
            if (
              wantedLocale !== undefined &&
              locale.toLowerCase().replace(/_/g, '-') !== wantedLocale
            )
              continue;
            const notes = text(ref.attributes.whatsNew);
            if (notes === undefined || notes.trim() === '') continue;
            const capped = capText(notes);
            out.push({
              source: 'appstoreconnect',
              locale,
              text: capped.text,
              truncated: capped.truncated,
              version: v.version,
              track: null,
              state: v.state,
              at: v.at,
            });
          }
          perVersion[i] = out;
        } catch (error) {
          perVersion[i] = error instanceof Error ? error : new Error('unexpected');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, chosen.length) }, worker));
    const failures = perVersion.filter((r): r is Error => r instanceof Error);
    if (chosen.length > 0 && failures.length === chosen.length) throw failures[0];
    return {
      entries: perVersion.flatMap((r) => (r instanceof Error ? [] : r)),
      truncated: listed.length > chosen.length,
      versionsRead: chosen.length - failures.length,
      failed: failures.length,
    };
  }

  /** The release fields of the editable version (a refusal `no_editable_version` when there is none). */
  async readEditableRelease(): Promise<EditableRelease> {
    const version = await this.#editableVersion();
    const [build, phased, locs] = await Promise.all([
      this.#attachedBuild(version.id),
      this.#phasedRelease(version.id),
      this.#localizations(version.id),
    ]);
    const earliest = text(version.attrs.earliestReleaseDate);
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version: {
        id: version.id,
        versionString: version.versionString,
        state: version.state,
        editable: true,
      },
      releaseType: (text(version.attrs.releaseType) ?? '').toUpperCase() || null,
      earliestReleaseDate:
        earliest === undefined || earliest === ''
          ? null
          : normalizeReleaseValue('earliest_release_date', earliest),
      copyright: text(version.attrs.copyright) ?? null,
      build,
      phasedRelease: phased,
      releaseNotes: [...locs].flatMap(([locale, ref]) => {
        const notes = text(ref.attributes.whatsNew);
        return notes === undefined ? [] : [{ locale, text: notes }];
      }),
    };
  }

  /** The screenshot placements of a localization, in display order, each with its library image. */
  async #placements(localizationId: string): Promise<PlacementRef[]> {
    const what = 'reading the screenshot placements';
    const query =
      'filter[placementType]=APP_SCREENSHOT&sort=placementGroupPosition&include=image&limit=200&fields[appAssetLibraryImages]=fileName,referenceName,state,specId,fileSize,category,imageAsset';
    let url: string | undefined =
      `${this.#base}/v1/appStoreVersionLocalizations/${enc(localizationId)}/placements?${query}`;
    const out: PlacementRef[] = [];
    const images = new Map<string, Json>();
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.included)) {
        const id = text(item.id);
        if (id && text(item.type) === 'appAssetLibraryImages') images.set(id, item);
      }
      for (const item of records(body.data)) {
        const id = text(item.id);
        const a = isRecord(item.attributes) ? item.attributes : {};
        const group = text(a.placementGroup);
        if (!id || !group || (text(a.placementType) ?? 'APP_SCREENSHOT') !== 'APP_SCREENSHOT')
          continue;
        const rels = isRecord(item.relationships) ? item.relationships : {};
        const rel = isRecord(rels.image) ? rels.image : {};
        const imageId = isRecord(rel.data) ? text(rel.data.id) : undefined;
        out.push({
          id,
          group,
          imageId: imageId ?? null,
          image: (imageId ? images.get(imageId) : undefined) ?? {},
        });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    // `included` may come on a later page than the placement that points at it.
    for (const p of out)
      if (p.imageId && Object.keys(p.image).length === 0) p.image = images.get(p.imageId) ?? {};
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // The asset library: reference data, the library, placement groups

  async #libraryId(): Promise<string> {
    if (this.#library) return this.#library;
    const body = (
      await this.#get(
        `${this.#base}/v1/apps/${enc(this.#appId)}/assetLibrary`,
        'reading the app asset library',
      )
    ).json;
    const id = isRecord(body.data) ? text(body.data.id) : undefined;
    if (!id)
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'App Store Connect sent no asset library for this app.',
      );
    this.#library = id;
    return id;
  }

  async #refData(): Promise<RefData> {
    if (this.#ref) return this.#ref;
    const what = 'reading the asset library reference data';
    const fields = 'features,placementProfileGroups,imageSpecs,placementTypes,displayClasses';
    const body = (
      await this.#get(
        `${this.#base}/v1/appAssetLibraryRefData?fields[appAssetLibraryRefData]=${fields}`,
        what,
      )
    ).json;
    const first = records(body.data)[0];
    const a = first && isRecord(first.attributes) ? first.attributes : undefined;
    if (!a)
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'App Store Connect sent no asset library reference data.',
      );
    const specs = new Map<string, Dims>();
    for (const spec of records(a.imageSpecs)) {
      const id = text(spec.specId);
      const d = isRecord(spec.dimensions) ? spec.dimensions : {};
      const dims = {
        minWidth: num(d.minWidth),
        maxWidth: num(d.maxWidth),
        minHeight: num(d.minHeight),
        maxHeight: num(d.maxHeight),
      };
      if (
        id &&
        dims.minWidth !== undefined &&
        dims.maxWidth !== undefined &&
        dims.minHeight !== undefined &&
        dims.maxHeight !== undefined
      ) {
        specs.set(id, {
          minWidth: dims.minWidth,
          maxWidth: dims.maxWidth,
          minHeight: dims.minHeight,
          maxHeight: dims.maxHeight,
        });
      }
    }
    const screenshotSpecs = new Map<string, Set<string>>();
    for (const type of records(a.placementTypes)) {
      if (text(type.placementTypeId) !== 'APP_SCREENSHOT') continue;
      for (const mapping of records(type.specMappings)) {
        const group = text(mapping.placementGroupId);
        if (!group) continue;
        const ids = Array.isArray(mapping.specs)
          ? mapping.specs.filter((x): x is string => typeof x === 'string')
          : [];
        screenshotSpecs.set(group, new Set([...(screenshotSpecs.get(group) ?? []), ...ids]));
      }
    }
    const groups = new Map<string, { platform: string | null; displayClass: string | null }>();
    for (const g of records(a.placementProfileGroups)) {
      const id = text(g.placementProfileGroupId);
      if (id)
        groups.set(id, {
          platform: text(g.platform) ?? null,
          displayClass: text(g.displayClassId) ?? null,
        });
    }
    const displayClasses = new Map<string, { family: string | null; screens: string[] }>();
    for (const d of records(a.displayClasses)) {
      const id = text(d.displayClassId);
      if (id) {
        const screens = Array.isArray(d.screenDimensions)
          ? d.screenDimensions.filter((x): x is string => typeof x === 'string')
          : [];
        displayClasses.set(id, { family: text(d.deviceFamily) ?? null, screens });
      }
    }
    const maxCount = new Map<string, number>();
    for (const feature of records(a.features)) {
      if (text(feature.featureId) !== 'APP_STORE_VERSIONS') continue;
      for (const policy of records(feature.placementPolicies)) {
        if (text(policy.placementType) !== 'APP_SCREENSHOT') continue;
        for (const limit of records(policy.groupLimits)) {
          const max = num(limit.maxCount);
          if (max === undefined || !Array.isArray(limit.groupIds)) continue;
          for (const id of limit.groupIds) if (typeof id === 'string') maxCount.set(id, max);
        }
      }
    }
    if (screenshotSpecs.size === 0) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'The App Store Connect reference data lists no screenshot placement groups, so this server cannot place a screenshot.',
      );
    }
    this.#ref = { screenshotSpecs, specs, groups, displayClasses, maxCount };
    return this.#ref;
  }

  /**
   * The placement group a set belongs to: the groups whose screenshot specs have exactly the size of its files, narrowed
   * by the device family and then the screen size when several do. Never a guess: no group, or no single group, is a
   * refusal that names the size.
   */
  async #groupFor(
    slot: Pick<DraftSlot, 'device' | 'width' | 'height' | 'target'>,
  ): Promise<string> {
    const ref = await this.#refData();
    const w = slot.width ?? null;
    const h = slot.height ?? null;
    if (w === null || h === null) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `The size of the files of the ${slot.target} set is not known, so its App Store placement group cannot be found.`,
      );
    }
    let found = [...ref.screenshotSpecs]
      .filter(([, ids]) =>
        [...ids].some((id) => {
          const d = ref.specs.get(id);
          return (
            d !== undefined &&
            w >= d.minWidth &&
            w <= d.maxWidth &&
            h >= d.minHeight &&
            h <= d.maxHeight
          );
        }),
      )
      .map(([group]) => group);
    const describe = () => `${w}x${h}`;
    if (found.length === 0) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `App Store Connect's reference data has no screenshot placement group for ${describe()} pixels.`,
      );
    }
    if (found.length > 1) {
      const family = familyOf(slot.device);
      const info = (g: string) => {
        const group = ref.groups.get(g);
        return {
          platform: group?.platform ?? '',
          display: (group?.displayClass
            ? ref.displayClasses.get(group.displayClass)
            : undefined) ?? { family: null, screens: [] },
        };
      };
      if (family) {
        const narrowed = found.filter((g) => {
          const i = info(g);
          return `${i.platform} ${i.display.family ?? ''}`.toUpperCase().includes(family);
        });
        if (narrowed.length > 0) found = narrowed;
      }
      const screen = screenOf(slot.device);
      if (found.length > 1 && screen) {
        const narrowed = found.filter((g) => info(g).display.screens.includes(screen));
        if (narrowed.length > 0) found = narrowed;
      }
    }
    if (found.length !== 1) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `More than one App Store placement group takes ${describe()} pixel screenshots (${found.slice(0, 4).join(', ')}), so this server will not guess. Place this set in App Store Connect.`,
      );
    }
    return found[0] as string;
  }

  // -------------------------------------------------------------------------------------------
  // Replacing a set of screenshots

  async #replaceSet(
    localizationId: string,
    write: DraftAssetWrite,
    group: string,
    state: DraftAssetState | undefined,
    existing: PlacementRef[],
  ): Promise<DraftStep> {
    const base = { type: 'asset' as const, locale: write.locale, target: write.target };
    if (state?.setExists && setMatches(state.images, write.files))
      return { ...base, outcome: 'already_same' };
    const ref = await this.#refData();
    const max = ref.maxCount.get(group) ?? MAX_SET_FILES;
    if (write.files.length > max) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `The ${write.target} set of ${write.locale} has ${write.files.length} files; the group takes at most ${max}.`,
      );
    }

    // 1. Which placements already show a wanted file, in which place.
    const pool = existing.map((p) => ({
      p,
      hash: hashOfReference(
        text((isRecord(p.image.attributes) ? p.image.attributes : {}).referenceName),
      ),
      used: false,
    }));
    const plan = write.files.map((file) => {
      const wanted = file.sha256.slice(0, REFERENCE_HEX);
      const hit = pool.find(
        (e) =>
          !e.used &&
          e.hash === wanted &&
          text((isRecord(e.p.image.attributes) ? e.p.image.attributes : {}).state) !== 'FAILED',
      );
      if (hit) hit.used = true;
      return {
        file,
        placementId: hit?.p.id as string | undefined,
        imageId: undefined as string | undefined,
      };
    });
    // 2. Images first: nothing visible changes until a placement is made.
    let uploaded = 0;
    for (const item of plan) {
      if (item.placementId) continue;
      item.imageId = await this.#libraryImage(item.file, group, ref);
      if (item.imageId === undefined) {
        item.imageId = await this.#upload(item.file, group, ref);
        uploaded++;
      }
    }
    // 3. Placements: new ones before the old are deleted when the group has room for both.
    const stale = pool.filter((e) => !e.used).map((e) => e.p.id);
    const fresh = plan.filter((p) => !p.placementId).length;
    const kept = plan.length - fresh;
    const roomForBoth = kept + stale.length + fresh <= max;
    let removed = 0;
    const removeStale = async () => {
      for (const id of stale) {
        await this.#write(
          'DELETE',
          `/v1/appAssetLibraryPlacements/${enc(id)}`,
          'removing a screenshot placement of the draft',
          undefined,
          [404],
        );
        removed++;
      }
    };
    if (!roomForBoth) await removeStale();
    for (const item of plan) {
      if (item.placementId) continue;
      const created = await this.#write(
        'POST',
        '/v1/appAssetLibraryPlacements',
        `placing ${item.file.name}`,
        {
          data: {
            type: 'appAssetLibraryPlacements',
            attributes: { placementType: 'APP_SCREENSHOT', placementGroup: group },
            relationships: {
              image: { data: { type: 'appAssetLibraryImages', id: item.imageId } },
              appStoreVersionLocalization: {
                data: { type: 'appStoreVersionLocalizations', id: localizationId },
              },
            },
          },
        },
      );
      const id = idOf(created);
      if (!id)
        throw new StoreError(
          'appstoreconnect',
          'unexpected',
          `App Store Connect placed ${item.file.name} but sent no placement id.`,
          created.status,
        );
      item.placementId = id;
    }
    if (roomForBoth) await removeStale();
    // 4. The order: only when it is not already the wanted one.
    // New placements are appended in the order they were made, so the group is already in order when the kept
    // placements come first, in their own order, and the new ones follow in the wanted order.
    const wantedOrder = plan.map((p) => p.placementId as string);
    const keptIds = new Set(
      plan.filter((p) => existing.some((e) => e.id === p.placementId)).map((p) => p.placementId),
    );
    const resulting = [
      ...existing.filter((p) => keptIds.has(p.id)).map((p) => p.id),
      ...plan.filter((p) => !keptIds.has(p.placementId)).map((p) => p.placementId as string),
    ];
    const inOrder =
      resulting.length === wantedOrder.length && resulting.every((id, i) => id === wantedOrder[i]);
    if (!inOrder && wantedOrder.length > 0) {
      await this.#write(
        'POST',
        '/v1/appAssetLibraryPlacementOrderingRequests',
        'ordering the screenshots',
        {
          data: {
            type: 'appAssetLibraryPlacementOrderingRequests',
            attributes: { placementGroup: group },
            relationships: {
              orderedPlacements: {
                data: wantedOrder.map((id) => ({ type: 'appAssetLibraryPlacements', id })),
              },
              appStoreVersionLocalization: {
                data: { type: 'appStoreVersionLocalizations', id: localizationId },
              },
            },
          },
        },
      );
    }
    return { ...base, outcome: 'applied', uploaded, removed };
  }

  /** An image of the library that already is this file and is processed, or undefined. A failed lookup is just "not found". */
  async #libraryImage(
    file: DraftAssetWrite['files'][number],
    group: string,
    ref: RefData,
  ): Promise<string | undefined> {
    const library = await this.#libraryId();
    const name = referenceName(file.sha256);
    let body: Json;
    try {
      body = (
        await this.#get(
          `${this.#base}/v1/appAssetLibraries/${enc(library)}/images?filter[referenceName]=${encodeURIComponent(name)}&limit=20&fields[appAssetLibraryImages]=fileName,fileSize,referenceName,state,specId,category`,
          `looking for ${file.name} in the asset library`,
        )
      ).json;
    } catch (error) {
      if (
        error instanceof StoreError &&
        error.kind !== 'network' &&
        error.kind !== 'server' &&
        error.kind !== 'rate_limited' &&
        error.kind !== 'auth' &&
        error.kind !== 'forbidden'
      )
        return undefined;
      throw error;
    }
    const accepted = ref.screenshotSpecs.get(group) ?? new Set<string>();
    for (const item of records(body.data)) {
      const a = isRecord(item.attributes) ? item.attributes : {};
      const id = text(item.id);
      const specId = text(a.specId);
      if (!id || text(a.referenceName) !== name || a.fileSize !== file.bytes.length) continue;
      if (
        !DRAFT_IMAGE_READY_STATES.includes(text(a.state) ?? '') ||
        (text(a.category) ?? 'APP_SCREENSHOTS_AND_PREVIEWS') !== 'APP_SCREENSHOTS_AND_PREVIEWS'
      )
        continue;
      if (specId === undefined || !accepted.has(specId)) continue;
      return id;
    }
    return undefined;
  }

  /** Reserve, upload every part, commit, wait until Apple has processed it. Returns the library image id. */
  async #upload(
    file: DraftAssetWrite['files'][number],
    group: string,
    ref: RefData,
  ): Promise<string> {
    const what = `uploading ${file.name}`;
    const library = await this.#libraryId();
    const reserved = await this.#write(
      'POST',
      '/v1/appAssetLibraryImages',
      `reserving the upload of ${file.name}`,
      {
        data: {
          type: 'appAssetLibraryImages',
          attributes: {
            fileName: file.name,
            fileSize: file.bytes.length,
            category: 'APP_SCREENSHOTS_AND_PREVIEWS',
            referenceName: referenceName(file.sha256),
          },
          relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: library } } },
        },
      },
    );
    const id = idOf(reserved);
    const data = isRecord(reserved.json) && isRecord(reserved.json.data) ? reserved.json.data : {};
    const attributes = isRecord(data.attributes) ? data.attributes : {};
    const operations = records(attributes.uploadOperations);
    if (!id || operations.length === 0) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `App Store Connect reserved ${file.name} but sent no upload instructions.`,
        reserved.status,
      );
    }
    for (const op of operations) await this.#putPart(op, file.bytes, what);
    await this.#write('PATCH', `/v1/appAssetLibraryImages/${enc(id)}`, `committing ${file.name}`, {
      data: { type: 'appAssetLibraryImages', id, attributes: { uploaded: true } },
    });
    const specId = await this.#waitProcessed(id, file.name);
    if (
      specId === undefined ||
      !(ref.screenshotSpecs.get(group) ?? new Set<string>()).has(specId)
    ) {
      await this.#discard(id, file.name);
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        `App Store Connect matched ${file.name} to a specification that the ${group} placement group does not take (${specId === undefined ? 'none' : `spec ${specId}`}). Check the size of the file.`,
      );
    }
    return id;
  }

  /** Removes an image THIS connector made and could not use: it has no placements, so the delete is safe. */
  async #discard(id: string, name: string): Promise<void> {
    try {
      await this.#write(
        'DELETE',
        `/v1/appAssetLibraryImages/${enc(id)}`,
        `removing the unusable ${name}`,
        undefined,
        [404],
      );
    } catch {
      // An unused image in the library is harmless; the next push finds or replaces it.
    }
  }

  async #putPart(op: Json, bytes: Uint8Array, what: string): Promise<void> {
    const method = (text(op.method) ?? 'PUT').toUpperCase();
    const offset = typeof op.offset === 'number' ? op.offset : 0;
    const length = typeof op.length === 'number' ? op.length : bytes.length;
    const url = text(op.url);
    let target: URL | undefined;
    try {
      target = url ? new URL(url) : undefined;
    } catch {
      target = undefined;
    }
    if (target?.protocol !== 'https:' || !UPLOAD_HOST.test(target.hostname)) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `Apple sent an upload address that is not an https address of apple.com while ${what}. Nothing was sent to it.`,
      );
    }
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `Apple asked for a byte range outside the file while ${what}.`,
      );
    }
    // The headers are Apple's, to be sent as given; the content type goes in its own field.
    let contentType = 'application/octet-stream';
    const headers: Record<string, string> = {};
    for (const h of records(op.requestHeaders)) {
      const name = text(h.name);
      const value = text(h.value);
      if (!name || value === undefined) continue;
      if (name.toLowerCase() === 'content-type') contentType = value;
      else headers[name.toLowerCase()] = value;
    }
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, target.toString(), {
        headers,
        raw: { body: bytes.subarray(offset, offset + length), contentType },
      });
    } catch (error) {
      if (error instanceof StoreError)
        throw new StoreError(
          'appstoreconnect',
          error.kind,
          `The upload of a part failed while ${what}: ${error.message}`,
          error.status,
        );
      throw error;
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new StoreError(
        'appstoreconnect',
        reply.status >= 500 ? 'server' : 'unexpected',
        `Apple's upload server answered HTTP ${reply.status} while ${what}.`,
        reply.status,
      );
    }
  }

  /** Polls until the image is processed. Returns the specification Apple matched. */
  async #waitProcessed(id: string, name: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < this.#maxPolls; attempt++) {
      const body = (
        await this.#get(
          `${this.#base}/v1/appAssetLibraryImages/${enc(id)}?fields[appAssetLibraryImages]=state,stateDetails,specId,fileName`,
          `checking ${name}`,
        )
      ).json;
      const data = isRecord(body.data) ? body.data : {};
      const a = isRecord(data.attributes) ? data.attributes : {};
      const state = text(a.state);
      if (state !== undefined && DRAFT_IMAGE_READY_STATES.includes(state)) return text(a.specId);
      if (state === 'FAILED') {
        const details = isRecord(a.stateDetails)
          ? (text(a.stateDetails.description) ??
            text(a.stateDetails.message) ??
            text(a.stateDetails.code))
          : text(a.stateDetails);
        await this.#discard(id, name);
        throw new StoreError(
          'appstoreconnect',
          'invalid_input',
          `App Store Connect rejected ${name} while processing it (${this.#http.redact(details ?? 'no reason given')}).`,
        );
      }
      await this.#sleep(this.#pollMs);
    }
    throw new StoreError(
      'appstoreconnect',
      'server',
      `App Store Connect had not finished processing ${name} after ${this.#maxPolls} checks. It stays in the asset library without a placement; push again to use it.`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

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
      return { json: reply.json };
    }
    throw this.#fail(reply, what);
  }

  /** One write. No retries. A lost answer or a 5xx is `DraftOutcomeUnknownError`; a 4xx is a refusal. `okStatuses` are extra statuses that count as done (a 404 on a delete). */
  async #write(
    method: string,
    path: string,
    what: string,
    json?: unknown,
    okStatuses: number[] = [],
  ): Promise<StoreReply> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, `${this.#base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
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
    if ((reply.status >= 200 && reply.status < 300) || okStatuses.includes(reply.status))
      return reply;
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
        'Apple refused the change (403). The key may not be allowed to edit the app listing (an App Manager or Admin key is assumed to be needed, UNVERIFIED). See docs/credentials.md.',
        403,
        error.details,
      );
    }
    throw error;
  }

  /** A paging link is followed only when it stays on the API host: the token is sent nowhere else. */
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
