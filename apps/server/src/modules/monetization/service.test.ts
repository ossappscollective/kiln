import assert from 'node:assert/strict';
import { StoreError, StoreRateLimitError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { ASC_SECRET, bootMonetization, iapProduct } from './test-helpers.ts';

const SECRET_BODY = 'SECRETKEYBODY';
/** The line of the private key, as a store error could echo it. */
const KEY_LINE = (JSON.parse(ASC_SECRET) as { privateKey: string }).privateKey.split('\n')[1] ?? '';

dbTest('before a sync there is nothing: an empty list, no sync status', async (db) => {
  const t = await bootMonetization(db);
  const appId = await t.addApp('ios');
  const res = await t.list(appId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.products, []);
  assert.equal(res.body.sync, null);
  assert.equal(res.body.supported, true);
  assert.deepEqual(res.body.write, { enabled: true, envName: 'KILN_STORE_PRODUCT_WRITE_ENABLED' });
  assert.equal(res.body.app.store, 'appstoreconnect');
  assert.equal(t.stores.ios.listReads, 0, 'reading the list asks no store');
  assert.equal((await t.call(t.owner, 'GET', t.pp(appId, '/com.acme.coins100'))).status, 404);
});

dbTest(
  'an App Store sync stores products, texts and prices; the list and the detail show them',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    const synced = await t.sync(appId);
    assert.equal(synced.status, 200, synced.text);
    assert.equal(synced.body.sync.products, 2);
    assert.equal(synced.body.sync.complete, true);
    assert.equal(synced.body.sync.app.id, appId);
    assert.equal(t.stores.ios.listReads, 1);
    assert.equal(
      t.built[0]?.storeAppId,
      '1234567890',
      'the connector is built for the app’s store id',
    );

    const list = await t.list(appId);
    assert.equal(list.body.sync.productCount, 2);
    assert.equal(list.body.sync.failures, 0);
    assert.equal(list.body.sync.lastError, null);
    assert.equal(typeof list.body.sync.lastSyncedAt, 'number');
    const [coins, pro] = list.body.products;
    assert.equal(coins.productId, 'com.acme.coins100');
    assert.equal(coins.kind, 'consumable');
    assert.equal(coins.name, '100 coins');
    assert.deepEqual(coins.locales, ['de-DE', 'en-US']);
    assert.deepEqual(coins.price, {
      planId: null,
      territory: 'USA',
      currency: 'USD',
      amount: '99',
      display: '0.99',
    });
    assert.equal(coins.territoryCount, 3);
    assert.equal(pro.kind, 'subscription');
    assert.equal(pro.group, 'Pro');
    assert.equal(pro.period, 'ONE_MONTH');
    assert.equal(pro.price.display, '4.99');

    const detail = await t.call(t.owner, 'GET', t.pp(appId, '/com.acme.coins100'));
    assert.equal(detail.status, 200);
    const product = detail.body.product;
    assert.equal(product.baseTerritory, 'USA');
    assert.deepEqual(product.localizations, [
      { locale: 'de-DE', name: '100 Münzen', description: 'Ein Haufen Münzen' },
      { locale: 'en-US', name: '100 coins', description: 'A pile of coins' },
    ]);
    assert.equal(product.prices.length, 3);
    assert.deepEqual(
      product.prices.find((p: { territory: string }) => p.territory === 'JPN'),
      { planId: null, territory: 'JPN', currency: 'JPY', amount: '150', display: '150' },
      'a currency without minor units shows its amount as it is',
    );
    assert.deepEqual(product.availability, {
      territories: ['DEU', 'JPN', 'USA'],
      availableInNewTerritories: true,
    });
    assert.equal(detail.body.sync.productCount, 2);
    assert.equal(
      JSON.stringify(detail.body).includes('6740000001'),
      false,
      'the store’s resource id is not an API field',
    );
    assert.equal((await t.call(t.owner, 'GET', t.pp(appId, '/nope'))).status, 404);
  },
);

dbTest(
  'a Google Play sync keeps the plan of each price, the base plans and the offers',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('android');
    assert.equal((await t.sync(appId)).status, 200);
    const [pro] = (await t.list(appId)).body.products;
    assert.equal(pro.productId, 'pro_monthly');
    assert.equal(pro.price.planId, 'monthly');
    assert.equal(pro.price.territory, 'US');
    assert.equal(pro.period, 'P1M');
    const detail = (await t.call(t.owner, 'GET', t.pp(appId, '/pro_monthly'))).body.product;
    assert.deepEqual(detail.plans, [{ id: 'monthly', state: 'ACTIVE', period: 'P1M' }]);
    assert.deepEqual(detail.offers, [{ id: 'intro', planId: 'monthly', state: 'ACTIVE' }]);
    assert.deepEqual(
      detail.prices.map((p: { territory: string }) => p.territory),
      ['DE', 'US'],
    );
    assert.equal(detail.availability.availableInNewTerritories, null);
    assert.equal(t.built[0]?.kind, 'google_play');
    assert.equal(t.built[0]?.identifier, 'com.acme.app1');
  },
);

