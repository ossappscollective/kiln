import { createHash } from 'node:crypto';
import type { StoreId } from '@mrm/core';
import { StoreError } from './errors.ts';

/**
 * In-app purchases and subscriptions, store independent (docs/api/products.md, docs/adr/0034-in-app-products.md).
 *
 * Apple has in-app purchases (consumable, non-consumable, non-renewing subscription) and auto-renewable subscriptions in groups; Google Play has
 * one-time products (purchase options) and subscriptions (base plans, offers). Only the connectors know that: everything else sees a
 * `StoreProduct` of kind `consumable`, `non_consumable` or `subscription`, with its localized display texts, its price per territory in MINOR
 * units (a string, so a big currency never loses digits) and the territories it is sold in.
 *
 * Reading is the whole of the read connectors. The one write that exists is `StoreProductWriteConnector.updateLocalization`: it changes the display
 * name and description of ONE locale of ONE product, behind the gates of the server's monetization module. No connector here changes a price,
 * an availability, a state, or creates or deletes a product.
 */

export const STORE_PRODUCT_KINDS = ['consumable', 'non_consumable', 'subscription'] as const;
export type StoreProductKind = (typeof STORE_PRODUCT_KINDS)[number];
export const isStoreProductKind = (value: unknown): value is StoreProductKind =>
  typeof value === 'string' && (STORE_PRODUCT_KINDS as readonly string[]).includes(value);

/**
 * Where a product stands, in words that fit both stores. `draft`: not offered yet (Apple: metadata missing or ready to submit;
 * Google: draft). `in_review`: with Apple's review. `action_needed`: Apple rejected it or asks for something. `active`: on sale.
 * `inactive`: no longer sold to new customers (Google). `removed`: taken off sale (Apple).
 */
export const STORE_PRODUCT_STATES = [
  'draft',
  'in_review',
  'action_needed',
  'active',
  'inactive',
  'removed',
  'unknown',
] as const;
export type StoreProductState = (typeof STORE_PRODUCT_STATES)[number];

export type StoreProductLocalization = {
  /** The locale as the store writes it: `en-US` (both stores use BCP-47 style tags; Apple's can be `es-MX`, `zh-Hans`). */
  locale: string;
  name: string;
  description: string;
  /** Apple: the id of the localization resource (what a change is sent to). Google Play has none: a listing is named by its language. */
  ref?: string | undefined;
};

export type StoreProductPrice = {
  /** Apple: the three-letter territory id (`USA`); Google Play: the two-letter region code (`US`). */
  territory: string;
  /** ISO 4217. */
  currency: string;
  /** The price in the currency's MINOR units, as a string of digits: `"499"` for 4.99 USD, `"500"` for 500 JPY. Tax excluded or included as the store says. */
  amount: string;
  /** Google Play: the base plan or purchase option the price belongs to. Apple: null. */
  planId: string | null;
};

export type StoreProductAvailability = {
  /** The territories the product is on sale in (the store's own codes, sorted). */
  territories: string[];
  /** Whether territories the store adds later get the product; null when the store does not say. */
  availableInNewTerritories: boolean | null;
};

/** A Google Play base plan or one-time purchase option. */
export type StoreProductPlan = {
  id: string;
  /** The store's own state (`ACTIVE`, `DRAFT`, `INACTIVE`, ...). */
  state: string;
  /** ISO 8601 billing period of a base plan (`P1M`); null for a purchase option. */
  period: string | null;
};

export type StoreProductOffer = { id: string; planId: string; state: string };

export type StoreProduct = {
  store: StoreId;
  /** The id a developer chooses and the app uses: Apple `productId`, Google Play `productId`. Unique within an app. */
  productId: string;
  /** Apple: the resource id of the in-app purchase or subscription (what its other resources are read with). Google Play: null. */
  storeRef: string | null;
  kind: StoreProductKind;
  /** The name only the developer sees (Apple: `name`; Google Play: the product id, because it has no reference name). */
  referenceName: string;
  state: StoreProductState;
  /** The store's own state, for display and for a state this code does not know. */
  rawState: string | null;
  localizations: StoreProductLocalization[];
  prices: StoreProductPrice[];
  /** Null when the store's answer had none (a product that is not priced yet). */
  availability: StoreProductAvailability | null;
  /** Apple subscriptions: the name of the subscription group. */
  group: string | null;
  /** Apple: the subscription period (`ONE_MONTH`); Google Play: the billing period of the first base plan (`P1M`). */
  period: string | null;
  /** Apple: the territory the prices are derived from (the price schedule's base territory); null when unknown. */
  baseTerritory: string | null;
  plans: StoreProductPlan[];
  offers: StoreProductOffer[];
};

