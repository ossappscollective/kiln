import {
  baseLocaleOf,
  type CopyIntent,
  copyTextsOf,
  declaredLocaleOf,
  localeKey,
  type StoreCopyView,
  storeCopyView,
} from '@kiln/core';
import type { Sql } from '@kiln/db';
import { type Drift, getDrift, getLiveListing, type ListingApp, type LiveListing } from './live.ts';

/**
 * THE one server read of the store side of an app's listing (docs/state-model.md, "Single owners (core)", docs/api/listing.md
 * `GET /apps/:id/listing/store`). Before it, seven modules each read `getLiveListing` and picked a channel by hand (Insights: live only;
 * ASO: live with locales else any; the fixes: live then editable; the asset proposal: editable first; pull: live else editable; the Listing
 * grid: `getDrift`'s own pick; the release stepper: editable else the first channel), so five pages listed five sets of locales.
 *
 * Every consumer asks for the copy of ITS INTENT (`COPY_INTENT_CONSUMERS` of `@kiln/core`): `shown` (the union: what a person looks at),
 * `editable` (what a push writes into and a baseline is judged against) or `live` (what is in users' hands). The picking is
 * `storeCopyView`; this file only reads the stored snapshots once and hands the views over.
 *
 * `defaultLocale` is the app's base language: DECLARED by the store when it says (Google Play `defaultLanguage`; the App Store's
 * `primaryLocale`, which the connector reads from the app), else `en-US`, else another English, else the first locale (`source` says which).
 */

export type StoreListingOptions = {
  /** KILN_LISTING_INTERVAL_MINUTES in milliseconds (the schedule of the read). */
  intervalMs?: number;
};

/** The base locale of an app, with how it was decided. `locale` is null only when the store holds no locale at all. */
export type StoreDefaultLocale = {
  locale: string | null;
  /** What the store DECLARES, whether or not it is among the locales (null: it does not say, or the connector could not read it). */
  declared: string | null;
  source: 'declared' | 'english' | 'first' | null;
  /** Why there is no declared locale, when there is none: the store did not say (read it again) or nothing was read. */
  reason: 'declared' | 'not_declared' | 'no_locales';
};

export type StoreListing = {
  live: LiveListing;
  /** The store copy of each intent. */
  copies: Record<CopyIntent, StoreCopyView>;
  /** The locales to show: `copies.shown.codes`. */
  locales: string[];
  defaultLocale: StoreDefaultLocale;
};

export const COPY_INTENTS: readonly CopyIntent[] = ['shown', 'editable', 'live'];

/** The default locale of a listing, decided ONCE from the locales a consumer works with (`codes`). */
export function defaultLocaleOf(live: LiveListing, codes: readonly string[]): StoreDefaultLocale {
  const declared = declaredLocaleOf(live.channels);
  const base = baseLocaleOf(codes, declared);
  return {
    locale: base === null ? null : base.locale,
    declared,
    source: base === null ? null : base.source,
    reason: declared !== null ? 'declared' : base === null ? 'no_locales' : 'not_declared',
  };
}

/** The views and the default locale of a stored listing that was already read (a module that needs the sections too keeps `live`). */
export function storeListingOf(live: LiveListing): StoreListing {
  const copies = {
    shown: storeCopyView(live.channels, { intent: 'shown' }),
    editable: storeCopyView(live.channels, { intent: 'editable' }),
    live: storeCopyView(live.channels, { intent: 'live' }),
  };
  return {
    live,
    copies,
    locales: copies.shown.codes,
    defaultLocale: defaultLocaleOf(live, copies.shown.codes),
  };
}

/** Reads the stored listing and returns it in the one shape. Read-only; no store call. */
export async function getStoreListing(
  sql: Sql,
  workspaceId: string,
  app: ListingApp,
  options: StoreListingOptions = {},
): Promise<StoreListing> {
  const live = await getLiveListing(sql, workspaceId, app, {
    intervalMs: options.intervalMs ?? 0,
  });
  return storeListingOf(live);
}

/** The `locale -> field -> text` record of one intent: what a planner or a check takes as "the store's texts". */
export const storeTextsOf = (view: StoreCopyView): Record<string, Record<string, string>> =>
  copyTextsOf(view);

/**
 * The section data (media, details, ...) of the copy a locale was read from. A locale only the draft has takes the DRAFT's sections: the
 * screenshots it shows are the draft's.
 */
export function sectionsOfLocale(live: LiveListing, view: StoreCopyView, locale: string) {
  const key = localeKey(locale);
  const copy = view.locales.find((l) => localeKey(l.locale) === key) ?? null;
  const channel = copy === null ? undefined : live.channels.find((c) => c.channel === copy.from);
  return channel?.sections;
}

// ---------------------------------------------------------------------------------------------
// The answer of `GET /apps/:id/listing/store`

export type StoreListingAnswer = {
  appId: string;
  platform: ListingApp['platform'];
  readAt: number | null;
  error: string | null;
  warnings: string[];
  schedule: LiveListing['schedule'];
  /** The raw channels (texts and sections as last read): for the sections and the raw "live" column. */
  channels: LiveListing['channels'];
  /** The locales to show (`copies.shown.codes`). */
  locales: string[];
  /**
   * The copy of each intent. `fields` is empty unless asked for (`?fields=release_notes,keywords` or `?fields=all`): the locale lists
   * (with `from` and `held`) are what most readers need, and the texts are in `channels` and `drift`.
   */
  copies: Record<CopyIntent, StoreCopyView>;
  defaultLocale: StoreDefaultLocale;
  /** The three-way view per locale and field with the repository, or null when not asked for (`?drift=0`). */
  drift: Drift | null;
};

/** Keeps in each locale of a view only the fields named (`all`: every field; none: no text). */
export function withFields(view: StoreCopyView, fields: 'all' | readonly string[]): StoreCopyView {
  if (fields === 'all') return view;
  const keep = new Set(fields);
  return {
    ...view,
    locales: view.locales.map((l) => ({
      ...l,
      fields: Object.fromEntries(Object.entries(l.fields).filter(([f]) => keep.has(f))),
    })),
  };
}

export async function getStoreListingAnswer(
  sql: Sql,
  workspaceId: string,
  app: ListingApp,
  options: StoreListingOptions & {
    fields: 'all' | readonly string[];
    drift?: { compareRepo: boolean; compareMedia: boolean } | null;
  },
): Promise<StoreListingAnswer> {
  const view = await getStoreListing(sql, workspaceId, app, options);
  const drift =
    options.drift === undefined || options.drift === null
      ? null
      : await getDrift(sql, workspaceId, app, options.drift);
  return {
    appId: app.id,
    platform: app.platform,
    readAt: view.live.readAt,
    error: view.live.error,
    warnings: view.live.warnings,
    schedule: view.live.schedule,
    channels: view.live.channels,
    locales: view.locales,
    copies: {
      shown: withFields(view.copies.shown, options.fields),
      editable: withFields(view.copies.editable, options.fields),
      live: withFields(view.copies.live, options.fields),
    },
    defaultLocale: view.defaultLocale,
    drift,
  };
}
