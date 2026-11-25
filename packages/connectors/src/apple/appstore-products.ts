import { mapLimit } from '../concurrency.ts';
import { StoreError } from '../errors.ts';
import { isRecord, type Json, records, type StoreHttpOptions, text } from '../store-http.ts';
import {
  cleanCurrency,
  cleanLocale,
  decimalToMinor,
  type ListProductsResult,
  type StoreProduct,
  type StoreProductAvailability,
  type StoreProductKind,
  type StoreProductLocalization,
  type StoreProductPrice,
  type StoreProductState,
  type StoreProductsConnector,
  sortedUnique,
} from '../store-products-types.ts';
import { AppleProductsHttp, seg } from './appstore-products-http.ts';

/**
 * App Store Connect: in-app purchases and auto-renewable subscriptions, READ ONLY. Endpoints, each checked on Apple's documentation
 * (the JSON behind developer.apple.com/documentation, 2026-11-20; the pages list parameters and schema names but not the attributes of
 * every object, so what is not listed is marked UNVERIFIED):
 *
 * - `GET /v1/apps/{id}/inAppPurchasesV2` with `include=inAppPurchaseLocalizations`, `limit` (max 200) and `limit[inAppPurchaseLocalizations]`
 *   (max 50). Attributes `name`, `productId`, `inAppPurchaseType` (`CONSUMABLE`, `NON_CONSUMABLE`, `NON_RENEWING_SUBSCRIPTION`), `state`
 *   (twelve values, see `appleProductState`). Localization attributes `name`, `locale`, `description`, `state`. VERIFIED (names and values).
 * - `GET /v2/inAppPurchases/{id}/iapPriceSchedule` (`include=baseTerritory`), then `GET /v1/inAppPurchasePriceSchedules/{id}/manualPrices` and
 *   `.../automaticPrices` (`include=inAppPurchasePricePoint,territory`, `limit` max 200). Price attributes `startDate`, `endDate`, `manual`,
 *   relationships `inAppPurchasePricePoint` and `territory`; price point attributes `customerPrice` and `proceeds`; territory attribute `currency`.
 *   VERIFIED (the names, from the `fields[...]` lists). UNVERIFIED: that `customerPrice` is a decimal string in the territory's currency
 *   (it is read as one, and a price that cannot be read is left out), and what a product with no schedule answers (404 is read as "no prices").
 * - `GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability` (`availableInNewTerritories`), then
 *   `GET /v1/inAppPurchaseAvailabilities/{id}/availableTerritories` (max 200). VERIFIED.
 * - `GET /v1/apps/{id}/subscriptionGroups` (`referenceName`), `GET /v1/subscriptionGroups/{id}/subscriptions` with
 *   `include=subscriptionLocalizations,planAvailabilities` (max 200, relationships max 50). Subscription attributes `name`, `productId`,
 *   `state` (ten values), `subscriptionPeriod` (`ONE_WEEK` .. `ONE_YEAR`). VERIFIED. The localization endpoints under a subscription are
 *   DEPRECATED since API 4.4.1 (the replacement lists the localizations of a "version"), which is why the localizations are read through `include`:
 *   whether `include` keeps returning them is UNVERIFIED.
 * - `GET /v1/subscriptions/{id}/prices` (`include=subscriptionPricePoint,territory`, max 200): attributes `startDate`, `preserved`, `planType`
 *   (`MONTHLY`, `UPFRONT`); price point `customerPrice`, `proceeds`, `proceedsYear2`. VERIFIED (names). UNVERIFIED: what `preserved` means exactly
 *   (a price kept for existing subscribers): preserved prices are left out, so the price shown is the one new subscribers pay.
 * - `GET /v1/subscriptions/{id}/planAvailabilities` (included) and `GET /v1/subscriptionPlanAvailabilities/{id}/availableTerritories`
 *   (the older `subscriptionAvailability` is deprecated since 4.4). VERIFIED. The `planType` values beyond `UPFRONT` are UNVERIFIED.
 *
 * Reads never write. A sub-resource that Apple does not have (404) is an empty answer with a warning; any other failure fails the read, so a
 * half-read snapshot never replaces a good one. The answer is capped (`maxProducts`) and says so.
 */

export type AppleProductsConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: import('./apple-auth.ts').AppStoreConnectKey;
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  apiBase?: string;
  /** Most products read (in-app purchases and subscriptions together). Default 300. */
  maxProducts?: number;
  /** Pages followed per list. Default 10. */
  maxPages?: number;
  /** Products read at the same time. Default 4. */
  concurrency?: number;
};

const dateMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Apple's review state of an in-app purchase or subscription in this feature's words. */
export function appleProductState(raw: string | undefined): StoreProductState {
  switch ((raw ?? '').toUpperCase()) {
    case 'MISSING_METADATA':
    case 'WAITING_FOR_UPLOAD':
    case 'PROCESSING_CONTENT':
    case 'READY_TO_SUBMIT':
      return 'draft';
    case 'WAITING_FOR_REVIEW':
    case 'IN_REVIEW':
    case 'PENDING_BINARY_APPROVAL':
      return 'in_review';
    case 'DEVELOPER_ACTION_NEEDED':
    case 'REJECTED':
      return 'action_needed';
    case 'APPROVED':
      return 'active';
    case 'DEVELOPER_REMOVED_FROM_SALE':
    case 'REMOVED_FROM_SALE':
      return 'removed';
    default:
      return 'unknown';
  }
}

/** Non-renewing subscriptions are subscriptions here too. undefined for a type this code does not know. */
export function appleProductKind(raw: string | undefined): StoreProductKind | undefined {
  switch ((raw ?? '').toUpperCase()) {
    case 'CONSUMABLE':
      return 'consumable';
    case 'NON_CONSUMABLE':
      return 'non_consumable';
    case 'NON_RENEWING_SUBSCRIPTION':
      return 'subscription';
    default:
      return undefined;
  }
}

const attrs = (resource: Json): Json => (isRecord(resource.attributes) ? resource.attributes : {});

/** The ids a to-many relationship of a resource names (`relationships.<name>.data`). */
export function relationIds(resource: Json, name: string): string[] {
  const rel = isRecord(resource.relationships) ? resource.relationships[name] : undefined;
  const data = isRecord(rel) ? rel.data : undefined;
  if (Array.isArray(data)) return records(data).flatMap((d) => text(d.id) ?? []);
  return isRecord(data) && text(data.id) ? [text(data.id) as string] : [];
}

/** The single id a to-one relationship names. */
export const relationId = (resource: Json, name: string): string | undefined =>
  relationIds(resource, name)[0];

const byTypeAndId = (items: Json[], type: string): Map<string, Json> => {
  const found = new Map<string, Json>();
  for (const item of items) {
    const id = text(item.id);
    if (id && item.type === type) found.set(id, item);
  }
  return found;
};

/** Localizations (`inAppPurchaseLocalizations` or `subscriptionLocalizations`) named by a product, read from `included`. */
export function parseAppleLocalizations(
  product: Json,
  included: Json[],
  type: 'inAppPurchaseLocalizations' | 'subscriptionLocalizations',
): StoreProductLocalization[] {
  const known = byTypeAndId(included, type);
  const found: StoreProductLocalization[] = [];
  for (const id of relationIds(product, type)) {
    const item = known.get(id);
    if (!item) continue;
    const a = attrs(item);
    const locale = cleanLocale(a.locale);
    if (!locale) continue;
    found.push({
      locale,
      name: text(a.name) ?? '',
      description: text(a.description) ?? '',
      ref: id,
    });
  }
  return found.sort((x, y) => (x.locale < y.locale ? -1 : x.locale > y.locale ? 1 : 0));
}

/** A price row before the current one is chosen. */
export type ApplePriceRow = {
  territory: string;
  currency: string;
  amount: string;
  planId: string | null;
  startMs: number | null;
  endMs: number | null;
  manual: boolean;
};

/**
 * The price in force now per territory (and plan type): started (or no start) and not ended; among several, a manual one before an
 * automatic one, then the latest start. A future price is not "the price".
 */
export function currentApplePrices(rows: ApplePriceRow[], nowMs: number): StoreProductPrice[] {
  const best = new Map<string, ApplePriceRow>();
  for (const row of rows) {
    if (row.startMs !== null && row.startMs > nowMs) continue;
    if (row.endMs !== null && row.endMs <= nowMs) continue;
    const key = `${row.planId ?? ''}\u0000${row.territory}`;
    const old = best.get(key);
    if (
      !old ||
      (row.manual && !old.manual) ||
      (row.manual === old.manual && (row.startMs ?? -Infinity) > (old.startMs ?? -Infinity))
    )
      best.set(key, row);
  }
  return [...best.values()]
    .map((r) => ({
      territory: r.territory,
      currency: r.currency,
      amount: r.amount,
      planId: r.planId,
    }))
    .sort((a, b) =>
      `${a.planId ?? ''}\u0000${a.territory}` < `${b.planId ?? ''}\u0000${b.territory}` ? -1 : 1,
    );
}

