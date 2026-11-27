import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseLocaleOf,
  equivalentLocaleKeys,
  isLocaleCode,
  isLocaleOrDefault,
  isRepoLocaleFolder,
  LOCALE_EQUIVALENTS,
  languageOfLocale,
  localeGroupKey,
  localeKey,
  localesMatch,
  matchLocale,
  mergeLocales,
  normalizeLocaleCode,
  parseLocale,
  storeCodeOf,
} from './locale.ts';

/**
 * The one locale module (audit listing.md F10/F11): Apple fr-FR vs repo fr_FR vs fastlane fr vs an FR folder; zh-Hans (Apple) vs zh-CN
 * (Play); the primary locale. The old tables are pinned so the move from the server's EQUIVALENT_GROUPS loses nothing.
 */

test('normalizeLocaleCode: every written form of one locale gives one code', () => {
  const same = ['fr-FR', 'fr_FR', 'fr-fr', 'FR-FR', 'Fr_fR', ' fr-FR '];
  for (const raw of same) assert.equal(normalizeLocaleCode(raw), 'fr-FR', raw);
  assert.equal(normalizeLocaleCode('zh-hans'), 'zh-Hans');
  assert.equal(normalizeLocaleCode('zh_hans_cn'), 'zh-Hans-CN');
  assert.equal(normalizeLocaleCode('ES-419'), 'es-419');
  assert.equal(normalizeLocaleCode('EN'), 'en');
  assert.equal(normalizeLocaleCode('pt_br'), 'pt-BR');
  assert.equal(normalizeLocaleCode('fil'), 'fil');
});

test('not a locale: empty, numbers, too many parts, a 4-part tag, an overlong text, not a string', () => {
  for (const bad of ['', ' ', 'e', 'english', '12', 'en-', '-US', 'en-US-x-y', 'en--US', 'en-USA', 'ios/en', 'a'.repeat(40)]) {
    assert.equal(isLocaleCode(bad), false, bad);
    assert.equal(normalizeLocaleCode(bad), null, bad);
  }
  assert.equal(normalizeLocaleCode(undefined), null);
  assert.equal(normalizeLocaleCode(42), null);
  assert.equal(isLocaleOrDefault('default'), true);
  assert.equal(isLocaleOrDefault('fr_FR'), true);
  assert.equal(isLocaleOrDefault('defaults'), false);
  assert.deepEqual(parseLocale('sr-Latn-RS'), { language: 'sr', script: 'Latn', region: 'RS' });
  assert.equal(languageOfLocale('pt-BR'), 'pt');
  assert.equal(languageOfLocale('x'), null);
});

test('the key is total: any text has one, case and separator folded', () => {
  assert.equal(localeKey('FR_fr'), 'fr-fr');
  assert.equal(localeKey(' zh-Hans '), 'zh-hans');
  assert.equal(localeKey('not a code'), 'not a code');
});

test('localesMatch exact / equivalent / language', () => {
  const exact = { mode: 'exact' } as const;
  const lang = { mode: 'language' } as const;
  // exact: case and separator only
  assert.equal(localesMatch('fr_FR', 'fr-fr', exact), true);
  assert.equal(localesMatch('zh-Hans', 'zh-CN', exact), false);
  assert.equal(localesMatch('fr', 'fr-FR', exact), false);
  // equivalent (default): the other store's spelling
  for (const [a, b] of [['zh-Hans', 'zh-CN'], ['zh-Hant', 'zh-TW'], ['ja', 'ja-JP'], ['he', 'iw-IL'], ['he', 'iw'], ['es-MX', 'es-419'], ['no', 'nb-NO'], ['in-ID', 'id'], ['ar-SA', 'ar'], ['nl', 'nl-NL']] as const) {
    assert.equal(localesMatch(a, b), true, `${a} ~ ${b}`);
    assert.equal(localesMatch(b, a), true, `${b} ~ ${a}`);
  }
  assert.equal(localesMatch('en', 'en-US'), false);
  assert.equal(localesMatch('fr-CA', 'fr-FR'), false);
  assert.equal(localesMatch('zh-Hans', 'zh-TW'), false);
  // language: a bare language against a variant, never two variants
  assert.equal(localesMatch('it', 'it-IT', lang), true);
  assert.equal(localesMatch('FR', 'fr_FR', lang), true);
  assert.equal(localesMatch('es-MX', 'es-ES', lang), false);
  assert.equal(localesMatch('fr-CA', 'fr-FR', lang), false);
  assert.equal(localesMatch('en', 'de-DE', lang), false);
});

