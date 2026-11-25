import assert from 'node:assert/strict';
import test from 'node:test';
import { dbTest } from '@kiln/db/testing';
import type { Exchange } from '../../services/safe-fetch.ts';
import { bootStaged } from '../publish/test-helpers.ts';
import { clearAssetIndexes } from './asset-repo.ts';
import { withinDeadline } from './compare-deadline.ts';
import { clearStoreImageCaches } from './store-images.ts';
import { iosListing } from './test-helpers.ts';

/**
 * The comparison of the Assets step of Prepare release always ends (docs/adr/0066-assets-step-bounded-reads.md): a slow store or a slow
 * repository answers `504 compare_timeout` after the deadline instead of keeping the request open, the next read works, an app without a
 * repository or with nothing to compare answers an explicit empty comparison, and none of it needs the `compareMedia` setting.
 */

const never = <T>() => new Promise<T>(() => undefined);
const exchange: Exchange = async () => ({
  status: 404,
  headers: {},
  body: new Uint8Array(0),
  overflow: false,
});
const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];

async function boot(db: Parameters<typeof bootStaged>[0]) {
  clearStoreImageCaches();
  clearAssetIndexes();
  return bootStaged(db, {
    extra: { assetSync: { compareDeadlineMs: 80, net: { resolve, exchange } } },
  });
}

test('withinDeadline: the work wins, or a coded 504 that is retryable', async () => {
  assert.deepEqual(await withinDeadline(Promise.resolve({ ok: true }), 50), { ok: true });
  const late = await withinDeadline(never<{ ok: true }>(), 20);
  assert.equal(late.ok, false);
  if (!late.ok) {
    assert.equal(late.status, 504);
    assert.equal(late.body.error, 'compare_timeout');
    assert.equal(late.body.code, 'assets.compareTimeout');
  }
  await assert.rejects(withinDeadline(Promise.reject(new Error('boom')), 50), /boom/);
});

dbTest(
  'a store that never answers: 504 compare_timeout within the deadline, and the next read works',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios');
    const real = t.stores.ios.readStoreImages.bind(t.stores.ios);
    t.stores.ios.readStoreImages = () => never();
    const started = Date.now();
    const slow = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff?fresh=1`);
    assert.equal(slow.status, 504, slow.text);
    assert.equal(slow.body.error, 'compare_timeout');
    assert.equal(slow.body.code, 'assets.compareTimeout');
    assert.ok(Date.now() - started < 5000, 'the request did not stay open');
    t.stores.ios.readStoreImages = real;
    const again = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff?fresh=1`);
    assert.equal(again.status, 200, again.text);
  },
);

dbTest('a repository that never answers: 504 compare_timeout, not an open request', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  t.repo.listBlobEntries = () => never();
  t.repo.listFiles = () => never();
  t.repo.resolveCommit = () => never();
  const res = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff?fresh=1`);
  assert.equal(res.status, 504, res.text);
  assert.equal(res.body.error, 'compare_timeout');
});

dbTest(
  'no repository: an explicit empty comparison (repoStatus no_repository), no setting needed',
  async (db) => {
    const t = await boot(db);
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform: 'ios',
      identifier: 'com.acme.other',
      credentialId: t.iosCredential,
      name: 'No repo',
    });
    const app = res.body.app.id as string;
    t.readStores.ios.listing = iosListing({ 'en-US': { name: 'No repo' } });
    assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/sync`)).status, 200);
    const before = t.repo.listCalls;
    const diff = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff`);
    assert.equal(diff.status, 200, diff.text);
    assert.equal(diff.body.diff.repoStatus, 'no_repository');
    assert.equal(t.repo.listCalls, before, 'the repository was not read');
  },
);

dbTest(
  'an empty repository and an empty store: a comparison with no sets, repoStatus ok',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios');
    t.repo.files = new Map();
    t.repo.blobs = new Map();
    t.stores.ios.imageRecords = [];
    const diff = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff?fresh=1`);
    assert.equal(diff.status, 200, diff.text);
    assert.equal(diff.body.diff.repoStatus, 'ok');
    assert.deepEqual(diff.body.diff.sets, []);
    assert.equal(
      diff.body.diff.totals.differs +
        diff.body.diff.totals.only_repo +
        diff.body.diff.totals.only_store,
      0,
    );
  },
);
