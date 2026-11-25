import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import * as pf from '../store-products.fixtures.ts';
import {
  ProductLocaleMissingError,
  ProductLocalizationDriftError,
  ProductMissingError,
  ProductOutcomeUnknownError,
  type StoreProductRef,
} from '../store-products-types.ts';
import { PlayProductWriteConnector } from './play-product-write.ts';

const key = fx.googleKeyPem();
const SUB: StoreProductRef = { productId: 'premium_monthly', kind: 'subscription', storeRef: null };
const ONE: StoreProductRef = { productId: 'coins_100', kind: 'consumable', storeRef: null };
const SUB_PATH = `${pf.SUBS}/premium_monthly`;
const ONE_GET = `${pf.ONE_TIME}/coins_100`;
const ONE_PATCH = `/androidpublisher/v3/applications/${pf.PACKAGE}/onetimeproducts/coins_100`;
const CONVERT = `/androidpublisher/v3/applications/${pf.PACKAGE}/pricing:convertRegionPrices`;
const accept = () => true;

function setup() {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({ method: 'GET', match: SUB_PATH, json: pf.playSubscription })
    .on({ method: 'GET', match: ONE_GET, json: pf.playOneTime })
    .on({
      method: 'POST',
      match: CONVERT,
      json: { convertedRegionPrices: {}, regionVersion: { version: '2025/03' } },
    })
    .on({
      method: 'PATCH',
      match: /^\/androidpublisher\/v3\/applications\/[^/]+\/subscriptions\/premium_monthly\?/,
      json: pf.playSubscription,
    })
    .on({
      method: 'PATCH',
      match: /^\/androidpublisher\/v3\/applications\/[^/]+\/onetimeproducts\/coins_100\?/,
      json: pf.playOneTime,
    });
  const connector = new PlayProductWriteConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: pf.PACKAGE,
    fetch: fake.fetch,
    now: () => pf.T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}

function assertNoSecrets(error: unknown) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n'))
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  assert.ok(!text.includes(fx.ACCESS_TOKEN));
}

test('readLocalization reads one listing and changes nothing', async () => {
  const { fake, connector } = setup();
  assert.deepEqual(await connector.readLocalization(SUB, 'de-de'), {
    locale: 'de-DE',
    name: 'Premium',
    description: 'Alles, monatlich',
  });
  assert.equal(await connector.readLocalization(ONE, 'fr-FR'), undefined);
  assert.ok(fake.calls.every((c) => c.method === 'GET' || c.url.pathname === '/token'));
});

test('a subscription listing is patched with the mask listings, every other field sent back as read', async () => {
  const { fake, connector } = setup();
  const result = await connector.updateLocalization({
    product: SUB,
    locale: 'en-US',
    name: 'Premium plus',
    description: 'Everything, better',
    guard: accept,
  });
  assert.equal(result.before.name, 'Premium');
  const patch = fake.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch);
  assert.equal(
    patch.url.pathname,
    `/androidpublisher/v3/applications/${pf.PACKAGE}/subscriptions/premium_monthly`,
  );
  assert.equal(patch.url.searchParams.get('updateMask'), 'listings');
  assert.equal(patch.url.searchParams.get('regionsVersion.version'), '2025/03');
  assert.equal(patch.url.searchParams.has('allowMissing'), false, 'never creates a product');
  const body = JSON.parse(patch.body ?? '{}');
  assert.deepEqual(Object.keys(body), ['listings'], 'nothing but the listings');
  assert.deepEqual(body.listings[0], {
    languageCode: 'en-US',
    title: 'Premium plus',
    description: 'Everything, better',
    benefits: ['No ads', 'Cloud sync'],
  });
  assert.deepEqual(body.listings[1], pf.playSubscription.listings[1]);
  assert.equal(fake.called('POST', CONVERT).length, 1);
});

test('a one-time product uses its own regions version and the lowercase path', async () => {
  const { fake, connector } = setup();
  await connector.updateLocalization({
    product: ONE,
    locale: 'en-US',
    name: '120 coins',
    description: 'A bag',
    guard: accept,
  });
  const patch = fake.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch?.url.pathname, ONE_PATCH);
  assert.equal(patch?.url.searchParams.get('regionsVersion.version'), '2022/02');
  assert.equal(
    fake.called('POST', CONVERT).length,
    0,
    'no conversion call when the product has its version',
  );
});

test('a guard that says no, a missing locale and a missing product write nothing', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.updateLocalization({
      product: SUB,
      locale: 'en-US',
      name: 'x',
      description: 'y',
      guard: () => false,
    }),
    (error: unknown) =>
      error instanceof ProductLocalizationDriftError && error.current.name === 'Premium',
  );
  await assert.rejects(
    connector.updateLocalization({
      product: SUB,
      locale: 'fr-FR',
      name: 'x',
      description: 'y',
      guard: accept,
    }),
    ProductLocaleMissingError,
  );
  fake.clear('GET', SUB_PATH);
  fake.on({
    method: 'GET',
    match: SUB_PATH,
    status: 404,
    json: { error: { message: 'Package not found' } },
  });
  await assert.rejects(
    connector.updateLocalization({
      product: SUB,
      locale: 'en-US',
      name: 'x',
      description: 'y',
      guard: accept,
    }),
    ProductMissingError,
  );
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('a product id that is not one is refused before any call', async () => {
  const { fake, connector } = setup();
  await assert.rejects(
    connector.readLocalization({ ...SUB, productId: '../x' }, 'en-US'),
    /Not a valid Google Play product id/,
  );
  assert.equal(fake.calls.length, 0);
});

test('when Play names no regions version the texts are not changed', async () => {
  const { fake, connector } = setup();
  fake.clear('POST', CONVERT);
  fake.on({ method: 'POST', match: CONVERT, json: {} });
  await assert.rejects(
    connector.updateLocalization({
      product: SUB,
      locale: 'en-US',
      name: 'x',
      description: 'y',
      guard: accept,
    }),
    /regions version/,
  );
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('a refusal is plain; a 5xx, a cut connection and a 429 are never sent again', async () => {
  for (const mode of ['403', '5xx', 'cut', '429'] as const) {
    const { fake, connector } = setup();
    const re = /^\/androidpublisher\/v3\/applications\/[^/]+\/subscriptions\/premium_monthly\?/;
    fake.clear('PATCH', re as unknown as string);
    fake.on(
      mode === 'cut'
        ? { method: 'PATCH', match: re, throws: new TypeError('fetch failed') }
        : {
            method: 'PATCH',
            match: re,
            status: mode === '5xx' ? 503 : mode === '429' ? 429 : 403,
            headers: { 'retry-after': '1' },
            json: { error: { code: 403, message: 'no' } },
          },
    );
    await assert.rejects(
      connector.updateLocalization({
        product: SUB,
        locale: 'en-US',
        name: 'x',
        description: 'y',
        guard: accept,
      }),
      (error: unknown) => {
        assertNoSecrets(error);
        assert.ok(error instanceof StoreError);
        assert.equal(
          error instanceof ProductOutcomeUnknownError,
          mode === '5xx' || mode === 'cut',
          mode,
        );
        return true;
      },
    );
    assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 1, `${mode}: sent once`);
  }
});