test('storeCodeOf: write a locale the way a store writes it', () => {
  assert.equal(storeCodeOf('zh-CN', 'app_store'), 'zh-Hans');
  assert.equal(storeCodeOf('zh-Hans', 'google_play'), 'zh-CN');
  assert.equal(storeCodeOf('ja-JP', 'app_store'), 'ja');
  assert.equal(storeCodeOf('ja', 'google_play'), 'ja-JP');
  assert.equal(storeCodeOf('es-419', 'app_store'), 'es-MX');
  assert.equal(storeCodeOf('es-MX', 'google_play'), 'es-419');
  assert.equal(storeCodeOf('he', 'google_play'), 'iw-IL');
  assert.equal(storeCodeOf('fr_FR', 'app_store'), 'fr-FR');
  assert.equal(storeCodeOf('fr_fr', 'google_play'), 'fr-FR');
  assert.equal(storeCodeOf('zh-CN', 'repo'), 'zh-CN');
  assert.equal(storeCodeOf('FR_fr', 'repo'), 'fr-FR');
  assert.equal(storeCodeOf('pt-BR', 'app_store'), 'pt-BR');
});

test('the table is the server table: pinned group by group (zh-Hans/zh-CN included)', () => {
  const OLD: string[][] = [
    ['zh-hans', 'zh-cn'], ['zh-hant', 'zh-tw'], ['ja', 'ja-jp'], ['ko', 'ko-kr'], ['it', 'it-it'], ['ru', 'ru-ru'], ['tr', 'tr-tr'],
    ['pl', 'pl-pl'], ['sv', 'sv-se'], ['da', 'da-dk'], ['fi', 'fi-fi'], ['no', 'no-no', 'nb', 'nb-no'], ['cs', 'cs-cz'], ['el', 'el-gr'],
    ['hu', 'hu-hu'], ['he', 'he-il', 'iw', 'iw-il'], ['hi', 'hi-in'], ['ar-sa', 'ar'], ['ms', 'ms-my'], ['id', 'id-id', 'in-id'],
    ['th', 'th-th'], ['vi', 'vi-vn'], ['uk', 'uk-ua'], ['ro', 'ro-ro'], ['sk', 'sk-sk'], ['hr', 'hr-hr'], ['ca', 'ca-es'], ['nl-nl', 'nl'], ['es-mx', 'es-419'],
  ];
  assert.equal(LOCALE_EQUIVALENTS.length, OLD.length);
  for (const group of OLD) {
    const keys = equivalentLocaleKeys(group[0] as string).slice().sort();
    // the old `id` group has `id` twice via apple/play; compare as sets
    assert.deepEqual([...new Set(keys)], [...new Set(group)].sort(), group.join(','));
  }
  assert.deepEqual(equivalentLocaleKeys('fr-FR'), ['fr-fr']);
});

