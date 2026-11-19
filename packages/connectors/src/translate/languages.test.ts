import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  azureCode,
  deeplSource,
  deeplTarget,
  detectedTag,
  googleCode,
  libreTranslateCode,
  providerSource,
  providerTarget,
} from './languages.ts';

const table = (fn: (tag: string) => string | undefined, rows: [string, string | undefined][]) => {
  for (const [tag, expected] of rows) assert.equal(fn(tag), expected, tag);
};

test('Google: Chinese by script or region, Portuguese variants, Norwegian, Filipino, region dropped', () => {
  table(googleCode, [
    ['en', 'en'],
    ['en-GB', 'en'],
    ['EN_us', 'en'],
    ['zh', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh-Hant', 'zh-TW'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant-HK', 'zh-TW'],
    ['pt', 'pt'],
    ['pt-BR', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['pt-AO', 'pt'],
    ['nb', 'no'],
    ['no', 'no'],
    ['nn', 'no'],
    ['tl', 'fil'],
    ['fil', 'fil'],
    ['he', 'he'],
    ['de-CH', 'de'],
    ['not a tag', undefined],
    ['', undefined],
  ]);
});

test('DeepL: English and Portuguese variants, Chinese per script, NB, es-419, sources without variants', () => {
  table(deeplTarget, [
    ['en', 'EN-US'],
    ['en-US', 'EN-US'],
    ['en-CA', 'EN-US'],
    ['en-GB', 'EN-GB'],
    ['en-AU', 'EN-GB'],
    ['pt', 'PT-BR'],
    ['pt-BR', 'PT-BR'],
    ['pt-PT', 'PT-PT'],
    ['zh', 'ZH-HANS'],
    ['zh-Hans', 'ZH-HANS'],
    ['zh-CN', 'ZH-HANS'],
    ['zh-Hant', 'ZH-HANT'],
    ['zh-TW', 'ZH-HANT'],
    ['nb', 'NB'],
    ['no', 'NB'],
    ['nn', 'NB'],
    ['es', 'ES'],
    ['es-MX', 'ES'],
    ['es-419', 'ES-419'],
    ['de', 'DE'],
    ['ja-JP', 'JA'],
    ['??', undefined],
  ]);
  table(deeplSource, [
    ['en-GB', 'EN'],
    ['pt-BR', 'PT'],
    ['zh-Hant', 'ZH'],
    ['nb', 'NB'],
    ['no', 'NB'],
    ['de', 'DE'],
    ['??', undefined],
  ]);
});

test('Azure: zh-Hans and zh-Hant, pt and pt-pt, nb, fil, Serbian scripts, French Canada', () => {
  table(azureCode, [
    ['zh', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['pt', 'pt'],
    ['pt-BR', 'pt'],
    ['pt-PT', 'pt-pt'],
    ['nb', 'nb'],
    ['no', 'nb'],
    ['nn', 'nb'],
    ['tl', 'fil'],
    ['fil', 'fil'],
    ['he', 'he'],
    ['sr', 'sr-Cyrl'],
    ['sr-Latn', 'sr-Latn'],
    ['sr-Cyrl', 'sr-Cyrl'],
    ['fr-CA', 'fr-ca'],
    ['fr-FR', 'fr'],
    ['en-GB', 'en'],
    ['yue', 'yue'],
    ['??', undefined],
  ]);
});

test('LibreTranslate: zh and zt, pt and pb, nb', () => {
  table(libreTranslateCode, [
    ['zh', 'zh'],
    ['zh-Hans', 'zh'],
    ['zh-Hant', 'zt'],
    ['zh-TW', 'zt'],
    ['pt', 'pt'],
    ['pt-PT', 'pt'],
    ['pt-BR', 'pb'],
    ['nb', 'nb'],
    ['no', 'nb'],
    ['en-GB', 'en'],
    ['??', undefined],
  ]);
});

test('auto source detection: undefined, empty and auto all mean "let the provider detect"', () => {
  for (const provider of ['google', 'deepl', 'azure', 'libretranslate'] as const) {
    assert.equal(providerSource(provider, undefined), undefined, provider);
    assert.equal(providerSource(provider, ''), undefined, provider);
    assert.equal(providerSource(provider, 'AUTO'), undefined, provider);
    assert.ok(providerSource(provider, 'de'), provider);
    assert.ok(providerTarget(provider, 'de'), provider);
  }
  assert.equal(providerSource('deepl', 'pt-BR'), 'PT');
  assert.equal(providerTarget('deepl', 'pt-BR'), 'PT-BR');
});

test('detectedTag turns provider codes into tags and drops what is not a language', () => {
  assert.equal(detectedTag('EN'), 'en');
  assert.equal(detectedTag('ZH-HANS'), 'zh-Hans');
  assert.equal(detectedTag('PT-BR'), 'pt-BR');
  assert.equal(detectedTag('iw'), 'he');
  assert.equal(detectedTag('zt'), 'zh-Hant');
  assert.equal(detectedTag('pb'), 'pt-BR');
  assert.equal(detectedTag('und'), undefined);
  assert.equal(detectedTag(''), undefined);
  assert.equal(detectedTag(undefined), undefined);
  assert.equal(detectedTag('???'), undefined);
});
