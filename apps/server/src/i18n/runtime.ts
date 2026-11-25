/**
 * The server's translation runtime (docs/i18n-server.md, ADR 0045): the pure part. No file access, no globals except `Intl`, so
 * `node --test` runs it and the catalog check can reason about it.
 *
 * It reads the same catalog format as the web app (flat JSON, `{{name}}` placeholders, plurals as `key_one` / `key_other`) and follows
 * the same rules as `apps/web/src/lib/i18n/core.ts`. It is a deliberate small copy, not an import: the desktop build stages `apps/server`
 * and `packages/*` and not `apps/web/src`, so a server file must not reach into the web sources. `runtime.test.ts` pins the copy
 * against the web runtime (same plural choice, same interpolation, same tag reading) so the two cannot drift.
 */

/** Values a message can take: `{{name}}` is replaced by `String(params.name)`. `count` also selects the plural form. */
export type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** One catalog file: flat key to message. */
export type Catalog = Readonly<Record<string, string>>;

/** Finds the loaded catalog of a namespace in a language, or undefined when there is none. */
export type Lookup = (locale: string, ns: string) => Catalog | undefined;

export const SOURCE_LOCALE = 'en';

/**
 * The languages the server has catalogs for, English first. The same list as `availableLocales` in the web app
 * (`runtime.test.ts` compares them); a language is added in both places.
 */
export const SERVER_LOCALES: readonly string[] = ['en', 'fr', 'es', 'de'];

export const isServerLocale = (code: unknown): code is string =>
  typeof code === 'string' && SERVER_LOCALES.includes(code);

/** The tags a message may contain, as in the web catalogs. `link` kinds are for the web; the server renders `strong`, `em`, `code`. */
export const RICH_TAGS: readonly string[] = ['link', 'link2', 'link3', 'strong', 'em', 'code'];

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const TAG = /<(\/?)([a-z][a-z0-9]*)>/g;

// ---------------------------------------------------------------------------------------------
// Choosing a language

const languageOf = (tag: string): string =>
  tag.toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';

/**
 * The language to answer in for an `Accept-Language` header (RFC 9110): entries are ranked by their `q` (default 1, `q=0` means "not
 * this one"), ties keep the order written. For each entry the exact tag wins, then the same language with another region (`fr-CA`
 * gives `fr`). `*` and languages we have no catalog for are skipped; nothing usable gives `fallback`. A malformed header never throws.
 */
export function negotiateLocale(
  header: string | null | undefined,
  available: readonly string[] = SERVER_LOCALES,
  fallback: string = SOURCE_LOCALE,
): string {
  if (!header || header.length > 1000) return fallback;
  const entries: { tag: string; q: number; at: number }[] = [];
  header.split(',').forEach((raw, at) => {
    const [tagPart, ...params] = raw.split(';');
    const tag = (tagPart ?? '').trim();
    if (!/^[A-Za-z]{1,8}([-_][A-Za-z0-9]{1,8})*$/.test(tag)) return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number.parseFloat(m[1] as string);
    }
    if (!Number.isFinite(q) || q <= 0) return;
    entries.push({ tag, q: Math.min(q, 1), at });
  });
  entries.sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { tag } of entries) {
    const normal = tag.toLowerCase().replace(/_/g, '-');
    const exact = available.find((a) => a.toLowerCase() === normal);
    if (exact) return exact;
    const language = languageOf(tag);
    const loose = available.find((a) => languageOf(a) === language);
    if (loose) return loose;
  }
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// Plurals

const rulesCache = new Map<string, Intl.PluralRules | null>();

function rulesFor(locale: string): Intl.PluralRules | null {
  let rules = rulesCache.get(locale);
  if (rules === undefined) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = null;
    }
    rulesCache.set(locale, rules);
  }
  return rules;
}

export const pluralCategory = (locale: string, count: number): string =>
  rulesFor(locale)?.select(count) ?? 'other';

/**
 * The raw message for a key. With a `count` the order is `key_<category>`, `key_other`, `key`; without one `key`, then `key_other`.
 * An empty string is an untranslated string (Weblate writes those) and counts as missing.
 */
