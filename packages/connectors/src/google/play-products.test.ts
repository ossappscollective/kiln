import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as pf from '../store-products.fixtures.ts';
import * as fx from '../store.fixtures.ts';
import {
  PlayProductsConnector,
  parsePlayListings,
  parsePlayOneTimeProduct,
  parsePlaySubscription,
  playProductState,
} from './play-products.ts';

const key = fx.googleKeyPem();

function connector(fake: fx.FakeFetch, extra: Record<string, unknown> = {}) {
  return new PlayProductsConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: pf.PACKAGE,
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
  assert.ok(!text.includes(fx.ACCESS_TOKEN));
}

test('a product state follows its plans: active beats inactive beats draft', () => {
  assert.equal(playProductState(['DRAFT', 'ACTIVE']), 'active');
  assert.equal(playProductState(['INACTIVE', 'DRAFT']), 'inactive');
  assert.equal(playProductState(['INACTIVE_PUBLISHED']), 'inactive');
  assert.equal(playProductState(['DRAFT']), 'draft');
  assert.equal(playProductState([]), 'unknown');
});

test('listings become localizations; one without a language is left out', () => {
  assert.deepEqual(
    parsePlayListings([
      { languageCode: 'pt_BR', title: 'Olá', description: 'Texto' },
      { title: 'no language' },
      { languageCode: 'en-US', title: 'Hi' },
    ]),
    [
      { locale: 'en-US', name: 'Hi', description: '' },
      { locale: 'pt-BR', name: 'Olá', description: 'Texto' },
    ],
  );
  assert.deepEqual(parsePlayListings(undefined), []);
});

test('a subscription: base plans, regional prices in minor units, availability of the active plans', () => {
  const p = parsePlaySubscription(pf.playSubscription, [
    { id: 'trial', planId: 'monthly', state: 'ACTIVE' },
  ]);
  assert.ok(p);
  assert.equal(p.kind, 'subscription');
  assert.equal(p.state, 'active');
  assert.equal(p.rawState, 'ACTIVE,INACTIVE');
  assert.equal(p.period, 'P1M');
  assert.deepEqual(p.plans, [
    { id: 'monthly', state: 'ACTIVE', period: 'P1M' },
    { id: 'old-yearly', state: 'INACTIVE', period: 'P1Y' },
  ]);
  assert.deepEqual(p.prices, [
    { territory: 'DE', currency: 'EUR', amount: '499', planId: 'monthly' },
    { territory: 'JP', currency: 'JPY', amount: '600', planId: 'monthly' },
    { territory: 'US', currency: 'USD', amount: '499', planId: 'monthly' },
    { territory: 'US', currency: 'USD', amount: '3999', planId: 'old-yearly' },
  ]);
  assert.deepEqual(p.availability, { territories: ['DE', 'US'], availableInNewTerritories: true });
  assert.equal(p.localizations[0]?.description, 'Alles, monatlich');
  assert.deepEqual(p.offers, [{ id: 'trial', planId: 'monthly', state: 'ACTIVE' }]);
  assert.equal(parsePlaySubscription({ basePlans: [] }), undefined, 'no product id');
});

test('a one-time product: purchase options, availability, and the kind guess', () => {
  const p = parsePlayOneTimeProduct(pf.playOneTime);
  assert.ok(p);
  assert.equal(p.kind, 'consumable', 'more than one unit per checkout');
  assert.equal(p.state, 'active');
  assert.deepEqual(p.prices, [
    { territory: 'FR', currency: 'EUR', amount: '99', planId: 'buy' },
    { territory: 'US', currency: 'USD', amount: '99', planId: 'buy' },
  ]);
  assert.deepEqual(p.availability, { territories: ['US'], availableInNewTerritories: true });
  const draft = parsePlayOneTimeProduct(pf.playOneTimeSecond);
  assert.equal(draft?.kind, 'non_consumable');
  assert.equal(draft?.state, 'draft');
  assert.deepEqual(draft?.availability, { territories: [], availableInNewTerritories: null });
  const bare = parsePlayOneTimeProduct({ productId: 'x', listings: [] });
  assert.equal(bare?.availability, null);
  assert.equal(bare?.state, 'unknown');
});

test('listProducts reads subscriptions, one-time products and offers, and only reads', async () => {
  const fake = pf.playProductsFake();
  const result = await connector(fake).listProducts();
  assert.deepEqual(fake.unexpected, []);
  assert.ok(fake.calls.every((c) => c.method === 'GET' || c.url.pathname === '/token'));
  assert.equal(result.complete, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.products.map((p) => [p.productId, p.kind, p.state]),
    [
      ['coins_100', 'consumable', 'active'],
      ['premium_monthly', 'subscription', 'active'],
      ['remove_ads', 'non_consumable', 'draft'],
    ],
  );
  assert.equal(result.products[1]?.offers.length, 1);
});

