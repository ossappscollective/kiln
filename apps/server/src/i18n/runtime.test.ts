import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  interpolate as webInterpolate,
  pickMessage as webPick,
  pluralCategory as webPlural,
  splitRich as webSplit,
} from '../../../web/src/lib/i18n/core.ts';
import { availableLocales } from '../../../web/src/lib/i18n/locales.ts';
import { clearCatalogs, registerCatalog, translator } from './catalogs.ts';
import {
  interpolate,
  negotiateLocale,
  pickMessage,
  pluralCategory,
  SERVER_LOCALES,
  splitRich,
} from './runtime.ts';

test('negotiateLocale ranks by q, accepts a region, skips what is unknown and never throws', () => {
  assert.equal(negotiateLocale('fr-CA,fr;q=0.9,en;q=0.8'), 'fr');
  assert.equal(negotiateLocale('xx, de;q=0.5, es;q=0.7'), 'es');
  assert.equal(negotiateLocale('de;q=0'), 'en');
  assert.equal(negotiateLocale('*'), 'en');
  assert.equal(negotiateLocale(undefined), 'en');
  assert.equal(negotiateLocale('x'.repeat(2000)), 'en');
  assert.equal(negotiateLocale(';;;,,,q=', undefined, 'de'), 'de');
  assert.equal(negotiateLocale('pt-BR', ['en', 'pt'], 'en'), 'pt');
});

test('the server runtime picks plurals and fills values like the web runtime', () => {
  const catalog = {
    n_one: '{{count}} app',
    n_other: '{{count}} apps',
    plain: 'Hi {{name}}',
    rich: 'a <strong>b</strong> <link>c</link>',
  };
  for (const locale of SERVER_LOCALES) {
    for (const count of [0, 1, 2, 5, 21, 1000]) {
      assert.equal(pluralCategory(locale, count), webPlural(locale, count));
      assert.equal(pickMessage(catalog, 'n', locale, count), webPick(catalog, 'n', locale, count));
      assert.equal(
        interpolate('{{count}} apps', { count }, locale),
        webInterpolate('{{count}} apps', { count }, locale),
      );
    }
    assert.equal(
      interpolate('Hi {{name}}', { name: 'Ana' }, locale),
      webInterpolate('Hi {{name}}', { name: 'Ana' }, locale),
    );
  }
  assert.deepEqual(splitRich(catalog.rich), webSplit(catalog.rich));
});

test('the server and the web app list the same languages', () => {
  assert.deepEqual(
    [...SERVER_LOCALES],
    availableLocales.map((l) => l.code),
  );
});

test('a translator falls back to English, then to the key; html escapes values', () => {
  clearCatalogs();
  registerCatalog('en', 'x', {
    hello: 'Hello {{name}}',
    only: 'Only English',
    bold: 'Go to <strong>{{where}}</strong>.',
  });
  registerCatalog('fr', 'x', { hello: 'Bonjour {{name}}' });
  const fr = translator('fr');
  assert.equal(fr('x:hello', { name: 'Zoé' }), 'Bonjour Zoé');
  assert.equal(fr('x:only'), 'Only English');
  assert.equal(fr('x:nope'), 'x:nope');
  assert.equal(fr.html('x:bold', { where: '<b>&' }), 'Go to <strong>&lt;b&gt;&amp;</strong>.');
  assert.equal(fr.locale, 'fr');
  clearCatalogs();
});
