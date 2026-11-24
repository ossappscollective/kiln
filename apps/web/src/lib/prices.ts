import {
  can,
  changeBp,
  DEFAULT_PRICE_LIMITS,
  type PriceChange,
  type PriceLimits,
  parseDecimalMinor,
  percentLabel,
  priceConfirmationPhrase,
  requiredAcknowledgements,
  SUBSCRIBER_RULES_BY_KIND,
  type Role,
} from '@kiln/core';
import { ApiError } from './api.ts';
import { formatMinorUnits } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import { stepUpMessage } from './step-up.ts';
import type {
  PriceAck,
  PriceIssueView,
  PriceStageRequest,
  PriceSubscriberRule,
  PriceWriteView,
  ProductKind,
  StagedPriceChange,
} from './types.ts';

/**
 * Price changes, pure (docs/adr/0062-price-writes.md): reading what a person typed as money (never rounded), the change of each territory,
 * the acknowledgements the screen shows ahead of the server (the server decides), why price editing is unavailable, the typed phrase and the
 * words for the store's answers. Amounts are minor units as text, moved with BigInt by the core; currencies are never added together.
 */

export const PRICE_ENV = 'KILN_PRICE_WRITES_ENABLED';
export const PRICE_SETTING = 'prices.writeEnabled';

// ----- why price editing is unavailable ----------------------------------------------------------

export type PriceBlock = { kind: 'role' | 'server' | 'workspace'; message: string };

/** The first reason a person cannot edit prices, in the order the server checks them; null when they can. Never a reason to hide the prices. */
export function priceBlock(view: PriceWriteView | null, role: Role): PriceBlock | null {
  if (!can(role, 'monetization.price'))
    return { kind: 'role', message: t('products:price.blockRole') };
  if (view === null) return null;
  if (view.reason === 'server_switch')
    return {
      kind: 'server',
      message: t('products:price.blockServer', { env: view.envName || PRICE_ENV }),
    };
  if (view.reason === 'workspace_setting')
    return {
      kind: 'workspace',
      message: t('products:price.blockWorkspace', { setting: PRICE_SETTING }),
    };
  return null;
}

// ----- reading what was typed --------------------------------------------------------------------

export type AmountRead =
  | { ok: true; minor: string }
  | { ok: false; problem: 'empty' | 'format' | 'precision' | 'zero' };

/**
 * `4.99`, `4,99` and `1,299.00` read as money in the currency's own number of decimals. More decimals than the currency has are refused,
 * never rounded: a price the person did not type must not be sent.
 */
