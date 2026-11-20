import type { Platform, StoreId } from '@mrm/core';
import type { TestNotes } from './release-candidates.ts';

/**
 * Release notes ("what is new") in the prepare-release stepper: the limits, the texts earlier releases used (and where),
 * copying one language to others, and the TestFlight notes of a build. Pure. Nothing here talks to a store, and a text
 * placed in a draft here is only staged when the person says so. Review text never goes into a log.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

/** The longest "what is new": App Store 4000, Google Play 500 (a limit no official page states: only a warning). */
export const noteLimit = (platform: Platform): number => (platform === 'android' ? 500 : 4000);

export const normalizeLocale = (locale: string): string =>
  locale.trim().toLowerCase().replace(/_/g, '-');

// ---------------------------------------------------------------------------------------------
// History (`GET /apps/{id}/release/notes-history`)

export type NoteUse = {
  source: StoreId | 'plan';
  locale: string;
  version: string | null;
  track: string | null;
  /** Google Play: the version codes of the release. */
  versionCodes?: string[];
  state: string | null;
  at: number | null;
};

export type HistoryNote = {
  text: string;
  truncated: boolean;
  locales: string[];
  lastUsedAt: number | null;
  uses: NoteUse[];
};

export type NotesHistory = {
  app: { id: string; platform: string; store: StoreId };
  locale: string | null;
  notes: HistoryNote[];
  truncated: boolean;
  limit: number;
  store: {
    read: boolean;
    error: string | null;
    cached: boolean;
    versionsRead: number;
    failed: number;
    truncated: boolean;
  };
  generatedAt: number;
};

const STATE_WORDS: Record<string, string> = {
  READY_FOR_DISTRIBUTION: 'live',
  READY_FOR_SALE: 'live',
  PREPARE_FOR_SUBMISSION: 'prepare for submission',
  WAITING_FOR_REVIEW: 'waiting for review',
  IN_REVIEW: 'in review',
  REJECTED: 'rejected',
  PENDING_DEVELOPER_RELEASE: 'approved',
  REPLACED_WITH_NEW_VERSION: 'replaced',
  completed: 'completed',
  inProgress: 'rolling out',
  halted: 'halted',
  draft: 'draft',
};

const stateWord = (state: string | null): string | null => {
  if (state === null || state === '') return null;
  return STATE_WORDS[state] ?? state.toLowerCase().replace(/_/g, ' ');
};

/** Where one text was used: "App Store version 2.4.0 (live), 12 Nov 2026"; "Google Play release Winter on production (completed), no date"; "Release plan 2.3.0". */
export function useLine(use: NoteUse, date: (at: number) => string): string {
  const state = stateWord(use.state);
  const when =
    use.at !== null
      ? `, ${date(use.at)}`
      : use.source === 'googleplay'
        ? ', no date (Google Play does not give one)'
        : '';
  if (use.source === 'plan')
    return `Release plan${use.version ? ` ${use.version}` : ''}${use.at !== null ? `, ${date(use.at)}` : ''}`;
  if (use.source === 'appstoreconnect')
    return `App Store version ${use.version ?? '(unnamed)'}${state ? ` (${state})` : ''}${when}`;
  return `Google Play release ${use.version ?? '(unnamed)'}${use.track ? ` on ${use.track}` : ''}${state ? ` (${state})` : ''}${when}`;
}

export type ReuseOption = {
  text: string;
  /** The first line, cut for the menu. */
  preview: string;
  /** Where it was used, newest first, at most three, then "and N more". */
  uses: string[];
  usesMore: number;
  /** Longer than the target limit: reusing it would be flagged. */
  overLimit: number | null;
  /** The store cut the text at its read limit. */
  truncated: boolean;
  /** The text is what the draft says already. */
  same: boolean;
};

const clean = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

