import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRevenueCatClient } from './client.ts';
import { RevenueCatError } from './errors.ts';
import {
  getRevenueCatApp,
  listRevenueCatApps,
  listRevenueCatProjects,
  readRevenueCatConfiguration,
} from './read.ts';
import {
  type Answer,
  apps,
  type Call,
  entitlement,
  errorBody,
  fakeFetch,
  IOS_APP_ID,
  KEY,
  list,
  MAC_APP_ID,
  offering,
  PLAY_APP_ID,
  PROJECT_ID,
  packageOf,
  product,
  project,
} from './revenuecat.fixtures.ts';

const client = (
  f: ReturnType<typeof fakeFetch>,
  extra: Partial<Parameters<typeof createRevenueCatClient>[0]> = {},
) => createRevenueCatClient({ apiKey: KEY, fetch: f.fetch, ...extra });

async function failure(run: () => Promise<unknown>): Promise<RevenueCatError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof RevenueCatError, String(error));
    return error;
  }
  assert.fail('expected a RevenueCatError');
}

test('projects are listed with id and name', async () => {
  const f = fakeFetch(() => ({
    body: list([project(), project('proj2', 'Other'), { name: 'no id' }]),
  }));
  const got = await listRevenueCatProjects(client(f));
  assert.deepEqual(got.projects, [
    { id: PROJECT_ID, name: 'MagicWeather' },
    { id: 'proj2', name: 'Other' },
  ]);
  assert.equal(f.calls[0]?.path, '/v2/projects');
});

test('apps: App Store, Mac App Store and Play Store are mapped with their identifier; every other store is listed as not mapped', async () => {
  const f = fakeFetch(() => ({
    body: list([
      apps.ios,
      apps.mac,
      apps.play,
      apps.stripe,
      { id: 'amz', name: 'Amazon', type: 'amazon', amazon: { package_name: 'com.example.amz' } },
      { id: 'rcb', name: 'Billing', type: 'rc_billing' },
      { id: 'tst', name: 'Test', type: 'test_store' },
      { id: 'future', name: 'Future', type: 'a_new_store' },
    ]),
  }));
  const { apps: got } = await listRevenueCatApps(client(f), PROJECT_ID);
  assert.deepEqual(
    got.map((a) => [a.id, a.type, a.store, a.identifier]),
    [
      [IOS_APP_ID, 'app_store', 'app_store', 'com.example.magic'],
      [MAC_APP_ID, 'mac_app_store', 'mac_app_store', 'com.example.magic.mac'],
      [PLAY_APP_ID, 'play_store', 'play_store', 'com.example.magic'],
      ['appstripe01', 'stripe', null, null],
      ['amz', 'amazon', null, null],
      ['rcb', 'rc_billing', null, null],
      ['tst', 'test_store', null, null],
      ['future', 'a_new_store', null, null],
    ],
  );
  assert.equal(f.calls.length, 1, 'unmapped apps cost no extra request');
});

test('an app list that leaves out the bundle id is completed from the app itself', async () => {
  const bare = { id: IOS_APP_ID, name: 'Magic iOS', type: 'app_store' };
  const f = fakeFetch((call) =>
    call.path.endsWith('/apps') ? { body: list([bare]) } : { body: apps.ios },
  );
  const { apps: got } = await listRevenueCatApps(client(f), PROJECT_ID);
  assert.equal(got[0]?.identifier, 'com.example.magic');
  assert.equal(f.calls[1]?.path, `/v2/projects/${PROJECT_ID}/apps/${IOS_APP_ID}`);
  // A key that may read the list but not one app leaves the identifier empty, without failing.
  const g = fakeFetch((call) =>
    call.path.endsWith('/apps')
      ? { body: list([bare]) }
      : { status: 403, body: errorBody('authorization_error') },
  );
  assert.equal((await listRevenueCatApps(client(g), PROJECT_ID)).apps[0]?.identifier, null);
});

test('one app: found, or undefined when RevenueCat has none', async () => {
  const f = fakeFetch(() => ({ body: apps.play }));
  assert.equal(
    (await getRevenueCatApp(client(f), PROJECT_ID, PLAY_APP_ID))?.identifier,
    'com.example.magic',
  );
  const gone = fakeFetch(() => ({ status: 404, body: errorBody('resource_missing') }));
  assert.equal(await getRevenueCatApp(client(gone), PROJECT_ID, 'nope'), undefined);
  const denied = fakeFetch(() => ({ status: 403, body: {} }));
  await failure(() => getRevenueCatApp(client(denied), PROJECT_ID, 'x'));
});

test('ids are percent-encoded into the path', async () => {
  const f = fakeFetch(() => ({ body: apps.ios }));
  await getRevenueCatApp(client(f), 'a/b?c', 'x y');
  assert.equal(f.calls[0]?.path, '/v2/projects/a%2Fb%3Fc/apps/x%20y');
});

const base = `/projects/${PROJECT_ID}`;
const pathOf = (call: Call) => call.path.replace('/v2', '');

