import { ApiError } from './api.ts';
import { timeAgo } from './format.ts';
import { formatMinorUnits } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import { stepUpMessage } from './step-up.ts';
import type {
  ProductKind,
  ProductLocalizationPreview,
  ProductPrice,
  ProductState,
  ProductSyncStatus,
} from './types.ts';

/**
 * In-app purchases and subscriptions of an app (docs/api/products.md, docs/adr/0034-in-app-products.md): the words, the tones and the
 * checks of the Products page, as pure functions. The server decides every rule; nothing here sends anything. Written for the ES2017 web
 * build: no flatMap, no fromEntries.
 */

export const PRODUCT_WRITE_ENV = 'KILN_STORE_PRODUCT_WRITE_ENABLED';
/** A message key: translate it where it is drawn (`t(PRODUCT_WRITE_ROLE_REASON)`). */
export const PRODUCT_WRITE_ROLE_REASON = k('products:note.writeRole');
/** The limits the server enforces; the store may have stricter ones and says so when it refuses. */
export const MAX_PRODUCT_NAME = 200;
export const MAX_PRODUCT_DESCRIPTION = 2000;

/** A message key: translate it where it is drawn (`t(READ_ONLY_NOTE)`). */
export const READ_ONLY_NOTE = k('products:note.readOnly');

export function kindLabel(kind: ProductKind): string {
  switch (kind) {
    case 'consumable':
      return t('products:kind.consumable');
    case 'non_consumable':
      return t('products:kind.nonConsumable');
    case 'subscription':
      return t('products:kind.subscription');
  }
}

/** Google Play does not say whether a one-time product is consumable: the server guesses from whether it can be bought more than once. */
/** A message key: translate it where it is drawn. */
export const guessedKindNote = k('products:note.guessedKind');

export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info';

/** The status as a word and a tone (never the tone alone). The store's own word is shown beside it when it differs. */
export function stateBadge(state: ProductState): { label: string; tone: Tone } {
  switch (state) {
    case 'active':
      return { label: t('products:state.active'), tone: 'ok' };
    case 'in_review':
      return { label: t('products:state.inReview'), tone: 'info' };
    case 'action_needed':
      return { label: t('products:state.actionNeeded'), tone: 'bad' };
    case 'draft':
      return { label: t('products:state.draft'), tone: 'neutral' };
    case 'inactive':
      return { label: t('products:state.inactive'), tone: 'warn' };
    case 'removed':
      return { label: t('products:state.removed'), tone: 'warn' };
    default:
      return { label: t('products:state.unknown'), tone: 'neutral' };
  }
}

const PERIODS: Record<string, string> = {
  ONE_WEEK: k('products:period.weekly'),
  ONE_MONTH: k('products:period.monthly'),
  TWO_MONTHS: k('products:period.every2Months'),
  THREE_MONTHS: k('products:period.every3Months'),
  SIX_MONTHS: k('products:period.every6Months'),
  ONE_YEAR: k('products:period.yearly'),
  P1W: k('products:period.weekly'),
  P1M: k('products:period.monthly'),
  P2M: k('products:period.every2Months'),
  P3M: k('products:period.every3Months'),
  P4M: k('products:period.every4Months'),
  P6M: k('products:period.every6Months'),
  P1Y: k('products:period.yearly'),
};

/** The billing period as a word; an unknown value is shown as the store wrote it. */
export const periodLabel = (period: string | null): string | null =>
  period === null || period === '' ? null : PERIODS[period] === undefined ? period : t(PERIODS[period]);

/** `$4.99` (the store's price in its own currency, written for the reader's language); a product with no price yet says so. */
export const priceText = (price: ProductPrice | null): string =>
  price === null ? t('products:price.none') : priceDisplay(price);

/** One price in the store's currency, written for the reader's language (`$4.99`); the store's own text when the amount cannot be read. */
export const priceDisplay = (price: ProductPrice): string =>
  formatMinorUnits(price.amount, price.currency) || `${price.display} ${price.currency}`;

export type PriceGroup = { planId: string | null; label: string; prices: ProductPrice[] };

/** Prices grouped by plan (Google Play base plans), in the order the plans first appear; Apple has one group. */
export function groupPrices(prices: readonly ProductPrice[]): PriceGroup[] {
  const groups: PriceGroup[] = [];
  for (const price of prices) {
    let group = groups.find((g) => g.planId === price.planId);
    if (!group) {
      group = {
        planId: price.planId,
        label: price.planId === null ? t('products:price.groupPrices') : t('products:price.groupPlan', { plan: price.planId }),
        prices: [],
      };
      groups.push(group);
    }
    group.prices.push(price);
  }
  return groups;
}

export function priceCountText(count: number): string {
  return count === 0 ? t('products:price.noTerritories') : t('products:price.territories', { count });
}

