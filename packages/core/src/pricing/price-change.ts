import type { StoreId } from '../platform.ts';

/**
 * Price changes of in-app purchases and subscriptions (docs/adr/0062-price-writes.md). PURE: no store, no database, no clock of its own.
 * Money is a string of MINOR units (`"499"` is 4.99 USD) moved with BigInt, never a float; the web bundle imports this file, so there are no
 * BigInt literals and no `**` on BigInt (the build target is old). Everything the server enforces is here, so the screen can show the same
 * answer before anything is staged. The server runs it again on every stage and again right before a push: the client is never trusted.
 */

export const PRICE_PRODUCT_KINDS = ['consumable', 'non_consumable', 'subscription'] as const;
export type PriceProductKind = (typeof PRICE_PRODUCT_KINDS)[number];

/**
 * What happens to people who already pay the old price.
 * - `preserve`: they keep it (Apple: `preserveCurrentPrice: true`, only honoured for an increase; Google Play: no migration call, so old price cohorts stay).
 * - `apply`: Apple only. They move to the new price at their next renewal, after the notice and consent Apple requires.
 * - `opt_in` / `opt_out`: Google Play only. Existing subscribers are migrated to the new price, and must accept it (`opt_in`) or are notified and may refuse (`opt_out`).
 * - `not_applicable`: an in-app purchase that is bought once.
 */
export const SUBSCRIBER_RULES = ['preserve', 'apply', 'opt_in', 'opt_out', 'not_applicable'] as const;
export type SubscriberRule = (typeof SUBSCRIBER_RULES)[number];

/** Acknowledgements a person gives on purpose; each one is required by a rule below. */
export const PRICE_ACKS = ['large_change', 'large_absolute', 'existing_subscribers'] as const;
export type PriceAck = (typeof PRICE_ACKS)[number];

export type PriceLine = {
  /** Apple: three-letter territory id (`USA`). Google Play: two-letter region code (`US`). */
  territory: string;
  /** ISO 4217. */
  currency: string;
  /** The price the person saw when staging, in minor units. */
  currentAmount: string;
  /** The wanted price, in minor units. */
  newAmount: string;
  /** Apple: the price point (a store-defined tier) that carries `newAmount`. Never set for Google Play. */
  pricePointId?: string | undefined;
};

export type PriceChange = {
  store: StoreId;
  productId: string;
  kind: PriceProductKind;
  /** Google Play: the base plan of a subscription (null for a one-time product). Apple: null. */
  planId: string | null;
  /** Apple: the territory the equalized prices come from; kept for display and for the connector. */
  baseTerritory: string | null;
  lines: PriceLine[];
  /** `YYYY-MM-DD` (UTC date), or null for "as soon as the store allows". */
  effectiveDate: string | null;
  existingSubscribers: SubscriberRule;
  acknowledgements: PriceAck[];
};

/** An Apple price point as read from the store: a fixed price in one territory. */
export type PricePoint = { id: string; territory: string; currency: string; amount: string };
/** What the store shows now for one territory. */
export type CurrentPrice = { territory: string; currency: string; amount: string };

export type PriceLimits = {
  /** A change above this share (basis points: 5000 is 50%) of the current price, up or down, needs `large_change`. */
  relativeBp: number;
  /** A change above this many MAJOR units (per line, absolute) needs `large_absolute`. Per-currency values override the default. */
  absoluteMajor: number;
  absoluteMajorByCurrency: Readonly<Record<string, number>>;
  /** At most this many territories in one change. */
  maxTerritories: number;
  /** No price above this many major units, whatever the acknowledgements say. */
  maxPriceMajor: number;
};

/** Rough magnitude of one USD in currencies whose unit is small, so the default absolute guard is not meaningless for them. */
const SMALL_UNIT: Readonly<Record<string, number>> = {
  JPY: 100, KRW: 1000, IDR: 10000, VND: 20000, CLP: 1000, COP: 4000, HUF: 300, PYG: 7000, UGX: 3500, TZS: 2500, IQD: 1300,
  LAK: 20000, MMK: 2000, KHR: 4000, NGN: 1000, PKR: 280, BDT: 110, LKR: 300, RWF: 1300, GNF: 8500, MGA: 4500, XAF: 600,
  XOF: 600, CRC: 500, ARS: 1000, ISK: 140, INR: 83, PHP: 56, RUB: 90, CZK: 23, TWD: 32, THB: 35,
};

