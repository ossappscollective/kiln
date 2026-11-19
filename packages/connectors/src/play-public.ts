import { AsoError, checkStatus, cleanPublicText, decodeEntities, getCapped } from './aso-common.ts';
import { isPlayPackageName } from './googleplay.ts';
import { isRecord } from './store-http.ts';

/**
 * Google Play, from its PUBLIC web pages. UNOFFICIAL, OPT-IN, FRAGILE.
 *
 * Google Play has no official API for search results or for the public data of any app. The Play
 * Developer API (googleplay.ts and friends) is for your own apps and has no search. Reading the public
 * pages of the store from a program may be against the Google Play Terms of Service or Google's Terms
 * of Service: that was NOT checked by a lawyer and is for the operator to decide. That is why this
 * is off unless the operator sets `MRM_ASO_PLAY_UNOFFICIAL_ENABLED=true` (the server passes it as
 * `enabled`; a connector that is not enabled makes no request and throws `unavailable/disabled`).
 * docs/adr/0011-aso-keywords-competitors.md has the stance in full.
 *
 * What it does, and no more:
 * - GET `https://play.google.com/store/search?q=<term>&c=apps&hl=<language>&gl=<country>` and reads the
 *   package names of the result links, in page order. That is the rank.
 * - GET `https://play.google.com/store/apps/details?id=<package>&hl=<language>&gl=<country>` and reads the
 *   public data of one app (name, description, rating, price, icon, number of screenshots).
 * - No login, no cookie, no API key, no JavaScript. Redirects are not followed (a consent page is a redirect:
 *   it is reported as `unavailable/redirect`). A 429 or 403 is `rate_limited`; a page with a robot check is
 *   `unavailable/blocked`. The User-Agent says what this is.
 * - Page sizes are capped and the host is fixed. The server also limits the rate (a few requests a minute),
 *   caches, and backs off (services/aso.ts).
 *
 * UNVERIFIED, all of it: the markup was not fetched or checked from here (no network was used and the
 * Terms were not tested against). The parsers look for: result links with `/store/apps/details?id=`;
 * schema.org JSON-LD (`SoftwareApplication`) for the name, description, rating, price, version and
 * image; the `og:` meta tags and `<title>`; `data-g-id="description"`; `data-screenshot-index`; and
 * `aria-label="Rated 4.5 stars ..."`. Each is optional. The fixtures in play-public.test.ts are
 * SYNTHETIC: written by hand to look like that markup, not saved from Google.
 *
 * When Google changes the pages the result is "unavailable" (`unavailable/layout_changed`), never a
 * made-up rank and never "not ranked": a search page with no result link at all, or an app page with no
 * name, is treated as a layout change. Search terms and package names are never in an error message.
 */

export const PLAY_HOST = 'play.google.com';
export const PLAY_SEARCH_URL = `https://${PLAY_HOST}/store/search`;
export const PLAY_DETAILS_URL = `https://${PLAY_HOST}/store/apps/details`;
const MAX_BYTES = 3 * 1024 * 1024;
export const PLAY_DEFAULT_SEARCH_LIMIT = 30;
export const PLAY_MAX_SEARCH_LIMIT = 50;

/** Shown wherever the unofficial source is offered (the config route, the docs, the web UI). */
export const PLAY_UNOFFICIAL_NOTICE =
  'Google Play has no official search or listing API. This reads the public pages of play.google.com, which may be against the Google Play Terms of Service or Google\'s Terms of Service. It is off by default; turn it on only if you accept that risk. It can stop working whenever Google changes its pages.';

export type PlayApp = {
  packageName: string;
  name: string;
  description?: string;
  version?: string;
  /** `0` for free, else the number as the page gives it. */
  price?: string;
  currency?: string;
  ratingMilli?: number;
  ratingCount?: number;
  iconUrl?: string;
  /** Null when the page does not say. */
  screenshotCount?: number;
  developer?: string;
  category?: string;
};

// ---------------------------------------------------------------------------------------------
// Parsing (pure; the page text in, data out)

