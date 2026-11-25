import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import * as pf from '../store-products.fixtures.ts';
import {
  AppleProductsConnector,
  appleProductKind,
  appleProductState,
  currentApplePrices,
  mapLimit,
} from './appstore-products.ts';

const key = fx.appleKeyPem();

function connector(fake: fx.FakeFetch, extra: Record<string, unknown> = {}) {
  return new AppleProductsConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: pf.APPLE_APP,
    fetch: fake.fetch,
    now: () => pf.T0,
    sleep: async () => undefined,
    ...extra,
  });
}

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
}

test('states and kinds are mapped; an unknown one is kept as unknown', () => {
  assert.equal(appleProductState('APPROVED'), 'active');
  assert.equal(appleProductState('READY_TO_SUBMIT'), 'draft');
  assert.equal(appleProductState('MISSING_METADATA'), 'draft');
  assert.equal(appleProductState('IN_REVIEW'), 'in_review');
  assert.equal(appleProductState('REJECTED'), 'action_needed');
  assert.equal(appleProductState('DEVELOPER_REMOVED_FROM_SALE'), 'removed');
  assert.equal(appleProductState('FUTURE_STATE'), 'unknown');
  assert.equal(appleProductState(undefined), 'unknown');
  assert.equal(appleProductKind('CONSUMABLE'), 'consumable');
  assert.equal(appleProductKind('NON_CONSUMABLE'), 'non_consumable');
  assert.equal(appleProductKind('NON_RENEWING_SUBSCRIPTION'), 'subscription');
  assert.equal(appleProductKind('NEW_KIND'), undefined);
});

test('the price in force: not a future one, manual before automatic, the latest start', () => {
  const row = (over: Partial<Parameters<typeof currentApplePrices>[0][number]>) => ({
    territory: 'DEU',
    currency: 'EUR',
    amount: '109',
    planId: null,
    startMs: null,
    endMs: null,
    manual: false,
    ...over,
  });
  const now = Date.UTC(2026, 0, 1);
  assert.deepEqual(
    currentApplePrices(
      [
        row({ amount: '1' }),
        row({ amount: '2', startMs: now + 1 }),
        row({ amount: '3', startMs: now - 10 }),
        row({ amount: '4', endMs: now - 1 }),
      ],
      now,
    ).map((p) => p.amount),
    ['3'],
  );
  assert.equal(
    currentApplePrices(
      [row({ amount: '1', manual: true }), row({ amount: '2', startMs: now - 5 })],
      now,
    )[0]?.amount,
    '1',
  );
  assert.deepEqual(currentApplePrices([row({ startMs: now + 5 })], now), []);
});

test('mapLimit runs at most N at once, keeps order and stops at the first failure', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2);
  await assert.rejects(
    mapLimit([1, 2, 3], 1, async (n) => {
      if (n === 2) throw new Error('stop');
      return n;
    }),
    /stop/,
  );
});

test('listProducts reads in-app purchases and subscriptions, with prices, texts and territories', async () => {
  const fake = pf.appleProductsFake();
  const result = await connector(fake).listProducts();
  assert.deepEqual(fake.unexpected, []);
  assert.ok(
    fake.calls.every((c) => c.method === 'GET'),
    'reading never writes',
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.products.map((p) => [p.productId, p.kind, p.state]),
    [
      ['coins_100', 'consumable', 'active'],
      ['premium_monthly', 'subscription', 'active'],
      ['pro_unlock', 'non_consumable', 'draft'],
    ],
  );
  const coins = result.products[0];
  assert.ok(coins);
  assert.equal(coins.storeRef, 'iap-1');
  assert.equal(coins.referenceName, '100 coins');
  assert.equal(coins.rawState, 'APPROVED');
  assert.deepEqual(coins.localizations, [
    { locale: 'de-DE', name: '100 Münzen', description: 'Ein kleiner Beutel Münzen', ref: 'loc-2' },
    { locale: 'en-US', name: '100 coins', description: 'A small bag of coins', ref: 'loc-1' },
  ]);
  assert.deepEqual(coins.prices, [
    { territory: 'DEU', currency: 'EUR', amount: '109', planId: null },
    { territory: 'JPN', currency: 'JPY', amount: '150', planId: null },
    { territory: 'USA', currency: 'USD', amount: '99', planId: null },
  ]);
  assert.equal(coins.baseTerritory, 'USA');
  assert.deepEqual(coins.availability, {
    territories: ['DEU', 'JPN', 'USA'],
    availableInNewTerritories: true,
  });

  const sub = result.products[1];
  assert.ok(sub);
  assert.equal(sub.group, 'Premium');
  assert.equal(sub.period, 'ONE_MONTH');
  assert.deepEqual(sub.prices, [
    { territory: 'USA', currency: 'USD', amount: '499', planId: 'MONTHLY' },
  ]);
  assert.deepEqual(sub.availability, {
    territories: ['FRA', 'USA'],
    availableInNewTerritories: false,
  });
  assert.equal(sub.localizations.length, 2);

  const pro = result.products[2];
  assert.ok(pro);
  assert.deepEqual(pro.prices, []);
  assert.equal(pro.availability, null);
  assert.ok(result.warnings.some((w) => /pro_unlock: .*no price schedule/.test(w)));
  assert.ok(result.warnings.some((w) => /pro_unlock: .*no availability/.test(w)));
  assert.ok(result.warnings.some((w) => /mystery: .*does not know/.test(w)));
  // The credential never travels in a URL.
  for (const call of fake.calls) assert.ok(!call.url.search.includes('PRIVATE'));
});

