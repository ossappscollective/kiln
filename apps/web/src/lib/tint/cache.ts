/**
 * The palette of an app icon, remembered per app and icon (docs/adr/0068-app-tint.md): localStorage, so the tint is applied from
 * the cache before the first paint and the icon is not decoded again. The entry names the icon URL it was made from; when the
 * icon changes (the server adds a version to the URL) the entry no longer matches and the palette is extracted again.
 * Every access is in try/catch: a private window or a full disk just means no cache.
 */
import type { Palette } from './palette.ts';

export const CACHE_PREFIX = 'kiln.tint.v1.';

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

export type CacheEntry = { url: string; palette: Palette };

const HEX = /^#[0-9a-f]{6}$/;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export const cacheKey = (appId: string): string => `${CACHE_PREFIX}${appId}`;

/** A stored entry that is well formed, or null. Anything else (an old shape, edited by hand) is ignored. */
export function parseEntry(raw: unknown): CacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { url?: unknown; colors?: unknown; neutral?: unknown };
  if (typeof r.url !== 'string' || typeof r.neutral !== 'boolean' || !Array.isArray(r.colors))
    return null;
  const colors = r.colors
    .filter((c): c is string => typeof c === 'string' && HEX.test(c))
    .slice(0, 3);
  if (colors.length !== r.colors.length) return null;
  if (r.neutral !== (colors.length === 0)) return null;
  return { url: r.url, palette: { colors, neutral: r.neutral } };
}

export function readEntry(
  appId: string,
  storage: Reader | undefined = defaultStorage(),
): CacheEntry | null {
  try {
    const raw = storage?.getItem(cacheKey(appId));
    return raw ? parseEntry(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeEntry(
  appId: string,
  entry: CacheEntry,
  storage: Writer | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(
      cacheKey(appId),
      JSON.stringify({
        url: entry.url,
        colors: entry.palette.colors,
        neutral: entry.palette.neutral,
      }),
    );
  } catch {
    // Not cached.
  }
}
