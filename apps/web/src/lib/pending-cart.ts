import type { Platform } from '@kiln/core';
import { appAddress, type AppSection, type PlatformScope } from './app-scope.ts';
import { k, t } from './i18n/t.ts';
import { confirmationPhrase, type PriceResultDetail } from './prices.ts';
import type { StagedPriceChange } from './types.ts';

/**
 * The pending cart, pure (docs/adr/0054-pending-cart.md): the wire types of `GET /apps/{id}/pending/cart`, grouping, selection
 * (a bundle moves together), counts for the confirm, the requests of a publish, and merging per item results. No DOM and no fetch.
 */

export const CART_KINDS = ['listing', 'graphics', 'release', 'price', 'review_reply'] as const;
export type CartKind = (typeof CART_KINDS)[number];

export type CartReason = { code: string; action?: string; envName?: string };

/** One item as the server lists it. */
export type CartItem = {
  id: string;
  kind: CartKind;
  title: string;
  summary: string | null;
  before: string | null;
  platform: Platform;
  store: 'appstoreconnect' | 'googleplay';
  locale: string | null;
  createdAt: number;
  author: { id: string; name: string | null } | null;
  risk: 'store_draft' | 'public_reply' | 'financial';
  needsApproval: boolean;
  publishable: boolean;
  reason: CartReason | null;
  canDiscard: boolean;
  bundle: string | null;
  version: string;
  counts: Record<string, number>;
  /** Graphics: addresses of up to four uploaded files of the set, for thumbnails (CartGraphicsDetail). */
  thumbs?: string[];
  problems: { code: string; severity: 'error' | 'warning'; message: string }[];
  ref: { locale?: string; field?: string; slot?: string; reviewId?: string };
  /** A price change (kind `price`): per territory before and after in minor units; risk `financial`, always needs the typed phrase. */
  price?: StagedPriceChange;
  review?: { rating: number; excerpt: string; language: string | null; territory: string | null; status: string };
};

export type CartRights = { push: boolean; reply: boolean; price: boolean; discardStaged: boolean; discardReply: boolean };
export type CartResponse = { cart: { items: CartItem[]; can: CartRights; generatedAt: number } };

export type CartOutcome = { status: 'ok' | 'failed' | 'skipped'; reason: string | null; /** A price item: what the store showed after the write. */ price?: PriceResultDetail };
export type CartResultResponse = {
  result: { results: { id: string; status: CartOutcome['status']; reason: string | null; httpStatus?: number; price?: PriceResultDetail }[]; remaining: number };
};

/** An item as the page holds it: with the record (app id) it belongs to, because one app can have an iOS and an Android record. */
export type CartRow = CartItem & { appId: string; key: string };

export const rowKey = (appId: string, id: string) => `${appId}|${id}`;
export const toRows = (appId: string, items: readonly CartItem[]): CartRow[] =>
  items.map((i) => ({ ...i, appId, key: rowKey(appId, i.id) }));

export type CartGroup = { kind: CartKind; rows: CartRow[] };

/** Rows in the order of the kinds, empty kinds left out; the order inside a kind is kept. */
export function groupRows(rows: readonly CartRow[]): CartGroup[] {
  return CART_KINDS.map((kind) => ({ kind, rows: rows.filter((r) => r.kind === kind) })).filter((g) => g.rows.length > 0);
}

// ----- selection ---------------------------------------------------------------------------------

export type Selection = ReadonlySet<string>;
export const noSelection: Selection = new Set<string>();

/** The rows that go together with this one: the members of its bundle in the same record (all or none), or itself. */
export function withBundle(rows: readonly CartRow[], row: CartRow): CartRow[] {
  return row.bundle === null ? [row] : rows.filter((r) => r.appId === row.appId && r.bundle === row.bundle);
}

/** Only rows that can be published are selectable; the rest are listed with their reason. */
export const selectable = (row: CartRow) => row.publishable;

export function toggle(rows: readonly CartRow[], selection: Selection, key: string): Selection {
  const row = rows.find((r) => r.key === key);
  if (!row || !selectable(row)) return selection;
  const group = withBundle(rows, row).filter(selectable);
  const next = new Set(selection);
  if (selection.has(key)) for (const g of group) next.delete(g.key);
  else for (const g of group) next.add(g.key);
  return next;
}

