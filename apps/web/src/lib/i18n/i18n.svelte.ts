/**
 * The reactive side of the language: which one is active, choosing another, and the start-up. Everything that does not need a rune lives in
 * the plain modules (`t.ts`, `format.ts`, `locales.ts`, `preference.ts`).
 *
 * First paint: `main.ts` awaits `initI18n()` before mounting, so the first thing drawn is already in the person's language (English is
 * bundled; another language is fetched first). If the fetch is slow (over 4 seconds) the app mounts in English and switches when it arrives.
 * Changing the language later loads the new catalogs first and flips in one step; the old language stays until then.
 */

import { loadLocale } from './catalogs.ts';
import { SOURCE_LOCALE } from './core.ts';
import {
  availableLocales,
  isKnownLocale,
  type LocaleInfo,
  localeInfo,
  pseudoLocaleInfo,
} from './locales.ts';
import {
  applyDocumentLocale,
  readLocalePref,
  resolveInitialLocale,
  saveLocalePref,
} from './preference.ts';
import { setLocaleSource, setMissingReporter } from './t.ts';

let current = $state<string>(SOURCE_LOCALE);
let switching = $state(false);
let ticket = 0;

setLocaleSource(() => current);

if (import.meta.env.DEV) {
  setMissingReporter((key, locale) =>
    console.warn(
      `[i18n] No message for "${key}" (active language: ${locale}). Add it to apps/web/locales.`,
    ),
  );
}

/** The languages the picker offers: the available ones, plus the pseudo-locale in development builds. */
export const pickerLocales: readonly LocaleInfo[] = import.meta.env.DEV
  ? [...availableLocales, pseudoLocaleInfo]
  : availableLocales;

/** The active language, reactive: read it in a template or `$derived`. */
export const i18n = {
  get locale(): string {
    return current;
  },
  get info(): LocaleInfo {
    return localeInfo(current);
  },
  /** True while another language's files are being fetched. */
  get switching(): boolean {
    return switching;
  },
};

async function activate(code: string): Promise<boolean> {
  const mine = ++ticket;
  switching = true;
  try {
    await loadLocale(code);
  } catch (error) {
    console.warn(
      `[i18n] Could not load the "${code}" translations; staying on "${current}".`,
      error,
    );
    if (mine === ticket) switching = false;
    return false;
  }
  if (mine !== ticket) return false;
  current = code;
  switching = false;
  if (typeof document !== 'undefined') applyDocumentLocale(code, document.documentElement);
  return true;
}

/**
 * Chooses the language: loads it, makes it active and remembers it in this browser (`kiln.locale`). `{ persist: false }` is for a
 * preview that should not become the person's choice. An unknown code is ignored. Resolves to whether the language is now active.
 */
export async function setLocale(
  code: string,
  options: { persist?: boolean } = {},
): Promise<boolean> {
  if (!isKnownLocale(code)) return false;
  const ok = await activate(code);
  if (ok && options.persist !== false) saveLocalePref(code);
  return ok;
}

const SLOW_MS = 4000;

/** Starts the language: `?lang=`, else the saved choice, else the browser's languages, else English. Call once, before mounting. Never rejects. */
export async function initI18n(): Promise<string> {
  const code = resolveInitialLocale({
    search: typeof location === 'undefined' ? '' : location.search,
    stored: readLocalePref(),
    languages:
      typeof navigator === 'undefined'
        ? []
        : navigator.languages && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language],
  });
  if (typeof document !== 'undefined') applyDocumentLocale(SOURCE_LOCALE, document.documentElement);
  const started = activate(code);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SLOW_MS);
  });
  await Promise.race([started.then(() => undefined), slow]);
  if (timer !== undefined) clearTimeout(timer);
  return current;
}