const full = (call: Call): Answer => {
  const path = pathOf(call);
  if (path === `${base}/products`) {
    return {
      body: list([
        product('prod_m', 'pro_monthly', IOS_APP_ID),
        product('prod_y', 'pro_yearly', IOS_APP_ID, { subscription: { duration: 'P1Y' } }),
        product('prod_old', 'legacy_pass', IOS_APP_ID, {
          state: 'inactive',
          type: 'non_consumable',
          subscription: null,
        }),
        product('prod_play_m', 'sub_pro:monthly', PLAY_APP_ID),
        product('prod_play_y', 'sub_pro:yearly', PLAY_APP_ID),
        { id: 'no_store_id', app_id: IOS_APP_ID },
      ]),
    };
  }
  if (path === `${base}/entitlements`) {
    return {
      body: list([
        entitlement('ent_pro', 'pro', [
          product('prod_m', 'pro_monthly', IOS_APP_ID),
          product('prod_play_m', 'sub_pro:monthly', PLAY_APP_ID),
        ]),
        entitlement('ent_android', 'android_only', [
          product('prod_play_y', 'sub_pro:yearly', PLAY_APP_ID),
        ]),
        entitlement('ent_empty', 'nothing', []),
      ]),
    };
  }
  if (path === `${base}/offerings`) {
    return {
      body: list([
        offering('ofr_default', 'default', [
          packageOf('pk_2', '$rc_annual', 2, [product('prod_y', 'pro_yearly', IOS_APP_ID)]),
          packageOf('pk_1', '$rc_monthly', 1, [
            product('prod_m', 'pro_monthly', IOS_APP_ID),
            {
              product: product('prod_play_m', 'sub_pro:monthly', PLAY_APP_ID),
              eligibility_criteria: 'google_sdk_ge_6',
            },
          ]),
        ]),
        offering('ofr_android', 'android', [
          packageOf('pk_a', 'monthly', 1, [product('prod_play_y', 'sub_pro:yearly', PLAY_APP_ID)]),
        ]),
      ]),
    };
  }
  return { status: 404, body: errorBody('resource_missing') };
};

test('the configuration of the iOS app: its products, the entitlements and offerings that hold them, nothing of other apps', async () => {
  const f = fakeFetch(full);
  const config = await readRevenueCatConfiguration(client(f), {
    projectId: PROJECT_ID,
    appId: IOS_APP_ID,
  });
  assert.deepEqual(
    config.products.map((p) => [p.id, p.storeIdentifier, p.state, p.type]),
    [
      ['prod_m', 'pro_monthly', 'active', 'subscription'],
      ['prod_y', 'pro_yearly', 'active', 'subscription'],
      ['prod_old', 'legacy_pass', 'archived', 'non_consumable'],
    ],
  );
  assert.equal(config.products[0]?.duration, 'P1M');
  assert.equal(config.products[0]?.gracePeriod, 'P3D');
  assert.equal(config.products[0]?.trialDuration, 'P1W');
  assert.equal(config.products[2]?.rawState, 'inactive');
  assert.equal(config.otherAppProducts, 2);
  // `android_only` holds only another app's product and is left out; `nothing` holds none at all and is kept.
  assert.deepEqual(
    config.entitlements.map((e) => [e.lookupKey, e.productIds, e.projectProductCount]),
    [
      ['pro', ['prod_m'], 2],
      ['nothing', [], 0],
    ],
  );
  assert.equal(config.offerings.length, 1);
  assert.equal(config.offerings[0]?.lookupKey, 'default');
  assert.equal(config.offerings[0]?.isCurrent, true);
  assert.deepEqual(
    config.offerings[0]?.packages.map((p) => [
      p.lookupKey,
      p.position,
      p.products.map((x) => x.productId),
    ]),
    [
      ['$rc_monthly', 1, ['prod_m']],
      ['$rc_annual', 2, ['prod_y']],
    ],
  );
  assert.equal(config.complete, true);
  assert.deepEqual(config.warnings, ['1 RevenueCat product could not be read and was left out.']);
  // Three lists and nothing else: the nested lists were sent in full.
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1]?.query.get('expand'), 'items.product');
  assert.equal(f.calls[2]?.query.get('expand'), 'items.package.product');
  assert.ok(f.calls.every((c) => c.init.method === 'GET'));
});

test('the Play app keeps the eligibility of a package product and one product per base plan', async () => {
  const config = await readRevenueCatConfiguration(client(fakeFetch(full)), {
    projectId: PROJECT_ID,
    appId: PLAY_APP_ID,
  });
  assert.deepEqual(
    config.products.map((p) => p.storeIdentifier),
    ['sub_pro:monthly', 'sub_pro:yearly'],
  );
  const monthly = config.offerings.find((o) => o.lookupKey === 'default')?.packages[0];
  assert.deepEqual(monthly?.products, [
    { productId: 'prod_play_m', eligibility: 'google_sdk_ge_6' },
  ]);
  assert.deepEqual(
    config.entitlements.map((e) => e.lookupKey),
    ['pro', 'android_only', 'nothing'],
  );
});

