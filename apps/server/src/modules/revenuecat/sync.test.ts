import assert from 'node:assert/strict';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { entitlement, product } from '../../../../../packages/connectors/src/revenuecat/revenuecat.fixtures.ts';
import { bootRevenueCat, errorBody, json, REVENUECAT_KEY } from './test-helpers.ts';

const codes = (warnings: { code: string; storeProductId: string | null; rcProductId: string | null; entitlementId: string | null }[]) =>
  warnings.map((w) => `${w.code}:${w.storeProductId ?? w.rcProductId ?? w.entitlementId}`).sort();

dbTest('before a sync there is a link and nothing joined: nothing is claimed', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  const view = await t.view(appId);
  assert.equal(view.status, 200);
  assert.equal(view.body.supported, true);
  assert.equal(view.body.link.projectName, 'MagicWeather');
  assert.equal(view.body.sync, null);
  assert.deepEqual(view.body.products, {});
  assert.deepEqual(view.body.warnings, []);
  assert.deepEqual(view.body.unmatched, []);
});

dbTest('an app without a link has an empty view and its sync is refused without asking RevenueCat', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.addApp('ios');
  const view = await t.view(appId);
  assert.deepEqual(
    [view.body.link, view.body.sync, view.body.products, view.body.warnings],
    [null, null, {}, []],
  );
  const sync = await t.rcSync(appId);
  assert.equal(sync.status, 422);
  assert.equal(sync.body.error, 'revenuecat_not_linked');
  assert.equal(t.rc.calls.length, 0);
});

dbTest('a sync stores the products of the linked app, the entitlements and the offerings, and the view joins them to the store products', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  const store = await t.sync(appId);
  assert.equal(store.status, 200, store.text);
  assert.equal(store.body.revenuecat.ok, true, 'the products sync ran the RevenueCat step');
  // Start again from the stored copy only: sync RevenueCat alone, as a person retrying that half.
  const res = await t.rcSync(appId);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sync.products, 3);
  assert.equal(res.body.sync.entitlements, 2);
  assert.equal(res.body.sync.offerings, 1);
  assert.equal(res.body.sync.otherAppProducts, 2, 'the Play products of the same project are left out');
  assert.equal(res.body.sync.complete, true);
  assert.ok(t.rc.calls.every((c) => c.method === 'GET'));

  const view = (await t.view(appId)).body;
  assert.equal(view.sync.productCount, 3);
  assert.equal(view.sync.failures, 0);
  assert.equal(view.sync.lastError, null);
  const pro = view.products['com.acme.pro.monthly'];
  assert.equal(pro.status, 'in_revenuecat');
  assert.deepEqual(pro.products.map((p: { rcProductId: string }) => p.rcProductId), ['rc_pro']);
  assert.equal(pro.products[0].duration, 'P1M');
  assert.equal(pro.products[0].trialDuration, 'P1W');
  assert.deepEqual(pro.entitlements.map((e: { lookupKey: string }) => e.lookupKey), ['pro']);
  assert.deepEqual(
    pro.offerings.map((o: { lookupKey: string; isCurrent: boolean; packages: { lookupKey: string }[] }) => [o.lookupKey, o.isCurrent, o.packages.map((p) => p.lookupKey)]),
    [['default', true, ['$rc_monthly']]],
  );
  const coins = view.products['com.acme.coins100'];
  assert.equal(coins.status, 'in_revenuecat');
  assert.deepEqual(coins.entitlements, []);
  // Only configuration: no money, no customer data anywhere in the answer.
  assert.equal(JSON.stringify(view).match(/"(amount|revenue(?!cat)|mrr|price|customer|subscriber)[^"]*"/i), null);
  assert.deepEqual(view.unmatched.map((u: { rcProductId: string }) => u.rcProductId), ['rc_ghost']);
  assert.deepEqual(codes(view.warnings), [
    'entitlement_without_active_product:ent_empty',
    'revenuecat_product_not_in_store:rc_ghost',
  ]);
  assert.ok(view.warnings.every((w: { message: string }) => w.message.length > 20));
});

dbTest('Google Play: one store product maps to several RevenueCat products, one per base plan, and a plan without a product is said', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('android');
  assert.equal((await t.sync(appId)).status, 200);
  const view = (await t.view(appId)).body;
  const sub = view.products.pro_monthly;
  assert.equal(sub.status, 'in_revenuecat');
  assert.deepEqual(sub.products.map((p: { planId: string; planInStore: boolean }) => [p.planId, p.planInStore]), [
    ['monthly', true],
    ['yearly', false],
  ]);
  assert.equal(sub.offerings[0].packages[0].eligibility, 'google_sdk_ge_6');
  assert.deepEqual(sub.entitlements.map((e: { lookupKey: string }) => e.lookupKey), ['pro']);
  // The yearly RevenueCat product names a base plan the store does not list; the Apple products are other apps' and left out.
  assert.deepEqual(codes(view.warnings), ['entitlement_without_active_product:ent_empty', 'product_not_sellable:pro_monthly'].sort());
});

