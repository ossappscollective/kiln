import {
  type AsoPlatform,
  byFamily,
  type CoachLink,
  type FieldBudget,
  type FitField,
  type FitFields,
  type FitKeyword,
  type ListingBudget,
  localeKey,
  type StagedChangesView,
  supports,
  type WasteReason,
} from '@kiln/core';
import { withHeaderParams, withPanel } from '../app-header.ts';
import { appAddress, type PlatformScope, parseViewPath } from '../app-scope.ts';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { DriftField } from '../types.ts';
import { type AsoKeyword, asoViewHref, fitFieldLabels } from './aso.ts';

/**
 * The budget meters and the coach in the web (docs/api/aso.md): the pure parts. What counts and what is
 * wasted is worked out in `@kiln/core` (`listingBudget`, `buildCoach`); here the listing text of a locale is
 * put together from what the screens hold (the store copy, with the staged text on top) and the results
 * are turned into the words and addresses the screens show. Written for the ES2017 web build.
 */

// ---------------------------------------------------------------------------------------------
// The text of a locale

const APPLE_FIELDS: Record<string, FitField> = {
  name: 'title',
  subtitle: 'subtitle',
  keywords: 'keywords',
  description: 'description',
};
const PLAY_FIELDS: Record<string, FitField> = {
  title: 'title',
  short_description: 'shortDescription',
  full_description: 'description',
};

/** The fit field a store field id is, or null for a field the budgets do not look at. */
export function fitFieldOf(platform: AsoPlatform, fieldId: string): FitField | null {
  const map = byFamily(platform, { apple: APPLE_FIELDS, google: PLAY_FIELDS });
  return map[fieldId] ?? null;
}

export type LocaleText = {
  fields: FitFields;
  /** The fields whose text is a staged one (not pushed yet). */
  staged: FitField[];
};

/** The staged text of a locale laid over a base. A staged text is what the store will have after the next push. */
export function overlayStaged(
  platform: AsoPlatform,
  locale: string,
  base: FitFields,
  view: StagedChangesView | null,
): LocaleText {
  const fields: FitFields = { ...base };
  const staged: FitField[] = [];
  if (view !== null) {
    for (const t of view.text) {
      if (t.locale !== locale) continue;
      const f = fitFieldOf(platform, t.field);
      if (f === null) continue;
      fields[f] = t.value;
      if (staged.indexOf(f) < 0) staged.push(f);
    }
  }
  return { fields, staged };
}

/**
 * The text of one locale as the listing grid has it: what the store has (the live copy, else the last
 * synced one), with the staged text on top. Fields the budgets do not look at are left out.
 */
export function fieldsFromDrift(
  platform: AsoPlatform,
  locale: string,
  drift: readonly Pick<DriftField, 'locale' | 'field' | 'live' | 'db'>[],
  view: StagedChangesView | null,
): LocaleText {
  const base: FitFields = {};
  for (const d of drift) {
    const f = fitFieldOf(platform, d.field);
    if (f === null) continue;
    const value = d.live.value ?? d.db.value;
    if (value !== null) base[f] = value;
  }
  // A staged text of a field the drift view has no row for is found by `overlayStaged` too.
  return overlayStaged(platform, locale, base, view);
}

/** The tracked keywords of exactly this locale, for the budget. Another locale of the same language is not guessed. */
export function keywordsForLocale(
  keywords: readonly Pick<AsoKeyword, 'id' | 'term' | 'priority' | 'locale'>[],
  locale: string,
): FitKeyword[] {
  return keywords
    .filter((k) => localeKey(k.locale) === localeKey(locale))
    .map((k) => ({ id: k.id, term: k.term, priority: k.priority }));
}

