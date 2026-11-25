import { StoreError } from '../errors.ts';
import {
  appleExperimentState,
  currentCustomPageVersion,
  emptyAssetCounts,
  type ListExperimentsResult,
  type StoreAssetCounts,
  type StoreCustomPage,
  type StoreCustomPageVersion,
  type StoreExperiment,
  type StoreExperimentLocale,
  type StoreExperimentsConnector,
  type StoreExperimentTreatment,
} from '../store-experiments-types.ts';
import { isRecord, type Json, records, type StoreHttpOptions, text } from '../store-http.ts';
import { mapLimit } from './appstore-products.ts';
import { AppleProductsHttp, seg } from './appstore-products-http.ts';

/**
 * App Store Connect: Product Page Optimization experiments and custom product pages, READ ONLY (docs/spikes/store-experiments.md has every
 * source). Endpoints, checked on Apple's pages (the JSON behind developer.apple.com/documentation, 2026-11-22); the pages list parameters,
 * allowed values and schema names, and the attributes of each object, but never a real response, so what a response looks like is UNVERIFIED:
 *
 * - `GET /v1/apps/{id}/appStoreVersionExperimentsV2` with `include=appStoreVersionExperimentTreatments`, `limit` (max 200),
 *   `limit[appStoreVersionExperimentTreatments]` (max 50). Attributes `name`, `platform`, `trafficProportion`, `state` (nine values),
 *   `reviewRequired`, `startDate`, `endDate`. The v1 experiment endpoints are deprecated (API 2.4) and are not used.
 * - `GET /v2/appStoreVersionExperiments/{id}/appStoreVersionExperimentTreatments` when the list carried no treatment linkage. Treatment
 *   attributes `name`, `appIconName`, `promotedDate`.
 * - `GET /v1/appStoreVersionExperimentTreatments/{id}/appStoreVersionExperimentTreatmentLocalizations` with `include=placements,appScreenshotSets`
 *   (limits max 50): the locales of a treatment (`locale`) and its media as asset-library placements (`placementType`: `APP_SCREENSHOT`,
 *   `APP_PREVIEW`, ...). Apple deprecated the screenshot-set endpoints in favour of the App Asset Library, so sets are only counted when they
 *   come along.
 * - `GET /v1/apps/{id}/appCustomProductPages` with `include=appCustomProductPageVersions` (`limit[...]` max 50): `name`, `url`, `visible`;
 *   versions `version`, `state` (eight values), `deepLink`.
 * - `GET /v1/appCustomProductPageVersions/{id}/appCustomProductPageLocalizations` with the same includes: `locale`, `promotionalText`.
 *
 * Results (impressions, conversion, confidence) are NOT in the API: there is no endpoint for them on Apple's pages. They are not read.
 *
 * A part Apple refuses (403: the key's role, 404: the app is not live) is a warning and an empty part, never a failed read, unless both parts are
 * refused (then the error is thrown, so a wrong key is said). Any other failure fails the whole read: a half-read answer never replaces a good
 * copy. The read is capped (`maxItems`) and says so.
 */

export type AppleExperimentsConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: import('./apple-auth.ts').AppStoreConnectKey;
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** `macos` keeps the experiments of the Mac platform and reads no custom product pages (they are for iPhone and iPad). Default `ios`. */
  scope?: 'ios' | 'macos';
  apiBase?: string;
  /** Most experiments, and most custom pages, read. Default 100. */
  maxItems?: number;
  maxPages?: number;
  concurrency?: number;
};

const dateMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};
const attrs = (r: Json): Json => (isRecord(r.attributes) ? r.attributes : {});
const id = (r: Json): string => text(r.id) ?? '';

/** The ids a relationship names (`relationships.<name>.data`), or undefined when the answer carried no linkage for it. */
export function linkedIds(resource: Json, name: string): string[] | undefined {
  const rels = isRecord(resource.relationships) ? resource.relationships : {};
  const rel = rels[name];
  if (!isRecord(rel) || !('data' in rel)) return undefined;
  const data = rel.data;
  if (data === null) return [];
  if (isRecord(data)) return [text(data.id) ?? ''].filter(Boolean);
  return records(data)
    .map((d) => text(d.id) ?? '')
    .filter(Boolean);
}

/** The media of a localization as counts, from the placements (and sets) the answer included for it. */
export function assetCounts(localization: Json, byId: ReadonlyMap<string, Json>): StoreAssetCounts {
  const counts = emptyAssetCounts();
  for (const placementId of linkedIds(localization, 'placements') ?? []) {
    const type = (text(attrs(byId.get(placementId) ?? {}).placementType) ?? '').toUpperCase();
    if (type === 'APP_SCREENSHOT' || type === 'IMESSAGE_APP_SCREENSHOT') counts.screenshots++;
    else if (type === 'APP_PREVIEW') counts.previews++;
    else counts.other++;
  }
  counts.screenshotSets = (linkedIds(localization, 'appScreenshotSets') ?? []).length;
  return counts;
}

