import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type JoinInput, type JoinStoreProduct, joinRevenueCat } from './join.ts';
import type { RevenueCatEntitlement, RevenueCatOffering, RevenueCatProduct } from './types.ts';

const store = (
  productId: string,
  state = 'active',
  kind = 'subscription',
  plans: JoinStoreProduct['plans'] = [],
): JoinStoreProduct => ({
  productId,
  kind,
  state,
  plans,
});
const rc = (
  id: string,
  storeIdentifier: string,
  state: RevenueCatProduct['state'] = 'active',
): RevenueCatProduct => ({
  id,
  storeIdentifier,
  type: 'subscription',
  state,
  rawState: state,
  displayName: null,
  appId: 'app',
  duration: 'P1M',
  gracePeriod: null,
  trialDuration: null,
});
const ent = (
  id: string,
  lookupKey: string,
  productIds: string[],
  extra: Partial<RevenueCatEntitlement> = {},
): RevenueCatEntitlement => ({
  id,
  lookupKey,
  displayName: null,
  state: 'active',
  rawState: 'active',
  productIds,
  projectProductCount: productIds.length,
  ...extra,
});
const offer = (
  id: string,
  lookupKey: string,
  packages: [string, string[]][],
  extra: Partial<RevenueCatOffering> = {},
): RevenueCatOffering => ({
  id,
  lookupKey,
  displayName: null,
  isCurrent: lookupKey === 'default',
  state: 'active',
  rawState: 'active',
  packages: packages.map(([key, ids], i) => ({
    id: `${id}_${key}`,
    lookupKey: key,
    displayName: null,
    position: i + 1,
    products: ids.map((productId) => ({ productId, eligibility: 'all' })),
  })),
  ...extra,
});
const input = (extra: Partial<JoinInput>): JoinInput => ({
  storeProducts: [],
  storeComplete: true,
  storeSynced: true,
  rcProducts: [],
  entitlements: [],
  offerings: [],
  rcComplete: true,
  ...extra,
});
const codes = (r: ReturnType<typeof joinRevenueCat>) =>
  r.warnings.map((w) => `${w.code}:${w.storeProductId ?? w.rcProductId ?? w.entitlementId}`).sort();

test('Apple: the RevenueCat store identifier is the product id; the entitlements, offerings and packages come with it', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [store('pro_monthly'), store('lifetime', 'active', 'non_consumable')],
      rcProducts: [rc('p1', 'pro_monthly'), rc('p2', 'lifetime')],
      entitlements: [ent('e1', 'pro', ['p1', 'p2'])],
      offerings: [
        offer('o1', 'default', [
          ['$rc_monthly', ['p1']],
          ['$rc_lifetime', ['p2']],
        ]),
      ],
    }),
  );
  const monthly = r.byProduct.get('pro_monthly');
  assert.equal(monthly?.status, 'in_revenuecat');
  assert.deepEqual(
    monthly?.products.map((p) => [p.rcProductId, p.planId, p.planInStore]),
    [['p1', null, null]],
  );
  assert.deepEqual(
    monthly?.entitlements.map((e) => e.lookupKey),
    ['pro'],
  );
  assert.deepEqual(
    monthly?.offerings.map((o) => [o.lookupKey, o.isCurrent, o.packages.map((p) => p.lookupKey)]),
    [['default', true, ['$rc_monthly']]],
  );
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.unmatched, []);
});

test('Google Play: one store product maps to several RevenueCat products, one per base plan', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [
        store('sub_pro', 'active', 'subscription', [
          { id: 'monthly', state: 'ACTIVE' },
          { id: 'yearly', state: 'ACTIVE' },
        ]),
      ],
      rcProducts: [rc('p1', 'sub_pro:monthly'), rc('p2', 'sub_pro:yearly')],
      entitlements: [ent('e1', 'pro', ['p1', 'p2'])],
      offerings: [
        offer('o1', 'default', [
          ['m', ['p1']],
          ['y', ['p2']],
        ]),
      ],
    }),
  );
  const view = r.byProduct.get('sub_pro');
  assert.equal(view?.status, 'in_revenuecat');
  assert.deepEqual(
    view?.products.map((p) => [p.rcProductId, p.planId, p.planInStore]),
    [
      ['p1', 'monthly', true],
      ['p2', 'yearly', true],
    ],
  );
  assert.equal(view?.offerings.length, 1, 'one offering, with the packages of both products');
  assert.deepEqual(
    view?.offerings[0]?.packages.map((p) => p.lookupKey),
    ['m', 'y'],
  );
  assert.deepEqual(view?.entitlements.length, 1);
  assert.deepEqual(r.warnings, []);
});