dbTest(
  'a sync replaces the copy: changed products update, products the store dropped go',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    await t.sync(appId);
    t.stores.ios.products = [
      iapProduct({
        prices: [{ territory: 'USA', currency: 'USD', amount: '199', planId: null }],
        localizations: [{ locale: 'en-US', name: 'Coins', description: 'New', ref: 'loc-en' }],
      }),
    ];
    assert.equal((await t.sync(appId)).body.sync.products, 1);
    const list = (await t.list(appId)).body;
    assert.equal(list.products.length, 1);
    assert.equal(list.products[0].name, 'Coins');
    assert.equal(list.products[0].price.display, '1.99');
    assert.deepEqual(list.products[0].locales, ['en-US']);
    assert.equal(list.sync.productCount, 1);
    const rows = async (table: string) =>
      Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
    assert.equal(await rows('store_products'), 1);
    assert.equal(await rows('store_product_localizations'), 1);
    assert.equal(await rows('store_product_prices'), 1);
  },
);

dbTest('an incomplete read replaces only the products it lists and deletes nothing', async (db) => {
  const t = await bootMonetization(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  t.stores.ios.complete = false;
  t.stores.ios.warnings = ['Stopped after 300 products.'];
  t.stores.ios.products = [
    iapProduct({ prices: [{ territory: 'USA', currency: 'USD', amount: '299', planId: null }] }),
  ];
  const second = await t.sync(appId);
  assert.equal(second.body.sync.complete, false);
  assert.deepEqual(second.body.sync.warnings, ['Stopped after 300 products.']);
  const list = (await t.list(appId)).body;
  assert.deepEqual(
    list.products.map((p: { productId: string }) => p.productId),
    ['com.acme.coins100', 'com.acme.pro.monthly'],
    'the product that was not listed is still there',
  );
  assert.equal(list.products[0].price.display, '2.99');
  assert.equal(list.sync.complete, false);
  assert.equal(list.sync.productCount, 2);
});

dbTest(
  'a failed sync keeps the last good copy, says why, and counts the streak; a good one resets it',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    await t.sync(appId);
    t.stores.ios.listError = new StoreError(
      'appstoreconnect',
      'server',
      `Apple said no near ${KEY_LINE}`,
      503,
    );
    const failed = await t.sync(appId);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'store_unavailable');
    assert.equal(failed.text.includes(SECRET_BODY), false, 'the credential is redacted');
    await t.sync(appId);
    const list = (await t.list(appId)).body;
    assert.equal(list.products.length, 2, 'the last good copy stays');
    assert.equal(list.sync.failures, 2);
    assert.equal(typeof list.sync.lastError, 'string');
    assert.equal(list.sync.lastError.includes(SECRET_BODY), false);
    assert.equal(list.sync.productCount, 2);
    assert.notEqual(list.sync.lastSyncedAt, null, 'the time of the last good sync is kept');

    t.stores.ios.listError = undefined;
    assert.equal((await t.sync(appId)).status, 200);
    const after = (await t.list(appId)).body.sync;
    assert.equal(after.failures, 0);
    assert.equal(after.lastError, null);
    for (const text of t.texts) assert.equal(text.includes(SECRET_BODY), false);
    for (const row of await db.query('SELECT detail FROM audit_events'))
      assert.equal(String(row.detail).includes(SECRET_BODY), false);
  },
);

dbTest('a first sync that fails leaves a status with the error and no products', async (db) => {
  const t = await bootMonetization(db);
  const appId = await t.addApp('android');
  t.stores.android.listError = new StoreError('googleplay', 'forbidden', 'No access.', 403);
  const res = await t.sync(appId);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'store_forbidden');
  const list = (await t.list(appId)).body;
  assert.deepEqual(list.products, []);
  assert.equal(list.sync.failures, 1);
  assert.equal(list.sync.lastSyncedAt, null);
  assert.equal(list.sync.lastError, 'No access.');
});

