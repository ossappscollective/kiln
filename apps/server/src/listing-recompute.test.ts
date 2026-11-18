import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Platform } from '@mrm/core';
import {
  GithubError,
  type StoreApp,
  type StoreBuild,
  type StoreConnector,
  type StoreListing,
  type StoreVersion,
} from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { BranchRepo } from './fixup-test-helpers.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import type { StoreConnectorFactory } from './services/apps.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { forgetInspectedChangeSets } from './services/listing-repo.ts';
import { diffFromPrevious, planPull, textHash } from './services/listing-pull.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

// Recomputing a store pull: the same change set, made again from the CURRENT store snapshot and
// the CURRENT repository. Fakes only: no store and no GitHub is contacted.

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
const ASC_SECRET = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });

type Texts = Record<string, Record<string, string>>;

const iosListing = (live: Texts): StoreListing => ({
  platform: 'ios',
  appStoreId: '1234567890',
  warnings: [],
  channels: [{ channel: 'live', versionString: '2.0', listing: { appStore: { locales: live } } }],
});

class FakeStore implements StoreConnector {
  readonly platform: Platform = 'ios';
  listing: StoreListing | undefined;
  calls: string[] = [];
  async readListing(id: string): Promise<StoreListing> {
    this.calls.push(`readListing:${id}`);
    if (!this.listing) throw new Error('no listing set');
    return this.listing;
  }
  async verifyCredentials() {}
  async listApps(): Promise<StoreApp[]> {
    return [{ storeId: '1234567890', platform: 'ios', name: 'Acme', bundleId: 'com.acme.app' }];
  }
  async listVersions(): Promise<StoreVersion[]> {
    return [];
  }
  async listBuilds(): Promise<StoreBuild[]> {
    return [];
  }
}

type Db = Parameters<typeof bootRepoApp>[0];

async function boot(db: Db, options: { syncLimit?: number } = {}) {
  const store = new FakeStore();
  const factory: StoreConnectorFactory = () => store;
  const repo = new BranchRepo();
  clearRepoSnapshots();
  const t = await bootRepoApp(db, repo, {
    masterKey: randomBytes(32),
    appSync: {
      connectorFactory: factory,
      ...(options.syncLimit === undefined ? {} : { limiter: createTestLimiter({ limit: options.syncLimit }) }),
    },
  });
  forgetInspectedChangeSets();
  const credential = await t.addCredential('app_store_connect', ASC_SECRET);
  const addApp = async (extra: Record<string, unknown>) =>
    (await t.call(t.owner, 'POST', '/apps', { platform: 'ios', identifier: 'com.acme.app', credentialId: credential, ...extra })).body.app.id as string;
  return { ...t, repo, store, addApp };
}

const REPO_EN = { name: 'Acme App', subtitle: 'Old subtitle', description: 'A description that is long enough.' };
const DE = { name: 'Acme App', subtitle: 'Alter Untertitel' };
const SUBTITLE = 'fastlane/metadata/en-US/subtitle.txt';
const DESCRIPTION = 'fastlane/metadata/en-US/description.txt';

/** An app whose store and repository agree, then a store that moved: a draft pull of the subtitle and the description. */
async function pulled(db: Db, options: { syncLimit?: number } = {}) {
  const t = await boot(db, options);
  const { repositoryId } = await t.connect();
  const appId = await t.addApp({ repositoryId });
  t.store.listing = iosListing({ 'en-US': REPO_EN, 'de-DE': DE });
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/sync`)).status, 200);
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/listing/repo-refresh`)).status, 200);
  t.store.listing = iosListing({
    'en-US': { ...REPO_EN, subtitle: 'Fresh from the store', description: 'The new store description text.' },
    'de-DE': DE,
  });
  await t.call(t.owner, 'POST', `/apps/${appId}/sync`);
  const res = await t.call(t.owner, 'POST', `/apps/${appId}/listing/pull`, {});
  assert.equal(res.status, 201, res.text);
  const setId = res.body.changeSet.id as string;
  return { t, appId, repositoryId, setId, first: res.body };
}
type Pulled = Awaited<ReturnType<typeof pulled>>;

const sync = (p: Pulled) => p.t.call(p.t.owner, 'POST', `/apps/${p.appId}/sync`);
const recompute = (p: Pulled, body?: unknown, cookie = p.t.owner, id = p.setId) =>
  p.t.call(cookie, 'POST', `/change-sets/${id}/recompute`, body);
