import assert from 'node:assert/strict';
import type { StoreImageRecord } from '@kiln/connectors';
import { ASSET_SYNC_LIMITS, groupStoreImages, readImageHeader, storeSideOf } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { rgbaPng, rgbPng } from '../../png-test-helpers.ts';
import { decodePng } from '../../services/png-codec.ts';
import type { Exchange, ExchangeRequest } from '../../services/safe-fetch.ts';
import {
  bootStaged,
  type StagedBoot,
  type StagedBootOptions,
  sha256,
} from '../publish/test-helpers.ts';
import { clearStoreImageCaches } from './store-images.ts';

/**
 * Two way sync of graphics (docs/api/assets.md, docs/adr/0012-assets-two-way-sync.md): reading the store, the comparison, the
 * thumbnail proxy, pulling into a change set, uploads, replace, remove and fix, and staged sets into the repository. Everything
 * runs against fakes: no store, CDN or GitHub is contacted.
 */

export const SHOTS = 'fastlane/metadata/ios/screenshots/en-US';
export const PLAY_SHOTS = 'fastlane/metadata/android/en-US/images/phoneScreenshots';
const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];

/** A fake CDN: answers by URL path (or `*`), remembers every request. */
export function cdn(bodies: Record<string, Uint8Array> = {}) {
  const seen: ExchangeRequest[] = [];
  const exchange: Exchange = async (request) => {
    seen.push(request);
    // A Google address carries a size option (`=s0`, `=s160`); the fake answers the same file for any of them.
    const body = bodies[request.url.pathname.replace(/=s\d+$/, '')] ?? bodies['*'];
    if (!body) return { status: 404, headers: {}, body: new Uint8Array(0), overflow: false };
    return { status: 200, headers: { 'content-type': 'text/html' }, body, overflow: false };
  };
  return { seen, exchange };
}

export const boot = async (
  db: Parameters<typeof bootStaged>[0],
  net: ReturnType<typeof cdn>,
  options: StagedBootOptions = {},
) => {
  clearStoreImageCaches();
  return bootStaged(db, {
    ...options,
    extra: { assetSync: { net: { resolve, exchange: net.exchange } } },
  });
};

export const apple = (
  position: number,
  over: Partial<StoreImageRecord> = {},
): StoreImageRecord => ({
  locale: 'en-US',
  kind: 'screenshot',
  device: 'iphone_6_5',
  target: 'APP_IPHONE_65',
  position,
  id: `a${position}`,
  name: `s${position}.png`,
  width: 1242,
  height: 2688,
  bytes: null,
  checksum: null,
  checksumKind: null,
  state: 'COMPLETE',
  url: `https://is1.mzstatic.com/image/thumb/Pic${position}/{w}x{h}bb.{f}`,
  urlKind: 'apple_template',
  ...over,
});
export const play = (position: number, over: Partial<StoreImageRecord> = {}): StoreImageRecord => ({
  locale: 'en-US',
  kind: 'screenshot',
  device: 'phone',
  target: 'phoneScreenshots',
  position,
  id: `p${position}`,
  name: null,
  width: null,
  height: null,
  bytes: null,
  checksum: null,
  checksumKind: null,
  state: null,
  url: `https://play-lh.googleusercontent.com/img${position}`,
  urlKind: 'play_url',
  ...over,
});

export const API = (t: StagedBoot, path: string) => `/api/workspaces/${t.workspaceId}${path}`;
/** A request with a raw body (the upload routes). */
export async function raw(
  t: StagedBoot,
  method: string,
  path: string,
  body?: Uint8Array,
  cookie = t.owner,
) {
  const res = await t.app.request(API(t, path), {
    method,
    headers: { cookie, 'content-type': 'application/octet-stream' },
    ...(body ? { body } : {}),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = res.headers.get('content-type')?.includes('json')
    ? new TextDecoder().decode(bytes)
    : '';
  return {
    status: res.status,
    headers: res.headers,
    bytes,
    text,
    body: text ? JSON.parse(text) : null,
  };
}
export const slot = 'locale=en-US&kind=screenshot&device=iphone_6_5';
export const SHOT = rgbPng(1242, 2688, () => [10, 20, 30]);

// ----- the store, the comparison and the thumbnail proxy ------------------------------------------

dbTest(
  'the store view has opaque refs and no address, is cached, and is audited without a secret',
  async (db) => {
    const t = await boot(db, cdn());
    const app = await t.addApp('ios');
    t.stores.ios.imageRecords = [apple(1), apple(2), apple(1, { locale: 'de-DE' })];
    const a = await t.call(t.owner, 'GET', `/apps/${app}/assets/store`);
    assert.equal(a.status, 200, a.text);
    assert.equal(a.body.cached, false);
    const set = a.body.store.sets.find((s: { locale: string }) => s.locale === 'en-US');
    assert.equal(set.files.length, 2);
    assert.match(set.files[0].ref, /^[0-9a-f]{32}$/);
    assert.equal(set.files[0].downloadable, true);
    assert.equal(a.body.store.version.editable, true);
    assert.ok(!/mzstatic|https?:\/\//.test(a.text), 'a client never receives a store address');
    const b = await t.call(t.owner, 'GET', `/apps/${app}/assets/store`);
    assert.equal(b.body.cached, true);
    assert.equal(t.stores.ios.imageReads, 1, 'the second read came from the cache');
    const c = await t.call(t.owner, 'GET', `/apps/${app}/assets/store?fresh=1`);
    assert.equal(c.body.cached, false);
    assert.equal(t.stores.ios.imageReads, 2);
    const uses = await t.audit('credential.use');
    assert.ok(uses.some((u) => u.detail.purpose === 'store.images_read'));
    assert.equal(t.stores.ios.applyCalls, 0, 'reading never writes');
  },
);

dbTest(
  'the store is read with the viewer role, a failure is a clear message, and an unknown app is 404',
  async (db) => {
    const t = await boot(db, cdn());
    const app = await t.addApp('ios');
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', `/apps/${app}/assets/store`)).status, 200);
    t.stores.ios.imageReadError = new Error('the store is down');
    const failed = await t.call(t.owner, 'GET', `/apps/${app}/assets/store?fresh=1`);
    assert.equal(failed.status, 502);
    assert.equal(
      (await t.call(t.owner, 'GET', '/apps/00000000-0000-0000-0000-000000000000/assets/store'))
        .status,
      404,
    );
  },
);

dbTest(
  'the diff says identical, probably the same, only in the store, and fills the counts of the Assets tab',
  async (db) => {
    const t = await boot(db, cdn());
    const app = await t.addApp('ios');
    const first = t.files[`${SHOTS}/1_iphone65.png`] as Buffer;
    t.stores.ios.imageRecords = [
      apple(1, { checksum: sha256(first).slice(0, 32), checksumKind: 'sha256' }),
      apple(2),
      apple(3),
      apple(1, { locale: 'de-DE' }),
    ];
    const before = await t.call(t.owner, 'GET', `/apps/${app}/assets`);
    assert.equal(before.body.storeSide, null, 'the index is the repository only: the store counts come from the view (storeSideOf of core)');
    const res = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff`);
    assert.equal(res.status, 200, res.text);
    const set = res.body.diff.sets.find(
      (s: { locale: string; device: string }) => s.locale === 'en-US' && s.device === 'iphone_6_5',
    );
    assert.deepEqual(
      set.rows.map((r: { status: string }) => r.status),
      ['identical', 'likely_same', 'only_store'],
    );
    assert.equal(set.inSync, false);
    assert.equal(set.rows[0].repo.path, `${SHOTS}/1_iphone65.png`);
    assert.ok(set.rows[0].store.ref);
    const de = res.body.diff.sets.find((s: { locale: string }) => s.locale === 'de-DE');
    assert.deepEqual(
      de.rows.map((r: { status: string }) => r.status),
      ['only_store'],
    );
    assert.deepEqual(res.body.diff.totals, {
      identical: 1,
      likely_same: 1,
      differs: 0,
      only_repo: 0,
      only_store: 2,
    });
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/assets/store`)).body.store;
    const side = storeSideOf(view);
    assert.equal(side.counts.find((c) => c.locale === 'en-US' && c.device === 'iphone_6_5')?.count, 3);
    assert.equal(typeof side.observedAt, 'number');
  },
);

dbTest(
  'a different checksum is "differs", and a file only in the repository is shown',
  async (db) => {
    const t = await boot(db, cdn());
    const app = await t.addApp('android');
    const one = t.files[`${PLAY_SHOTS}/1.png`] as Buffer;
    t.stores.android.imageRecords = [
      play(1, { checksum: sha256(one), checksumKind: 'sha256' }),
      play(2, { checksum: 'f'.repeat(64), checksumKind: 'sha256' }),
    ];
    const res = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff`);
    const phone = (body: { diff: { sets: { locale: string; device: string }[] } }) =>
      body.diff.sets.find((s) => s.locale === 'en-US' && s.device === 'phone') as unknown as {
        rows: { status: string }[];
      };
    assert.deepEqual(
      phone(res.body).rows.map((r) => r.status),
      ['identical', 'differs'],
    );
    t.stores.android.imageRecords = [play(1, { checksum: sha256(one), checksumKind: 'sha256' })];
    const again = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff?fresh=1`);
    assert.deepEqual(
      phone(again.body).rows.map((r) => r.status),
      ['identical', 'only_repo'],
    );
  },
);