export const selectAll = (rows: readonly CartRow[]): Selection => new Set(rows.filter(selectable).map((r) => r.key));

/** Drops keys that are no longer in the list (after a refresh), keeping the rest. */
export const prune = (rows: readonly CartRow[], selection: Selection): Selection => {
  const keys = new Set(rows.filter(selectable).map((r) => r.key));
  return new Set([...selection].filter((k) => keys.has(k)));
};

export const selectedRows = (rows: readonly CartRow[], selection: Selection): CartRow[] => rows.filter((r) => selection.has(r.key));

export type CartCounts = {
  total: number;
  selectable: number;
  selected: number;
  byKind: Record<CartKind, number>;
  /** Stores that would be written, in order of first use: all, those that get a draft, those that get a public reply. */
  stores: ('appstoreconnect' | 'googleplay')[];
  draftStores: ('appstoreconnect' | 'googleplay')[];
  replyStores: ('appstoreconnect' | 'googleplay')[];
  /** Selected staged changes (written as a draft) and replies (public at once). */
  drafts: number;
  replies: number;
  /** Selected price changes (a financial write: the typed phrase is needed). */
  prices: number;
  /** True when the step-up policy asks for another confirmation. */
  needsApproval: boolean;
};

export function countsOf(rows: readonly CartRow[], selection: Selection): CartCounts {
  const chosen = selectedRows(rows, selection);
  const byKind: Record<CartKind, number> = { listing: 0, graphics: 0, release: 0, price: 0, review_reply: 0 };
  for (const r of chosen) byKind[r.kind] += 1;
  return {
    total: rows.length,
    selectable: rows.filter(selectable).length,
    selected: chosen.length,
    byKind,
    stores: [...new Set(chosen.map((r) => r.store))],
    draftStores: [...new Set(chosen.filter((r) => r.risk === 'store_draft').map((r) => r.store))],
    replyStores: [...new Set(chosen.filter((r) => r.risk === 'public_reply').map((r) => r.store))],
    drafts: chosen.filter((r) => r.risk === 'store_draft').length,
    replies: chosen.filter((r) => r.risk === 'public_reply').length,
    prices: chosen.filter((r) => r.kind === 'price').length,
    needsApproval: chosen.some((r) => r.needsApproval),
  };
}

/** The tri-state of a "select all" box. */
export function allState(rows: readonly CartRow[], selection: Selection): 'none' | 'some' | 'all' {
  const n = rows.filter(selectable).length;
  const s = rows.filter((r) => selectable(r) && selection.has(r.key)).length;
  return s === 0 ? 'none' : s === n ? 'all' : 'some';
}

// ----- requests and results ----------------------------------------------------------------------

/** One request per record: the `{ id, version }` pairs of what was selected, in list order. */
export function publishRequests(rows: readonly CartRow[], selection: Selection): Map<string, { id: string; version: string }[]> {
  const out = new Map<string, { id: string; version: string }[]>();
  for (const r of selectedRows(rows, selection)) {
    const list = out.get(r.appId) ?? [];
    list.push({ id: r.id, version: r.version });
    out.set(r.appId, list);
  }
  return out;
}

/**
 * The phrase to type for the price items selected, ONE PER RECORD: a publish is one request per record and the server checks the phrase of the
 * price items of that request (their number and the largest change among them). Empty when no price item is selected.
 */
export function pricePhrases(rows: readonly CartRow[], selection: Selection): { appId: string; count: number; phrase: string }[] {
  const byApp = new Map<string, StagedPriceChange[]>();
  for (const r of selectedRows(rows, selection)) {
    if (r.kind !== 'price' || !r.price) continue;
    const list = byApp.get(r.appId) ?? [];
    list.push(r.price);
    byApp.set(r.appId, list);
  }
  return [...byApp].map(([appId, items]) => ({ appId, count: items.length, phrase: confirmationPhrase(items) }));
}

