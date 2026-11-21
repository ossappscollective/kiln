import { ApiError } from './api.ts';
import { timeAgo } from './format.ts';
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
export const PRODUCT_WRITE_ROLE_REASON =
  'Changing a product text needs the admin or owner role. You can read everything on this page.';
/** The limits the server enforces; the store may have stricter ones and says so when it refuses. */
export const MAX_PRODUCT_NAME = 200;
export const MAX_PRODUCT_DESCRIPTION = 2000;

export const READ_ONLY_NOTE =
  'Prices and availability are read from the store and cannot be changed here. Only the display name and description of a language can.';

export function kindLabel(kind: ProductKind): string {
  switch (kind) {
    case 'consumable':
      return 'Consumable';
    case 'non_consumable':
      return 'Non-consumable';
    case 'subscription':
      return 'Subscription';
  }
}

/** Google Play does not say whether a one-time product is consumable: the server guesses from whether it can be bought more than once. */
export const guessedKindNote =
  'Google Play does not say if a one-time product is consumable. This is a guess from whether it can be bought more than once.';

export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info';

/** The status as a word and a tone (never the tone alone). The store's own word is shown beside it when it differs. */
export function stateBadge(state: ProductState): { label: string; tone: Tone } {
  switch (state) {
    case 'active':
      return { label: 'On sale', tone: 'ok' };
    case 'in_review':
      return { label: 'In review', tone: 'info' };
    case 'action_needed':
      return { label: 'Needs action', tone: 'bad' };
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'inactive':
      return { label: 'Not for sale', tone: 'warn' };
    case 'removed':
      return { label: 'Removed from sale', tone: 'warn' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}

const PERIODS: Record<string, string> = {
  ONE_WEEK: 'Weekly',
  ONE_MONTH: 'Monthly',
  TWO_MONTHS: 'Every 2 months',
  THREE_MONTHS: 'Every 3 months',
  SIX_MONTHS: 'Every 6 months',
  ONE_YEAR: 'Yearly',
  P1W: 'Weekly',
  P1M: 'Monthly',
  P2M: 'Every 2 months',
  P3M: 'Every 3 months',
  P4M: 'Every 4 months',
  P6M: 'Every 6 months',
  P1Y: 'Yearly',
};

/** The billing period as a word; an unknown value is shown as the store wrote it. */
export const periodLabel = (period: string | null): string | null =>
  period === null || period === '' ? null : (PERIODS[period] ?? period);

/** `4.99 USD`; a product with no price yet says so. */
export const priceText = (price: ProductPrice | null): string =>
  price === null ? 'No price yet' : `${price.display} ${price.currency}`;

export type PriceGroup = { planId: string | null; label: string; prices: ProductPrice[] };

/** Prices grouped by plan (Google Play base plans), in the order the plans first appear; Apple has one group. */
export function groupPrices(prices: readonly ProductPrice[]): PriceGroup[] {
  const groups: PriceGroup[] = [];
  for (const price of prices) {
    let group = groups.find((g) => g.planId === price.planId);
    if (!group) {
      group = {
        planId: price.planId,
        label: price.planId === null ? 'Prices' : `Plan ${price.planId}`,
        prices: [],
      };
      groups.push(group);
    }
    group.prices.push(price);
  }
  return groups;
}

export function priceCountText(count: number): string {
  return count === 0 ? 'No territories' : count === 1 ? '1 territory' : `${count} territories`;
}

/** How the last sync went, in one line, and how it should look. */
export function syncLine(
  sync: ProductSyncStatus | null,
  now: number,
): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (sync === null || (sync.lastSyncedAt === null && sync.lastError === null))
    return { text: 'Not read from the store yet.', tone: 'neutral' };
  if (sync.lastError !== null) {
    const kept =
      sync.lastSyncedAt === null
        ? 'Nothing was read yet.'
        : `Showing what was read ${timeAgo(sync.lastSyncedAt, now)}.`;
    const times = sync.failures > 1 ? ` (${sync.failures} syncs in a row failed)` : '';
    return { text: `The last sync failed${times}. ${kept} ${sync.lastError}`, tone: 'bad' };
  }
  const when = sync.lastSyncedAt === null ? '' : ` ${timeAgo(sync.lastSyncedAt, now)}`;
  if (!sync.complete)
    return {
      text: `Read${when}, but the store has more products than were read. The list is not complete.`,
      tone: 'warn',
    };
  return { text: `Read${when}.`, tone: 'neutral' };
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
  if (n === '') out.name = 'Enter a display name.';
  else if (n.indexOf('\n') >= 0) out.name = 'The display name is one line.';
  else if (n.length > MAX_PRODUCT_NAME)
    out.name = `The display name is at most ${MAX_PRODUCT_NAME} characters.`;
  else if (CONTROL.test(n)) out.name = 'The display name cannot hold control characters.';
  if (d.length > MAX_PRODUCT_DESCRIPTION)
    out.description = `The description is at most ${MAX_PRODUCT_DESCRIPTION} characters.`;
  else if (CONTROL.test(d)) out.description = 'The description cannot hold control characters.';
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
  const parts: string[] = [];
  if (preview.changes.name) parts.push('the display name');
  if (preview.changes.description) parts.push('the description');
  if (parts.length === 0) return 'The store already shows these texts.';
  return `Changes ${parts.join(' and ')} for ${preview.locale}.`;
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
  const nothing = action === 'change' ? ' Nothing was changed.' : '';
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      message:
        action === 'change'
          ? 'The request failed. Check your connection, then look at the product again. It is not known whether anything was changed.'
          : 'The request failed. Check your connection, then try again.',
    };
  const message = bodyMessage(error);
  const step = stepUpMessage(error.code, error.retryAfter);
  if (step !== undefined) return { kind: 'other', message: step };
  switch (error.code) {
    case 'store_product_write_disabled':
      return {
        kind: 'disabled',
        message: `Changing product texts is switched off on this server (${PRODUCT_WRITE_ENV}).${nothing} Someone who runs the server sets ${PRODUCT_WRITE_ENV}=true and restarts it.`,
      };
    case 'forbidden':
      return { kind: 'forbidden', message: PRODUCT_WRITE_ROLE_REASON };
    case 'write_in_progress':
      return { kind: 'busy', message: `${message}${nothing}` };
    case 'no_change':
      return { kind: 'no_change', message };
    case 'locale_not_found':
      return { kind: 'locale_missing', message: `${message}${nothing}` };
    case 'outcome_unknown':
      return {
        kind: 'outcome_unknown',
        message: `${message} Look at the product in the store before you try again.`,
      };
    case 'state_changed':
      return {
        kind: 'state_changed',
        message,
        current: textsOf(error.body.current),
        previewHash: typeof error.body.previewHash === 'string' ? error.body.previewHash : null,
      };
    case 'rate_limited':
      return { kind: 'other', message: `${message}${nothing}` };
    case 'timeout':
      return {
        kind: 'other',
        message:
          action === 'change'
            ? 'The store did not answer in time. It is not known whether the change was made: look at the product again.'
            : 'The store did not answer in time. Try again in a moment.',
      };
    default:
      return { kind: 'other', message: `${message}${error.status >= 400 && error.status < 500 ? nothing : ''}` };
  }
}