const refused = (error: unknown): error is StoreError =>
  error instanceof StoreError && (error.kind === 'forbidden' || error.kind === 'not_found');

const MEDIA_INCLUDE =
  'include=placements,appScreenshotSets&limit=200&limit[placements]=50&limit[appScreenshotSets]=50&fields[appAssetLibraryPlacements]=placementType,mediaType,state';

export class AppleExperimentsConnector implements StoreExperimentsConnector {
  readonly store = 'appstoreconnect' as const;
  readonly #api: AppleProductsHttp;
  readonly #app: string;
  readonly #scope: 'ios' | 'macos';
  readonly #maxItems: number;
  readonly #maxPages: number;
  readonly #concurrency: number;

  constructor(options: AppleExperimentsConnectorOptions) {
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
    this.#maxItems = Math.max(1, options.maxItems ?? 100);
    this.#maxPages = Math.max(1, options.maxPages ?? 5);
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
  }

  /** Builds a connector from the stored secret (core `buildSecret` JSON for `app_store_connect`). */
  static fromSecret(
    secret: string,
    options: Omit<AppleExperimentsConnectorOptions, 'credential'>,
  ): AppleExperimentsConnector {
    return new AppleExperimentsConnector({
      ...options,
      credential: AppleProductsHttp.credentialOf(secret),
    });
  }

  async listExperiments(): Promise<ListExperimentsResult> {
    const warnings: string[] = [];
    let complete = true;
    const result: ListExperimentsResult = {
      experiments: [],
      customPages: [],
      complete,
      warnings,
      experimentsRead: false,
      customPagesRead: false,
    };
    let firstRefusal: StoreError | undefined;
    let refusals = 0;

    try {
      const read = await this.#experiments();
      result.experiments = read.items;
      result.experimentsRead = true;
      if (read.truncated) complete = false;
      warnings.push(...read.warnings);
    } catch (error) {
      if (!refused(error)) throw error;
      firstRefusal ??= error;
      refusals++;
      warnings.push(
        'App Store Connect did not give the experiments of this app (the key may lack access, or the app is not live yet).',
      );
    }

    if (this.#scope === 'macos') {
      // Custom product pages are for iPhone and iPad: nothing to read, and not a refusal.
      result.customPagesRead = true;
      refusals = 0;
    } else {
      try {
        const read = await this.#customPages();
        result.customPages = read.items;
        result.customPagesRead = true;
        if (read.truncated) complete = false;
        warnings.push(...read.warnings);
      } catch (error) {
        if (!refused(error)) throw error;
        firstRefusal ??= error;
        refusals++;
        warnings.push(
          'App Store Connect did not give the custom product pages of this app (the key may lack access, or the app is not live yet).',
        );
      }
      if (refusals < 2) firstRefusal = undefined;
    }
    if (firstRefusal && refusals >= 2) throw firstRefusal;
    result.complete = complete;
    return result;
  }

