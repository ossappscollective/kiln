import {
  APPLE_SEARCH_MAX_LIMIT,
  type AppleApp,
  AsoError,
  lookupApple,
  PLAY_MAX_SEARCH_LIMIT,
  type PlayApp,
  PlayPublicConnector,
  searchApple,
} from '@kiln/connectors';
import { type AsoPlatform, byFamily, isDesktop, listingStoreOf } from '@kiln/core';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { type Exchange, safeGet } from '../../services/safe-fetch.ts';
import { timedCache } from '../../services/timed-cache.ts';
import type { Resolver } from '../../services/webhook-transport.ts';

/**
 * The outbound side of ASO: the only two hosts the server ever contacts for it, how, and how often.
 *
 * - `createAsoFetch`: a `fetch` for the connectors that goes through the SSRF-safe GET of safe-fetch.ts:
 *   https only, the host must be `itunes.apple.com` or `play.google.com` (checked for the first URL and for
 *   every redirect), the resolved addresses must be public, the body is capped, the whole thing has a timeout, and
 *   the User-Agent is the one the connector sets. No cookie and no credential is ever added.
 * - `createAsoSources`: what the services call. It turns the two connectors into one shape, and puts three
 *   things in front of them: a cache (the same term in the same storefront is looked up once per
 *   `cacheMs`, and the same lookup in flight is shared), a conservative per process rate limit per source
 *   (Apple documents "approximately 20 calls per minute"; the default here is below that, and Google Play, which
 *   documents nothing, gets fewer), and a cool-down after a store said to slow down.
 *
 * A call that the local limit or the cool-down stops makes no request and throws a `rate_limited` `AsoError`
 * WITHOUT a `status` (a store's own 429 has one): the refresh treats the first as "later" and the second as a failure.
 * Nothing here logs. Search terms live only in the cache keys, in memory.
 */

export const ASO_HOSTS: ReadonlySet<string> = new Set(['itunes.apple.com', 'play.google.com']);
/** The largest body the fetch accepts (the connectors cap at 4 MiB and 3 MiB). */
export const ASO_FETCH_MAX_BYTES = 4 * 1024 * 1024;

export type AsoNet = {
  resolve?: Resolver;
  exchange?: Exchange;
  allowPrivate?: boolean;
  timeoutMs?: number;
};