test('a nested list that was not sent, or has a next page, is read from its own endpoint', async () => {
  const f = fakeFetch((call) => {
    const path = pathOf(call);
    if (path === `${base}/products`)
      return {
        body: list([
          product('prod_m', 'pro_monthly', IOS_APP_ID),
          product('prod_y', 'pro_yearly', IOS_APP_ID),
        ]),
      };
    if (path === `${base}/entitlements`)
      return { body: list([entitlement('ent_pro', 'pro', null)]) };
    if (path === `${base}/entitlements/ent_pro/products`)
      return { body: list([product('prod_m', 'pro_monthly', IOS_APP_ID)]) };
    if (path === `${base}/offerings`) return { body: list([offering('ofr', 'default', null)]) };
    if (path === `${base}/offerings/ofr/packages`) {
      return {
        body: list([
          packageOf('pk_1', 'monthly', 1, null),
          packageOf('pk_2', 'annual', 2, [product('prod_y', 'pro_yearly', IOS_APP_ID)]),
        ]),
      };
    }
    if (path === `${base}/packages/pk_1/products`) {
      return {
        body: list([
          { product: product('prod_m', 'pro_monthly', IOS_APP_ID), eligibility_criteria: 'all' },
        ]),
      };
    }
    return { status: 404, body: errorBody('resource_missing') };
  });
  const config = await readRevenueCatConfiguration(client(f), {
    projectId: PROJECT_ID,
    appId: IOS_APP_ID,
  });
  assert.deepEqual(
    config.entitlements.map((e) => [e.lookupKey, e.productIds]),
    [['pro', ['prod_m']]],
  );
  assert.deepEqual(
    config.offerings[0]?.packages.map((p) => [p.lookupKey, p.products.map((x) => x.productId)]),
    [
      ['monthly', ['prod_m']],
      ['annual', ['prod_y']],
    ],
  );
  assert.equal(config.complete, true);
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(
    f.calls.map((c) => c.path.replace(`/v2${base}`, '')),
    [
      '/products',
      '/entitlements',
      '/entitlements/ent_pro/products',
      '/offerings',
      '/offerings/ofr/packages',
      '/packages/pk_1/products',
    ],
  );
});

test('when the request budget runs out the read is incomplete, says so, and still returns what it has', async () => {
  // Entitlements without their products need one more request each; the budget of 3 cannot pay for them.
  const g = fakeFetch((call) =>
    pathOf(call) === `${base}/entitlements`
      ? { body: list([entitlement('e1', 'pro', null), entitlement('e2', 'plus', null)]) }
      : full(call),
  );
  const config = await readRevenueCatConfiguration(client(g, { maxRequests: 3 }), {
    projectId: PROJECT_ID,
    appId: IOS_APP_ID,
  });
  assert.equal(config.complete, false);
  assert.ok(config.warnings.some((w) => /rate limit/.test(w)));
  assert.ok(g.calls.length <= 3);
  assert.ok(config.products.length > 0);
});

test('products that fill more pages than the budget allows make the read incomplete', async () => {
  const f = fakeFetch((call) =>
    call.path.endsWith('/products')
      ? {
          body: list(
            [product(`p${call.query.get('starting_after') ?? '0'}`, 'x', IOS_APP_ID)],
            '/next',
          ),
        }
      : { body: list([]) },
  );
  const config = await readRevenueCatConfiguration(client(f, { maxRequests: 6 }), {
    projectId: PROJECT_ID,
    appId: IOS_APP_ID,
  });
  assert.equal(config.complete, false);
  assert.ok(config.warnings.some((w) => /more products/.test(w)));
});

test('an unreadable product reference makes the read incomplete, so no "not found" is claimed from it', async () => {
  const f = fakeFetch((call) => {
    const path = pathOf(call);
    if (path === `${base}/products`)
      return { body: list([product('prod_m', 'pro_monthly', IOS_APP_ID)]) };
    if (path === `${base}/entitlements`)
      return { body: list([entitlement('e', 'pro', [{ weird: true }])]) };
    return { body: list([]) };
  });
  const config = await readRevenueCatConfiguration(client(f), {
    projectId: PROJECT_ID,
    appId: IOS_APP_ID,
  });
  assert.equal(config.complete, false);
  assert.ok(config.warnings.some((w) => /could not be read/.test(w)));
});

test('a refusal of RevenueCat in the middle of the read is a RevenueCatError, never a partial result', async () => {
  const f = fakeFetch((call) =>
    call.path.endsWith('/offerings')
      ? { status: 403, body: errorBody('authorization_error') }
      : full(call),
  );
  const error = await failure(() =>
    readRevenueCatConfiguration(client(f), { projectId: PROJECT_ID, appId: IOS_APP_ID }),
  );
  assert.equal(error.kind, 'forbidden');
  assert.match(error.message, /offerings and packages/);
});