export function pickMessage(
  catalog: Catalog,
  key: string,
  locale: string,
  count: number | undefined,
): string | undefined {
  const order =
    count === undefined
      ? [key, `${key}_other`]
      : [`${key}_${pluralCategory(locale, count)}`, `${key}_other`, key];
  for (const candidate of order) {
    const value = catalog[candidate];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Interpolation and rich text

function countText(count: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(count);
  } catch {
    return String(count);
  }
}

/**
 * Replaces `{{name}}` in one pass (a value that itself holds `{{x}}` is not replaced again). A placeholder with no value stays as
 * written, so a mistake is visible. `count` is written with the language's digit grouping. `escapeText` (for HTML) is applied to every
 * value AND to the fixed text around them.
 */
export function interpolate(
  message: string,
  params: Params | undefined,
  locale: string,
  escapeText: (text: string) => string = (text) => text,
): string {
  let out = '';
  let from = 0;
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  for (let m = pattern.exec(message); m; m = pattern.exec(message)) {
    out += escapeText(message.slice(from, m.index));
    from = m.index + m[0].length;
    const name = m[1] as string;
    if (!params || !Object.hasOwn(params, name)) {
      out += escapeText(m[0]);
      continue;
    }
    const value = params[name];
    if (value === null || value === undefined) continue;
    out +=
      name === 'count' && typeof value === 'number' && Number.isFinite(value)
        ? escapeText(countText(value, locale))
        : escapeText(String(value));
  }
  return out + escapeText(message.slice(from));
}

export type RichPart = { text: string; tag?: string };

/** Splits a raw message at its `<tag>…</tag>` pairs (tags of `RICH_TAGS` only; anything else stays text). Same rules as the web. */
export function splitRich(message: string): RichPart[] {
  const parts: RichPart[] = [];
  let from = 0;
  const pattern = new RegExp(TAG.source, 'g');
  for (let m = pattern.exec(message); m; m = pattern.exec(message)) {
    const name = m[2] as string;
    if (m[1] === '/' || !RICH_TAGS.includes(name)) continue;
    const close = message.indexOf(`</${name}>`, pattern.lastIndex);
    if (close < 0) continue;
    if (m.index > from) parts.push({ text: message.slice(from, m.index) });
    parts.push({ tag: name, text: message.slice(pattern.lastIndex, close) });
    from = close + name.length + 3;
    pattern.lastIndex = from;
  }
  if (from < message.length || parts.length === 0) parts.push({ text: message.slice(from) });
  return parts;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Renders the parts of a message as HTML: text and values escaped, `strong`, `em` and `code` as elements, `link*` through `links`. */
export function richToHtml(
  raw: string,
  params: Params | undefined,
  locale: string,
  links: Readonly<Record<string, (innerHtml: string) => string>> = {},
): string {
  return splitRich(raw)
    .map((part) => {
      const inner = interpolate(part.text, params, locale, escapeHtml);
      if (part.tag === undefined) return inner;
      const wrap = links[part.tag];
      if (wrap) return wrap(inner);
      return part.tag.startsWith('link') ? inner : `<${part.tag}>${inner}</${part.tag}>`;
    })
    .join('');
}

/** The message as plain text: tags removed, the words between them kept. */
export function richToText(raw: string, params: Params | undefined, locale: string): string {
  return splitRich(raw)
    .map((part) => interpolate(part.text, params, locale))
    .join('');
}

// ---------------------------------------------------------------------------------------------
// Translating

/** `ns:key` into its two parts, or null. */
export function splitKey(full: string): { ns: string; key: string } | null {
  const at = full.indexOf(':');
  if (at <= 0 || at === full.length - 1) return null;
  return { ns: full.slice(0, at), key: full.slice(at + 1) };
}

/**
 * The raw message of `ns:key` for a language and the language it was found in: the language itself, then English. Undefined when no
 * catalog has it.
 */
export function resolveMessage(
  full: string,
  params: Params | undefined,
  locale: string,
  lookup: Lookup,
): { raw: string; locale: string } | undefined {
  const parts = splitKey(full);
  if (!parts) return undefined;
  const count =
    typeof params?.count === 'number' && Number.isFinite(params.count) ? params.count : undefined;
  const chain = locale === SOURCE_LOCALE ? [SOURCE_LOCALE] : [locale, SOURCE_LOCALE];
  for (const language of chain) {
    const catalog = lookup(language, parts.ns);
    const raw = catalog ? pickMessage(catalog, parts.key, language, count) : undefined;
    if (raw !== undefined) return { raw, locale: language };
  }
  return undefined;
}