export function createAsoFetch(net: AsoNet = {}): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const userAgent = headers.get('user-agent');
    const result = await safeGet(url, {
      allowHost: (host) => ASO_HOSTS.has(host),
      maxBytes: ASO_FETCH_MAX_BYTES,
      accept: headers.get('accept') ?? '*/*',
      ...(userAgent ? { userAgent } : {}),
      ...(net.allowPrivate ? { allowPrivate: true } : {}),
      ...(net.resolve ? { resolve: net.resolve } : {}),
      ...(net.exchange ? { exchange: net.exchange } : {}),
      ...(net.timeoutMs ? { timeoutMs: net.timeoutMs } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (result.ok) {
      return new Response(result.body, {
        status: 200,
        headers: result.contentType ? { 'content-type': result.contentType } : {},
      });
    }
    switch (result.kind) {
      case 'status':
        return new Response(null, {
          status:
            result.status && result.status >= 200 && result.status <= 599 ? result.status : 502,
          ...(result.retryAfter ? { headers: { 'retry-after': result.retryAfter } } : {}),
        });
      case 'redirect':
        return new Response(null, { status: 302 });
      case 'too_large':
        throw Object.assign(new Error('too large'), { name: 'TooLargeError' });
      case 'timeout':
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      default:
        throw new TypeError('network');
    }
  };
}

// ---------------------------------------------------------------------------------------------

export type PublicApp = {
  id: string;
  name: string;
  version?: string;
  price?: string;
  currency?: string;
  ratingMilli?: number;
  ratingCount?: number;
  description?: string;
  iconUrl?: string;
  /** Null (absent) when the source does not say. */
  screenshotCount?: number;
  /** The addresses of the screenshots, when the source gives them (hashed by the caller, never stored). */
  screenshotUrls?: string[];
};

export type SearchHit = { id: string; name?: string };
export type SearchOutcome = { hits: SearchHit[]; total: number; cached: boolean };

export type SearchInput = {
  platform: AsoPlatform;
  term: string;
  country: string;
  locale: string;
  limit: number;
};
export type LookupInput = { platform: AsoPlatform; id: string; country: string; locale: string };

export type AsoSources = {
  /** The unofficial Google Play source is switched on (MRM_ASO_PLAY_UNOFFICIAL_ENABLED). */
  playEnabled: boolean;
  search(input: SearchInput): Promise<SearchOutcome>;
  lookup(input: LookupInput): Promise<PublicApp | undefined>;
};

export type AsoSourceOptions = {
  playEnabled: boolean;
  now: () => number;
  /** How long a search or lookup is reused. 0: never. */
  cacheMs: number;
  /** Calls per minute per source for this process. */
  appleCallsPerMinute: number;
  playCallsPerMinute: number;
  /** Replaces the network (tests). Default: `createAsoFetch(net)`. */
  fetch?: typeof fetch;
  net?: AsoNet;
};

const fromApple = (a: AppleApp): PublicApp => ({
  id: a.trackId,
  name: a.name,
  ...(a.version ? { version: a.version } : {}),
  ...(a.price ? { price: a.price } : {}),
  ...(a.currency ? { currency: a.currency } : {}),
  ...(a.ratingMilli !== undefined ? { ratingMilli: a.ratingMilli } : {}),
  ...(a.ratingCount !== undefined ? { ratingCount: a.ratingCount } : {}),
  ...(a.description ? { description: a.description } : {}),
  ...(a.iconUrl ? { iconUrl: a.iconUrl } : {}),
  screenshotCount: a.screenshotUrls.length,
  screenshotUrls: a.screenshotUrls,
});

const fromPlay = (a: PlayApp): PublicApp => ({
  id: a.packageName,
  name: a.name,
  ...(a.version ? { version: a.version } : {}),
  ...(a.price ? { price: a.price === '0' ? 'Free' : a.price } : {}),
  ...(a.currency ? { currency: a.currency } : {}),
  ...(a.ratingMilli !== undefined ? { ratingMilli: a.ratingMilli } : {}),
  ...(a.ratingCount !== undefined ? { ratingCount: a.ratingCount } : {}),
  ...(a.description ? { description: a.description } : {}),
  ...(a.iconUrl ? { iconUrl: a.iconUrl } : {}),
  ...(a.screenshotCount !== undefined ? { screenshotCount: a.screenshotCount } : {}),
});

export function createAsoSources(options: AsoSourceOptions): AsoSources {
  const doFetch = options.fetch ?? createAsoFetch(options.net);
  const play = new PlayPublicConnector({ enabled: options.playEnabled, fetch: doFetch });
  const limiters: Record<'apple' | 'play', TestLimiter> = {
    apple: createTestLimiter({ limit: options.appleCallsPerMinute, now: options.now }),
    play: createTestLimiter({ limit: options.playCallsPerMinute, now: options.now }),
  };
  const cooldown: Record<'apple' | 'play', number> = { apple: 0, play: 0 };
  const searches = timedCache<SearchOutcome>(options.cacheMs, 500);
  const lookups = timedCache<PublicApp | null>(options.cacheMs, 500);
  const inflight = new Map<string, Promise<unknown>>();

  /** One outbound call: the cool-down and the local limit first, the cool-down set when the store itself says to slow down. */
  async function outbound<T>(source: 'apple' | 'play', call: () => Promise<T>): Promise<T> {
    const now = options.now();
    if (now < cooldown[source]) {
      throw new AsoError(
        source === 'apple' ? 'apple_search' : 'play_public',
        'rate_limited',
        'Paused after the store asked to slow down.',
        {
          retryAfterSeconds: Math.max(1, Math.ceil((cooldown[source] - now) / 1000)),
        },
      );
    }
    const wait = limiters[source].take('process');
    if (wait > 0) {
      throw new AsoError(
        source === 'apple' ? 'apple_search' : 'play_public',
        'rate_limited',
        'The local rate limit for this source is used up.',
        {
          retryAfterSeconds: wait,
        },
      );
    }
    try {
      return await call();
    } catch (error) {
      if (error instanceof AsoError && error.kind === 'rate_limited') {
        cooldown[source] = options.now() + (error.retryAfterSeconds ?? 60) * 1000;
      }
      throw error;
    }
  }

  /** The cache, and one call in flight per key. Failures are not cached. */
  async function shared<T>(
    key: string,
    cache: ReturnType<typeof timedCache<T>>,
    load: () => Promise<T>,
  ): Promise<{ value: T; cached: boolean }> {
    const hit = options.cacheMs > 0 ? cache.get(key, options.now()) : undefined;
    if (hit !== undefined) return { value: hit, cached: true };
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return { value: await running, cached: true };
    const promise = load().then((value) => {
      if (options.cacheMs > 0) cache.set(key, value, options.now());
      return value;
    });
    inflight.set(key, promise);
    try {
      return { value: await promise, cached: false };
    } finally {
      inflight.delete(key);
    }
  }

  return {
    playEnabled: options.playEnabled,
    async search(input) {
      const limit = Math.min(
        input.limit,
        byFamily(input.platform, { apple: APPLE_SEARCH_MAX_LIMIT, google: PLAY_MAX_SEARCH_LIMIT }),
      );
      const key = `s|${input.platform}|${input.country}|${byFamily(input.platform, { apple: '', google: input.locale })}|${input.term.toLowerCase()}|${limit}`;
      const { value, cached } = await shared(key, searches, async () => {
        if (listingStoreOf(input.platform) === 'app_store') {
          const r = await outbound('apple', () =>
            searchApple({
              term: input.term,
              country: input.country,
              limit,
              ...(isDesktop(input.platform) ? { macos: true } : {}),
              fetch: doFetch,
            }),
          );
          return {
            hits: r.apps.map((a) => ({ id: a.trackId, name: a.name })),
            total: r.total,
            cached: false,
          };
        }
        if (!options.playEnabled) {
          throw new AsoError(
            'play_public',
            'unavailable',
            'Reading Google Play pages is switched off (MRM_ASO_PLAY_UNOFFICIAL_ENABLED).',
            { reason: 'disabled' },
          );
        }
        const r = await outbound('play', () =>
          play.search({ term: input.term, country: input.country, language: input.locale, limit }),
        );
        return { hits: r.ids.map((id) => ({ id })), total: r.total, cached: false };
      });
      return { ...value, cached };
    },
    async lookup(input) {
      const key = `l|${input.platform}|${input.country}|${byFamily(input.platform, { apple: '', google: input.locale })}|${input.id}`;
      const { value } = await shared(key, lookups, async () => {
        if (listingStoreOf(input.platform) === 'app_store') {
          const app = await outbound('apple', () =>
            lookupApple({
              id: input.id,
              country: input.country,
              ...(isDesktop(input.platform) ? { macos: true } : {}),
              fetch: doFetch,
            }),
          );
          return app ? fromApple(app) : null;
        }
        if (!options.playEnabled) {
          throw new AsoError(
            'play_public',
            'unavailable',
            'Reading Google Play pages is switched off (MRM_ASO_PLAY_UNOFFICIAL_ENABLED).',
            { reason: 'disabled' },
          );
        }
        const app = await outbound('play', () =>
          play.getApp({ packageName: input.id, country: input.country, language: input.locale }),
        );
        return app ? fromPlay(app) : null;
      });
      return value ?? undefined;
    },
  };
}
