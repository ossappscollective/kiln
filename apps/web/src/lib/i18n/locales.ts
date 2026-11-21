/**
 * The languages of the app and the rules for choosing one. Pure: the browser's language list is passed in.
 * To add a language: add it here, add its files under `apps/web/locales/<namespace>/<code>.json` (docs/translating.md).
 */
import { PSEUDO_LOCALE, SOURCE_LOCALE, intlLocaleOf } from './core.ts';

export type LocaleInfo = {
  /** The file name and the value stored in localStorage: a language code such as `fr`. */
  code: string;
  /** The language written in itself, shown in the picker. */
  name: string;
  /** Written direction. */
  dir: 'ltr' | 'rtl';
  /** The tag for `<html lang>` and for `lang` on the picker's options. */
  htmlLang: string;
};

const ltr = 'ltr' as const;

/** The languages people can choose, English first (the source language). Names are native and are never translated. */
export const availableLocales: readonly LocaleInfo[] = [
  { code: 'en', name: 'English', dir: ltr, htmlLang: 'en' },
  { code: 'fr', name: 'Français', dir: ltr, htmlLang: 'fr' },
  { code: 'es', name: 'Español', dir: ltr, htmlLang: 'es' },
  { code: 'de', name: 'Deutsch', dir: ltr, htmlLang: 'de' },
];

/** The development locale: English with accents and brackets. Offered in the picker only in development builds. */
export const pseudoLocaleInfo: LocaleInfo = { code: PSEUDO_LOCALE, name: 'Pseudo (development)', dir: ltr, htmlLang: 'en-XA' };

export const localeCodes: readonly string[] = availableLocales.map((l) => l.code);

/** A language the app has files for (not the pseudo-locale). */
export const isAvailableLocale = (code: unknown): code is string => typeof code === 'string' && localeCodes.indexOf(code) >= 0;

/** A language the app can run in: the available ones and the pseudo-locale. */
export const isKnownLocale = (code: unknown): code is string => isAvailableLocale(code) || code === PSEUDO_LOCALE;

export function localeInfo(code: string): LocaleInfo {
  return availableLocales.find((l) => l.code === code) ?? (code === PSEUDO_LOCALE ? pseudoLocaleInfo : (availableLocales[0] as LocaleInfo));
}

const languageOf = (tag: string): string => tag.toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';

/**
 * The best available language for the person's list of languages (`navigator.languages`, most wanted first): the first entry whose
 * language we have wins, `fr-CA` gives `fr`; otherwise English. The order of the list matters more than how exact a match is.
 */
export function bestMatch(requested: readonly string[], available: readonly string[] = localeCodes): string {
  for (const tag of requested) {
    const normal = tag.toLowerCase().replace(/_/g, '-');
    const exact = available.find((a) => a.toLowerCase() === normal);
    if (exact) return exact;
    const language = languageOf(tag);
    const loose = available.find((a) => languageOf(a) === language);
    if (loose) return loose;
  }
  return SOURCE_LOCALE;
}

/**
 * The tag numbers, dates and currencies are formatted with. The app language alone is too coarse (`en` could be the US, the UK or
 * India), so when the browser's language list names the same language with a region (`en-GB`, `de-CH`) that tag is used: the region
 * decides separators, the order of a date and where the currency sign goes. Otherwise the app language itself. The pseudo-locale
 * formats as English.
 */
export function formatLocaleFor(app: string, browserLanguages: readonly string[]): string {
  const base = intlLocaleOf(app);
  const language = languageOf(base);
  for (const tag of browserLanguages) {
    if (languageOf(tag) !== language || tag.indexOf('-') < 0) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? base;
    } catch {
      // A malformed tag from the browser: ignore it.
    }
  }
  return base;
}

const RIGHT_TO_LEFT = ['ar', 'fa', 'he', 'ur'];

/** `ltr` or `rtl` for a language code. */
export const directionOf = (code: string): 'ltr' | 'rtl' => (RIGHT_TO_LEFT.indexOf(languageOf(code)) >= 0 ? 'rtl' : ltr);
