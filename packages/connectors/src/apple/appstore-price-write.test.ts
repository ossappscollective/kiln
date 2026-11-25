import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PriceChange } from '@kiln/core';
import * as fx from '../store.fixtures.ts';
import { PriceDriftError, priceMismatches } from '../store-price-types.ts';
import * as pf from '../store-products.fixtures.ts';
import type { StoreProductRef } from '../store-products-types.ts';
import { AppleProductPriceConnector } from './appstore-price-write.ts';

const key = fx.appleKeyPem();
const SUB: StoreProductRef = {
  productId: 'premium_monthly',
  kind: 'subscription',
  storeRef: 's-1',
};
const IAP: StoreProductRef = { productId: 'coins_100', kind: 'consumable', storeRef: 'iap-1' };
const link = (id: string, type: string) => ({ type, id });
const SUB_PRICES = /^\/v1\/subscriptions\/s-1\/prices\?/;
const change = (over: Partial<PriceChange> = {}): PriceChange => ({
  store: 'appstoreconnect',
  productId: 'premium_monthly',
  kind: 'subscription',
  planId: 'MONTHLY',
  baseTerritory: 'USA',
  lines: [
    {
      territory: 'USA',
      currency: 'USD',
      currentAmount: '499',
      newAmount: '599',
      pricePointId: 'spp-599',
    },
  ],
  effectiveDate: '2026-12-01',
  existingSubscribers: 'preserve',
  acknowledgements: [],
  ...over,
});
const subPricesAfter = {
  data: [
    ...pf.appleSubPrices.data,
    {
      type: 'subscriptionPrices',
      id: 'sp-new',
      attributes: { startDate: '2026-12-01', preserved: false, planType: 'MONTHLY' },
      relationships: {
        territory: { data: link('USA', 'territories') },
        subscriptionPricePoint: { data: link('spp-599', 'subscriptionPricePoints') },
      },
    },
  ],
  included: [
    ...pf.appleSubPrices.included,
    { type: 'subscriptionPricePoints', id: 'spp-599', attributes: { customerPrice: '5.99' } },
  ],
};

function setup() {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'GET', match: SUB_PRICES, json: pf.appleSubPrices });
  const connector = new AppleProductPriceConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    now: () => pf.T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}
const accept = () => true;
const posts = (fake: fx.FakeFetch, m: string | RegExp) => fake.called('POST', m);

test('readPrices: the price in force, scheduled prices apart, preserved rows ignored', async () => {
  const { fake, connector } = setup();
  fake.clear('GET', SUB_PRICES).on({ method: 'GET', match: SUB_PRICES, json: subPricesAfter });
  const live = await connector.readPrices(SUB, 'MONTHLY');
  assert.deepEqual(live.current, [{ territory: 'USA', currency: 'USD', amount: '499' }]);
  assert.deepEqual(
    live.scheduled.map((s) => [s.territory, s.amount, s.startDate]),
    [['USA', '599', '2026-12-01']],
  );
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
});

test('pricePoints: customer prices as minor units per territory', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: /^\/v1\/subscriptions\/s-1\/pricePoints\?filter\[territory\]=USA/,
    json: {
      data: [
        { type: 'subscriptionPricePoints', id: 'spp-599', attributes: { customerPrice: '5.99' } },
      ],
      included: [{ type: 'territories', id: 'USA', attributes: { currency: 'USD' } }],
    },
  });
  assert.deepEqual(await connector.pricePoints(SUB, ['USA', 'bad']), [
    { id: 'spp-599', territory: 'USA', currency: 'USD', amount: '599' },
  ]);
});

test('apply (subscription): one POST per territory, preserve for an increase, then it reads back', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'POST',
    match: '/v1/subscriptionPrices',
    status: 201,
    json: { data: { type: 'subscriptionPrices', id: 'sp-new' } },
  });
  const result = await connector.apply(SUB, change(), accept, pf.T0);
  assert.deepEqual(result.lines, [{ territory: 'USA', outcome: 'applied' }]);
  const sent = JSON.parse(posts(fake, '/v1/subscriptionPrices')[0]?.body ?? '{}');
  assert.deepEqual(sent.data.attributes, {
    startDate: '2026-12-01',
    preserveCurrentPrice: true,
    planType: 'MONTHLY',
  });
  assert.equal(sent.data.relationships.subscriptionPricePoint.data.id, 'spp-599');
  assert.equal(sent.data.relationships.subscription.data.id, 's-1');
});

