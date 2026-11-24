import type { CurrentPrice, PriceChange, PricePoint, StoreId } from '@kiln/core';
import { StoreError } from './errors.ts';
import type { StoreProductRef } from './store-products-types.ts';

/**
 * Price writes of in-app purchases and subscriptions (docs/adr/0062-price-writes.md). The only connectors that can change what a customer pays.
 * Called only by the server's price service, after the gates (switch, workspace setting, right, step-up, typed phrase), a re-validation, and
 * a LIVE read of the prices. Never retried. A lost answer is `outcome: 'unknown'` for the lines it may have covered; the caller reads back.
 */

/** Codes the server translates into a plain sentence. Never a store's own text as the only explanation. */
export const PRICE_WRITE_CODES = [
  'product_not_found',
  'price_point_invalid',
  'price_change_not_allowed',
  'existing_subscriber_rule',
  'unsupported_territory',
  'rate_limited',
  'forbidden',
  'rejected',
] as const;
export type PriceWriteCode = (typeof PRICE_WRITE_CODES)[number];

export class PriceWriteError extends StoreError {
  readonly priceCode: PriceWriteCode;
  readonly territory?: string | undefined;
  constructor(
    store: StoreId,
    priceCode: PriceWriteCode,
    message: string,
    status?: number,
    territory?: string,
  ) {
    super(
      store,
      priceCode === 'rate_limited'
        ? 'rate_limited'
        : priceCode === 'product_not_found'
          ? 'not_found'
          : 'unexpected',
      message,
      status,
    );
    this.name = 'PriceWriteError';
    this.priceCode = priceCode;
    this.territory = territory;
  }
}

/** The live prices differ from what the person saw: nothing was written. */
export class PriceDriftError extends StoreError {
  readonly live: LivePrices;
  constructor(store: StoreId, live: LivePrices) {
    super(
      store,
      'unexpected',
      'The store shows other prices than the ones that were reviewed. Nothing was changed.',
    );
    this.name = 'PriceDriftError';
    this.live = live;
  }
}

/** A price already scheduled for a later date (Apple). */
export type ScheduledPrice = {
  territory: string;
  currency: string;
  amount: string;
  startDate: string | null;
  pricePointId?: string | undefined;
};

export type LivePrices = {
  /** In force now, one per territory (of the plan or purchase option for Google Play). */
  current: CurrentPrice[];
  /** Apple: prices set for a later date. Empty for Google Play. */
  scheduled: ScheduledPrice[];
};

export type PriceLineOutcome = {
  territory: string;
  /** `applied`: written. `already_applied`: the store already had exactly this (nothing sent). `failed`: refused, nothing changed for this line. `unknown`: sent, answer lost. `not_sent`: left out on purpose after an earlier line was refused for rate limiting or had an unknown outcome. */
  outcome: 'applied' | 'already_applied' | 'failed' | 'unknown' | 'not_sent';
  code?: PriceWriteCode | undefined;
  message?: string | undefined;
};

export type PriceApplyResult = {
  lines: PriceLineOutcome[];
  /** Google Play subscriptions: whether the existing-subscriber migration (opt-in or opt-out) was requested, and its outcome. */
  migration?:
    | {
        requested: boolean;
        outcome: 'applied' | 'failed' | 'unknown' | 'not_sent';
        code?: PriceWriteCode | undefined;
        message?: string | undefined;
      }
    | undefined;
};

export type PricePreviewLine = {
  territory: string;
  changeType?: string | undefined;
  note?: string | undefined;
};
export type PricePreviewResult = {
  /** `store`: the store's own validation ran (nothing saved). `local`: the store has no validation call; `requests` is what would be sent. */
  mode: 'store' | 'local';
  lines: PricePreviewLine[];
  requests: { method: 'POST' | 'PATCH'; path: string; summary: string }[];
};

export type ConvertedPrices = { prices: CurrentPrice[]; regionsVersion: string | null };

