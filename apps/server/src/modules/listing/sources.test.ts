import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectDetection } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootRepoApp, FakeRepo, fastlaneFiles } from '../../repo-test-helpers.ts';
import { detectedSources } from './sources.ts';

/**
 * Which source a store's listing comes from: the Expo store.config.json for the App Store when
 * the repository has one, fastlane otherwise; Google Play is always fastlane.
 */

const STORE_PATH = 'store.config.json';

/** An Expo project: store.config.json is only picked up when detection sees the project as Expo. */
const EXPO_STORE = `{
  "configVersion": 0,
  "apple": {
    "copyright": "2026 Acme, Inc.",
    "review": { "firstName": "Ada", "lastName": "Lovelace" },
    "info": {
      "en-US": {
        "title": "Acme Expo",
        "subtitle": "Old expo subtitle",
        "description": "A description that is long enough.",
        "keywords": ["acme", "expo"],
        "supportUrl": "https://example.com/support",
        "privacyPolicyUrl": "https://example.com/privacy"
      }
    }
  }
}
`;

const expoProject = (store: string = EXPO_STORE): Record<string, string> => ({
  'package.json': '{ "name": "acme", "dependencies": { "expo": "^52.0.0" } }\n',
  'app.json': '{ "expo": { "name": "Acme", "slug": "acme" } }\n',
  [STORE_PATH]: store,
});

const PLAY_TITLE = 'fastlane/metadata/android/en-US/title.txt';
const playFiles = (): Record<string, string> => ({
  [PLAY_TITLE]: 'Acme Play\n',
  'fastlane/metadata/android/en-US/short_description.txt': 'Short play text\n',
});

const setFiles = (repo: FakeRepo, ...sets: Record<string, string>[]) => {
  repo.files = new Map(Object.entries(Object.assign({}, ...sets)));
};

