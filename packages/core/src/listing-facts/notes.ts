import type { ListingStore } from '../listing/listing.ts';
import { measureField } from '../listing/listing.ts';
import { localeGroupKey, localeKey, normalizeLocaleCode } from './locale.ts';
import { normalizeStoreText, RELEASE_NOTES_FIELD, textLimitOf } from './text.ts';

/**
 * THE release notes ("what's new") of a release, merged over the FIVE places that hold them (docs/state-model.md, "Single owners (core)"):
 * the store's editable copy, the staged change, the repository's changelog files, the release PLAN's notes and the Google Play section. Plan
 * readiness ("notes complete") ignored the store and the staged text; the stepper counted locales with text from drafts only and never
 * checked every listing locale had notes; a web row counted UTF-16 units. One view, one status, one limit, one counting unit.
 *
 * THE SOURCES, from the one that will be SHIPPED to the one that is only a draft of it (`NOTE_SOURCE_ORDER`):
 *   1. `staged`   an unpushed staged text: the newest intent of the person (a staged row marked `pushed` is already in the store and is
 *                 the store's text now, so it is ignored here);
 *   2. `store`    the store's EDITABLE copy: what the draft holds;
 *   3. `plan`     the notes written in the release plan;
 *   4. `repo`     the repository's changelog files (fastlane `changelogs`, `release_notes.txt`);
 *   5. `section`  the Google Play section of the last read (the notes of the track's release).
 * The text of a locale is the first non-empty one in that order (`from`). Texts that differ between sources are CONFLICTS: reported with
 * every candidate and the winner, never merged and never silently dropped. (A staged text is an intended edit of the store's text: the two
 * never conflict with each other.)
 *
 * LOCALES are matched by key and by the store equivalence table (a plan locale `fr_FR` and a store `fr-FR` are one row; `zh-Hans` and `zh-CN`
 * too). `locales` (the listing's locales) are the rows that MUST have notes: a required locale with no text is `missing`.
 * STATUS: `empty` (no locale has text), `complete` (every required locale has text; with no required list: at least one has), `partial`
 * (some have, some of the required ones do not). `over` lists the locales over the store's limit, counted by `measureField` (code points, trimmed).
 *
 * Pure. ES2017.
 */

export const NOTE_SOURCE_ORDER = ['staged', 'store', 'plan', 'repo', 'section'] as const;
export type NoteSource = (typeof NOTE_SOURCE_ORDER)[number];

/** One note of one locale in one source. `text: null` or blank is "no note there". */
export type SourceNote = { locale: string; text: string | null | undefined };
export type StagedSourceNote = SourceNote & { pushed?: boolean | undefined };

export type NoteSources = {
  staged?: readonly StagedSourceNote[] | undefined;
  store?: readonly SourceNote[] | undefined;
  plan?: readonly SourceNote[] | undefined;
  repo?: readonly SourceNote[] | undefined;
  section?: readonly SourceNote[] | undefined;
};

export type NoteCandidate = { source: NoteSource; text: string };

export type NoteLocale = {
  /** The code of the row: the listing's code when `locales` names it, else the first source's, normalised. */
  locale: string;
  /** The notes to ship: the first non-empty candidate; '' when no source has one. */
  text: string;
  /** The source of `text`; null when none. */
  from: NoteSource | null;
  /** Every non-empty candidate, in source order. */
  candidates: NoteCandidate[];
  /** `measureField` of `text`. */
  length: number;
  /** The store's limit, or null. */
  limit: number | null;
  over: boolean;
  /** More than one candidate and they differ (once normalised). */
  conflict: boolean;
};

export type NotesView = {
  status: 'empty' | 'partial' | 'complete';
  /** One row per locale that has a source or is required, sorted by code. */
  locales: NoteLocale[];
  /** The locales with at least two different candidates. */
  conflicts: NoteLocale[];
  /** Required locales (the listing's) with no text. */
  missing: string[];
  /** Locales over the limit. */
  over: string[];
};

const text = (v: string | null | undefined): string =>
  (v ?? '').trim() === '' ? '' : (v as string);

export function notesView(
  store: ListingStore,
  sources: NoteSources,
  options: { locales?: readonly string[] } = {},
): NotesView {
  const limit = textLimitOf(store, RELEASE_NOTES_FIELD)?.max ?? null;
  const rows = new Map<string, { code: string; candidates: NoteCandidate[] }>();
  const row = (code: string) => {
    const key = localeGroupKey(code);
    let r = rows.get(key);
    if (r === undefined) {
      r = { code: normalizeLocaleCode(code) ?? code.trim(), candidates: [] };
      rows.set(key, r);
    }
    return r;
  };
  // The required locales come first, so their code is the row's code.
  for (const code of options.locales ?? []) row(code);
  const required = new Set((options.locales ?? []).map(localeGroupKey));
  for (const source of NOTE_SOURCE_ORDER) {
    const list = (sources[source] ?? []) as readonly StagedSourceNote[];
    for (const note of list) {
      if (source === 'staged' && note.pushed === true) continue;
      const value = text(note.text);
      if (value === '') continue;
      row(note.locale).candidates.push({ source, text: value });
    }
  }
  const locales: NoteLocale[] = [];
  rows.forEach((r) => {
    // one candidate per source (the last one given wins), in the fixed order
    const candidates = NOTE_SOURCE_ORDER.map((s) => {
      const mine = r.candidates.filter((c) => c.source === s);
      return mine.length === 0 ? null : (mine[mine.length - 1] as NoteCandidate);
    }).filter((c): c is NoteCandidate => c !== null);
    const first = candidates[0] ?? null;
    const length = first === null ? 0 : measureField({ unit: 'characters' }, first.text);
    // A staged text is an EDIT of the store's text on purpose: it never conflicts with the store copy it replaces (it does with the plan's
    // or the repository's text, which are meant to say the same thing).
    const staged = candidates.some((c) => c.source === 'staged');
    const distinct = new Set(
      candidates
        .filter((c) => !(staged && c.source === 'store'))
        .map((c) => normalizeStoreText(c.text)),
    );
    locales.push({
      locale: r.code,
      text: first === null ? '' : first.text,
      from: first === null ? null : first.source,
      candidates,
      length,
      limit,
      over: limit !== null && length > limit,
      conflict: distinct.size > 1,
    });
  });
  locales.sort((a, b) =>
    localeKey(a.locale) < localeKey(b.locale)
      ? -1
      : localeKey(a.locale) > localeKey(b.locale)
        ? 1
        : 0,
  );
  const have = locales.filter((l) => l.from !== null);
  const missing = locales
    .filter((l) => required.has(localeGroupKey(l.locale)) && l.from === null)
    .map((l) => l.locale);
  const status: NotesView['status'] =
    have.length === 0 ? 'empty' : missing.length > 0 ? 'partial' : 'complete';
  return {
    status,
    locales,
    conflicts: locales.filter((l) => l.conflict),
    missing,
    over: locales.filter((l) => l.over).map((l) => l.locale),
  };
}
