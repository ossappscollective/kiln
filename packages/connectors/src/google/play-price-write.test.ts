import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PriceChange } from '@kiln/core';
import { PriceDriftError } from '../store-price-types.ts';
import * as pf from '../store-products.fixtures.ts';
import type { StoreProductRef } from '../store-products-types.ts';
import * as fx from '../store.fixtures.ts';
import { PlayProductPriceConnector } from './play-price-write.ts';

const key = fx.googleKeyPem();
const SUB: StoreProductRef = { productId: 'premium_monthly', kind: 'subscription', storeRef: null };
const ONE: StoreProductRef = { productId: 'coins_100', kind: 'consumable', storeRef: null };
const SUB_PATH = `${pf.SUBS}/premium_monthly`;
const SUB_PATCH = /^\/androidpublisher\/v3\/applications\/[^/]+\/subscriptions\/premium_monthly\?/;
const ONE_PATCH = /^\/androidpublisher\/v3\/applications\/[^/]+\/onetimeproducts\/coins_100\?/;
const MIGRATE = `${SUB_PATH}/basePlans/monthly:migratePrices`;
const CONVERT = `/androidpublisher/v3/applications/${pf.PACKAGE}/pricing:convertRegionPrices`;
const accept = () => true;
const change = (over: Partial<PriceChange> = {}): PriceChange => ({
  store: 'googleplay',
  productId: 'premium_monthly',
  kind: 'subscription',
  planId: 'monthly',
  baseTerritory: null,
  lines: [{ territory: 'US', currency: 'USD', currentAmount: '499', newAmount: '599' }],
  effectiveDate: null,
  existingSubscribers: 'preserve',
  acknowledgements: [],
  ...over,
});

function setup() {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({ method: 'GET', match: SUB_PATH, json: pf.playSubscription })
    .on({ method: 'GET', match: `${pf.ONE_TIME}/coins_100`, json: pf.playOneTime })
    .on({
      method: 'POST',
      match: CONVERT,
      json: {
        convertedRegionPrices: {
          DE: { regionCode: 'DE', price: pf.money('EUR', '5', 990_000_000) },
          JP: { regionCode: 'JP', price: pf.money('JPY', '800') },
        },
        regionVersion: { version: '2025/03' },
      },
    });
  const connector = new PlayProductPriceConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: pf.PACKAGE,
    fetch: fake.fetch,
    now: () => pf.T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}
const sentBody = (fake: fx.FakeFetch, method: string, m: string | RegExp) =>
  JSON.parse(fake.called(method, m)[0]?.body ?? '{}');

test("readPrices: the plan's regional prices only; convertFromBase derives regions from one price and changes nothing", async () => {
  const { fake, connector } = setup();
  const live = await connector.readPrices(SUB, 'monthly');
  assert.deepEqual(
    live.current.map((p) => [p.territory, p.amount]),
    [
      ['DE', '499'],
      ['JP', '600'],
      ['US', '499'],
    ],
  );
  assert.deepEqual(live.scheduled, []);
  assert.deepEqual(await connector.convertFromBase({ currency: 'USD', amount: '499' }), {
    prices: [
      { territory: 'DE', currency: 'EUR', amount: '599' },
      { territory: 'JP', currency: 'JPY', amount: '800' },
    ],
    regionsVersion: '2025/03',
  });
  assert.deepEqual(sentBody(fake, 'POST', CONVERT).price, {
    currencyCode: 'USD',
    units: '4',
    nanos: 990000000,
  });
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('apply (subscription): patches basePlans with one price replaced and everything else as read; preserve means no migration', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'PATCH', match: SUB_PATCH, json: pf.playSubscription });
  const result = await connector.apply(SUB, change(), accept, pf.T0);
  assert.deepEqual(result.lines, [{ territory: 'US', outcome: 'applied' }]);
  assert.equal(result.migration, undefined);
  const call = fake.called('PATCH', SUB_PATCH)[0];
  assert.ok(
    call?.url.search.includes('updateMask=basePlans') &&
      call.url.search.includes('regionsVersion.version=2025%2F03') &&
      !call.url.search.includes('allowMissing'),
  );
  const body = sentBody(fake, 'PATCH', SUB_PATCH);
  assert.deepEqual(Object.keys(body), ['basePlans']);
  const monthly = body.basePlans.find((p: { basePlanId: string }) => p.basePlanId === 'monthly');
  assert.deepEqual(
    monthly.regionalConfigs.map((c: { regionCode: string; price: unknown }) => [
      c.regionCode,
      c.price,
    ]),
    [
      ['US', { currencyCode: 'USD', units: '5', nanos: 990000000 }],
      ['DE', { currencyCode: 'EUR', units: '4', nanos: 990000000 }],
      ['JP', { currencyCode: 'JPY', units: '600', nanos: 0 }],
    ],
  );
  assert.deepEqual(
    body.basePlans.find((p: { basePlanId: string }) => p.basePlanId === 'old-yearly'),
    pf.playSubscription.basePlans[1],
  );
  assert.equal(fake.called('POST', MIGRATE).length, 0);
});

