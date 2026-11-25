import {
  type CurrentPrice,
  minorToPlayMoney,
  type PriceChange,
  type PricePoint,
  utcDate,
} from '@kiln/core';
import { StoreError } from '../errors.ts';
import { enc, isRecord, type Json, records, text } from '../store-http.ts';
import {
  type ConvertedPrices,
  type LivePrices,
  lineAlreadyApplied,
  type PriceApplyResult,
  PriceDriftError,
  type PriceLineOutcome,
  type PricePreviewResult,
  priceCodeOf,
  type StorePriceWriteConnector,
} from '../store-price-types.ts';
import { moneyToPrice, type StoreProductRef } from '../store-products-types.ts';
import { parsePlayOneTimeProduct, parsePlaySubscription } from './play-products.ts';
import { PlayProductsHttp, type PlayProductsHttpOptions } from './play-products-http.ts';

/**
 * Google Play: change the PRICE of a subscription base plan or of a one-time product purchase option. A STORE WRITE that charges real customers.
 * Only called by the server's price service after its gates (docs/adr/0062-price-writes.md). Never retried. Never creates a product, plan,
 * option or region (`allowMissing` is never sent; a region the plan does not have is refused).
 *
 * VERIFIED (Google's reference pages): `monetization.subscriptions.patch` and `monetization.onetimeproducts.patch` take `updateMask` (required),
 * `regionsVersion.version` (required), `allowMissing`, `latencyTolerance`. `RegionalBasePlanConfig`: `regionCode`, `newSubscriberAvailability`,
 * `price` (Money; "must use the region's linked currency"). `pricing:convertRegionPrices`: body `price` (tax exclusive) and
 * `productTaxCategoryCode`; answer `convertedRegionPrices` (region to `price`, tax inclusive, and `taxAmount`), `convertedOtherRegionsPrice`,
 * `regionVersion`. `basePlans.migratePrices`: "Migrates subscribers from one or more legacy price cohorts to the current price" and "Requests
 * result in Google Play notifying affected subscribers"; body `regionalPriceMigrations[]` (`regionCode`, `oldestAllowedPriceVersionTime`,
 * `priceIncreaseType`), `regionsVersion`; `PRICE_INCREASE_TYPE_OPT_IN` ("must accept or their subscription is canceled") and `_OPT_OUT` ("notified
 * but can keep their current price"; the FIRST opt-out increase of an app must be started in the Play Console; increases outside Google's
 * regional, frequency and amount limits proceed as opt-in).
 * UNVERIFIED: that `updateMask=basePlans` with the whole list as read changes one base plan's regional prices and nothing else; that
 * `updateMask=purchaseOptions` does the same for a one-time product; the exact path `.../subscriptions/{id}/basePlans/{planId}:migratePrices`;
 * that a plain patch leaves existing subscribers on their legacy price cohort (that is the default this code relies on for `preserve`); whether a
 * price is tax inclusive or exclusive in `regionalConfigs` (the conversion answer says inclusive); a store minimum or maximum per currency (the store
 * refuses and the refusal is shown).
 */

export type PlayProductPriceConnectorOptions = PlayProductsHttpOptions;
const PRODUCT_ID = /^[a-z0-9][a-z0-9._]{0,39}$/;
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const iso = (ms: number) => new Date(ms).toISOString();

export class PlayProductPriceConnector implements StorePriceWriteConnector {
  readonly store = 'googleplay' as const;
  readonly #api: PlayProductsHttp;

  constructor(options: PlayProductPriceConnectorOptions) {
    this.#api = new PlayProductsHttp(options);
  }

