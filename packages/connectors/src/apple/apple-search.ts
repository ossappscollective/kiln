import { AsoError, type CappedGet, checkStatus, cleanPublicText, getCapped } from '../aso-common.ts';
import { ITUNES_LOOKUP_URL } from './itunes-rating.ts';
import { isRecord, num, records } from '../store-http.ts';

/**
 * Apple, from the public iTunes Search and Lookup APIs: where apps rank for a search term in a
 * storefront, and the public data of an app. No credential, one GET to a fixed host.
 *
 * Checked on Apple's pages on 2026-11-18 (https://performance-partners.apple.com/search-api, which
 * the old developer.apple.com Search API guide redirects to, and the Lookup examples at
 * https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html):
 *
 * - `GET https://itunes.apple.com/search?term=<url encoded>&country=<ISO 3166-1 alpha-2>&media=software&entity=software&limit=<1..200>`.
 *   `term` and `country` are required, `country` defaults to US, `limit` defaults to 50 and is 1 to 200,
 *   `media=software` and `entity=software` (also `iPadSoftware`, `desktopSoftware`) are documented values,
 *   `lang` is `en_us` or `ja_jp`, `explicit` is Yes or No.
 * - "The Search API is limited to approximately 20 calls per minute (subject to change)", and "large
 *   websites should set up caching logic for the search and lookup requests". This module does no
 *   throttling of its own: the server limits and caches (services/aso.ts).
 * - `GET https://itunes.apple.com/lookup?id=<id>` is documented for an iTunes id.
 *
 * UNVERIFIED (not on those pages; what the service is widely observed to do): that the order of the
 * results equals the order of the App Store app's own search (Apple does not say, so a "rank" is a
 * position in THIS API's results, a proxy and not the App Store's ranking); the software result
 * fields (`trackId`, `trackName`, `bundleId`, `version`, `formattedPrice`, `price`, `currency`,
 * `averageUserRating`, `userRatingCount`, `description`, `screenshotUrls`, `artworkUrl512`,
 * `sellerName`, `primaryGenreName`, `trackViewUrl`); the `country` parameter on a lookup; that there is
 * no subtitle in the reply (there is none in what is parsed here). The parser accepts the absence of
 * every optional field, so a change on Apple's side gives less data and not an error.
 *
 * Search terms never appear in an error message, and nothing is logged here.
 */

export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
/**
 * The Mac App Store entities. The search page lists `desktopSoftware` among the software entities (documented), the
 * lookup practice and the `kind` of its answers (`mac-software`) say `macSoftware`: UNVERIFIED which one each endpoint
 * takes. A search for macOS apps asks `desktopSoftware` (the documented one), a lookup of a Mac app's rating `macSoftware`;
 * both are one constant here, so a correction is one line.
 */
export const APPLE_MAC_SEARCH_ENTITY = 'desktopSoftware';
export const APPLE_MAC_LOOKUP_ENTITY = 'macSoftware';
export const APPLE_SEARCH_MAX_LIMIT = 200;
export const APPLE_SEARCH_DEFAULT_LIMIT = 50;
/** Apple's own figure, "approximately 20 calls per minute (subject to change)". */
export const APPLE_DOCUMENTED_CALLS_PER_MINUTE = 20;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DESCRIPTION = 4000;

export type AppleApp = {
  /** Apple's numeric app id, as text. */
  trackId: string;
  name: string;
  bundleId?: string;
  version?: string;
  /** `Free` or the price as Apple formats it. */
  price?: string;
  currency?: string;
  /** Average rating in thousandths (4.5 stars is 4500). */
  ratingMilli?: number;
  ratingCount?: number;
  /** Public description, cut to 4000 characters. */
  description?: string;
  iconUrl?: string;
  /** The addresses of the screenshots (iPhone, then iPad). The server keeps only their number and a hash. */
  screenshotUrls: string[];
  sellerName?: string;
  genre?: string;
};