test('pages are followed by their token, and a cap says so', async () => {
  const fake = new fx.FakeFetch()
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({
      method: 'GET',
      match: `${pf.SUBS}?pageSize=1`,
      json: { subscriptions: [pf.playSubscription], nextPageToken: 'p2' },
    })
    .on({
      method: 'GET',
      match: `${pf.SUBS}?pageSize=1&pageToken=p2`,
      json: { subscriptions: [{ ...pf.playSubscription, productId: 'premium_yearly' }] },
    })
    .on({ method: 'GET', match: `${pf.ONE_TIME}?pageSize=1`, json: {} })
    .on({ method: 'GET', match: `${pf.OFFERS}?pageSize=1`, json: {} });
  const result = await connector(fake, { pageSize: 1 }).listProducts();
  assert.deepEqual(
    result.products.map((p) => p.productId),
    ['premium_monthly', 'premium_yearly'],
  );
  const capped = await connector(fake, { pageSize: 1, maxPages: 1 }).listProducts();
  assert.equal(capped.complete, false);
  const few = await connector(pf.playProductsFake(), { maxProducts: 1 }).listProducts();
  assert.equal(few.products.length, 1);
  assert.equal(few.complete, false);
});

test('offers that cannot be read leave the products and add a warning; other failures fail', async () => {
  const fake = pf.playProductsFake();
  fake.clear('GET', `${pf.OFFERS}?pageSize=100`);
  fake.on({
    method: 'GET',
    match: `${pf.OFFERS}?pageSize=100`,
    status: 404,
    json: { error: { message: 'x' } },
  });
  const result = await connector(fake).listProducts();
  assert.equal(result.products.length, 3);
  assert.ok(result.warnings.some((w) => /offers/.test(w)));

  const broken = pf.playProductsFake();
  broken.clear('GET', `${pf.ONE_TIME}?pageSize=100`);
  broken.on({ method: 'GET', match: `${pf.ONE_TIME}?pageSize=100`, status: 500, json: {} });
  await assert.rejects(connector(broken).listProducts(), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'server');
    return true;
  });
});

test('a refused service account is a clear error with no secret in it', async () => {
  const fake = new fx.FakeFetch()
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({
      method: 'GET',
      match: `${pf.SUBS}?pageSize=100`,
      status: 403,
      json: { error: { code: 403, message: 'The caller does not have permission' } },
    });
  await assert.rejects(connector(fake).listProducts(), (error: unknown) => {
    assertNoSecrets(error);
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'forbidden');
    return true;
  });
});

test('a package name that is not one is refused before any call', () => {
  assert.throws(
    () => connector(new fx.FakeFetch(), { packageName: '../etc' }),
    /Not a valid Android package name/,
  );
});

test('an empty answer to a list is an empty list; one that is not JSON costs only the one-time products', async () => {
  const empty = pf.playProductsFake();
  empty.clear('GET', `${pf.ONE_TIME}?pageSize=100`);
  empty.on({ method: 'GET', match: `${pf.ONE_TIME}?pageSize=100`, raw: '' });
  const none = await connector(empty).listProducts();
  assert.equal(none.complete, true);
  assert.deepEqual(none.warnings, []);
  assert.deepEqual(
    none.products.map((p) => p.productId),
    ['premium_monthly'],
  );

  const html = pf.playProductsFake();
  html.clear('GET', `${pf.ONE_TIME}?pageSize=100`);
  html.on({
    method: 'GET',
    match: `${pf.ONE_TIME}?pageSize=100`,
    raw: '<html>blocked</html>',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const partial = await connector(html).listProducts();
  assert.equal(partial.complete, false, 'nothing may be taken to be gone');
  assert.deepEqual(
    partial.products.map((p) => p.productId),
    ['premium_monthly'],
  );
  assert.equal(partial.warnings.length, 1);
  assert.match(partial.warnings[0] ?? '', /one-time products could not be read.*\(text\/html\)/);
  assert.ok(!(partial.warnings[0] ?? '').includes('blocked'), 'the body is never quoted');

  const subs = pf.playProductsFake();
  subs.clear('GET', `${pf.SUBS}?pageSize=100`);
  subs.on({ method: 'GET', match: `${pf.SUBS}?pageSize=100`, raw: '<html>x</html>' });
  await assert.rejects(connector(subs).listProducts(), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'unexpected');
    return true;
  });
});