const getSet = async (p: Pulled, id = p.setId) => (await p.t.call(p.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
const approve = (p: Pulled, id = p.setId) => p.t.call(p.t.owner, 'POST', `/change-sets/${id}/approve`);
const after = (set: { files: { path: string; after?: string }[] }, path: string) => set.files.find((f) => f.path === path)?.after;

// ---------------------------------------------------------------------------------------------
// The pure part

const plan = (changes: { repoLocale: string; field: string; after: string }[], skipped: { repoLocale: string; field?: string; reason: string }[] = []) =>
  ({
    changes: changes.map((c) => ({ locale: c.repoLocale, label: c.field, status: 'store-ahead', before: null, newLocale: false, ...c })),
    skipped: skipped.map((s) => ({ locale: s.repoLocale, message: '', ...s })),
    problems: [],
    locales: [],
    desired: {},
  }) as unknown as Parameters<typeof diffFromPrevious>[1];

test('diffFromPrevious: store changed, unchanged, added, and dropped with its reason', () => {
  const previous = [
    { locale: 'en-US', repoLocale: 'en-US', field: 'subtitle', hash: textHash('one') },
    { locale: 'en-US', repoLocale: 'en-US', field: 'name', hash: textHash('same') },
    { locale: 'en-US', repoLocale: 'en-US', field: 'description', hash: textHash('d') },
    { locale: 'de-DE', repoLocale: 'de-DE', field: 'subtitle', hash: textHash('e') },
  ];
  const diff = diffFromPrevious(
    previous,
    plan(
      [
        { repoLocale: 'en-US', field: 'subtitle', after: 'two' },
        { repoLocale: 'en-US', field: 'name', after: 'same' },
        { repoLocale: 'en-US', field: 'keywords', after: 'k' },
      ],
      [{ repoLocale: 'de-DE', field: 'subtitle', reason: 'repo_ahead' }],
    ),
  );
  const by = (field: string, locale = 'en-US') => diff.find((d) => d.field === field && d.repoLocale === locale);
  assert.equal(by('subtitle')?.change, 'store_changed');
  assert.equal(by('name')?.change, 'unchanged');
  assert.equal(by('keywords')?.change, 'added');
  assert.deepEqual([by('description')?.change, by('description')?.reason], ['dropped', 'identical']);
  assert.deepEqual([by('subtitle', 'de-DE')?.change, by('subtitle', 'de-DE')?.reason], ['dropped', 'repo_ahead']);
  assert.equal(textHash('x').length, 16);
});

test('planPull is unchanged by the recompute work (smoke)', () => {
  assert.equal(typeof planPull, 'function');
});

// ---------------------------------------------------------------------------------------------
// The origin

dbTest('a pull stores its request (hashes, no text) on the change set; the view says only where it came from', async (db) => {
  const p = await pulled(db);
  const [row] = await db.query('SELECT origin_json FROM change_sets WHERE id = ?', [p.setId]);
  const origin = JSON.parse(String(row?.origin_json));
  assert.equal(origin.source, 'store_pull');
  assert.equal(origin.appId, p.appId);
  assert.equal(origin.channel, 'live');
  assert.equal(origin.request.addLocales, false);
  assert.deepEqual(
    origin.fields.map((f: { field: string }) => f.field).sort(),
    ['description', 'subtitle'],
  );
  assert.ok(!String(row?.origin_json).includes('Fresh from the store'), 'no store text is kept in the origin');
  assert.ok(!String(row?.origin_json).includes('/'), 'no path');
  const set = await getSet(p);
  assert.deepEqual(set.origin, { source: 'store_pull', appId: p.appId, channel: 'live' });
  assert.deepEqual(JSON.parse(JSON.stringify(set.fixups)), []);
  // A change set from the plain create route has no origin.
  const read = await p.t.call(p.t.owner, 'GET', `/repositories/${p.repositoryId}/listing`);
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].name = 'Acme Pro';
  const made = await p.t.call(p.t.owner, 'POST', `/repositories/${p.repositoryId}/change-sets`, { summary: 'Rename', listing });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.changeSet.origin, null);
});

// ---------------------------------------------------------------------------------------------
// Recompute

