import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COUNTRY_CODES, languageKey, localeCovering, mainLanguageOf, normalizeCountryCode } from './countries.ts';

test('the main language of a country, for both stores', () => {
  assert.equal(mainLanguageOf('DE'), 'de');
  assert.equal(mainLanguageOf('at'), 'de');
  assert.equal(mainLanguageOf(' br '), 'pt');
  assert.equal(mainLanguageOf('TW'), 'zh-Hant');
  assert.equal(mainLanguageOf('CN'), 'zh-Hans');
  assert.equal(mainLanguageOf('US'), 'en');
  // A language the App Store cannot offer is English there and the local language on Google Play.
  assert.equal(mainLanguageOf('BG'), 'en');
  assert.equal(mainLanguageOf('BG', 'google_play'), 'bg');
  assert.equal(mainLanguageOf('FR', 'google_play'), 'fr');
});

test('an unknown or malformed country has no language', () => {
  assert.equal(mainLanguageOf('ZZ'), null);
  assert.equal(mainLanguageOf('USA'), null);
  assert.equal(mainLanguageOf(''), null);
  assert.equal(normalizeCountryCode(12), null);
  assert.equal(normalizeCountryCode('de'), 'DE');
});

test('the table has each country once, 175 of them', () => {
  assert.equal(COUNTRY_CODES.length, new Set(COUNTRY_CODES).size);
  assert.equal(COUNTRY_CODES.length, 175);
});

test('language keys fold the spellings of one language', () => {
  assert.equal(languageKey('pt-BR'), 'pt');
  assert.equal(languageKey('pt_PT'), 'pt');
  assert.equal(languageKey('no'), 'nb');
  assert.equal(languageKey('nn-NO'), 'nb');
  assert.equal(languageKey('iw'), 'he');
  assert.equal(languageKey('zh'), 'zh-Hans');
  assert.equal(languageKey('zh-CN'), 'zh-Hans');
  assert.equal(languageKey('zh-Hant-TW'), 'zh-Hant');
  assert.equal(languageKey('zh-HK'), 'zh-Hant');
  assert.equal(languageKey('es-419'), 'es');
  assert.equal(languageKey('default'), null);
  assert.equal(languageKey(''), null);
});

test('a store page covers a language by its tag, and Chinese by script', () => {
  assert.equal(localeCovering('de', ['en-US', 'de-DE']), 'de-DE');
  assert.equal(localeCovering('de', ['en-US', 'fr-FR']), null);
  assert.equal(localeCovering('pt', ['pt-BR']), 'pt-BR');
  assert.equal(localeCovering('zh-Hant', ['zh-Hans']), null);
  assert.equal(localeCovering('zh-Hant', ['zh-Hans', 'zh-TW']), 'zh-TW');
  assert.equal(localeCovering('??', ['en-US']), null);
});
