/**
 * The pure part of the translation runtime: no Svelte, no Vite, no globals except `Intl`, so `node --test` can run it
 * and `scripts/i18n.mjs` (the catalog check) shares the exact same rules as the app (plural categories, placeholders, tags).
 * See docs/i18n.md. Keep the library calls ES2017-safe: the web build targets ES2017.
 */

/** Values a message can take: `{{name}}` is replaced by `String(params.name)`. `count` also selects the plural form. */
export type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** One catalog file: flat key to message. */
export type Catalog = Readonly<Record<string, string>>;

/** Finds the loaded catalog of a namespace in a language, or undefined when it is not loaded. */
export type Lookup = (locale: string, ns: string) => Catalog | undefined;

export const SOURCE_LOCALE = 'en';
/** A development locale built from English at run time (accents, brackets, longer text). Has no files. */
export const PSEUDO_LOCALE = 'pseudo';

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** The tags a message may contain (see `splitRich`). Closing tags are written `</name>`. Tags never nest. */
export const RICH_TAGS: readonly string[] = ['link', 'link2', 'link3', 'strong', 'em', 'code'];

/** Key grammar: dot-separated camelCase segments, optionally ending in a plural suffix. */
export const KEY_PATTERN =
  /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*(_(zero|one|two|few|many|other))?$/;
/** Namespace grammar. */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------------------------
// Keys

/** Splits `ns:key`. Null when there is no namespace or no key. */
export function splitKey(full: string): { ns: string; key: string } | null {
  const at = full.indexOf(':');
  if (at <= 0 || at === full.length - 1) return null;
  return { ns: full.slice(0, at), key: full.slice(at + 1) };
}

/** `delta.up_one` is the plural form `one` of `delta.up`; any other key is its own base. */
export function splitPluralKey(key: string): { base: string; category: PluralCategory | null } {
  const at = key.lastIndexOf('_');
  if (at > 0) {
    const suffix = key.slice(at + 1);
    if ((PLURAL_CATEGORIES as readonly string[]).indexOf(suffix) >= 0) {
      return { base: key.slice(0, at), category: suffix as PluralCategory };
    }
  }
  return { base: key, category: null };
}

// ---------------------------------------------------------------------------------------------
// Languages and plurals

/** What `Intl` should be given for an app locale: the pseudo locale reads like English. */
export const intlLocaleOf = (locale: string): string =>
  locale === PSEUDO_LOCALE ? SOURCE_LOCALE : locale;

const rulesCache = new Map<string, Intl.PluralRules | null>();

function rulesFor(locale: string): Intl.PluralRules | null {
  const tag = intlLocaleOf(locale);
  let rules = rulesCache.get(tag);
  if (rules === undefined) {
    try {
      rules = new Intl.PluralRules(tag);
    } catch {
      rules = null;
    }
    rulesCache.set(tag, rules);
  }
  return rules;
}

/** The plural categories a language uses, for example `one, other` for English and `one, many, other` for French. */
export function pluralCategories(locale: string): PluralCategory[] {
  const rules = rulesFor(locale);
  if (!rules) return ['other'];
  return rules.resolvedOptions().pluralCategories as PluralCategory[];
}

/** The plural category of a number in a language; `other` when the language is unknown. */
export function pluralCategory(locale: string, count: number): PluralCategory {
  const rules = rulesFor(locale);
  return rules ? (rules.select(count) as PluralCategory) : 'other';
}

// ---------------------------------------------------------------------------------------------
// Placeholders, tags and rich text

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const TAG = /<(\/?)([a-z][a-z0-9]*)>/g;

/** The distinct `{{name}}` placeholders of a message, sorted. */
export function placeholdersOf(message: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  for (let m = pattern.exec(message); m; m = pattern.exec(message)) {
    const name = m[1] as string;
    if (found.indexOf(name) < 0) found.push(name);
  }
  return found.sort();
}

/** The opening and closing tags of a message in order of appearance, as `{ name, closing }`. Unknown tags are included. */
export function tagsOf(message: string): { name: string; closing: boolean }[] {
  const found: { name: string; closing: boolean }[] = [];
  const pattern = new RegExp(TAG.source, 'g');
  for (let m = pattern.exec(message); m; m = pattern.exec(message)) {
    found.push({ name: m[2] as string, closing: m[1] === '/' });
  }
  return found;
}

/** What must be the same in every language: `{{name}}` placeholders and `<tag>` names, sorted and distinct. */
export function tokensOf(message: string): string[] {
  const tokens = placeholdersOf(message).map((p) => `{{${p}}}`);
  for (const tag of tagsOf(message)) {
    if (!tag.closing && tokens.indexOf(`<${tag.name}>`) < 0) tokens.push(`<${tag.name}>`);
  }
  return tokens.sort();
}

/**
 * Whether a message uses tags correctly: every tag is in `RICH_TAGS`, each opening tag has its closing tag right after its text
 * and tags do not nest. Returns a sentence about the first problem, or '' when it is fine.
 */
