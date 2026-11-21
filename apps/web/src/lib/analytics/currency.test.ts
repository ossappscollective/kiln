import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCurrency, localeCurrency, offeredCurrencies } from './currency.ts';

test('a locale tells its currency; a tag without a known region tells none', () => {
  assert.equal(localeCurrency('en-US'), 'USD');
  assert.equal(localeCurrency('de-CH'), 'CHF');
  assert.equal(localeCurrency('fr-FR'), 'EUR');
  assert.equal(localeCurrency('pt-BR'), 'BRL');
  assert.equal(localeCurrency('ja'), 'JPY', 'a language alone is completed to its usual region');
  assert.equal(localeCurrency('en'), 'USD');
  assert.equal(localeCurrency(null), null);
  assert.equal(localeCurrency('not a locale'), null);
});

test('the currency a chart opens on: what the person chose, else their locale, else the biggest', () => {
  const have = ['EUR', 'USD', 'GBP'];
  assert.equal(defaultCurrency(have, 'GBP', 'en-US'), 'GBP', 'the earlier choice wins');
  assert.equal(defaultCurrency(have, null, 'en-US'), 'USD', 'then the locale');
  assert.equal(defaultCurrency(have, 'JPY', 'en-GB'), 'GBP', 'a choice the card does not have is ignored');
  assert.equal(defaultCurrency(have, null, 'ja-JP'), 'EUR', 'a locale currency the card does not have: the biggest');
  assert.equal(defaultCurrency([], null, 'en-US'), '');
});

test('the default is offered first and the rest keep their order', () => {
  assert.deepEqual(offeredCurrencies(['EUR', 'USD', 'GBP'], 'USD'), ['USD', 'EUR', 'GBP']);
  assert.deepEqual(offeredCurrencies(['EUR', 'USD'], 'EUR'), ['EUR', 'USD']);
  assert.deepEqual(offeredCurrencies(['EUR', 'USD'], 'JPY'), ['EUR', 'USD']);
});
