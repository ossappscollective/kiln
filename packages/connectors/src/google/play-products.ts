import { StoreError } from '../errors.ts';
import { isRecord, type Json, records, text } from '../store-http.ts';
import {
  cleanLocale,
  type ListProductsResult,
  moneyToPrice,
  type StoreProduct,
  type StoreProductAvailability,
  type StoreProductLocalization,
  type StoreProductOffer,
  type StoreProductPlan,
  type StoreProductPrice,
  type StoreProductState,
  type StoreProductsConnector,
  sortedUnique,
} from '../store-products-types.ts';
import { PlayProductsHttp, type PlayProductsHttpOptions } from './play-products-http.ts';

/**
 * Google Play: subscriptions and one-time products, READ ONLY. Endpoints, each checked on Google's reference pages and discovery document
 * on 2026-11-20 (https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.subscriptions and `.onetimeproducts`):
 *
 * - `GET /androidpublisher/v3/applications/{packageName}/subscriptions` (`monetization.subscriptions.list`): `pageSize` (default 50, at most
 *   1000), `pageToken`; answer `subscriptions[]`, `nextPageToken`. Subscription: `packageName`, `productId`, `basePlans[]`, `listings[]`,
 *   `archived`, `taxAndComplianceSettings`. BasePlan: `basePlanId`, `state` (`DRAFT`, `ACTIVE`, `INACTIVE`), `regionalConfigs[]` (`regionCode`,
 *   `newSubscriberAvailability`, `price` Money), `otherRegionsConfig` (`usdPrice`, `eurPrice`, `newSubscriberAvailability`) and one of
 *   `autoRenewingBasePlanType`, `prepaidBasePlanType`, `installmentsBasePlanType` (each with an ISO 8601 `billingPeriodDuration`).
 *   SubscriptionListing: `languageCode`, `title`, `description`, `benefits[]`. Money: `currencyCode`, `units` (a string), `nanos`. VERIFIED.
 * - `GET .../oneTimeProducts` (`monetization.onetimeproducts.list`; note the capital T: the patch path is lowercase): the same paging; answer
 *   `oneTimeProducts[]`. OneTimeProduct: `productId`, `listings[]` (`languageCode`, `title`, `description`), `purchaseOptions[]`
 *   (`purchaseOptionId`, `state` `DRAFT`/`ACTIVE`/`INACTIVE`/`INACTIVE_PUBLISHED`, `regionalPricingAndAvailabilityConfigs[]` with `regionCode`,
 *   `price`, `availability` `AVAILABLE`/`NO_LONGER_AVAILABLE`/`AVAILABLE_IF_RELEASED`/`AVAILABLE_FOR_OFFERS_ONLY`, `newRegionsConfig`,
 *   `buyOption.multiQuantityEnabled`), `regionsVersion`. VERIFIED. The page carries no beta or deprecation note, which is why the legacy
 *   `inappproducts` resource is not read (whether an app that was never migrated shows its products here is UNVERIFIED).
 * - `GET .../subscriptions/-/basePlans/-/offers` (`monetization.subscriptions.basePlans.offers.list`): "-" reads every offer of the app (VERIFIED);
 *   `subscriptionOffers[]` with `productId`, `basePlanId`, `offerId`, `state`.
 *
 * Google Play has no reference name (the product id is used) and does not say whether a one-time product is consumable: that is decided in the
 * app by consuming or acknowledging a purchase. A product whose purchase option allows more than one unit per checkout is called `consumable`,
 * every other `non_consumable`; this is a guess and the UI says so.
 * `otherRegionsConfig` prices (a USD and a EUR price for regions without their own) are not listed as territories.
 */

export type PlayProductsConnectorOptions = PlayProductsHttpOptions & {
  /** Products per request. Default 100 (the documented maximum is 1000). */
  pageSize?: number;
  /** Pages followed per list. Default 10. */
  maxPages?: number;
  /** Most products read (subscriptions and one-time products together). Default 300. */
  maxProducts?: number;
};

const attrsOf = (value: unknown): Json => (isRecord(value) ? value : {});

/** A base plan or purchase option state in this feature's words, over all of a product's plans. */
export function playProductState(states: readonly string[]): StoreProductState {
  const set = new Set(states.map((s) => s.toUpperCase()));
  if (set.has('ACTIVE')) return 'active';
  if (set.has('INACTIVE') || set.has('INACTIVE_PUBLISHED')) return 'inactive';
  if (set.has('DRAFT')) return 'draft';
  return 'unknown';
}

