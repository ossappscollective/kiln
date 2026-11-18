import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Platform } from '@mrm/core';
import {
  type StoreApp,
  type StoreBuild,
  type StoreConnector,
  StoreError,
  type StoreListing,
  type StoreVersion,
} from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import {
  CARD_APP,
  SCAN_APP,
  scannerMonorepo,
  weatherApp,
} from '../../../packages/connectors/src/fastlane.fixtures.ts';
import { FakeRepo, bootRepoApp } from './repo-test-helpers.ts';
import type { StoreConnectorFactory } from './services/apps.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { forgetInspectedChangeSets } from './services/listing-repo.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

// The store pull end to end: a live store listing (a fake connector) into repository files (a fake
// GitHub), as a draft change set. Nothing here contacts a store or GitHub. The pure parts are in
// listing-pull-plan.test.ts.

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
const ASC_SECRET = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });
const PLAY_SECRET = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: PEM });

type Texts = Record<string, Record<string, string>>;

const iosListing = (live: Texts): StoreListing => ({
  platform: 'ios',
  appStoreId: '1234567890',
  warnings: [],
  channels: [{ channel: 'live', versionString: '2.0', listing: { appStore: { locales: live } } }],
});

const playListing = (locales: Texts): StoreListing => ({
  platform: 'android',
  appStoreId: 'com.acme.app',
  warnings: [],
  channels: [{ channel: 'live', listing: { googlePlay: { locales, changelogs: {} } } }],
});

class FakeStore implements StoreConnector {
  readonly platform: Platform;
  listing: StoreListing | undefined;
  error: unknown;
  calls: string[] = [];
  bundleId = 'com.acme.app';
  constructor(platform: Platform) {
    this.platform = platform;
  }
  async readListing(id: string): Promise<StoreListing> {
    this.calls.push(`readListing:${id}`);
    if (this.error) throw this.error;
    if (!this.listing) throw new Error('no listing set');
    return this.listing;
  }
  async verifyCredentials() {}
  async listApps(): Promise<StoreApp[]> {
    return [{ storeId: '1234567890', platform: 'ios', name: 'Acme', bundleId: this.bundleId }];
  }
  async listVersions(): Promise<StoreVersion[]> {
    return [];
  }
  async listBuilds(): Promise<StoreBuild[]> {
    return [];
  }
}

type Db = Parameters<typeof bootRepoApp>[0];

async function boot(db: Db, options: { files?: Record<string, string>; syncLimit?: number } = {}) {
  const stores = { ios: new FakeStore('ios'), android: new FakeStore('android') };
  const factory: StoreConnectorFactory = (input) =>
    input.kind === 'app_store_connect' ? stores.ios : stores.android;
  const repo = new FakeRepo();
  if (options.files) repo.files = new Map(Object.entries(options.files));
  clearRepoSnapshots();
  const t = await bootRepoApp(db, repo, {
    masterKey: randomBytes(32),
    appSync: {
      connectorFactory: factory,
      ...(options.syncLimit === undefined ? {} : { limiter: createTestLimiter({ limit: options.syncLimit }) }),
    },
  });
  forgetInspectedChangeSets();
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  const addApp = async (body: Record<string, unknown>) =>
    (await t.call(t.owner, 'POST', '/apps', body)).body.app.id as string;
  const addIos = (extra: Record<string, unknown> = {}) =>
    addApp({ platform: 'ios', identifier: 'com.acme.app', credentialId: iosCredential, ...extra });
  const addAndroid = (extra: Record<string, unknown> = {}) =>
    addApp({ platform: 'android', identifier: 'com.acme.app', credentialId: playCredential, ...extra });
  const sync = (id: string) => t.call(t.owner, 'POST', `/apps/${id}/sync`);
  const refreshRepo = (id: string) => t.call(t.owner, 'POST', `/apps/${id}/listing/repo-refresh`);
  const pull = (id: string, body: Record<string, unknown> = {}, cookie = t.owner) =>
    t.call(cookie, 'POST', `/apps/${id}/listing/pull`, body);
  const drafts = async () => (await db.query('SELECT id FROM change_sets')).length;
  return { ...t, stores, addIos, addAndroid, sync, refreshRepo, pull, drafts };
}

