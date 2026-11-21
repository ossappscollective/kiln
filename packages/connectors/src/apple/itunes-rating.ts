import { StoreError, StoreRateLimitError } from '../errors.ts';
import { isRecord, num, parseRetryAfter, records } from '../store-http.ts';

/**
 * The public iTunes Lookup API as an optional, store-wide rating summary for an App Store app:
 * no credential, one GET to a fixed host.
 *
 * - `GET https://itunes.apple.com/lookup?id=<numeric app id>&country=<two letters>`
 *   Apple's guide: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html
 *   documents lookup by `id`. The Search API guide
 *   (https://performance-partners.apple.com/search-api) says the API is "limited to approximately
 *   20 calls per minute (subject to change)" and that large sites should cache.
 *
 * UNVERIFIED (Apple's pages fetched on 2026-11-18 do not document them; they are what the service
 * is widely observed to send): the `country` parameter on a lookup, and the software result fields
 * `averageUserRating`, `userRatingCount`, `averageUserRatingForCurrentVersion`,
 * `userRatingCountForCurrentVersion` and `trackViewUrl`. The parser accepts their absence, so a
 * change on Apple's side gives "no summary" and not an error.
 *
 * Safety: the host and the path are constants, the id is digits only and the country two letters,
 * so no value from outside can change where the request goes. Redirects are refused (`redirect:
 * 'error'`), https only, the reply is cut at `maxBytes` and the request at `timeoutMs`. The reply
 * is data: only numbers are taken from it.
 */

export const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export type RatingSummary = {
  appStoreId: string;
  /** Two letter storefront, upper case. */
  country: string;
  /** `macos` when the rating is the Mac App Store listing's (`entity=macSoftware`). Absent: the iOS listing. */
  platform?: 'macos';
  /** Average of all ratings, 0 to 5. */
  averageRating?: number;
  ratingCount?: number;
  /** Average of the ratings of the current version, when Apple sent it. */
  currentVersionAverage?: number;
  currentVersionCount?: number;
};

export type FetchRatingSummaryOptions = {
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** A two letter storefront code, such as `us`. */
  country: string;
  /**
   * `macos`: look up the Mac App Store listing of the app (`&entity=macSoftware`). UNVERIFIED: Apple's pages document
   * the lookup by `id` only, and its search page lists `desktopSoftware` as the Mac software entity. A lookup that
   * answers with nothing is "no summary", never an error.
   */
  platform?: 'ios' | 'macos';
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

const average = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isFinite(n) && n >= 0 && n <= 5
    ? Math.round(n * 1000) / 1000
    : undefined;
};
const count = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 1e10 ? n : undefined;
};

/** The rating fields of a lookup reply, or undefined when the reply has no result or no rating at all. */
export function parseRatingSummary(
  json: unknown,
  appStoreId: string,
  country: string,
  platform: 'ios' | 'macos' = 'ios',
): RatingSummary | undefined {
  const results = isRecord(json) ? records(json.results) : [];
  // Only the entry for this app: a lookup by id answers with that id, nothing else is trusted. For macOS, the
  // entry that says it is Mac software is the one (a universal purchase app has the same id on both stores).
  const mine = results.filter((r) => String(r.trackId ?? '') === appStoreId);
  const entry =
    (platform === 'macos' ? (mine.find((r) => r.kind === 'mac-software') ?? mine[0]) : mine[0]) ??
    (platform === 'macos' ? undefined : results[0]);
  if (!entry) return undefined;
  const averageRating = average(entry.averageUserRating);
  const ratingCount = count(entry.userRatingCount);
  const currentVersionAverage = average(entry.averageUserRatingForCurrentVersion);
  const currentVersionCount = count(entry.userRatingCountForCurrentVersion);
  if (averageRating === undefined && ratingCount === undefined) return undefined;
  return {
    appStoreId,
    country: country.toUpperCase(),
    ...(platform === 'macos' ? { platform } : {}),
    ...(averageRating !== undefined ? { averageRating } : {}),
    ...(ratingCount !== undefined ? { ratingCount } : {}),
    ...(currentVersionAverage !== undefined ? { currentVersionAverage } : {}),
    ...(currentVersionCount !== undefined ? { currentVersionCount } : {}),
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'The iTunes lookup answered with more data than expected.',
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the store-wide rating of an app in one storefront. Returns undefined when Apple has no
 * result or sent no rating (a new app has none yet). Throws a `StoreError` when the call fails.
 */
export async function fetchRatingSummary(
  options: FetchRatingSummaryOptions,
): Promise<RatingSummary | undefined> {
  if (!/^[0-9]{1,20}$/.test(options.appStoreId)) {
    throw new StoreError(
      'appstoreconnect',
      'invalid_input',
      'The App Store id of the app is missing or not a number.',
    );
  }
  if (!/^[A-Za-z]{2}$/.test(options.country)) {
    throw new StoreError(
      'appstoreconnect',
      'invalid_input',
      'The storefront must be a two letter country code.',
    );
  }
  const macos = options.platform === 'macos';
  const url = `${ITUNES_LOOKUP_URL}?id=${options.appStoreId}&country=${options.country.toLowerCase()}${macos ? '&entity=macSoftware' : ''}`;
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'kiln' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new StoreError(
      'appstoreconnect',
      'network',
      name === 'TimeoutError' || name === 'AbortError'
        ? 'The iTunes lookup timed out.'
        : 'Could not reach itunes.apple.com. Check the network connection of the server.',
    );
  }
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new StoreRateLimitError(
      'appstoreconnect',
      parseRetryAfter(response.headers.get('retry-after'), Date.now()) ?? 60,
      response.status,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new StoreError(
      'appstoreconnect',
      response.status >= 500 ? 'server' : 'unexpected',
      `The iTunes lookup answered with HTTP ${response.status}.`,
      response.status,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await readCapped(response, options.maxBytes ?? DEFAULT_MAX_BYTES));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(
      'appstoreconnect',
      'unexpected',
      'The iTunes lookup answered with a response that could not be read.',
    );
  }
  return parseRatingSummary(json, options.appStoreId, options.country, options.platform ?? 'ios');
}