export interface StorePriceWriteConnector {
  readonly store: StoreId;
  /** The prices as the store has them now. Changes nothing. */
  readPrices(product: StoreProductRef, planId: string | null): Promise<LivePrices>;
  /** Apple: the price points of the product in the given territories (`customerPrice` as minor units). Google Play: none. */
  pricePoints(product: StoreProductRef, territories: readonly string[]): Promise<PricePoint[]>;
  /** Google Play: regional prices derived from one base price (`pricing:convertRegionPrices`; changes nothing). Apple: undefined (use price points). */
  convertFromBase?(base: { currency: string; amount: string }): Promise<ConvertedPrices>;
  /** The store's validation where one exists (Apple subscriptions), else what would be sent. Changes nothing. */
  preview(
    product: StoreProductRef,
    change: PriceChange,
    nowMs: number,
  ): Promise<PricePreviewResult>;
  /** Writes. `guard` gets the live prices read right before the write; false and nothing is written (`PriceDriftError`). */
  apply(
    product: StoreProductRef,
    change: PriceChange,
    guard: (live: LivePrices) => boolean,
    nowMs: number,
  ): Promise<PriceApplyResult>;
}

/**
 * A store error of a price call as a price code. Status and the store's own detail words decide; the message is the already redacted one.
 * Nothing here ever echoes a request body.
 */
export function priceCodeOf(error: StoreError): PriceWriteCode {
  const words = [
    error.message,
    ...(error.details ?? []).map((d) => `${d.code ?? ''} ${d.title ?? ''} ${d.detail ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();
  if (error.kind === 'rate_limited' || error.status === 429) return 'rate_limited';
  if (error.kind === 'not_found' || error.status === 404) return 'product_not_found';
  if (
    error.kind === 'forbidden' ||
    error.kind === 'auth' ||
    error.status === 403 ||
    error.status === 401
  )
    return 'forbidden';
  if (/unsupported_territory|territory|region/.test(words)) return 'unsupported_territory';
  if (/price.?point/.test(words)) return 'price_point_invalid';
  if (/preserv|subscriber|opt.?in|opt.?out|price.?increase/.test(words))
    return 'existing_subscriber_rule';
  if (error.status === 409 || /already|schedul|cannot|not allowed|conflict/.test(words))
    return 'price_change_not_allowed';
  return 'rejected';
}

/**
 * Whether the store now shows what the change asked for (read after write). A price with an effective date is confirmed when it is
 * SCHEDULED for that date (Apple) and, once the date has passed, when it is current. Returns the lines that do not match, with what the store shows.
 */
export function priceMismatches(
  change: PriceChange,
  live: LivePrices,
  today: string,
): { territory: string; expected: string; actual: string | null }[] {
  const out: { territory: string; expected: string; actual: string | null }[] = [];
  for (const line of change.lines) {
    const now = live.current.find((c) => c.territory === line.territory);
    const later = live.scheduled.find(
      (s) =>
        s.territory === line.territory &&
        s.amount === line.newAmount &&
        (s.startDate ?? '') === (change.effectiveDate ?? ''),
    );
    const due = change.effectiveDate === null || change.effectiveDate <= today;
    const ok = (due && now?.amount === line.newAmount) || (!due && later !== undefined);
    if (!ok)
      out.push({
        territory: line.territory,
        expected: line.newAmount,
        actual: due ? (now?.amount ?? null) : (later?.amount ?? now?.amount ?? null),
      });
  }
  return out;
}

/** Whether the store already has exactly this line (idempotency: nothing is sent twice). */
export function lineAlreadyApplied(
  change: PriceChange,
  live: LivePrices,
  territory: string,
  today: string,
): boolean {
  const line = change.lines.find((l) => l.territory === territory);
  if (!line) return false;
  return priceMismatches({ ...change, lines: [line] }, live, today).length === 0;
}
