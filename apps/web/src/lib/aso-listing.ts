import { type AsoPlatform, isApplePlatform, type ListingRow, type ListingRowTerm, normalizeLocale, storeShortName, type TermSource } from '@mrm/core';
import type { AsoKeywordInput } from './aso.ts';
import { timeAgo } from './format.ts';

/**
 * "Keywords in your listing" in the web (docs/api/aso.md): the pure parts. Which terms a locale of the stored listing
 * sets, whether they are wasted or tracked, is worked out in `@mrm/core` (`listingRows`); here the rows are put into
 * words, short marks and the plan that tracks what is not tracked yet. Nothing here reads a store. Written for the ES2017 web build.
 */

/** The tag the keywords added from this view carry. */
export const LISTING_TAG = 'from listing';

export const storeName = (platform: AsoPlatform): string =>
  storeShortName(platform);

/** "Read from the App Store 3 hours ago", or that nothing was read yet. */
export function freshnessText(platform: AsoPlatform, readAt: number | null, now: number): string {
  const store = isApplePlatform(platform) ? 'the App Store' : 'Google Play';
  return readAt === null
    ? `Not read from ${store} yet`
    : `Read from ${store} ${timeAgo(readAt, now)}`;
}

/** The one line about Google Play: there is no hidden keyword field. */
export const PLAY_NO_KEYWORD_FIELD =
  'Google Play has no hidden keyword field. These terms are extracted from the text of the listing; Play does not keep them as keywords.';

/** The field in words: "keyword field", "name" (App Store) or "title" (Google Play). */
export function sourceLabel(platform: AsoPlatform, source: TermSource): string {
  switch (source) {
    case 'keywords':
      return 'keyword field';
    case 'title':
      return isApplePlatform(platform) ? 'name' : 'title';
    case 'subtitle':
      return 'subtitle';
    case 'shortDescription':
      return 'short description';
    default:
      return 'description';
  }
}

/** A short mark of the field, for a chip: the full word is in the title and for screen readers. */
export const sourceMark = (source: TermSource): string =>
  source === 'keywords'
    ? 'kw'
    : source === 'title'
      ? 'name'
      : source === 'subtitle'
        ? 'sub'
        : source === 'shortDescription'
          ? 'short'
          : 'desc';

/** "In the keyword field and the name". */
export function sourcesText(platform: AsoPlatform, sources: readonly TermSource[]): string {
  const names = sources.map((s) => sourceLabel(platform, s));
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type TermMarkInfo = { text: string; title: string; tone: 'warn' | 'info' };

/** The waste or repeat mark of a term, or null. The words say it; the tone is only a tint. */
export function termMark(
  t: Pick<ListingRowTerm, 'waste' | 'duplicate' | 'entries'>,
): TermMarkInfo | null {
  if (t.waste === 'in_title_or_subtitle') {
    return {
      text: 'wasted',
      tone: 'warn',
      title:
        'Already in the name or subtitle, which the store searches anyway (unverified), so the keyword field spends room on it.',
    };
  }
  if (t.waste === 'repeated_entry' || t.waste === 'plural_variant') {
    return {
      text: 'repeated',
      tone: 'warn',
      title: `${t.entries} entries of the keyword field have these words (a repeat or a plural), so room is spent twice.`,
    };
  }
  if (t.duplicate)
    return { text: 'twice', tone: 'info', title: 'The word is in more than one searched field.' };
  return null;
}

/** The rank today of a tracked term as a small number: "12", "50+" (not within the results read), a dash (not checked yet). */
export function rankMark(
  t: Pick<ListingRowTerm, 'tracked' | 'state' | 'rank'>,
  depth = 50,
): { text: string; title: string } | null {
  if (!t.tracked) return null;
  if (t.state === 'ranked' && t.rank !== null)
    return { text: String(t.rank), title: `Tracked, rank ${t.rank} today` };
  if (t.state === 'not_ranked')
    return { text: `${depth}+`, title: `Tracked, not within the first ${depth} results` };
  return { text: '–', title: 'Tracked, not checked yet' };
}

/** "42 of 100 bytes, 58 left" or "12 over the limit of 100 bytes". */
export function keywordFieldText(f: {
  bytes: number;
  limit: number;
  remaining: number;
  over: boolean;
}): string {
  return f.over
    ? `${-f.remaining} bytes over the limit of ${f.limit}`
    : `${f.bytes} of ${f.limit} bytes, ${f.remaining} left`;
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
    ? `Only ${room} more fit in the limit of ${limit} keywords an app tracks, so the rest will not be added.`
    : `Room for ${room} more of ${limit}.`;
}