export function discardRequests(rows: readonly CartRow[], selection: Selection): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of selectedRows(rows, selection).filter((x) => x.canDiscard)) {
    const list = out.get(r.appId) ?? [];
    list.push(r.id);
    out.set(r.appId, list);
  }
  return out;
}

/** Outcomes by row key; `running` rows have no outcome yet. */
export type Outcomes = Readonly<Record<string, CartOutcome>>;

export function mergeResults(previous: Outcomes, appId: string, results: CartResultResponse['result']['results']): Outcomes {
  const next: Record<string, CartOutcome> = { ...previous };
  for (const r of results) next[rowKey(appId, r.id)] = { status: r.status, reason: r.reason, ...(r.price ? { price: r.price } : {}) };
  return next;
}

/** A whole request that failed (network, step-up, a 4xx): every row of it failed with that code. */
export function failAll(previous: Outcomes, appId: string, ids: readonly string[], reason: string): Outcomes {
  const next: Record<string, CartOutcome> = { ...previous };
  for (const id of ids) next[rowKey(appId, id)] = { status: 'failed', reason };
  return next;
}

export function tally(outcomes: Outcomes): { ok: number; failed: number; skipped: number } {
  const all = Object.values(outcomes);
  return {
    ok: all.filter((o) => o.status === 'ok').length,
    failed: all.filter((o) => o.status === 'failed').length,
    skipped: all.filter((o) => o.status === 'skipped').length,
  };
}

/** Rows of a run, from the snapshot taken before it started (they are gone from the cart when sent). */
export const outcomeRows = (snapshot: readonly CartRow[], outcomes: Outcomes): { row: CartRow; outcome: CartOutcome }[] =>
  snapshot.flatMap((row) => {
    const outcome = outcomes[row.key];
    return outcome ? [{ row, outcome }] : [];
  });

// ----- places and signals ------------------------------------------------------------------------

const SECTION: Record<CartKind, AppSection> = { listing: 'listing', graphics: 'assets', release: 'releases', price: 'products', review_reply: 'reviews' };

/** Where the item was made: the page of the app that holds it. */
export const placeOf = (row: CartRow, groupId: string, platform: PlatformScope | null): string =>
  appAddress(groupId, SECTION[row.kind], platform);

export const CART_ADDED_EVENT = 'kiln:cart-added';

/** A page staged something: the cart button pulses once and says so. Safe where there is no window (tests, servers). */
export function announceCartAdded(target: EventTarget | undefined = typeof window === 'undefined' ? undefined : window): void {
  target?.dispatchEvent(new CustomEvent(CART_ADDED_EVENT));
}

export const CART_OPEN_EVENT = 'kiln:cart-open';

/** Opens the cart drawer, scrolled to the items of one locale (the "2 staged" chip of a locale row). `locale: null` just opens it. */
export function announceCartOpen(
  locale: string | null,
  target: Pick<EventTarget, 'dispatchEvent'> | undefined = typeof window === 'undefined' ? undefined : window,
): void {
  target?.dispatchEvent(new CustomEvent(CART_OPEN_EVENT, { detail: { locale } }));
}

/** The cart rows made for one locale (listing texts and graphics), in list order. */
export const rowsForLocale = (rows: readonly CartRow[], locale: string): CartRow[] =>
  rows.filter((r) => (r.kind === 'listing' || r.kind === 'graphics') && r.locale === locale);

/** The messages for a reason code of a row (why it cannot be sent) or of a result; an unknown code reads as the generic one. */
const REASON_KEYS = {
  no_right: k('app:cart.reason.noRight'),
  switch_off: k('app:cart.reason.switchOff'),
  workspace_off: k('app:cart.reason.workspaceOff'),
  invalid: k('app:cart.reason.invalid'),
  bundle_blocked: k('app:cart.reason.bundleBlocked'),
  metadata_locked: k('app:cart.reason.metadataLocked'),
  in_progress: k('app:cart.reason.inProgress'),
  outcome_unknown: k('app:cart.reason.outcomeUnknown'),
  other: k('app:cart.reason.other'),
} as const;
type ReasonCode = keyof typeof REASON_KEYS;
const reasonCode = (code: string | null | undefined): ReasonCode =>
  code !== null && code !== undefined && Object.prototype.hasOwnProperty.call(REASON_KEYS, code) ? (code as ReasonCode) : 'other';