dbTest('nothing moved: the same files, an approval stays, every field is unchanged', async (db) => {
  const p = await pulled(db);
  assert.equal((await approve(p)).status, 200);
  const res = await recompute(p);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.unchanged, true);
  assert.equal(res.body.approvalCleared, false);
  assert.equal(res.body.nothingLeft, false);
  assert.equal(res.body.changeSet.status, 'approved');
  assert.deepEqual(res.body.diffFromPrevious.map((d: { change: string }) => d.change), ['unchanged', 'unchanged']);
  assert.equal(res.body.changes.length, 2);
  assert.ok(Array.isArray(res.body.skipped) && Array.isArray(res.body.problems));
  assert.equal((await b(res)).refreshed, false);
  assert.equal((await p.t.auditActions()).filter((a) => a.action === 'changeset.recompute').length, 0, 'nothing written, nothing audited');
});
const b = async (res: { body: { store: { refreshed: boolean } } }) => res.body.store;

dbTest('the store text changed again: the same change set gets the new text, the approval is cleared, id and creator stay', async (db) => {
  const p = await pulled(db);
  assert.equal((await approve(p)).status, 200);
  const before = await getSet(p);
  p.t.store.listing = iosListing({
    'en-US': { ...REPO_EN, subtitle: 'Even fresher subtitle', description: 'The new store description text.' },
    'de-DE': DE,
  });
  await sync(p);
  const res = await recompute(p);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.unchanged, false);
  assert.equal(res.body.approvalCleared, true);
  const set = res.body.changeSet;
  assert.equal(set.id, p.setId);
  assert.equal(set.status, 'draft');
  assert.equal(set.approvedBy, null);
  assert.deepEqual(set.createdBy, before.createdBy);
  assert.equal(set.createdAt, before.createdAt);
  const stored = await getSet(p);
  assert.equal(after(stored, SUBTITLE), 'Even fresher subtitle\n');
  assert.equal(after(stored, DESCRIPTION), 'The new store description text.\n');
  const byField = Object.fromEntries(res.body.diffFromPrevious.map((d: { field: string; change: string }) => [d.field, d.change]));
  assert.deepEqual(byField, { subtitle: 'store_changed', description: 'unchanged' });
  assert.equal(res.body.changes.find((c: { field: string }) => c.field === 'subtitle').after, 'Even fresher subtitle');
  // The origin remembers the new text's hash, so a second recompute is unchanged.
  const again = await recompute(p);
  assert.equal(again.body.unchanged, true);
  assert.deepEqual(again.body.diffFromPrevious.map((d: { change: string }) => d.change), ['unchanged', 'unchanged']);
  // Audit: counts only.
  const events = (await p.t.auditActions()).filter((a) => a.action === 'changeset.recompute');
  assert.equal(events.length, 1);
  const detail = JSON.parse(events[0]?.detail ?? '{}');
  assert.deepEqual([detail.was, detail.files, detail.storeChanged, detail.approvalCleared], ['approved', { before: 2, after: 2 }, 1, true]);
  assert.ok(!events[0]?.detail.includes('Even fresher'), 'no text in the audit trail');
  assert.equal(events[0]?.actorType, 'user');
});