export const DEFAULT_PRICE_LIMITS: PriceLimits = {
  relativeBp: 5000,
  absoluteMajor: 100,
  absoluteMajorByCurrency: Object.keys(SMALL_UNIT).reduce<Record<string, number>>((out, code) => {
    out[code] = 100 * (SMALL_UNIT[code] as number);
    return out;
  }, {}),
  maxTerritories: 50,
  maxPriceMajor: 100000,
};

// ---------------------------------------------------------------------------------------------
// Money

const ZERO_DIGITS = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const THREE_DIGITS = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];

/** The digits after the decimal point of a currency's minor unit: 0, 2 or 3. */
export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  return ZERO_DIGITS.indexOf(code) >= 0 ? 0 : THREE_DIGITS.indexOf(code) >= 0 ? 3 : 2;
}

const big = (value: string | number): bigint => BigInt(value);
const ZERO = BigInt(0);
const pow10 = (n: number): bigint => {
  let out = BigInt(1);
  for (let i = 0; i < n; i++) out = out * BigInt(10);
  return out;
};
const isDigits = (value: unknown): value is string => typeof value === 'string' && /^\d{1,18}$/.test(value);

/**
 * A decimal text (`"4.99"`, `"500"`) as minor units. NEVER rounds: more decimals than the currency has is undefined, so a person typing
 * `4.999` is told, not silently given 5.00. A comma is not accepted as a separator (the screen converts before it calls this).
 */
export function parseDecimalMinor(text: string, currency: string): string | undefined {
  const match = /^(\d{1,12})(?:\.(\d{1,9}))?$/.exec(text.trim());
  if (!match) return undefined;
  const digits = currencyDigits(currency);
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return undefined;
  return big(`${match[1]}${fraction.padEnd(digits, '0')}`).toString();
}

/** Minor units as an exact decimal text (`"499"` USD is `"4.99"`). */
export function minorToDecimal(amount: string, currency: string): string {
  const digits = currencyDigits(currency);
  const padded = amount.replace(/^0+(?=\d)/, '').padStart(digits + 1, '0');
  return digits === 0 ? padded : `${padded.slice(0, padded.length - digits)}.${padded.slice(padded.length - digits)}`;
}

/** Google Play's `Money`: whole `units` as a string and `nanos` (billionths) as an integer. */
export type PlayMoney = { currencyCode: string; units: string; nanos: number };

export function minorToPlayMoney(amount: string, currency: string): PlayMoney {
  const digits = currencyDigits(currency);
  const total = big(amount);
  const unit = pow10(digits);
  const units = total / unit;
  const nanos = (total % unit) * pow10(9 - digits);
  return { currencyCode: currency.toUpperCase(), units: units.toString(), nanos: Number(nanos) };
}

/** `Money` as minor units, or undefined when it has more precision than the currency (a cent and a half is not a price). */
export function playMoneyToMinor(money: { currencyCode?: unknown; units?: unknown; nanos?: unknown }): string | undefined {
  if (typeof money.currencyCode !== 'string') return undefined;
  const units = typeof money.units === 'string' || typeof money.units === 'number' ? String(money.units) : '0';
  const nanos = typeof money.nanos === 'number' ? money.nanos : 0;
  if (!/^\d{1,15}$/.test(units) || !Number.isInteger(nanos) || nanos < 0 || nanos > 999999999) return undefined;
  const digits = currencyDigits(money.currencyCode);
  const step = pow10(9 - digits);
  if (BigInt(nanos) % step !== ZERO) return undefined;
  return (big(units) * pow10(digits) + BigInt(nanos) / step).toString();
}

/** Change in basis points of the current price, rounded half away from zero. Undefined when the current price is not positive. */
export function changeBp(current: string, next: string): number | undefined {
  if (!isDigits(current) || !isDigits(next)) return undefined;
  const cur = big(current);
  if (cur <= ZERO) return undefined;
  const delta = (big(next) - cur) * BigInt(10000);
  const sign = delta < ZERO ? BigInt(-1) : BigInt(1);
  const abs = delta < ZERO ? -delta : delta;
  return Number(sign * ((abs * BigInt(2) + cur) / (cur * BigInt(2))));
}

