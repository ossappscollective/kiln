import {
  type AsoPlatform,
  byFamily,
  type ListingRow,
  type ListingRowTerm,
  normalizeLocale,
  storeShortName,
  type TermSource,
} from '@kiln/core';
import { agoText } from './ago.ts';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { AsoKeywordInput } from './aso.ts';

/**
 * "Keywords in your listing" in the web (docs/api/aso.md): the pure parts. Which terms a locale of the stored listing
 * sets, whether they are wasted or tracked, is worked out in `@kiln/core` (`listingRows`); here the rows are put into
 * words, short marks and the plan that tracks what is not tracked yet. Nothing here reads a store. Written for the ES2017 web build.
 */

/** The tag the keywords added from this view carry. */
export const LISTING_TAG = 'from listing';

export const storeName = (platform: AsoPlatform): string => storeShortName(platform);

/** "Read from the App Store 3 hours ago", or that nothing was read yet. */
export function freshnessText(platform: AsoPlatform, readAt: number | null, now: number): string {
  const store = t(byFamily(platform, { apple: k('aso:lst.storeApple'), google: k('aso:lst.storeGoogle') }));
  return readAt === null
    ? t('aso:lst.notRead', { store })
    : t('aso:lst.read', { store, when: agoText(readAt, now) });
}

/** The one line about Google Play: there is no hidden keyword field (a message key: `t(PLAY_NO_KEYWORD_FIELD)`). */
export const PLAY_NO_KEYWORD_FIELD = k('aso:lst.playNoKeywordField');

/** The field in words: "keyword field", "name" (App Store) or "title" (Google Play). */
export function sourceLabel(platform: AsoPlatform, source: TermSource): string {
  switch (source) {
    case 'keywords':
      return t('aso:lst.source.keywords');
    case 'title':
      return t(byFamily(platform, { apple: k('aso:lst.source.name'), google: k('aso:lst.source.title') }));
    case 'subtitle':
      return t('aso:lst.source.subtitle');
    case 'shortDescription':
      return t('aso:lst.source.shortDescription');
    default:
      return t('aso:lst.source.description');
  }
}

/** A short mark of the field, for a chip: the full word is in the title and for screen readers. */
export const sourceMark = (source: TermSource): string =>
  source === 'keywords'
    ? t('aso:lst.mark.keywords')
    : source === 'title'
      ? t('aso:lst.mark.name')
      : source === 'subtitle'
        ? t('aso:lst.mark.subtitle')
        : source === 'shortDescription'
          ? t('aso:lst.mark.short')
          : t('aso:lst.mark.description');

/** "In the keyword field and the name". */
export function sourcesText(platform: AsoPlatform, sources: readonly TermSource[]): string {
  return formatList(sources.map((s) => sourceLabel(platform, s)));
}

export type TermMarkInfo = { text: string; title: string; tone: 'warn' | 'info' };

/** The waste or repeat mark of a term, or null. The words say it; the tone is only a tint. */
export function termMark(
  term: Pick<ListingRowTerm, 'waste' | 'duplicate' | 'entries'>,
): TermMarkInfo | null {
  if (term.waste === 'in_title_or_subtitle') {
    return {
      text: t('aso:lst.mark.wasted'),
      tone: 'warn',
      title: t('aso:lst.mark.wasted.title'),
    };
  }
  if (term.waste === 'repeated_entry' || term.waste === 'plural_variant') {
    return {
      text: t('aso:lst.mark.repeated'),
      tone: 'warn',
      title: t('aso:lst.mark.repeated.title', { count: term.entries }),
    };
  }
  if (term.duplicate)
    return { text: t('aso:lst.mark.twice'), tone: 'info', title: t('aso:lst.mark.twice.title') };
  return null;
}

/** The rank today of a tracked term as a small number: "12", "50+" (not within the results read), a dash (not checked yet). */
export function rankMark(
  term: Pick<ListingRowTerm, 'tracked' | 'state' | 'rank'>,
  depth = 50,
): { text: string; title: string } | null {
  if (!term.tracked) return null;
  if (term.state === 'ranked' && term.rank !== null)
    return { text: String(term.rank), title: t('aso:lst.rank.ranked', { rank: term.rank }) };
  if (term.state === 'not_ranked')
    return { text: `${depth}+`, title: t('aso:lst.rank.notRanked', { count: depth }) };
  return { text: '–', title: t('aso:lst.rank.notChecked') };
}

/** "42 of 100 bytes, 58 left" or "12 over the limit of 100 bytes". */
export function keywordFieldText(f: {
  bytes: number;
  limit: number;
  remaining: number;
  over: boolean;
}): string {
  return f.over
    ? t('aso:lst.bytesOver', { count: -f.remaining, limit: f.limit })
    : t('aso:meter.left', { bytes: f.bytes, count: f.limit, left: f.remaining });
}

// ---------------------------------------------------------------------------------------------
// Tracking what is not tracked

export type PlanItem = { key: string; term: string; sources: TermSource[] };
export type PlanGroup = {
  id: string;
  appId: string;
  platform: AsoPlatform;
  locale: string;
  country: string;
  items: PlanItem[];
};
export type TrackPlan = { groups: PlanGroup[]; total: number };

/** The one id of a plan group, and the key of a selected item. */
export const planGroupId = (appId: string, locale: string, country: string): string =>
  `${appId}|${locale}|${country}`;
export const planItemId = (group: Pick<PlanGroup, 'id'>, key: string): string =>
  `${group.id}|${key}`;

/**
 * What "track all untracked" would add: per app and locale, the terms that are not tracked in the locale's storefront and
 * that the keywords API accepts. A locale whose code the API does not accept is left out. `scope` limits it to one locale.
 */
export function buildPlan(
  sections: readonly { appId: string; platform: AsoPlatform; rows: readonly ListingRow[] }[],
  scope?: { appId: string; locale: string },
): TrackPlan {
  const groups: PlanGroup[] = [];
  for (const s of sections) {
    for (const row of s.rows) {
      if (scope && (scope.appId !== s.appId || scope.locale !== row.locale)) continue;
      if (!row.trackable || row.untracked.length === 0) continue;
      groups.push({
        id: planGroupId(s.appId, row.locale, row.country),
        appId: s.appId,
        platform: s.platform,
        locale: row.locale,
        country: row.country,
        items: row.untracked.map((t) => ({ key: t.key, term: t.term, sources: t.sources })),
      });
    }
  }
  return { groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
}

/** The items for `POST /aso/keywords`: the chosen terms of one group, in the group's storefront and locale, tagged "from listing". */
export function planKeywordItems(
  group: PlanGroup,
  chosen: (item: PlanItem) => boolean,
): AsoKeywordInput[] {
  const locale = normalizeLocale(group.locale) ?? group.locale;
  return group.items
    .filter(chosen)
    .map((i) => ({ term: i.term, country: group.country, locale, tag: LISTING_TAG }));
}

/** One term of one row, as the "+" on its chip adds it. */
export const termKeywordItem = (
  row: Pick<ListingRow, 'locale' | 'country'>,
  term: Pick<ListingRowTerm, 'term'>,
): AsoKeywordInput => ({
  term: term.term,
  country: row.country,
  locale: normalizeLocale(row.locale) ?? row.locale,
  tag: LISTING_TAG,
});

/** "Room for 12 more of 50" for an app, or '' when the limit is not known. */
export function roomText(limit: number | undefined, tracked: number, adding: number): string {
  if (!limit) return '';
  const room = Math.max(0, limit - tracked);
  return adding > room
    ? t('aso:lst.room.over', { room, limit })
    : t('aso:lst.room.left', { room, limit });
}
