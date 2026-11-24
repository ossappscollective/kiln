import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { weatherApp } from '../../../../../packages/connectors/src/fastlane.fixtures.ts';
import type { StoreImageRecord } from '@kiln/connectors';
import type { Exchange } from '../../services/safe-fetch.ts';
import { iosListing, playListing } from './test-helpers.ts';
import { bootStaged, IPHONE_65, png, type StagedBoot } from '../publish/test-helpers.ts';
import { clearStoreImageCaches } from './store-images.ts';
import { clearAssetIndexes, isCommitSha } from './asset-repo.ts';
import { resetProposalSummaryCache } from './asset-proposal-summary.ts';

/**
 * The release asset proposal (docs/api/release-asset-proposal.md, docs/adr/0063-release-asset-proposal.md): what changed in the repository since
 * the previous release, checked, and staged on request. A fake repository with three commits and a fake store; nothing reaches a store.
 */

const cdn = () => {
  const exchange: Exchange = async () => ({ status: 404, headers: {}, body: new Uint8Array(0), overflow: false });
  return { exchange };
};
const apple = (position: number, over: Partial<StoreImageRecord> = {}): StoreImageRecord => ({
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

const B0 = 'b'.repeat(40); // the source of the previous release
const B1 = 'c'.repeat(40); // the source of this release
const HEAD = 'd'.repeat(40);
const SHOTS = 'fastlane/metadata/ios/screenshots/en-US';
const TXT = 'fastlane/metadata/ios/en-US';

type Files = Record<string, string | Buffer>;
const shot = (seed: number) => png(...IPHONE_65, { seed });

function metadata(over: Record<string, string | null> = {}, shots: number[] = [1, 2]): Files {
  const files: Files = { ...weatherApp() };
  delete files[`${SHOTS}/1_iphone.png`];
  const texts: Record<string, string | null> = {
    name: 'Pocket Notes',
    description: 'Old description',
    keywords: 'notes,memo',
    release_notes: 'Bug fixes.',
    ...over,
  };
  for (const [field, value] of Object.entries(texts)) {
    if (value === null) delete files[`${TXT}/${field}.txt`];
    else files[`${TXT}/${field}.txt`] = `${value}\n`;
  }
  shots.forEach((seed, i) => {
    files[`${SHOTS}/${i + 1}_iphone65.png`] = shot(seed);
  });
  return files;
}

/** Makes the fake repository answer by ref: B0, B1 and HEAD hold different trees. */
function versioned(t: StagedBoot, trees: Record<string, Files>) {
  const repo = t.repo;
  const at = (ref?: string) => {
    const tree = trees[ref ?? HEAD] ?? trees[HEAD] ?? {};
    repo.files = new Map(Object.entries(tree).filter((e): e is [string, string] => typeof e[1] === 'string'));
    repo.blobs = new Map(Object.entries(tree).filter((e): e is [string, Buffer] => typeof e[1] !== 'string'));
  };
  const list = repo.listFiles.bind(repo);
  const read = repo.readFile.bind(repo);
  const entries = repo.listBlobEntries.bind(repo);
  const heads = repo.readBlobHeads.bind(repo);
  repo.listFiles = async (ref?: string) => (at(ref), list());
  repo.readFile = async (path: string, ref?: string) => (at(ref), read(path));
  repo.resolveCommit = async (ref?: string) => (ref && isCommitSha(ref) ? ref : HEAD);
  repo.listBlobEntries = async (ref?: string) => (at(ref), { ...(await entries()), commit: ref && isCommitSha(ref) ? ref : HEAD });
  repo.readBlobHeads = async (paths, options) => (at(options.ref), heads(paths, options));
}

async function boot(
  db: Parameters<typeof bootStaged>[0],
  options: { trees?: Record<string, Files>; store?: Record<string, string>; releases?: 'previous' | 'none' | 'locked'; deadlineMs?: number } = {},
) {
  clearStoreImageCaches();
  const net = cdn();
  const t = await bootStaged(db, { extra: { assetSync: { ...(options.deadlineMs ? { compareDeadlineMs: options.deadlineMs } : {}), net: { resolve: async () => [{ address: '93.184.216.34', family: 4 as const }], exchange: net.exchange } } } });
  versioned(t, options.trees ?? { [B0]: metadata(), [B1]: metadata(), [HEAD]: metadata() });
  const app = await t.addApp('ios');
  t.readStores.ios.listing = iosListing({
    'en-US': { name: 'Pocket Notes', description: 'Old description', keywords: 'notes,memo', ...(options.store ?? {}) },
  });
  assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/sync`)).status, 200);
  const release = (id: string, version: string, build: string, status: string) =>
    db.execute(
      `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json, store_updated_at, synced_at)
       VALUES (?, ?, ?, 'ios', ?, '', ?, ?, 'RAW', '{}', 1000, 5)`,
      [id, app, t.workspaceId, version, build, status],
    );
  const link = (id: string, build: string, sha: string) =>
    db.execute(
      `INSERT INTO build_links (id, workspace_id, app_id, platform, build_number, repository_id, run_id, head_sha, source, linked_at)
       VALUES (?, ?, ?, 'ios', ?, ?, ?, ?, 'manual', 1)`,
      [id, t.workspaceId, app, build, t.repositoryId, id, sha],
    );
  await db.execute('DELETE FROM app_releases WHERE app_id = ?', [app]);
  if (options.releases !== 'none') {
    await release('r-old', '1.0', '10', 'live');
    await link('l0', '10', B0);
    if (options.releases !== 'locked') await release('r-new', '1.1', '11', 'draft');
  }
  await link('l1', '11', B1);
  const q = '?version=1.1&build=11';
  const url = `/apps/${app}/release/asset-proposal`;
  return {
    t,
    app,
    net,
    url,
    q,
    get: (query = q, cookie = t.owner) => t.call(cookie, 'GET', `${url}${query}`),
    stage: (body: Record<string, unknown>, cookie = t.owner) => t.call(cookie, 'POST', `${url}/stage`, { version: '1.1', build: '11', ...body }, ),
    dismiss: (mode: string, cookie = t.owner) => t.call(cookie, 'POST', `${url}/dismiss`, { version: '1.1', mode }),
  };
}

/** The window B0 -> B1: a keywords field that is over its limit, a clean promo text, a description that already is in the store, a new second screenshot. */
const CHANGED: Record<string, Files> = {
  [B0]: metadata(),
  [B1]: metadata(
    { keywords: 'notes,memo,'.repeat(12), promotional_text: 'Fresh and new', description: 'New description', subtitle: 'A new subtitle' },
    [1, 3],
  ),
  [HEAD]: metadata(),
};

dbTest('changed since the last release: issues first, the clean items checked, the one with errors marked', async (db) => {
  const b = await boot(db, { trees: CHANGED, store: { description: 'New description', release_notes: 'Old notes' } });
  const res = await b.get();
  assert.equal(res.status, 200, res.text);
  const p = res.body.proposal;
  assert.equal(p.unavailable, null);
  assert.equal(p.targetRef.sha, B1);
  assert.equal(p.targetRef.source, 'build');
  assert.equal(p.baseRef.sha, B0);
  assert.equal(p.noPreviousRelease, false);
  const ids = p.changes.map((c: { id: string }) => c.id).sort();
  assert.deepEqual(ids, ['graphics:en-US:screenshot:iphone_6_5', 'text:en-US:keywords', 'text:en-US:promotional_text']);
  const keywords = p.changes.find((c: { id: string }) => c.id === 'text:en-US:keywords');
  assert.equal(keywords.hasErrors, true, 'a field over its limit has errors');
  assert.equal(keywords.before, 'notes,memo', 'before is the store text');
  assert.equal(p.changes.find((c: { id: string }) => c.id === 'text:en-US:promotional_text').hasErrors, false);
  assert.ok(p.issues.some((i: { severity: string; itemId: string; code: string }) => i.severity === 'error' && i.itemId === 'text:en-US:keywords' && i.code === 'too_long'));
  assert.equal(p.issues[0].severity, 'error', 'errors come first');
  const rank = { error: 0, warning: 1, tip: 2 } as const;
  const order = p.issues.map((i: { severity: keyof typeof rank }) => rank[i.severity]);
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  const graphics = p.changes.find((c: { kind: string }) => c.kind === 'graphics');
  assert.equal(graphics.after.count, 2);
  assert.equal(graphics.after.commit, B1);
  assert.equal(graphics.before, 0);
  assert.equal(p.skipped.sameAsStore, 1, 'the description is the store text already');
  assert.ok(p.skipped.unchangedSinceRelease >= 2, 'name and release notes did not change since the last release');
  assert.equal(p.skipped.notStageable, 1, 'the App Store subtitle cannot be staged');
  assert.equal(p.summary.texts, 2);
  assert.equal(p.summary.graphics, 1);
  assert.equal(p.summary.locales, 1);
});

dbTest('the proposal works without the compare settings and never writes anything', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  const settings = await b.t.call(b.t.owner, 'GET', `/apps/${b.app}/listing-settings`);
  assert.deepEqual(settings.body.settings, { compareRepo: false, compareMedia: false });
  assert.equal((await b.get()).body.proposal.changes.length > 0, true);
  assert.equal((await b.t.rows(b.app)).length, 0);
  assert.equal(b.t.stores.ios.writes.length, 0);
});

dbTest('staging a clean item and a screenshot set; staging twice never duplicates; nothing reaches a store', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  const done = await b.stage({ itemIds: ['text:en-US:promotional_text', 'graphics:en-US:screenshot:iphone_6_5'] });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(
    done.body.results.map((r: { status: string }) => r.status),
    ['staged', 'staged'],
  );
  const view = await b.t.view(b.app);
  assert.equal(view.text.length, 1);
  assert.equal(view.text[0]?.value, 'Fresh and new');
  assert.equal(view.assets.length, 1);
  assert.equal(view.assets[0]?.files.length, 2);
  assert.equal(done.body.proposal.changes.some((c: { id: string }) => c.id === 'text:en-US:promotional_text'), false);
  assert.ok(done.body.proposal.alreadyStaged.some((s: { id: string; state: string }) => s.id === 'text:en-US:promotional_text' && s.state === 'same'));
  const again = await b.stage({ itemIds: ['text:en-US:promotional_text', 'graphics:en-US:screenshot:iphone_6_5'] });
  assert.deepEqual(
    again.body.results.map((r: { status: string }) => r.status),
    ['already_staged', 'already_staged'],
  );
  assert.equal((await b.t.rows(b.app)).length, 3, 'one text row and two files, not more');
  assert.equal((await b.t.audit('release.asset_proposal_staged')).length, 1, 'the second press staged nothing');
  assert.equal(b.t.stores.ios.writes.length, 0, 'nothing reached a store');
});

dbTest('an item with errors needs the explicit confirmation; then it is staged', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  const refused = await b.stage({ itemIds: ['text:en-US:keywords'] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'has_issues');
  assert.deepEqual(refused.body.itemIds, ['text:en-US:keywords']);
  assert.equal((await b.t.rows(b.app)).length, 0);
  const ok = await b.stage({ itemIds: ['text:en-US:keywords'], acceptIssues: true });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.results[0].status, 'staged');
  const audit = await b.t.audit('release.asset_proposal_staged');
  assert.equal(audit[0]?.detail.acceptedIssues, true);
  assert.ok(!JSON.stringify(audit[0]?.detail).includes('notes,memo,'), 'a text is never audited');
});

dbTest('a text the person already edited in the cart is shown as staged and never overwritten', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  assert.equal((await b.t.stageText(b.app, { locale: 'en-US', field: 'promotional_text', from: 'local', value: 'My own words' })).status, 200);
  const p = (await b.get()).body.proposal;
  assert.equal(p.changes.some((c: { id: string }) => c.id === 'text:en-US:promotional_text'), false);
  assert.deepEqual(p.alreadyStaged.find((s: { id: string }) => s.id === 'text:en-US:promotional_text')?.state, 'edited');
  const res = await b.stage({ itemIds: ['text:en-US:promotional_text'] });
  assert.equal(res.body.results[0].status, 'kept_edited');
  assert.equal((await b.t.view(b.app)).text[0]?.value, 'My own words');
});

dbTest('repository content that did not change since the last release, or equals the store, is not proposed', async (db) => {
  const same = { [B0]: metadata(), [B1]: metadata(), [HEAD]: metadata() };
  const b = await boot(db, { trees: same, store: { keywords: 'something,else' } });
  const p = (await b.get()).body.proposal;
  assert.deepEqual(p.changes, [], 'the keywords differ from the store but did not change since the last release');
  assert.ok(p.skipped.unchangedSinceRelease > 0);
});

dbTest('changed in the window but already in the store: not proposed', async (db) => {
  const c = await boot(db, { trees: { [B0]: metadata({ description: 'Other' }), [B1]: metadata(), [HEAD]: metadata() }, store: { description: 'Old description' } });
  const p = (await c.get()).body.proposal;
  assert.equal(p.changes.some((x: { id: string }) => x.id === 'text:en-US:description'), false);
  assert.equal(p.skipped.sameAsStore, 1);
});

dbTest('no previous release found: everything that differs from the store is a candidate, and it is flagged', async (db) => {
  const b = await boot(db, { trees: { [HEAD]: metadata({ keywords: 'new,words' }), [B1]: metadata({ keywords: 'new,words' }) }, releases: 'none', store: {} });
  const p = (await b.get('?version=1.1')).body.proposal;
  assert.equal(p.noPreviousRelease, true);
  assert.equal(p.baseRef, null);
  assert.equal(p.targetRef.source, 'default_branch');
  assert.equal(p.targetRef.sha, HEAD);
  assert.ok(p.changes.some((c: { id: string }) => c.id === 'text:en-US:keywords'));
});

dbTest('a locked App Store app shows the proposal but stages nothing; Google Play never locks', async (db) => {
  const b = await boot(db, { trees: CHANGED, releases: 'locked' });
  const p = (await b.get()).body.proposal;
  assert.equal(p.locked.locked, true);
  assert.equal(p.locked.liveVersion, '1.0');
  assert.ok(p.changes.length > 0, 'the changes are still shown');
  const res = await b.stage({ itemIds: ['text:en-US:promotional_text'] });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'metadata_locked');
  assert.equal((await b.t.rows(b.app)).length, 0);
});

dbTest('Google Play never locks', async (db) => {
  const t = await bootStaged(db);
  const android = await t.addApp('android');
  t.readStores.android.listing = playListing({ 'en-US': { title: 'Weather', short_description: 'Short', full_description: 'Full' } });
  await t.call(t.owner, 'POST', `/apps/${android}/sync`);
  await db.execute(`INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json, synced_at) VALUES ('pr', ?, ?, 'android', '1.0', 'production', '5', 'live', 'RAW', '{}', 5)`, [android, t.workspaceId]);
  const play = await t.call(t.owner, 'GET', `/apps/${android}/release/asset-proposal?version=1.0&track=production`);
  assert.equal(play.status, 200, play.text);
  assert.equal(play.body.proposal.locked.locked, false);
});

dbTest('no repository: nothing is read and nothing is proposed', async (db) => {
  const t = await bootStaged(db);
  const res = await t.call(t.owner, 'POST', '/apps', { platform: 'ios', identifier: 'com.acme.other', credentialId: t.iosCredential, name: 'No repo' });
  const app = res.body.app.id as string;
  const before = t.repo.listCalls;
  const p = await t.call(t.owner, 'GET', `/apps/${app}/release/asset-proposal?version=1.0`);
  assert.equal(p.status, 200, p.text);
  assert.equal(p.body.proposal.unavailable, 'no_repository');
  assert.deepEqual(p.body.proposal.changes, []);
  assert.equal(t.repo.listCalls, before, 'the repository was not read');
  assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/release/asset-proposal/stage`, { itemIds: ['text:en-US:keywords'] })).status, 422);
});