export function previewOf(text: string, max = 90): string {
  const first = clean(text).split('\n')[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1).replace(/\s+$/, '')}…` : first;
}

/**
 * The entries of a history for one language: the texts that were used in that language, newest first. A text that
 * is used in another language only is not offered here (a translation is not a reuse). `current` is the draft text.
 */
export function reuseOptions(
  history: Pick<NotesHistory, 'notes'>,
  locale: string,
  platform: Platform,
  current: string,
  date: (at: number) => string,
): ReuseOption[] {
  const want = normalizeLocale(locale);
  const limit = noteLimit(platform);
  const out: ReuseOption[] = [];
  for (const note of history.notes) {
    const mine = note.uses.filter((u) => normalizeLocale(u.locale) === want);
    if (mine.length === 0 && note.locales.map(normalizeLocale).indexOf(want) < 0) continue;
    const lines = (mine.length > 0 ? mine : note.uses).map((u) => useLine(u, date));
    out.push({
      text: note.text,
      preview: previewOf(note.text),
      uses: lines.slice(0, 3),
      usesMore: Math.max(0, lines.length - 3),
      overLimit: note.text.length > limit ? note.text.length : null,
      truncated: note.truncated,
      same: clean(note.text) === clean(current),
    });
  }
  return out;
}

/** Why the store could not be read, in words ("the store is limiting requests"). */
export const storeErrorWhy = (error: string | null): string =>
  error === 'rate_limited'
    ? 'the store is limiting requests'
    : error === 'store_forbidden' || error === 'credential_unreadable'
      ? 'the credential of this app cannot read them'
      : error === 'timeout'
        ? 'the store did not answer in time'
        : 'the store could not be read';

/** One sentence when the store history could not be read in full (the plan notes are still listed). */
export function historyStoreLine(store: NotesHistory['store'] | undefined): string | null {
  if (!store) return null;
  if (!store.read) {
    return `Earlier notes from the store were not read (${storeErrorWhy(store.error)}). Only the notes of your release plans are listed.`;
  }
  const parts: string[] = [];
  if (store.truncated) parts.push('Only the newest versions were read.');
  if (store.failed > 0)
    parts.push(`${store.failed} ${store.failed === 1 ? 'version' : 'versions'} could not be read.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------------------------
// Drafts of the stepper: one text per language, edited here and staged on request

export type Drafts = Record<string, string>;

/** `drafts` with `text` copied from `from` to every language in `targets` (never to `from` itself). */
export function copyToLocales(
  drafts: Drafts,
  from: string,
  targets: readonly string[],
): { drafts: Drafts; overwritten: number; copied: number } {
  const source = drafts[from] ?? '';
  const next: Drafts = { ...drafts };
  let overwritten = 0;
  let copied = 0;
  for (const t of targets) {
    if (t === from) continue;
    if ((next[t] ?? '').trim() !== '' && next[t] !== source) overwritten += 1;
    next[t] = source;
    copied += 1;
  }
  return { drafts: next, overwritten, copied };
}

/** How many other languages a copy would overwrite (they hold a different text). */
export function overwriteCount(drafts: Drafts, from: string, targets: readonly string[]): number {
  return copyToLocales(drafts, from, targets).overwritten;
}

export type TestFlightFill = { drafts: Drafts; filled: string[]; skipped: string[] };

/**
 * Puts the TestFlight notes of a build into the drafts, language by language (matched ignoring case and `_`/`-`). Only languages
 * the drafts know are filled; the other languages of the notes are reported in `skipped`. Nothing is staged by this.
 */
export function useTestFlightNotes(drafts: Drafts, notes: TestNotes | undefined): TestFlightFill {
  const next: Drafts = { ...drafts };
  const filled: string[] = [];
  const skipped: string[] = [];
  if (!notes?.read) return { drafts, filled, skipped };
  const keys = Object.keys(drafts);
  for (const n of notes.locales) {
    const key = keys.filter((k) => normalizeLocale(k) === normalizeLocale(n.locale))[0];
    if (key === undefined) {
      skipped.push(n.locale);
      continue;
    }
    next[key] = clean(n.text);
    filled.push(key);
  }
  return { drafts: next, filled, skipped };
}

