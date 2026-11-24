import type { PublicApp } from './net.ts';

/**
 * The result of a competitor search by name (App Store only): a short, sanitised row per app. Pure mapping, no network.
 * Fields are capped, text is plain, the icon is an https address or null, and the state tells the add dialog whether the
 * app is this app itself or is already followed in that storefront.
 */

export const COMPETITOR_SEARCH_LIMIT = 10;
export const COMPETITOR_QUERY_MIN = 2;
export const COMPETITOR_QUERY_MAX = 100;

export type CompetitorSearchState = 'available' | 'followed' | 'own';

export type CompetitorSearchResult = {
  externalId: string;
  name: string;
  developer: string | null;
  category: string | null;
  iconUrl: string | null;
  /** An opaque ref for the icon proxy (`GET .../competitors/search-image`); null without an icon on Apple's image host. */
  iconRef: string | null;
  /** 0 to 5 with two decimals, or null. */
  ratingAverage: number | null;
  ratingCount: number | null;
  /** As the store formats it (`Free`, `$4.99`), or null. */
  price: string | null;
  state: CompetitorSearchState;
};

const clip = (value: string | undefined, max: number): string | null => {
  if (value === undefined) return null;
  // Plain text only: control characters and angle brackets (anything markup-like) are dropped.
  const text = value
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text.slice(0, max);
};

/** An https address of at most 500 characters on Apple's image CDN (`mzstatic.com`), or null. */
export function safeIconUrl(value: string | undefined): string | null {
  if (!value || value.length > 500) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const cdn = host === 'mzstatic.com' || host.endsWith('.mzstatic.com');
    return url.protocol === 'https:' && cdn && url.username === '' && url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function mapSearchResults(
  apps: readonly PublicApp[],
  context: { ownId: string | undefined; followed: ReadonlySet<string> },
): CompetitorSearchResult[] {
  const seen = new Set<string>();
  const out: CompetitorSearchResult[] = [];
  for (const app of apps) {
    if (!/^[0-9]{1,15}$/.test(app.id) || seen.has(app.id)) continue;
    const name = clip(app.name, 120);
    if (name === null) continue;
    seen.add(app.id);
    out.push({
      externalId: app.id,
      name,
      developer: clip(app.developer, 120),
      category: clip(app.category, 60),
      iconUrl: safeIconUrl(app.iconUrl),
      iconRef: null,
      ratingAverage:
        app.ratingMilli !== undefined && app.ratingMilli >= 0 && app.ratingMilli <= 5000
          ? Math.round(app.ratingMilli / 10) / 100
          : null,
      ratingCount:
        app.ratingCount !== undefined && Number.isInteger(app.ratingCount) && app.ratingCount >= 0
          ? app.ratingCount
          : null,
      price: clip(app.price, 20),
      state:
        app.id === context.ownId ? 'own' : context.followed.has(app.id) ? 'followed' : 'available',
    });
    if (out.length >= COMPETITOR_SEARCH_LIMIT) break;
  }
  return out;
}