const text = (v: unknown, max = 300): string | undefined => cleanPublicText(v, max);

function toApp(entry: Record<string, unknown>): AppleApp | undefined {
  const id =
    typeof entry.trackId === 'number' && Number.isInteger(entry.trackId)
      ? String(entry.trackId)
      : typeof entry.trackId === 'string' && /^[0-9]{1,20}$/.test(entry.trackId)
        ? entry.trackId
        : undefined;
  if (id === undefined) return undefined;
  const kind = typeof entry.kind === 'string' ? entry.kind : undefined;
  const wrapper = typeof entry.wrapperType === 'string' ? entry.wrapperType : undefined;
  // A search for software answers with software. Anything that says it is something else is not an app.
  if (
    (kind !== undefined && kind !== 'software' && kind !== 'mac-software') ||
    (wrapper !== undefined && wrapper !== 'software')
  ) {
    return undefined;
  }
  const rating = num(entry.averageUserRating);
  const count = num(entry.userRatingCount);
  const price =
    text(entry.formattedPrice, 40) ??
    (typeof entry.price === 'number' && Number.isFinite(entry.price)
      ? entry.price === 0
        ? 'Free'
        : String(entry.price)
      : undefined);
  const shots = [
    ...(Array.isArray(entry.screenshotUrls) ? entry.screenshotUrls : []),
    ...(Array.isArray(entry.ipadScreenshotUrls) ? entry.ipadScreenshotUrls : []),
  ]
    .filter((u): u is string => typeof u === 'string' && u.length <= 500)
    .slice(0, 40);
  const icon = text(entry.artworkUrl512, 500) ?? text(entry.artworkUrl100, 500);
  const app: AppleApp = {
    trackId: id,
    name: text(entry.trackName, 200) ?? '',
    screenshotUrls: shots,
  };
  const bundleId = text(entry.bundleId, 200);
  const version = text(entry.version, 50);
  const currency = text(entry.currency, 10);
  const description = text(entry.description, MAX_DESCRIPTION);
  const seller = text(entry.sellerName, 200);
  const genre = text(entry.primaryGenreName, 100);
  if (bundleId) app.bundleId = bundleId;
  if (version) app.version = version;
  if (price) app.price = price;
  if (currency) app.currency = currency;
  if (rating !== undefined && Number.isFinite(rating) && rating >= 0 && rating <= 5)
    app.ratingMilli = Math.round(rating * 1000);
  if (count !== undefined && Number.isInteger(count) && count >= 0 && count <= 1e10)
    app.ratingCount = count;
  if (description) app.description = description;
  if (icon) app.iconUrl = icon;
  if (seller) app.sellerName = seller;
  if (genre) app.genre = genre;
  return app;
}

/** The apps of a search or lookup reply, in the order Apple sent them. Throws `unexpected` when there is no `results` list. */
export function parseAppleApps(json: unknown): AppleApp[] {
  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new AsoError(
      'apple_search',
      'unexpected',
      'The iTunes Search API answered with something that is not a result list.',
    );
  }
  const out: AppleApp[] = [];
  const seen = new Set<string>();
  for (const entry of records(json.results)) {
    const app = toApp(entry);
    if (app && !seen.has(app.trackId)) {
      seen.add(app.trackId);
      out.push(app);
    }
  }
  return out;
}

function parseJson(got: CappedGet): unknown {
  try {
    return JSON.parse(got.text);
  } catch {
    throw new AsoError(
      'apple_search',
      'unexpected',
      'The iTunes Search API answered with a response that could not be read.',
    );
  }
}

