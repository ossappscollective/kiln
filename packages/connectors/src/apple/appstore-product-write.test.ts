import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as pf from '../store-products.fixtures.ts';
import {
  localizationHash,
  ProductLocaleMissingError,
  ProductLocalizationDriftError,
  ProductMissingError,
  ProductOutcomeUnknownError,
  type StoreProductRef,
} from '../store-products-types.ts';
import * as fx from '../store.fixtures.ts';
import { AppleProductWriteConnector } from './appstore-product-write.ts';

const key = fx.appleKeyPem();
const IAP: StoreProductRef = { productId: 'coins_100', kind: 'consumable', storeRef: 'iap-1' };
const SUB: StoreProductRef = { productId: 'premium_monthly', kind: 'subscription', storeRef: 's-1' };

const iapRead = {
  data: pf.appleIap('iap-1', 'coins_100', 'CONSUMABLE', 'APPROVED', ['loc-1', 'loc-2']),
  included: [
    pf.appleIapLocalization('loc-1', 'en-US', '100 coins', 'A small bag of coins'),
    pf.appleIapLocalization('loc-2', 'de-DE', '100 Münzen', 'Ein kleiner Beutel'),
  ],
};
const subRead = {
  data: { type: 'subscriptions', id: 's-1', attributes: { productId: 'premium_monthly' }, relationships: { subscriptionLocalizations: { data: [{ type: 'subscriptionLocalizations', id: 'sl-1' }] } } },
  included: [pf.appleSubLocalization('sl-1', 'en-US', 'Premium', 'Everything, monthly')],
};

function setup() {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'GET', match: /^\/v2\/inAppPurchases\/iap-1\?include=inAppPurchaseLocalizations/, json: iapRead })
    .on({ method: 'GET', match: /^\/v1\/subscriptions\/s-1\?include=subscriptionLocalizations/, json: subRead })
    .on({
      method: 'PATCH',
      match: '/v2/inAppPurchaseLocalizations/loc-1',
      json: { data: { type: 'inAppPurchaseLocalizations', id: 'loc-1', attributes: { locale: 'en-US', name: 'New name', description: 'New text' } } },
    })
    .on({
      method: 'PATCH',
      match: '/v2/subscriptionLocalizations/sl-1',
      json: { data: { type: 'subscriptionLocalizations', id: 'sl-1', attributes: { name: 'Premium+', description: 'Better' } } },
    });
  const connector = new AppleProductWriteConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    now: () => pf.T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}
const accept = () => true;

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
}

test('readLocalization finds one locale of an in-app purchase or a subscription, and changes nothing', async () => {
  const { fake, connector } = setup();
  assert.deepEqual(await connector.readLocalization(IAP, 'de-de'), {
    locale: 'de-DE',
    name: '100 Münzen',
    description: 'Ein kleiner Beutel',
    ref: 'loc-2',
  });
  assert.equal(await connector.readLocalization(IAP, 'fr-FR'), undefined);
  assert.equal((await connector.readLocalization(SUB, 'en-US'))?.ref, 'sl-1');
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
  await assert.rejects(
    connector.readLocalization({ ...IAP, storeRef: null }, 'en-US'),
    /Sync the app first/,
  );
});

test('updateLocalization reads the live texts, checks the guard, then patches one localization', async () => {
  const { fake, connector } = setup();
  let seen: unknown;
  const result = await connector.updateLocalization({
    product: IAP,
    locale: 'en-US',
    name: 'New name',
    description: 'New text',
    guard: (current) => {
      seen = current;
      return localizationHash(current.name, current.description) === localizationHash('100 coins', 'A small bag of coins');
    },
  });
  assert.deepEqual(seen, { locale: 'en-US', name: '100 coins', description: 'A small bag of coins', ref: 'loc-1' });
  assert.equal(result.before.name, '100 coins');
  assert.equal(result.after.name, 'New name');
  const writes = fake.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.method, 'PATCH');
  assert.equal(writes[0]?.url.pathname, '/v2/inAppPurchaseLocalizations/loc-1');
  assert.deepEqual(JSON.parse(writes[0]?.body ?? '{}'), {
    data: {
      type: 'inAppPurchaseLocalizations',
      id: 'loc-1',
      attributes: { name: 'New name', description: 'New text' },
    },
  });
  assert.deepEqual(fake.unexpected, []);
});

