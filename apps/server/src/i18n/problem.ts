/**
 * Stable machine codes for the sentences a person reads (docs/i18n-server.md, ADR 0045).
 *
 * A response or a stored note keeps its English `message` (API clients, the MCP server and old data rely on it) and may add
 * `code` (dot.case, for example `store.google.unreadableResponse`) and `params` (what the sentence needs: a store name, a number,
 * a branch). The web app shows `errors:<code>` in the person's language and falls back to `message` for a code it does not know.
 * `coded()` is the one way to write the pair, so the code is checked in one place:
 *
 *   failure(409, 'sync_in_progress', 'A sync of this app is already running.', coded('sync.inProgress'))
 *   c.json({ error: 'busy', message: '...', ...coded('tokens.tooMany', { count: 30 }) }, 429)
 *
 * Params are plain scalars (never a secret: a token, a key, a password, an address of a person). Keys that look like secrets are
 * dropped, long text is cut, anything not a scalar is left out. `scripts/i18n.mjs` and `i18n/errors-catalog.test.ts` check that every
 * code written with `coded('…')` has an English message in `apps/web/locales/errors/en.json`.
 */
import type { Params } from './runtime.ts';

/** Segments of lower camelCase joined by dots, at least two: `store.rateLimited`, `store.google.unreadableResponse`. */
export const CODE_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

export type ErrorParams = Record<string, string | number | boolean | null>;
export type Coding = { code: string; params?: ErrorParams };

const SECRETY = /secret|token(?!Id)|password|passwd|ciphertext|authorization|private_?key|api_?key|credential/i;
const MAX_TEXT = 300;
export const MAX_PARAMS = 12;

/** Params safe to send and to store: scalars only, no secret-looking names, text cut to 300 characters. */
export function cleanParams(params: Params | undefined): ErrorParams | undefined {
  if (!params) return undefined;
  const out: ErrorParams = {};
  let n = 0;
  for (const [name, value] of Object.entries(params)) {
    if (n >= MAX_PARAMS || SECRETY.test(name) || value === undefined) continue;
    if (typeof value === 'string') out[name] = value.slice(0, MAX_TEXT);
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else if (typeof value === 'boolean' || value === null) out[name] = value;
    else continue;
    n++;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `{ code, params? }`, ready to spread into a response body. A malformed code is a bug in the caller and throws. */
export function coded(code: string, params?: Params): Coding {
  if (!CODE_PATTERN.test(code)) throw new Error(`"${code}" is not a valid error code (dot.case, e.g. store.rateLimited).`);
  const clean = cleanParams(params);
  return clean ? { code, params: clean } : { code };
}

/** `coded()` for a value that may not be coded at all: nothing to spread when there is no code. */
export function codingOf(source: { code?: unknown; params?: unknown } | null | undefined): Coding | Record<string, never> {
  if (!source || typeof source.code !== 'string' || !CODE_PATTERN.test(source.code)) return {};
  const params =
    source.params && typeof source.params === 'object' ? cleanParams(source.params as Params) : undefined;
  return params ? { code: source.code, params } : { code: source.code };
}

/**
 * The code of a response that has none: the legacy `error` word in dot.case form (`not_found` is `api.notFound`). It is how the web app
 * finds the sentence of every fixed `error` code without the server repeating it.
 */
export function legacyCode(error: string): string {
  const words = error.split('_').filter((w) => w !== '');
  const camel = words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
  return `api.${camel}`;
}

/**
 * The coding of an error's own sentence, but only when the text sent is that sentence: a caller that adds to it ("... Nothing was
 * changed.") or rewrites it has a message the code no longer describes, so it gets no code (and the English text is shown).
 */
export function messageCoding(error: unknown, sent: string): Coding | Record<string, never> {
  return error instanceof Error && sent === error.message ? codingOf(error as { code?: unknown; params?: unknown }) : {};
}
