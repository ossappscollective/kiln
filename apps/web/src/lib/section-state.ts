import { canonicalAppHash, canonicalSection, viewOf } from './app-nav.ts';
import { parseAppAddress, parseViewPath } from './app-scope.ts';
import { t } from './i18n/t.ts';

/**
 * The open or closed state of the collapsible sections of a page (components/ui/Section.svelte), remembered per workspace, person,
 * page and section key. Pure: the storage is passed in (the browser's `localStorage`, or a fake in tests) and every call survives a
 * storage that is missing, full or refuses (a private window): reads then give the default and writes are dropped.
 */

export type SectionScope = { workspaceId: string; userId: string; page: string };

/** The part of `Storage` this needs; `null` stands for no storage at all. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const PREFIX = 'kiln.sections.v1';

/** One entry per workspace, person and page; it holds `{ [sectionKey]: open }`. */
export const sectionStorageKey = (scope: SectionScope): string =>
  `${PREFIX}:${scope.workspaceId}:${scope.userId}:${scope.page}`;

/** What is stored, as a map. Anything that is not an object of booleans reads as nothing. */
export function parseSectionState(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function load(storage: StorageLike | null, scope: SectionScope): Record<string, boolean> {
  if (!storage) return {};
  try {
    return parseSectionState(storage.getItem(sectionStorageKey(scope)));
  } catch {
    return {};
  }
}

/** The remembered state of a section, else the default. */
export function readSectionOpen(
  storage: StorageLike | null,
  scope: SectionScope,
  key: string,
  fallback: boolean,
): boolean {
  return load(storage, scope)[key] ?? fallback;
}

/** Remembers the state of several sections of a page at once (Collapse all, Expand all). Returns false when it could not be saved. */
export function writeSectionsOpen(
  storage: StorageLike | null,
  scope: SectionScope,
  changes: Readonly<Record<string, boolean>>,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      sectionStorageKey(scope),
      JSON.stringify({ ...load(storage, scope), ...changes }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Remembers the state of one section. */
export const writeSectionOpen = (
  storage: StorageLike | null,
  scope: SectionScope,
  key: string,
  open: boolean,
): boolean => writeSectionsOpen(storage, scope, { [key]: open });

/** The browser's storage, or null when it refuses to be touched. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Collapse all and Expand all are offered from this many sections on a page. */
export const TOGGLE_ALL_FROM = 3;
export const showsToggleAll = (sectionCount: number): boolean => sectionCount >= TOGGLE_ALL_FROM;

/** The label of the one button: it collapses while any section is open, and expands when all are closed. */
export const toggleAllLabel = (anyOpen: boolean): string =>
  anyOpen ? t('shell:section.collapseAll') : t('shell:section.expandAll');

/** The one-line summary of a collapsed section: the parts that have something to say, joined as `12 locales · 3 need attention`. */
export function summaryLine(
  parts: readonly (string | number | null | undefined | false)[],
): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && p !== false && p !== '')
    .join(' · ');
}

/** `count(1, 'locale')` is `1 locale`, `count(3, 'locale')` is `3 locales`. */
export const countOf = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The page an address is, for remembering sections: the page of an app (`listing.graphics`, not the app, so a choice holds for every
 * app and an old address reads as the page that replaced it), else the first part of the address (`reviews`, `settings`).
 */
export function sectionPageOf(hash: string): string {
  const canonical = canonicalAppHash(hash) ?? hash;
  const app = parseAppAddress(canonical);
  if (app) {
    if (app.release !== null) return 'release';
    const section = canonicalSection(app.section);
    const view = viewOf(section, canonical);
    return view === '' ? section : `${section}.${view}`;
  }
  return parseViewPath(hash).segments[0] ?? 'portfolio';
}