export type ListProductsResult = {
  products: StoreProduct[];
  /** Plain sentences about what could not be read (a product without a price schedule, a cap that was reached). */
  warnings: string[];
  /** False when the read stopped at a cap: the list is not everything the store has. */
  complete: boolean;
};

/** Reads in-app purchases and subscriptions. Read only. */
export interface StoreProductsConnector {
  readonly store: StoreId;
  listProducts(): Promise<ListProductsResult>;
}

/** What names a product to a connector. */
export type StoreProductRef = { productId: string; kind: StoreProductKind; storeRef: string | null };

/** What `updateLocalization` is asked to do, and how it checks the store is still as the person saw it. */
export type ProductLocalizationUpdate = {
  product: StoreProductRef;
  locale: string;
  name: string;
  description: string;
  /**
   * Called with the localization as the store has it right before the write. Return false and nothing is written
   * (`ProductLocalizationDriftError`). The connector never writes without it.
   */
  guard: (current: StoreProductLocalization) => boolean;
};

export type ProductLocalizationResult = {
  before: StoreProductLocalization;
  after: StoreProductLocalization;
};

/**
 * Reads one localization and changes it. The only store write of this feature. A new locale cannot be added and a locale cannot be
 * removed: only the name and the description of one that exists. Never retried; a lost answer is `ProductOutcomeUnknownError`.
 */
export interface StoreProductWriteConnector {
  readonly store: StoreId;
  /** The localization as the store has it now, or undefined when the product has none for that locale. Changes nothing. */
  readLocalization(
    product: StoreProductRef,
    locale: string,
  ): Promise<StoreProductLocalization | undefined>;
  updateLocalization(input: ProductLocalizationUpdate): Promise<ProductLocalizationResult>;
}

/** The store's localization is not what the confirmation was made from. Nothing was written. */
export class ProductLocalizationDriftError extends StoreError {
  readonly current: StoreProductLocalization;
  constructor(store: StoreId, current: StoreProductLocalization) {
    super(
      store,
      'unexpected',
      'The store shows other texts than the ones that were previewed. Nothing was changed.',
    );
    this.name = 'ProductLocalizationDriftError';
    this.current = current;
  }
}

/** The product has no localization for the locale (adding one is not built). Nothing was written. */
export class ProductLocaleMissingError extends StoreError {
  readonly locale: string;
  constructor(store: StoreId, locale: string) {
    super(
      store,
      'not_found',
      `The product has no localization for ${locale}. Adding a locale is not built: add it in the store's console first.`,
    );
    this.name = 'ProductLocaleMissingError';
    this.locale = locale;
  }
}

/** The product is not in the store (any more). Nothing was written. */
export class ProductMissingError extends StoreError {
  constructor(store: StoreId) {
    super(store, 'not_found', 'The store has no such product (any more). Sync the app again.');
    this.name = 'ProductMissingError';
  }
}

/** The write was sent and the answer was lost: the store may or may not have applied it. The caller reads it back. */
export class ProductOutcomeUnknownError extends StoreError {
  constructor(store: StoreId, message: string, status?: number) {
    super(store, 'network', message, status);
    this.name = 'ProductOutcomeUnknownError';
  }
}

// ---------------------------------------------------------------------------------------------
// Money

/** Currencies with no minor unit (ISO 4217 exponent 0) and with three decimals. Every other currency has two. */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** The number of digits after the decimal point of a currency's minor unit: 0, 2 or 3. */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** A currency code as ISO 4217 writes it, or undefined. */
export const cleanCurrency = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined;

/** Divides `n` by `d` (both positive) and rounds half up. */
const divRound = (n: bigint, d: bigint): bigint => (n * 2n + d) / (d * 2n);

/**
 * A decimal string (`"4.99"`, `"500"`) as minor units (`"499"`, `"50000"` for a currency with two decimals). Rounds half up when the string has
 * more decimals than the currency. undefined for anything that is not a non-negative decimal number.
 */