/** `listings[]` of a subscription or one-time product as localizations. A listing without a language is left out. */
export function parsePlayListings(listings: unknown): StoreProductLocalization[] {
  const found: StoreProductLocalization[] = [];
  for (const listing of records(listings)) {
    const locale = cleanLocale(listing.languageCode);
    if (!locale) continue;
    found.push({
      locale,
      name: text(listing.title) ?? '',
      description: text(listing.description) ?? '',
    });
  }
  return found.sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));
}

const periodOf = (plan: Json): string | null => {
  for (const key of ['autoRenewingBasePlanType', 'prepaidBasePlanType', 'installmentsBasePlanType']) {
    const type = attrsOf(plan[key]);
    const period = text(type.billingPeriodDuration);
    if (period) return period;
  }
  return null;
};

const sortProducts = (a: StoreProduct, b: StoreProduct) =>
  a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;

/** One `Subscription` as a product, or undefined without a product id. `offers` are the app's offers, already filtered to this product. */
export function parsePlaySubscription(
  subscription: unknown,
  offers: StoreProductOffer[] = [],
): StoreProduct | undefined {
  const s = attrsOf(subscription);
  const productId = text(s.productId);
  if (!productId) return undefined;
  const plans: StoreProductPlan[] = [];
  const prices: StoreProductPrice[] = [];
  const territories = new Set<string>();
  let inNew: boolean | null = null;
  const baseRecords = records(s.basePlans);
  const activeExists = baseRecords.some((p) => text(p.state) === 'ACTIVE');
  for (const plan of baseRecords) {
    const id = text(plan.basePlanId);
    if (!id) continue;
    const state = text(plan.state) ?? 'STATE_UNSPECIFIED';
    plans.push({ id, state, period: periodOf(plan) });
    // Availability is what a NEW subscriber can buy: the active plans, or every plan when none is active yet.
    const counts = !activeExists || state === 'ACTIVE';
    for (const config of records(plan.regionalConfigs)) {
      const region = text(config.regionCode);
      const price = moneyToPrice(config.price);
      if (region && price) prices.push({ territory: region, ...price, planId: id });
      if (region && counts && config.newSubscriberAvailability === true) territories.add(region);
    }
    const other = attrsOf(plan.otherRegionsConfig);
    if (counts && typeof other.newSubscriberAvailability === 'boolean')
      inNew = inNew === true || other.newSubscriberAvailability;
  }
  const first = plans.find((p) => p.state === 'ACTIVE') ?? plans[0];
  return {
    store: 'googleplay',
    productId,
    storeRef: null,
    kind: 'subscription',
    referenceName: productId,
    state: playProductState(plans.map((p) => p.state)),
    rawState: plans.length > 0 ? sortedUnique(plans.map((p) => p.state)).join(',') : null,
    localizations: parsePlayListings(s.listings),
    prices: prices.sort((a, b) =>
      `${a.planId ?? ''}\u0000${a.territory}` < `${b.planId ?? ''}\u0000${b.territory}` ? -1 : 1,
    ),
    availability: plans.length === 0 ? null : { territories: sortedUnique(territories), availableInNewTerritories: inNew },
    group: null,
    period: first?.period ?? null,
    baseTerritory: null,
    plans,
    offers,
  };
}

/** One `OneTimeProduct` as a product, or undefined without a product id. */
export function parsePlayOneTimeProduct(product: unknown): StoreProduct | undefined {
  const p = attrsOf(product);
  const productId = text(p.productId);
  if (!productId) return undefined;
  const plans: StoreProductPlan[] = [];
  const prices: StoreProductPrice[] = [];
  const territories = new Set<string>();
  let inNew: boolean | null = null;
  let multi = false;
  const options = records(p.purchaseOptions);
  const activeExists = options.some((o) => text(o.state) === 'ACTIVE');
  for (const option of options) {
    const id = text(option.purchaseOptionId);
    if (!id) continue;
    const state = text(option.state) ?? 'STATE_UNSPECIFIED';
    plans.push({ id, state, period: null });
    if (attrsOf(option.buyOption).multiQuantityEnabled === true) multi = true;
    const counts = !activeExists || state === 'ACTIVE';
    for (const config of records(option.regionalPricingAndAvailabilityConfigs)) {
      const region = text(config.regionCode);
      const price = moneyToPrice(config.price);
      if (region && price) prices.push({ territory: region, ...price, planId: id });
      if (region && counts && text(config.availability) === 'AVAILABLE') territories.add(region);
    }
    const fresh = text(attrsOf(option.newRegionsConfig).availability);
    if (counts && fresh !== undefined) inNew = inNew === true || fresh === 'AVAILABLE';
  }
  const availability: StoreProductAvailability | null =
    plans.length === 0 ? null : { territories: sortedUnique(territories), availableInNewTerritories: inNew };
  return {
    store: 'googleplay',
    productId,
    storeRef: null,
    kind: multi ? 'consumable' : 'non_consumable',
    referenceName: productId,
    state: playProductState(plans.map((o) => o.state)),
    rawState: plans.length > 0 ? sortedUnique(plans.map((o) => o.state)).join(',') : null,
    localizations: parsePlayListings(p.listings),
    prices: prices.sort((a, b) =>
      `${a.planId ?? ''}\u0000${a.territory}` < `${b.planId ?? ''}\u0000${b.territory}` ? -1 : 1,
    ),
    availability,
    group: null,
    period: null,
    baseTerritory: null,
    plans,
    offers: [],
  };
}