test('the paging link of a list is followed, but never to another host', async () => {
  const fake = pf.appleProductsFake();
  fake.clear('GET', new RegExp(`^${pf.IAPS_PATH}\\?`) as unknown as string);
  fake
    .on({
      method: 'GET',
      match: new RegExp(`^${pf.IAPS_PATH}\\?limit=200`),
      json: {
        ...pf.appleIapList(),
        links: { next: `${fx.APPLE_BASE}${pf.IAPS_PATH}?cursor=abc&limit=200` },
      },
      times: 1,
    })
    .on({
      method: 'GET',
      match: new RegExp(`^${pf.IAPS_PATH}\\?cursor=abc`),
      json: {
        data: [pf.appleIap('iap-9', 'extra_pack', 'CONSUMABLE', 'APPROVED', [])],
        included: [],
      },
    })
    .on({ method: 'GET', match: /^\/v2\/inAppPurchases\/iap-9\/.*/, status: 404, json: {} });
  const result = await connector(fake).listProducts();
  assert.ok(result.products.some((p) => p.productId === 'extra_pack'));

  const evil = pf.appleProductsFake();
  evil.clear('GET', new RegExp(`^${pf.IAPS_PATH}\\?`) as unknown as string);
  evil.on({
    method: 'GET',
    match: new RegExp(`^${pf.IAPS_PATH}\\?`),
    json: { ...pf.appleIapList(), links: { next: 'https://evil.example/steal?cursor=1' } },
  });
  await assert.rejects(connector(evil).listProducts(), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.match(error.message, /another host/);
    return true;
  });
  assert.ok(
    evil.calls.every((c) => c.url.host !== 'evil.example'),
    'the token was not sent to another host',
  );
});

test('a cap on the number of products says so', async () => {
  const fake = pf.appleProductsFake();
  const result = await connector(fake, { maxProducts: 2 }).listProducts();
  assert.equal(result.complete, false);
  assert.equal(result.products.length, 2);
  assert.ok(result.warnings.some((w) => /first 2 products/.test(w)));
});

test('a refused key is a clear error that holds no secret; a rate limit carries the wait', async () => {
  const denied = new fx.FakeFetch().on({
    method: 'GET',
    match: new RegExp(`^${pf.IAPS_PATH}\\?`),
    status: 403,
    json: { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'Forbidden' }] },
  });
  await assert.rejects(connector(denied).listProducts(), (error: unknown) => {
    assertNoSecrets(error);
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'forbidden');
    return true;
  });
  const limited = new fx.FakeFetch().on({
    method: 'GET',
    match: new RegExp(`^${pf.IAPS_PATH}\\?`),
    status: 429,
    headers: { 'retry-after': '3000' },
    json: {},
  });
  await assert.rejects(
    connector(limited, { maxRateLimitRetries: 0 }).listProducts(),
    (error: unknown) => {
      assert.ok(error instanceof StoreRateLimitError);
      return true;
    },
  );
});

test('a failure in the middle fails the read: a half snapshot never replaces a good one', async () => {
  const fake = pf.appleProductsFake();
  fake.clear(
    'GET',
    /^\/v1\/inAppPurchasePriceSchedules\/ps-1\/manualPrices\?/ as unknown as string,
  );
  fake.on({
    method: 'GET',
    match: /^\/v1\/inAppPurchasePriceSchedules\/ps-1\/manualPrices\?/,
    status: 500,
    json: {},
  });
  await assert.rejects(connector(fake).listProducts(), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'server');
    return true;
  });
});

test('the App Store id must be a number', () => {
  assert.throws(
    () =>
      new AppleProductsConnector({
        credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
        appStoreId: '../x',
        fetch: new fx.FakeFetch().fetch,
      }),
    /App Store id/,
  );
});