dbTest('skip and remind later are saved per release and survive; reopen brings it back; nothing is staged by them', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  assert.equal((await b.get()).body.proposal.state.state, 'open');
  assert.equal((await b.dismiss('skip')).body.state.state, 'skipped');
  assert.equal((await b.get()).body.proposal.state.state, 'skipped');
  assert.equal((await b.get('?version=1.2&build=11')).body.proposal.state.state, 'open', 'another release is not affected');
  assert.equal((await b.dismiss('later')).body.state.state, 'later');
  assert.equal((await b.get()).body.proposal.state.state, 'later');
  assert.equal((await b.dismiss('reopen')).body.state.state, 'open');
  assert.equal((await b.get()).body.proposal.state.state, 'open');
  assert.equal((await b.t.rows(b.app)).length, 0);
  assert.equal((await b.dismiss('nonsense')).status, 400);
  assert.ok((await b.t.audit('release.asset_proposal_decided')).length >= 3);
  await b.dismiss('skip');
  assert.equal((await b.t.call(b.t.owner, 'DELETE', `/apps/${b.app}`)).status < 300, true);
  assert.equal((await db.query("SELECT key FROM workspace_settings WHERE key LIKE '%assetProposal%'")).length, 0, 'deleted with the app');
});

dbTest('another workspace gets 404, a viewer can read but not stage, and a made-up id stages nothing', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  const viewer = await b.t.addMember('viewer');
  assert.equal((await b.get(b.q, viewer)).status, 200);
  assert.equal((await b.stage({ itemIds: ['text:en-US:promotional_text'] }, viewer)).status, 403);
  assert.equal((await b.dismiss('skip', viewer)).status, 403);

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w2', 'Other', 1)");
  const stranger = await b.t.addMember('owner', 'w2');
  const post = (workspace: string, path: string, body: Record<string, unknown>) =>
    b.t.app.request(`/api/workspaces/${workspace}${path}`, {
      method: 'POST',
      headers: { cookie: stranger, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (const workspace of [b.t.workspaceId, 'w2']) {
    const read = await b.t.app.request(`/api/workspaces/${workspace}${b.url}${b.q}`, { headers: { cookie: stranger } });
    assert.equal(read.status, 404, `read in ${workspace}`);
    assert.equal((await post(workspace, `${b.url}/stage`, { itemIds: ['text:en-US:keywords'] })).status, 404, `stage in ${workspace}`);
    assert.equal((await post(workspace, `${b.url}/dismiss`, { mode: 'skip' })).status, 404, `dismiss in ${workspace}`);
  }
  assert.equal((await b.get()).body.proposal.state.state, 'open', 'the stranger changed nothing');
  const nothing = await b.stage({ itemIds: ['text:en-US:keywords_nope', 'graphics:en-US:../../etc/passwd'] });
  assert.deepEqual(nothing.body.results.map((r: { status: string }) => r.status), ['not_proposed', 'not_proposed']);
  assert.equal((await b.t.rows(b.app)).length, 0);
});

dbTest('a version, track or build that is not a plain label is refused (no path or query smuggling)', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  for (const q of ['?version=../../etc', '?version=1.1&build=11/../x', '?track=a%00b']) assert.equal((await b.get(q)).status, 400, q);
  assert.equal((await b.stage({ itemIds: ['x:y:z'], version: '../x' })).status, 400);
});

dbTest('the store graphics that match the repository are not proposed', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  const bytes = shot(1).length;
  b.t.stores.ios.imageRecords = [apple(1, { bytes, width: IPHONE_65[0], height: IPHONE_65[1] })];
  const own = shot(3);
  b.t.stores.ios.imageRecords.push(apple(2, { bytes: own.length, width: IPHONE_65[0], height: IPHONE_65[1] }));
  clearStoreImageCaches();
  const p = (await b.get()).body.proposal;
  assert.equal(p.changes.some((c: { kind: string }) => c.kind === 'graphics'), false, 'identical by size: not proposed');
  assert.equal(p.skipped.sameAsStore, 1, 'the one set of screenshots');
});