export class PlayProductsConnector implements StoreProductsConnector {
  readonly store = 'googleplay' as const;
  readonly #api: PlayProductsHttp;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #maxProducts: number;

  constructor(options: PlayProductsConnectorOptions) {
    this.#api = new PlayProductsHttp(options);
    const wanted = options.pageSize ?? 100;
    this.#pageSize = Number.isFinite(wanted) ? Math.min(1000, Math.max(1, Math.trunc(wanted))) : 100;
    this.#maxPages = Math.max(1, options.maxPages ?? 10);
    this.#maxProducts = Math.max(1, options.maxProducts ?? 300);
  }

  /** Every page of a list: `path` is the suffix after the package, `key` the array in the answer. */
  async #pages(
    path: string,
    key: string,
    what: string,
  ): Promise<{ items: Json[]; truncated: boolean }> {
    const items: Json[] = [];
    let token: string | undefined;
    for (let page = 1; ; page++) {
      const url = `${this.#api.url(path)}?pageSize=${this.#pageSize}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const body = (await this.#api.get(url, what, false, true)) as Json;
      items.push(...records(body[key]));
      token = text(body.nextPageToken);
      if (!token) return { items, truncated: false };
      if (page >= this.#maxPages) return { items, truncated: true };
    }
  }

  async listProducts(): Promise<ListProductsResult> {
    const warnings: string[] = [];
    let complete = true;

    const subscriptions = await this.#pages('/subscriptions', 'subscriptions', 'reading the subscriptions');
    // The one-time products are read apart: an app that was never moved to the new product model, or an answer that is not JSON, must not
    // cost the app its subscriptions. The list is then marked incomplete so nothing is taken to be gone.
    let oneTime: { items: Json[]; truncated: boolean } = { items: [], truncated: false };
    try {
      oneTime = await this.#pages('/oneTimeProducts', 'oneTimeProducts', 'reading the one-time products');
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'unexpected') throw error;
      complete = false;
      warnings.push(`The one-time products could not be read: ${error.message}`);
    }
    if (subscriptions.truncated || oneTime.truncated) complete = false;

    const offers = new Map<string, StoreProductOffer[]>();
    try {
      const listed = await this.#pages(
        '/subscriptions/-/basePlans/-/offers',
        'subscriptionOffers',
        'reading the subscription offers',
      );
      if (listed.truncated) warnings.push('Some subscription offers were not read (too many pages).');
      for (const offer of listed.items) {
        const productId = text(offer.productId);
        const id = text(offer.offerId);
        const planId = text(offer.basePlanId);
        if (!productId || !id || !planId) continue;
        const list = offers.get(productId) ?? [];
        list.push({ id, planId, state: text(offer.state) ?? 'STATE_UNSPECIFIED' });
        offers.set(productId, list);
      }
    } catch (error) {
      // Offers are extra information: an app without them, or a key that may not read them, still has its products.
      if (!(error instanceof StoreError) || (error.kind !== 'not_found' && error.kind !== 'forbidden'))
        throw error;
      warnings.push('The offers of the subscriptions could not be read.');
    }

    const products: StoreProduct[] = [];
    for (const subscription of subscriptions.items) {
      const parsed = parsePlaySubscription(subscription, offers.get(text(subscription.productId) ?? '') ?? []);
      if (parsed) products.push(parsed);
    }
    for (const product of oneTime.items) {
      const parsed = parsePlayOneTimeProduct(product);
      if (parsed) products.push(parsed);
    }
    products.sort(sortProducts);
    if (products.length > this.#maxProducts) {
      products.length = this.#maxProducts;
      complete = false;
      warnings.push(
        `Only the first ${this.#maxProducts} products were kept; the app has more in Google Play Console.`,
      );
    }
    return { products, warnings, complete };
  }
}