  #id(product: StoreProductRef): string {
    if (!PRODUCT_ID.test(product.productId))
      throw new StoreError('googleplay', 'invalid_input', 'Not a valid Google Play product id.');
    return product.productId;
  }

  async #resource(product: StoreProductRef): Promise<Json> {
    const id = this.#id(product);
    const url = this.#api.url(
      product.kind === 'subscription' ? `/subscriptions/${enc(id)}` : `/oneTimeProducts/${enc(id)}`,
    );
    const body = await this.#api.get(url, 'reading a product', true);
    if (body === undefined)
      throw new StoreError(
        'googleplay',
        'not_found',
        'The store has no such product (any more). Sync the app again.',
        404,
      );
    return body;
  }

  #live(product: StoreProductRef, resource: Json, planId: string | null): LivePrices {
    const parsed =
      product.kind === 'subscription'
        ? parsePlaySubscription(resource)
        : parsePlayOneTimeProduct(resource);
    const current: CurrentPrice[] = (parsed?.prices ?? [])
      .filter((p) => planId === null || p.planId === planId)
      .map((p) => ({ territory: p.territory, currency: p.currency, amount: p.amount }));
    return { current, scheduled: [] };
  }

  async readPrices(product: StoreProductRef, planId: string | null): Promise<LivePrices> {
    return this.#live(product, await this.#resource(product), planId);
  }

  async pricePoints(): Promise<PricePoint[]> {
    return [];
  }

  async convertFromBase(base: { currency: string; amount: string }): Promise<ConvertedPrices> {
    const body = await this.#api.postRead(
      this.#api.url('/pricing:convertRegionPrices'),
      { price: minorToPlayMoney(base.amount, base.currency) },
      'converting a price to other regions',
    );
    const map = isRecord(body.convertedRegionPrices) ? body.convertedRegionPrices : {};
    const prices: CurrentPrice[] = [];
    for (const [region, value] of Object.entries(map)) {
      const price = isRecord(value) ? moneyToPrice(value.price) : undefined;
      if (/^[A-Z]{2}$/.test(region) && price)
        prices.push({ territory: region, currency: price.currency, amount: price.amount });
    }
    const version = isRecord(body.regionVersion) ? text(body.regionVersion.version) : undefined;
    return {
      prices: prices.sort((a, b) => (a.territory < b.territory ? -1 : 1)),
      regionsVersion: version ?? null,
    };
  }

  async preview(product: StoreProductRef, change: PriceChange): Promise<PricePreviewResult> {
    const id = this.#id(product);
    const sub = product.kind === 'subscription';
    const requests: PricePreviewResult['requests'] = [
      {
        method: 'PATCH',
        path: `/applications/{package}/${sub ? 'subscriptions' : 'onetimeproducts'}/${id}?updateMask=${sub ? 'basePlans' : 'purchaseOptions'}`,
        summary: `${change.lines.length} regional price(s) of ${change.planId ?? 'the plan'} replaced, everything else sent back as read.`,
      },
    ];
    if (
      sub &&
      (change.existingSubscribers === 'opt_in' || change.existingSubscribers === 'opt_out')
    ) {
      requests.push({
        method: 'POST',
        path: `/applications/{package}/subscriptions/${id}/basePlans/${change.planId ?? ''}:migratePrices`,
        summary: `Existing subscribers are moved to the new price (${change.existingSubscribers === 'opt_in' ? 'they must accept it or the subscription is cancelled' : 'they are notified and may keep their price'}); Google Play notifies them.`,
      });
    }
    return {
      mode: 'local',
      lines: change.lines.map((l) => ({ territory: l.territory })),
      requests,
    };
  }

  async #regionsVersion(resource: Json): Promise<string> {
    const own = isRecord(resource.regionsVersion)
      ? text(resource.regionsVersion.version)
      : undefined;
    if (own) return own;
    const converted = await this.#api.postRead(
      this.#api.url('/pricing:convertRegionPrices'),
      { price: { currencyCode: 'USD', units: '1', nanos: 0 } },
      'reading the current regions version',
    );
    const version = isRecord(converted.regionVersion)
      ? text(converted.regionVersion.version)
      : undefined;
    if (!version)
      throw new StoreError(
        'googleplay',
        'unexpected',
        'Google Play did not say which regions version to use, so nothing was changed.',
      );
    return version;
  }

  async apply(
    product: StoreProductRef,
    change: PriceChange,
    guard: (live: LivePrices) => boolean,
    nowMs: number,
  ): Promise<PriceApplyResult> {
    const sub = product.kind === 'subscription';
    const planId = change.planId;
    if (!planId || (!PLAN_ID.test(planId) && !PRODUCT_ID.test(planId)))
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'The base plan or purchase option is not named.',
      );
    const resource = await this.#resource(product);
    const live = this.#live(product, resource, planId);
    if (!guard(live)) throw new PriceDriftError('googleplay', live);
    const today = utcDate(nowMs);
    const all = (
      outcome: PriceLineOutcome['outcome'],
      extra: Partial<PriceLineOutcome> = {},
    ): PriceLineOutcome[] =>
      change.lines.map((l) => ({ territory: l.territory, outcome, ...extra }));
    const pending = change.lines.filter(
      (l) => !lineAlreadyApplied(change, live, l.territory, today),
    );
    if (pending.length === 0) return { lines: all('already_applied') };

    // Find the plan or option, and make sure every region to change is one it already has.
    const key = sub ? 'basePlans' : 'purchaseOptions';
    const idKey = sub ? 'basePlanId' : 'purchaseOptionId';
    const cfgKey = sub ? 'regionalConfigs' : 'regionalPricingAndAvailabilityConfigs';
    const plans = records(resource[key]);
    const index = plans.findIndex((p) => text(p[idKey]) === planId);
    const plan = index >= 0 ? plans[index] : undefined;
    if (!plan)
      return {
        lines: all('failed', {
          code: 'product_not_found',
          message: `The product has no ${sub ? 'base plan' : 'purchase option'} ${planId}.`,
        }),
      };
    const configs = records(plan[cfgKey]);
    const missing = pending.filter((l) => !configs.some((c) => text(c.regionCode) === l.territory));
    if (missing.length > 0) {
      const names = new Set(missing.map((l) => l.territory));
      return {
        lines: change.lines.map((l) =>
          names.has(l.territory)
            ? {
                territory: l.territory,
                outcome: 'failed' as const,
                code: 'unsupported_territory' as const,
                message: `The ${sub ? 'base plan' : 'purchase option'} has no price in ${l.territory}; adding a region is not done from here.`,
              }
            : {
                territory: l.territory,
                outcome: 'not_sent' as const,
                message: 'Not sent: another region of this change was refused.',
              },
        ),
      };
    }
    const toApply = new Map(pending.map((l) => [l.territory, l] as const));
    const nextConfigs = configs.map((c) => {
      const line = toApply.get(text(c.regionCode) ?? '');
      return line ? { ...c, price: minorToPlayMoney(line.newAmount, line.currency) } : c;
    });
    const nextPlans = plans.map((p, i) => (i === index ? { ...p, [cfgKey]: nextConfigs } : p));
    const version = await this.#regionsVersion(resource);
    const id = this.#id(product);
    const path = sub ? `/subscriptions/${enc(id)}` : `/onetimeproducts/${enc(id)}`;
    const url = `${this.#api.url(path)}?updateMask=${key}&regionsVersion.version=${enc(version)}`;
    const pendingNames = new Set(pending.map((l) => l.territory));
    const outcomes = (
      outcome: PriceLineOutcome['outcome'],
      extra: Partial<PriceLineOutcome> = {},
    ): PriceLineOutcome[] =>
      change.lines.map((l) =>
        pendingNames.has(l.territory)
          ? { territory: l.territory, outcome, ...extra }
          : { territory: l.territory, outcome: 'already_applied' as const },
      );
    let result: Awaited<ReturnType<PlayProductsHttp['patch']>>;
    try {
      result = await this.#api.patch(url, { [key]: nextPlans }, 'changing the price of a product');
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      const migration =
        sub && change.existingSubscribers !== 'preserve'
          ? { requested: true, outcome: 'not_sent' as const }
          : undefined;
      return {
        lines: outcomes('failed', { code: priceCodeOf(error), message: error.message }),
        ...(migration ? { migration } : {}),
      };
    }
    if (!result.ok) {
      const migration =
        sub && change.existingSubscribers !== 'preserve'
          ? { requested: true, outcome: 'not_sent' as const }
          : undefined;
      return {
        lines: outcomes('unknown', { message: result.message }),
        ...(migration ? { migration } : {}),
      };
    }
    const lines = outcomes('applied');
    if (
      !sub ||
      (change.existingSubscribers !== 'opt_in' && change.existingSubscribers !== 'opt_out')
    )
      return { lines };

    // Existing subscribers: only when the person chose it. Increases carry the opt-in or opt-out type; decreases carry none.
    const type =
      change.existingSubscribers === 'opt_in'
        ? 'PRICE_INCREASE_TYPE_OPT_IN'
        : 'PRICE_INCREASE_TYPE_OPT_OUT';
    const migrations = pending.map((l) => ({
      regionCode: l.territory,
      oldestAllowedPriceVersionTime: iso(nowMs),
      ...(BigInt(l.newAmount) > BigInt(l.currentAmount) ? { priceIncreaseType: type } : {}),
    }));
    try {
      const moved = await this.#api.patch(
        `${this.#api.url(`/subscriptions/${enc(id)}/basePlans/${enc(planId)}:migratePrices`)}`,
        { regionalPriceMigrations: migrations, regionsVersion: { version } },
        'moving existing subscribers to the new price',
        'POST',
      );
      return {
        lines,
        migration: moved.ok
          ? { requested: true, outcome: 'applied' }
          : { requested: true, outcome: 'unknown', message: moved.message },
      };
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      return {
        lines,
        migration: {
          requested: true,
          outcome: 'failed',
          code: priceCodeOf(error),
          message: error.message,
        },
      };
    }
  }
}
