import assert from 'node:assert/strict';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootPrices, type PriceBoot } from './price-test-helpers.ts';

const COINS = 'com.acme.coins100';
const PRO = 'com.acme.pro.monthly';
const PASSWORD = 'correct horse battery staple';

async function ready(t: PriceBoot, platform: 'ios' | 'android' = 'ios') {
  const appId = await t.addApp(platform);
  assert.equal((await t.sync(appId)).status, 200);
  return appId;
}
/** Stages JPN 150 -> 200 on the coins and returns the cart item. */
async function stagedCoins(t: PriceBoot, appId: string) {
  const res = await t.stage(appId, COINS);
  assert.equal(res.status, 200, res.text);
  const [item] = await t.priceItems(appId);
  assert.ok(item);
  return item;
}
const PHRASE = 'CHANGE 1 PRICE MAX 34%';
const sent = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Record<string, any>,
});

// ----- the gates ------------------------------------------------------------------------------------

dbTest(
  'off by default: the server switch is named, nothing is staged and no store is reached',
  async (db) => {
    const t = await bootPrices(db, { server: false });
    const appId = await ready(t);
    const list = await t.list(appId);
    assert.equal(list.body.priceWrite.enabled, false);
    assert.equal(list.body.priceWrite.reason, 'server_switch');
    assert.equal(list.body.priceWrite.envName, 'KILN_PRICE_WRITES_ENABLED');
    const res = await t.stage(appId, COINS);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'price_writes_disabled');
    assert.equal(res.body.reason, 'server_switch');
    assert.equal(t.fakes.ios.pointReads + t.fakes.ios.reads, 0);
    assert.equal((await t.priceItems(appId)).length, 0);
  },
);

dbTest('the workspace setting is a second switch, off by default', async (db) => {
  const t = await bootPrices(db, { workspace: false });
  const appId = await ready(t);
  assert.equal((await t.list(appId)).body.priceWrite.reason, 'workspace_setting');
  const res = await t.stage(appId, COINS);
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'workspace_setting');
  const on = await t.call(t.owner, 'PUT', '/settings', { 'prices.writeEnabled': true });
  assert.equal(on.status, 200);
  assert.equal((await t.stage(appId, COINS)).status, 200);
});

dbTest(
  'the right monetization.price: a member and a viewer cannot stage, read price points or dry-run',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    for (const role of ['member', 'viewer', 'admin'] as const) {
      const cookie = await t.addMember(role);
      const res = await t.stage(appId, COINS, {}, cookie);
      assert.equal(res.status, role === 'admin' ? 200 : 403, role);
      const dry = await t.call(cookie, 'POST', `/apps/${appId}/prices/dry-run`, {});
      assert.equal(dry.status, role === 'admin' ? 200 : 403, role);
    }
  },
);

// ----- staging: the server decides --------------------------------------------------------------------

dbTest(
  'staging: currency and current price come from the snapshot; the client cannot send them',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const smuggled = await t.stage(appId, COINS, {
      lines: [
        {
          territory: 'JPN',
          newAmount: '200',
          pricePointId: 'jpn-200',
          currency: 'USD',
          currentAmount: '1',
        },
      ],
    });
    assert.equal(smuggled.status, 400);
    const ok = await t.stage(appId, COINS);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body.staged.lines[0], {
      territory: 'JPN',
      currency: 'JPY',
      before: '150',
      after: '200',
      percentBp: 3333,
      direction: 'increase',
      pricePointId: 'jpn-200',
    });
    assert.deepEqual(ok.body.staged.currencies, ['JPY']);
  },
);