test('Google Play: a legacy bare subscription id is one RevenueCat product for the whole subscription, no base plan warning', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [
        store('sub_pro', 'active', 'subscription', [
          { id: 'monthly', state: 'ACTIVE' },
          { id: 'yearly', state: 'ACTIVE' },
        ]),
      ],
      rcProducts: [rc('p1', 'sub_pro')],
      offerings: [offer('o1', 'default', [['m', ['p1']]])],
    }),
  );
  assert.deepEqual(
    r.byProduct.get('sub_pro')?.products.map((p) => [p.planId, p.planInStore]),
    [[null, null]],
  );
  assert.deepEqual(codes(r), []);
});

test('Google Play: an active base plan with no RevenueCat product is an info warning; a RevenueCat plan the store lacks is shown as such', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [
        store('sub_pro', 'active', 'subscription', [
          { id: 'monthly', state: 'ACTIVE' },
          { id: 'yearly', state: 'ACTIVE' },
          { id: 'old', state: 'INACTIVE' },
        ]),
      ],
      rcProducts: [rc('p1', 'sub_pro:monthly'), rc('p3', 'sub_pro:P1Y')],
      offerings: [offer('o1', 'default', [['m', ['p1', 'p3']]])],
    }),
  );
  assert.deepEqual(codes(r), ['play_base_plan_not_in_revenuecat:sub_pro']);
  assert.equal(r.warnings[0]?.severity, 'info');
  assert.match(r.warnings[0]?.message ?? '', /sub_pro:yearly/);
  assert.deepEqual(
    r.byProduct.get('sub_pro')?.products.map((p) => [p.planId, p.planInStore]),
    [
      ['monthly', true],
      ['P1Y', false],
    ],
  );
});

test('a store product that is on sale and not in RevenueCat is a warning; a draft or a removed one is not', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [
        store('a'),
        store('b', 'in_review'),
        store('c', 'draft'),
        store('d', 'removed'),
        store('e', 'inactive'),
      ],
    }),
  );
  assert.deepEqual(codes(r), [
    'store_product_not_in_revenuecat:a',
    'store_product_not_in_revenuecat:b',
  ]);
  assert.equal(r.byProduct.get('c')?.status, 'not_in_revenuecat');
  assert.ok(r.warnings.every((w) => w.severity === 'warn'));
});

test('a RevenueCat product with no store product is a warning when the store read was complete, archived ones are not', () => {
  const rcProducts = [
    rc('p1', 'ghost'),
    rc('p2', 'old_ghost', 'archived'),
    rc('p3', 'sub_x:monthly'),
  ];
  const r = joinRevenueCat(input({ storeProducts: [store('a')], rcProducts }));
  assert.deepEqual(
    codes(r).filter((c) => c.startsWith('revenuecat_product_not_in_store')),
    ['revenuecat_product_not_in_store:p1', 'revenuecat_product_not_in_store:p3'],
  );
  assert.deepEqual(
    r.unmatched.map((p) => p.rcProductId),
    ['p1', 'p2', 'p3'],
    'archived ones are still listed as unmatched',
  );
  const partial = joinRevenueCat(
    input({ storeProducts: [store('a')], rcProducts, storeComplete: false }),
  );
  assert.deepEqual(
    codes(partial).filter((c) => c.startsWith('revenuecat_product_not_in_store')),
    [],
    'an incomplete store read never says "not in the store"',
  );
  const never = joinRevenueCat(
    input({ storeProducts: [], rcProducts, storeSynced: false, storeComplete: false }),
  );
  assert.deepEqual(
    never.warnings.filter((w) => w.code === 'revenuecat_product_not_in_store'),
    [],
  );
});

