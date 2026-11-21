import {
  APP_STORE_FIELD_SPECS,
  type AppStoreField,
  byFamily,
  countBytes,
  countCharacters,
  isStageableTextField,
  type ListingFieldSpec,
  languageOf,
  listingStoreOf,
  matchWords,
  PLAY_FIELD_SPECS,
  type Platform,
  type PlayField,
  type TermSource,
} from '@kiln/core';
import { formatList, formatNumber } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * Editing a listing text from the web, pure parts: which main text fields a store has, their limits, whether a draft push can
 * write them (and so whether "Stage" exists), the live character or byte counter, and the starting text when a keyword is added to a
 * field. Nothing here reads or writes anything: the editor stages through `PUT .../staged/text`, which only touches our own
 * database, and the push to a store stays the gated step of the tray. Written for the ES2017 web build.
 */

export type FieldInfo = {
  /** The id the store listing uses (`name`, `subtitle`, `keywords`, `title`, `short_description`, ...). */
  id: string;
  /** The name in the screen ("Name", "Keyword field", "Short description"). */
  label: string;
  /** The label in the middle of a sentence ("keyword field"), written for the active language. */
  lower: string;
  limit: number | null;
  unit: 'characters' | 'bytes';
  multiline: boolean;
  /** A draft push can write it, so the text can be staged. */
  stageable: boolean;
};

const APPLE_ORDER: readonly string[] = [
  'name',
  'subtitle',
  'keywords',
  'promotional_text',
  'description',
];
const PLAY_ORDER: readonly string[] = ['title', 'short_description', 'full_description'];

/** Message keys of the field names (translated by `fieldInfo`). */
const LABELS: Record<string, string> = {
  name: k('listing:edit.label.name'),
  title: k('listing:edit.label.title'),
  subtitle: k('listing:edit.label.subtitle'),
  keywords: k('listing:edit.label.keywords'),
  promotional_text: k('listing:edit.label.promotionalText'),
  description: k('listing:edit.label.description'),
  short_description: k('listing:edit.label.shortDescription'),
  full_description: k('listing:edit.label.fullDescription'),
};

/** Message keys of the field names inside a sentence ("keyword field"). */
const LOWER: Record<string, string> = {
  name: k('listing:edit.lower.name'),
  title: k('listing:edit.lower.title'),
  subtitle: k('listing:edit.lower.subtitle'),
  keywords: k('listing:edit.lower.keywords'),
  promotional_text: k('listing:edit.lower.promotionalText'),
  description: k('listing:edit.lower.description'),
  short_description: k('listing:edit.lower.shortDescription'),
  full_description: k('listing:edit.lower.fullDescription'),
};

const MULTILINE: Record<string, boolean> = {
  description: true,
  full_description: true,
  promotional_text: true,
  short_description: false,
};

function specOf(platform: Platform, id: string): ListingFieldSpec | null {
  if (listingStoreOf(platform) === 'app_store')
    return APP_STORE_FIELD_SPECS[id as AppStoreField] ?? null;
  return PLAY_FIELD_SPECS[id as PlayField] ?? null;
}

/** What the main text fields of a store are, in the order a person works through them. */
export function editableFieldIds(platform: Platform): readonly string[] {
  return byFamily(platform, { apple: APPLE_ORDER, google: PLAY_ORDER });
}

/** The field, or null for an id this editor does not edit (urls, release notes, video, ...). */
export function fieldInfo(platform: Platform, id: string): FieldInfo | null {
  if (editableFieldIds(platform).indexOf(id) < 0) return null;
  const spec = specOf(platform, id);
  const label = LABELS[id] ? t(LABELS[id]) : (spec?.label ?? id);
  return {
    id,
    label,
    lower: LOWER[id] ? t(LOWER[id]) : label.toLowerCase(),
    limit: spec?.maxLength ?? null,
    unit: spec?.unit ?? 'characters',
    multiline: MULTILINE[id] === true || spec?.kind === 'multiline',
    stageable: isStageableTextField(platform, id),
  };
}

