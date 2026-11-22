/**
 * The sentence for a server error, in the person's language (docs/i18n-server.md, docs/adr/0045-server-message-localisation.md).
 *
 * The server sends `{ error, message, code?, params? }`. `code` is a stable dot.case name for the sentence
 * (`store.google.noAccess`); `params` is what it needs (a store name, a number, a branch). The text lives in the `errors` namespace
 * (`apps/web/locales/errors`). A code this app has no message for (a newer server, a code only some stores use) is not an error: the
 * caller falls back to the server's English `message`. Pure TypeScript, no Svelte: `lib/api.ts` and the screens that show stored
 * notes (`lastSyncError`) both use it.
 */
import { formatNumber } from './i18n/format.ts';
import { t } from './i18n/t.ts';

type Scalar = string | number | boolean | null;
export type ErrorParams = Record<string, Scalar>;

/** The same shape the server accepts in `coded()`: lower camelCase segments joined by dots, at least two. */
const CODE_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

/** `not_found` is `api.notFound`: the code a response without one has implicitly (the server's `legacyCode`). */
export function legacyCode(error: string): string {
  const [first = '', ...rest] = error.split('_');
  return `api.${first}${rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')}`;
}

/** The params of a response or a stored note, reduced to scalars (anything else is ignored, never shown). */
export function paramsOf(value: unknown): ErrorParams {
  const out: ErrorParams = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      item === null
    ) {
      out[name] = item;
    }
  }
  return out;
}

/** "30 seconds", "1 minute", "10 minutes" in the active language: how long to wait, rounded up (under a minute in seconds). */
export function waitText(seconds: number): string {
  const secs = Math.max(1, Math.ceil(seconds));
  if (secs < 60) return formatNumber(secs, { style: 'unit', unit: 'second', unitDisplay: 'long' });
  return formatNumber(Math.ceil(secs / 60), { style: 'unit', unit: 'minute', unitDisplay: 'long' });
}

/** The message of `errors:<code>` with its params, or undefined when this app has none for the code. */
export function codedText(code: string, params?: ErrorParams): string | undefined {
  if (!CODE_PATTERN.test(code)) return undefined;
  const key = `errors:${code}`;
  const text = t(key, params);
  return text === key ? undefined : text;
}

/** A stored note (a sync failure kept in a row): its code and params when it has them, else the English text it was saved with. */
export function noteText(
  note: { message: string | null; code?: string | null; params?: unknown },
  fallback = '',
): string {
  if (typeof note.code === 'string') {
    const text = codedText(note.code, paramsOf(note.params));
    if (text !== undefined) return text;
  }
  return note.message ?? fallback;
}

export type ErrorBody = {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  params?: unknown;
  paths?: unknown;
};

/** The sentence of the body's own `code`, or undefined (no code, a malformed one, one this app has no message for). */
export function explicitText(body: ErrorBody, retryAfter?: number): string | undefined {
  if (typeof body.code !== 'string' || !CODE_PATTERN.test(body.code)) return undefined;
  return codedText(body.code, { wait: waitText(retryAfter ?? 60), ...paramsOf(body.params) });
}

/**
 * The sentence for the legacy `error` word (`not_found` is `errors:api.notFound`), or undefined. `invalid_request` with issues is left
 * to the caller (its sentence is the first issue), and `local_*` errors carry their own sentence.
 */
export function legacyText(body: ErrorBody, retryAfter?: number): string | undefined {
  const error = body.error;
  if (typeof error !== 'string' || error === '' || error.startsWith('local_')) return undefined;
  const issues = (body as { issues?: unknown }).issues;
  if (error === 'invalid_request' && Array.isArray(issues) && issues.length > 0) return undefined;
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === 'string')
    : [];
  if (error === 'base_changed' && paths.length > 0) {
    return codedText('api.baseChangedFiles', { paths: paths.join(', ') });
  }
  return codedText(legacyCode(error), {
    wait: waitText(retryAfter ?? 60),
    ...paramsOf(body.params),
  });
}

/** The translated sentence for an error body, or undefined to let the caller choose (the server's own `message`). */
export const errorText = (body: ErrorBody, retryAfter?: number): string | undefined =>
  explicitText(body, retryAfter) ?? legacyText(body, retryAfter);