dbTest('a graphics item carries the refs of the store images for the image comparison, never a store address', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  b.t.stores.ios.imageRecords = [apple(1, { bytes: 10, width: IPHONE_65[0], height: IPHONE_65[1] })];
  clearStoreImageCaches();
  const p = (await b.get()).body.proposal;
  const g = p.changes.find((c: { kind: string }) => c.kind === 'graphics');
  assert.equal(g.beforeFiles.length, g.before);
  assert.equal(g.beforeFiles[0].position, 1);
  assert.match(g.beforeFiles[0].ref, /^[0-9a-f]+$/, 'an opaque ref');
  assert.equal(JSON.stringify(g.beforeFiles).includes('http'), false);
});

// ---- The count-only summary for the Releases list ----

dbTest('summary: the count of changed texts and graphics, cached (the repository is not read again), refreshed when the cart changes', async (db) => {
  resetProposalSummaryCache();
  const b = await boot(db, { trees: CHANGED, store: { description: 'New description', release_notes: 'Old notes' } });
  const sum = () => b.t.call(b.t.owner, 'GET', `${b.url}/summary`);
  const first = await sum();
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(
    [first.body.summary.available, first.body.summary.count, first.body.summary.texts, first.body.summary.graphics, first.body.summary.version, first.body.summary.cached],
    [true, 3, 2, 1, '1.1', false],
  );
  assert.equal(JSON.stringify(first.body).includes('Fresh and new'), false, 'no text leaves in a count');
  const reads = b.t.repo.listCalls;
  const again = await sum();
  assert.equal(again.body.summary.cached, true);
  assert.equal(again.body.summary.count, 3);
  assert.equal(b.t.repo.listCalls, reads, 'a cached answer reads nothing');
  // Staging one item changes the cart: the answer is computed again and the staged item is no longer proposed.
  assert.equal((await b.stage({ itemIds: ['text:en-US:promotional_text'] })).status, 200);
  const after = await sum();
  assert.equal(after.body.summary.cached, false);
  assert.equal(after.body.summary.count, 2);
  assert.equal((await b.t.rows(b.app)).length, 1, 'the summary itself stages nothing');
});