export function editableFields(platform: Platform): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const id of editableFieldIds(platform)) {
    const info = fieldInfo(platform, id);
    if (info) out.push(info);
  }
  return out;
}

/** Why a field cannot be staged, or null when it can. */
export function notStageableReason(platform: Platform, id: string): string | null {
  if (isStageableTextField(platform, id)) return null;
  return listingStoreOf(platform) === 'app_store'
    ? t('listing:edit.notStageableApple')
    : t('listing:edit.notStageableOther');
}

// ---------------------------------------------------------------------------------------------
// The counter

export type FieldMeter = {
  used: number;
  limit: number | null;
  remaining: number | null;
  over: boolean;
  unit: 'characters' | 'bytes';
  percent: number;
  /** "18 of 30 characters, 12 left" or "3 over the limit of 30 characters" (in the active language). */
  text: string;
};

export const lengthOf = (text: string, unit: 'characters' | 'bytes'): number =>
  unit === 'bytes' ? countBytes(text) : countCharacters(text);

export function measureField(info: Pick<FieldInfo, 'limit' | 'unit'>, text: string): FieldMeter {
  const used = lengthOf(text, info.unit);
  if (info.limit === null) {
    return {
      used,
      limit: null,
      remaining: null,
      over: false,
      unit: info.unit,
      percent: 0,
      text:
        info.unit === 'bytes'
          ? t('listing:edit.meter.bytes', { count: used })
          : t('listing:edit.meter.characters', { count: used }),
    };
  }
  const bytes = info.unit === 'bytes';
  const remaining = info.limit - used;
  const over = remaining < 0;
  return {
    used,
    limit: info.limit,
    remaining,
    over,
    unit: info.unit,
    percent: info.limit === 0 ? 100 : Math.min(100, Math.round((used / info.limit) * 100)),
    text: over
      ? bytes
        ? t('listing:edit.meter.overBytes', { count: info.limit, over: formatNumber(-remaining) })
        : t('listing:edit.meter.overCharacters', { count: info.limit, over: formatNumber(-remaining) })
      : bytes
        ? t('listing:edit.meter.leftBytes', { count: info.limit, used: formatNumber(used), left: formatNumber(remaining) })
        : t('listing:edit.meter.leftCharacters', { count: info.limit, used: formatNumber(used), left: formatNumber(remaining) }),
  };
}

// ---------------------------------------------------------------------------------------------
// Mapping a field to where a keyword appears

/** The listing field id a place a keyword appears in stands for, on this store. */
export function fieldIdForSource(platform: Platform, source: TermSource): string {
  switch (source) {
    case 'title':
      return byFamily(platform, { apple: 'name', google: 'title' });
    case 'subtitle':
      return 'subtitle';
    case 'keywords':
      return 'keywords';
    case 'shortDescription':
      return 'short_description';
    default:
      return byFamily(platform, { apple: 'description', google: 'full_description' });
  }
}

/** The word for a place in a sentence: the same on both stores ("title", "keyword field"). */
export function sourceWord(source: TermSource): string {
  switch (source) {
    case 'title':
      return t('listing:edit.source.title');
    case 'subtitle':
      return t('listing:edit.source.subtitle');
    case 'keywords':
      return t('listing:edit.source.keywords');
    case 'shortDescription':
      return t('listing:edit.source.shortDescription');
    default:
      return t('listing:edit.source.description');
  }
}

/** "In the title and keyword field". */
export function whereText(sources: readonly TermSource[]): string {
  if (sources.length === 0) return t('listing:edit.where.none');
  return t('listing:edit.where.in', { list: formatList(sources.map(sourceWord)) });
}

// ---------------------------------------------------------------------------------------------
// Adding a keyword to a field