dbTest(
  'staging refuses: not a price point (nearest returned), wrong territory, unknown territory, past date, stale snapshot',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const off = await t.stage(appId, COINS, {
      lines: [{ territory: 'JPN', newAmount: '210', pricePointId: 'jpn-200' }],
    });
    assert.equal(off.status, 422);
    assert.equal(off.body.error, 'price_point_invalid');
    const nearest = off.body.issues
      .find((i: { code: string }) => i.code === 'amount_not_price_point')
      .detail.nearest.map((p: { id: string }) => p.id);
    assert.deepEqual(nearest.slice(0, 2), ['jpn-200', 'jpn-150']);
    assert.equal(
      (
        await t.stage(appId, COINS, {
          lines: [{ territory: 'JPN', newAmount: '199', pricePointId: 'usa-199' }],
        })
      ).body.error,
      'price_point_invalid',
    );
    assert.equal(
      (
        await t.stage(appId, COINS, {
          lines: [{ territory: 'FRA', newAmount: '99', pricePointId: 'x' }],
        })
      ).body.issues[0].code,
      'unknown_territory',
    );
    assert.equal(
      (await t.stage(appId, COINS, { effectiveDate: '2020-01-01' })).body.issues[0].code,
      'effective_date_past',
    );
    const stale = await t.stage(appId, COINS, { seenSyncedAt: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stale_snapshot');
    assert.equal((await t.priceItems(appId)).length, 0, 'nothing was staged by a refusal');
  },
);

dbTest(
  'guard rail: a change over 50 percent needs the acknowledgement, and it is checked on the server',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const big = { lines: [{ territory: 'USA', newAmount: '299', pricePointId: 'usa-299' }] };
    const refused = await t.stage(appId, COINS, big);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'acknowledgement_required');
    assert.deepEqual(refused.body.issues[0].detail.acks, ['large_change']);
    const done = await t.stage(appId, COINS, { ...big, acknowledgements: ['large_change'] });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.staged.lines[0].percentBp, 20202);
  },
);

// ----- the cart -----------------------------------------------------------------------------------------

dbTest(
  'the cart shows the price item: financial, needs approval, before and after with percent; discard removes only the draft',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    await stagedCoins(t, appId);
    const [item] = await t.priceItems(appId);
    assert.equal(item?.risk, 'financial');
    assert.equal(item?.needsApproval, true);
    assert.equal(item?.publishable, true);
    assert.equal((item?.price as any).lines[0].percentBp, 3333);
    assert.equal((await t.cart(appId)).body.cart.can.price, true);
    const discard = await t.call(t.owner, 'POST', `/apps/${appId}/pending/discard`, {
      ids: [item?.id],
    });
    assert.equal(discard.status, 200);
    assert.equal(discard.body.result.results[0].status, 'ok');
    assert.equal((await t.priceItems(appId)).length, 0);
    assert.equal(t.fakes.ios.writes.length, 0, 'the store was not touched');
    assert.equal((await t.audit('price.discarded')).length, 1);
  },
);

dbTest(
  'publish needs the typed phrase naming the count and the largest change: nothing is sent without it',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    for (const phrase of [
      undefined,
      '',
      'CHANGE PRICES',
      'change 1 price max 34%',
      'CHANGE 2 PRICES MAX 34%',
    ]) {
      const res = await sent(
        await t.publish(appId, [{ id: item.id, version: item.version }], phrase),
      );
      assert.equal(res.status, 422, String(phrase));
      assert.equal(res.body.error, 'confirmation_mismatch');
    }
    assert.equal(t.fakes.ios.writes.length, 0);
    assert.equal(t.fakes.ios.reads, 0, 'refused before the store was read');
    assert.equal(
      t.stores.ios.products
        .find((p) => p.productId === COINS)
        ?.prices.find((x) => x.territory === 'JPN')?.amount,
      '150',
    );
  },
);

dbTest(
  'publish: re-reads, writes, reads back, says confirmed, audits amounts and the actor, and removes the draft',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    const res = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body.result.results[0];
    assert.equal(r.status, 'ok');
    assert.equal(r.price.verification, 'confirmed');
    assert.deepEqual(r.price.lines, [
      { territory: 'JPN', currency: 'JPY', before: '150', after: '200', outcome: 'applied' },
    ]);
    assert.equal(t.fakes.ios.writes.length, 1);
    assert.ok(t.fakes.ios.reads >= 3, 'live read, the connector read, and the read back');
    assert.equal((await t.priceItems(appId)).length, 0);
    const changed = (await t.audit('price.changed'))[0];
    assert.equal(changed?.actorType, 'user');
    assert.equal(changed?.detail.productId, COINS);
    assert.deepEqual((changed?.detail.lines as any[])[0], {
      territory: 'JPN',
      currency: 'JPY',
      before: '150',
      after: '200',
      outcome: 'applied',
      percentBp: 3333,
    });
    assert.equal(changed?.detail.verification, 'confirmed');
    assert.equal(
      (await t.db.query('SELECT * FROM store_price_claims')).length,
      0,
      'the claim is released',
    );
    // Repeating the request is safe: the draft is gone.
    const again = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE),
    );
    assert.equal(again.body.result.results[0].status, 'skipped');
    assert.equal(again.body.result.results[0].reason, 'not_pending');
    assert.equal(t.fakes.ios.writes.length, 1);
  },
);