test('matchLocale: exact, normalized (fr_FR folder), equivalent (zh-CN folder for Apple zh-Hans), ambiguous, none', () => {
  assert.deepEqual(matchLocale('fr-FR', ['de-DE', 'fr-FR']), { kind: 'match', locale: 'fr-FR', how: 'exact' });
  assert.deepEqual(matchLocale('fr-FR', ['de-DE', 'fr_FR']), { kind: 'match', locale: 'fr_FR', how: 'normalized' });
  assert.deepEqual(matchLocale('zh-Hans', ['en-US', 'zh-CN']), { kind: 'match', locale: 'zh-CN', how: 'equivalent' });
  assert.deepEqual(matchLocale('ja', ['ja-JP']), { kind: 'match', locale: 'ja-JP', how: 'equivalent' });
  assert.deepEqual(matchLocale('zh-Hans', ['zh-CN', 'zh-hans']), { kind: 'match', locale: 'zh-hans', how: 'normalized' });
  assert.deepEqual(matchLocale('zh-Hans', ['zh-CN', 'zh-Hans-x'.slice(0, 7)]).kind, 'match');
  assert.deepEqual(matchLocale('he', ['iw', 'he-IL']), { kind: 'ambiguous', candidates: ['he-IL', 'iw'] });
  // nothing is guessed beyond the table: en is not en-US, fr is not fr-FR ...
  assert.deepEqual(matchLocale('en-US', ['en']), { kind: 'none' });
  assert.deepEqual(matchLocale('fr-FR', ['fr', 'FR']), { kind: 'none' });
  // ... unless the language fallback is asked for (a fastlane `fr` or `FR` folder), and then two are still ambiguous
  assert.deepEqual(matchLocale('fr-FR', ['fr'], { languageFallback: true }), { kind: 'match', locale: 'fr', how: 'language' });
  assert.deepEqual(matchLocale('fr-FR', ['FR'], { languageFallback: true }), { kind: 'match', locale: 'FR', how: 'language' });
  assert.deepEqual(matchLocale('fr-FR', ['fr', 'FR'], { languageFallback: true }), { kind: 'ambiguous', candidates: ['FR', 'fr'] });
  // the fallback folder is never a locale
  assert.deepEqual(matchLocale('en-US', ['default']), { kind: 'none' });
});

test('repository folders: fr-FR, fr_FR, Fr-fr, FR, fr, zh-Hans are locale folders; ios, android, default, long names are not', () => {
  for (const ok of ['fr-FR', 'fr_FR', 'Fr-fr', 'FR', 'fr', 'zh-Hans', 'es-419', 'en-US']) assert.equal(isRepoLocaleFolder(ok), true, ok);
  for (const bad of ['ios', 'iOS', 'android', 'default', 'metadata', 'review_information', 'screenshots', '', 'fr-FR-x-y']) assert.equal(isRepoLocaleFolder(bad), false, bad);
});

test('merging records: iOS zh-Hans and Android zh-CN are ONE row', () => {
  const rows = mergeLocales([['en-US', 'zh-Hans', 'fr_FR'], ['en_us', 'zh-CN', 'fr-FR', 'pt-BR']]);
  assert.deepEqual(rows.map((r) => r.key), ['en-us', 'zh-hans', 'fr-fr', 'pt-br']);
  assert.deepEqual(rows.find((r) => r.key === 'zh-hans')?.codes, ['zh-Hans', 'zh-CN']);
  assert.deepEqual(rows.find((r) => r.key === 'fr-fr')?.codes, ['fr-FR']);
  assert.equal(localeGroupKey('zh-CN'), localeGroupKey('zh-Hans'));
  assert.equal(localeGroupKey('es-419'), 'es-mx');
  assert.equal(localeGroupKey('de-DE'), 'de-de');
});

test('the base locale: declared (Play defaultLanguage / Apple primary), else en-US, else English, else the first, said which', () => {
  assert.deepEqual(baseLocaleOf(['de-DE', 'en-US', 'fr-FR'], 'de-DE'), { locale: 'de-DE', source: 'declared' });
  // the declared code may be the other store's spelling
  assert.deepEqual(baseLocaleOf(['zh-Hans', 'en-US'], 'zh-CN'), { locale: 'zh-Hans', source: 'declared' });
  assert.deepEqual(baseLocaleOf(['de-DE', 'en-US'], 'sv-SE'), { locale: 'en-US', source: 'english' });
  assert.deepEqual(baseLocaleOf(['de-DE', 'en-GB', 'en-AU']), { locale: 'en-AU', source: 'english' });
  // an Apple app whose primary is de-DE without en-US: with the primary known it is not "the alphabetically first"
  assert.deepEqual(baseLocaleOf(['fr-FR', 'de-DE', 'ja'], 'de-DE'), { locale: 'de-DE', source: 'declared' });
  assert.deepEqual(baseLocaleOf(['fr-FR', 'de-DE', 'ja']), { locale: 'de-DE', source: 'first' });
  assert.equal(baseLocaleOf([]), null);
  assert.equal(baseLocaleOf(['default']), null);
});