dbTest(
  'the thumbnail proxy fetches from the allowed host only, sniffs the bytes, sets safe headers and answers 304',
  async (db) => {
    const body = rgbPng(3, 2, () => [1, 2, 3]);
    const net = cdn({ '*': body });
    const t = await boot(db, net);
    const app = await t.addApp('ios');
    t.stores.ios.imageRecords = [apple(1), apple(2, { url: 'https://evil.test/{w}x{h}bb.{f}' })];
    const view = await t.call(t.owner, 'GET', `/apps/${app}/assets/store`);
    const [good, bad] = view.body.store.sets[0].files as { ref: string }[];
    const res = await raw(t, 'GET', `/apps/${app}/assets/store/thumb?ref=${good?.ref}&size=160`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'image/png',
      'the type is the sniffed one, not the answer header',
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(net.seen.length, 1);
    assert.equal(net.seen[0]?.url.hostname, 'is1.mzstatic.com');
    assert.match(
      net.seen[0]?.url.pathname ?? '',
      /74x160bb\.jpg$/,
      'a thumbnail of the asked size is requested from Apple',
    );
    assert.equal(net.seen[0]?.headers.cookie, undefined);
    const etag = res.headers.get('etag') ?? '';
    const second = await t.app.request(
      API(t, `/apps/${app}/assets/store/thumb?ref=${good?.ref}&size=160`),
      { headers: { cookie: t.owner, 'if-none-match': etag } },
    );
    assert.equal(second.status, 304);
    assert.equal(net.seen.length, 1, 'a 304 costs no fetch');
    const blocked = await raw(t, 'GET', `/apps/${app}/assets/store/thumb?ref=${bad?.ref}`);
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error, 'image_blocked');
    assert.equal(net.seen.length, 1, 'an address off the list is never fetched');
    assert.equal(
      (await raw(t, 'GET', `/apps/${app}/assets/store/thumb?ref=../../etc/passwd`)).status,
      400,
    );
    const unknown = await raw(t, 'GET', `/apps/${app}/assets/store/thumb?ref=${'0'.repeat(32)}`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'ref_expired');
    const other = await t.addApp('ios');
    assert.equal(
      (await raw(t, 'GET', `/apps/${other}/assets/store/thumb?ref=${good?.ref}`)).status,
      404,
      'another app cannot use the ref',
    );
  },
);

dbTest('a redirect off the allowlist is refused', async (db) => {
  let calls = 0;
  const net = {
    seen: [],
    exchange: (async () => {
      calls++;
      return {
        status: 302,
        headers: { location: 'https://evil.test/x' },
        body: new Uint8Array(0),
        overflow: false,
      };
    }) as Exchange,
  };
  const t = await boot(db, net);
  const app = await t.addApp('ios');
  t.stores.ios.imageRecords = [apple(1)];
  const view = await t.call(t.owner, 'GET', `/apps/${app}/assets/store`);
  const ref = view.body.store.sets[0].files[0].ref as string;
  const res = await raw(t, 'GET', `/apps/${app}/assets/store/thumb?ref=${ref}`);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'image_blocked');
  assert.equal(calls, 1, 'the redirect target was never contacted');
});

// ----- pull --------------------------------------------------------------------------------------