export function readAmount(text: string, currency: string): AmountRead {
  let s = text.trim().replace(/[\s ']/g, '');
  if (s === '') return { ok: false, problem: 'empty' };
  if (s.includes(',') && !s.includes('.')) {
    const parts = s.split(',');
    // One comma with 1-2 digits after it is a decimal comma; groups of three digits are thousands separators.
    s =
      parts.length === 2 && (parts[1] as string).length !== 3
        ? `${parts[0]}.${parts[1]}`
        : parts.join('');
  } else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, problem: 'format' };
  const minor = parseDecimalMinor(s, currency);
  if (minor === undefined) return { ok: false, problem: 'precision' };
  return /^0+$/.test(minor) ? { ok: false, problem: 'zero' } : { ok: true, minor };
}

const PROBLEM_KEYS = {
  empty: k('products:price.problem.empty'),
  format: k('products:price.problem.format'),
  precision: k('products:price.problem.precision'),
  zero: k('products:price.problem.zero'),
} as const;
export const amountProblemText = (problem: keyof typeof PROBLEM_KEYS, currency: string): string =>
  t(PROBLEM_KEYS[problem], { currency });

// ----- the rows of the editor --------------------------------------------------------------------

/** One territory of the editor: the current price (minor units), the text typed, and for Apple the price point picked. */
export type PriceRow = {
  territory: string;
  currency: string;
  current: string;
  input: string;
  pricePointId: string | null;
};

export type RowChange =
  | { state: 'unchanged' }
  | { state: 'invalid'; problem: Extract<AmountRead, { ok: false }>['problem'] }
  | {
      state: 'changed';
      minor: string;
      bp: number | null;
      direction: 'increase' | 'decrease' | 'same';
    };

export function rowChange(row: PriceRow): RowChange {
  if (row.input.trim() === '') return { state: 'unchanged' };
  const read = readAmount(row.input, row.currency);
  if (!read.ok) return { state: 'invalid', problem: read.problem };
  if (read.minor === row.current) return { state: 'unchanged' };
  const bp = changeBp(row.current, read.minor) ?? null;
  const direction = bp === null ? 'same' : bp > 0 ? 'increase' : bp < 0 ? 'decrease' : 'same';
  return { state: 'changed', minor: read.minor, bp, direction };
}

export const changedRows = (
  rows: readonly PriceRow[],
): (PriceRow & { minor: string; bp: number | null })[] =>
  rows.flatMap((r) => {
    const c = rowChange(r);
    return c.state === 'changed' ? [{ ...r, minor: c.minor, bp: c.bp }] : [];
  });

export const hasInvalid = (rows: readonly PriceRow[]): boolean =>
  rows.some((r) => rowChange(r).state === 'invalid');

export const stageLines = (
  rows: readonly PriceRow[],
  applePoints: boolean,
): PriceStageRequest['lines'] =>
  changedRows(rows).map((r) => ({
    territory: r.territory,
    newAmount: r.minor,
    ...(applePoints && r.pricePointId ? { pricePointId: r.pricePointId } : {}),
  }));

/** `$4.99` to `$5.99`: both in the territory's own currency, written for the reader's language. */
export const moneyChange = (before: string, after: string, currency: string): string =>
  t('products:price.fromTo', {
    from: formatMinorUnits(before, currency) || `${before} ${currency}`,
    to: formatMinorUnits(after, currency) || `${after} ${currency}`,
  });

export const money = (amount: string, currency: string): string =>
  formatMinorUnits(amount, currency) || `${amount} ${currency}`;

/** `+20%` (up), `-10%` (down); null when the current price is not a positive amount. */
export const bpText = (bp: number | null): string => (bp === null ? '' : percentLabel(bp));

// ----- what the screen knows ahead of the server -------------------------------------------------

export const subscriberRules = (store: string, kind: ProductKind): readonly PriceSubscriberRule[] =>
  SUBSCRIBER_RULES_BY_KIND(store === 'googleplay' ? 'googleplay' : 'appstoreconnect', kind);

export function limitsOf(view: PriceWriteView | null): PriceLimits {
  if (!view) return DEFAULT_PRICE_LIMITS;
  return {
    ...DEFAULT_PRICE_LIMITS,
    relativeBp: Math.round(view.limits.relativeChangePercent * 100),
    absoluteMajor: view.limits.absoluteChangeMajor,
    maxTerritories: view.limits.maxTerritories,
  };
}

/** The acknowledgements this draft needs, from its own numbers (the same function the server runs); the server stays the judge. */
export function neededAcks(input: {
  store: string;
  productId: string;
  kind: ProductKind;
  rule: PriceSubscriberRule;
  rows: readonly PriceRow[];
  limits: PriceLimits;
}): PriceAck[] {
  const change: PriceChange = {
    store: input.store === 'googleplay' ? 'googleplay' : 'appstoreconnect',
    productId: input.productId,
    kind: input.kind,
    planId: null,
    baseTerritory: null,
    lines: changedRows(input.rows).map((r) => ({
      territory: r.territory,
      currency: r.currency,
      currentAmount: r.current,
      newAmount: r.minor,
    })),
    effectiveDate: null,
    existingSubscribers: input.rule,
    acknowledgements: [],
  };
  return requiredAcknowledgements(change, input.limits);
}

/** The phrase for a set of price items: their number and the largest change among them (what the server computes from the same rows). */
export const confirmationPhrase = (
  items: readonly Pick<StagedPriceChange, 'largestBp'>[],
): string =>
  priceConfirmationPhrase(
    items.length,
    items.reduce((m, i) => Math.max(m, i.largestBp), 0),
  );

export const samePhrase = (typed: string, expected: string): boolean =>
  typed.trim().replace(/\s+/g, ' ') === expected;

/** Per currency: how many lines go up and down. Never a total: a euro and a dollar are not added. */
export function perCurrency(
  lines: readonly StagedPriceChange['lines'][number][],
): { currency: string; up: number; down: number }[] {
  const out = new Map<string, { currency: string; up: number; down: number }>();
  for (const l of lines) {
    const row = out.get(l.currency) ?? { currency: l.currency, up: 0, down: 0 };
    if (l.direction === 'increase') row.up += 1;
    else if (l.direction === 'decrease') row.down += 1;
    out.set(l.currency, row);
  }
  return [...out.values()];
}

// ----- words for the answers ---------------------------------------------------------------------

const ISSUE_KEYS = {
  no_lines: k('products:price.issue.noLines'),
  too_many_territories: k('products:price.issue.tooManyTerritories'),
  duplicate_territory: k('products:price.issue.duplicateTerritory'),
  bad_territory: k('products:price.issue.badTerritory'),
  bad_product: k('products:price.issue.badProduct'),
  bad_amount: k('products:price.issue.badAmount'),
  not_positive: k('products:price.issue.notPositive'),
  too_high: k('products:price.issue.tooHigh'),
  no_change: k('products:price.issue.noChange'),
  currency_mismatch: k('products:price.issue.currencyMismatch'),
  unknown_territory: k('products:price.issue.unknownTerritory'),
  price_point_missing: k('products:price.issue.pricePointMissing'),
  price_point_unknown: k('products:price.issue.pricePointUnknown'),
  price_point_territory: k('products:price.issue.pricePointTerritory'),
  price_point_mismatch: k('products:price.issue.pricePointMismatch'),
  amount_not_price_point: k('products:price.issue.amountNotPricePoint'),
  price_point_not_allowed: k('products:price.issue.pricePointNotAllowed'),
  plan_missing: k('products:price.issue.planMissing'),
  plan_not_allowed: k('products:price.issue.planNotAllowed'),
  effective_date_invalid: k('products:price.issue.dateInvalid'),
  effective_date_past: k('products:price.issue.datePast'),
  effective_date_unsupported: k('products:price.issue.dateUnsupported'),
  subscriber_rule_invalid: k('products:price.issue.subscriberRule'),
  ack_required: k('products:price.issue.ackRequired'),
  ack_unknown: k('products:price.issue.ackUnknown'),
  stale_price: k('products:price.issue.stalePrice'),
} as const;

/** One issue as a sentence, with the territory in front; an unknown code reads as the generic sentence. */
export function issueText(issue: PriceIssueView, currency?: string): string {
  const key = Object.prototype.hasOwnProperty.call(ISSUE_KEYS, issue.code)
    ? ISSUE_KEYS[issue.code as keyof typeof ISSUE_KEYS]
    : k('products:price.issue.other');
  const base = t(key);
  const near = issue.detail?.nearest;
  const hint =
    near && near.length > 0 && currency
      ? ` ${t('products:price.nearest', { list: near.map((p) => money(p.amount, p.currency)).join(', ') })}`
      : '';
  return `${issue.territory ? `${issue.territory}: ` : ''}${base}${hint}`;
}

export type PriceFailure = {
  kind: 'disabled' | 'stale' | 'invalid' | 'busy' | 'other';
  message: string;
  issues: PriceIssueView[];
};

const issuesOf = (value: unknown): PriceIssueView[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is PriceIssueView =>
          typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string',
      )
    : [];

/** What a failed stage, convert, price-point read or dry run means for the person. The message is a sentence; nothing was sent to a store. */
export function classifyPriceFailure(error: unknown): PriceFailure {
  if (!(error instanceof ApiError))
    return { kind: 'other', message: t('products:price.failure.network'), issues: [] };
  const step = stepUpMessage(error.code, error.retryAfter);
  if (step !== undefined) return { kind: 'other', message: step, issues: [] };
  const message =
    typeof error.body.message === 'string' && error.body.message !== ''
      ? error.body.message
      : error.message;
  switch (error.code) {
    case 'price_writes_disabled':
      return { kind: 'disabled', message, issues: [] };
    case 'stale_snapshot':
      return { kind: 'stale', message: t('products:price.failure.stale'), issues: [] };
    case 'write_in_progress':
    case 'outcome_unknown':
      return { kind: 'busy', message, issues: [] };
    case 'forbidden':
      return { kind: 'other', message: t('products:price.blockRole'), issues: [] };
    default:
      return {
        kind: error.status === 422 ? 'invalid' : 'other',
        message,
        issues: issuesOf(error.body.issues),
      };
  }
}

// ----- what the store said after a send ----------------------------------------------------------

export type PriceResultDetail = {
  productId: string;
  lines: {
    territory: string;
    currency: string;
    before: string;
    after: string;
    outcome: string;
    code?: string;
  }[];
  verification: 'confirmed' | 'store_shows' | 'unverified' | 'not_sent';
  mismatches: { territory: string; expected: string; actual: string | null }[];
  migration?: { requested: boolean; outcome: string; code?: string };
  issues?: PriceIssueView[];
};

/** "Confirmed by the store" only when the read back shows the asked prices; otherwise what the store shows instead, or that it is not verified. */
export function verificationText(d: PriceResultDetail): string {
  switch (d.verification) {
    case 'confirmed':
      return t('app:cart.price.confirmed');
    case 'store_shows': {
      const first = d.mismatches[0];
      if (!first) return t('app:cart.price.storeShowsOther');
      const currency = d.lines.find((l) => l.territory === first.territory)?.currency ?? '';
      return t('app:cart.price.storeShows', {
        territory: first.territory,
        actual: first.actual === null ? t('app:cart.price.noPrice') : money(first.actual, currency),
        expected: money(first.expected, currency),
      });
    }
    case 'unverified':
      return t('app:cart.price.unverified');
    default:
      return t('app:cart.price.notSent');
  }
}