const reading = async (t: Awaited<ReturnType<typeof bootRepoApp>>, repositoryId: string) =>
  (await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`)).body;

const changed = (before: string, after: string): string[] => {
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length, 'same number of lines');
  return b.filter((line, i) => line !== a[i]);
};

dbTest(
  'Expo only: the App Store listing is read from store.config.json, with its warnings',
  async (db) => {
    const repo = new FakeRepo();
    setFiles(repo, expoProject());
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();

    const res = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
    assert.equal(res.status, 200);
    const view = res.body;
    assert.equal(view.listing.appStore.locales['en-US'].name, 'Acme Expo');
    assert.equal(view.listing.appStore.locales['en-US'].keywords, 'acme,expo');
    assert.equal(view.listing.appStore.copyright, '2026 Acme, Inc.');
    assert.equal(view.listing.googlePlay, undefined);
    assert.equal(view.sources.appStore.source, 'expo-store-config');
    assert.equal(view.sources.appStore.path, STORE_PATH);
    assert.equal(view.sources.appStore.found, true);
    assert.equal(view.sources.appStore.error, undefined);
    assert.deepEqual(view.sources.appStore.uncovered, ['apple.review']);
    assert.deepEqual(view.sources.appStore.unknown, []);
    assert.ok(view.sources.appStore.warnings.some((w: string) => /apple\.review/.test(w)));
    // Play is fastlane only: nothing there, and the source says where it would be.
    assert.equal(view.sources.googlePlay.source, 'fastlane');
    assert.equal(view.sources.googlePlay.found, false);
    // The existing fields keep their meaning.
    assert.deepEqual(view.found, { appStore: true, googlePlay: false });
    assert.equal(view.roots.appStore, 'fastlane/metadata');
    assert.ok(Array.isArray(view.warnings));
    assert.ok(Array.isArray(view.problems));
  },
);

dbTest('Expo only: an edit changes one line of store.config.json and nothing else', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, expoProject());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();

  const { res, id } = await t.draft(repositoryId, 'New expo subtitle');
  assert.equal(res.status, 201);
  const set = res.body.changeSet;
  assert.equal(set.filesChanged, 1);
  assert.equal(set.files[0].path, STORE_PATH);
  assert.equal(set.files[0].change, 'modified');
  assert.equal(set.files[0].before, EXPO_STORE);
  assert.deepEqual(changed(EXPO_STORE, set.files[0].after), [
    '        "subtitle": "New expo subtitle",',
  ]);
  assert.deepEqual(res.body.warnings, []);

  await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
  const applied = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.changeSet.status, 'applied');
  // Only that file reached the connector; the default branch is untouched.
  assert.deepEqual(
    repo.proposals[0]?.changeSet.files.map((f) => f.path),
    [STORE_PATH],
  );
  assert.equal(repo.files.get(STORE_PATH), EXPO_STORE);
  const branch = repo.branches.get(applied.body.changeSet.branch);
  assert.equal(branch?.get(STORE_PATH), set.files[0].after);
  assert.equal(branch?.has('fastlane/metadata/en-US/subtitle.txt'), false);

  // Reading it back from the branch's text gives the edited value.
  repo.files = new Map(branch);
  assert.equal(
    (await reading(t, repositoryId)).listing.appStore.locales['en-US'].subtitle,
    'New expo subtitle',
  );
});

dbTest('fastlane only: the source is fastlane with the metadata folder as its path', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();

  const view = await reading(t, repositoryId);
  assert.equal(view.sources.appStore.source, 'fastlane');
  assert.equal(view.sources.appStore.path, 'fastlane/metadata');
  assert.equal(view.sources.appStore.found, true);
  assert.deepEqual(view.sources.appStore.warnings, []);
  assert.equal(view.sources.googlePlay.source, 'fastlane');
  assert.equal(view.sources.googlePlay.path, 'fastlane/metadata/android');
  assert.equal(view.sources.googlePlay.found, false);
  assert.equal(view.listing.appStore.locales['en-US'].subtitle, 'Old subtitle');

  const { res } = await t.draft(repositoryId);
  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.changeSet.files.map((f: { path: string }) => f.path),
    ['fastlane/metadata/en-US/subtitle.txt'],
  );
});

dbTest('both: iOS comes from store.config.json, Android from fastlane', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, fastlaneFiles(), playFiles(), expoProject());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();

  const view = await reading(t, repositoryId);
  assert.equal(view.sources.appStore.source, 'expo-store-config');
  assert.equal(view.sources.googlePlay.source, 'fastlane');
  assert.equal(view.sources.googlePlay.path, 'fastlane/metadata/android');
  assert.equal(view.sources.googlePlay.found, true);
  // The App Store listing is the Expo one: the fastlane name and the de-DE folder are not mixed in.
  assert.equal(view.listing.appStore.locales['en-US'].name, 'Acme Expo');
  assert.equal(view.listing.appStore.locales['de-DE'], undefined);
  assert.equal(view.listing.googlePlay.locales['en-US'].title, 'Acme Play');
  assert.ok(
    view.warnings.some((w: string) => w.includes(STORE_PATH) && /ignored/.test(w)),
    'says the fastlane App Store files are ignored',
  );

  // One edit in each store: one file each, and no fastlane App Store file.
  const listing = view.listing;
  listing.appStore.locales['en-US'].subtitle = 'Both subtitle';
  listing.googlePlay.locales['en-US'].title = 'Acme Play 2';
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Edit both stores',
    listing,
  });
  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.changeSet.files.map((f: { path: string }) => f.path),
    [PLAY_TITLE, STORE_PATH],
  );

  // Only the Android part (as the UI sends it when only Play was edited): one fastlane file.
  const playOnly = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Edit Play',
    listing: { googlePlay: listing.googlePlay },
  });
  assert.equal(playOnly.status, 201);
  assert.deepEqual(
    playOnly.body.changeSet.files.map((f: { path: string }) => f.path),
    [PLAY_TITLE],
  );

  // Only the iOS part: never a fastlane file.
  const iosOnly = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Edit iOS',
    listing: { appStore: listing.appStore },
  });
  assert.equal(iosOnly.status, 201);
  assert.deepEqual(
    iosOnly.body.changeSet.files.map((f: { path: string }) => f.path),
    [STORE_PATH],
  );
});

dbTest('both: sending the unchanged listing back is no change', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, fastlaneFiles(), playFiles(), expoProject());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Nothing',
    listing: (await reading(t, repositoryId)).listing,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'no_changes');
});

dbTest(
  'an invalid store.config.json is a clear error, not a crash, and Play still works',
  async (db) => {
    const repo = new FakeRepo();
    setFiles(
      repo,
      fastlaneFiles(),
      playFiles(),
      expoProject('{\n  "apple": { "info": { "en-US": { "title": "x", } } }\n}\n'),
    );
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();

    const res = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
    assert.equal(res.status, 200);
    const view = res.body;
    assert.equal(view.sources.appStore.source, 'expo-store-config');
    assert.equal(view.sources.appStore.path, STORE_PATH);
    assert.equal(view.sources.appStore.found, false);
    assert.match(view.sources.appStore.error, /store\.config\.json is not valid JSON/);
    // It does not fall back to the fastlane App Store files.
    assert.equal(view.listing.appStore, undefined);
    assert.equal(view.found.appStore, false);
    assert.equal(view.listing.googlePlay.locales['en-US'].title, 'Acme Play');

    // Editing the App Store is refused with a message that names the file.
    const refused = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
      summary: 'Edit iOS',
      listing: { appStore: { locales: { 'en-US': { subtitle: 'x' } } } },
    });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'store_config_invalid');
    assert.equal(refused.body.path, STORE_PATH);
    assert.match(refused.body.message, /not valid JSON/);
    assert.equal((await t.call(t.owner, 'GET', '/change-sets')).body.changeSets.length, 0);

    // Play is unaffected.
    const googlePlay = view.listing.googlePlay;
    googlePlay.locales['en-US'].title = 'Acme Play 3';
    const play = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
      summary: 'Edit Play',
      listing: { googlePlay },
    });
    assert.equal(play.status, 201);
    assert.equal(play.body.changeSet.files[0].path, PLAY_TITLE);
  },
);

dbTest('a store config that is not an object is also an error, not a crash', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, expoProject('[1, 2]\n'));
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const view = await reading(t, repositoryId);
  assert.match(view.sources.appStore.error, /not a JSON object/);
  assert.equal(view.listing.appStore, undefined);
});

dbTest(
  'a dynamic store.config.js is never read: fastlane is the App Store source, with a note',
  async (db) => {
    const repo = new FakeRepo();
    setFiles(repo, fastlaneFiles(), {
      'package.json': '{ "dependencies": { "expo": "^52.0.0" } }\n',
      'app.json': '{ "expo": { "name": "Acme", "slug": "acme" } }\n',
      'eas.json':
        '{ "submit": { "production": { "ios": { "metadataPath": "./store.config.js" } } } }\n',
      'store.config.js': 'module.exports = { configVersion: 0, apple: { info: {} } };\n',
    });
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const view = await reading(t, repositoryId);
    assert.equal(view.sources.appStore.source, 'fastlane');
    assert.equal(view.listing.appStore.locales['en-US'].subtitle, 'Old subtitle');
    assert.ok(view.warnings.some((w: string) => /store\.config\.js is a script/.test(w)));
  },
);

dbTest('a locale EAS does not support is reported, and alone it is no change', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, expoProject());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const listing = (await reading(t, repositoryId)).listing;
  listing.appStore.locales['es-419'] = { name: 'Acme' };
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Add a locale',
    listing,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'no_changes');
  assert.ok(res.body.warnings.some((w: string) => w.includes('es-419')));

  // With a real edit beside it, the warning comes with the draft.
  listing.appStore.locales['en-US'].subtitle = 'Fine';
  const ok = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Edit and add',
    listing,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.changeSet.filesChanged, 1);
  assert.ok(ok.body.warnings.some((w: string) => w.includes('es-419')));
});

dbTest('scan and the stored repository say which source each store would use', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, fastlaneFiles(), playFiles(), expoProject());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();

  const before = await t.call(t.owner, 'GET', `/repositories/${repositoryId}`);
  assert.equal(before.body.detection, null);
  assert.equal(before.body.listingSources, undefined);

  const scan = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal(scan.status, 200);
  assert.equal(scan.body.detection.kind, 'both');
  assert.deepEqual(scan.body.listingSources, {
    appStore: { source: 'expo-store-config', path: STORE_PATH },
    googlePlay: { source: 'fastlane', path: 'fastlane/metadata/android' },
  });
  const stored = await t.call(t.owner, 'GET', `/repositories/${repositoryId}`);
  assert.deepEqual(stored.body.listingSources, scan.body.listingSources);
});

dbTest('a viewer cannot read the listing, with either source', async (db) => {
  const repo = new FakeRepo();
  setFiles(repo, expoProject());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const viewer = await t.addMember('viewer');
  const res = await t.call(viewer, 'GET', `/repositories/${repositoryId}/listing`);
  assert.equal(res.status, 403);
});

const detection = (
  over: Partial<ProjectDetection['paths']>,
  storeConfigs: { path: string; dynamic: boolean }[] = [],
) =>
  ({
    kind: 'unknown',
    platforms: [],
    platformsInferred: [],
    locales: { ios: [], android: [] },
    paths: { fastlaneDirs: [], fastfiles: [], ...over },
    ...(storeConfigs.length > 0
      ? { expo: { dynamicConfig: false, buildProfiles: [], submitProfiles: [], storeConfigs } }
      : {}),
    evidence: [],
    warnings: [],
  }) as ProjectDetection;

test('detectedSources applies the same rule to a stored scan', () => {
  assert.deepEqual(detectedSources(detection({})), { appStore: null, googlePlay: null });
  assert.deepEqual(detectedSources(detection({ iosMetadata: 'fastlane/metadata' })), {
    appStore: { source: 'fastlane', path: 'fastlane/metadata' },
    googlePlay: null,
  });
  const both = detectedSources(
    detection({ iosMetadata: 'fastlane/metadata', androidMetadata: 'fastlane/metadata/android' }, [
      { path: 'config/store.json', dynamic: false },
    ]),
  );
  assert.deepEqual(both.appStore, { source: 'expo-store-config', path: 'config/store.json' });
  assert.deepEqual(both.googlePlay, { source: 'fastlane', path: 'fastlane/metadata/android' });
  // A script is not a source.
  assert.equal(
    detectedSources(
      detection({ iosMetadata: 'fastlane/metadata' }, [{ path: 'store.config.js', dynamic: true }]),
    ).appStore?.source,
    'fastlane',
  );
});