export type AppleSearchOptions = {
  term: string;
  /** Two letters. */
  country: string;
  /** 1 to 200. Default 50. */
  limit?: number;
  /** `en_us` (default) or `ja_jp`. */
  lang?: 'en_us' | 'ja_jp';
  /** Search the Mac App Store (`entity=desktopSoftware`) instead of the iOS App Store. */
  macos?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type AppleSearchResult = {
  /** Apple's app ids in result order: index 0 is rank 1. */
  ids: string[];
  apps: AppleApp[];
  /** How many results came back (at most the limit asked). */
  total: number;
  limit: number;
};

/** The URL of a search. Pure, so tests and docs can show it. */
export function appleSearchUrl(
  options: Pick<AppleSearchOptions, 'term' | 'country' | 'limit' | 'lang' | 'macos'>,
): string {
  const limit = options.limit ?? APPLE_SEARCH_DEFAULT_LIMIT;
  const params = [
    `term=${encodeURIComponent(options.term)}`,
    `country=${options.country.toLowerCase()}`,
    'media=software',
    `entity=${options.macos === true ? APPLE_MAC_SEARCH_ENTITY : 'software'}`,
    `limit=${limit}`,
  ];
  if (options.lang) params.push(`lang=${options.lang}`);
  return `${ITUNES_SEARCH_URL}?${params.join('&')}`;
}

/** Searches the App Store storefront for apps matching a term. Throws `AsoError`. */
export async function searchApple(options: AppleSearchOptions): Promise<AppleSearchResult> {
  const term = options.term.trim();
  const limit = options.limit ?? APPLE_SEARCH_DEFAULT_LIMIT;
  if (term === '' || term.length > 200)
    throw new AsoError('apple_search', 'invalid_input', 'The search term is empty or too long.');
  if (!/^[A-Za-z]{2}$/.test(options.country))
    throw new AsoError(
      'apple_search',
      'invalid_input',
      'The storefront must be a two letter country code.',
    );
  if (!Number.isInteger(limit) || limit < 1 || limit > APPLE_SEARCH_MAX_LIMIT) {
    throw new AsoError(
      'apple_search',
      'invalid_input',
      `The limit must be a whole number from 1 to ${APPLE_SEARCH_MAX_LIMIT}.`,
    );
  }
  const got = await getCapped({
    source: 'apple_search',
    url: appleSearchUrl({
      term,
      country: options.country,
      limit,
      ...(options.lang ? { lang: options.lang } : {}),
      ...(options.macos === true ? { macos: true } : {}),
    }),
    accept: 'application/json',
    maxBytes: MAX_BYTES,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  checkStatus('apple_search', got);
  const apps = parseAppleApps(parseJson(got)).slice(0, limit);
  return { ids: apps.map((a) => a.trackId), apps, total: apps.length, limit };
}

/** The 1-based position of `id` in `ids`, or null when it is not there. */
export function rankIn(ids: readonly string[], id: string): number | null {
  const index = ids.indexOf(id);
  return index === -1 ? null : index + 1;
}

export type AppleLookupOptions = {
  id: string;
  country: string /** The Mac listing of the app (`entity=macSoftware`, UNVERIFIED). */;
  macos?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** The public data of one app in one storefront, or undefined when Apple has no such app there. Throws `AsoError`. */
export async function lookupApple(options: AppleLookupOptions): Promise<AppleApp | undefined> {
  if (!/^[0-9]{1,20}$/.test(options.id))
    throw new AsoError('apple_search', 'invalid_input', 'The App Store id is not a number.');
  if (!/^[A-Za-z]{2}$/.test(options.country))
    throw new AsoError(
      'apple_search',
      'invalid_input',
      'The storefront must be a two letter country code.',
    );
  const got = await getCapped({
    source: 'apple_search',
    url: `${ITUNES_LOOKUP_URL}?id=${options.id}&country=${options.country.toLowerCase()}${options.macos === true ? `&entity=${APPLE_MAC_LOOKUP_ENTITY}` : ''}`,
    accept: 'application/json',
    maxBytes: MAX_BYTES,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  checkStatus('apple_search', got);
  const apps = parseAppleApps(parseJson(got));
  return apps.find((a) => a.trackId === options.id);
}