const PACKAGE_LINK = /\/store\/apps\/details\?id(?:=|\\u003d)([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/g;

/** The package names linked from a search page, in page order, once each. Empty when the page has no such link. */
export function parsePlaySearch(html: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const text = html.replace(/\\\//g, '/');
  PACKAGE_LINK.lastIndex = 0;
  for (let match = PACKAGE_LINK.exec(text); match !== null; match = PACKAGE_LINK.exec(text)) {
    const id = match[1] as string;
    if (!seen.has(id) && isPlayPackageName(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

const TAG = (name: string) => new RegExp(`<${name}\\b[^>]*>`, 'gi');

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  const value = match ? (match[2] ?? match[3]) : undefined;
  return value === undefined ? undefined : decodeEntities(value);
}

function meta(html: string, key: string): string | undefined {
  for (const tag of html.match(TAG('meta')) ?? []) {
    const name = attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop');
    if (name && name.toLowerCase() === key) {
      const content = attr(tag, 'content');
      if (content !== undefined) return content;
    }
  }
  return undefined;
}

function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = re.exec(html); match !== null; match = re.exec(html)) {
    let value: unknown;
    try {
      value = JSON.parse(match[1] as string);
    } catch {
      continue;
    }
    const stack: unknown[] = [value];
    while (stack.length > 0 && out.length < 20) {
      const item = stack.pop();
      if (Array.isArray(item)) stack.push(...item);
      else if (isRecord(item)) {
        out.push(item);
        if (Array.isArray(item['@graph'])) stack.push(...(item['@graph'] as unknown[]));
      }
    }
  }
  return out;
}

const asText = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? cleanPublicText(v, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;

const toNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, ''));
}

const MAX_DESCRIPTION = 4000;

/**
 * The public data of an app page, as far as the markup gives it. Returns undefined when not even a
 * name can be found (the caller then says "layout changed"). The package name is the one asked for.
 */
export function parsePlayApp(html: string, packageName: string): PlayApp | undefined {
  const ld = jsonLd(html).find((o) => {
    const type = o['@type'];
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => t === 'SoftwareApplication' || t === 'MobileApplication' || t === 'GameApplication');
  });
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const fromTitle = titleTag ? decodeEntities(titleTag).replace(/\s*[-–|]\s*Apps? on Google Play.*$/i, '').trim() : undefined;
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const name =
    asText(ld?.name, 200) ??
    cleanPublicText((meta(html, 'og:title') ?? '').replace(/\s*[-–|]\s*Apps? on Google Play.*$/i, ''), 200) ??
    cleanPublicText(h1 ? stripTags(h1) : undefined, 200) ??
    cleanPublicText(fromTitle, 200);
  if (!name) return undefined;
  const app: PlayApp = { packageName, name };

  const body = /<div\b[^>]*data-g-id\s*=\s*["']description["'][^>]*>([\s\S]{0,40000}?)<\/div>/i.exec(html)?.[1];
  const description =
    cleanPublicText(body ? stripTags(body) : undefined, MAX_DESCRIPTION) ??
    asText(ld?.description, MAX_DESCRIPTION) ??
    cleanPublicText(meta(html, 'og:description') ?? meta(html, 'description'), MAX_DESCRIPTION);
  if (description) app.description = description;

  const version =
    asText(ld?.softwareVersion, 50) ??
    cleanPublicText(/itemprop\s*=\s*["']softwareVersion["'][^>]*>([^<]{1,50})</i.exec(html)?.[1], 50);
  if (version) app.version = version;

  const rating = isRecord(ld?.aggregateRating) ? ld.aggregateRating : undefined;
  const ratingValue =
    toNumber(rating?.ratingValue) ?? toNumber(/aria-label\s*=\s*["']Rated\s+([0-9]+(?:\.[0-9]+)?)\s+stars?/i.exec(html)?.[1]);
  if (ratingValue !== undefined && ratingValue >= 0 && ratingValue <= 5) app.ratingMilli = Math.round(ratingValue * 1000);
  const ratingCount =
    toNumber(rating?.ratingCount) ??
    toNumber(rating?.reviewCount) ??
    toNumber(/itemprop\s*=\s*["']ratingCount["'][^>]*content\s*=\s*["']([0-9]+)["']/i.exec(html)?.[1]);
  if (ratingCount !== undefined && Number.isInteger(ratingCount) && ratingCount >= 0 && ratingCount <= 1e10) app.ratingCount = ratingCount;

  const offers = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const offer = isRecord(offers) ? offers : undefined;
  const price = asText(offer?.price, 20) ?? cleanPublicText(meta(html, 'price'), 20);
  if (price) app.price = price;
  const currency = asText(offer?.priceCurrency, 10);
  if (currency) app.currency = currency;

  const image = asText(Array.isArray(ld?.image) ? ld.image[0] : ld?.image, 500) ?? cleanPublicText(meta(html, 'og:image'), 500);
  if (image) app.iconUrl = image;

  const shots = (html.match(/data-screenshot-index\s*=\s*["'][0-9]+["']/gi) ?? []).length;
  const ldShots = Array.isArray(ld?.screenshot) ? ld.screenshot.length : undefined;
  if (shots > 0) app.screenshotCount = Math.min(shots, 50);
  else if (ldShots !== undefined) app.screenshotCount = Math.min(ldShots, 50);

  const author = isRecord(ld?.author) ? asText(ld.author.name, 200) : undefined;
  if (author) app.developer = author;
  const category = asText(ld?.applicationCategory, 100);
  if (category) app.category = category;
  return app;
}

/** Signs of a robot check or a consent wall in a 200 page. */
function blocked(html: string): boolean {
  return /unusual traffic|\/sorry\/|g-recaptcha/i.test(html.slice(0, 200_000));
}

// ---------------------------------------------------------------------------------------------
// The connector

export type PlayPublicOptions = {
  /** MRM_ASO_PLAY_UNOFFICIAL_ENABLED. False: no request is ever made. */
  enabled: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PlaySearchOptions = {
  term: string;
  /** Two letters (`gl`). */
  country: string;
  /** `hl`, a language tag such as `en` or `pt-BR`. */
  language?: string;
  /** At most 50, default 30: what the first page holds is all there is (infinite scroll is not followed). */
  limit?: number;
};

export type PlaySearchResult = { ids: string[]; total: number; limit: number };

const country = (value: string): string => {
  if (!/^[A-Za-z]{2}$/.test(value)) throw new AsoError('play_public', 'invalid_input', 'The storefront must be a two letter country code.');
  return value.toLowerCase();
};
const language = (value: string | undefined): string => {
  const v = (value ?? 'en').replace(/_/g, '-');
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(v)) throw new AsoError('play_public', 'invalid_input', 'The language is not a language tag.');
  return v;
};

export function playSearchUrl(options: PlaySearchOptions): string {
  return `${PLAY_SEARCH_URL}?q=${encodeURIComponent(options.term.trim())}&c=apps&hl=${language(options.language)}&gl=${country(options.country)}`;
}

export function playDetailsUrl(packageName: string, countryCode: string, lang?: string): string {
  return `${PLAY_DETAILS_URL}?id=${packageName}&hl=${language(lang)}&gl=${country(countryCode)}`;
}

export class PlayPublicConnector {
  readonly #options: PlayPublicOptions;
  constructor(options: PlayPublicOptions) {
    this.#options = options;
  }

  get enabled(): boolean {
    return this.#options.enabled;
  }

  #guard(): void {
    if (!this.#options.enabled) {
      throw new AsoError('play_public', 'unavailable', 'Reading Google Play pages is switched off (MRM_ASO_PLAY_UNOFFICIAL_ENABLED).', { reason: 'disabled' });
    }
  }

  async #page(url: string): Promise<string | undefined> {
    const got = await getCapped({
      source: 'play_public',
      url,
      accept: 'text/html',
      maxBytes: MAX_BYTES,
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
    });
    if (got.status >= 300 && got.status < 400) {
      throw new AsoError('play_public', 'unavailable', 'Google Play redirected the request (a consent page or a moved address).', { status: got.status, reason: 'redirect' });
    }
    if (got.status === 404) return undefined;
    checkStatus('play_public', got);
    if (blocked(got.text)) {
      throw new AsoError('play_public', 'unavailable', 'Google Play asked for a consent or a robot check.', { reason: 'blocked' });
    }
    return got.text;
  }

  /** The package names that Google Play lists for a search, in order. Throws `AsoError`. */
  async search(options: PlaySearchOptions): Promise<PlaySearchResult> {
    this.#guard();
    const term = options.term.trim();
    if (term === '' || term.length > 200) throw new AsoError('play_public', 'invalid_input', 'The search term is empty or too long.');
    const limit = options.limit ?? PLAY_DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > PLAY_MAX_SEARCH_LIMIT) {
      throw new AsoError('play_public', 'invalid_input', `The limit must be a whole number from 1 to ${PLAY_MAX_SEARCH_LIMIT}.`);
    }
    const html = await this.#page(playSearchUrl(options));
    const ids = html === undefined ? [] : parsePlaySearch(html).slice(0, limit);
    if (ids.length === 0) {
      // Not "no result": a search page that lists no app at all is far more likely a changed layout.
      throw new AsoError('play_public', 'unavailable', 'Google Play\'s search page held no app links: its layout may have changed.', { reason: 'layout_changed' });
    }
    return { ids, total: ids.length, limit };
  }

  /** The public data of one app, or undefined when Google Play has no such app in that country (404). Throws `AsoError`. */
  async getApp(options: { packageName: string; country: string; language?: string }): Promise<PlayApp | undefined> {
    this.#guard();
    if (!isPlayPackageName(options.packageName)) throw new AsoError('play_public', 'invalid_input', 'Not a valid Android package name.');
    const html = await this.#page(playDetailsUrl(options.packageName, options.country, options.language));
    if (html === undefined) return undefined;
    const app = parsePlayApp(html, options.packageName);
    if (!app) {
      throw new AsoError('play_public', 'unavailable', 'Google Play\'s app page held no app name: its layout may have changed.', { reason: 'layout_changed' });
    }
    return app;
  }
}