const REPO_EN = { name: 'Acme App', subtitle: 'Old subtitle', description: 'A description that is long enough.' };
const SUBTITLE = 'fastlane/metadata/en-US/subtitle.txt';
const DESCRIPTION = 'fastlane/metadata/en-US/description.txt';
const NAME = 'fastlane/metadata/en-US/name.txt';
const DE = { name: 'Acme App', subtitle: 'Alter Untertitel' };

/** An iOS app whose store and repository agree, so what changes next has a direction. */
async function agreed(db: Db, options: Parameters<typeof boot>[1] = {}) {
  const t = await boot(db, options);
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  t.stores.ios.listing = iosListing({ 'en-US': REPO_EN, 'de-DE': DE });
  assert.equal((await t.sync(id)).status, 200);
  assert.equal((await t.refreshRepo(id)).status, 200);
  return { t, id, repositoryId };
}

dbTest('a store-ahead field is pulled into the fastlane files as a draft, which then goes through the usual PR flow', async (db) => {
  const { t, id, repositoryId } = await agreed(db);
  // Someone edits the store in the console.
  t.stores.ios.listing = iosListing({
    'en-US': { ...REPO_EN, subtitle: 'Fresh from the store', description: 'The new store description text.' },
    'de-DE': DE,
  });
  await t.sync(id);

  const res = await t.pull(id);
  assert.equal(res.status, 201, res.text);
  const set = res.body.changeSet;
  assert.equal(set.status, 'draft');
  assert.equal(set.repositoryId, repositoryId);
  assert.match(set.summary, /^Pull the App Store listing of /);
  assert.deepEqual(set.files, [
    { path: DESCRIPTION, change: 'modified', before: 'A description that is long enough.\n', after: 'The new store description text.\n' },
    { path: SUBTITLE, change: 'modified', before: 'Old subtitle\n', after: 'Fresh from the store\n' },
  ]);
  assert.deepEqual(
    res.body.changes.map((c: { locale: string; field: string; status: string; before: string; after: string }) => [c.locale, c.field, c.status, c.before, c.after]),
    [
      ['en-US', 'subtitle', 'store-ahead', 'Old subtitle', 'Fresh from the store'],
      ['en-US', 'description', 'store-ahead', 'A description that is long enough.', 'The new store description text.'],
    ],
  );
  assert.deepEqual(res.body.skipped, []);
  assert.equal(res.body.channel, 'live');
  assert.deepEqual(res.body.target, {
    repositoryId,
    repository: 'acme/app',
    branch: 'main',
    source: 'fastlane',
    path: 'fastlane/metadata',
    selected: { id: null, origin: 'default', label: 'Detected folders' },
  });
  assert.equal(res.body.store.refreshed, false);
  // A draft writes nothing, and the audit event says where it came from.
  assert.equal(t.repo.proposals.length, 0);
  const created = (await t.auditActions()).filter((a) => a.action === 'changeset.create');
  assert.equal(created.length, 1);
  const detail = JSON.parse(created[0]?.detail ?? '{}');
  assert.equal(detail.source, 'store_pull');
  assert.equal(detail.appId, id);
  assert.equal(detail.repositoryId, repositoryId);
  assert.equal(detail.files, 2);

  // The draft is an ordinary change set: approve, apply, and a branch with a pull request exists.
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${set.id}/approve`)).status, 200);
  const applied = await t.call(t.owner, 'POST', `/change-sets/${set.id}/apply`);
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.body.changeSet.status, 'applied');
  assert.match(applied.body.changeSet.prUrl, /\/pull\/1$/);
  assert.equal(t.repo.proposals.length, 1);
  const branch = t.repo.branches.get(applied.body.changeSet.branch);
  assert.equal(branch?.get(SUBTITLE), 'Fresh from the store\n');
  assert.equal(branch?.get('fastlane/metadata/de-DE/subtitle.txt'), 'Alter Untertitel\n', 'the rest is untouched');
  assert.equal(t.repo.files.get(SUBTITLE), 'Old subtitle\n', 'the default branch is untouched until the pull request is merged');
});

dbTest('a repo-ahead field is left alone by default', async (db) => {
  const { t, id } = await agreed(db);
  // The repository changed (a merged pull request); the store has not caught up.
  t.repo.files.set(SUBTITLE, 'Repo is newer\n');
  clearRepoSnapshots();
  assert.equal((await t.refreshRepo(id)).status, 200);

  const res = await t.pull(id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.changeSet, null);
  assert.deepEqual(res.body.changes, []);
  assert.deepEqual(res.body.skipped.map((s: { field: string; reason: string }) => [s.field, s.reason]), [['subtitle', 'repo_ahead']]);
  assert.match(res.body.explanation, /Nothing to pull/);
  assert.equal(await t.drafts(), 0);
  // Naming it on purpose does not override that either.
  const named = await t.pull(id, { items: [{ locale: 'en-US', field: 'subtitle' }] });
  assert.equal(named.body.changeSet, null);
});

dbTest('a field the store does not have never blanks the repository value', async (db) => {
  const { t, id } = await agreed(db);
  // The store now shows only a new name; subtitle and description are absent, a keyword field is blank.
  t.stores.ios.listing = iosListing({ 'en-US': { name: 'Acme Pro', keywords: '  ' } });
  await t.sync(id);
  const res = await t.pull(id);
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body.changeSet.files.map((f: { path: string }) => f.path), [NAME]);
  assert.equal(res.body.changeSet.files[0].after, 'Acme Pro\n');
  assert.ok(res.body.changeSet.files.every((f: { after?: string }) => f.after !== undefined), 'nothing is deleted');
  // Named, the absent field is reported.
  const named = await t.pull(id, { fields: ['subtitle'] });
  assert.equal(named.status, 200);
  assert.deepEqual(named.body.skipped.map((s: { locale: string; reason: string }) => [s.locale, s.reason]), [
    ['en-US', 'missing_in_store'],
  ]);
});

dbTest('a value over the store limit is reported and not pulled, and never truncated', async (db) => {
  const { t, id } = await agreed(db);
  const long = 'N'.repeat(40);
  t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, name: long, subtitle: 'Short and fine' } });
  await t.sync(id);
  const res = await t.pull(id);
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body.changeSet.files.map((f: { path: string }) => f.path), [SUBTITLE]);
  assert.deepEqual(res.body.skipped.map((s: { field: string; reason: string }) => [s.field, s.reason]), [['name', 'over_limit']]);
  const problem = res.body.problems.find((p: { field: string }) => p.field === 'name');
  assert.deepEqual([problem.code, problem.limit, problem.actual, problem.locale], ['too_long', 30, 40, 'en-US']);
  // Only over-limit: nothing to draft.
  const only = await t.pull(id, { fields: ['name'] });
  assert.equal(only.status, 200);
  assert.equal(only.body.changeSet, null);
  assert.equal(only.body.skipped[0].reason, 'over_limit');
});

dbTest('locales: mapped between store and repository codes; a locale not in the repository is skipped or created', async (db) => {
  const files = {
    'fastlane/Fastfile': 'lane :release do\n  upload_to_app_store\nend\n',
    'fastlane/Appfile': 'app_identifier("com.acme.app")\n',
    [NAME]: 'Acme App\n',
    [SUBTITLE]: 'Old subtitle\n',
    'fastlane/metadata/ja-JP/name.txt': 'Acme JP\n',
  };
  const t = await boot(db, { files });
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  t.stores.ios.listing = iosListing({
    'en-US': { name: 'Acme App', subtitle: 'Old subtitle' },
    ja: { name: 'Acme Japan' },
    'fr-FR': { name: 'Acme France', subtitle: 'Sous-titre' },
  });
  await t.sync(id);

  const res = await t.pull(id);
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body.changeSet.files.map((f: { path: string; change: string }) => [f.path, f.change]), [
    ['fastlane/metadata/ja-JP/name.txt', 'modified'],
  ]);
  assert.deepEqual(res.body.locales, [
    { locale: 'en-US', repoLocale: 'en-US', how: 'exact' },
    { locale: 'ja', repoLocale: 'ja-JP', how: 'equivalent' },
  ]);
  assert.deepEqual(res.body.skipped.map((s: { locale: string; reason: string }) => [s.locale, s.reason]), [['fr-FR', 'locale_not_in_repo']]);

  const added = await t.pull(id, { addLocales: true, summary: 'Add the French listing' });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.body.changeSet.summary, 'Add the French listing');
  assert.deepEqual(added.body.changeSet.files.map((f: { path: string; change: string }) => [f.path, f.change]), [
    ['fastlane/metadata/fr-FR/name.txt', 'added'],
    ['fastlane/metadata/fr-FR/subtitle.txt', 'added'],
    ['fastlane/metadata/ja-JP/name.txt', 'modified'],
  ]);
  assert.equal(added.body.changeSet.files[0].after, 'Acme France\n', 'a new file follows the convention of the existing ones');
  const french = added.body.changes.filter((c: { locale: string }) => c.locale === 'fr-FR');
  assert.equal(french.length, 2);
  assert.ok(french.every((c: { status: string; newLocale: boolean }) => c.status === 'new-locale' && c.newLocale));
  assert.deepEqual(added.body.skipped, []);
});

const EXPO_STORE = `{
  "configVersion": 0,
  "apple": {
    "copyright": "2026 Acme, Inc.",
    "info": {
      "en-US": {
        "title": "Acme Expo",
        "subtitle": "Old expo subtitle",
        "description": "A description that is long enough.",
        "keywords": ["acme", "expo"]
      }
    }
  }
}
`;
const expoProject = (): Record<string, string> => ({
  'package.json': '{ "name": "acme", "dependencies": { "expo": "^52.0.0" } }\n',
  'app.json': '{ "expo": { "name": "Acme", "slug": "acme" } }\n',
  'store.config.json': EXPO_STORE,
});

dbTest('the Expo store config is the App Store target and is edited in place', async (db) => {
  const t = await boot(db, { files: { ...expoProject(), [NAME]: 'Ignored\n' } });
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  t.stores.ios.listing = iosListing({
    'en-US': { name: 'Acme Expo', subtitle: 'New expo subtitle', description: 'A description that is long enough.', keywords: 'acme,expo' },
    'de-DE': { name: 'Acme Expo DE' },
    sw: { name: 'Acme Expo SW' },
  });
  await t.sync(id);

  // Without addLocales the new locales are skipped.
  const plain = await t.pull(id);
  assert.deepEqual(plain.body.skipped.map((s: { locale: string; reason: string }) => [s.locale, s.reason]), [
    ['de-DE', 'locale_not_in_repo'],
    ['sw', 'locale_not_in_repo'],
  ]);
  assert.deepEqual(plain.body.changes.map((c: { locale: string; field: string }) => `${c.locale}/${c.field}`), ['en-US/subtitle']);

  const res = await t.pull(id, { addLocales: true });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.target.source, 'expo-store-config');
  assert.equal(res.body.target.path, 'store.config.json');
  assert.deepEqual(res.body.changeSet.files.map((f: { path: string }) => f.path), ['store.config.json']);
  const after = JSON.parse(res.body.changeSet.files[0].after);
  assert.equal(after.apple.info['en-US'].subtitle, 'New expo subtitle');
  assert.deepEqual(after.apple.info['en-US'].keywords, ['acme', 'expo']);
  assert.equal(after.apple.info['de-DE'].title, 'Acme Expo DE');
  assert.equal(after.apple.info.sw, undefined);
  assert.equal(after.apple.copyright, '2026 Acme, Inc.');
  assert.deepEqual(res.body.skipped.map((s: { locale: string; reason: string }) => [s.locale, s.reason]), [['sw', 'locale_unsupported']]);
  assert.deepEqual(res.body.changes.map((c: { locale: string; field: string }) => `${c.locale}/${c.field}`), ['de-DE/name', 'en-US/subtitle']);
  // The change set then applies like any other.
  const set = res.body.changeSet.id;
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${set}/approve`)).status, 200);
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${set}/apply`)).status, 200);
  assert.equal(t.repo.proposals[0]?.changeSet.files.length, 1);
});

dbTest('Google Play: titles and descriptions are pulled; release notes and the other store are never touched', async (db) => {
  const t = await boot(db, { files: weatherApp({ enChangelogs: 3, frChangelogs: 3 }) });
  const { repositoryId } = await t.connect();
  const id = await t.addAndroid({ repositoryId });
  t.stores.android.listing = playListing({
    'en-US': { title: 'Example Weather Pro', short_description: 'Example Weather: short text (en-US).', video: 'https://example.com/video' },
  });
  await t.sync(id);
  const res = await t.pull(id);
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body.changeSet.files.map((f: { path: string }) => f.path), ['fastlane/metadata/android/en-US/title.txt']);
  assert.match(res.body.changeSet.summary, /Google Play listing/);
  assert.equal(res.body.target.source, 'fastlane');
  assert.equal(res.body.target.path, 'fastlane/metadata/android');
});

dbTest('errors: no repository, an unknown field, nothing read from the store yet, and the body', async (db) => {
  const t = await boot(db);
  const unlinked = await t.addIos({ identifier: 'com.acme.unlinked' });
  const none = await t.pull(unlinked);
  assert.equal(none.status, 422);
  assert.equal(none.body.error, 'no_repository');

  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  const empty = await t.pull(id);
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error, 'no_store_listing');
  assert.equal(t.repo.listCalls, 0, 'nothing is read from GitHub when there is nothing to pull');

  t.stores.ios.listing = iosListing({ 'en-US': REPO_EN });
  await t.sync(id);
  const field = await t.pull(id, { fields: ['title'] });
  assert.equal(field.status, 422);
  assert.equal(field.body.error, 'invalid_field');
  const bad = await t.pull(id, { items: [{ locale: 'en US', field: 'name' }], addLocales: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_request');
  const editable = await t.pull(id, { channel: 'editable' });
  assert.equal(editable.status, 422);
  assert.equal(editable.body.error, 'no_store_listing');
  assert.equal((await t.pull('nope')).status, 404);
  // No body at all is a pull with the defaults.
  const bare = await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${id}/listing/pull`, {
    method: 'POST',
    headers: { cookie: t.owner },
  });
  assert.equal(bare.status, 200);
  assert.equal(await t.drafts(), 0);
});