/**
 * Prices (`inAppPurchasePrices` or `subscriptionPrices`) with their included price points and territories. A price whose territory, currency or
 * customer price cannot be read is left out and counted in `skipped`.
 */
export function parseApplePriceRows(
  prices: Json[],
  included: Json[],
  kind: { point: string; relation: string; planType?: boolean },
): { rows: ApplePriceRow[]; skipped: number } {
  const points = byTypeAndId(included, kind.point);
  const territories = byTypeAndId(included, 'territories');
  const rows: ApplePriceRow[] = [];
  let skipped = 0;
  for (const price of prices) {
    const a = attrs(price);
    if (a.preserved === true) continue;
    const territory = relationId(price, 'territory');
    const pointId = relationId(price, kind.relation);
    const point = pointId ? points.get(pointId) : undefined;
    const currency = cleanCurrency(
      territory ? attrs(territories.get(territory) ?? {}).currency : undefined,
    );
    const amount =
      point && currency ? decimalToMinor(attrs(point).customerPrice, currency) : undefined;
    if (!territory || !currency || amount === undefined) {
      skipped++;
      continue;
    }
    const planType = kind.planType ? text(a.planType) : undefined;
    rows.push({
      territory,
      currency,
      amount,
      planId: planType ? planType.toUpperCase() : null,
      startMs: dateMs(a.startDate),
      endMs: dateMs(a.endDate),
      manual: kind.planType ? true : a.manual === true,
    });
  }
  return { rows, skipped };
}

export { mapLimit };

export class AppleProductsConnector implements StoreProductsConnector {
  readonly store = 'appstoreconnect' as const;
  readonly #api: AppleProductsHttp;
  readonly #app: string;
  readonly #maxProducts: number;
  readonly #maxPages: number;
  readonly #concurrency: number;

