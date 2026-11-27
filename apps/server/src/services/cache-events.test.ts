import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { clearCurrentReadiness } from '../modules/publish/current-readiness.ts';
import { resolveRef } from '../modules/listing/store-images.ts';
import { bootStaged } from '../modules/publish/test-helpers.ts';
import { cacheEvents, emitCacheEvent } from './cache-registry.ts';

/**
 * The events that make caches stale reach them from the places where things change (docs/state-model.md, "Caches and events"):
 * a sync, a push, a staged change, a new version, a build. The registry test checks WHICH caches declared which event; this one
 * checks the other half: the code that changes things really fires the event, and a fired event really empties the cache.
 */

async function boot(db: Parameters<typeof bootStaged>[0]) {
  clearCurrentReadiness();
  const t = await bootStaged(db, { extra: { storePublish: { enabled: true } } });
  t.submitStores.ios.imageSize = [2064, 2752];
  const app = await t.addApp('ios', 'Event App');
  const [row] = await db.query('SELECT workspace_id FROM apps WHERE id = ?', [app]);
  const workspaceId = String(row?.workspace_id);
  const readiness = async (fresh = false) =>
    (await t.call(t.owner, 'GET', `/apps/${app}/publish/readiness${fresh ? '?fresh=1' : ''}`)).body
      .readiness as { cached: boolean };
  const images = async (fresh = false) =>
    (await t.call(t.owner, 'GET', `/apps/${app}/assets/store${fresh ? '?fresh=1' : ''}`)).body as {
      cached: boolean;
    };
  return { ...t, app, workspaceId, readiness, images };
}

dbTest('every event drops the cached readiness and the store images it declared, and only for its app', async (db) => {
  const t = await boot(db);
  const other = await t.addApp('ios', 'Other App');
  const readinessOf = async (app: string) =>
    (await t.call(t.owner, 'GET', `/apps/${app}/publish/readiness`)).body.readiness as { cached: boolean };
  const REGISTERED: Record<string, readonly string[]> = {
    readiness: ['store_read', 'sync', 'publish', 'release_changed', 'build_changed', 'staged_changed'],
    images: ['store_read', 'sync', 'publish', 'release_changed'],
  };
  for (const event of cacheEvents) {
    assert.equal((await t.readiness()).cached, false, `${event}: first read`);
    assert.equal((await t.readiness()).cached, true, `${event}: filled`);
    await readinessOf(other);
    assert.equal((await t.images(true)).cached, false);
    assert.equal((await t.images()).cached, true, `${event}: images filled`);
    emitCacheEvent(event, { workspaceId: t.workspaceId, appId: t.app });
    const drops = REGISTERED.readiness?.includes(event) === true;
    assert.equal((await t.readiness()).cached, !drops, `${event}: readiness ${drops ? 'dropped' : 'kept'}`);
    const dropsImages = REGISTERED.images?.includes(event) === true;
    assert.equal((await t.images()).cached, !dropsImages, `${event}: images ${dropsImages ? 'dropped' : 'kept'}`);
    assert.equal((await readinessOf(other)).cached, true, `${event}: another app keeps its reading`);
    clearCurrentReadiness();
  }
});

dbTest('staging, unstaging and clearing fire staged_changed: the readiness judges the staged push as it is now', async (db) => {
  const t = await boot(db);
  await t.readiness();
  assert.equal((await t.readiness()).cached, true);
  const staged = await t.stageText(t.app, { locale: 'en-US', field: 'description', from: 'local', value: 'A new description' });
  assert.equal(staged.status, 200, staged.text.slice(0, 200));
  assert.equal((await t.readiness()).cached, false, 'a staged text drops it');
  assert.equal((await t.readiness()).cached, true);
  const id = staged.body.staged.text[0].id as string;
  assert.equal((await t.unstage(t.app, id)).status, 200);
  assert.equal((await t.readiness()).cached, false, 'unstaging drops it');
  assert.equal((await t.readiness()).cached, true);
  assert.equal((await t.stageText(t.app, { locale: 'en-US', field: 'description', from: 'local', value: 'Again' })).status, 200);
  assert.equal((await t.readiness()).cached, false);
  assert.equal((await t.readiness()).cached, true);
  assert.equal((await t.clear(t.app)).status, 200);
  assert.equal((await t.readiness()).cached, false, 'clearing drops it');
});

dbTest('a sync fires sync (the readiness and the store images are read again)', async (db) => {
  const t = await boot(db);
  await t.images(true);
  await t.readiness();
  assert.equal((await t.readiness()).cached, true);
  assert.equal((await t.images()).cached, true);
  const sync = await t.call(t.owner, 'POST', `/apps/${t.app}/sync`);
  assert.equal(sync.status, 200, sync.text.slice(0, 200));
  assert.equal((await t.readiness()).cached, false);
  assert.equal((await t.images()).cached, false);
});

dbTest('an image ref is dropped with the view that made it (a ref never outlives a read the server threw away)', async (db) => {
  const t = await boot(db);
  t.stores.ios.imageRecords = [
    {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      target: 'APP_IPHONE_65',
      position: 1,
      id: 'a1',
      name: 's1.png',
      width: 1242,
      height: 2688,
      bytes: null,
      checksum: null,
      checksumKind: null,
      state: 'COMPLETE',
      url: 'https://is1.mzstatic.com/image/thumb/Pic1/{w}x{h}bb.{f}',
      urlKind: 'apple_template',
    },
  ];
  const body = await t.images(true);
  const refs: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === 'ref' && typeof x === 'string') refs.push(x);
        else walk(x);
      }
  };
  walk(body);
  assert.ok(refs.length > 0, 'the view carries refs');
  const now = Date.now();
  const known = (ref: string) => resolveRef(ref, t.workspaceId, t.app, now) !== undefined;
  assert.equal(known(refs[0] as string), true);
  for (const event of ['store_read', 'sync', 'publish', 'release_changed'] as const) {
    await t.images(true);
    assert.equal(known(refs[0] as string), true, `${event}: read again, known again`);
    emitCacheEvent(event, { workspaceId: t.workspaceId, appId: t.app });
    assert.equal(known(refs[0] as string), false, `${event}: dropped`);
  }
  await t.images(true);
  emitCacheEvent('staged_changed', { workspaceId: t.workspaceId, appId: t.app });
  assert.equal(known(refs[0] as string), true, 'a staged change does not touch the store read');
});