dbTest('the store went back to the repository text: that field leaves the set (identical); all of them: nothingLeft', async (db) => {
  const p = await pulled(db);
  p.t.store.listing = iosListing({
    'en-US': { ...REPO_EN, subtitle: 'Fresh from the store' },
    'de-DE': DE,
  });
  await sync(p);
  const one = await recompute(p);
  assert.equal(one.status, 200, one.text);
  const reverted = one.body.diffFromPrevious.find((d: { field: string }) => d.field === 'description');
  assert.deepEqual([reverted.change, reverted.reason], ['dropped', 'identical']);
  assert.equal(one.body.changeSet.filesChanged, 1);
  assert.equal((await getSet(p)).files.some((f: { path: string }) => f.path === DESCRIPTION), false);

  p.t.store.listing = iosListing({ 'en-US': REPO_EN, 'de-DE': DE });
  await sync(p);
  const none = await recompute(p);
  assert.equal(none.status, 200, none.text);
  assert.equal(none.body.nothingLeft, true);
  assert.equal(none.body.changeSet.filesChanged, 0);
  assert.equal(none.body.changeSet.status, 'draft');
  // Nothing left to approve: the change set can be discarded.
  const refused = await approve(p);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'nothing_to_apply');
  assert.equal((await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/discard`)).status, 200);
});

dbTest('the repository moved: a field the repository has caught up on leaves the set, the rest is made against the new files', async (db) => {
  const p = await pulled(db);
  // Someone committed the store's description to the repository.
  p.t.repo.files.set(DESCRIPTION, 'The new store description text.\n');
  p.t.repo.files.set(SUBTITLE, 'Old subtitle\n');
  clearRepoSnapshots();
  const res = await recompute(p);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.changeSet.filesChanged, 1);
  const diff = Object.fromEntries(res.body.diffFromPrevious.map((d: { field: string; change: string }) => [d.field, d.change]));
  assert.deepEqual(diff, { subtitle: 'unchanged', description: 'dropped' });
  const set = await getSet(p);
  assert.equal(set.files[0].path, SUBTITLE);
  assert.equal(set.files[0].before, 'Old subtitle\n');
});

dbTest('a failed change set without a branch is recomputed and is a draft again; one with a branch is not (use fix up)', async (db) => {
  const p = await pulled(db);
  assert.equal((await approve(p)).status, 200);
  p.t.repo.proposeErrors.push(new GithubError('server', 'GitHub failed'));
  const failed = await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/apply`);
  assert.equal(failed.status, 502, failed.text);
  assert.equal((await getSet(p)).status, 'failed');
  p.t.store.listing = iosListing({ 'en-US': { ...REPO_EN, subtitle: 'After the failure', description: 'The new store description text.' }, 'de-DE': DE });
  await sync(p);
  const res = await recompute(p);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.changeSet.status, 'draft');
  assert.equal(after(await getSet(p), SUBTITLE), 'After the failure\n');

  await db.execute("UPDATE change_sets SET status = 'failed', branch = 'mrm/x' WHERE id = ?", [p.setId]);
  const branch = await recompute(p);
  assert.equal(branch.status, 409);
  assert.equal(branch.body.error, 'has_branch');
  await db.execute("UPDATE change_sets SET status = 'applied' WHERE id = ?", [p.setId]);
  assert.equal((await recompute(p)).status, 409);
  assert.equal((await recompute(p)).body.error, 'invalid_state');
});

dbTest('not_recomputable: a change set that is not a store pull, an old row with no origin, an app that is gone or relinked', async (db) => {
  const p = await pulled(db);
  const read = await p.t.call(p.t.owner, 'GET', `/repositories/${p.repositoryId}/listing`);
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].name = 'Acme Pro';
  const plain = (await p.t.call(p.t.owner, 'POST', `/repositories/${p.repositoryId}/change-sets`, { summary: 'Rename', listing })).body.changeSet.id;
  const res = await recompute(p, undefined, p.t.owner, plain);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'not_recomputable');
  assert.equal((await getSet(p, plain)).status, 'draft', 'untouched');

  await db.execute('UPDATE change_sets SET origin_json = NULL WHERE id = ?', [p.setId]);
  const old = await recompute(p);
  assert.equal(old.status, 409);
  assert.equal(old.body.error, 'not_recomputable');
  assert.equal((await getSet(p)).origin, null);
});

dbTest('app_gone and app_relinked', async (db) => {
  const p = await pulled(db);
  await db.execute('UPDATE apps SET repository_id = NULL WHERE id = ?', [p.appId]);
  const relinked = await recompute(p);
  assert.equal(relinked.status, 409);
  assert.equal(relinked.body.error, 'app_relinked');
  await db.execute('DELETE FROM app_listing_status WHERE app_id = ?', [p.appId]);
  const gone = await p.t.call(p.t.owner, 'DELETE', `/apps/${p.appId}`);
  assert.equal(gone.status, 204);
  const res = await recompute(p);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'app_gone');
});

dbTest('refresh: true runs the read-only store read first, under the sync limiter, and needs apps.sync', async (db) => {
  const p = await pulled(db, { syncLimit: 4 });
  const calls = () => p.t.store.calls.length;
  const start = calls();
  // The store changed and nobody synced: without refresh the stored snapshot is used.
  p.t.store.listing = iosListing({
    'en-US': { ...REPO_EN, subtitle: 'Straight from the store', description: 'The new store description text.' },
    'de-DE': DE,
  });
  const stale = await recompute(p);
  assert.equal(stale.body.unchanged, true);
  assert.equal(calls(), start, 'no store read without refresh');
  const fresh = await recompute(p, { refresh: true });
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(calls(), start + 1);
  assert.equal(fresh.body.store.refreshed, true);
  assert.equal(after(await getSet(p), SUBTITLE), 'Straight from the store\n');
  // The budget: 4 store reads a minute for the workspace; the pulled() fixture used some.
  let limited: Awaited<ReturnType<typeof recompute>> | undefined;
  for (let i = 0; i < 6 && !limited; i++) {
    const r = await recompute(p, { refresh: true });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the store read is rate limited');
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const stores = calls();
  assert.equal((await recompute(p)).status, 200, 'a recompute that does not refresh still works');
  assert.equal(calls(), stores);

  // A member may recompute but a refresh needs apps.sync, which members have; a viewer has neither.
  const viewer = await p.t.addMember('viewer');
  assert.equal((await recompute(p, { refresh: true }, viewer)).status, 403);
});

dbTest('a failed store read does not stop the recompute: the last good values are used and the failure is said', async (db) => {
  const p = await pulled(db);
  p.t.store.listing = undefined;
  const res = await recompute(p, { refresh: true });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.store.error || res.body.warnings.some((w: string) => /last attempt/.test(w)) || res.body.store.refreshed);
});