test('apply: a decrease or "apply to existing subscribers" never sends preserveCurrentPrice; startDate null is immediate', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'POST',
    match: '/v1/subscriptionPrices',
    status: 201,
    json: { data: { id: 'x' } },
  });
  await connector.apply(
    SUB,
    change({
      effectiveDate: null,
      existingSubscribers: 'apply',
      acknowledgements: ['existing_subscribers'],
    }),
    accept,
    pf.T0,
  );
  const sent = JSON.parse(posts(fake, '/v1/subscriptionPrices')[0]?.body ?? '{}');
  assert.deepEqual(sent.data.attributes, { startDate: null, planType: 'MONTHLY' });
});

test('apply is idempotent: what the store already has is not sent again', async () => {
  const { fake, connector } = setup();
  fake.clear('GET', SUB_PRICES).on({ method: 'GET', match: SUB_PRICES, json: subPricesAfter });
  const result = await connector.apply(SUB, change(), accept, pf.T0);
  assert.deepEqual(result.lines, [{ territory: 'USA', outcome: 'already_applied' }]);
  assert.equal(posts(fake, '/v1/subscriptionPrices').length, 0);
});

test('apply never deletes: a different scheduled price is a refusal with the code, nothing is sent', async () => {
  const { fake, connector } = setup();
  const other = {
    ...subPricesAfter,
    included: subPricesAfter.included.map((i) =>
      i.id === 'spp-599' ? { ...i, attributes: { customerPrice: '6.99' } } : i,
    ),
  };
  fake.clear('GET', SUB_PRICES).on({ method: 'GET', match: SUB_PRICES, json: other });
  const result = await connector.apply(SUB, change(), accept, pf.T0);
  assert.equal(result.lines[0]?.outcome, 'failed');
  assert.equal(result.lines[0]?.code, 'price_change_not_allowed');
  assert.equal(fake.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('apply: the guard sees the LIVE prices; false writes nothing', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.apply(SUB, change(), (live) => live.current[0]?.amount === '399', pf.T0),
    PriceDriftError,
  );
  assert.equal(fake.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('apply: one territory refused (409, unsupported), another still goes; a 429 stops the rest; a 500 is unknown', async () => {
  const { fake, connector } = setup();
  const two = change({
    lines: [
      {
        territory: 'CAN',
        currency: 'CAD',
        currentAmount: '499',
        newAmount: '699',
        pricePointId: 'c',
      },
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '499',
        newAmount: '599',
        pricePointId: 'spp-599',
      },
      {
        territory: 'ZZZ',
        currency: 'USD',
        currentAmount: '499',
        newAmount: '599',
        pricePointId: 'z',
      },
    ],
  });
  fake
    .on({
      method: 'POST',
      match: '/v1/subscriptionPrices',
      status: 422,
      times: 1,
      json: {
        errors: [
          {
            code: 'UNSUPPORTED_TERRITORY',
            title: 'Territory',
            detail: 'The subscription is not available in this territory.',
          },
        ],
      },
    })
    .on({
      method: 'POST',
      match: '/v1/subscriptionPrices',
      status: 429,
      times: 1,
      headers: { 'retry-after': '30' },
      json: { errors: [{ code: 'RATE_LIMIT', title: 'slow down' }] },
    });
  const result = await connector.apply(SUB, two, accept, pf.T0);
  assert.deepEqual(
    result.lines.map((l) => [l.territory, l.outcome, l.code]),
    [
      ['CAN', 'failed', 'unsupported_territory'],
      ['USA', 'failed', 'rate_limited'],
      ['ZZZ', 'not_sent', undefined],
    ],
  );
  const f2 = setup();
  f2.fake.on({ method: 'POST', match: '/v1/subscriptionPrices', status: 500, json: {} });
  const r2 = await f2.connector.apply(SUB, change(), accept, pf.T0);
  assert.equal(r2.lines[0]?.outcome, 'unknown');
  for (const l of [...result.lines, ...r2.lines])
    assert.ok(!/PRIVATE KEY|eyJ[A-Za-z0-9_-]{8,}\./.test(l.message ?? ''));
});

test('preview (subscription): the store validates and saves nothing; a decrease is not preservable', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'POST',
    match: '/v1/subscriptionPriceChangePreviews',
    status: 200,
    json: {
      data: {
        type: 'subscriptionPriceChangePreviews',
        attributes: {
          changeResults: [{ territoryId: 'USA', changeType: 'DECREASE_NOT_PRESERVABLE' }],
        },
      },
    },
  });
  const preview = await connector.preview(SUB, change(), pf.T0);
  assert.equal(preview.mode, 'store');
  assert.deepEqual(preview.lines, [
    { territory: 'USA', changeType: 'DECREASE_NOT_PRESERVABLE', note: 'not_preservable' },
  ]);
  const sent = JSON.parse(posts(fake, /Previews/)[0]?.body ?? '{}');
  assert.deepEqual(sent.data.attributes.proposedChanges, [
    { territoryId: 'USA', startDate: '2026-12-01', basePricePointId: 'spp-599' },
  ]);
});