dbTest(
  'the store asking to wait is a 429 with Retry-After and does not count as a failed sync',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    await t.sync(appId);
    t.stores.ios.listError = new StoreRateLimitError('appstoreconnect', 42);
    const res = await t.sync(appId);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '42');
    assert.equal(res.body.error, 'rate_limited');
    assert.equal((await t.list(appId)).body.sync.failures, 0);
  },
);

dbTest('a store that does not answer in time is a 504 and keeps the copy', async (db) => {
  const t = await bootMonetization(db, { read: { timeoutMs: 20 } });
  const appId = await t.addApp('ios');
  await t.sync(appId);
  t.stores.ios.listGate = new Promise(() => undefined);
  const res = await t.sync(appId);
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
  const list = (await t.list(appId)).body;
  assert.equal(list.products.length, 2);
  assert.equal(list.sync.failures, 1);
});

dbTest(
  'the sync is rate limited per workspace, with the budget of the app sync; an unknown app costs no slot',
  async (db) => {
    const t = await bootMonetization(
      db,
      {},
      { appSync: { limiter: createTestLimiter({ limit: 2 }) } },
    );
    const appId = await t.addApp('ios');
    assert.equal((await t.call(t.owner, 'POST', t.pp('nope', '/sync'))).status, 404);
    assert.equal((await t.sync(appId)).status, 200);
    assert.equal((await t.sync(appId)).status, 200);
    const third = await t.sync(appId);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.equal(t.stores.ios.listReads, 2);
    // The app sync draws on the same budget.
    assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/sync`)).status, 429);
  },
);

dbTest(
  'an App Store app without its store id cannot sync yet; a missing credential says so',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    await db.execute('UPDATE apps SET store_app_id = NULL WHERE id = ?', [appId]);
    const res = await t.sync(appId);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'app_not_synced');
    assert.equal(t.stores.ios.listReads, 0);
    assert.equal((await t.list(appId)).body.sync.failures, 1);
  },
);

dbTest('who may read and who may sync; another workspace sees nothing', async (db) => {
  const t = await bootMonetization(db);
  const appId = await t.addApp('ios');
  await t.sync(appId);
  const { can } = await import('@kiln/core');
  for (const role of ['viewer', 'member', 'admin'] as const) {
    const cookie = await t.addMember(role);
    assert.equal((await t.list(appId, cookie)).status, 200, `${role} reads`);
    assert.equal(
      (await t.call(cookie, 'GET', t.pp(appId, '/com.acme.coins100'))).status,
      200,
      `${role} reads one`,
    );
    const synced = await t.sync(appId, cookie);
    assert.equal(synced.status === 403, !can(role, 'apps.sync'), `${role} sync: ${synced.status}`);
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const [method, path] of [
    ['GET', t.pp(appId)],
    ['GET', t.pp(appId, '/com.acme.coins100')],
    ['POST', t.pp(appId, '/sync')],
  ] as const) {
    assert.equal((await t.call(outsider, method, path)).status, 404, `${method} ${path}`);
    assert.equal((await t.call(outsider, method, path, undefined, 'other')).status, 404);
  }
});

dbTest(
  'deleting the app deletes its products, texts, prices, sync status and claim',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    const keep = await t.addApp('android');
    await t.sync(appId);
    await t.sync(keep);
    await db.execute(
      `INSERT INTO store_product_claims (app_id, workspace_id, product_id, status, claimed_by, claim_at)
     VALUES (?, ?, 'com.acme.coins100', 'unknown', 'u', 1)`,
      [appId, t.workspaceId],
    );
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
    for (const table of [
      'store_products',
      'store_product_localizations',
      'store_product_prices',
      'store_product_sync',
      'store_product_claims',
    ]) {
      assert.equal(
        Number(
          (await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`, [appId]))[0]?.n,
        ),
        0,
        table,
      );
    }
    assert.equal((await t.list(keep)).body.products.length, 1, 'another app keeps its copy');
  },
);

dbTest(
  'a sync is audited with counts only and uses the credential under its own purpose',
  async (db) => {
    const t = await bootMonetization(db);
    const appId = await t.addApp('ios');
    await t.sync(appId);
    const [synced] = await t.audit('monetization.synced');
    assert.deepEqual(synced?.detail, {
      appId,
      store: 'appstoreconnect',
      products: 2,
      complete: true,
      warnings: 0,
    });
    const used = (await t.audit('credential.use')).filter(
      (a) => a.detail.purpose === 'products.sync',
    );
    assert.equal(used.length, 1);
    assert.equal(JSON.stringify(synced).includes('coins'), false, 'no product text in the audit');
  },
);
