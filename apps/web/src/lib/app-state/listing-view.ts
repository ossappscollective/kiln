import type { StoreCopyViewJson, StoreDefaultLocale, StoreListingView } from '../types.ts';

/**
 * The selectors over the ONE store read of the listing (`StoreListingView`, `GET /apps/:id/listing/store`; docs/state-model.md, "Single
 * owners (core)"). A page asks the view for the copy of ITS intent and never picks a channel itself:
 *  - `shown`    the Listing page, the checks, ASO: every locale of both copies;
 *  - `editable` the draft a push writes into: the release stepper's notes locales, the fix bar, the staged baseline;
 *  - `live`     only what users see.
 * Plain TypeScript (no runes), so it is tested on its own.
 */

export type CopyIntentName = 'shown' | 'editable' | 'live';

/** The copy of an intent, or null while the listing is not read. */
export const copyOf = (
  view: StoreListingView | null,
  intent: CopyIntentName,
): StoreCopyViewJson | null => (view === null ? null : view.copies[intent]);

/** The locale codes of an intent (sorted, the `default` fallback is never in it); empty while not read. */
export const localesOf = (
  view: StoreListingView | null,
  intent: CopyIntentName = 'shown',
): string[] => copyOf(view, intent)?.codes ?? [];

/** The locales a release's notes are written for: the draft's (the live copy when the store has no draft). */
export const noteLocalesOf = (view: StoreListingView | null): string[] =>
  localesOf(view, 'editable');

/** The base language and how it was decided; null while the listing is not read. */
export const defaultLocaleOf = (view: StoreListingView | null): StoreDefaultLocale | null =>
  view === null ? null : view.defaultLocale;

/** The base language to show, or null (the store holds no locale, or the listing is not read). */
export const baseLocaleOf = (view: StoreListingView | null): string | null =>
  view?.defaultLocale.locale ?? null;

/** Where a locale of the `shown` copy was read from and which copies hold it ("only in the draft"), or null. */
export function heldOf(
  view: StoreListingView | null,
  locale: string,
): { from: 'live' | 'editable'; held: ('live' | 'editable')[] } | null {
  const hit = copyOf(view, 'shown')?.locales.find((l) => l.locale === locale);
  return hit === undefined ? null : { from: hit.from, held: hit.held };
}

/** The locales only the draft holds: not live yet. */
export const draftOnlyLocales = (view: StoreListingView | null): string[] =>
  (copyOf(view, 'shown')?.locales ?? [])
    .filter((l) => l.held.indexOf('live') < 0)
    .map((l) => l.locale);