dbTest('summary: a skipped proposal counts nothing and reads nothing; remind later still counts; reopen brings it back', async (db) => {
  resetProposalSummaryCache();
  const b = await boot(db, { trees: CHANGED });
  const sum = () => b.t.call(b.t.owner, 'GET', `${b.url}/summary`);
  assert.equal((await sum()).body.summary.count, 4);
  await b.dismiss('skip');
  const reads = b.t.repo.listCalls;
  const skipped = await sum();
  assert.deepEqual([skipped.body.summary.state, skipped.body.summary.count], ['skipped', 0]);
  assert.equal(b.t.repo.listCalls, reads);
  await b.dismiss('later');
  assert.deepEqual([(await sum()).body.summary.state, (await sum()).body.summary.count], ['later', 4]);
  await b.dismiss('reopen');
  assert.equal((await sum()).body.summary.count, 4);
});

dbTest('summary: an app without a repository is unavailable and nothing is read; another workspace is 404; a viewer may read', async (db) => {
  resetProposalSummaryCache();
  const t = await bootStaged(db);
  const res = await t.call(t.owner, 'POST', '/apps', { platform: 'ios', identifier: 'com.acme.other', credentialId: t.iosCredential, name: 'No repo' });
  const app = res.body.app.id as string;
  const before = t.repo.listCalls;
  const none = await t.call(t.owner, 'GET', `/apps/${app}/release/asset-proposal/summary`);
  assert.equal(none.status, 200, none.text);
  assert.deepEqual([none.body.summary.available, none.body.summary.reason, none.body.summary.count], [false, 'no_repository', 0]);
  assert.equal(t.repo.listCalls, before);
  assert.equal((await t.call(t.owner, 'GET', '/apps/nope/release/asset-proposal/summary')).status, 404);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.call(outsider, 'GET', `/apps/${app}/release/asset-proposal/summary`)).status, 404);
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'GET', `/apps/${app}/release/asset-proposal/summary`)).status, 200);
});

