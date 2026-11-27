import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { clearCurrentReadiness } from './current-readiness.ts';
import { bootStaged } from './test-helpers.ts';

/**
 * What stands in the way of a submit NOW (`GET /apps/:id/publish/readiness`): the blockers a run kept are true of the moment it ran, this
 * is the answer from the store as it is now, counted per store set. The user's case: 12 iPad 13" screenshots and an empty fr-FR when the
 * run was blocked; the person then removed two screenshots, and a sync did not change what Kiln said.
 */

const GROUP = 'APP_IPAD_PRO_3GEN_129';
const SIBLING = 'APP_IPAD_PRO_129';

async function boot(db: Parameters<typeof bootStaged>[0], options: { submit?: boolean } = {}) {
  clearCurrentReadiness();
  const t = await bootStaged(db, {
    ...(options.submit === undefined ? {} : { submit: { enabled: options.submit } }),
    extra: { storePublish: { enabled: true } },
  });
  t.submitStores.ios.imageSize = [2064, 2752];
  const readiness = (app: string, fresh = false, cookie = t.owner) =>
    t.call(cookie, 'GET', `/apps/${app}/publish/readiness${fresh ? '?fresh=1' : ''}`);
  return { ...t, readiness };
}

const files = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    name: `s${from + i + 1}.png`,
    bytes: new Uint8Array([from + i + 1, 7, 7]),
  }));

const blank = (t: Awaited<ReturnType<typeof boot>>, fields: string[]) => {
  t.stores.ios.locales.add('fr-FR');
  for (const field of fields) t.submitStores.ios.textOverrides.set(`fr-FR\u0000${field}`, null);
};
const codes = (body: any): string[] =>
  (body.readiness.blockers as { code: string; locale?: string; item?: string }[]).map(
    (b) => `${b.code}:${b.locale ?? ''}:${b.item ?? ''}`,
  );

dbTest(
  '12 screenshots in one display type and an empty fr-FR: the blockers say which set is over, and how much',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios', 'OSS Document Scanner');
    blank(t, ['description', 'keywords', 'support_url']);
    t.stores.ios.seedSet('en-US', GROUP, files(12));
    const res = await t.readiness(app);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const r = res.body.readiness;
    assert.equal(r.ready, false);
    assert.equal(r.cached, false);
    assert.equal(typeof r.storeReadAt, 'number');
    const count = r.blockers.find((b: any) => b.code === 'asset_spec');
    assert.match(count.message, /\(APP_IPAD_PRO_3GEN_129\): 12 found\.$/);
    assert.deepEqual(count.params, { count: 12, max: 10, device: 'ipad_13', set: GROUP });
    assert.equal(count.fix.kind, 'screenshots');
    assert.equal(r.blockers.filter((b: any) => b.code === 'missing_text').length, 3);
  },
);

dbTest('10 in the 13" set and 2 in the 12.9" set are two sets: nothing is over', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios', 'OSS Document Scanner');
  t.stores.ios.seedSet('en-US', GROUP, files(10));
  t.stores.ios.seedSet('en-US', SIBLING, files(2, 10));
  const res = await t.readiness(app);
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.body.readiness.ready, true, JSON.stringify(res.body.readiness.blockers));
  assert.deepEqual(codes(res.body), []);
});

dbTest(
  'the answer is kept for 30 seconds; "Check again" (fresh) asks the store again and sees the screenshots removed since',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios', 'OSS Document Scanner');
    blank(t, ['description']);
    t.stores.ios.seedSet('en-US', GROUP, files(12));
    const first = await t.readiness(app);
    assert.ok(codes(first.body).some((c) => c.startsWith('asset_spec')));
    const reads = t.submitStores.ios.reads;
    // The person removes two screenshots in the store's own console.
    t.stores.ios.seedSet('en-US', GROUP, files(10));
    const kept = await t.readiness(app);
    assert.equal(kept.body.readiness.cached, true);
    assert.equal(t.submitStores.ios.reads, reads, 'the cache answered, no store read');
    assert.ok(
      codes(kept.body).some((c) => c.startsWith('asset_spec')),
      'still the old picture inside the 30 s',
    );
    const fresh = await t.readiness(app, true);
    assert.equal(fresh.body.readiness.cached, false);
    assert.ok(t.submitStores.ios.reads > reads);
    assert.deepEqual(codes(fresh.body), ['missing_text:fr-FR:description']);
  },
);

