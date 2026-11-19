import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import {
  CARD_APP,
  mapsApp,
  SCAN_APP,
  scannerMonorepo,
  weatherApp,
} from '../../../packages/connectors/src/fastlane.fixtures.ts';
import { bootRepoApp, FakeRepo } from './repo-test-helpers.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

/**
 * Listing targets: one repository, several apps; detected targets (one per app id) and saved,
 * custom ones. A change set writes only inside the folders of the chosen target.
 */

const CARD = `fastlane/metadata/${CARD_APP}`;
const SCAN = `fastlane/metadata/${SCAN_APP}`;

type T = Awaited<ReturnType<typeof bootRepoApp>>;

const withFiles = (repo: FakeRepo, files: Record<string, string>) => {
  repo.files = new Map(Object.entries(files));
  clearRepoSnapshots();
};
const listingUrl = (id: string, query = '') => `/repositories/${id}/listing${query}`;
const targetQuery = (target: string) => `?target=${encodeURIComponent(target)}`;
const monorepo = () => scannerMonorepo({ cardChangelogs: 3, scanChangelogs: 3 });

async function monorepoApp(db: Parameters<typeof bootRepoApp>[0]) {
  const repo = new FakeRepo();
  withFiles(repo, monorepo());
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  return { t, repo, repositoryId };
}

/** The draft a person makes: the listing of a target with one App Store and one Play edit. */
async function draftFor(t: T, repositoryId: string, target: string, cookie = t.owner) {
  const read = await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(target)));
  assert.equal(read.status, 200, read.text);
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].subtitle = 'Edited subtitle';
  listing.googlePlay.locales['en-US'].title = 'Edited title';
  return t.call(cookie, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Edit the listing',
    target,
    listing,
  });
}

dbTest(
  'a monorepo scan finds one target per app id, and the listing defaults to the first with a warning',
  async (db) => {
    const { t, repositoryId } = await monorepoApp(db);
    const scan = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    assert.equal(scan.status, 200);
    const found = scan.body.detection.listing;
    assert.deepEqual(
      found.targets.map((x: { key: string }) => x.key),
      [`app:${CARD_APP}`, `app:${SCAN_APP}`],
    );
    assert.equal(found.candidates.length, 4);
    assert.match(scan.body.detection.warnings.join('\n'), /Several apps or metadata folders/);

    const view = (await t.call(t.owner, 'GET', listingUrl(repositoryId))).body;
    assert.equal(view.found.appStore, true);
    assert.equal(view.roots.appStore, `${CARD}/ios`);
    assert.deepEqual(
      view.targets.map((x: { id: string; origin: string }) => [x.id, x.origin]),
      [
        [`auto:app:${CARD_APP}`, 'detected'],
        [`auto:app:${SCAN_APP}`, 'detected'],
      ],
    );
    assert.deepEqual(view.selected, {
      id: `auto:app:${CARD_APP}`,
      origin: 'default',
      label: CARD_APP,
    });
    assert.match(view.warnings.join('\n'), /Several App Store metadata folders/);
    assert.equal(view.diagnostics.appStore.state, 'found');
  },
);

