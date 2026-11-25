import { type CurrentPrice, type PriceChange, type PricePoint, utcDate } from '@kiln/core';
import { StoreError } from '../errors.ts';
import { isRecord, type Json, records, text } from '../store-http.ts';
import {
  type LivePrices,
  lineAlreadyApplied,
  type PriceApplyResult,
  PriceDriftError,
  type PriceLineOutcome,
  type PricePreviewResult,
  PriceWriteError,
  priceCodeOf,
  type ScheduledPrice,
  type StorePriceWriteConnector,
} from '../store-price-types.ts';
import { cleanCurrency, decimalToMinor, type StoreProductRef } from '../store-products-types.ts';
import { relationId } from './appstore-products.ts';
import { AppleProductsHttp, type AppleProductsHttpOptions, seg } from './appstore-products-http.ts';

/**
 * App Store Connect: change the PRICE of an in-app purchase or a subscription. A STORE WRITE that charges real customers, irreversible once in
 * effect. Only called by the server's price service after its gates (docs/adr/0062-price-writes.md). Never retried; nothing is ever deleted.
 *
 * VERIFIED (Apple's article "Configuring subscription prices across territories" and the endpoint pages):
 * - `POST /v1/subscriptionPrices`: relationships `subscription` and `subscriptionPricePoint`; attributes `startDate` (`null` = immediately, else a
 *   date), `preserveCurrentPrice` (keeps existing subscribers on the old price, honoured ONLY when the change is an increase: Apple's
 *   `INCREASE_PRESERVABLE`) and `planType` (`MONTHLY` or `UPFRONT`). The territory comes with the price point. One scheduled price per territory:
 *   a second one is a 409 until the first is deleted (this connector never deletes); a price in effect cannot be deleted; `UNSUPPORTED_TERRITORY` when
 *   the subscription is not available there.
 * - `POST /v1/subscriptionPriceChangePreviews` (`proposedChanges[]` of `territoryId`, `startDate`, `basePricePointId`; answer `changeResults[]` of
 *   `territoryId` and `changeType`: `INCREASE_PRESERVABLE`, `DECREASE_NOT_PRESERVABLE`, `MIXED_NOT_PRESERVABLE`, `NO_CHANGE`). "This request doesn't save
 *   anything": it is the dry run.
 * - `GET /v1/subscriptions/{id}/pricePoints?filter[territory]=XXX&include=territory` (`customerPrice`, `proceeds`), `GET /v1/subscriptions/{id}/prices`.
 * - `POST /v1/inAppPurchasePriceSchedules` exists and "a base territory is now required"; the page lists no body.
 * UNVERIFIED (from the read side and memory): the whole body of the in-app purchase schedule (`manualPrices` with inline `inAppPurchasePrices` in
 * `included`, `${tmp}` ids, `startDate` and `endDate` on each price); that a new schedule REPLACES the old one (so every existing manual price is
 * sent again, unchanged); that changing the base territory moves every automatically priced territory (so Kiln refuses it unless the change names
 * them all); the place of `changeResults` in the preview answer; that a preview needs a `startDate` (today is sent for "immediately").
 */

export type AppleProductPriceConnectorOptions = AppleProductsHttpOptions;
const MAX_TERRITORY_READS = 60;
type Row = {
  territory: string;
  currency: string;
  amount: string;
  startDate: string | null;
  endDate: string | null;
  pointId: string;
  planId: string | null;
  manual: boolean;
};
type ReadResult = LivePrices & {
  baseTerritory: string | null;
  scheduleId: string | null;
  manual: Row[];
};
const SUB_PRICE_CHANGE = new Set(['INCREASE_PRESERVABLE']);
const attrs = (r: Json): Json => (isRecord(r.attributes) ? r.attributes : {});
const day = (value: unknown): string | null => {
  const v = text(value);
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
};

export class AppleProductPriceConnector implements StorePriceWriteConnector {
  readonly store = 'appstoreconnect' as const;
  readonly #api: AppleProductsHttp;

  constructor(options: AppleProductPriceConnectorOptions) {
    this.#api = new AppleProductsHttp(options);
  }