/** The sentence under "Use TestFlight notes". Says plainly when there is nothing to use. */
export function testFlightLine(notes: TestNotes | undefined, buildLabel: string): string {
  if (!notes) return `${buildLabel}: this server did not say whether it has TestFlight notes.`;
  if (!notes.read) {
    return notes.error
      ? `${buildLabel}: its TestFlight notes could not be read (${notes.error.replace(/_/g, ' ')}).`
      : `${buildLabel}: its TestFlight notes were not read. Only the newest eight processed builds are.`;
  }
  if (notes.locales.length === 0) return `${buildLabel}: read, and it has no TestFlight notes.`;
  return `${buildLabel}: TestFlight notes in ${notes.locales.length} ${notes.locales.length === 1 ? 'language' : 'languages'}.`;
}

// ---------------------------------------------------------------------------------------------
// "Promote to production": the notes of the release being promoted fill the editors

export type PromoteNotesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      /** Languages whose editor got the text of the source release. */
      filled: string[];
      /** Languages the source release has text for, where the person had typed or staged text already (left alone). */
      kept: string[];
      /** Filled languages whose text is over the limit of the store. */
      tooLong: string[];
      /** The release was read and has no notes in any language. */
      none: boolean;
      /** The store could not be read (`null`: it was). */
      storeError: string | null;
      storeRead: boolean;
    };

export type PromoteNotesFill = {
  drafts: Drafts;
  /** Languages of the source release that are not shown yet (the editors must show them). */
  addLocales: string[];
  state: Extract<PromoteNotesState, { status: 'done' }>;
};

/**
 * Puts the notes of the source release (the history read for its track and version codes) into the drafts, per language. Never
 * overwrites: a language the person already has a draft for (even an empty one: they cleared it) or has staged text for is kept
 * as it is. `locales` are the languages shown; a language of the source that matches one of them (ignoring case and `_`/`-`) uses
 * its spelling, any other is reported in `addLocales`. Nothing is staged by this.
 */
export function promoteNotesFill(input: {
  history: Pick<NotesHistory, 'notes' | 'store'>;
  drafts: Drafts;
  staged: Readonly<Record<string, string>>;
  locales: readonly string[];
  platform: Platform;
}): PromoteNotesFill {
  const known = (list: readonly string[], locale: string): string | undefined =>
    list.filter((l) => normalizeLocale(l) === normalizeLocale(locale))[0];
  const found = new Map<string, { locale: string; text: string }>();
  for (const note of input.history.notes) {
    const text = clean(note.text);
    if (text === '') continue;
    for (const locale of note.locales) {
      const key = normalizeLocale(locale);
      if (!found.has(key)) found.set(key, { locale, text });
    }
  }
  const drafts: Drafts = { ...input.drafts };
  const filled: string[] = [];
  const kept: string[] = [];
  const tooLong: string[] = [];
  const addLocales: string[] = [];
  const limit = noteLimit(input.platform);
  found.forEach(({ locale, text }) => {
    const shown = known(input.locales, locale) ?? known(Object.keys(input.drafts), locale);
    const key = shown ?? locale;
    const typed = known(Object.keys(input.drafts), key) !== undefined;
    const stagedKey = known(Object.keys(input.staged), key);
    const hasStaged = stagedKey !== undefined && clean(input.staged[stagedKey] as string) !== '';
    if (typed || hasStaged) {
      kept.push(key);
      return;
    }
    drafts[key] = text;
    filled.push(key);
    if (text.length > limit) tooLong.push(key);
    if (shown === undefined && isNoteLocale(key)) addLocales.push(key);
  });
  return {
    drafts,
    addLocales,
    state: {
      status: 'done',
      filled,
      kept,
      tooLong,
      none: found.size === 0,
      storeError: input.history.store.error,
      storeRead: input.history.store.read,
    },
  };
}

const list = (items: readonly string[]): string => items.join(', ');

/**
 * The sentence under the title of the step "What is new" when the person came from a promotion: where the text came from and that
 * nothing is staged yet, or plainly that the source release has no notes (or could not be read).
 */