export function decimalToMinor(value: unknown, currency: string): string | undefined {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*(\d{1,15})(?:\.(\d{1,12}))?\s*$/.exec(raw);
  if (!match) return undefined;
  const exponent = currencyExponent(currency);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const digits = BigInt(whole + fraction);
  const scale = fraction.length;
  if (scale === exponent) return digits.toString();
  if (scale < exponent) return (digits * 10n ** BigInt(exponent - scale)).toString();
  return divRound(digits, 10n ** BigInt(scale - exponent)).toString();
}

/** A Google `Money` (`{ currencyCode, units, nanos }`) as a price amount in minor units, or undefined when it is not a non-negative amount. */
export function moneyToPrice(money: unknown): { currency: string; amount: string } | undefined {
  if (typeof money !== 'object' || money === null) return undefined;
  const m = money as Record<string, unknown>;
  const currency = cleanCurrency(m.currencyCode);
  if (!currency) return undefined;
  const unitsText = typeof m.units === 'number' ? String(m.units) : m.units;
  const units = unitsText === undefined || unitsText === '' ? '0' : unitsText;
  if (typeof units !== 'string' || !/^-?\d{1,15}$/.test(units)) return undefined;
  const nanos = m.nanos === undefined ? 0 : m.nanos;
  if (typeof nanos !== 'number' || !Number.isInteger(nanos) || Math.abs(nanos) > 999_999_999)
    return undefined;
  const total = BigInt(units) * 1_000_000_000n + BigInt(nanos);
  if (total < 0n) return undefined;
  const exponent = currencyExponent(currency);
  return { currency, amount: divRound(total, 10n ** BigInt(9 - exponent)).toString() };
}

/** `"499"` and `USD` as `"4.99"`: the amount for a person to read, without a currency symbol. */
export function formatMinor(amount: string, currency: string): string {
  const exponent = currencyExponent(currency);
  if (!/^\d+$/.test(amount)) return amount;
  if (exponent === 0) return amount.replace(/^0+(?=\d)/, '');
  const padded = amount.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent).replace(/^0+(?=\d)/, '');
  return `${whole}.${padded.slice(padded.length - exponent)}`;
}

// ---------------------------------------------------------------------------------------------
// Hashes and small rules

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The hash of the two texts of one localization: what a preview is made from and an apply is checked against. Never the text itself. */
export const localizationHash = (name: string, description: string): string =>
  sha256(JSON.stringify([name, description]));

/** A stable hash of a product as read, to tell whether a sync changed anything. Order independent for lists. */
export function productHash(product: StoreProduct): string {
  const byKey = <T>(items: readonly T[], key: (item: T) => string): T[] =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return sha256(
    JSON.stringify({
      s: product.store,
      p: product.productId,
      r: product.storeRef,
      k: product.kind,
      n: product.referenceName,
      st: product.state,
      rs: product.rawState,
      l: byKey(product.localizations, (x) => x.locale).map((x) => [
        x.locale,
        x.name,
        x.description,
        x.ref ?? null,
      ]),
      pr: byKey(product.prices, (x) => `${x.planId ?? ''}\u0000${x.territory}`).map((x) => [
        x.planId,
        x.territory,
        x.currency,
        x.amount,
      ]),
      av: product.availability && [
        [...product.availability.territories].sort(),
        product.availability.availableInNewTerritories,
      ],
      g: product.group,
      pe: product.period,
      b: product.baseTerritory,
      pl: byKey(product.plans, (x) => x.id).map((x) => [x.id, x.state, x.period]),
      o: byKey(product.offers, (x) => `${x.planId}\u0000${x.id}`).map((x) => [
        x.id,
        x.planId,
        x.state,
      ]),
    }),
  );
}

/** A locale as both stores write it: letters, digits and hyphens (`en-US`, `es-419`, `zh-Hans`, `pt_BR` is read as `pt-BR`). */
export function cleanLocale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().replace(/_/g, '-');
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v) ? v : undefined;
}

/** Locales are compared case-insensitively: `en-us` is `en-US`. */
export const sameLocale = (a: string, b: string): boolean =>
  a.replace(/_/g, '-').toLowerCase() === b.replace(/_/g, '-').toLowerCase();

/** A product id of either store: Apple's letters, digits, `_` and `.`; Google Play's lowercase letters, digits, `_` and `.`. */
export const isStoreProductId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(value);

/** Sorted, distinct, trimmed. */
export const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();