/** How the last sync went, in one line, and how it should look. */
export function syncLine(
  sync: ProductSyncStatus | null,
  now: number,
): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (sync === null || (sync.lastSyncedAt === null && sync.lastError === null))
    return { text: t('products:sync.never'), tone: 'neutral' };
  if (sync.lastError !== null) {
    const error = sync.lastError;
    const many = sync.failures > 1;
    if (sync.lastSyncedAt === null)
      return {
        text: many
          ? t('products:sync.failedManyNothing', { count: sync.failures, error })
          : t('products:sync.failedNothing', { error }),
        tone: 'bad',
      };
    const ago = timeAgo(sync.lastSyncedAt, now);
    return {
      text: many
        ? t('products:sync.failedManyKept', { count: sync.failures, ago, error })
        : t('products:sync.failedKept', { ago, error }),
      tone: 'bad',
    };
  }
  // Past the checks above a sync with no error has been read at least once.
  const ago = timeAgo(sync.lastSyncedAt ?? now, now);
  if (!sync.complete) return { text: t('products:sync.partial', { ago }), tone: 'warn' };
  return { text: t('products:sync.read', { ago }), tone: 'neutral' };
}

// ---------------------------------------------------------------------------------------------
// The texts

export type TextProblems = { name?: string; description?: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** The text as the server compares it: line breaks are `\n`, no space around. */
export const normalizeText = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

/** The same checks the server makes, so a person is told before a round trip. The store's own limits are checked by the store. */
export function validateTexts(name: string, description: string): TextProblems {
  const n = normalizeText(name);
  const d = normalizeText(description);
  const out: TextProblems = {};
  if (n === '') out.name = t('products:validation.nameRequired');
  else if (n.indexOf('\n') >= 0) out.name = t('products:validation.nameOneLine');
  else if (n.length > MAX_PRODUCT_NAME) out.name = t('products:validation.nameTooLong', { count: MAX_PRODUCT_NAME });
  else if (CONTROL.test(n)) out.name = t('products:validation.nameControl');
  if (d.length > MAX_PRODUCT_DESCRIPTION)
    out.description = t('products:validation.descriptionTooLong', { count: MAX_PRODUCT_DESCRIPTION });
  else if (CONTROL.test(d)) out.description = t('products:validation.descriptionControl');
  return out;
}

/** Whether the draft differs from what is stored (after the same normalizing the server does). */
export const textsDiffer = (
  draft: { name: string; description: string },
  stored: { name: string; description: string },
): boolean =>
  normalizeText(draft.name) !== stored.name || normalizeText(draft.description) !== stored.description;

/** One line saying what a preview changes. */
export function changeSummary(preview: ProductLocalizationPreview): string {
  const { name, description } = preview.changes;
  if (!name && !description) return t('products:change.none');
  if (name && description) return t('products:change.both', { locale: preview.locale });
  return name
    ? t('products:change.name', { locale: preview.locale })
    : t('products:change.description', { locale: preview.locale });
}

// ---------------------------------------------------------------------------------------------
// Failures

export type ProductFailure =
  | { kind: 'disabled'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'busy'; message: string }
  | { kind: 'no_change'; message: string }
  | { kind: 'locale_missing'; message: string }
  | { kind: 'outcome_unknown'; message: string }
  | {
      kind: 'state_changed';
      message: string;
      /** The new preview the server sends back: what the store shows now and the hash to apply it. */
      current: { name: string; description: string } | null;
      previewHash: string | null;
    }
  | { kind: 'other'; message: string };

const bodyMessage = (error: ApiError): string =>
  typeof error.body.message === 'string' && error.body.message !== ''
    ? error.body.message
    : error.message;

const textsOf = (value: unknown): { name: string; description: string } | null => {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { name?: unknown; description?: unknown };
  return typeof v.name === 'string' && typeof v.description === 'string'
    ? { name: v.name, description: v.description }
    : null;
};

export function classifyProductFailure(error: unknown, action: 'read' | 'change'): ProductFailure {
  const change = action === 'change';
  /** The server's sentence, and for a change the reassurance that nothing was changed. */
  const unchanged = (text: string): string => (change ? t('products:failure.withNothing', { message: text }) : text);
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      message: change ? t('products:failure.networkChange') : t('products:failure.networkRead'),
    };
  const message = bodyMessage(error);
  const step = stepUpMessage(error.code, error.retryAfter);
  if (step !== undefined) return { kind: 'other', message: step };
  switch (error.code) {
    case 'store_product_write_disabled':
      return {
        kind: 'disabled',
        message: change
          ? t('products:failure.disabledChange', { env: PRODUCT_WRITE_ENV })
          : t('products:failure.disabledRead', { env: PRODUCT_WRITE_ENV }),
      };
    case 'forbidden':
      return { kind: 'forbidden', message: t(PRODUCT_WRITE_ROLE_REASON) };
    case 'write_in_progress':
      return { kind: 'busy', message: unchanged(message) };
    case 'no_change':
      return { kind: 'no_change', message };
    case 'locale_not_found':
      return { kind: 'locale_missing', message: unchanged(message) };
    case 'outcome_unknown':
      return {
        kind: 'outcome_unknown',
        message: t('products:failure.outcomeUnknown', { message }),
      };
    case 'state_changed':
      return {
        kind: 'state_changed',
        message,
        current: textsOf(error.body.current),
        previewHash: typeof error.body.previewHash === 'string' ? error.body.previewHash : null,
      };
    case 'rate_limited':
      return { kind: 'other', message: unchanged(message) };
    case 'timeout':
      return {
        kind: 'other',
        message: change ? t('products:failure.timeoutChange') : t('products:failure.timeoutRead'),
      };
    default:
      return { kind: 'other', message: error.status >= 400 && error.status < 500 ? unchanged(message) : message };
  }
}