export function tagProblem(message: string): string {
  const tags = tagsOf(message);
  let open: string | null = null;
  for (const tag of tags) {
    if (RICH_TAGS.indexOf(tag.name) < 0)
      return `<${tag.name}> is not an allowed tag (allowed: ${RICH_TAGS.join(', ')}).`;
    if (!tag.closing) {
      if (open !== null) return `<${tag.name}> inside <${open}>: tags do not nest.`;
      open = tag.name;
    } else if (open !== tag.name) {
      return open === null
        ? `</${tag.name}> has no opening tag.`
        : `</${tag.name}> closes <${open}>.`;
    } else {
      open = null;
    }
  }
  if (open !== null) return `<${open}> is never closed.`;
  const stray = /<[A-Za-z/!]/.exec(message.replace(new RegExp(TAG.source, 'g'), ''));
  if (stray)
    return 'Looks like HTML. Messages hold text, {{placeholders}} and the documented tags only.';
  if (/&[A-Za-z#0-9]+;/.test(message))
    return 'HTML entities are not allowed: write the character itself.';
  return '';
}

export type RichPart = { text: string; tag?: undefined } | { text: string; tag: string };

/**
 * Splits a raw message into plain and tagged parts: `Read <link>the guide</link> first.` is
 * `[{ text: 'Read ' }, { tag: 'link', text: 'the guide' }, { text: ' first.' }]`. Only tags in `RICH_TAGS` count; anything else, and an
 * opening tag without its closing tag, stays as text. The text inside a tag is never parsed again.
 */
export function splitRich(message: string): RichPart[] {
  const parts: RichPart[] = [];
  let from = 0;
  const pattern = new RegExp(TAG.source, 'g');
  for (let m = pattern.exec(message); m; m = pattern.exec(message)) {
    const name = m[2] as string;
    if (m[1] === '/' || RICH_TAGS.indexOf(name) < 0) continue;
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

// ---------------------------------------------------------------------------------------------
// Interpolation

function countText(count: number, locale: string): string {
  try {
    return new Intl.NumberFormat(intlLocaleOf(locale)).format(count);
  } catch {
    return String(count);
  }
}

/**
 * Replaces `{{name}}` with the value in one pass (a value that itself contains `{{x}}` is not replaced again). A placeholder with no
 * value in `params` stays as written, so a mistake is visible. `count` is written with the language's digit grouping.
 */
export function interpolate(message: string, params: Params | undefined, locale: string): string {
  if (!params || message.indexOf('{{') < 0) return message;
  return message.replace(new RegExp(PLACEHOLDER.source, 'g'), (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    if (value === null || value === undefined) return '';
    if (name === 'count' && typeof value === 'number' && Number.isFinite(value))
      return countText(value, locale);
    return String(value);
  });
}

// ---------------------------------------------------------------------------------------------
// Pseudo-locale

const ACCENTED: Record<string, string> = {
  a: 'à',
  b: 'ƀ',
  c: 'ç',
  d: 'ď',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ľ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ɋ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'À',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ď',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ľ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ɋ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

/**
 * "Save changes" becomes "[Šàṽé çĥàñĝéš ~~~]": letters are accented (so a hard-coded string stands out as plain ASCII), the whole text
 * sits in brackets (a missing bracket shows clipping), and it is about 30 percent longer (a layout that breaks here will break in German
 * or French). `{{placeholders}}` and the documented tags are left alone, so the result still works as a message.
 */
export function pseudoize(message: string): string {
  let letters = 0;
  const body = message
    .split(/(\{\{[^}]*\}\}|<\/?[a-z][a-z0-9]*>)/)
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk;
      let out = '';
      for (const ch of chunk) {
        const accented = ACCENTED[ch];
        if (accented !== undefined) letters++;
        out += accented ?? ch;
      }
      return out;
    })
    .join('');
  const pad = Math.ceil(letters * 0.3);
  return `[${body}${pad > 0 ? ` ${'~'.repeat(pad)}` : ''}]`;
}

// ---------------------------------------------------------------------------------------------
// Translating

export type TranslateOptions = {
  locale: string;
  lookup: Lookup;
  /** Called when a key has no message in any language. Not called for a key that only exists in English. */
  onMissing?: ((key: string, locale: string) => void) | undefined;
};

/**
 * The raw message (placeholders and tags still in it) for a key with the plural rules of `locale`, or undefined. With a `count` the order
 * is `key_<category>`, `key_other`, `key`; without one `key`, then `key_other`. An empty string is an untranslated string (Weblate writes
 * those) and counts as missing.
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

function countOf(params: Params | undefined): number | undefined {
  const count = params?.count;
  return typeof count === 'number' && Number.isFinite(count) ? count : undefined;
}

/** The raw message and the language it was found in (the plural rules and the pseudo-locale follow it), or null. */
function resolve(
  full: string,
  params: Params | undefined,
  opts: TranslateOptions,
): { raw: string; locale: string } | null {
  const parts = splitKey(full);
  if (parts) {
    const count = countOf(params);
    const chain =
      opts.locale === SOURCE_LOCALE || opts.locale === PSEUDO_LOCALE
        ? [SOURCE_LOCALE]
        : [opts.locale, SOURCE_LOCALE];
    for (const language of chain) {
      const catalog = opts.lookup(language, parts.ns);
      const raw = catalog ? pickMessage(catalog, parts.key, language, count) : undefined;
      if (raw !== undefined)
        return { raw: opts.locale === PSEUDO_LOCALE ? pseudoize(raw) : raw, locale: language };
    }
  }
  opts.onMissing?.(full, opts.locale);
  return null;
}

/**
 * The message of `ns:key` in the active language with `{{placeholders}}` filled. A key missing from the language is read from English; a
 * key missing everywhere is returned as written (`onMissing` is told). Tags stay in the text: use `translateParts` for messages with tags.
 */
export function translate(
  full: string,
  params: Params | undefined,
  opts: TranslateOptions,
): string {
  const found = resolve(full, params, opts);
  return found ? interpolate(found.raw, params, opts.locale) : full;
}

/** Like `translate`, split into parts for the `<T>` component. Tags are found before the values are put in, so a value can never add a tag. */
export function translateParts(
  full: string,
  params: Params | undefined,
  opts: TranslateOptions,
): RichPart[] {
  const found = resolve(full, params, opts);
  if (!found) return [{ text: full }];
  return splitRich(found.raw).map((part) => ({
    ...part,
    text: interpolate(part.text, params, opts.locale),
  }));
}
