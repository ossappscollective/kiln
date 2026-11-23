import { parseStoreRef, type StoreRef } from '@kiln/core';

/**
 * The add-competitor field: what a typed or pasted text means. Pure (no network, no strings): the component turns the result into
 * a search (App Store only), a direct add, or a short message. Google Play has no search: Kiln does not scrape it.
 */

export type StoreKind = 'app_store' | 'google_play';

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 300;

export type FieldMeaning =
  | { kind: 'empty' }
  /** A link or id of the store of the chosen app: resolve it directly, no search. */
  | { kind: 'ref'; ref: StoreRef }
  /** A link of the other store than the chosen app's. */
  | { kind: 'wrongStore'; ref: StoreRef }
  /** Google Play field text that is not a package name or a Play link. */
  | { kind: 'badPackage' }
  /** An App Store name that is still too short to search. */
  | { kind: 'short' }
  | { kind: 'search'; term: string };

export function readField(raw: string, store: StoreKind): FieldMeaning {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return { kind: 'empty' };
  const ref = parseStoreRef(text, store);
  if (ref) return ref.store === store ? { kind: 'ref', ref } : { kind: 'wrongStore', ref };
  if (store === 'google_play') return { kind: 'badPackage' };
  return text.length < SEARCH_MIN_CHARS ? { kind: 'short' } : { kind: 'search', term: text };
}

/** The storefront that appears most often (a tie keeps the first seen), `us` when there is none: the picker's starting value. */
export function primaryCountry(countries: readonly string[]): string {
  const counts: Record<string, number> = {};
  let best = '';
  for (const raw of countries) {
    const c = raw.toLowerCase();
    if (!/^[a-z]{2}$/.test(c)) continue;
    counts[c] = (counts[c] ?? 0) + 1;
    if (best === '' || (counts[c] as number) > (counts[best] as number)) best = c;
  }
  return best === '' ? 'us' : best;
}

export type SearchState = 'available' | 'followed' | 'own';

/** The index to highlight after an arrow key: wraps around, nothing highlighted yet (-1) starts at the first or the last. */
export function moveActive(current: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}