test('apply (subscription): moving existing subscribers is a second, explicit call with the opt-in or opt-out type, increases only', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'PATCH', match: SUB_PATCH, json: pf.playSubscription })
    .on({ method: 'POST', match: MIGRATE, json: {} });
  const two = change({
    existingSubscribers: 'opt_out',
    acknowledgements: ['existing_subscribers'],
    lines: [
      { territory: 'US', currency: 'USD', currentAmount: '499', newAmount: '599' },
      { territory: 'DE', currency: 'EUR', currentAmount: '499', newAmount: '399' },
    ],
  });
  const result = await connector.apply(SUB, two, accept, pf.T0);
  assert.deepEqual(result.migration, { requested: true, outcome: 'applied' });
  const body = sentBody(fake, 'POST', MIGRATE);
  assert.equal(body.regionsVersion.version, '2025/03');
  assert.deepEqual(
    body.regionalPriceMigrations.map((m: { regionCode: string; priceIncreaseType?: string }) => [
      m.regionCode,
      m.priceIncreaseType,
    ]),
    [
      ['US', 'PRICE_INCREASE_TYPE_OPT_OUT'],
      ['DE', undefined],
    ],
  );
  assert.equal(
    body.regionalPriceMigrations[0].oldestAllowedPriceVersionTime,
    '2026-11-20T12:00:00.000Z',
  );
});

test('apply: idempotent, a region the plan lacks is refused, drift writes nothing', async () => {
  const { fake, connector } = setup();
  const same = await connector.apply(
    SUB,
    change({
      lines: [{ territory: 'US', currency: 'USD', currentAmount: '499', newAmount: '499' }],
    }),
    accept,
    pf.T0,
  );
  assert.deepEqual(same.lines, [{ territory: 'US', outcome: 'already_applied' }]);
  const gone = await connector.apply(
    SUB,
    change({
      lines: [
        { territory: 'FR', currency: 'EUR', currentAmount: '499', newAmount: '599' },
        { territory: 'US', currency: 'USD', currentAmount: '499', newAmount: '599' },
      ],
    }),
    accept,
    pf.T0,
  );
  assert.deepEqual(
    gone.lines.map((l) => [l.territory, l.outcome, l.code]),
    [
      ['FR', 'failed', 'unsupported_territory'],
      ['US', 'not_sent', undefined],
    ],
  );
  await assert.rejects(
    connector.apply(SUB, change(), () => false, pf.T0),
    PriceDriftError,
  );
  assert.equal(
    fake.calls.filter(
      (c) => c.method !== 'GET' && !/convertRegionPrices|token/.test(c.url.pathname),
    ).length,
    0,
  );
});

test('apply: a store refusal is a code, a lost answer is unknown and sends no migration', async () => {
  const a = setup();
  a.fake.on({
    method: 'PATCH',
    match: SUB_PATCH,
    status: 400,
    json: {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Price is below the minimum for this region.',
      },
    },
  });
  const refused = await a.connector.apply(SUB, change(), accept, pf.T0);
  assert.equal(refused.lines[0]?.outcome, 'failed');
  assert.ok(['rejected', 'unsupported_territory'].includes(refused.lines[0]?.code ?? ''));
  const b = setup();
  b.fake.on({ method: 'PATCH', match: SUB_PATCH, status: 503, json: {} });
  const lost = await b.connector.apply(
    SUB,
    change({ existingSubscribers: 'opt_in', acknowledgements: ['existing_subscribers'] }),
    accept,
    pf.T0,
  );
  assert.equal(lost.lines[0]?.outcome, 'unknown');
  assert.deepEqual(lost.migration, { requested: true, outcome: 'not_sent' });
  assert.equal(b.fake.called('POST', MIGRATE).length, 0);
  for (const l of [...refused.lines, ...lost.lines])
    assert.ok(!/PRIVATE KEY|eyJ[A-Za-z0-9_-]{8,}\./.test(l.message ?? ''));
});

test("apply (one-time product): purchaseOptions with the product's own regionsVersion", async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'PATCH', match: ONE_PATCH, json: pf.playOneTime });
  const c = change({
    productId: 'coins_100',
    kind: 'consumable',
    planId: 'buy',
    lines: [{ territory: 'US', currency: 'USD', currentAmount: '99', newAmount: '149' }],
  });
  const result = await connector.apply(ONE, c, accept, pf.T0);
  assert.deepEqual(result.lines, [{ territory: 'US', outcome: 'applied' }]);
  const call = fake.called('PATCH', ONE_PATCH)[0];
  assert.ok(
    call?.url.search.includes('updateMask=purchaseOptions') &&
      call.url.search.includes('regionsVersion.version=2022%2F02'),
  );
  const body = sentBody(fake, 'PATCH', ONE_PATCH);
  assert.deepEqual(body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0].price, {
    currencyCode: 'USD',
    units: '1',
    nanos: 490000000,
  });
  assert.equal(
    body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0].availability,
    'AVAILABLE',
  );
});

test('preview: Play has no validation call, so it lists what would be sent', async () => {
  const { connector } = setup();
  const p = await connector.preview(
    SUB,
    change({ existingSubscribers: 'opt_in', acknowledgements: ['existing_subscribers'] }),
  );
  assert.equal(p.mode, 'local');
  assert.deepEqual(
    p.requests.map((r) => r.method),
    ['PATCH', 'POST'],
  );
});