dbTest(
  'switch turned off after staging: the item stays in the cart with its reason and nothing is sent',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    await t.call(t.owner, 'PUT', '/settings', { 'prices.writeEnabled': false });
    const [off] = await t.priceItems(appId);
    assert.equal(off?.publishable, false);
    assert.equal((off?.reason as any).code, 'workspace_off');
    const res = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE),
    );
    assert.equal(res.body.result.results[0].status, 'skipped');
    assert.equal(res.body.result.results[0].reason, 'workspace_off');
    assert.equal(t.fakes.ios.reads + t.fakes.ios.writes.length, 0);
  },
);

dbTest('a member who may see the cart cannot send a price: skipped with no_right', async (db) => {
  const t = await bootPrices(db);
  const appId = await ready(t);
  const item = await stagedCoins(t, appId);
  const member = await t.addMember('member');
  const seen = (await t.cart(appId, member)).body.cart.items.find(
    (i: { kind: string }) => i.kind === 'price',
  );
  assert.equal(seen.publishable, false);
  assert.equal(seen.reason.code, 'no_right');
  assert.equal(seen.reason.action, 'monetization.price');
  const res = await sent(
    await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE, member),
  );
  assert.equal(res.body.result.results[0].reason, 'no_right');
  assert.equal(t.fakes.ios.writes.length, 0);
});

