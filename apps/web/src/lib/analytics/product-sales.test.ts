import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountLines,
  type ProductSalesView,
  salesByProduct,
  salesCell,
  salesMeasureText,
  salesSetupHint,
  salesVisible,
  unitsText,
} from './product-sales.ts';

const base = (over: Partial<ProductSalesView> = {}): ProductSalesView => ({
  appId: 'a',
  platform: 'android',
  from: '2026-10-22',
  to: '2026-11-18',
  source: 'play_sales',
  measure: 'google_buyer_paid_estimate',
  unitsKind: 'orders',
  hasSalesData: true,
  enabled: true,
  sales: { source: 'play_sales', label: 'x', state: 'ready', setup: null, lastOkAt: 1, lastError: null },
  products: [
    {
      productId: 'coins',
      units: 3,
      amounts: [
        { currency: 'EUR', amount: 7.11, refunds: 2.37 },
        { currency: 'USD', amount: 5, refunds: 0 },
      ],
      days: 2,
    },
    { productId: 'free_thing', units: null, amounts: [], days: 0 },
  ],
  notes: [],
  ...over,
});
const apple = (): ProductSalesView =>
  base({
    platform: 'ios',
    source: 'apple_sales',
    measure: 'apple_proceeds',
    unitsKind: 'units',
    products: [
      { productId: 'pro', units: 1, amounts: [{ currency: 'USD', amount: 29.99, refunds: null }], days: 1 },
    ],
  });

test('money is one line per currency, refunds are taken off a Google estimate, never summed', () => {
  const view = base();
  const item = salesByProduct(view).get('coins');
  assert.deepEqual(amountLines(view, item), ['€4.74', '$5.00']);
  assert.equal(unitsText(view, item), '3 orders');
  assert.deepEqual(salesCell(view, item), ['3 orders', '€4.74', '$5.00']);
  const a = apple();
  assert.deepEqual(salesCell(a, salesByProduct(a).get('pro')), ['1 unit', '$29.99']);
});

test('no number is a dash, never a zero', () => {
  const view = base();
  assert.deepEqual(salesCell(view, undefined), ['—']);
  assert.deepEqual(salesCell(view, salesByProduct(view).get('free_thing')), ['—']);
  assert.equal(unitsText(view, undefined), '');
});

test('the tooltip says what the number is: Apple proceeds, or a Google buyer-paid estimate that is not proceeds', () => {
  assert.match(salesMeasureText(apple()), /developer proceeds/i);
  const google = salesMeasureText(base());
  assert.match(google, /buyers paid/i);
  assert.match(google, /not your proceeds/i);
  assert.match(google, /never converted/i);
});

test('sales are hidden until a sales day is stored, and the hint says how to turn them on', () => {
  assert.equal(salesVisible(null), false);
  assert.equal(salesVisible(base({ hasSalesData: false })), false);
  assert.equal(salesVisible(base()), true);
  assert.match(salesSetupHint(null, true), /vendor number/);
  assert.match(salesSetupHint(base({ enabled: false, platform: 'ios' }), true), /Turn on analytics/);
  const play = salesSetupHint(base({ hasSalesData: false }), false);
  assert.match(play, /View financial data/);
  assert.match(play, /Global/);
  assert.match(
    salesSetupHint(
      base({
        sales: {
          source: 'play_sales',
          label: '',
          state: 'needs_setup',
          setup: { code: 'bucket_id_missing', nextStep: 'set_bucket_id', optional: true, message: '' },
          lastOkAt: null,
          lastError: null,
        },
      }),
      false,
    ),
    /bucket id/,
  );
});