test('a subscription localization goes to the subscription endpoint', async () => {
  const { fake, connector } = setup();
  const result = await connector.updateLocalization({
    product: SUB,
    locale: 'en-US',
    name: 'Premium+',
    description: 'Better',
    guard: accept,
  });
  assert.equal(result.after.name, 'Premium+');
  const patch = fake.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch?.url.pathname, '/v2/subscriptionLocalizations/sl-1');
  assert.equal(JSON.parse(patch?.body ?? '{}').data.type, 'subscriptionLocalizations');
});

test('a guard that says no writes nothing and returns the live texts', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.updateLocalization({ product: IAP, locale: 'en-US', name: 'x', description: 'y', guard: () => false }),
    (error: unknown) => {
      assert.ok(error instanceof ProductLocalizationDriftError);
      assert.equal(error.current.name, '100 coins');
      return true;
    },
  );
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
});

test('a locale the product does not have, and a product Apple does not have, write nothing', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.updateLocalization({ product: IAP, locale: 'fr-FR', name: 'x', description: 'y', guard: accept }),
    ProductLocaleMissingError,
  );
  fake.clear('GET', /^\/v2\/inAppPurchases\/iap-1\?include=inAppPurchaseLocalizations/ as unknown as string);
  fake.on({ method: 'GET', match: /^\/v2\/inAppPurchases\/iap-1\?/, status: 404, json: { errors: [] } });
  await assert.rejects(
    connector.updateLocalization({ product: IAP, locale: 'en-US', name: 'x', description: 'y', guard: accept }),
    ProductMissingError,
  );
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
});

test('a refusal (409) is a plain error, nothing is retried and no secret is in it', async () => {
  const { fake, connector } = setup();
  fake.clear('PATCH', '/v2/inAppPurchaseLocalizations/loc-1');
  fake.on({
    method: 'PATCH',
    match: '/v2/inAppPurchaseLocalizations/loc-1',
    status: 409,
    json: { errors: [{ status: '409', code: 'STATE_ERROR', title: 'Not editable', detail: 'The product is in review.' }] },
  });
  await assert.rejects(
    connector.updateLocalization({ product: IAP, locale: 'en-US', name: 'x', description: 'y', guard: accept }),
    (error: unknown) => {
      assertNoSecrets(error);
      assert.ok(error instanceof StoreError);
      assert.ok(!(error instanceof ProductOutcomeUnknownError));
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('a 5xx or a cut connection on the write is an unknown outcome and is never sent again', async () => {
  for (const mode of ['5xx', 'cut', '429'] as const) {
    const { fake, connector } = setup();
    fake.clear('PATCH', '/v2/inAppPurchaseLocalizations/loc-1');
    fake.on(
      mode === 'cut'
        ? { method: 'PATCH', match: '/v2/inAppPurchaseLocalizations/loc-1', throws: new TypeError('fetch failed') }
        : { method: 'PATCH', match: '/v2/inAppPurchaseLocalizations/loc-1', status: mode === '5xx' ? 503 : 429, headers: { 'retry-after': '1' }, json: {} },
    );
    const attempt = connector.updateLocalization({ product: IAP, locale: 'en-US', name: 'x', description: 'y', guard: accept });
    if (mode === '429') {
      await assert.rejects(attempt, (error: unknown) => !(error instanceof ProductOutcomeUnknownError));
    } else {
      await assert.rejects(attempt, (error: unknown) => {
        assertNoSecrets(error);
        return error instanceof ProductOutcomeUnknownError;
      });
    }
    assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 1, `${mode}: sent once`);
  }
});