dbTest(
  'pull (Google Play): files are checked against the store checksum, a change set is drafted, nothing is written anywhere',
  async (db) => {
    const good = rgbPng(1080, 1920, () => [9, 9, 9]);
    const other = rgbPng(1080, 1920, () => [8, 8, 8]);
    const net = cdn({ '/img1': good, '/img2': other, '/img3': good });
    const t = await boot(db, net);
    const app = await t.addApp('android');
    t.stores.android.imageRecords = [1, 2, 3].map((i) =>
      play(i, { checksum: sha256(good), checksumKind: 'sha256' }),
    );
    const res = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {});
    assert.equal(res.status, 200, res.text);
    const pull = res.body.pull;
    assert.equal(pull.skipped.length, 1);
    assert.equal(pull.skipped[0].reason, 'checksum_mismatch');
    assert.match(pull.skipped[0].key, /android\/en-US\/screenshot:phone#2/);
    assert.equal(pull.unverified.length, 0);
    assert.equal(pull.written, 2, 'position 1 replaces a file, position 3 is new');
    const cs = pull.changeSet;
    assert.equal(cs.status, 'draft');
    assert.equal(cs.origin.source, 'store_assets_pull');
    assert.deepEqual(cs.files.map((f: { path: string }) => f.path).sort(), [
      `${PLAY_SHOTS}/1.png`,
      `${PLAY_SHOTS}/phone-03.png`,
    ]);
    assert.ok(
      cs.files.every(
        (f: { binary?: boolean; after?: string }) => f.binary === true && f.after === undefined,
      ),
      'bytes are never put in a view',
    );
    assert.ok(!res.text.includes(good.toString('base64').slice(0, 60)), 'no base64 in the answer');
    assert.ok(!res.text.includes('googleusercontent'), 'no store address in the answer');
    const row = (await db.query('SELECT files_json FROM change_sets WHERE id = ?', [cs.id]))[0];
    const stored = JSON.parse(String(row?.files_json)) as {
      path: string;
      before?: string;
      after: string;
      encoding: string;
    }[];
    assert.ok(stored.every((f) => f.encoding === 'base64'));
    const replaced = stored.find((f) => f.path.endsWith('/1.png'));
    assert.equal(
      replaced?.before,
      (t.files[`${PLAY_SHOTS}/1.png`] as Buffer).toString('base64'),
      'the old bytes are the precondition',
    );
    assert.equal(replaced?.after, good.toString('base64'));
    assert.equal(t.repo.proposals.length, 0, 'nothing was proposed or written to the repository');
    assert.equal(t.stores.android.applyCalls, 0);
    const events = await t.events('assets.pulled');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.changeSetId, cs.id);
    assert.ok(!JSON.stringify(events).includes('googleusercontent'));
    const audit = await t.audit('assets.pulled');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.detail.written, 2);
    assert.ok(!JSON.stringify(audit).includes('.png'), 'no file name in the audit');
    const got = await t.call(t.owner, 'GET', `/change-sets/${cs.id}`);
    assert.ok(
      got.body.changeSet.files.every((f: { bytes?: number }) => typeof f.bytes === 'number'),
    );
  },
);

dbTest(
  'pull (App Store): files are taken but reported unverified; identical bytes are not touched; prune removes extras',
  async (db) => {
    const same = rgbPng(1242, 2688, () => [1, 1, 1]);
    const files = {
      [`${SHOTS}/1_iphone65.png`]: same,
      [`${SHOTS}/2_iphone65.png`]: rgbPng(1242, 2688, () => [2, 2, 2]),
      [`${SHOTS}/3_iphone65.png`]: rgbPng(1242, 2688, () => [3, 3, 3]),
      'fastlane/metadata/ios/en-US/description.txt': 'Hello',
    };
    const fresh = rgbPng(1242, 2688, () => [200, 1, 1]);
    const net = cdn({
      '/image/thumb/Pic1/1242x2688bb.png': same,
      '/image/thumb/Pic2/1242x2688bb.png': fresh,
    });
    const t = await boot(db, net, { files });
    const app = await t.addApp('ios');
    t.stores.ios.imageRecords = [apple(1), apple(2)];
    const res = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, { prune: true });
    assert.equal(res.status, 200, res.text);
    const pull = res.body.pull;
    assert.equal(pull.unverified.length, 2, 'the App Store gives no checksum');
    assert.equal(pull.unchanged, 1, 'position 1 is the same file');
    assert.equal(pull.written, 1);
    assert.equal(pull.deleted, 1, 'the third file is not in the store');
    const paths = pull.changeSet.files
      .map((f: { path: string; change: string }) => `${f.change}:${f.path}`)
      .sort();
    assert.deepEqual(paths, [
      `deleted:${SHOTS}/3_iphone65.png`,
      `modified:${SHOTS}/2_iphone65.png`,
    ]);
    const keep = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {
      files: ['ios/en-US/screenshot:iphone_6_5#2'],
    });
    assert.equal(keep.status, 200, keep.text);
    assert.equal(keep.body.pull.deleted, 0);
    assert.equal(keep.body.pull.changeSet.files.length, 1);
  },
);

dbTest(
  'pull: a selection that is not in the store is refused, and a store with nothing new drafts nothing',
  async (db) => {
    const same = rgbPng(1080, 1920, () => [5, 5, 5]);
    const t = await boot(db, cdn({ '*': same }), {
      files: { [`${PLAY_SHOTS}/1.png`]: same, 'fastlane/metadata/android/en-US/title.txt': 'T' },
    });
    const app = await t.addApp('android');
    t.stores.android.imageRecords = [play(1, { checksum: sha256(same), checksumKind: 'sha256' })];
    const bad = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {
      sets: ['android/en-US/screenshot:tablet_7'],
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, 'unknown_selection');
    const nothing = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {});
    assert.equal(nothing.status, 200, nothing.text);
    assert.equal(nothing.body.pull.changeSet, null);
    assert.equal(nothing.body.pull.unchanged, 1);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM change_sets'))[0]?.n), 0);
  },
);

dbTest(
  'pull needs changesets.write; a viewer may read the comparison but not draft a change set',
  async (db) => {
    const t = await boot(db, cdn());
    const app = await t.addApp('android');
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'POST', `/apps/${app}/assets/pull`, {})).status, 403);
    assert.equal((await t.call(viewer, 'GET', `/apps/${app}/assets/diff`)).status, 200);
  },
);

dbTest(
  'a change set of images is never refreshed in place, and its staleness is not an error',
  async (db) => {
    const good = rgbPng(1080, 1920, () => [9, 9, 9]);
    const t = await boot(db, cdn({ '*': good }));
    const app = await t.addApp('android');
    t.stores.android.imageRecords = [play(1, { checksum: sha256(good), checksumKind: 'sha256' })];
    const pulled = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {});
    const id = pulled.body.pull.changeSet.id as string;
    const refresh = await t.call(t.owner, 'POST', `/change-sets/${id}/refresh`, {});
    assert.equal(refresh.status, 422);
    assert.equal(refresh.body.error, 'binary_change_set');
    const stale = await t.call(t.owner, 'GET', `/change-sets/${id}/staleness`);
    assert.equal(stale.status, 200, stale.text);
    assert.equal(stale.body.stale, false);
  },
);