/** The fields a keyword can be added to, the likeliest first (the keyword field on the App Store). */
export function addTargets(platform: Platform): FieldInfo[] {
  const order =
    listingStoreOf(platform) === 'app_store'
      ? ['keywords', 'name', 'subtitle', 'promotional_text', 'description']
      : ['title', 'short_description', 'full_description'];
  const out: FieldInfo[] = [];
  for (const id of order) {
    const info = fieldInfo(platform, id);
    if (info) out.push(info);
  }
  return out;
}

/** "Add to keyword field", "Add to title". */
export const addLabel = (info: Pick<FieldInfo, 'lower'>): string => t('listing:edit.addTo', { field: info.lower });

export type AddResult = {
  /** The text to start the editor with. The person edits it before staging. */
  text: string;
  changed: boolean;
  /** Why nothing changed, or how the term was put in. */
  note: string;
};

const keyOf = (text: string, language: string): string => matchWords(text, language).join(' ');

/**
 * The text of a field with a keyword added, as a STARTING POINT for the editor: the keyword field gets the term after a comma (no
 * space: every byte counts), the name goes after a dash, a short text after a comma, a long text on a new paragraph. A term whose words
 * are all in the field already changes nothing. The person edits the result; nothing is staged by this function.
 */
export function addTermToText(
  info: Pick<FieldInfo, 'id' | 'lower'>,
  current: string,
  term: string,
  locale: string,
): AddResult {
  const clean = term.replace(/\s+/g, ' ').trim();
  const language = languageOf(locale);
  if (clean === '') return { text: current, changed: false, note: t('listing:edit.add.noKeyword') };
  const needle = Array.from(new Set(matchWords(clean, language)));
  if (info.id === 'keywords') {
    const entries = current.split(',').map((e) => keyOf(e, language));
    if (entries.indexOf(keyOf(clean, language)) >= 0) {
      return { text: current, changed: false, note: t('listing:edit.add.alreadyInKeywords', { term: clean }) };
    }
    const base = current.replace(/[\s,]+$/, '');
    return {
      text: base === '' ? clean : `${base},${clean}`,
      changed: true,
      note: t('listing:edit.add.keywordsAdded'),
    };
  }
  const have = new Set(matchWords(current, language));
  if (needle.length > 0 && needle.every((w) => have.has(w))) {
    return {
      text: current,
      changed: false,
      note: t('listing:edit.add.alreadyIn', { term: clean, field: info.lower }),
    };
  }
  if (current.trim() === '') {
    return {
      text: clean,
      changed: true,
      note: t('listing:edit.add.emptyField'),
    };
  }
  const base = current.replace(/\s+$/, '');
  let text: string;
  if (info.id === 'name' || info.id === 'title') text = `${base} - ${clean}`;
  else if (info.id === 'description' || info.id === 'full_description')
    text = `${base}\n\n${clean}`;
  else text = `${base.replace(/[,;.\s]+$/, '')}, ${clean}`;
  return {
    text,
    changed: true,
    note: t('listing:edit.add.added'),
  };
}

/** Whether two texts are the same once line breaks and trailing white space are normalised (the server does the same). */
export const sameText = (a: string, b: string): boolean => {
  const n = (v: string) =>
    v
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\s+$/, '');
  return n(a) === n(b);
};

/** Why "Stage" is unavailable for a draft, or null. */
export function stageBlockedReason(input: {
  platform: Platform;
  field: string;
  canStage: boolean;
  empty: boolean;
  over: boolean;
  unchanged: boolean;
}): string | null {
  const notStageable = notStageableReason(input.platform, input.field);
  if (notStageable !== null) return notStageable;
  if (!input.canStage) return t('listing:edit.blocked.role');
  if (input.empty) return t('listing:edit.blocked.empty');
  if (input.over) return t('listing:edit.blocked.over');
  if (input.unchanged) return t('listing:edit.blocked.unchanged');
  return null;
}