dbTest('choosing a detected target reads, and writes, only that app', async (db) => {
  const { t, repo, repositoryId } = await monorepoApp(db);
  const target = `auto:app:${SCAN_APP}`;
  const view = (await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(target)))).body;
  assert.equal(view.roots.appStore, `${SCAN}/ios`);
  assert.equal(view.listing.appStore.locales['en-US'].name, 'Example Scanner');
  assert.equal(view.selected.id, target);
  assert.equal(view.selected.origin, 'detected');
  assert.deepEqual(
    view.warnings.filter((w: string) => /Several/.test(w)),
    [],
  );

  const made = await draftFor(t, repositoryId, target);
  assert.equal(made.status, 201, made.text);
  const paths = made.body.changeSet.files.map((f: { path: string }) => f.path);
  assert.deepEqual(paths, [`${SCAN}/android/en-US/title.txt`, `${SCAN}/ios/en-US/subtitle.txt`]);
  assert.ok(paths.every((p: string) => p.startsWith(`${SCAN}/`)));

  // Apply keeps working: only these two files change on the branch; the other app is untouched.
  const id = made.body.changeSet.id;
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/approve`)).status, 200);
  const applied = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(applied.status, 200, applied.text);
  const branch = repo.branches.get(applied.body.changeSet.branch);
  assert.equal(branch?.get(`${SCAN}/ios/en-US/subtitle.txt`)?.trim(), 'Edited subtitle');
  assert.equal(
    branch?.get(`${CARD}/android/en-US/title.txt`),
    repo.files.get(`${CARD}/android/en-US/title.txt`),
  );
});

dbTest('the other app of the monorepo is read and written on its own', async (db) => {
  const { t, repositoryId } = await monorepoApp(db);
  const target = `auto:app:${CARD_APP}`;
  const made = await draftFor(t, repositoryId, target);
  // Cards has no App Store subtitle file, so its edit is a new file in its own folder.
  const paths = made.body.changeSet.files.map((f: { path: string }) => f.path);
  assert.ok(paths.length > 0);
  assert.ok(
    paths.every((p: string) => p.startsWith(`${CARD}/`)),
    paths.join(', '),
  );
});

dbTest(
  'a detected target that is not in the repository is a 404, not a silent default',
  async (db) => {
    const { t, repositoryId } = await monorepoApp(db);
    const res = await t.call(
      t.owner,
      'GET',
      listingUrl(repositoryId, targetQuery('auto:app:com.example.gone')),
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'target_not_found');
    const saved = await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery('no-such-id')));
    assert.equal(saved.status, 404);
  },
);

dbTest('saved targets: create, list, use, edit, delete, and they are audited', async (db) => {
  const repo = new FakeRepo();
  withFiles(repo, {
    ...weatherApp({ enChangelogs: 2, frChangelogs: 2 }),
    'store/listing/apple/en-US/name.txt': 'Custom Name\n',
    'store/listing/apple/en-US/description.txt': 'Custom description.\n',
  });
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const base = `/repositories/${repositoryId}/listing-targets`;

  const created = await t.call(t.owner, 'POST', base, {
    name: 'Custom store folder',
    appId: 'com.example.weather',
    appStoreRoot: './store/listing/apple/',
    googlePlayRoot: 'fastlane/metadata/android',
  });
  assert.equal(created.status, 201, created.text);
  const target = created.body.target;
  assert.equal(target.appStoreRoot, 'store/listing/apple');
  assert.equal(target.name, 'Custom store folder');
  assert.equal((await t.call(t.owner, 'GET', base)).body.targets.length, 1);

  // A custom folder wins over detection (fastlane/metadata/ios is detected, and not used).
  const view = (await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(target.id))))
    .body;
  assert.equal(view.roots.appStore, 'store/listing/apple');
  assert.equal(view.listing.appStore.locales['en-US'].name, 'Custom Name');
  assert.equal(view.selected.id, target.id);
  assert.equal(view.selected.origin, 'custom');
  assert.ok(
    view.targets.some(
      (x: { id: string; origin: string }) => x.id === target.id && x.origin === 'custom',
    ),
  );
  assert.ok(view.targets.some((x: { origin: string }) => x.origin === 'detected'));

  const renamed = await t.call(t.owner, 'PATCH', `${base}/${target.id}`, {
    name: 'Store folder',
    googlePlayRoot: null,
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.target.googlePlayRoot, null);
  assert.equal(renamed.body.target.appStoreRoot, 'store/listing/apple');

  const dup = await t.call(t.owner, 'POST', base, { name: 'store FOLDER', appStoreRoot: 'a/b' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'duplicate_name');

  assert.equal((await t.call(t.owner, 'DELETE', `${base}/${target.id}`)).status, 204);
  assert.equal((await t.call(t.owner, 'DELETE', `${base}/${target.id}`)).status, 404);
  assert.equal((await t.call(t.owner, 'GET', base)).body.targets.length, 0);
  assert.equal(
    (await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(target.id)))).status,
    404,
  );
  const actions = (await t.auditActions()).map((a) => a.action);
  for (const a of [
    'repository.listing_target_create',
    'repository.listing_target_update',
    'repository.listing_target_delete',
  ]) {
    assert.ok(actions.includes(a), a);
  }
});

dbTest('saved targets persist across requests and go away with the repository', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const base = `/repositories/${repositoryId}/listing-targets`;
  await t.call(t.owner, 'POST', base, { name: 'One', appStoreRoot: 'a/ios' });
  await t.call(t.owner, 'POST', base, { name: 'Two', googlePlayRoot: 'a/android' });
  const rows = await db.query(
    'SELECT name, app_store_root, google_play_root FROM repository_listing_targets ORDER BY name',
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.app_store_root, r.google_play_root]),
    [
      ['One', 'a/ios', null],
      ['Two', null, 'a/android'],
    ],
  );
  assert.equal((await t.call(t.owner, 'DELETE', `/repositories/${repositoryId}`)).status, 204);
  assert.equal((await db.query('SELECT id FROM repository_listing_targets')).length, 0);
});

dbTest('paths of a saved target follow the repository path rules', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const base = `/repositories/${repositoryId}/listing-targets`;
  for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a\\b', '.git/hooks', 'a//b', 'a/./b']) {
    const res = await t.call(t.owner, 'POST', base, { name: 'Bad', appStoreRoot: bad });
    assert.equal(res.status, 422, bad);
    assert.equal(res.body.error, 'invalid_target');
    assert.equal(res.body.problems[0].field, 'appStoreRoot');
    const play = await t.call(t.owner, 'POST', base, { name: 'Bad', googlePlayRoot: bad });
    assert.equal(play.status, 422, bad);
  }
  const none = await t.call(t.owner, 'POST', base, { name: 'No folders' });
  assert.equal(none.status, 422);
  assert.equal(none.body.problems[0].field, 'roots');
  assert.equal(
    (await t.call(t.owner, 'POST', base, { name: '   ', appStoreRoot: 'a' })).status,
    422,
  );
  assert.equal(
    (await t.call(t.owner, 'POST', base, { name: 'x\ny', appStoreRoot: 'a' })).status,
    422,
  );
  assert.equal((await db.query('SELECT id FROM repository_listing_targets')).length, 0);

  const ok = await t.call(t.owner, 'POST', base, { name: 'Fine', appStoreRoot: 'a/ios' });
  const patch = await t.call(t.owner, 'PATCH', `${base}/${ok.body.target.id}`, {
    appStoreRoot: '../out',
  });
  assert.equal(patch.status, 422);
  assert.equal((await t.call(t.owner, 'GET', base)).body.targets[0].appStoreRoot, 'a/ios');

  // The same rules apply to folders sent with a request.
  const read = await t.call(t.owner, 'GET', listingUrl(repositoryId, '?appStoreRoot=..%2Fx'));
  assert.equal(read.status, 422);
  assert.equal(read.body.error, 'invalid_root');
  const draft = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'x',
    roots: { googlePlay: '/abs' },
    listing: {},
  });
  assert.equal(draft.status, 422);
});

dbTest('who may use and edit listing targets', async (db) => {
  const { t, repositoryId } = await monorepoApp(db);
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  const base = `/repositories/${repositoryId}/listing-targets`;
  const body = { name: 'Mine', appStoreRoot: `${SCAN}/ios`, googlePlayRoot: `${SCAN}/android` };

  for (const cookie of [viewer, member, admin])
    assert.equal((await t.call(cookie, 'GET', base)).status, 200);
  for (const cookie of [viewer, member]) {
    assert.equal((await t.call(cookie, 'POST', base, body)).status, 403);
  }
  const created = await t.call(admin, 'POST', base, body);
  assert.equal(created.status, 201);
  const id = created.body.target.id;
  for (const cookie of [viewer, member]) {
    assert.equal((await t.call(cookie, 'PATCH', `${base}/${id}`, { name: 'Other' })).status, 403);
    assert.equal((await t.call(cookie, 'DELETE', `${base}/${id}`)).status, 403);
  }
  // Using a target is reading the listing: member and up, not a viewer.
  assert.equal(
    (await t.call(viewer, 'GET', listingUrl(repositoryId, targetQuery(id)))).status,
    403,
  );
  assert.equal(
    (await t.call(member, 'GET', listingUrl(repositoryId, targetQuery(id)))).status,
    200,
  );
  // ... and making a change set in it is changesets.write.
  const made = await draftFor(t, repositoryId, id, member);
  assert.equal(made.status, 201, made.text);
  assert.ok(
    made.body.changeSet.files.every((f: { path: string }) => f.path.startsWith(`${SCAN}/`)),
  );
  assert.equal(
    (
      await t.call(viewer, 'POST', `/repositories/${repositoryId}/change-sets`, {
        summary: 'x',
        target: id,
        listing: {},
      })
    ).status,
    403,
  );
});

dbTest('a target of another repository or workspace is not found', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId, credentialId } = await t.connect();
  const other = await t.call(t.owner, 'POST', '/repositories', {
    credentialId,
    owner: 'acme',
    repo: 'two',
  });
  const otherId = other.body.repository.id;
  const made = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/listing-targets`, {
    name: 'T',
    appStoreRoot: 'x/ios',
  });
  const id = made.body.target.id;
  assert.equal((await t.call(t.owner, 'GET', listingUrl(otherId, targetQuery(id)))).status, 404);
  assert.equal(
    (
      await t.call(t.owner, 'PATCH', `/repositories/${otherId}/listing-targets/${id}`, {
        name: 'Z',
      })
    ).status,
    404,
  );
  assert.equal(
    (await t.call(t.owner, 'DELETE', `/repositories/${otherId}/listing-targets/${id}`)).status,
    404,
  );
  assert.equal(
    (
      await t.call(t.owner, 'POST', `/repositories/nope/listing-targets`, {
        name: 'T',
        appStoreRoot: 'x',
      })
    ).status,
    404,
  );

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other-ws', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other-ws');
  const res = await t.call(
    outsider,
    'GET',
    `/repositories/${repositoryId}/listing-targets`,
    undefined,
    'other-ws',
  );
  assert.equal(res.status, 404);
  assert.equal(
    (
      await t.call(
        outsider,
        'DELETE',
        `/repositories/${repositoryId}/listing-targets/${id}`,
        undefined,
        'other-ws',
      )
    ).status,
    404,
  );
});