test('an id that differs only in letter case is its own warning, not a match and not a missing product', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [store('Pro_Monthly')],
      rcProducts: [rc('p1', 'pro_monthly')],
      offerings: [offer('o', 'd', [['m', ['p1']]])],
    }),
  );
  assert.equal(r.byProduct.get('Pro_Monthly')?.status, 'id_not_matched');
  assert.deepEqual(codes(r), ['revenuecat_product_case_differs:Pro_Monthly']);
});

test('archived: matched only by archived RevenueCat products', () => {
  const r = joinRevenueCat(
    input({ storeProducts: [store('a')], rcProducts: [rc('p1', 'a', 'archived')] }),
  );
  assert.equal(r.byProduct.get('a')?.status, 'archived');
  assert.deepEqual(codes(r), [], 'archived is a state, not a missing product');
  const unknown = joinRevenueCat(
    input({ storeProducts: [store('a')], rcProducts: [rc('p1', 'a', 'unknown')] }),
  );
  assert.equal(unknown.byProduct.get('a')?.status, 'in_revenuecat');
});

test('an active RevenueCat product in no package of an active offering is an info warning', () => {
  const rcProducts = [rc('p1', 'a'), rc('p2', 'b')];
  const r = joinRevenueCat(
    input({
      storeProducts: [store('a'), store('b')],
      rcProducts,
      offerings: [
        offer('o', 'default', [['m', ['p1']]]),
        offer('o2', 'old', [['m', ['p2']]], { state: 'archived' }),
      ],
    }),
  );
  assert.deepEqual(codes(r), ['product_not_sellable:b']);
  assert.equal(r.warnings[0]?.severity, 'info');
});

test('an entitlement with no active product is a warning: archived, removed in the store, or empty; other apps products count as none here', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [store('a'), store('gone', 'removed'), store('ok')],
      rcProducts: [rc('p1', 'a', 'archived'), rc('p2', 'gone'), rc('p3', 'ok')],
      entitlements: [
        ent('e1', 'archived_only', ['p1']),
        ent('e2', 'removed_only', ['p2']),
        ent('e3', 'empty', [], { projectProductCount: 0 }),
        ent('e4', 'fine', ['p3']),
        ent('e5', 'mixed', ['p1', 'p3']),
        ent('e6', 'archived_ent', ['p1'], { state: 'archived' }),
        ent('e7', 'other_apps', [], { projectProductCount: 2 }),
      ],
      offerings: [offer('o', 'default', [['m', ['p3']]])],
    }),
  );
  const ids = r.warnings
    .filter((w) => w.code === 'entitlement_without_active_product')
    .map((w) => w.entitlementId);
  assert.deepEqual(ids.sort(), ['e1', 'e2', 'e3', 'e7']);
  assert.match(
    r.warnings.find((w) => w.entitlementId === 'e3')?.message ?? '',
    /no product in RevenueCat/,
  );
  assert.match(
    r.warnings.find((w) => w.entitlementId === 'e1')?.message ?? '',
    /no active product of this app/,
  );
});

test('a product the store removed that RevenueCat still offers is a bad warning', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [store('a', 'removed'), store('b', 'inactive')],
      rcProducts: [rc('p1', 'a'), rc('p2', 'b')],
      offerings: [offer('o', 'default', [['m', ['p1']]])],
    }),
  );
  assert.deepEqual(
    r.warnings.filter((w) => w.severity === 'bad').map((w) => [w.code, w.storeProductId]),
    [['store_removed_but_active_in_revenuecat', 'a']],
  );
});

test('an incomplete RevenueCat read makes no "not found" claim and says so once', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [store('a')],
      rcProducts: [],
      entitlements: [ent('e', 'empty', [], { projectProductCount: 0 })],
      rcComplete: false,
    }),
  );
  assert.deepEqual(codes(r), ['revenuecat_read_incomplete:null']);
  assert.equal(r.warnings[0]?.severity, 'info');
});

test('a store that was never synced raises nothing about store products', () => {
  const r = joinRevenueCat(
    input({
      storeProducts: [],
      storeSynced: false,
      rcProducts: [rc('p1', 'a')],
      offerings: [offer('o', 'default', [['m', ['p1']]])],
    }),
  );
  assert.deepEqual(r.warnings, []);
});
