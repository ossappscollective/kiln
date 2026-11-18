/**
 * The open or closed state of the collapsible parts of a screen (Disclosure, StatusPill, InfoTip),
 * kept in memory only: it survives moving between tabs of the app in one page load, and is gone on
 * reload. Nothing here touches storage. Keys are plain strings such as `listing.warnings`.
 */

const memory = new Map<string, boolean>();

/** What was last chosen for a key, or `undefined` when nothing was chosen yet. */
export function recallExpanded(key: string | undefined): boolean | undefined {
  return key === undefined ? undefined : memory.get(key);
}

/** Remembers a choice. A key of `undefined` is not remembered. */
export function rememberExpanded(key: string | undefined, open: boolean): void {
  if (key !== undefined) memory.set(key, open);
}

/** The remembered choice, else the default. */
export function expandedOr(key: string | undefined, fallback: boolean): boolean {
  return recallExpanded(key) ?? fallback;
}

/** Forgets every choice (tests, sign out). */
export function forgetExpanded(): void {
  memory.clear();
}

/** A key for a part of a screen: `screenKey('listing', 'warnings')` is `listing.warnings`. */
export const screenKey = (screen: string, part: string): string => `${screen}.${part}`;