dbTest(
  'a custom folder with no listing files says so, instead of falling back to a detected one',
  async (db) => {
    const repo = new FakeRepo();
    withFiles(repo, weatherApp({ enChangelogs: 1, frChangelogs: 1 }));
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const base = `/repositories/${repositoryId}/listing-targets`;

    const missing = await t.call(t.owner, 'POST', base, {
      name: 'Typo',
      appStoreRoot: 'fastlane/metadata/iso',
    });
    const view = (
      await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(missing.body.target.id)))
    ).body;
    assert.equal(view.found.appStore, false);
    assert.equal(view.listing.appStore, undefined);
    assert.equal(view.diagnostics.appStore.state, 'missing');
    assert.equal(view.diagnostics.appStore.explicit, true);
    assert.match(view.diagnostics.appStore.message, /fastlane\/metadata\/iso/);
    assert.match(view.diagnostics.appStore.message, /does not exist/);
    // The Play store of this target has no folder at all.
    assert.equal(view.diagnostics.googlePlay.state, 'not_used');

    const empty = await t.call(t.owner, 'POST', base, {
      name: 'Review',
      appStoreRoot: 'fastlane/metadata/ios/review_information',
    });
    const view2 = (
      await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(empty.body.target.id)))
    ).body;
    assert.equal(view2.diagnostics.appStore.state, 'no_listing_files');
    assert.ok(view2.diagnostics.appStore.entries.includes('notes.txt'));
  },
);

