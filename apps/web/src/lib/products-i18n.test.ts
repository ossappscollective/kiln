import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import { durationText, severityLabel, warningsSummary } from './revenuecat/revenuecat.ts';
import { kindLabel, priceCountText, priceText } from './products.ts';
import type { ProductPrice } from './types.ts';

const price: ProductPrice = { planId: null, territory: 'FRA', currency: 'EUR', amount: '499', display: '4.99' };

test('product words, plurals and prices follow the language', () => {
  useLocale('fr');
  assert.equal(kindLabel('non_consumable'), 'Non consommable');
  assert.equal(priceCountText(1), '1 pays ou région');
  assert.equal(priceCountText(175), '175 pays ou régions');
  assert.match(priceText(price), /4,99/);
  assert.match(priceText(price), /€/);
  assert.equal(severityLabel('bad'), 'Problème');
  useLocale('de');
  assert.equal(priceCountText(2), '2 Länder oder Regionen');
  assert.equal(durationText('P1M'), '1 Monat');
  assert.equal(warningsSummary([{ code: 'x', severity: 'warn', message: 'm', storeProductId: null, rcProductId: null, entitlementId: null }])?.text, '1 Punkt in der RevenueCat-Einrichtung zu prüfen');
  useLocale('en');
  assert.equal(priceCountText(0), 'No territories');
  assert.equal(durationText('P1M'), '1 month');
});