dbTest('macOS reads through the capability: a macOS record shares the Apple store products and the Mac App Store app', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('macos');
  t.rc.products = [
    product('rc_mac_pro', 'com.acme.pro.monthly', 'appmac0001'),
    product('rc_ios_coins', 'com.acme.coins100', 'appios0001'),
  ];
  assert.equal((await t.sync(appId)).status, 200);
  const view = (await t.view(appId)).body;
  assert.equal(view.link.revenueCatAppType, 'mac_app_store');
  assert.equal(view.products['com.acme.pro.monthly'].status, 'in_revenuecat');
  assert.equal(view.products['com.acme.coins100'].status, 'not_in_revenuecat', 'the iOS app’s product is not this record’s');
  assert.deepEqual(codes(view.warnings).filter((c) => c.startsWith('store_product')), ['store_product_not_in_revenuecat:com.acme.coins100']);
});

dbTest('a product the store lacks or a store product RevenueCat lacks is a warning only when the other copy is complete', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  t.rc.products = [product('rc_pro', 'com.acme.pro.monthly', 'appios0001')];
  t.rc.entitlements = [entitlement('e', 'pro', [product('rc_pro', 'com.acme.pro.monthly', 'appios0001')])];
  t.rc.offerings = [];
  assert.equal((await t.sync(appId)).status, 200);
  let view = (await t.view(appId)).body;
  assert.deepEqual(codes(view.warnings), ['product_not_sellable:com.acme.pro.monthly', 'store_product_not_in_revenuecat:com.acme.coins100'].sort());
  // The store read stopped at a cap: "RevenueCat has a product the store has not" is not claimed, "not in RevenueCat" still is.
  t.stores.ios.products = t.stores.ios.products.slice(0, 1);
  t.stores.ios.complete = false;
  t.rc.products = [...t.rc.products, product('rc_x', 'com.acme.unknown', 'appios0001')];
  assert.equal((await t.sync(appId)).status, 200);
  view = (await t.view(appId)).body;
  assert.ok(!codes(view.warnings).some((c) => c.startsWith('revenuecat_product_not_in_store')));
  assert.ok(codes(view.warnings).includes('store_product_not_in_revenuecat:com.acme.coins100'));
});

dbTest('a RevenueCat failure keeps the last good copy, says what went wrong, and does not count a rate limit as a failure', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await t.rcSync(appId);
  const good = await t.view(appId);
  const failures: [Response | Error, number, string][] = [
    [json(errorBody('authentication_error'), 401), 422, 'revenuecat_auth'],
    [json(errorBody('authorization_error'), 403), 422, 'revenuecat_forbidden'],
    [json({}, 500), 502, 'revenuecat_unavailable'],
    [new TypeError(`ECONNREFUSED ${REVENUECAT_KEY}`), 502, 'revenuecat_unavailable'],
  ];
  let streak = 0;
  for (const [answer, status, code] of failures) {
    t.rc.next.push(answer);
    const res = await t.rcSync(appId);
    assert.equal(res.status, status);
    assert.equal(res.body.error, code);
    streak += 1;
    const view = (await t.view(appId)).body;
    assert.equal(view.sync.failures, streak);
    assert.equal(view.sync.lastError, res.body.message);
    assert.deepEqual(view.products, good.body.products, 'the last good copy is kept');
  }
  t.rc.next.push(json({}, 429, { 'retry-after': '9' }));
  const limited = await t.rcSync(appId);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '9');
  const after = (await t.view(appId)).body;
  assert.equal(after.sync.failures, streak, 'waiting is not a failed sync');
  assert.match(after.sync.lastError, /slow down/);
  // A good sync clears the failure.
  assert.equal((await t.rcSync(appId)).status, 200);
  const cleared = (await t.view(appId)).body.sync;
  assert.deepEqual([cleared.failures, cleared.lastError], [0, null]);
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
});

dbTest('a linked app that RevenueCat no longer has is said, not shown as an empty list', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  t.rc.apps = [];
  const res = await t.rcSync(appId);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'revenuecat_app_missing');
});

dbTest('the read is capped: a project that needs more requests than allowed is incomplete, says so, and raises no "not found" warning from it', async (db) => {
  const t = await bootRevenueCat(db, {}, { maxRequests: 4 });
  const appId = await t.linked('ios');
  // Entitlements without their products need one request each to read; the budget cannot pay for them.
  t.rc.entitlements = [entitlement('e1', 'pro', null), entitlement('e2', 'plus', null)];
  const res = await t.rcSync(appId);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sync.complete, false);
  assert.ok(res.body.sync.warnings.some((w: string) => /rate limit/.test(w)));
  const view = (await t.view(appId)).body;
  assert.equal(view.sync.complete, false);
  assert.deepEqual(codes(view.warnings), ['revenuecat_read_incomplete:null']);
});