dbTest('a target without an App Store folder changes nothing there and says so', async (db) => {
  const repo = new FakeRepo();
  withFiles(repo, weatherApp({ enChangelogs: 1, frChangelogs: 1 }));
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const made = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/listing-targets`, {
    name: 'Android only',
    googlePlayRoot: 'fastlane/metadata/android',
  });
  const id = made.body.target.id;
  const read = (await t.call(t.owner, 'GET', listingUrl(repositoryId, targetQuery(id)))).body;
  assert.equal(read.listing.appStore, undefined);
  const full = (await t.call(t.owner, 'GET', listingUrl(repositoryId))).body.listing;
  full.googlePlay.locales['en-US'].title = 'Edited';
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'x',
    target: id,
    listing: { appStore: full.appStore, googlePlay: full.googlePlay },
  });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(
    res.body.changeSet.files.map((f: { path: string }) => f.path),
    ['fastlane/metadata/android/en-US/title.txt'],
  );
  assert.match(res.body.warnings.join('\n'), /selected target has no App Store folder/);
});

dbTest(
  'folders sent with a request win over a target and over detection, with no hint needed',
  async (db) => {
    const repo = new FakeRepo();
    withFiles(repo, {
      ...mapsApp({ enChangelogs: 1, frChangelogs: 1 }),
      'somewhere/else/apple/de/name.txt': 'Nur hier\n',
      'somewhere/else/apple/de/description.txt': 'Beschreibung\n',
    });
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const res = await t.call(
      t.owner,
      'GET',
      listingUrl(repositoryId, '?appStoreRoot=somewhere%2Felse%2Fapple%2F'),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.roots.appStore, 'somewhere/else/apple');
    assert.equal(res.body.listing.appStore.locales.de.name, 'Nur hier');
    assert.equal(res.body.selected.origin, 'folders');
    // An empty folder means: do not read that store.
    const none = await t.call(t.owner, 'GET', listingUrl(repositoryId, '?googlePlayRoot='));
    assert.equal(none.body.listing.googlePlay, undefined);
    assert.equal(none.body.diagnostics.googlePlay.state, 'not_used');
  },
);

dbTest(
  'a repository with no listing says what was searched and which folders looked like metadata',
  async (db) => {
    const repo = new FakeRepo();
    withFiles(repo, {
      'fastlane/Fastfile': 'lane :x do\nend\n',
      'fastlane/metadata/README.md': 'nothing here\n',
      'app/store/apple/en-US/name.txt': 'N\n',
      'app/store/apple/en-US/description.txt': 'D\n',
    });
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const view = (await t.call(t.owner, 'GET', listingUrl(repositoryId))).body;
    assert.equal(view.found.appStore, false);
    const d = view.diagnostics.appStore;
    assert.ok(d.searched.length >= 3);
    assert.ok(d.unused.some((u: { path: string }) => u.path === 'app/store/apple'));
    assert.ok(d.unused.some((u: { path: string }) => u.path === 'fastlane/metadata'));
    // ... and choosing the loose folder explicitly makes it readable.
    const chosen = await t.call(
      t.owner,
      'GET',
      listingUrl(repositoryId, '?appStoreRoot=app%2Fstore%2Fapple'),
    );
    assert.equal(chosen.body.listing.appStore.locales['en-US'].name, 'N');
  },
);

dbTest(
  'the tree is listed once for a scan, a listing and a change set when the connector can name the commit',
  async (db) => {
    class PinnedRepo extends FakeRepo {
      refs = 0;
      reads = 0;
      async resolveCommit(): Promise<string> {
        this.refs++;
        return 'c'.repeat(40);
      }
      override async readFile(path: string): Promise<string | undefined> {
        this.reads++;
        return super.readFile(path);
      }
    }
    const repo = new PinnedRepo();
    withFiles(repo, weatherApp({ enChangelogs: 12, frChangelogs: 12 }));
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    const read = await t.call(t.owner, 'GET', listingUrl(repositoryId));
    assert.equal(read.status, 200);
    const reads = repo.reads;
    const listing = read.body.listing;
    listing.appStore.locales['en-US'].subtitle = 'Another subtitle';
    const made = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
      summary: 'x',
      listing,
    });
    assert.equal(made.status, 201, made.text);
    assert.equal(repo.listCalls, 1, 'one tree listing for all three requests');
    assert.equal(repo.reads, reads, 'the change set read nothing again');
    assert.equal(repo.refs, 3);
    assert.match(read.body.warnings.join('\n'), /Only the 10 newest release notes/);
  },
);
