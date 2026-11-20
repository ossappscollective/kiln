import {
  APP_STORE_FIELD_SPECS,
  type AppStoreField,
  countBytes,
  countCharacters,
  isApplePlatform,
  isStageableTextField,
  languageOf,
  type ListingFieldSpec,
  matchWords,
  PLAY_FIELD_SPECS,
  type Platform,
  type PlayField,
  type TermSource,
} from '@mrm/core';

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
  /** The label in the middle of a sentence ("keyword field"). */
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

const LABELS: Record<string, string> = {
  name: 'Title (App Store name)',
  title: 'Title',
  subtitle: 'Subtitle',
  keywords: 'Keyword field',
  promotional_text: 'Promotional text',
  description: 'Description',
  short_description: 'Short description',
  full_description: 'Full description',
};

/** The label in the middle of a sentence, where it is not just the label in lower case. */
const LOWER: Record<string, string> = { name: 'title' };

const MULTILINE: Record<string, boolean> = {
  description: true,
  full_description: true,
  promotional_text: true,
  short_description: false,
};

function specOf(platform: Platform, id: string): ListingFieldSpec | null {
  if (isApplePlatform(platform)) return APP_STORE_FIELD_SPECS[id as AppStoreField] ?? null;
  return PLAY_FIELD_SPECS[id as PlayField] ?? null;
}

/** What the main text fields of a store are, in the order a person works through them. */
export function editableFieldIds(platform: Platform): readonly string[] {
  return isApplePlatform(platform) ? APPLE_ORDER : PLAY_ORDER;
}

/** The field, or null for an id this editor does not edit (urls, release notes, video, ...). */
export function fieldInfo(platform: Platform, id: string): FieldInfo | null {
  if (editableFieldIds(platform).indexOf(id) < 0) return null;
  const spec = specOf(platform, id);
  const label = LABELS[id] ?? spec?.label ?? id;
  return {
    id,
    label,
    lower: LOWER[id] ?? label.toLowerCase(),
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
  return isApplePlatform(platform)
    ? 'The App Store keeps the name and subtitle on the app information, not on the version, so a draft push cannot write them. You can work out the text here and copy it, then change it in App Store Connect. Nothing is saved from here.'
    : 'A draft push cannot write this field. You can work out the text here and copy it. Nothing is saved from here.';
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
  /** "18 of 30 characters, 12 left" or "3 over the limit of 30 characters". */
  text: string;
};

export const lengthOf = (text: string, unit: 'characters' | 'bytes'): number =>
  unit === 'bytes' ? countBytes(text) : countCharacters(text);

export function measureField(
  info: Pick<FieldInfo, 'limit' | 'unit'>,
  text: string,
): FieldMeter {
  const used = lengthOf(text, info.unit);
  if (info.limit === null) {
    return {
      used,
      limit: null,
      remaining: null,
      over: false,
      unit: info.unit,
      percent: 0,
      text: `${used} ${info.unit}`,
    };
  }
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
      ? `${-remaining} over the limit of ${info.limit} ${info.unit}`
      : `${used} of ${info.limit} ${info.unit}, ${remaining} left`,
  };
}

// ---------------------------------------------------------------------------------------------
// Mapping a field to where a keyword appears

/** The listing field id a place a keyword appears in stands for, on this store. */
export function fieldIdForSource(platform: Platform, source: TermSource): string {
  switch (source) {
    case 'title':
      return isApplePlatform(platform) ? 'name' : 'title';
    case 'subtitle':
      return 'subtitle';
    case 'keywords':
      return 'keywords';
    case 'shortDescription':
      return 'short_description';
    default:
      return isApplePlatform(platform) ? 'description' : 'full_description';
  }
}

/** The word for a place in a sentence: the same on both stores ("title", "keyword field"). */
export function sourceWord(source: TermSource): string {
  switch (source) {
    case 'title':
      return 'title';
    case 'subtitle':
      return 'subtitle';
    case 'keywords':
      return 'keyword field';
    case 'shortDescription':
      return 'short description';
    default:
      return 'description';
  }
}

/** "In the title and keyword field". */
export function whereText(sources: readonly TermSource[]): string {
  const names = sources.map(sourceWord);
  if (names.length === 0) return 'Not in the listing';
  const joined =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `In the ${joined}`;
}

// ---------------------------------------------------------------------------------------------
// Adding a keyword to a field

/** The fields a keyword can be added to, the likeliest first (the keyword field on the App Store). */
export function addTargets(platform: Platform): FieldInfo[] {
  const order = isApplePlatform(platform)
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
export const addLabel = (info: Pick<FieldInfo, 'lower'>): string => `Add to ${info.lower}`;

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
  if (clean === '') return { text: current, changed: false, note: 'There is no keyword to add.' };
  const needle = Array.from(new Set(matchWords(clean, language)));
  if (info.id === 'keywords') {
    const entries = current.split(',').map((e) => keyOf(e, language));
    if (entries.indexOf(keyOf(clean, language)) >= 0) {
      return { text: current, changed: false, note: `“${clean}” is already in the keyword field.` };
    }
    const base = current.replace(/[\s,]+$/, '');
    return {
      text: base === '' ? clean : `${base},${clean}`,
      changed: true,
      note: 'Added at the end, after a comma. Remove an entry you can spare if it does not fit.',
    };
  }
  const have = new Set(matchWords(current, language));
  if (needle.length > 0 && needle.every((w) => have.has(w))) {
    return {
      text: current,
      changed: false,
      note: `“${clean}” is already in the ${info.lower}.`,
    };
  }
  if (current.trim() === '') {
    return {
      text: clean,
      changed: true,
      note: 'The field is empty, so it starts with the keyword.',
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
    note: 'Added at the end as a starting point. Reword it so it reads well before you stage it.',
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
  if (!input.canStage) return 'Your role cannot stage changes. A member, admin or owner can.';
  if (input.empty) return 'The text is empty. A draft push does not write an empty text.';
  if (input.over) return 'The text is over the limit. Shorten it first.';
  if (input.unchanged) return 'The text is the same as the one in the store.';
  return null;
}