  constructor(options: AppleProductsConnectorOptions) {
    if (!/^[0-9]{1,20}$/.test(options.appStoreId)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the app is missing or not a number. Sync the app first.',
      );
    }
    this.#app = options.appStoreId;
    this.#api = new AppleProductsHttp(options);
    this.#maxProducts = Math.max(1, options.maxProducts ?? 300);
    this.#maxPages = Math.max(1, options.maxPages ?? 10);
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
  }

  /** Builds a connector from the stored secret (core `buildSecret` JSON for `app_store_connect`). */
  static fromSecret(
    secret: string,
    options: Omit<AppleProductsConnectorOptions, 'credential'>,
  ): AppleProductsConnector {
    return new AppleProductsConnector({
      ...options,
      credential: AppleProductsHttp.credentialOf(secret),
    });
  }

  async listProducts(): Promise<ListProductsResult> {
    const warnings: string[] = [];
    let complete = true;
    const nowMs = this.#api.now();

    // ----- in-app purchases
    const iaps = await this.#api.list(
      `/v1/apps/${seg(this.#app)}/inAppPurchasesV2?limit=200&include=inAppPurchaseLocalizations&limit[inAppPurchaseLocalizations]=50`,
      'reading the in-app purchases',
      { maxPages: this.#maxPages },
    );
    if (iaps.truncated) complete = false;

    // ----- subscription groups and their subscriptions
    const groups = await this.#api.list(
      `/v1/apps/${seg(this.#app)}/subscriptionGroups?limit=200&fields[subscriptionGroups]=referenceName`,
      'reading the subscription groups',
      { maxPages: this.#maxPages },
    );
    if (groups.truncated) complete = false;
    type SubInput = { resource: Json; included: Json[]; group: string | null };
    const subs: SubInput[] = [];
    for (const group of groups.data) {
      const groupId = text(group.id);
      if (!groupId) continue;
      const listed = await this.#api.list(
        `/v1/subscriptionGroups/${seg(groupId)}/subscriptions?limit=200&include=subscriptionLocalizations,planAvailabilities&limit[subscriptionLocalizations]=50&limit[planAvailabilities]=50`,
        'reading the subscriptions of a group',
        { maxPages: this.#maxPages },
      );
      if (listed.truncated) complete = false;
      for (const resource of listed.data)
        subs.push({
          resource,
          included: listed.included,
          group: text(attrs(group).referenceName) ?? null,
        });
    }

    // ----- the cap
    const iapItems = iaps.data.filter((r) => text(r.id) && text(attrs(r).productId));
    const subItems = subs.filter((s) => text(s.resource.id) && text(attrs(s.resource).productId));
    let room = this.#maxProducts;
    const iapUse = iapItems.slice(0, room);
    room -= iapUse.length;
    const subUse = subItems.slice(0, room);
    if (iapUse.length < iapItems.length || subUse.length < subItems.length) {
      complete = false;
      warnings.push(
        `Only the first ${this.#maxProducts} products were read; the app has more in App Store Connect.`,
      );
    }

    const products: StoreProduct[] = [];
    const iapProducts = await mapLimit(iapUse, this.#concurrency, (item) =>
      this.#inAppPurchase(item, iaps.included, nowMs, warnings),
    );
    for (const product of iapProducts) if (product) products.push(product);
    const subProducts = await mapLimit(subUse, this.#concurrency, (item) =>
      this.#subscription(item.resource, item.included, item.group, nowMs, warnings),
    );
    products.push(...subProducts);
    products.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    return { products, warnings, complete };
  }

  async #inAppPurchase(
    resource: Json,
    included: Json[],
    nowMs: number,
    warnings: string[],
  ): Promise<StoreProduct | undefined> {
    const id = text(resource.id) as string;
    const a = attrs(resource);
    const productId = text(a.productId) as string;
    const kind = appleProductKind(text(a.inAppPurchaseType));
    if (!kind) {
      warnings.push(
        `${productId}: an in-app purchase type this server does not know was left out.`,
      );
      return undefined;
    }
    const rawState = text(a.state) ?? null;
    const [priced, availability] = await Promise.all([
      this.#iapPrices(id, productId, nowMs, warnings),
      this.#iapAvailability(id, productId, warnings),
    ]);
    return {
      store: 'appstoreconnect',
      productId,
      storeRef: id,
      kind,
      referenceName: text(a.name) ?? productId,
      state: appleProductState(rawState ?? undefined),
      rawState,
      localizations: parseAppleLocalizations(resource, included, 'inAppPurchaseLocalizations'),
      prices: priced.prices,
      availability,
      group: null,
      period: null,
      baseTerritory: priced.baseTerritory,
      plans: [],
      offers: [],
    };
  }

  async #iapPrices(
    id: string,
    productId: string,
    nowMs: number,
    warnings: string[],
  ): Promise<{ prices: StoreProductPrice[]; baseTerritory: string | null }> {
    const schedule = await this.#api.get(
      `/v2/inAppPurchases/${seg(id)}/iapPriceSchedule?include=baseTerritory&fields[territories]=currency`,
      'reading a price schedule',
      true,
    );
    const data = schedule && isRecord(schedule.data) ? schedule.data : undefined;
    const scheduleId = data ? text(data.id) : undefined;
    if (!data || !scheduleId) {
      warnings.push(`${productId}: App Store Connect has no price schedule for it.`);
      return { prices: [], baseTerritory: null };
    }
    const baseTerritory = relationId(data, 'baseTerritory') ?? null;
    const rows: ApplePriceRow[] = [];
    let skipped = 0;
    for (const which of ['manualPrices', 'automaticPrices'] as const) {
      const listed = await this.#api.list(
        `/v1/inAppPurchasePriceSchedules/${seg(scheduleId)}/${which}?limit=200&include=inAppPurchasePricePoint,territory&fields[inAppPurchasePrices]=startDate,endDate,manual,inAppPurchasePricePoint,territory&fields[inAppPurchasePricePoints]=customerPrice&fields[territories]=currency`,
        'reading prices',
        { maxPages: this.#maxPages, optional: true },
      );
      const parsed = parseApplePriceRows(listed.data, listed.included, {
        point: 'inAppPurchasePricePoints',
        relation: 'inAppPurchasePricePoint',
      });
      // A price of the automatic list is not a manual one, whatever the flag says.
      rows.push(...parsed.rows.map((r) => ({ ...r, manual: which === 'manualPrices' })));
      skipped += parsed.skipped;
      if (listed.truncated)
        warnings.push(`${productId}: some prices were not read (too many pages).`);
    }
    if (skipped > 0)
      warnings.push(
        `${productId}: ${skipped} price${skipped === 1 ? '' : 's'} could not be read and were left out.`,
      );
    return { prices: currentApplePrices(rows, nowMs), baseTerritory };
  }

  async #iapAvailability(
    id: string,
    productId: string,
    warnings: string[],
  ): Promise<StoreProductAvailability | null> {
    const found = await this.#api.get(
      `/v2/inAppPurchases/${seg(id)}/inAppPurchaseAvailability?fields[inAppPurchaseAvailabilities]=availableInNewTerritories`,
      'reading the availability',
      true,
    );
    const data = found && isRecord(found.data) ? found.data : undefined;
    const availabilityId = data ? text(data.id) : undefined;
    if (!data || !availabilityId) {
      warnings.push(`${productId}: App Store Connect has no availability for it.`);
      return null;
    }
    const territories = await this.#api.list(
      `/v1/inAppPurchaseAvailabilities/${seg(availabilityId)}/availableTerritories?limit=200&fields[territories]=currency`,
      'reading the territories',
      { maxPages: this.#maxPages, optional: true },
    );
    return {
      territories: sortedUnique(territories.data.flatMap((t) => text(t.id) ?? [])),
      availableInNewTerritories:
        typeof attrs(data).availableInNewTerritories === 'boolean'
          ? (attrs(data).availableInNewTerritories as boolean)
          : null,
    };
  }

  async #subscription(
    resource: Json,
    included: Json[],
    group: string | null,
    nowMs: number,
    warnings: string[],
  ): Promise<StoreProduct> {
    const id = text(resource.id) as string;
    const a = attrs(resource);
    const productId = text(a.productId) as string;
    const rawState = text(a.state) ?? null;
    const [prices, availability] = await Promise.all([
      this.#subscriptionPrices(id, productId, nowMs, warnings),
      this.#subscriptionAvailability(resource, included, productId, warnings),
    ]);
    return {
      store: 'appstoreconnect',
      productId,
      storeRef: id,
      kind: 'subscription',
      referenceName: text(a.name) ?? productId,
      state: appleProductState(rawState ?? undefined),
      rawState,
      localizations: parseAppleLocalizations(resource, included, 'subscriptionLocalizations'),
      prices,
      availability,
      group,
      period: text(a.subscriptionPeriod) ?? null,
      baseTerritory: null,
      plans: [],
      offers: [],
    };
  }

  async #subscriptionPrices(
    id: string,
    productId: string,
    nowMs: number,
    warnings: string[],
  ): Promise<StoreProductPrice[]> {
    const listed = await this.#api.list(
      `/v1/subscriptions/${seg(id)}/prices?limit=200&include=subscriptionPricePoint,territory&fields[subscriptionPrices]=startDate,preserved,planType,territory,subscriptionPricePoint&fields[subscriptionPricePoints]=customerPrice&fields[territories]=currency`,
      'reading the prices of a subscription',
      { maxPages: this.#maxPages, optional: true },
    );
    const parsed = parseApplePriceRows(listed.data, listed.included, {
      point: 'subscriptionPricePoints',
      relation: 'subscriptionPricePoint',
      planType: true,
    });
    if (parsed.skipped > 0)
      warnings.push(
        `${productId}: ${parsed.skipped} price${parsed.skipped === 1 ? '' : 's'} could not be read and were left out.`,
      );
    if (listed.truncated)
      warnings.push(`${productId}: some prices were not read (too many pages).`);
    return currentApplePrices(parsed.rows, nowMs);
  }

  async #subscriptionAvailability(
    resource: Json,
    included: Json[],
    productId: string,
    warnings: string[],
  ): Promise<StoreProductAvailability | null> {
    const plans = byTypeAndId(included, 'subscriptionPlanAvailabilities');
    const planIds = relationIds(resource, 'planAvailabilities').filter((p) => plans.has(p));
    if (planIds.length === 0) {
      warnings.push(`${productId}: App Store Connect lists no availability for it.`);
      return null;
    }
    const territories = new Set<string>();
    let inNew: boolean | null = null;
    for (const planId of planIds) {
      const flag = attrs(plans.get(planId) as Json).availableInNewTerritories;
      if (typeof flag === 'boolean') inNew = inNew === true || flag;
      const listed = await this.#api.list(
        `/v1/subscriptionPlanAvailabilities/${seg(planId)}/availableTerritories?limit=200&fields[territories]=currency`,
        'reading the territories of a subscription',
        { maxPages: this.#maxPages, optional: true },
      );
      for (const t of listed.data) {
        const territory = text(t.id);
        if (territory) territories.add(territory);
      }
    }
    return { territories: sortedUnique(territories), availableInNewTerritories: inNew };
  }
}
