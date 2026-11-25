import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanCurrency,
  cleanLocale,
  currencyExponent,
  decimalToMinor,
  formatMinor,
  isStoreProductId,
  localizationHash,
  moneyToPrice,
  productHash,
  type StoreProduct,
  sameLocale,
} from './store-products-types.ts';

const product = (over: Partial<StoreProduct> = {}): StoreProduct => ({
  store: 'googleplay',
  productId: 'coins_100',
  storeRef: null,
  kind: 'consumable',
  referenceName: 'coins_100',
  state: 'active',
  rawState: 'ACTIVE',
  localizations: [
    { locale: 'en-US', name: '100 coins', description: 'Bag' },
    { locale: 'de-DE', name: '100 Münzen', description: 'Beutel' },
  ],
  prices: [
    { territory: 'US', currency: 'USD', amount: '99', planId: 'buy' },
    { territory: 'DE', currency: 'EUR', amount: '109', planId: 'buy' },
  ],
  availability: { territories: ['US', 'DE'], availableInNewTerritories: true },
  group: null,
  period: null,
  baseTerritory: null,
  plans: [{ id: 'buy', state: 'ACTIVE', period: null }],
  offers: [],
  ...over,
});

test('decimal prices become minor units, by the currency exponent', () => {
  assert.equal(decimalToMinor('0.99', 'USD'), '99');
  assert.equal(decimalToMinor('4.9', 'USD'), '490');
  assert.equal(decimalToMinor('5', 'USD'), '500');
  assert.equal(decimalToMinor('150', 'JPY'), '150');
  assert.equal(decimalToMinor('1.234', 'KWD'), '1234');
  assert.equal(decimalToMinor('1.005', 'USD'), '101', 'half rounds up');
  assert.equal(decimalToMinor('1.004', 'USD'), '100');
  assert.equal(decimalToMinor(4.99, 'USD'), '499');
  assert.equal(decimalToMinor('-1', 'USD'), undefined);
  assert.equal(decimalToMinor('abc', 'USD'), undefined);
  assert.equal(decimalToMinor('', 'USD'), undefined);
  assert.equal(decimalToMinor(undefined, 'USD'), undefined);
  assert.equal(decimalToMinor('99999999999999.99', 'USD'), '9999999999999999');
});

test('Google Money becomes a price in minor units', () => {
  assert.deepEqual(moneyToPrice({ currencyCode: 'USD', units: '4', nanos: 990_000_000 }), {
    currency: 'USD',
    amount: '499',
  });
  assert.deepEqual(moneyToPrice({ currencyCode: 'JPY', units: '600' }), {
    currency: 'JPY',
    amount: '600',
  });
  assert.deepEqual(moneyToPrice({ currencyCode: 'eur', units: '0', nanos: 5_000_000 }), {
    currency: 'EUR',
    amount: '1',
  });
  assert.deepEqual(moneyToPrice({ currencyCode: 'KWD', units: '1', nanos: 234_000_000 }), {
    currency: 'KWD',
    amount: '1234',
  });
  assert.equal(moneyToPrice({ currencyCode: 'USD', units: '-1', nanos: 0 }), undefined);
  assert.equal(moneyToPrice({ currencyCode: 'US', units: '1' }), undefined);
  assert.equal(moneyToPrice({ currencyCode: 'USD', units: 'x' }), undefined);
  assert.equal(moneyToPrice({ currencyCode: 'USD', units: '1', nanos: 1.5 }), undefined);
  assert.equal(moneyToPrice(null), undefined);
});

test('formatMinor writes the amount back for a person to read', () => {
  assert.equal(formatMinor('499', 'USD'), '4.99');
  assert.equal(formatMinor('5', 'USD'), '0.05');
  assert.equal(formatMinor('0', 'USD'), '0.00');
  assert.equal(formatMinor('600', 'JPY'), '600');
  assert.equal(formatMinor('1234', 'KWD'), '1.234');
  assert.equal(formatMinor('x', 'USD'), 'x');
  assert.equal(currencyExponent('jpy'), 0);
  assert.equal(currencyExponent('USD'), 2);
  assert.equal(cleanCurrency(' usd '), 'USD');
  assert.equal(cleanCurrency('US'), undefined);
});

test('locales and product ids', () => {
  assert.equal(cleanLocale('pt_BR'), 'pt-BR');
  assert.equal(cleanLocale('zh-Hans'), 'zh-Hans');
  assert.equal(cleanLocale('es-419'), 'es-419');
  assert.equal(cleanLocale('en us'), undefined);
  assert.equal(cleanLocale('../x'), undefined);
  assert.equal(cleanLocale(7), undefined);
  assert.equal(sameLocale('en-us', 'en_US'), true);
  assert.equal(sameLocale('en-US', 'en-GB'), false);
  assert.equal(isStoreProductId('com.example.coins_100'), true);
  assert.equal(isStoreProductId('../etc'), false);
  assert.equal(isStoreProductId(''), false);
});

test('the localization hash covers both texts and is not the text', () => {
  const a = localizationHash('Name', 'Description');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, localizationHash('Name', 'Description2'));
  assert.notEqual(a, localizationHash('Name2', 'Description'));
  assert.notEqual(localizationHash('ab', 'c'), localizationHash('a', 'bc'), 'the boundary counts');
  assert.ok(!a.includes('Name'));
});

test('the product hash ignores the order of lists and sees every change', () => {
  const base = product();
  const shuffled = product({
    localizations: [...base.localizations].reverse(),
    prices: [...base.prices].reverse(),
    availability: { territories: ['DE', 'US'], availableInNewTerritories: true },
  });
  assert.equal(productHash(base), productHash(shuffled));
  const changes: Partial<StoreProduct>[] = [
    { state: 'inactive' },
    { localizations: [{ locale: 'en-US', name: '100 coins', description: 'Bag!' }] },
    { prices: [{ territory: 'US', currency: 'USD', amount: '199', planId: 'buy' }] },
    { availability: { territories: ['US'], availableInNewTerritories: true } },
    { availability: null },
    { kind: 'non_consumable' },
    { plans: [{ id: 'buy', state: 'INACTIVE', period: null }] },
  ];
  for (const change of changes)
    assert.notEqual(productHash(base), productHash(product(change)), JSON.stringify(change));
});