const iapSchedule = pf.appleSchedule('ps-1', 'USA');
function iapSetup() {
  const s = setup();
  s.fake
    .on({
      method: 'GET',
      match: /^\/v2\/inAppPurchases\/iap-1\/iapPriceSchedule/,
      json: iapSchedule,
    })
    .on({
      method: 'GET',
      match: /^\/v1\/inAppPurchasePriceSchedules\/ps-1\/manualPrices/,
      json: pf.appleManualPrices,
    })
    .on({
      method: 'GET',
      match: /^\/v1\/inAppPurchasePriceSchedules\/ps-1\/automaticPrices/,
      json: pf.appleAutomaticPrices,
    });
  return s;
}
const iapChange = (over: Partial<PriceChange> = {}): PriceChange => ({
  store: 'appstoreconnect',
  productId: 'coins_100',
  kind: 'consumable',
  planId: null,
  baseTerritory: 'USA',
  lines: [
    {
      territory: 'JPN',
      currency: 'JPY',
      currentAmount: '150',
      newAmount: '180',
      pricePointId: 'pp-jpn-180',
    },
  ],
  effectiveDate: null,
  existingSubscribers: 'not_applicable',
  acknowledgements: [],
  ...over,
});

test('apply (in-app purchase): one schedule that keeps every other manual price unchanged', async () => {
  const { fake, connector } = iapSetup();
  fake.on({
    method: 'POST',
    match: '/v1/inAppPurchasePriceSchedules',
    status: 201,
    json: { data: { id: 'ps-2' } },
  });
  const result = await connector.apply(IAP, iapChange(), accept, pf.T0);
  assert.deepEqual(result.lines, [{ territory: 'JPN', outcome: 'applied' }]);
  const sent = JSON.parse(posts(fake, '/v1/inAppPurchasePriceSchedules')[0]?.body ?? '{}');
  assert.equal(sent.data.relationships.baseTerritory.data.id, 'USA');
  assert.deepEqual(
    sent.included.map(
      (i: { relationships: { inAppPurchasePricePoint: { data: { id: string } } } }) =>
        i.relationships.inAppPurchasePricePoint.data.id,
    ),
    ['pp-usa', 'pp-jpn-180'],
  );
});

test('apply (in-app purchase): a territory with a price already scheduled is refused', async () => {
  const { fake, connector } = iapSetup();
  const result = await connector.apply(
    IAP,
    iapChange({
      lines: [
        {
          territory: 'DEU',
          currency: 'EUR',
          currentAmount: '109',
          newAmount: '129',
          pricePointId: 'x',
        },
      ],
    }),
    accept,
    pf.T0,
  );
  assert.equal(result.lines[0]?.code, 'price_change_not_allowed');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('apply (in-app purchase): changing the base territory alone is refused, it would move every equalized territory', async () => {
  const { fake, connector } = iapSetup();
  const base = iapChange({
    lines: [
      {
        territory: 'USA',
        currency: 'USD',
        currentAmount: '99',
        newAmount: '199',
        pricePointId: 'pp-usa-199',
      },
    ],
  });
  const result = await connector.apply(IAP, base, accept, pf.T0);
  assert.equal(result.lines[0]?.code, 'price_change_not_allowed');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
  const prev = await connector.preview(IAP, iapChange(), pf.T0);
  assert.equal(prev.mode, 'local');
  assert.equal(prev.requests[0]?.path, '/v1/inAppPurchasePriceSchedules');
});

test('priceMismatches: current for an immediate or past date, scheduled for a future one', () => {
  const live = {
    current: [{ territory: 'USA', currency: 'USD', amount: '499' }],
    scheduled: [{ territory: 'USA', currency: 'USD', amount: '599', startDate: '2026-12-01' }],
  };
  assert.deepEqual(priceMismatches(change(), live, '2026-11-24'), []);
  assert.deepEqual(priceMismatches(change({ effectiveDate: null }), live, '2026-11-24'), [
    { territory: 'USA', expected: '599', actual: '499' },
  ]);
  assert.equal(priceMismatches(change(), { ...live, scheduled: [] }, '2026-11-24').length, 1);
});