// ----- uploads, replace, remove ------------------------------------------------------------------

dbTest(
  'an upload is checked by its bytes, kept here, staged as the whole set, pushed from the kept bytes, and audited without names',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const up = await raw(
      t,
      'PUT',
      `/apps/${app}/staged/assets/upload?${slot}&name=../../etc/My%20Shot.png`,
      SHOT,
    );
    assert.equal(up.status, 200, up.text);
    const set = up.body.staged.assets[0];
    assert.equal(set.files.length, 3, 'the repository set (2 files) plus the upload');
    assert.equal(set.source, 'local');
    assert.deepEqual(
      set.files.map((f: { upload?: boolean }) => f.upload === true),
      [false, false, true],
    );
    assert.match(
      set.files[2].path,
      /^uploads\/[0-9a-f]{8}\/My Shot\.png$/,
      'the name is a base name: no traversal',
    );
    assert.equal(set.files[2].commit, '');
    assert.equal(up.body.position, 3);
    assert.equal(up.body.staged.valid, true);
    const blobs = await db.query('SELECT oid, size FROM staged_asset_blobs WHERE app_id = ?', [
      app,
    ]);
    assert.equal(blobs.length, 1);
    assert.equal(Number(blobs[0]?.size), SHOT.length);
    const audit = await t.audit('staged.asset_added');
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes('Shot'), 'ids and hashes only');
    assert.equal((audit[0]?.detail.oids as string[]).length, 3);
    const blob = await raw(t, 'GET', `/apps/${app}/staged/assets/blob?oid=${set.files[2].oid}`);
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get('content-type'), 'image/png');
    assert.equal(blob.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(blob.bytes), SHOT);
    assert.equal(
      (await raw(t, 'GET', `/apps/${app}/staged/assets/blob?oid=${'a'.repeat(40)}`)).status,
      404,
    );
    assert.equal((await raw(t, 'GET', `/apps/${app}/staged/assets/blob?oid=../x`)).status, 400);
    const pushed = await t.previewAndPush(app);
    assert.equal(pushed.preview.status, 200, pushed.preview.text);
    assert.equal(pushed.push.status, 200, pushed.push.text);
    const files = t.stores.ios.lastInput?.assets[0]?.files ?? [];
    assert.equal(files.length, 3);
    assert.deepEqual(Buffer.from(files[2]?.bytes as Uint8Array), SHOT);
    assert.deepEqual(
      Buffer.from(files[0]?.bytes as Uint8Array),
      t.files[`${SHOTS}/1_iphone65.png`],
    );
  },
);

dbTest(
  'an upload that the stores would refuse is not staged: the problems and the fixes come back',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const small = await raw(
      t,
      'PUT',
      `/apps/${app}/staged/assets/upload?${slot}`,
      rgbPng(100, 100, () => [1, 1, 1]),
    );
    assert.equal(small.status, 422);
    assert.equal(small.body.error, 'spec_errors');
    assert.ok(
      small.body.problems.some((p: { rule: string }) => p.rule === 'apple.screenshot.size'),
    );
    assert.ok(
      small.body.fix.options.some((o: { kind: string }) => o.kind === 'resize'),
      'a PNG of the wrong size can be resized',
    );
    const withAlpha = rgbaPng(1242, 2688, () => [1, 2, 3, 100]);
    const alpha = await raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}`, withAlpha);
    assert.equal(alpha.status, 422);
    assert.ok(
      alpha.body.fix.options.some((o: { kind: string }) => o.kind === 'remove_alpha'),
      'the alpha channel can be removed in the app',
    );
    assert.equal((await t.rows(app)).length, 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n), 0);
    const inspected = await raw(
      t,
      'POST',
      `/apps/${app}/assets/inspect?${slot}&name=a.png`,
      withAlpha,
    );
    assert.equal(inspected.status, 200, inspected.text);
    assert.equal(inspected.body.inspected.hasAlpha, true);
    assert.ok(
      inspected.body.inspected.problems.some(
        (p: { rule: string }) => p.rule === 'apple.screenshot.alpha',
      ),
    );
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n),
      0,
      'an inspection stores nothing',
    );
  },
);

dbTest('uploads are held to magic bytes, the size cap, the type and the slot', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  const up = (query: string, body?: Uint8Array, cookie?: string) =>
    raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${query}`, body, cookie);
  const html = await up(
    `${slot}&name=x.png`,
    Buffer.from('<html><script>alert(1)</script></html>'),
  );
  assert.equal(html.status, 422);
  assert.equal(html.body.error, 'unsupported_media');
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(20),
  ]);
  assert.equal((await up(slot, webp)).status, 422);
  const huge = Buffer.concat([
    SHOT.subarray(0, 40),
    Buffer.alloc(ASSET_SYNC_LIMITS.maxUploadBytes),
  ]);
  assert.equal((await up(slot, huge)).status, 413);
  assert.equal((await up(slot)).status, 400, 'no body');
  assert.equal(
    (await up('locale=en-US&kind=screenshot', SHOT)).status,
    422,
    'a screenshot needs a device',
  );
  assert.equal((await up('locale=en-US&kind=nope', SHOT)).status, 400);
  assert.equal((await up(`${slot}&mode=x`, SHOT)).status, 400);
  assert.equal(
    (await up('locale=en-US&kind=app_icon', SHOT)).status,
    422,
    'the App Store icon cannot be pushed',
  );
  const viewer = await t.addMember('viewer');
  assert.equal((await up(slot, SHOT, viewer)).status, 403);
  assert.equal((await t.rows(app)).length, 0);
});