dbTest(
  'a sync of the app drops the cached readiness: the next read sees the store as it is',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios', 'OSS Document Scanner');
    t.stores.ios.seedSet('en-US', GROUP, files(12));
    assert.ok(
      codes(await t.readiness(app).then((r) => r.body)).some((c) => c.startsWith('asset_spec')),
    );
    t.stores.ios.seedSet('en-US', GROUP, files(10));
    const sync = await t.call(t.owner, 'POST', `/apps/${app}/sync`);
    assert.equal(sync.status, 200, sync.text.slice(0, 300));
    const after = await t.readiness(app);
    assert.equal(after.body.readiness.cached, false);
    assert.deepEqual(codes(after.body), []);
    assert.equal(after.body.readiness.ready, true);
  },
);

dbTest('everything fixed: ready, with the version the submit would send', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios', 'OSS Document Scanner');
  t.stores.ios.seedSet('en-US', GROUP, files(10));
  const res = await t.readiness(app, true);
  assert.equal(res.body.readiness.ready, true);
  assert.equal(
    typeof res.body.readiness.versionString === 'string' ||
      res.body.readiness.versionString === null,
    true,
  );
});

dbTest('needs the right to submit and the submit switch', async (db) => {
  const off = await boot(db, { submit: false });
  const app = await off.addApp('ios', 'OSS Document Scanner');
  const refused = await off.readiness(app);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'store_submit_disabled');
  const unknown = await off.call(off.owner, 'GET', '/apps/does-not-exist/publish/readiness');
  assert.ok([404, 409].includes(unknown.status));
});

dbTest(
  '"Read again" of the store graphics drops the cached readiness, and "Check again" drops the cached graphics',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios', 'OSS Document Scanner');
    t.stores.ios.seedSet('en-US', GROUP, files(12));
    assert.ok(codes((await t.readiness(app)).body).some((c) => c.startsWith('asset_spec')));
    const images = (fresh: boolean) =>
      t.call(t.owner, 'GET', `/apps/${app}/assets/store${fresh ? '?fresh=1' : ''}`);
    const before = await images(false);
    assert.equal(before.status, 200, before.text.slice(0, 200));
    t.stores.ios.seedSet('en-US', GROUP, files(10));
    // The graphics tab reads again: the readiness cache goes with it.
    assert.equal((await images(true)).body.cached, false);
    const after = await t.readiness(app);
    assert.equal(after.body.readiness.cached, false);
    assert.deepEqual(codes(after.body), []);
    // And the other way round: a "Check again" leaves no old picture of the graphics behind.
    assert.equal((await images(false)).body.cached, true);
    await t.readiness(app, true);
    assert.equal((await images(false)).body.cached, false);
  },
);

dbTest(
  'two apps of one workspace with other locales: the readiness of one never carries a locale of the other, cached, fresh or interleaved',
  async (db) => {
    const t = await boot(db);
    const scanner = await t.addApp('ios', 'OSS Document Scanner');
    const wallet = await t.addApp('ios', 'OSS CardWallet');
    // The scanner's store holds fr-FR with no text; the wallet's own store holds en-US only.
    blank(t, ['description', 'keywords', 'support_url']);
    const walletStore = t.ownStoreFor('com.acme.app2');
    walletStore.draft.seedSet('en-US', GROUP, files(3));
    const frOf = (body: any) =>
      (body.readiness.blockers as { locale?: string }[]).filter((b) => b.locale === 'fr-FR');
    // Interleaved: both reads are in flight together.
    const [a, b] = await Promise.all([t.readiness(scanner), t.readiness(wallet)]);
    assert.equal(a.status, 200, a.text.slice(0, 300));
    assert.equal(b.status, 200, b.text.slice(0, 300));
    assert.equal(frOf(a.body).length, 3, 'the scanner has fr-FR');
    assert.equal(frOf(b.body).length, 0, 'the wallet never gets the scanner locales');
    // Cached (30 s) and fresh, in the other order.
    for (const fresh of [false, true, false]) {
      const w = await t.readiness(wallet, fresh);
      const s = await t.readiness(scanner, fresh);
      assert.equal(frOf(w.body).length, 0);
      assert.equal(frOf(s.body).length, 3);
    }
    // Where the locale comes from is named: the scanner's fr-FR is in the store's draft.
    const missing = a.body.readiness.blockers.find((x: any) => x.code === 'missing_text');
    assert.equal(missing.params.source, 'store_draft');
    assert.equal(typeof missing.params.version, 'string');
  },
);
