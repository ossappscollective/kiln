import type { Platform } from '@kiln/core';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { columnKey, type MatrixRow } from './matrix.ts';

/**
 * A language the store holds with required texts left empty (App Store Connect creates a localization with nothing in it when a language
 * is added, and a submit then stops on "Description is empty in fr-FR"): which texts are empty, where to take them from, and what each of
 * the one-click actions would stage. Pure. Nothing here reads or changes a store; the actions stage text for a person to review.
 */

/** Message keys of the field names, in the middle of a sentence. */
const FIELD_WORDS: Record<string, string> = {
  description: k('listing:empty.field.description'),
  keywords: k('listing:empty.field.keywords'),
  support_url: k('listing:empty.field.supportUrl'),
  marketing_url: k('listing:empty.field.marketingUrl'),
  promotional_text: k('listing:empty.field.promotionalText'),
  title: k('listing:empty.field.title'),
  short_description: k('listing:empty.field.shortDescription'),
  full_description: k('listing:empty.field.fullDescription'),
};

export const emptyFieldWord = (field: string): string =>
  FIELD_WORDS[field] ? t(FIELD_WORDS[field]) : field;

/** "fr-FR: description, keywords, support URL are empty". */
export function emptyLine(locale: string, fields: readonly string[]): string {
  return t('listing:empty.line', {
    count: fields.length,
    locale,
    fields: formatList(fields.map(emptyFieldWord), { type: 'unit' }),
  });
}

/** "Empty: description, keywords, support URL": the short form for a chip. */
export const emptyChip = (fields: readonly string[]): string =>
  t('listing:empty.chip', { fields: formatList(fields.map(emptyFieldWord), { type: 'unit' }) });

/** The texts a translation makes sense for. An address or a link is copied as it is, never translated. */
const TRANSLATED = new Set([
  'description',
  'keywords',
  'promotional_text',
  'title',
  'short_description',
  'full_description',
]);
export const isTranslatedField = (field: string): boolean => TRANSLATED.has(field);

/** What a text of the locale already has staged for it (a staged text that is not blank counts as filled). */
export function stillEmpty(
  empty: readonly string[],
  staged: Readonly<Record<string, string | undefined>>,
): string[] {
  return empty.filter((field) => (staged[field] ?? '').trim() === '');
}

export type SourceChoice = {
  locale: string;
  /** The store's value of each wanted field this locale has. */
  values: Record<string, string>;
};

const lower = (code: string): string => code.toLowerCase().replace(/_/g, '-');

/**
 * The locale to take the texts from: the one with the most of the wanted fields filled, the preferred one (en-US) first on a tie, then
 * another English, then the first by code. A locale that is itself empty in the wanted fields is never the source. Null: none has any.
 */
export function pickSource(
  rows: readonly Pick<MatrixRow, 'locale' | 'fields'>[],
  platform: Platform,
  target: string,
  wanted: readonly string[],
  preferred = 'en-US',
): SourceChoice | null {
  let best: { choice: SourceChoice; score: number; rank: number } | null = null;
  for (const row of rows) {
    if (row.locale === target) continue;
    const fields = row.fields[platform];
    if (fields === undefined) continue;
    const values: Record<string, string> = {};
    for (const field of wanted) {
      const found = fields.find((f) => columnKey(f.field) === columnKey(field));
      const value = found?.live.value ?? found?.db.value ?? null;
      if (value !== null && value.trim() !== '') values[field] = value;
    }
    const score = Object.keys(values).length;
    if (score === 0) continue;
    const code = lower(row.locale);
    const rank = code === lower(preferred) ? 0 : code.startsWith('en') ? 1 : 2;
    const better =
      best === null ||
      score > best.score ||
      (score === best.score &&
        (rank < best.rank || (rank === best.rank && row.locale < best.choice.locale)));
    if (better) best = { choice: { locale: row.locale, values }, score, rank };
  }
  return best === null ? null : best.choice;
}

export type FillPlan = {
  source: string;
  /** The fields to stage, in the order of `wanted`, with the text of the source locale. */
  items: { field: string; value: string; translate: boolean }[];
  /** Wanted fields the source locale has no text for: they stay empty. */
  without: string[];
};

/** What "Copy from <source>" and "Translate from <source>" would stage for the empty fields. */
export function fillPlan(source: SourceChoice, wanted: readonly string[]): FillPlan {
  const items: FillPlan['items'] = [];
  const without: string[] = [];
  for (const field of wanted) {
    const value = source.values[field];
    if (value === undefined) without.push(field);
    else items.push({ field, value, translate: isTranslatedField(field) });
  }
  return { source: source.locale, items, without };
}