dbTest(
  'replace a file, take one out, the last one can be removed (the set is staged empty), and unstaging drops the kept bytes',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const rep = await raw(
      t,
      'PUT',
      `/apps/${app}/staged/assets/upload?${slot}&mode=replace&position=1&name=new.png`,
      SHOT,
    );
    assert.equal(rep.status, 200, rep.text);
    const files = rep.body.staged.assets[0].files;
    assert.equal(files.length, 2);
    assert.equal(files[0].upload, true);
    assert.equal(files[1].upload, undefined);
    assert.equal((await t.audit('staged.asset_replaced')).length, 1);
    const bad = await raw(
      t,
      'PUT',
      `/apps/${app}/staged/assets/upload?${slot}&mode=replace&position=9`,
      SHOT,
    );
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, 'invalid_position');
    const rm = await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=2`);
    assert.equal(rm.status, 200, rm.text);
    assert.equal(rm.body.staged.assets[0].files.length, 1);
    assert.equal(
      (await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=0`)).status,
      400,
    );
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n), 1);
    const last = await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=1`);
    assert.equal(last.status, 200, last.text);
    assert.equal(last.body.staged.assets[0].files.length, 0);
    assert.equal(last.body.staged.assets[0].cleared, true, 'the set is staged empty');
    assert.equal(last.body.staged.totals.assetFiles, 0);
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n),
      0,
      'the removed upload is not kept',
    );
    assert.equal((await t.unstage(app, 'en-US/screenshot:iphone_6_5')).status, 200);
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n),
      0,
      'bytes nothing refers to are dropped',
    );
  },
);

dbTest(
  'removing a file of a set that is not staged yet stages the rest of the repository set',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const rm = await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=1`);
    assert.equal(rm.status, 200, rm.text);
    const set = rm.body.staged.assets[0];
    assert.deepEqual(
      set.files.map((f: { path: string }) => f.path),
      [`${SHOTS}/2_iphone65.png`],
    );
    assert.equal(set.source, 'repo');
    assert.equal((await t.rows(app)).length, 1);
  },
);

dbTest('replacing does not pile up kept bytes', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  for (let i = 0; i < 4; i++) {
    const r = await raw(
      t,
      'PUT',
      `/apps/${app}/staged/assets/upload?${slot}&mode=replace&position=1`,
      rgbPng(1242, 2688, () => [i, i, i]),
    );
    assert.equal(r.status, 200, r.text);
  }
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n), 1);
});

// ----- fix ------------------------------------------------------------------------------------------

dbTest(
  'Fix: remove the alpha channel of a repository file on white, staged as an upload, and pushed from the fixed bytes',
  async (db) => {
    const alphaShot = rgbaPng(1242, 2688, () => [200, 100, 50, 128]);
    const files = {
      [`${SHOTS}/1_iphone65.png`]: alphaShot,
      [`${SHOTS}/2_iphone65.png`]: SHOT,
      'fastlane/metadata/ios/en-US/description.txt': 'Hello',
    };
    const t = await bootStaged(db, { files });
    const app = await t.addApp('ios');
    const index = await t.call(t.owner, 'GET', `/apps/${app}/assets`);
    assert.ok(
      index.body.problems.some((p: { rule: string }) => p.rule === 'apple.screenshot.alpha'),
    );
    const res = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/fix`, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      position: 1,
      fix: 'remove_alpha',
      background: '#ffffff',
    });
    assert.equal(res.status, 200, res.text);
    assert.match(res.body.summary, /alpha/i);
    const set = res.body.staged.assets[0];
    assert.equal(res.body.staged.valid, true);
    assert.equal(set.files[0].hasAlpha, false);
    assert.equal(set.files[0].upload, true);
    assert.equal(set.files[1].upload, undefined, 'the other file is still the repository one');
    const blob = await raw(t, 'GET', `/apps/${app}/staged/assets/blob?oid=${set.files[0].oid}`);
    const header = readImageHeader(blob.bytes);
    assert.ok(header.ok && header.hasAlpha === false);
    const decoded = decodePng(blob.bytes);
    assert.ok(decoded.ok, 'the fixed file decodes');
    assert.equal((await t.audit('staged.asset_fixed'))[0]?.detail.fix, 'remove_alpha');
    assert.equal(t.files[`${SHOTS}/1_iphone65.png`], alphaShot, 'the repository file is untouched');
    const pushed = await t.previewAndPush(app);
    assert.equal(pushed.push.status, 200, pushed.push.text);
    assert.deepEqual(
      Buffer.from(t.stores.ios.lastInput?.assets[0]?.files[0]?.bytes as Uint8Array),
      Buffer.from(blob.bytes),
    );
  },
);

dbTest('Fix says why it cannot, and a refused fix stages nothing', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  const body = { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5', position: 1 };
  const fix = (extra: Record<string, unknown>) =>
    t.call(t.owner, 'POST', `/apps/${app}/staged/assets/fix`, { ...body, ...extra });
  // The repository fixtures here only have PNG headers: the codec refuses them with a reason.
  const header = await fix({ fix: 'remove_alpha' });
  assert.equal(header.status, 422);
  assert.match(header.body.error, /^fix_/);
  assert.ok(header.body.message.length > 10);
  assert.equal((await fix({ position: 9, fix: 'remove_alpha' })).status, 422);
  assert.equal((await fix({ fix: 'sharpen' })).status, 400);
  assert.equal((await fix({ fix: 'remove_alpha', background: 'red' })).status, 400);
  assert.equal((await t.rows(app)).length, 0);
});

// ----- staged sets into the repository --------------------------------------------------------------

dbTest(
  'a staged set becomes a change set for the repository: the file takes its place, the old bytes are the precondition, nothing is applied',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}&name=third.png`, SHOT);
    await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=2`);
    const res = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/to-repo`, {});
    assert.equal(res.status, 200, res.text);
    const result = res.body.result;
    assert.equal(result.changeSet.status, 'draft');
    assert.equal(result.changeSet.origin.source, 'staged_assets');
    const changes = result.changeSet.files
      .map((f: { change: string; path: string }) => `${f.change}:${f.path}`)
      .sort();
    // The uploaded file takes over the place of the file it follows, so the names keep their order: a change, not an add and a delete.
    assert.deepEqual(changes, [`modified:${SHOTS}/2_iphone65.png`]);
    assert.ok(!res.text.includes(SHOT.toString('base64').slice(0, 60)));
    assert.equal(t.repo.proposals.length, 0, 'drafted only: nothing is applied');
    assert.equal((await t.audit('staged.assets_to_repo')).length, 1);
    await t.clear(app);
    await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' });
    const same = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/to-repo`, {});
    assert.equal(same.status, 200, same.text);
    assert.equal(same.body.result.changeSet, null);
    assert.equal(same.body.result.unchanged, 2);
    await t.clear(app);
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/to-repo`, {})).status,
      422,
      'nothing staged',
    );
    const viewer = await t.addMember('viewer');
    assert.equal(
      (await t.call(viewer, 'POST', `/apps/${app}/staged/assets/to-repo`, {})).status,
      403,
    );
  },
);