  static fromSecret(
    secret: string,
    options: Omit<AppleProductPriceConnectorOptions, 'credential'>,
  ): AppleProductPriceConnector {
    return new AppleProductPriceConnector({
      ...options,
      credential: AppleProductsHttp.credentialOf(secret),
    });
  }

  #ref(product: StoreProductRef): string {
    if (!product.storeRef || !/^[A-Za-z0-9._~=-]{1,200}$/.test(product.storeRef)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the product is not known. Sync the app first.',
      );
    }
    return product.storeRef;
  }

  /** Price rows (resources with `startDate`, price point and territory) as readable rows, with the price point id. */
  #rows(prices: Json[], included: Json[], point: string, relation: string, planType: boolean) {
    const byId = (type: string) =>
      new Map(
        included.filter((i) => text(i.type) === type).map((i) => [text(i.id) ?? '', i] as const),
      );
    const points = byId(point);
    const territories = byId('territories');
    const out: Row[] = [];
    for (const price of prices) {
      const a = attrs(price);
      if (a.preserved === true) continue;
      const territory = relationId(price, 'territory');
      const pointId = relationId(price, relation);
      const p = pointId ? points.get(pointId) : undefined;
      const currency = cleanCurrency(
        territory ? attrs(territories.get(territory) ?? {}).currency : undefined,
      );
      const amount = p && currency ? decimalToMinor(attrs(p).customerPrice, currency) : undefined;
      if (!territory || !currency || !pointId || amount === undefined) continue;
      const pt = planType ? text(a.planType) : undefined;
      out.push({
        territory,
        currency,
        amount,
        startDate: day(a.startDate),
        endDate: day(a.endDate),
        pointId,
        planId: pt ? pt.toUpperCase() : null,
        manual: a.manual === true,
      });
    }
    return out;
  }

  /** The row in force today per territory (a manual one before an automatic one, then the latest start), and the rows that start later. */
  #split(rows: Row[], today: string, planId: string | null): LivePrices {
    const mine = rows.filter((r) => planId === null || r.planId === null || r.planId === planId);
    const current = new Map<string, Row>();
    const scheduled: ScheduledPrice[] = [];
    for (const r of mine) {
      if (r.startDate !== null && r.startDate > today) {
        scheduled.push({
          territory: r.territory,
          currency: r.currency,
          amount: r.amount,
          startDate: r.startDate,
          pricePointId: r.pointId,
        });
        continue;
      }
      if (r.endDate !== null && r.endDate <= today) continue;
      const old = current.get(r.territory);
      if (
        !old ||
        (r.manual && !old.manual) ||
        (r.manual === old.manual && (r.startDate ?? '') > (old.startDate ?? ''))
      )
        current.set(r.territory, r);
    }
    return {
      current: [...current.values()]
        .map(
          (r): CurrentPrice => ({ territory: r.territory, currency: r.currency, amount: r.amount }),
        )
        .sort((a, b) => (a.territory < b.territory ? -1 : 1)),
      scheduled: scheduled.sort((a, b) => (a.territory < b.territory ? -1 : 1)),
    };
  }

  async #read(product: StoreProductRef, planId: string | null, nowMs: number): Promise<ReadResult> {
    const id = this.#ref(product);
    const today = utcDate(nowMs);
    if (product.kind === 'subscription') {
      const listed = await this.#api.list(
        `/v1/subscriptions/${seg(id)}/prices?limit=200&include=subscriptionPricePoint,territory&fields[subscriptionPrices]=startDate,preserved,planType,territory,subscriptionPricePoint&fields[territories]=currency&fields[subscriptionPricePoints]=customerPrice`,
        'reading the prices of a subscription',
        { maxPages: 10, optional: true },
      );
      if (listed.missing)
        throw new PriceWriteError(
          'appstoreconnect',
          'product_not_found',
          'The store has no such subscription (any more). Sync the app again.',
          404,
        );
      if (listed.truncated)
        throw new StoreError(
          'appstoreconnect',
          'unexpected',
          'The prices of the subscription have too many pages to be read in full, so nothing was changed.',
        );
      const rows = this.#rows(
        listed.data,
        listed.included,
        'subscriptionPricePoints',
        'subscriptionPricePoint',
        true,
      );
      return {
        ...this.#split(rows, today, planId),
        baseTerritory: null,
        scheduleId: null,
        manual: [],
      };
    }
    const schedule = await this.#api.get(
      `/v2/inAppPurchases/${seg(id)}/iapPriceSchedule?include=baseTerritory&fields[territories]=currency`,
      'reading a price schedule',
      true,
    );
    const data = schedule && isRecord(schedule.data) ? schedule.data : undefined;
    const scheduleId = data ? text(data.id) : undefined;
    if (!data || !scheduleId)
      throw new PriceWriteError(
        'appstoreconnect',
        'product_not_found',
        'App Store Connect has no price schedule for the product.',
        404,
      );
    const rows: Row[] = [];
    for (const which of ['manualPrices', 'automaticPrices'] as const) {
      const listed = await this.#api.list(
        `/v1/inAppPurchasePriceSchedules/${seg(scheduleId)}/${which}?limit=200&include=inAppPurchasePricePoint,territory&fields[inAppPurchasePrices]=startDate,endDate,manual,inAppPurchasePricePoint,territory&fields[territories]=currency&fields[inAppPurchasePricePoints]=customerPrice`,
        'reading prices',
        { maxPages: 10, optional: true },
      );
      if (listed.truncated)
        throw new StoreError(
          'appstoreconnect',
          'unexpected',
          'The prices of the product have too many pages to be read in full, so nothing was changed.',
        );
      for (const r of this.#rows(
        listed.data,
        listed.included,
        'inAppPurchasePricePoints',
        'inAppPurchasePricePoint',
        false,
      ))
        rows.push({ ...r, manual: which === 'manualPrices' });
    }
    return {
      ...this.#split(rows, today, null),
      baseTerritory: relationId(data, 'baseTerritory') ?? null,
      scheduleId,
      manual: rows.filter((r) => r.manual),
    };
  }

  async readPrices(product: StoreProductRef, planId: string | null): Promise<LivePrices> {
    const { current, scheduled } = await this.#read(product, planId, this.#api.now());
    return { current, scheduled };
  }

  async pricePoints(
    product: StoreProductRef,
    territories: readonly string[],
  ): Promise<PricePoint[]> {
    const id = this.#ref(product);
    const unique = [...new Set(territories)]
      .filter((t) => /^[A-Z]{3}$/.test(t))
      .slice(0, MAX_TERRITORY_READS);
    const out: PricePoint[] = [];
    for (const territory of unique) {
      const path =
        product.kind === 'subscription'
          ? `/v1/subscriptions/${seg(id)}/pricePoints?filter[territory]=${territory}&include=territory&limit=200&fields[territories]=currency`
          : `/v2/inAppPurchases/${seg(id)}/pricePoints?filter[territory]=${territory}&include=territory&limit=200&fields[territories]=currency`;
      const listed = await this.#api.list(path, 'reading the price points of a product', {
        maxPages: 5,
        optional: true,
      });
      const currency = cleanCurrency(
        attrs(listed.included.find((i) => text(i.type) === 'territories') ?? {}).currency,
      );
      if (!currency) continue;
      for (const point of listed.data) {
        const pid = text(point.id);
        const amount = decimalToMinor(attrs(point).customerPrice, currency);
        if (pid && amount !== undefined) out.push({ id: pid, territory, currency, amount });
      }
    }
    return out;
  }

  /** Changing a base territory moves every territory that is priced from it: refused unless the change names all of them. */
  static baseTerritoryProblem(
    product: StoreProductRef,
    change: PriceChange,
    baseTerritory: string | null,
    live: LivePrices,
  ): string | null {
    if (product.kind === 'subscription' || baseTerritory === null) return null;
    if (!change.lines.some((l) => l.territory === baseTerritory)) return null;
    const named = new Set(change.lines.map((l) => l.territory));
    const unnamed = live.current.filter((c) => !named.has(c.territory)).length;
    return unnamed === 0
      ? null
      : `Changing the price in the base territory (${baseTerritory}) also changes the ${unnamed} territories that are priced from it. Add them to the change with their price points, or change the base price in App Store Connect.`;
  }

  async preview(
    product: StoreProductRef,
    change: PriceChange,
    nowMs: number,
  ): Promise<PricePreviewResult> {
    const id = this.#ref(product);
    if (product.kind !== 'subscription') {
      return {
        mode: 'local',
        lines: change.lines.map((l) => ({ territory: l.territory })),
        requests: [
          {
            method: 'POST',
            path: '/v1/inAppPurchasePriceSchedules',
            summary: `One price schedule for the product: ${change.lines.length} price(s) from price points${change.effectiveDate ? ` starting ${change.effectiveDate}` : ' starting at once'}, existing manual prices sent again unchanged.`,
          },
        ],
      };
    }
    const body = await this.#api.write(
      'POST',
      '/v1/subscriptionPriceChangePreviews',
      'previewing a subscription price change',
      {
        data: {
          type: 'subscriptionPriceChangePreviews',
          attributes: {
            proposedChanges: change.lines.map((l) => ({
              territoryId: l.territory,
              startDate: change.effectiveDate ?? utcDate(nowMs),
              basePricePointId: l.pricePointId,
            })),
          },
          relationships: { subscription: { data: { type: 'subscriptions', id } } },
        },
      },
    );
    if (!body.ok) throw new StoreError('appstoreconnect', 'network', body.message, body.status);
    const json = isRecord(body.json) ? body.json : {};
    const data = isRecord(json.data) ? json.data : {};
    const results =
      records(attrs(data).changeResults).length > 0
        ? records(attrs(data).changeResults)
        : records(data.changeResults);
    if (results.length === 0)
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'App Store Connect answered the preview with a response that could not be read.',
      );
    return {
      mode: 'store',
      lines: results.map((r) => {
        const changeType = text(r.changeType);
        return {
          territory: text(r.territoryId) ?? '',
          changeType,
          note:
            change.existingSubscribers === 'preserve' &&
            changeType !== undefined &&
            !SUB_PRICE_CHANGE.has(changeType) &&
            changeType !== 'NO_CHANGE'
              ? 'not_preservable'
              : undefined,
        };
      }),
      requests: [],
    };
  }

  async apply(
    product: StoreProductRef,
    change: PriceChange,
    guard: (live: LivePrices) => boolean,
    nowMs: number,
  ): Promise<PriceApplyResult> {
    const live = await this.#read(product, change.planId, nowMs);
    if (!guard(live)) throw new PriceDriftError('appstoreconnect', live);
    const today = utcDate(nowMs);
    return product.kind === 'subscription'
      ? this.#applySubscription(product, change, live, today)
      : this.#applyIap(product, change, live, today);
  }

  async #applySubscription(
    product: StoreProductRef,
    change: PriceChange,
    live: LivePrices,
    today: string,
  ): Promise<PriceApplyResult> {
    const id = this.#ref(product);
    const lines: PriceLineOutcome[] = [];
    let stop: string | null = null;
    for (const line of [...change.lines].sort((a, b) => (a.territory < b.territory ? -1 : 1))) {
      const territory = line.territory;
      if (stop) {
        lines.push({ territory, outcome: 'not_sent', message: stop });
        continue;
      }
      if (lineAlreadyApplied(change, live, territory, today)) {
        lines.push({ territory, outcome: 'already_applied' });
        continue;
      }
      const clash = live.scheduled.find((s) => s.territory === territory);
      if (clash) {
        lines.push({
          territory,
          outcome: 'failed',
          code: 'price_change_not_allowed',
          message: `A different price is already scheduled for ${territory} (from ${clash.startDate ?? 'now'}). Kiln never deletes a scheduled price: remove it in App Store Connect first.`,
        });
        continue;
      }
      const increase = BigInt(line.newAmount) > BigInt(line.currentAmount);
      const attributes: Json = { startDate: change.effectiveDate };
      if (change.existingSubscribers === 'preserve' && increase)
        attributes.preserveCurrentPrice = true;
      if (change.planId) attributes.planType = change.planId;
      try {
        const result = await this.#api.write(
          'POST',
          '/v1/subscriptionPrices',
          'scheduling a subscription price',
          {
            data: {
              type: 'subscriptionPrices',
              attributes,
              relationships: {
                subscription: { data: { type: 'subscriptions', id } },
                subscriptionPricePoint: {
                  data: { type: 'subscriptionPricePoints', id: line.pricePointId },
                },
              },
            },
          },
        );
        if (!result.ok) {
          lines.push({ territory, outcome: 'unknown', message: result.message });
          stop = 'An earlier request had an unknown outcome, so this one was not sent.';
        } else lines.push({ territory, outcome: 'applied' });
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        const code = priceCodeOf(error);
        lines.push({ territory, outcome: 'failed', code, message: error.message });
        if (code === 'rate_limited' || code === 'forbidden')
          stop = 'Not sent after the store refused an earlier request.';
      }
    }
    return { lines };
  }

  async #applyIap(
    product: StoreProductRef,
    change: PriceChange,
    live: ReadResult,
    today: string,
  ): Promise<PriceApplyResult> {
    const id = this.#ref(product);
    const fail = (code: PriceLineOutcome['code'], message: string): PriceApplyResult => ({
      lines: change.lines.map((l) => ({
        territory: l.territory,
        outcome: 'failed',
        code,
        message,
      })),
    });
    const pending = change.lines.filter(
      (l) => !lineAlreadyApplied(change, live, l.territory, today),
    );
    if (pending.length === 0)
      return {
        lines: change.lines.map((l) => ({ territory: l.territory, outcome: 'already_applied' })),
      };
    const base = live.baseTerritory;
    if (!base)
      return fail(
        'price_change_not_allowed',
        'App Store Connect did not say which territory the prices are based on, so nothing was changed.',
      );
    const problem = AppleProductPriceConnector.baseTerritoryProblem(product, change, base, live);
    if (problem) return fail('price_change_not_allowed', problem);
    const changed = new Set(pending.map((l) => l.territory));
    if (live.scheduled.some((s) => changed.has(s.territory)))
      return fail(
        'price_change_not_allowed',
        'A different price is already scheduled for one of these territories. Kiln never deletes a scheduled price: remove it in App Store Connect first.',
      );
    const keep = live.manual.filter(
      (r) =>
        !changed.has(r.territory) ||
        (change.effectiveDate !== null &&
          (r.endDate === null || r.endDate > change.effectiveDate) &&
          (r.startDate === null || r.startDate <= today)),
    );
    const rows = [
      ...keep.map((r) => ({
        pointId: r.pointId,
        startDate: r.startDate,
        endDate: changed.has(r.territory) ? change.effectiveDate : r.endDate,
      })),
      ...pending.map((l) => ({
        pointId: l.pricePointId as string,
        startDate: change.effectiveDate,
        endDate: null as string | null,
      })),
    ];
    const tmp = (i: number) => `\${price${i}}`;
    try {
      const result = await this.#api.write(
        'POST',
        '/v1/inAppPurchasePriceSchedules',
        'scheduling a price change',
        {
          data: {
            type: 'inAppPurchasePriceSchedules',
            relationships: {
              inAppPurchase: { data: { type: 'inAppPurchases', id } },
              baseTerritory: { data: { type: 'territories', id: base } },
              manualPrices: {
                data: rows.map((_, i) => ({ type: 'inAppPurchasePrices', id: tmp(i) })),
              },
            },
          },
          included: rows.map((r, i) => ({
            type: 'inAppPurchasePrices',
            id: tmp(i),
            attributes: { startDate: r.startDate, endDate: r.endDate },
            relationships: {
              inAppPurchasePricePoint: {
                data: { type: 'inAppPurchasePricePoints', id: r.pointId },
              },
            },
          })),
        },
      );
      const outcome = result.ok ? 'applied' : 'unknown';
      return {
        lines: change.lines.map((l) => ({
          territory: l.territory,
          outcome: pending.includes(l) ? outcome : 'already_applied',
          ...(result.ok ? {} : { message: result.message }),
        })),
      };
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      return fail(priceCodeOf(error), error.message);
    }
  }
}