const never = <T>() => new Promise<T>(() => undefined);

dbTest('staging returns promptly with one result per item (a success is not slowed by the bounds)', async (db) => {
  const b = await boot(db, { trees: CHANGED });
  const started = Date.now();
  const done = await b.stage({ itemIds: ['text:en-US:promotional_text', 'graphics:en-US:screenshot:iphone_6_5'] });
  assert.equal(done.status, 200, done.text);
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(done.body.results, [
    { id: 'text:en-US:promotional_text', status: 'staged' },
    { id: 'graphics:en-US:screenshot:iphone_6_5', status: 'staged' },
  ]);
  assert.ok(done.body.proposal, 'what is left comes with the answer');
});

dbTest('a repository that hangs while the proposal is recomputed for staging: 504 stage_timeout, nothing is left locked, staging works again', async (db) => {
  const b = await boot(db, { trees: CHANGED, deadlineMs: 1500 });
  assert.equal((await b.get()).status, 200, 'the proposal is read (and cached) first');
  // Staging recomputes the proposal; with the index of the commits forgotten that is a repository read, and the repository does not answer.
  clearAssetIndexes();
  const real = { files: b.t.repo.listFiles, entries: b.t.repo.listBlobEntries, commit: b.t.repo.resolveCommit };
  b.t.repo.listFiles = () => never();
  b.t.repo.listBlobEntries = () => never();
  b.t.repo.resolveCommit = () => never();
  const started = Date.now();
  const slow = await b.stage({ itemIds: ['graphics:en-US:screenshot:iphone_6_5'] });
  assert.equal(slow.status, 504, slow.text);
  assert.equal(slow.body.error, 'stage_timeout');
  assert.equal(slow.body.code, 'assetProposal.stageTimeout');
  assert.ok(Date.now() - started < 8000, 'the request did not stay open');
  Object.assign(b.t.repo, { listFiles: real.files, listBlobEntries: real.entries, resolveCommit: real.commit });
  const again = await b.stage({ itemIds: ['text:en-US:promotional_text'] });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.results[0].status, 'staged');
});

dbTest('a proposal read that hangs: 504 compare_timeout (the card shows Try again)', async (db) => {
  const b = await boot(db, { trees: CHANGED, deadlineMs: 150 });
  b.t.repo.resolveCommit = () => never();
  b.t.repo.listFiles = () => never();
  b.t.repo.listBlobEntries = () => never();
  const res = await b.get();
  assert.equal(res.status, 504, res.text);
  assert.equal(res.body.error, 'compare_timeout');
});

dbTest('a locked App Store app answers 409 metadata_locked at once, never after a wait', async (db) => {
  const b = await boot(db, { trees: CHANGED, releases: 'locked' });
  const started = Date.now();
  const res = await b.stage({ itemIds: ['text:en-US:promotional_text'] });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'metadata_locked');
  assert.ok(Date.now() - started < 5000);
});