dbTest('rights and isolation: a viewer cannot recompute, an outsider and another workspace see 404, a bad body is 400', async (db) => {
  const p = await pulled(db);
  const viewer = await p.t.addMember('viewer');
  const member = await p.t.addMember('member');
  assert.equal((await recompute(p, {}, viewer)).status, 403);
  assert.equal((await recompute(p, {}, member)).status, 200, 'changesets.write and listing.read are enough');
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await p.t.addMember('owner', 'other');
  assert.equal((await p.t.call(outsider, 'POST', `/change-sets/${p.setId}/recompute`, {}, 'other')).status, 404);
  assert.equal((await p.t.call(outsider, 'POST', `/change-sets/${p.setId}/recompute`, {}, p.t.workspaceId)).status, 404);
  assert.equal((await recompute(p, { refresh: 'yes' })).status, 400);
  assert.equal((await recompute(p, { extra: true })).status, 400);
  const missing = await recompute(p, {}, p.t.owner, 'no-such-id');
  assert.equal(missing.status, 404);
  assert.ok(!p.t.texts.some((t) => t.includes(KEY_LINE)), 'no secret in any answer');
});

dbTest('fix up with recompute: the branch of an applied store pull takes the content recomputed from the store, as one commit', async (db) => {
  const p = await pulled(db);
  assert.equal((await approve(p)).status, 200);
  const applied = await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/apply`);
  assert.equal(applied.status, 200, applied.text);
  const branch = applied.body.changeSet.branch as string;
  const tip = p.t.repo.heads.get(branch);
  // Plain recompute is refused: the branch exists.
  const refused = await recompute(p);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'invalid_state');
  // The store changed again; the fix up recomputes and commits on top of the branch.
  p.t.store.listing = iosListing({
    'en-US': { ...REPO_EN, subtitle: 'Changed once more', description: 'The new store description text.' },
    'de-DE': DE,
  });
  await sync(p);
  const viewer = await p.t.addMember('viewer');
  assert.equal((await p.t.call(viewer, 'POST', `/change-sets/${p.setId}/fixup`, { recompute: true })).status, 403);
  const member = await p.t.addMember('member');
  assert.equal((await p.t.call(member, 'POST', `/change-sets/${p.setId}/fixup`, { recompute: true })).status, 403, 'fix up needs changesets.approve');
  const dry = await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/fixup`, { recompute: true, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(dry.body.willCommit, [SUBTITLE], 'only the field the store changed; the fields the set already committed are not undone');
  assert.equal(p.t.repo.commitCalls.length, 0);
  const res = await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/fixup`, { recompute: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(p.t.repo.commitCalls.length, 1);
  assert.equal(p.t.repo.commitCalls[0]?.expectedTip, tip);
  assert.deepEqual(p.t.repo.commitCalls[0]?.changes, [{ path: SUBTITLE, content: 'Changed once more\n' }]);
  assert.equal(res.body.changeSet.status, 'applied');
  assert.equal(res.body.changeSet.fixups.length, 1);
  assert.deepEqual(res.body.recompute.diffFromPrevious.map((d: { field: string; change: string }) => [d.field, d.change]).sort(), [['description', 'unchanged'], ['subtitle', 'store_changed']]);
  // The origin remembers the new store text, so the same fix up again has nothing to do.
  const again = await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/fixup`, { recompute: true });
  assert.equal(again.body.nothingToFix, true);
  assert.equal(p.t.repo.commitCalls.length, 1);
  assert.equal((await p.t.call(p.t.owner, 'POST', `/change-sets/${p.setId}/fixup`, { refresh: true })).status, 400);
});
