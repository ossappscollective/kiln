import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOURCE_LOCALE } from './core.ts';
import {
  availableLocales,
  bestMatch,
  directionOf,
  formatLocaleFor,
  isAvailableLocale,
  isKnownLocale,
  localeInfo,
  pseudoLocaleInfo,
} from './locales.ts';
import {
  LOCALE_KEY,
  applyDocumentLocale,
  localeFromSearch,
  readLocalePref,
  resolveInitialLocale,
  saveLocalePref,
} from './preference.ts';

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

test('the available languages are English, French, Spanish, German with native names', () => {
  assert.deepEqual(
    availableLocales.map((l) => [l.code, l.name]),
    [['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['de', 'Deutsch']],
  );
  assert.equal(availableLocales[0]?.code, SOURCE_LOCALE);
  assert.equal(isAvailableLocale('fr'), true);
  assert.equal(isAvailableLocale('pseudo'), false);
  assert.equal(isKnownLocale('pseudo'), true);
  assert.equal(isKnownLocale('xx'), false);
  assert.equal(isKnownLocale(null), false);
  assert.equal(localeInfo('de').name, 'Deutsch');
  assert.equal(localeInfo('pseudo'), pseudoLocaleInfo);
  assert.equal(localeInfo('zz').code, 'en');
});

test('bestMatch takes the first language we have, regions fold into the language', () => {
  assert.equal(bestMatch(['fr-CA', 'en']), 'fr');
  assert.equal(bestMatch(['de-AT']), 'de');
  assert.equal(bestMatch(['es_MX']), 'es');
  assert.equal(bestMatch(['ja', 'es', 'en']), 'es');
  assert.equal(bestMatch(['en-GB', 'fr']), 'en');
  assert.equal(bestMatch(['ja', 'zh']), 'en');
  assert.equal(bestMatch([]), 'en');
  assert.equal(bestMatch(['FR']), 'fr');
});

test('formats use the browser region when it names the same language', () => {
  assert.equal(formatLocaleFor('en', ['en-GB', 'en']), 'en-GB');
  assert.equal(formatLocaleFor('de', ['de-CH']), 'de-CH');
  assert.equal(formatLocaleFor('fr', ['en-US', 'fr']), 'fr');
  assert.equal(formatLocaleFor('fr', ['en-US']), 'fr');
  assert.equal(formatLocaleFor('pseudo', []), 'en');
  assert.equal(formatLocaleFor('pseudo', ['en-GB']), 'en-GB');
  assert.equal(formatLocaleFor('en', ['en-not a tag!']), 'en');
});

test('direction', () => {
  assert.equal(directionOf('en'), 'ltr');
  assert.equal(directionOf('ar-EG'), 'rtl');
});

test('the saved language is read back only when it is one we know', () => {
  const store = memory();
  assert.equal(readLocalePref(store), null);
  saveLocalePref('fr', store);
  assert.equal(store.data.get(LOCALE_KEY), 'fr');
  assert.equal(readLocalePref(store), 'fr');
  store.data.set(LOCALE_KEY, 'klingon');
  assert.equal(readLocalePref(store), null);
  saveLocalePref('pseudo', store);
  assert.equal(readLocalePref(store), 'pseudo');
  saveLocalePref(null, store);
  assert.equal(readLocalePref(store), null);
  assert.equal(LOCALE_KEY, 'kiln.locale');
});

test('storage that throws or is missing is not an error', () => {
  const denied = () => {
    throw new Error('denied');
  };
  const broken = { getItem: denied, setItem: denied, removeItem: denied };
  assert.equal(readLocalePref(broken), null);
  assert.doesNotThrow(() => saveLocalePref('fr', broken));
  assert.equal(readLocalePref(undefined), null);
});

test('?lang= asks for a language for this visit', () => {
  assert.equal(localeFromSearch('?lang=pseudo'), 'pseudo');
  assert.equal(localeFromSearch('?a=1&lang=de'), 'de');
  assert.equal(localeFromSearch('?lang=xx'), null);
  assert.equal(localeFromSearch(''), null);
});

test('start-up order: ?lang=, saved choice, browser languages, English', () => {
  assert.equal(resolveInitialLocale({ search: '?lang=de', stored: 'fr', languages: ['es'] }), 'de');
  assert.equal(resolveInitialLocale({ search: '', stored: 'fr', languages: ['es'] }), 'fr');
  assert.equal(resolveInitialLocale({ stored: null, languages: ['es-MX', 'en'] }), 'es');
  assert.equal(resolveInitialLocale({ stored: 'xx', languages: ['ja'] }), 'en');
  assert.equal(resolveInitialLocale({}), 'en');
});

test('lang and dir are set on the root element', () => {
  const attrs: Record<string, string> = {};
  const root = { setAttribute: (n: string, v: string) => void (attrs[n] = v) };
  applyDocumentLocale('fr', root);
  assert.deepEqual(attrs, { lang: 'fr', dir: 'ltr' });
  applyDocumentLocale('pseudo', root);
  assert.deepEqual(attrs, { lang: 'en-XA', dir: 'ltr' });
});
