import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialKinds } from './credentials.ts';
import {
  baseLanguage,
  isTranslationMode,
  isTranslationProvider,
  normalizeLanguageTag,
  sameLanguage,
  translationLimits,
  translationProviderInfo,
  translationProviders,
} from './translation.ts';

test('every provider has a credential kind that exists, and only LibreTranslate runs without one', () => {
  for (const provider of translationProviders) {
    const info = translationProviderInfo[provider];
    assert.ok((credentialKinds as readonly string[]).includes(info.credentialKind), provider);
    assert.ok(info.label && info.privacy, provider);
    assert.equal(info.credentialRequired, provider !== 'libretranslate', provider);
    assert.equal(info.needsUrl, provider === 'libretranslate', provider);
  }
  assert.equal(isTranslationProvider('google'), true);
  assert.equal(isTranslationProvider('bing'), false);
  assert.equal(isTranslationMode('auto'), true);
  assert.equal(isTranslationMode('always'), false);
});

test('the limits are the documented ones', () => {
  assert.deepEqual(translationLimits, {
    maxTextChars: 5000,
    maxTexts: 20,
    maxRequestChars: 20000,
    maxReviewIds: 25,
    maxAutoPerSync: 20,
  });
});

test('normalizeLanguageTag gives the usual spelling and refuses what is not a tag', () => {
  assert.equal(normalizeLanguageTag('en'), 'en');
  assert.equal(normalizeLanguageTag('EN'), 'en');
  assert.equal(normalizeLanguageTag('pt_br'), 'pt-BR');
  assert.equal(normalizeLanguageTag('pt-br'), 'pt-BR');
  assert.equal(normalizeLanguageTag('zh-hans'), 'zh-Hans');
  assert.equal(normalizeLanguageTag('ZH-HANT-TW'), 'zh-Hant-TW');
  assert.equal(normalizeLanguageTag('es-419'), 'es-419');
  assert.equal(normalizeLanguageTag(' fil '), 'fil');
  for (const bad of [
    '',
    'e',
    'english',
    'en-',
    'en-US-x-private',
    'en-US-US',
    'en US',
    'en-Latn-Latn',
    'x-klingon',
    '12',
    'en-1',
    'en;q=0.8',
  ]) {
    assert.equal(normalizeLanguageTag(bad), undefined, JSON.stringify(bad));
  }
});

test('baseLanguage and sameLanguage ignore script and region', () => {
  assert.equal(baseLanguage('pt-BR'), 'pt');
  assert.equal(baseLanguage('zh_Hant'), 'zh');
  assert.equal(baseLanguage('not a tag'), '');
  assert.equal(sameLanguage('en-GB', 'en'), true);
  assert.equal(sameLanguage('pt-PT', 'pt-BR'), true);
  assert.equal(sameLanguage('en', 'de'), false);
  assert.equal(sameLanguage('', ''), false);
  assert.equal(sameLanguage('??', '??'), false);
});