  async #experiments(): Promise<{
    items: StoreExperiment[];
    truncated: boolean;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const list = await this.#api.list(
      `/v1/apps/${seg(this.#app)}/appStoreVersionExperimentsV2?limit=200&include=appStoreVersionExperimentTreatments&limit[appStoreVersionExperimentTreatments]=50`,
      'reading the product page experiments',
      { maxPages: this.#maxPages },
    );
    const included = new Map<string, Json>(list.included.map((r) => [id(r), r]));
    let rows = list.data.filter((r) => id(r) !== '');
    // The platform is an attribute: an experiment of another platform is not this app record's. One with no platform is kept.
    const wanted = this.#scope === 'macos' ? 'MAC_OS' : 'IOS';
    rows = rows.filter((r) => {
      const p = (text(attrs(r).platform) ?? '').toUpperCase();
      return p === '' || p === wanted;
    });
    let truncated = list.truncated;
    if (rows.length > this.#maxItems) {
      rows = rows.slice(0, this.#maxItems);
      truncated = true;
    }
    if (truncated) {
      warnings.push(
        'The list of experiments was cut at its limit: the store may have more than is shown.',
      );
    }

    const items = await mapLimit(rows, this.#concurrency, async (row) => {
      let treatmentRows: Json[];
      const ids = linkedIds(row, 'appStoreVersionExperimentTreatments');
      if (ids !== undefined) {
        treatmentRows = ids.map((i) => included.get(i)).filter((r): r is Json => r !== undefined);
        // Linked but not included (the include was ignored): read them.
        if (treatmentRows.length < ids.length) treatmentRows = await this.#treatmentsOf(id(row));
      } else {
        treatmentRows = await this.#treatmentsOf(id(row));
      }
      const treatments: StoreExperimentTreatment[] = [];
      for (const t of treatmentRows) {
        const a = attrs(t);
        treatments.push({
          id: id(t),
          name: text(a.name) ?? '',
          iconName: text(a.appIconName) ?? null,
          promotedAt: dateMs(a.promotedDate),
          locales: await this.#locales(
            `/v1/appStoreVersionExperimentTreatments/${seg(id(t))}/appStoreVersionExperimentTreatmentLocalizations?${MEDIA_INCLUDE}`,
            'reading the locales of a treatment',
            false,
          ),
        });
      }
      const a = attrs(row);
      const raw = text(a.state) ?? null;
      const experiment: StoreExperiment = {
        id: id(row),
        name: text(a.name) ?? '',
        platform: text(a.platform) ?? null,
        state: appleExperimentState(raw ?? undefined),
        rawState: raw,
        trafficProportion: typeof a.trafficProportion === 'number' ? a.trafficProportion : null,
        reviewRequired: typeof a.reviewRequired === 'boolean' ? a.reviewRequired : null,
        startedAt: dateMs(a.startDate),
        endedAt: dateMs(a.endDate),
        treatments,
      };
      return experiment;
    });
    return { items, truncated, warnings };
  }

  async #treatmentsOf(experimentId: string): Promise<Json[]> {
    const read = await this.#api.list(
      `/v2/appStoreVersionExperiments/${seg(experimentId)}/appStoreVersionExperimentTreatments?limit=50`,
      'reading the treatments of an experiment',
      { maxPages: this.#maxPages, optional: true },
    );
    return read.data.filter((r) => id(r) !== '');
  }

  /** The localizations at `path` with their media counted. A 404 is no locales. */
  async #locales(
    path: string,
    what: string,
    withPromotionalText: boolean,
  ): Promise<StoreExperimentLocale[]> {
    const read = await this.#api.list(path, what, { maxPages: this.#maxPages, optional: true });
    const byId = new Map<string, Json>(read.included.map((r) => [id(r), r]));
    return read.data
      .filter((r) => id(r) !== '' && text(attrs(r).locale) !== undefined)
      .map((r) => ({
        locale: text(attrs(r).locale) ?? '',
        ref: id(r),
        assets: assetCounts(r, byId),
        hasPromotionalText: withPromotionalText
          ? (text(attrs(r).promotionalText) ?? '').trim() !== ''
          : null,
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale));
  }

  async #customPages(): Promise<{
    items: StoreCustomPage[];
    truncated: boolean;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const list = await this.#api.list(
      `/v1/apps/${seg(this.#app)}/appCustomProductPages?limit=200&include=appCustomProductPageVersions&limit[appCustomProductPageVersions]=50`,
      'reading the custom product pages',
      { maxPages: this.#maxPages },
    );
    const included = new Map<string, Json>(list.included.map((r) => [id(r), r]));
    let rows = list.data.filter((r) => id(r) !== '');
    let truncated = list.truncated;
    if (rows.length > this.#maxItems) {
      rows = rows.slice(0, this.#maxItems);
      truncated = true;
    }
    if (truncated) {
      warnings.push(
        'The list of custom product pages was cut at its limit: the store may have more than is shown.',
      );
    }
    const items = await mapLimit(rows, this.#concurrency, async (row) => {
      let versionRows: Json[];
      const ids = linkedIds(row, 'appCustomProductPageVersions');
      if (ids !== undefined) {
        versionRows = ids.map((i) => included.get(i)).filter((r): r is Json => r !== undefined);
        if (versionRows.length < ids.length) versionRows = await this.#versionsOf(id(row));
      } else {
        versionRows = await this.#versionsOf(id(row));
      }
      const versions: StoreCustomPageVersion[] = versionRows.map((v) => {
        const a = attrs(v);
        const raw = text(a.state) ?? null;
        return {
          id: id(v),
          version: text(a.version) ?? null,
          state: appleExperimentState(raw ?? undefined),
          rawState: raw,
          deepLink: text(a.deepLink) ?? null,
        };
      });
      const current = currentCustomPageVersion(versions);
      const a = attrs(row);
      const page: StoreCustomPage = {
        id: id(row),
        name: text(a.name) ?? '',
        visible: typeof a.visible === 'boolean' ? a.visible : null,
        url: text(a.url) ?? null,
        state: current?.state ?? 'unknown',
        rawState: current?.rawState ?? null,
        deepLink: current?.deepLink ?? null,
        versions,
        locales: current
          ? await this.#locales(
              `/v1/appCustomProductPageVersions/${seg(current.id)}/appCustomProductPageLocalizations?${MEDIA_INCLUDE}&fields[appCustomProductPageLocalizations]=locale,promotionalText,placements,appScreenshotSets`,
              'reading the locales of a custom product page',
              true,
            )
          : [],
      };
      return page;
    });
    return { items, truncated, warnings };
  }

  async #versionsOf(pageId: string): Promise<Json[]> {
    const read = await this.#api.list(
      `/v1/appCustomProductPages/${seg(pageId)}/appCustomProductPageVersions?limit=50`,
      'reading the versions of a custom product page',
      { maxPages: this.#maxPages, optional: true },
    );
    return read.data.filter((r) => id(r) !== '');
  }
}