/** `+12.5%` / `-3%` for a change in basis points; digits only, no locale (the screen formats with its own helpers). */
export const percentLabel = (bp: number): string => {
  const sign = bp > 0 ? '+' : bp < 0 ? '-' : '';
  const abs = Math.abs(bp);
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${whole}${rest === 0 ? '' : `.${String(rest).padStart(2, '0').replace(/0$/, '')}`}%`;
};

// ---------------------------------------------------------------------------------------------
// Price points (Apple)

/** The `count` price points of a territory nearest to `amount` (ties: the lower one first). Never picks for the caller. */
export function nearestPricePoints(points: readonly PricePoint[], territory: string, amount: string, count = 4): PricePoint[] {
  if (!isDigits(amount)) return [];
  const target = big(amount);
  const own = points.filter((p) => p.territory === territory && isDigits(p.amount));
  const dist = (p: PricePoint) => {
    const d = big(p.amount) - target;
    return d < ZERO ? -d : d;
  };
  return own
    .slice()
    .sort((a, b) => {
      const da = dist(a);
      const db = dist(b);
      return da < db ? -1 : da > db ? 1 : big(a.amount) < big(b.amount) ? -1 : 1;
    })
    .slice(0, count);
}

// ---------------------------------------------------------------------------------------------
// Validation

export type PriceIssueCode =
  | 'no_lines'
  | 'too_many_territories'
  | 'duplicate_territory'
  | 'bad_territory'
  | 'bad_product'
  | 'bad_amount'
  | 'not_positive'
  | 'too_high'
  | 'no_change'
  | 'currency_mismatch'
  | 'unknown_territory'
  | 'price_point_missing'
  | 'price_point_unknown'
  | 'price_point_territory'
  | 'price_point_mismatch'
  | 'amount_not_price_point'
  | 'price_point_not_allowed'
  | 'plan_missing'
  | 'plan_not_allowed'
  | 'effective_date_invalid'
  | 'effective_date_past'
  | 'effective_date_unsupported'
  | 'subscriber_rule_invalid'
  | 'ack_required'
  | 'ack_unknown'
  | 'stale_price';

export type PriceIssue = {
  code: PriceIssueCode;
  territory?: string;
  /** `ack_required`: the acknowledgements still missing. `amount_not_price_point`: the nearest price points. */
  detail?: { acks?: PriceAck[]; nearest?: PricePoint[]; expected?: string; actual?: string };
};

export type PriceContext = {
  /** What the store showed when this was checked (the stored snapshot at staging, the live read at publish). */
  current: readonly CurrentPrice[];
  /** Apple: the price points of the product, per territory. Required for Apple. */
  pricePoints?: readonly PricePoint[] | undefined;
  /** `YYYY-MM-DD`, today in UTC. */
  today: string;
  limits?: PriceLimits | undefined;
};

export const SUBSCRIBER_RULES_BY_KIND = (store: StoreId, kind: PriceProductKind): readonly SubscriberRule[] =>
  kind !== 'subscription' ? ['not_applicable'] : store === 'appstoreconnect' ? ['preserve', 'apply'] : ['preserve', 'opt_in', 'opt_out'];

/** Only Apple can schedule a price for a later date; Google Play applies a price when the write succeeds. */
export const storeSchedulesPrices = (store: StoreId): boolean => store === 'appstoreconnect';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Today's date in UTC as `YYYY-MM-DD`. */
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const absoluteLimitMinor = (currency: string, limits: PriceLimits): bigint => {
  const major = limits.absoluteMajorByCurrency[currency.toUpperCase()] ?? limits.absoluteMajor;
  return BigInt(Math.max(1, Math.floor(major))) * pow10(currencyDigits(currency));
};

/** The acknowledgements this change needs, from its own numbers. The caller compares them with the ones given. */
export function requiredAcknowledgements(change: PriceChange, limits: PriceLimits = DEFAULT_PRICE_LIMITS): PriceAck[] {
  const need = new Set<PriceAck>();
  for (const line of change.lines) {
    if (!isDigits(line.currentAmount) || !isDigits(line.newAmount)) continue;
    const bp = changeBp(line.currentAmount, line.newAmount);
    if (bp !== undefined && Math.abs(bp) > limits.relativeBp) need.add('large_change');
    const delta = big(line.newAmount) - big(line.currentAmount);
    if ((delta < ZERO ? -delta : delta) > absoluteLimitMinor(line.currency, limits)) need.add('large_absolute');
  }
  if (change.kind === 'subscription' && change.existingSubscribers !== 'preserve' && change.existingSubscribers !== 'not_applicable') {
    need.add('existing_subscribers');
  }
  return PRICE_ACKS.filter((a) => need.has(a));
}

const TERRITORY: Readonly<Record<StoreId, RegExp>> = { appstoreconnect: /^[A-Z]{3}$/, googleplay: /^[A-Z]{2}$/ };

/**
 * Every problem of a change, or an empty list. Order is stable. Nothing is rounded or picked for the person: an Apple amount that is not a price
 * point of the territory is refused with the nearest points. The same call runs at staging, in the dry run and right before the push.
 */
export function validatePriceChange(change: PriceChange, ctx: PriceContext): PriceIssue[] {
  const limits = ctx.limits ?? DEFAULT_PRICE_LIMITS;
  const issues: PriceIssue[] = [];
  const add = (code: PriceIssueCode, territory?: string, detail?: PriceIssue['detail']) =>
    issues.push({ code, ...(territory === undefined ? {} : { territory }), ...(detail === undefined ? {} : { detail }) });
  const apple = change.store === 'appstoreconnect';

  if (!/^[A-Za-z0-9._-]{1,200}$/.test(change.productId) || (PRICE_PRODUCT_KINDS as readonly string[]).indexOf(change.kind) < 0) add('bad_product');
  if (change.lines.length === 0) add('no_lines');
  if (change.lines.length > limits.maxTerritories) add('too_many_territories', undefined, { expected: String(limits.maxTerritories), actual: String(change.lines.length) });

  // Plan (Google Play subscriptions) and the date.
  if (!apple && change.kind === 'subscription' && !change.planId) add('plan_missing');
  if ((apple || change.kind !== 'subscription') && change.planId) add('plan_not_allowed');
  if (change.effectiveDate !== null) {
    if (!isCalendarDate(change.effectiveDate)) add('effective_date_invalid');
    else if (!storeSchedulesPrices(change.store)) add('effective_date_unsupported');
    else if (change.effectiveDate < ctx.today) add('effective_date_past');
  }
  if (SUBSCRIBER_RULES_BY_KIND(change.store, change.kind).indexOf(change.existingSubscribers) < 0) add('subscriber_rule_invalid');
  for (const ack of change.acknowledgements) if ((PRICE_ACKS as readonly string[]).indexOf(ack) < 0) add('ack_unknown');

  const seen = new Set<string>();
  for (const line of change.lines) {
    const t = line.territory;
    if (!TERRITORY[change.store].test(t)) {
      add('bad_territory', t);
      continue;
    }
    if (seen.has(t)) add('duplicate_territory', t);
    seen.add(t);
    const now = ctx.current.find((c) => c.territory === t);
    if (!isDigits(line.newAmount) || !isDigits(line.currentAmount)) {
      add('bad_amount', t);
      continue;
    }
    if (big(line.newAmount) <= ZERO) add('not_positive', t);
    else if (big(line.newAmount) > BigInt(limits.maxPriceMajor) * pow10(currencyDigits(line.currency))) add('too_high', t);
    if (!/^[A-Z]{3}$/.test(line.currency)) add('currency_mismatch', t, { expected: now?.currency ?? '', actual: line.currency });
    else if (!now) add('unknown_territory', t);
    else {
      if (now.currency !== line.currency) add('currency_mismatch', t, { expected: now.currency, actual: line.currency });
      if (now.amount !== line.currentAmount) add('stale_price', t, { expected: line.currentAmount, actual: now.amount });
    }
    if (line.newAmount === line.currentAmount) add('no_change', t);
    if (apple) {
      if (!line.pricePointId) add('price_point_missing', t);
      else {
        const point = ctx.pricePoints?.find((p) => p.id === line.pricePointId);
        if (!point) add('price_point_unknown', t);
        else if (point.territory !== t) add('price_point_territory', t);
        else if (point.currency !== line.currency || point.amount !== line.newAmount) {
          add('price_point_mismatch', t, { expected: point.amount, actual: line.newAmount });
        }
      }
      if (!ctx.pricePoints?.some((p) => p.territory === t && p.amount === line.newAmount)) {
        add('amount_not_price_point', t, { nearest: nearestPricePoints(ctx.pricePoints ?? [], t, line.newAmount) });
      }
    } else if (line.pricePointId) add('price_point_not_allowed', t);
  }

  const missing = requiredAcknowledgements(change, limits).filter((a) => change.acknowledgements.indexOf(a) < 0);
  if (missing.length > 0) add('ack_required', undefined, { acks: missing });
  return issues;
}

/** Only the check that the store still shows what the person saw (run again with the LIVE read right before a push). */
export function staleLines(change: PriceChange, live: readonly CurrentPrice[]): PriceIssue[] {
  const out: PriceIssue[] = [];
  for (const line of change.lines) {
    const now = live.find((c) => c.territory === line.territory);
    if (!now) out.push({ code: 'unknown_territory', territory: line.territory });
    else if (now.currency !== line.currency) out.push({ code: 'currency_mismatch', territory: line.territory, detail: { expected: now.currency, actual: line.currency } });
    else if (now.amount !== line.currentAmount) out.push({ code: 'stale_price', territory: line.territory, detail: { expected: line.currentAmount, actual: now.amount } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Summary

export type PriceDiffLine = {
  territory: string;
  currency: string;
  before: string;
  after: string;
  /** Signed difference in minor units, as text. */
  deltaMinor: string;
  /** Basis points of the current price (null when the current price is not positive). */
  percentBp: number | null;
  direction: 'increase' | 'decrease' | 'same';
};

export type PriceSummary = {
  lines: PriceDiffLine[];
  /** Currencies in play: amounts of different currencies are never added. */
  currencies: string[];
  /** The largest absolute change in basis points over the lines (0 when none can be computed). */
  largestBp: number;
  /** Signed value of the line with the largest absolute change. */
  largestSignedBp: number;
  increases: number;
  decreases: number;
};

export function summarizePriceChange(change: PriceChange): PriceSummary {
  const lines: PriceDiffLine[] = change.lines.map((l) => {
    const ok = isDigits(l.currentAmount) && isDigits(l.newAmount);
    const delta = ok ? big(l.newAmount) - big(l.currentAmount) : ZERO;
    return {
      territory: l.territory,
      currency: l.currency,
      before: l.currentAmount,
      after: l.newAmount,
      deltaMinor: delta.toString(),
      percentBp: ok ? (changeBp(l.currentAmount, l.newAmount) ?? null) : null,
      direction: delta > ZERO ? 'increase' : delta < ZERO ? 'decrease' : 'same',
    };
  });
  let largestBp = 0;
  let largestSignedBp = 0;
  for (const l of lines) {
    if (l.percentBp !== null && Math.abs(l.percentBp) > largestBp) {
      largestBp = Math.abs(l.percentBp);
      largestSignedBp = l.percentBp;
    }
  }
  const currencies = lines.map((l) => l.currency).filter((c, i, all) => all.indexOf(c) === i).sort();
  return {
    lines,
    currencies,
    largestBp,
    largestSignedBp,
    increases: lines.filter((l) => l.direction === 'increase').length,
    decreases: lines.filter((l) => l.direction === 'decrease').length,
  };
}

/** A stable text of the parts of a change that matter, for hashing (the server hashes it; the web never needs to). */
export function canonicalPriceChange(change: PriceChange): string {
  const lines = change.lines
    .slice()
    .sort((a, b) => (a.territory < b.territory ? -1 : 1))
    .map((l) => [l.territory, l.currency, l.currentAmount, l.newAmount, l.pricePointId ?? ''].join(':'))
    .join(',');
  return [change.store, change.productId, change.kind, change.planId ?? '', change.effectiveDate ?? '', change.existingSubscribers, lines].join('|');
}

/**
 * The phrase a person types to send prices: it names the number of products and the largest change, so it cannot be typed by habit
 * (`CHANGE 3 PRICES MAX 42%`; the percentage is rounded up to a whole percent). The server computes it from the items it loaded.
 */
export function priceConfirmationPhrase(products: number, largestBp: number): string {
  return `CHANGE ${products} ${products === 1 ? 'PRICE' : 'PRICES'} MAX ${Math.ceil(largestBp / 100)}%`;
}
export const samePhrase = (typed: string, expected: string): boolean => typed.trim().replace(/\s+/g, ' ') === expected;