dbTest('deleting an app deletes the bytes it kept', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  await raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}`, SHOT);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n), 1);
  const del = await t.call(t.owner, 'DELETE', `/apps/${app}`);
  assert.ok(del.status === 200 || del.status === 204, del.text);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n), 0);
});

dbTest(
  'a refused file is sent again with the fix the answer offered: the corrected copy is staged, the original is not kept',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const withAlpha = rgbaPng(1242, 2688, () => [255, 0, 0, 0]);
    const up = (query: string, bytes: Uint8Array) =>
      raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}&${query}`, bytes);
    assert.equal((await up('name=a.png', withAlpha)).status, 422);
    const fixed = await up('name=a.png&fix=remove_alpha&background=%2300ff00', withAlpha);
    assert.equal(fixed.status, 200, fixed.text);
    const file = fixed.body.staged.assets[0].files[2];
    assert.equal(file.hasAlpha, false);
    const blob = await raw(t, 'GET', `/apps/${app}/staged/assets/blob?oid=${file.oid}`);
    const decoded = decodePng(blob.bytes);
    assert.ok(decoded.ok);
    if (decoded.ok)
      assert.deepEqual(
        Array.from(decoded.raster.data.slice(0, 3)),
        [0, 255, 0],
        'fully transparent red on green is green',
      );
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n),
      1,
      'only the corrected copy is kept',
    );
    assert.equal((await t.audit('staged.asset_added'))[0]?.detail.fix, 'remove_alpha');
    // A size that is wrong is resized to the nearest size the display takes.
    const small = await up(
      'mode=replace&position=1&name=b.png&fix=resize',
      rgbPng(621, 1344, () => [5, 5, 5]),
    );
    assert.equal(small.status, 200, small.text);
    assert.deepEqual(
      [small.body.staged.assets[0].files[0].width, small.body.staged.assets[0].files[0].height],
      [1242, 2688],
    );
    assert.equal((await up('fix=sharpen', withAlpha)).status, 400);
    assert.equal((await up('fix=remove_alpha&background=red', withAlpha)).status, 400);
    // A fix that cannot be made says why and stages nothing more.
    const jpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
    const refused = await up('fix=remove_alpha', jpegLike);
    assert.equal(refused.status, 422);
  },
);

// ----- editing from the store's side (base=store) and reordering ----------------------------------------

dbTest(
  'base=store: an unstaged set starts from the images the store holds; add, move and remove stage the whole set',
  async (db) => {
    const one = rgbPng(1242, 2688, () => [1, 1, 1]);
    const two = rgbPng(1242, 2688, () => [2, 2, 2]);
    const net = cdn({
      '/image/thumb/Pic1/1242x2688bb.png': one,
      '/image/thumb/Pic2/1242x2688bb.png': two,
    });
    const t = await boot(db, net);
    const app = await t.addApp('ios');
    t.stores.ios.imageRecords = [apple(1), apple(2)];
    const added = await raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}&base=store`, SHOT);
    assert.equal(added.status, 200, added.text);
    const set = added.body.staged.assets[0];
    assert.equal(set.files.length, 3, 'the store images were kept, the new one added');
    assert.ok(set.files.every((f: { upload?: boolean }) => f.upload === true));
    assert.equal(added.body.position, 3);
    const moved = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/move`, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      from: 3,
      to: 1,
    });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.body.staged.assets[0].files[0].oid, set.files[2].oid);
    const bad = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/move`, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_5',
      from: 1,
      to: 9,
    });
    assert.equal(bad.status, 422);
    const removed = await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=1`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.staged.assets[0].files.length, 2);
    assert.equal((await t.audit('staged.asset_moved')).length, 1);
  },
);

dbTest(
  'an 11th screenshot for a size that takes 10 is refused when it is uploaded, with the documented sentence and a code',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const upload = (n: number) =>
      raw(
        t,
        'PUT',
        `/apps/${app}/staged/assets/upload?${slot}&name=s${n}.png`,
        rgbPng(1242, 2688, () => [n, 20, 30]),
      );
    // The repository set holds 2 files: 8 uploads make 10.
    for (let n = 1; n <= 8; n++) assert.equal((await upload(n)).status, 200, `upload ${n}`);
    const refused = await upload(9);
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body.error, 'set_too_large');
    assert.equal(refused.body.limit, 10);
    assert.equal(refused.body.actual, 11);
    assert.match(
      refused.body.message,
      /^At most 10 screenshots per device size\. iPhone .*: 11 would be staged\.$/,
    );
    assert.equal(refused.body.code, 'staged.setTooLarge');
    assert.equal(refused.body.params.count, 11);
    // Nothing of the refused file was kept: the set is still the 10 files.
    const view = await t.view(app);
    assert.equal(view.assets[0]?.files.length, 10);
  },
);

// ----- taking several files out in one request, each answered for itself -----------------------------