dbTest(
  'step-up: with the policy on, sending a price needs a grant for the app, before anything is read',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    const policy = await t.call(t.owner, 'PUT', '/step-up/policy', {
      mode: 'hard_actions',
      actions: ['store.price'],
    });
    assert.equal(policy.status, 200, policy.text);
    const refused = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE),
    );
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'step_up_required');
    assert.equal(refused.body.action, 'store.price');
    assert.equal(t.fakes.ios.reads + t.fakes.ios.writes.length, 0);
    const verify = await t.call(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'store.price',
      target: { id: appId },
      password: PASSWORD,
    });
    assert.equal(verify.status, 200, verify.text);
    const done = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE, t.owner, {
        'x-step-up-grant': verify.body.grant,
      }),
    );
    assert.equal(done.body.result.results[0].status, 'ok');
    // Staging and the dry run stay free.
    assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/prices/dry-run`, {})).status, 200);
  },
);

// ----- the live read, partial failure, unknown ---------------------------------------------------------

dbTest(
  'stale price: the store moved since staging, so the item is refused, nothing is written and the draft stays',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    const row = t.stores.ios.products
      .find((p) => p.productId === COINS)
      ?.prices.find((x) => x.territory === 'JPN');
    if (row) row.amount = '300';
    const res = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE),
    );
    const r = res.body.result.results[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'stale_price');
    assert.equal(r.price.verification, 'not_sent');
    assert.equal(t.fakes.ios.writes.length, 0);
    assert.equal((await t.priceItems(appId)).length, 1);
    assert.equal((await t.audit('price.change_failed'))[0]?.detail.outcome, 'refused');
  },
);

dbTest(
  'partial failure: one product refused by the store, the other still goes; results per item with codes',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    await t.stage(appId, COINS);
    const pro = await t.stage(appId, PRO, {
      lines: [{ territory: 'USA', newAmount: '599', pricePointId: 'usa-599' }],
      existingSubscribers: 'preserve',
    });
    assert.equal(pro.status, 200, pro.text);
    t.fakes.ios.behavior = { refuse: { JPN: { code: 'price_change_not_allowed' } } };
    const items = await t.priceItems(appId);
    const phrase = 'CHANGE 2 PRICES MAX 34%';
    const res = await sent(
      await t.publish(
        appId,
        items.map((i) => ({ id: i.id, version: i.version })),
        phrase,
      ),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byProduct = Object.fromEntries(
      res.body.result.results.map((r: any) => [r.price.productId, r]),
    );
    assert.equal(byProduct[COINS].status, 'failed');
    assert.equal(byProduct[COINS].reason, 'price_change_not_allowed');
    assert.equal(byProduct[PRO].status, 'ok');
    assert.equal(byProduct[PRO].price.verification, 'confirmed');
    assert.equal(res.body.result.remaining, 1);
    assert.deepEqual(
      (await t.priceItems(appId)).map((i: any) => i.price.productId),
      [COINS],
      'the failed one stays staged',
    );
  },
);

dbTest(
  'a subset: only the named product is sent, and the phrase is for the named ones',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    await t.stage(appId, COINS);
    await t.stage(appId, PRO, {
      lines: [{ territory: 'USA', newAmount: '599', pricePointId: 'usa-599' }],
      existingSubscribers: 'preserve',
    });
    const items = await t.priceItems(appId);
    const coins = items.find((i: any) => i.price.productId === COINS);
    const res = await sent(
      await t.publish(appId, [{ id: coins?.id ?? '', version: coins?.version ?? '' }], PHRASE),
    );
    assert.equal(res.body.result.results.length, 1);
    assert.equal(t.fakes.ios.writes.length, 1);
    assert.equal(t.fakes.ios.writes[0]?.productId, COINS);
    assert.equal((await t.priceItems(appId)).length, 1);
  },
);

dbTest(
  'a lost answer: the read back settles it when the store applied, and blocks the next send when it did not',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    t.fakes.ios.behavior = { unknown: { applied: true } };
    const ok = await sent(await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE));
    assert.equal(ok.body.result.results[0].status, 'ok', JSON.stringify(ok.body));
    assert.equal(ok.body.result.results[0].price.lines[0].outcome, 'applied');

    const t2 = t;
    const app2 = await t2.addApp('ios');
    await t2.sync(app2);
    const staged2 = await t2.stage(app2, COINS, {
      lines: [{ territory: 'JPN', newAmount: '300', pricePointId: 'jpn-300' }],
    });
    assert.equal(staged2.status, 200, staged2.text);
    const [item2] = await t2.priceItems(app2);
    assert.ok(item2);
    const PHRASE2 = 'CHANGE 1 PRICE MAX 50%';
    t2.fakes.ios.behavior = { unknown: { applied: false } };
    const lost = await sent(
      await t2.publish(app2, [{ id: item2.id, version: item2.version }], PHRASE2),
    );
    assert.equal(lost.body.result.results[0].status, 'failed');
    assert.equal(lost.body.result.results[0].reason, 'outcome_unknown');
    assert.equal(
      String((await db.query('SELECT status FROM store_price_claims'))[0]?.status),
      'unknown',
    );
    t2.fakes.ios.behavior = {};
    const [again] = await t2.priceItems(app2);
    assert.equal((again?.reason as any).code, 'outcome_unknown', 'the cart says so');
    const dry = await t2.call(t2.owner, 'POST', `/apps/${app2}/prices/dry-run`, {});
    assert.equal(dry.status, 200);
    const after = await sent(
      await t2.publish(app2, [{ id: item2.id, version: item2.version }], PHRASE2),
    );
    assert.equal(
      after.body.result.results[0].status,
      'ok',
      'a successful live read settled the unknown outcome',
    );
  },
);

dbTest(
  'read after write: when the store shows another price the item says so and stays staged',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    const item = await stagedCoins(t, appId);
    t.fakes.ios.behavior = { writeInstead: '300' };
    const res = await sent(
      await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE),
    );
    const r = res.body.result.results[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.price.verification, 'store_shows');
    assert.deepEqual(r.price.mismatches, [{ territory: 'JPN', expected: '200', actual: '300' }]);
    assert.equal((await t.priceItems(appId)).length, 1);
  },
);

// ----- Google Play: existing subscribers -----------------------------------------------------------------

dbTest(
  'Google Play: the default keeps existing subscribers (no migration); opt-out needs its own acknowledgement',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t, 'android');
    const base = {
      planId: 'monthly',
      lines: [{ territory: 'US', newAmount: '549' }],
      effectiveDate: null,
    };
    const optOut = await t.stage(appId, 'pro_monthly', { ...base, existingSubscribers: 'opt_out' });
    assert.equal(optOut.status, 422);
    assert.equal(optOut.body.error, 'acknowledgement_required');
    assert.deepEqual(optOut.body.issues[0].detail.acks, ['existing_subscribers']);
    assert.equal(
      (await t.stage(appId, 'pro_monthly', { ...base, existingSubscribers: 'apply' })).body
        .issues[0].code,
      'subscriber_rule_invalid',
    );
    assert.equal(
      (
        await t.stage(appId, 'pro_monthly', {
          ...base,
          effectiveDate: '2099-01-01',
          existingSubscribers: 'preserve',
        })
      ).body.issues[0].code,
      'effective_date_unsupported',
    );
    const kept = await t.stage(appId, 'pro_monthly', { ...base, existingSubscribers: 'preserve' });
    assert.equal(kept.status, 200, kept.text);
    const [item] = await t.priceItems(appId);
    const done = await sent(
      await t.publish(
        appId,
        [{ id: item?.id ?? '', version: item?.version ?? '' }],
        'CHANGE 1 PRICE MAX 11%',
      ),
    );
    assert.equal(done.body.result.results[0].status, 'ok', JSON.stringify(done.body));
    assert.deepEqual(t.fakes.android.migrations, []);
    assert.equal(t.fakes.android.writes[0]?.existingSubscribers, 'preserve');
  },
);

dbTest(
  'Google Play: convert from a base price keeps only regions the plan has, in its own currency',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t, 'android');
    const res = await t.call(
      t.owner,
      'POST',
      t.productPath(appId, 'pro_monthly', '/price-convert'),
      { planId: 'monthly', baseTerritory: 'US', amount: '599' },
    );
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      res.body.prices.map((p: { territory: string }) => p.territory),
      ['US', 'DE'],
      'FR is not a region of the plan',
    );
    assert.equal(res.body.regionsVersion, '2025/03');
    assert.equal(t.fakes.android.writes.length, 0);
  },
);

// ----- the dry run, the price points, secrets ------------------------------------------------------------

dbTest(
  'dry run: reads live, validates, shows the store preview, writes nothing and works while the switch is off',
  async (db) => {
    const t = await bootPrices(db);
    const appId = await ready(t);
    await stagedCoins(t, appId);
    const dry = await t.call(t.owner, 'POST', `/apps/${appId}/prices/dry-run`, {});
    assert.equal(dry.status, 200, dry.text);
    const item = dry.body.dryRun.items[0];
    assert.deepEqual(item.issues, []);
    assert.equal(item.preview.mode, 'store');
    assert.equal(item.summary.largestBp, 3333);
    assert.equal(dry.body.dryRun.writesEnabled, true);
    assert.equal(t.fakes.ios.writes.length, 0);
    assert.equal(t.fakes.ios.previews, 1);
    assert.equal((await t.audit('price.dry_run')).length, 1);
    // A price that moved: the dry run reports it instead of previewing.
    const row = t.stores.ios.products
      .find((p) => p.productId === COINS)
      ?.prices.find((x) => x.territory === 'JPN');
    if (row) row.amount = '300';
    const moved = await t.call(t.owner, 'POST', `/apps/${appId}/prices/dry-run`, {});
    assert.equal(moved.body.dryRun.items[0].issues[0].code, 'stale_price');
    assert.equal(moved.body.dryRun.items[0].preview, null);
  },
);

dbTest('price points of a territory, lowest first; none for Google Play', async (db) => {
  const t = await bootPrices(db);
  const iosApp = await ready(t);
  const res = await t.call(
    t.owner,
    'GET',
    `${t.productPath(iosApp, COINS, '/price-points')}?territory=JPN`,
  );
  assert.deepEqual(
    res.body.pricePoints.map((p: { amount: string }) => p.amount),
    ['150', '200', '300'],
  );
  assert.equal(res.body.currency, 'JPY');
  const play = await ready(t, 'android');
  const none = await t.call(
    t.owner,
    'GET',
    `${t.productPath(play, 'pro_monthly', '/price-points')}?territory=US`,
  );
  assert.equal(none.body.applicable, false);
});

dbTest('a store refusal never leaks a secret into the results or the audit log', async (db) => {
  const t = await bootPrices(db);
  const appId = await ready(t);
  const item = await stagedCoins(t, appId);
  t.fakes.ios.behavior = {
    readError: new StoreError(
      'appstoreconnect',
      'forbidden',
      'forbidden: -----BEGIN PRIVATE KEY----- abc',
      403,
    ),
  };
  const res = await t.publish(appId, [{ id: item.id, version: item.version }], PHRASE);
  const text = await res.text();
  const rows = JSON.stringify(await t.audit('price.%'));
  assert.ok(!rows.includes('abc'), 'no secret in the audit log');
  assert.ok(!text.includes('abc'));
});