dbTest('no_changes is an answer, not an error: 200 with changeSet null and an explanation', async (db) => {
  const { t, id } = await agreed(db);
  const res = await t.pull(id);
  assert.equal(res.status, 200);
  assert.equal(res.body.changeSet, null);
  assert.deepEqual(res.body.changes, []);
  assert.match(res.body.explanation, /Nothing to pull/);
  assert.equal(res.body.target.source, 'fastlane');
  assert.equal(await t.drafts(), 0);
  assert.equal((await t.auditActions()).filter((a) => a.action === 'changeset.create').length, 0);
});

const monorepo = () => scannerMonorepo({ cardChangelogs: 2, scanChangelogs: 2 });

dbTest('a repository with several apps needs a target: ambiguity is reported with the candidates', async (db) => {
  const t = await boot(db, { files: monorepo() });
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  const id = await t.addIos({ repositoryId });
  t.stores.ios.listing = iosListing({ 'en-US': { name: 'Brand new scanner' } });
  await t.sync(id);

  const ambiguous = await t.pull(id);
  assert.equal(ambiguous.status, 422, ambiguous.text);
  assert.equal(ambiguous.body.error, 'target_required');
  assert.deepEqual(ambiguous.body.candidates.map((c: { id: string }) => c.id), [`auto:app:${CARD_APP}`, `auto:app:${SCAN_APP}`]);
  assert.equal(await t.drafts(), 0);

  // Naming the target settles it.
  const chosen = await t.pull(id, { target: `auto:app:${SCAN_APP}` });
  assert.equal(chosen.status, 201, chosen.text);
  assert.deepEqual(chosen.body.changeSet.files.map((f: { path: string }) => f.path), [
    `fastlane/metadata/${SCAN_APP}/ios/en-US/name.txt`,
  ]);
  assert.deepEqual(chosen.body.target.selected, { id: `auto:app:${SCAN_APP}`, origin: 'detected', label: SCAN_APP });
  const roots = await t.pull(id, { roots: { appStore: `fastlane/metadata/${CARD_APP}/ios` } });
  assert.equal(roots.status, 201, roots.text);
  assert.ok(roots.body.changeSet.files[0].path.startsWith(`fastlane/metadata/${CARD_APP}/ios/`));
  assert.equal((await t.pull(id, { target: 'no-such-target' })).body.error, 'target_not_found');

  // A saved target that names the app is used without being asked.
  const saved = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/listing-targets`, {
    name: 'Scanner',
    appId: id,
    appStoreRoot: `fastlane/metadata/${SCAN_APP}/ios`,
    googlePlayRoot: `fastlane/metadata/${SCAN_APP}/android`,
  });
  assert.equal(saved.status, 201, saved.text);
  const viaSaved = await t.pull(id);
  assert.equal(viaSaved.status, 201, viaSaved.text);
  assert.equal(viaSaved.body.target.selected.id, saved.body.target.id);
  // Two saved targets for one app: ask.
  await t.call(t.owner, 'POST', `/repositories/${repositoryId}/listing-targets`, {
    name: 'Scanner again',
    appId: id,
    appStoreRoot: `fastlane/metadata/${CARD_APP}/ios`,
  });
  const twice = await t.pull(id);
  assert.equal(twice.status, 422);
  assert.equal(twice.body.error, 'target_required');
  assert.deepEqual(twice.body.candidates.map((c: { label: string }) => c.label).sort(), ['Scanner', 'Scanner again']);
});

dbTest('a detected target that belongs to the app by its id is used without being asked', async (db) => {
  const t = await boot(db, { files: monorepo() });
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  t.stores.ios.bundleId = SCAN_APP;
  const id = await t.addIos({ repositoryId, identifier: SCAN_APP });
  t.stores.ios.listing = iosListing({ 'en-US': { name: 'Brand new scanner' } });
  await t.sync(id);
  const res = await t.pull(id);
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body.changeSet.files.map((f: { path: string }) => f.path), [`fastlane/metadata/${SCAN_APP}/ios/en-US/name.txt`]);
});

dbTest('refresh reads the store first (read-only) under the sync rate limit', async (db) => {
  const { t, id } = await agreed(db, { syncLimit: 3 });
  // agreed() used one of the three store reads for its sync.
  const before = t.stores.ios.calls.length;
  t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, subtitle: 'Straight from the store' }, 'de-DE': DE });
  const stale = await t.pull(id);
  assert.equal(stale.status, 200, 'without refresh the stored snapshot is used: nothing new');
  assert.equal(t.stores.ios.calls.length, before);

  const fresh = await t.pull(id, { refresh: true });
  assert.equal(fresh.status, 201, fresh.text);
  assert.equal(t.stores.ios.calls.length, before + 1);
  assert.equal(fresh.body.store.refreshed, true);
  assert.equal(fresh.body.changes[0].after, 'Straight from the store');

  // The third store read of the minute is the last one the limiter allows; the next is refused,
  // and a pull that does not refresh still works.
  assert.equal((await t.pull(id, { refresh: true })).status, 201);
  const limited = await t.pull(id, { refresh: true });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(t.stores.ios.calls.length, before + 2, 'a refused refresh does not read the store');
  assert.equal((await t.pull(id)).status, 201);
});

dbTest('a failed store read does not stop the pull: the last good values are used and the failure is said', async (db) => {
  const { t, id } = await agreed(db);
  t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, subtitle: 'Good read' } });
  await t.sync(id);
  t.stores.ios.error = new StoreError('appstoreconnect', 'unexpected', `Apple said no ${KEY_LINE}`, 400);
  const res = await t.pull(id, { refresh: true });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.changes[0].after, 'Good read');
  assert.ok(res.body.store.error);
  assert.ok(res.body.warnings.some((w: string) => /last attempt/.test(w)));
  assert.ok(!res.text.includes(KEY_LINE), 'no secret in the answer');
});

dbTest('rights, isolation and limits: viewers cannot pull, outsiders see 404, the repository read is rate limited', async (db) => {
  const { t, id } = await agreed(db);
  t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, subtitle: 'Secret new subtitle' } });
  await t.sync(id);
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  assert.equal((await t.pull(id, {}, viewer)).status, 403);
  assert.equal(await t.drafts(), 0);
  const asMember = await t.pull(id, {}, member);
  assert.equal(asMember.status, 201, asMember.text);
  assert.equal(asMember.body.changeSet.createdBy.type, 'user');

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const inOther = await t.call(outsider, 'POST', `/apps/${id}/listing/pull`, {}, 'other');
  assert.deepEqual([inOther.status, inOther.body], [404, { error: 'not_found' }]);
  const foreign = await t.pull(id, {}, outsider);
  assert.equal(foreign.status, 404);
  assert.ok(!foreign.text.includes('Secret new subtitle'));
  assert.equal((await t.call(t.owner, 'POST', `/apps/${id}/listing/pull`, {}, 'no-such-workspace')).status, 404);

  // The repository read budget is shared with repo-refresh (10 a minute): agreed() used one.
  let last = 0;
  for (let i = 0; i < 12 && last !== 429; i++) last = (await t.pull(id)).status;
  assert.equal(last, 429);
  // Reading the database is not limited.
  assert.equal((await t.call(t.owner, 'GET', `/apps/${id}/listing/drift`)).status, 200);

  // A body that is too large is refused before it is read.
  const huge = await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${id}/listing/pull`, {
    method: 'POST',
    headers: { cookie: t.owner, 'content-type': 'application/json' },
    body: JSON.stringify({ summary: 'x'.repeat(70_000) }),
  });
  assert.equal(huge.status, 413);
});
