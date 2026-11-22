/**
 * The saved language, like `lib/theme.ts` does for the theme: `kiln.locale` in localStorage. Pure, with the storage passed in so
 * tests need no browser. Order of choice at start: `?lang=` in the address (this visit only), the saved choice, the browser's
 * languages, English.
 */
import { SOURCE_LOCALE } from './core.ts';
import { bestMatch, directionOf, isKnownLocale, localeInfo } from './locales.ts';

export const LOCALE_KEY = 'kiln.locale';

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem' | 'removeItem'>;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The saved language, or null when nothing valid is saved or storage is unavailable. */
export function readLocalePref(storage: Reader | undefined = defaultStorage()): string | null {
  try {
    const value = storage?.getItem(LOCALE_KEY);
    return isKnownLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** Saves the choice. A private window can refuse storage; the choice then lasts one visit. `null` forgets it. */
export function saveLocalePref(
  code: string | null,
  storage: Writer | undefined = defaultStorage(),
): void {
  try {
    if (code === null) storage?.removeItem(LOCALE_KEY);
    else storage?.setItem(LOCALE_KEY, code);
  } catch {
    // Not remembered. Nothing else to do.
  }
}

/** The language `?lang=fr` asks for (also `?lang=pseudo`), or null. Used for previews and screenshots; never saved. */
export function localeFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('lang');
  return isKnownLocale(value) ? value : null;
}

/** The language to start in. */
export function resolveInitialLocale(input: {
  search?: string | undefined;
  stored?: string | null | undefined;
  languages?: readonly string[] | undefined;
}): string {
  return (
    localeFromSearch(input.search ?? '') ??
    (isKnownLocale(input.stored) ? input.stored : null) ??
    bestMatch(input.languages ?? []) ??
    SOURCE_LOCALE
  );
}

/** Sets `lang` and `dir` on the root element (`<html>`), so screen readers, hyphenation and the layout follow the language. */
export function applyDocumentLocale(
  code: string,
  root: { setAttribute(name: string, value: string): void },
): void {
  root.setAttribute('lang', localeInfo(code).htmlLang);
  root.setAttribute('dir', directionOf(code));
}