/** The storefronts (two letters) where keywords are tracked in this locale, sorted. */
export function countriesForLocale(
  keywords: readonly Pick<AsoKeyword, 'country' | 'locale'>[],
  locale: string,
): string[] {
  const out: string[] = [];
  for (const k of keywords)
    if (localeKey(k.locale) === localeKey(locale) && out.indexOf(k.country) < 0) out.push(k.country);
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// Words for the meters

export type MeterTone = 'ok' | 'warn' | 'bad';

/** Thin bar tone: over the limit is bad, within a tenth of it is a warning. Room left is not a problem by itself. */
export function meterTone(f: Pick<FieldBudget, 'used' | 'limit' | 'over'>): MeterTone {
  if (f.over) return 'bad';
  return f.limit > 0 && f.used >= f.limit * 0.9 ? 'warn' : 'ok';
}

/** "18/30". */
export const meterNumber = (f: Pick<FieldBudget, 'used' | 'limit'>): string =>
  `${f.used}/${f.limit}`;

/** "18 of 30 characters, 12 left" or "3 over the limit of 30 characters". */
export function meterTitle(
  f: Pick<FieldBudget, 'used' | 'limit' | 'unit' | 'remaining' | 'over'>,
): string {
  const unit = f.unit === 'bytes' ? t('aso:bud.unit.bytes') : t('aso:bud.unit.characters');
  return f.over
    ? t('aso:bud.title.over', { over: -f.remaining, limit: f.limit, unit })
    : t('aso:bud.title.left', { used: f.used, limit: f.limit, unit, left: f.remaining });
}

/** Message keys: `t(wasteReasonText[reason])`. */
export const wasteReasonText: Record<WasteReason, string> = {
  space: k('aso:bud.waste.space'),
  empty_entry: k('aso:bud.waste.emptyEntry'),
  repeated_entry: k('aso:bud.waste.repeatedEntry'),
  plural_variant: k('aso:bud.waste.pluralVariant'),
  in_title_or_subtitle: k('aso:bud.waste.inTitleOrSubtitle'),
};

/** The label of a budget field: the Google Play title and full description have their own words. */
export function budgetFieldLabel(platform: AsoPlatform, field: FitField): string {
  const apple = supports(platform, 'keywordField');
  if (!apple && field === 'title') return t('aso:field.titlePlay');
  if (!apple && field === 'description') return t('aso:field.fullDescription');
  return t(fitFieldLabels[field] ?? k('aso:field.title'));
}

/** "name", "keyword field": the label of a field in a sentence. */
export const fieldWord = (f: FitField): string =>
  f === 'title'
    ? t('aso:lst.source.name')
    : f === 'shortDescription'
      ? t('aso:lst.source.shortDescription')
      : f === 'keywords'
        ? t('aso:lst.source.keywords')
        : f === 'description'
          ? t('aso:lst.source.description')
          : t('aso:lst.source.subtitle');

/** The one muted line under the bars: what is worth a look, or '' when there is nothing. */
export function budgetHeadline(b: ListingBudget): string {
  const parts: string[] = [];
  const over = b.fields.filter((f) => f.over).length;
  if (over > 0) parts.push(t('aso:bud.headline.over', { count: over }));
  if (b.wastedTotal > 0) parts.push(t('aso:bud.headline.freed', { count: b.wastedTotal }));
  if (b.missing.length > 0) parts.push(t('aso:bud.headline.missing', { count: b.missing.length }));
  if (!supports(b.platform, 'keywordField') && b.repeated.length > 0)
    parts.push(t('aso:bud.headline.repeated', { count: b.repeated.length }));
  return formatList(parts, { type: 'unit' });
}

// ---------------------------------------------------------------------------------------------
// Addresses

/** The same address without one query parameter. */
export function withoutParam(hash: string, name: string): string {
  const at = hash.indexOf('?');
  if (at < 0) return hash;
  const params = new URLSearchParams(hash.slice(at + 1));
  params.delete(name);
  const search = params.toString();
  return search === '' ? hash.slice(0, at) : `${hash.slice(0, at)}?${search}`;
}

/** Whether an address asks for the "add keywords" panel (`?add=1`). */
export const asksToAddKeywords = (hash: string): boolean =>
  parseViewPath(hash).query.get('add') === '1';

/** Where a coach action goes. The platform scope of the open app is kept. */
export function coachHref(
  link: CoachLink,
  appId: string,
  platform: PlatformScope | null = null,
): string {
  switch (link.to) {
    case 'keywords_add': {
      const base = asoViewHref(appId, 'keywords', platform);
      return `${base}${base.indexOf('?') < 0 ? '?' : '&'}add=1`;
    }
    case 'listing_keywords':
      return asoViewHref(appId, 'listing', platform);
    case 'keywords':
    case 'competitors':
    case 'fit':
    case 'ideas':
      return asoViewHref(appId, link.to, platform);
    default:
      // A deliberate deep link: it picks the locale and opens its panel (`panel` is not carried by tab links).
      return withPanel(
        withHeaderParams(appAddress(appId, 'listing', platform), { locale: link.locale ?? null }),
        link.locale ?? null,
      );
  }
}