dbTest('a sync takes a slot of the workspace budget; a rate limited one costs RevenueCat nothing', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  let last = 200;
  let calls = 0;
  for (let i = 0; i < 12 && last === 200; i++) {
    calls = t.rc.calls.length;
    last = (await t.rcSync(appId)).status;
  }
  assert.equal(last, 429);
  assert.equal(t.rc.calls.length, calls, 'refused before any request');
});

dbTest('the audit rows hold counts and ids, never a name, a response or the key', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await t.rcSync(appId);
  const synced = (await t.rcAudit()).filter((a) => a.action === 'revenuecat.synced');
  assert.equal(synced.length, 1);
  assert.deepEqual(JSON.parse(synced[0]?.detail ?? '{}'), {
    appId,
    products: 3,
    entitlements: 2,
    offerings: 1,
    complete: true,
    warnings: 0,
  });
  const uses = (await t.rcAudit()).filter((a) => a.action === 'credential.use').map((a) => JSON.parse(a.detail).purpose);
  assert.deepEqual(uses, ['revenuecat.link', 'revenuecat.sync']);
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
  assert.ok(!(await t.everything()).includes('Magic iOS Secret'));
});

dbTest('deleting the app deletes its RevenueCat link and copy', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await t.rcSync(appId);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  for (const table of ['app_revenuecat_links', 'revenuecat_products', 'revenuecat_entitlements', 'revenuecat_offerings', 'revenuecat_sync']) {
    assert.equal((await db.query(`SELECT 1 FROM ${table}`)).length, 0, table);
  }
});

// ---------------------------------------------------------------------------------------------
// The second step of "Sync products"

dbTest('Sync products reads the store, then RevenueCat, and reports both', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  const res = await t.sync(appId);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sync.products, 2, 'the store result is as before');
  assert.deepEqual(
    [res.body.revenuecat.ok, res.body.revenuecat.products, res.body.revenuecat.entitlements, res.body.revenuecat.offerings, res.body.revenuecat.complete],
    [true, 3, 2, 1, true],
  );
  assert.equal((await t.view(appId)).body.products['com.acme.pro.monthly'].status, 'in_revenuecat');
});

dbTest('Sync products of an app without a link asks RevenueCat nothing and reports null', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.addApp('ios');
  const res = await t.sync(appId);
  assert.equal(res.status, 200);
  assert.equal(res.body.revenuecat, null);
  assert.equal(t.rc.calls.length, 0);
});

dbTest('a RevenueCat failure never touches the store snapshot, and the store answer stays 200 with the RevenueCat failure beside it', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  t.rc.next.push(json(errorBody('authentication_error'), 401));
  const res = await t.sync(appId);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.sync.products, 2);
  assert.equal(res.body.revenuecat.ok, false);
  assert.equal(res.body.revenuecat.code, 'revenuecat_auth');
  assert.match(res.body.revenuecat.message, /did not accept the secret API key/);
  const list = await t.list(appId);
  assert.equal(list.body.products.length, 2, 'the store snapshot was replaced as usual');
  assert.equal(list.body.sync.lastError, null);
  assert.equal(list.body.sync.failures, 0);
  assert.equal((await t.call(t.owner, 'GET', t.base(appId))).body.sync.failures, 1);
});

dbTest('a store failure never blocks the RevenueCat step, which still runs and is reported in the failure body', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  t.stores.ios.listError = new StoreError('appstoreconnect', 'auth', 'The store did not accept the key.', 401);
  const res = await t.sync(appId);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'store_auth');
  assert.equal(res.body.revenuecat.ok, true, 'RevenueCat was read anyway');
  assert.equal(res.body.revenuecat.products, 3);
  assert.equal((await t.list(appId)).body.sync.failures, 1, 'the store failure is the store’s');
  const rc = (await t.view(appId)).body;
  assert.equal(rc.sync.failures, 0);
  assert.equal(Object.keys(rc.products).length, 0, 'no store snapshot, so nothing joined to it');
  // A failure of both is reported by both, each its own.
  t.rc.next.push(json({}, 500));
  const both = await t.sync(appId);
  assert.equal(both.body.error, 'store_auth');
  assert.equal(both.body.revenuecat.ok, false);
  assert.equal(both.body.revenuecat.code, 'revenuecat_unavailable');
});

dbTest('the two steps share one slot of the sync budget', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  let ok = 0;
  for (let i = 0; i < 12; i++) {
    const res = await t.sync(appId);
    if (res.status === 200) ok += 1;
    else assert.equal(res.status, 429);
  }
  assert.ok(ok > 0 && ok < 12);
});