const SLOT = { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' };
const remove = (t: Awaited<ReturnType<typeof boot>>, app: string, files: unknown[], base?: 'store') =>
  t.call(t.owner, 'POST', `/apps/${app}/staged/assets/remove`, {
    ...SLOT,
    files,
    ...(base ? { base } : {}),
  });
const storeRefs = async (t: Awaited<ReturnType<typeof boot>>, app: string): Promise<string[]> => {
  const read = await t.call(t.owner, 'GET', `/apps/${app}/assets/store?fresh=1`);
  assert.equal(read.status, 200, read.text);
  return read.body.store.sets
    .filter((s: { device: string }) => s.device === 'iphone_6_5')
    .flatMap((s: { files: { ref: string }[] }) => s.files.map((f) => f.ref));
};
const threeStoreImages = () => {
  const bodies: Record<string, Uint8Array> = {};
  for (const n of [1, 2, 3])
    bodies[`/image/thumb/Pic${n}/1242x2688bb.png`] = rgbPng(1242, 2688, () => [n, n, n]);
  return cdn(bodies);
};

dbTest('removing images the store holds: by ref, one answer each, one staged change', async (db) => {
  const t = await boot(db, threeStoreImages());
  const app = await t.addApp('ios');
  t.stores.ios.imageRecords = [apple(1), apple(2), apple(3)];
  const refs = await storeRefs(t, app);
  assert.equal(refs.length, 3);
  const done = await remove(t, app, [{ ref: refs[1] }, { ref: 'nope' }, { ref: refs[1] }, {}, { ref: refs[2] }], 'store');
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(
    done.body.results.map((r: { outcome: string; reason?: string }) => [r.outcome, r.reason ?? null]),
    [
      ['removed', null],
      ['not_found', 'stale_store_ref'],
      ['already_removed', 'duplicate_in_request'],
      ['not_found', 'no_identifier'],
      ['removed', null],
    ],
  );
  assert.deepEqual(done.body.results.map((r: { index: number }) => r.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(done.body.summary, { removed: 2, alreadyRemoved: 1, notFound: 2 });
  assert.equal(done.body.emptied, false);
  assert.equal(done.body.remaining, 1);
  assert.equal(done.body.staged.assets[0].files.length, 1);
  assert.equal((await t.audit('staged.asset_removed')).length, 1, 'ONE change, one audit entry');
  // The same ref again: the staged set no longer keeps it, and the store still lists it.
  const again = await remove(t, app, [{ ref: refs[1] }], 'store');
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.results[0].outcome, 'already_removed');
  assert.equal(again.body.results[0].reason, 'not_in_staged_set');
  assert.equal((await t.audit('staged.asset_removed')).length, 1, 'nothing was removed, nothing was staged');
});

dbTest('removing every file of a set stages it empty, and a push removes the images of the store', async (db) => {
  const t = await boot(db, threeStoreImages());
  const app = await t.addApp('ios');
  t.stores.ios.imageRecords = [apple(1), apple(2)];
  t.stores.ios.seedSet('en-US', 'APP_IPHONE_65', [
    { name: 's1.png', bytes: new Uint8Array([1]) },
    { name: 's2.png', bytes: new Uint8Array([2]) },
  ]);
  const refs = await storeRefs(t, app);
  const done = await remove(t, app, refs.map((ref) => ({ ref })), 'store');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.emptied, true);
  assert.equal(done.body.remaining, 0);
  const set = done.body.staged.assets[0];
  assert.equal(set.cleared, true);
  assert.deepEqual(set.files, []);
  assert.equal(done.body.staged.totals.assetSets, 1, 'it is one staged change');
  const rows = await t.rows(app);
  assert.equal(rows.length, 1, 'one marker row, no file');
  const pushed = await t.previewAndPush(app);
  assert.equal(pushed.preview.status, 200, pushed.preview.text);
  assert.equal(pushed.push.status, 200, pushed.push.text);
  const sent = t.stores.ios.lastInput?.assets ?? [];
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.target, 'APP_IPHONE_65');
  assert.deepEqual(sent[0]?.files, [], 'the push carries an empty set');
  assert.equal(t.stores.ios.sets.get('en-US\u0000APP_IPHONE_65')?.length ?? 0, 0, 'the store holds none');
});

dbTest('removing a file that was only staged (an upload) by its blob id', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  const up = await raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}&name=new.png`, SHOT);
  assert.equal(up.status, 200, up.text);
  const files = up.body.staged.assets[0].files;
  assert.equal(files.length, 3);
  const added = files[2];
  const gone = await remove(t, app, [{ oid: added.oid }, { oid: added.oid }, { oid: 'f'.repeat(40) }]);
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(
    gone.body.results.map((r: { outcome: string; reason?: string }) => [r.outcome, r.reason ?? null]),
    [
      ['removed', null],
      ['already_removed', 'duplicate_in_request'],
      ['not_found', 'unknown_file'],
    ],
  );
  assert.equal(gone.body.staged.assets[0].files.length, 2);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM staged_asset_blobs'))[0]?.n), 0);
});

dbTest('removing files of a repository set that is not staged, by place', async (db) => {
  const t2 = await bootStaged(db);
  const app2 = await t2.addApp('ios');
  const out = await remove(t2, app2, [{ position: 9 }, { position: 2 }]);
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(
    out.body.results.map((r: { outcome: string; reason?: string }) => [r.outcome, r.reason ?? null]),
    [
      ['not_found', 'position_out_of_range'],
      ['removed', null],
    ],
  );
  assert.deepEqual(
    out.body.staged.assets[0].files.map((f: { path: string }) => f.path),
    [`${SHOTS}/1_iphone65.png`],
  );
});

dbTest('a set that was pushed is edited from what the store holds now, not from the rows of the push', async (db) => {
  const t = await boot(db, threeStoreImages());
  const app = await t.addApp('ios');
  t.stores.ios.imageRecords = [apple(1), apple(2), apple(3)];
  // The set was staged and pushed with ONE file; the store holds three images (two were never replaced).
  const up = await raw(t, 'PUT', `/apps/${app}/staged/assets/upload?${slot}&name=new.png`, SHOT);
  assert.equal(up.status, 200, up.text);
  await db.execute(
    "UPDATE staged_changes SET pushed_at = ?, pushed_hash = value_hash WHERE app_id = ? AND kind = 'asset'",
    [Date.now(), app],
  );
  const refs = await storeRefs(t, app);
  // The Graphics tab shows the store's 3 images for a pushed set; image 3 is a store image the rows of the push do not have.
  const legacy = await raw(t, 'DELETE', `/apps/${app}/staged/assets/file?${slot}&position=3&base=store`);
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.body.staged.assets[0].files.length, 2);
  assert.equal(legacy.body.staged.assets[0].pushed, false, 'a new change, not the pushed one');
  const next = await remove(t, app, [{ ref: refs[0] }], 'store');
  assert.equal(next.status, 200, next.text);
  assert.equal(next.body.results[0].outcome, 'already_removed', 'already out of the staged set');
});

dbTest('a viewer cannot remove files, and bad bodies are refused with the field named', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  const viewer = await t.addMember('viewer');
  const body = { ...SLOT, files: [{ position: 1 }] };
  assert.equal((await t.call(viewer, 'POST', `/apps/${app}/staged/assets/remove`, body)).status, 403);
  assert.equal((await remove(t, app, [])).status, 400);
  assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/remove`, { ...SLOT, files: [{ position: 0 }] })).status, 400);
  assert.equal((await t.rows(app)).length, 0);
});