export function promoteNotesLine(
  state: PromoteNotesState,
  fromLabel: string,
  codes: readonly string[],
): { tone: 'info' | 'ok' | 'warn'; text: string } {
  const release = `the ${fromLabel} release`;
  if (state.status === 'loading') return { tone: 'info', text: `Reading the notes of ${release}.` };
  if (state.status === 'error')
    return {
      tone: 'warn',
      text: `The notes of ${release} could not be read (${state.message}). Write them or reuse earlier ones.`,
    };
  if (!state.storeRead)
    return {
      tone: 'warn',
      text: `The notes of ${release} were not read (${storeErrorWhy(state.storeError)}). Write them or reuse earlier ones.`,
    };
  if (state.none)
    return {
      tone: 'warn',
      text: `The ${fromLabel} release has no notes; write them or reuse earlier ones.`,
    };
  const code =
    codes.length > 0 ? ` (version code${codes.length === 1 ? '' : 's'} ${list(codes)})` : '';
  if (state.filled.length === 0)
    return {
      tone: 'info',
      text: `The ${fromLabel} release${code} has notes in ${list(state.kept)}, but text is already written or staged there, so nothing was replaced.`,
    };
  const parts = [
    `Put in the editors from ${release}${code}: ${list(state.filled)}. Nothing is staged yet.`,
  ];
  if (state.kept.length > 0)
    parts.push(`Not replaced, because you already wrote or staged text: ${list(state.kept)}.`);
  if (state.tooLong.length > 0)
    parts.push(`Too long for the store (shorten it before staging): ${list(state.tooLong)}.`);
  return { tone: 'ok', text: parts.join(' ') };
}

// ---------------------------------------------------------------------------------------------
// One language: where its text stands

export type LocaleState = 'same' | 'edited' | 'staged' | 'new';

export type NoteRow = {
  locale: string;
  /** The text in the editor. */
  draft: string;
  /** What the store holds now (null: not in the store, or not read). */
  store: string | null;
  /** What is staged (null: nothing). */
  staged: string | null;
  state: LocaleState;
  chars: number;
  limit: number;
  over: boolean;
};

/**
 * The state of each language: `edited` (the editor differs from what is staged or, without staging, from the store),
 * `staged` (staged and the editor shows it), `same` (the store has it), `new` (nothing in the store, nothing typed or staged yet counts as new only when text exists).
 */
export function noteRows(input: {
  platform: Platform;
  locales: readonly string[];
  drafts: Drafts;
  store: Readonly<Record<string, string>>;
  staged: Readonly<Record<string, string>>;
}): NoteRow[] {
  const limit = noteLimit(input.platform);
  return input.locales.map((locale) => {
    const draft = input.drafts[locale] ?? input.staged[locale] ?? input.store[locale] ?? '';
    const staged = input.staged[locale] ?? null;
    const store = input.store[locale] ?? null;
    const base = staged ?? store ?? '';
    let state: LocaleState;
    if (clean(draft) !== clean(base)) state = 'edited';
    else if (staged !== null) state = 'staged';
    else if (store !== null) state = 'same';
    else state = 'new';
    return {
      locale,
      draft,
      store,
      staged,
      state,
      chars: draft.length,
      limit,
      over: draft.length > limit,
    };
  });
}

/** The languages whose editor text must still be staged. */
export const unsavedLocales = (rows: readonly NoteRow[]): string[] =>
  rows.filter((r) => r.state === 'edited' && clean(r.draft) !== '').map((r) => r.locale);

export const stateLabel = (state: LocaleState): string =>
  state === 'edited'
    ? 'Not staged yet'
    : state === 'staged'
      ? 'Staged'
      : state === 'same'
        ? 'As in the store'
        : 'No text yet';

/** A locale code the server accepts for notes (`en-US`, `de`, `pt_BR`). */
export const isNoteLocale = (value: string): boolean =>
  /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(value.trim()) && value.trim().length <= 35;