export const reasonKey = (code: string | null | undefined): string => REASON_KEYS[reasonCode(code)];
export const reasonText = (code: string | null | undefined): string => {
  const c = reasonCode(code);
  return t(REASON_KEYS[c]);
};

const RESULT_KEYS = {
  not_pending: k('app:cart.result.notPending'),
  changed_since_review: k('app:cart.result.changedSinceReview'),
  bundle_incomplete: k('app:cart.result.bundleIncomplete'),
  state_changed: k('app:cart.result.stateChanged'),
  blocked: k('app:cart.result.blocked'),
  staged_invalid: k('app:cart.result.stagedInvalid'),
  step_up_required: k('app:cart.result.stepUpRequired'),
  network: k('app:cart.result.network'),
  no_right: k('app:cart.reason.noRight'),
  switch_off: k('app:cart.reason.switchOff'),
  invalid: k('app:cart.reason.invalid'),
  bundle_blocked: k('app:cart.reason.bundleBlocked'),
  metadata_locked: k('app:cart.reason.metadataLocked'),
  in_progress: k('app:cart.reason.inProgress'),
  outcome_unknown: k('app:cart.reason.outcomeUnknown'),
  workspace_off: k('app:cart.reason.workspaceOff'),
  confirmation_mismatch: k('app:cart.result.confirmationMismatch'),
  price_writes_disabled: k('app:cart.reason.switchOff'),
  write_in_progress: k('app:cart.reason.inProgress'),
  partial: k('app:cart.result.pricePartial'),
  stale_price: k('app:cart.result.priceStale'),
  currency_mismatch: k('app:cart.result.priceCurrency'),
  price_point_invalid: k('app:cart.result.pricePoint'),
  acknowledgement_required: k('app:cart.result.priceAck'),
  invalid_price: k('app:cart.result.priceInvalid'),
  store_rejected: k('app:cart.result.priceRejected'),
  rejected: k('app:cart.result.priceRejected'),
  price_change_not_allowed: k('app:cart.result.priceNotAllowed'),
  existing_subscriber_rule: k('app:cart.result.priceSubscribers'),
  unsupported_territory: k('app:cart.result.priceTerritory'),
  product_not_found: k('app:cart.result.priceProduct'),
  rate_limited: k('app:cart.result.rateLimited'),
  forbidden: k('app:cart.reason.noRight'),
  other: k('app:cart.result.other'),
} as const;
type ResultCode = keyof typeof RESULT_KEYS;
const resultCode = (code: string | null | undefined): ResultCode =>
  code !== null && code !== undefined && Object.prototype.hasOwnProperty.call(RESULT_KEYS, code) ? (code as ResultCode) : 'other';
export const resultKey = (code: string | null | undefined): string => RESULT_KEYS[resultCode(code)];
export const resultText = (code: string | null | undefined): string => {
  const c = resultCode(code);
  return t(RESULT_KEYS[c]);
};

export const GROUP_KEYS: Record<CartKind, string> = {
  listing: k('app:cart.group.listing'),
  graphics: k('app:cart.group.graphics'),
  release: k('app:cart.group.release'),
  price: k('app:cart.group.price'),
  review_reply: k('app:cart.group.reviewReply'),
};
export const STORE_KEYS: Record<CartItem['store'], string> = {
  appstoreconnect: k('app:cart.store.appstoreconnect'),
  googleplay: k('app:cart.store.googleplay'),
};
export const RISK_KEYS: Record<CartItem['risk'], string> = {
  store_draft: k('app:cart.risk.storeDraft'),
  public_reply: k('app:cart.risk.publicReply'),
  financial: k('app:cart.risk.financial'),
};
export const STATUS_KEYS: Record<CartOutcome['status'] | 'running', string> = {
  ok: k('app:cart.status.ok'),
  failed: k('app:cart.status.failed'),
  skipped: k('app:cart.status.skipped'),
  running: k('app:cart.status.running'),
};