dbTest(
  'a display the store keeps in two groups (13" and legacy 12.9"): the comparison pairs the one a push writes and lists the other as its own set, never summed or dropped',
  async (db) => {
    const t = await boot(db, cdn());
    const app = await t.addApp('ios');
    const ipad = (position: number, target: string, id: string) =>
      apple(position, {
        device: 'ipad_13',
        target,
        id,
        width: 2048,
        height: 2732,
      });
    t.stores.ios.imageRecords = [
      // The legacy group is read first: the last-wins pairing of the first version of this code would have kept the 8 and lost the 4.
      ...Array.from({ length: 4 }, (_, i) => ipad(i + 1, 'APP_IPAD_PRO_129', `old${i + 1}`)),
      ...Array.from({ length: 8 }, (_, i) => ipad(i + 1, 'APP_IPAD_PRO_3GEN_129', `new${i + 1}`)),
    ];
    const res = await t.call(t.owner, 'GET', `/apps/${app}/assets/diff?fresh=1`);
    assert.equal(res.status, 200, res.text);
    const sets = res.body.diff.sets.filter((s: { device: string }) => s.device === 'ipad_13');
    assert.deepEqual(
      sets
        .map((s: { target: string; rows: { store: unknown }[] }) => [s.target, s.rows.filter((r) => r.store).length])
        .sort(),
      [
        ['APP_IPAD_PRO_129', 4],
        ['APP_IPAD_PRO_3GEN_129', 8],
      ],
    );
    // The store counts of the Assets tab come from the view the caller holds (core), not from GET /assets.
    const side = storeSideOf((await t.call(t.owner, 'GET', `/apps/${app}/assets/store`)).body.store);
    const entries = side.counts.filter((c) => c.device === 'ipad_13');
    assert.equal(entries.length, 1, 'one count per display');
    assert.equal(entries[0]?.count, 8, 'the group a push writes, not the sum (12) and not the last of the siblings (4)');
    assert.equal(entries[0]?.target, 'APP_IPAD_PRO_3GEN_129');
    assert.deepEqual(
      (entries[0]?.groups ?? []).map((g) => [g.target, g.count]).sort(),
      [
        ['APP_IPAD_PRO_129', 4],
        ['APP_IPAD_PRO_3GEN_129', 8],
      ],
    );
  },
);

dbTest(
  'pull of a display held in two groups: the primary group is pulled (by the refs of its rows, not by the store position used as an index); the legacy sibling is never pulled',
  async (db) => {
    const ipad = (position: number, target: string, id: string) =>
      apple(position, { device: 'ipad_13', target, id, width: 2048, height: 2732 });
    const bodies: Record<string, Uint8Array> = {};
    for (let p = 1; p <= 12; p++)
      bodies[`/image/thumb/Pic${p}/2048x2732bb.png`] = rgbPng(2048, 2732, () => [p, p, p]);
    const net = cdn(bodies);
    const t = await boot(db, net);
    const app = await t.addApp('ios');
    t.stores.ios.imageRecords = [
      // The legacy group is read first: its images are 1..4, the primary group's are 5..12 (the store's counter continues across groups).
      ...Array.from({ length: 4 }, (_, i) => ipad(i + 1, 'APP_IPAD_PRO_129', `old${i + 1}`)),
      ...Array.from({ length: 8 }, (_, i) => ipad(i + 5, 'APP_IPAD_PRO_3GEN_129', `new${i + 1}`)),
    ];
    const all = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {});
    assert.equal(all.status, 200, all.text);
    assert.equal(all.body.pull.written, 8, 'the 8 images of the primary group, not the 4 of the last-read sibling, not 12');
    const fetched = net.seen.map((r) => r.url.pathname).filter((p) => p.includes('/Pic'));
    assert.ok(fetched.every((p) => /Pic([5-9]|1[0-2])\//.test(p)), `only primary images were downloaded: ${fetched.join(' ')}`);
    // A sibling image is not selectable (it has no counterpart in the repository); a primary image is, by its store position.
    const sibling = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {
      files: ['ios/en-US/screenshot:ipad_13#2'],
    });
    assert.equal(sibling.status, 422, sibling.text);
    const first = await t.call(t.owner, 'POST', `/apps/${app}/assets/pull`, {
      files: ['ios/en-US/screenshot:ipad_13#5'],
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.pull.written, 1, 'store position 5 is the FIRST image of the primary group: it goes to place 1 of the repository set');
  },
);

dbTest(
  'a display held in 10 + 2 images: the cart says 12 before (the display a push replaces), the seed is the display, and the two extra images are removed in one step (a single removal would leave 11, over the staged limit)',
  async (db) => {
    const png = rgbPng(2048, 2732, () => [9, 9, 9]);
    const t = await boot(db, cdn({ '*': png }));
    const app = await t.addApp('ios');
    const ipad = (position: number, target: string, id: string) =>
      apple(position, { device: 'ipad_13', target, id, width: 2048, height: 2732, url: `https://is1.mzstatic.com/image/thumb/P${id}/{w}x{h}bb.{f}` });
    t.stores.ios.imageRecords = [
      ...Array.from({ length: 10 }, (_, i) => ipad(i + 1, 'APP_IPAD_PRO_3GEN_129', `new${i + 1}`)),
      ...Array.from({ length: 2 }, (_, i) => ipad(i + 11, 'APP_IPAD_PRO_129', `old${i + 1}`)),
    ];
    const view = (await t.call(t.owner, 'GET', `/apps/${app}/assets/store?fresh=1`)).body.store;
    const display = groupStoreImages(view).find((d) => d.device === 'ipad_13');
    assert.deepEqual(display?.counts.perGroup.map((g) => g.count).sort(), [10, 2]);
    assert.equal(display?.counts.merged, 12);
    assert.equal(display?.overLimit.length, 0, 'each store group is within its own limit');
    assert.equal(display?.stagedFits, false);
    const slotBody = { locale: 'en-US', kind: 'screenshot', device: 'ipad_13', base: 'store' };
    const one = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/remove`, {
      ...slotBody,
      files: [{ ref: display?.files[10]?.ref }],
    });
    assert.equal(one.status, 422, 'one removal leaves 11: a staged set holds at most 10 (trim the extra images in one step)');
    assert.equal(one.body.error, 'set_too_large');
    // The two images of the sibling group in one step (refs of the display, the sibling group's included) leave 10.
    const out = await t.call(t.owner, 'POST', `/apps/${app}/staged/assets/remove`, {
      ...slotBody,
      files: [{ ref: display?.files[10]?.ref }, { ref: display?.files[11]?.ref }],
    });
    assert.equal(out.status, 200, out.text);
    assert.deepEqual(out.body.results.map((r: { outcome: string }) => r.outcome), ['removed', 'removed']);
    assert.equal(out.body.staged.assets[0].files.length, 10, 'the display seeded 12, two removed');
    const cart = await t.call(t.owner, 'GET', `/apps/${app}/pending/cart`);
    const item = cart.body.cart.items.find((i: { kind: string }) => i.kind === 'graphics');
    assert.equal(item.counts.before, 12, 'before is the merged display of the last store read, once');
    assert.equal(item.counts.files, 10);
  },
);
