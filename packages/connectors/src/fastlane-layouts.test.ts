import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProject } from './detect.ts';
import {
  CARD_APP,
  mapsApp,
  type RepoFiles,
  SCAN_APP,
  scannerMonorepo,
  weatherApp,
} from './fastlane.fixtures.ts';
import {
  checkListingRoot,
  detectedTargets,
  listingCandidates,
  listingChangeSet,
  listingFilePaths,
  loadListing,
  parseMetadataHints,
  readListing,
} from './fastlane.ts';

/**
 * Real project layouts, as hand-written file lists (see fastlane.fixtures.ts):
 * a) `fastlane/metadata/ios` + `fastlane/metadata/android`, b) a monorepo with one metadata
 * folder per app id, c) Android only.
 */

const detect = (repo: RepoFiles) => detectProject(Object.keys(repo), async (path) => repo[path]);

test('a) the iOS root is fastlane/metadata/ios, and the App Store listing is found', async () => {
  const repo = weatherApp({ enChangelogs: 3, frChangelogs: 2 });
  const snap = readListing(repo);
  assert.equal(snap.found.appStore, true);
  assert.equal(snap.roots.appStore, 'fastlane/metadata/ios');
  assert.equal(snap.roots.googlePlay, 'fastlane/metadata/android');
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Example Weather');
  assert.equal(snap.listing.appStore?.copyright, '2026 Example, Inc.');
  assert.deepEqual(Object.keys(snap.listing.appStore?.locales ?? {}), ['en-US']);
  assert.equal(snap.found.googlePlay, true);

  const d = await detect(repo);
  assert.equal(d.paths.iosMetadata, 'fastlane/metadata/ios');
  assert.equal(d.paths.androidMetadata, 'fastlane/metadata/android');
  assert.deepEqual(d.locales.ios, ['en-US']);
  assert.deepEqual(d.platforms, ['android', 'ios']);
});

test('b) a monorepo: the metadata folder of each app id is found', async () => {
  const repo = scannerMonorepo({ cardChangelogs: 2, scanChangelogs: 2 });
  const snap = readListing(repo);
  assert.equal(snap.found.appStore, true);
  assert.equal(snap.found.googlePlay, true);
  const d = await detect(repo);
  assert.ok(d.paths.iosMetadata?.endsWith('/ios'));
  assert.ok(d.paths.androidMetadata?.endsWith('/android'));
  assert.ok([CARD_APP, SCAN_APP].some((app) => d.paths.iosMetadata?.includes(app)));
});

test('c) an Android only app has no App Store listing and says so', () => {
  const snap = readListing(mapsApp({ enChangelogs: 2, frChangelogs: 2 }));
  assert.equal(snap.found.appStore, false);
  assert.equal(snap.found.googlePlay, true);
  assert.equal(snap.roots.googlePlay, 'fastlane/metadata/android');
});

const CARD = `fastlane/metadata/${CARD_APP}`;
const SCAN = `fastlane/metadata/${SCAN_APP}`;

test('b) every app id becomes a candidate and a target with both of its folders', () => {
  const repo = scannerMonorepo({ cardChangelogs: 2, scanChangelogs: 2 });
  const candidates = listingCandidates(Object.keys(repo));
  assert.deepEqual(
    candidates.map((c) => `${c.store}:${c.root}`).sort(),
    [
      `app_store:${CARD}/ios`,
      `app_store:${SCAN}/ios`,
      `google_play:${CARD}/android`,
      `google_play:${SCAN}/android`,
    ].sort(),
  );
  const card = candidates.find((c) => c.root === `${CARD}/ios`);
  assert.equal(card?.app, CARD_APP);
  assert.deepEqual(card?.locales, ['en-US']);
  assert.equal(card?.origin, 'convention');
  assert.deepEqual(detectedTargets(candidates), [
    {
      key: `app:${CARD_APP}`,
      label: CARD_APP,
      app: CARD_APP,
      roots: { appStore: `${CARD}/ios`, googlePlay: `${CARD}/android` },
    },
    {
      key: `app:${SCAN_APP}`,
      label: SCAN_APP,
      app: SCAN_APP,
      roots: { appStore: `${SCAN}/ios`, googlePlay: `${SCAN}/android` },
    },
  ]);
});

test('b) with several apps the first is the default, in a fixed order, and the rest are reported', () => {
  const repo = scannerMonorepo({ cardChangelogs: 2, scanChangelogs: 2 });
  const snap = readListing(repo);
  assert.equal(snap.roots.appStore, `${CARD}/ios`);
  assert.equal(snap.roots.googlePlay, `${CARD}/android`);
  assert.equal(snap.explicit.appStore, false);
  assert.match(snap.warnings.join('\n'), /Several App Store metadata folders were found/);
  assert.match(snap.warnings.join('\n'), /Several Google Play metadata folders were found/);
  // Same answer however the file list is ordered.
  const reversed = Object.fromEntries(Object.entries(repo).reverse());
  assert.deepEqual(readListing(reversed).roots, snap.roots);
  assert.equal(snap.targets.length, 2);
});

test('an app named by the Appfile is preferred over alphabetical order', () => {
  const repo = scannerMonorepo({ cardChangelogs: 1, scanChangelogs: 1 });
  repo['fastlane/Appfile'] = `app_identifier("${SCAN_APP}")\n`;
  const hints = parseMetadataHints([
    { path: 'fastlane/Appfile', source: repo['fastlane/Appfile'] },
  ]);
  assert.deepEqual(hints.apps, [SCAN_APP]);
  const snap = readListing(repo, { hints });
  assert.equal(snap.roots.appStore, `${SCAN}/ios`);
  assert.equal(snap.roots.googlePlay, `${SCAN}/android`);
});

test('b) choosing an app reads and writes only the files of that app', () => {
  const repo = scannerMonorepo({ cardChangelogs: 3, scanChangelogs: 3 });
  const roots = { appStore: `${SCAN}/ios`, googlePlay: `${SCAN}/android` };
  const snap = readListing(repo, { roots });
  assert.equal(snap.explicit.appStore, true);
  assert.deepEqual(
    snap.warnings.filter((w) => /Several/.test(w)),
    [],
  );
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Example Scanner');
  assert.equal(snap.listing.googlePlay?.locales['en-US']?.title, 'Example Scanner');
  assert.ok(Object.keys(snap.files).every((p) => p.startsWith(`${SCAN}/`)));

  const after = structuredClone(snap.listing);
  after.appStore = {
    ...after.appStore,
    locales: {
      ...after.appStore?.locales,
      'en-US': { ...after.appStore?.locales['en-US'], subtitle: 'New' },
    },
  };
  after.googlePlay = {
    ...after.googlePlay,
    locales: {
      ...after.googlePlay?.locales,
      'en-US': { ...after.googlePlay?.locales['en-US'], title: 'Scanner' },
    },
    changelogs: { 'en-US': { ...after.googlePlay?.changelogs['en-US'], '4': 'New release.' } },
  };
  const changes = listingChangeSet(snap, after);
  assert.deepEqual(
    changes.map((c) => c.path),
    [
      `${SCAN}/android/en-US/changelogs/4.txt`,
      `${SCAN}/android/en-US/title.txt`,
      `${SCAN}/ios/en-US/subtitle.txt`,
    ],
  );
  assert.ok(changes.every((c) => c.path.startsWith(`${SCAN}/`)));
});

test('a custom folder wins over detection, with no hint, and is used as given', () => {
  const repo: RepoFiles = {
    ...weatherApp({ enChangelogs: 1, frChangelogs: 1 }),
    'store/listing/apple/en-US/name.txt': 'Custom Name\n',
    'store/listing/apple/en-US/description.txt': 'Custom description.\n',
  };
  const snap = readListing(repo, { roots: { appStore: './store/listing/apple/' } });
  assert.equal(snap.roots.appStore, 'store/listing/apple');
  assert.equal(snap.explicit.appStore, true);
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Custom Name');
  // The other store is still detected.
  assert.equal(snap.roots.googlePlay, 'fastlane/metadata/android');
  assert.equal(snap.explicit.googlePlay, false);
  assert.equal(snap.diagnostics.appStore.state, 'found');
});

test('an empty custom root means the store is not read, and nothing is written for it', () => {
  const repo = weatherApp({ enChangelogs: 1, frChangelogs: 1 });
  const snap = readListing(repo, { roots: { appStore: '' } });
  assert.equal(snap.found.appStore, false);
  assert.equal(snap.diagnostics.appStore.state, 'not_used');
  const edited = structuredClone(readListing(repo).listing);
  assert.deepEqual(listingChangeSet(snap, edited.appStore ? { appStore: edited.appStore } : {}), []);
});

test('a custom folder with no listing files says so, and what is there instead', () => {
  const repo = scannerMonorepo({ cardChangelogs: 1, scanChangelogs: 1 });
  const missing = readListing(repo, {
    roots: { appStore: 'fastlane/metadata/com.example.nope/ios' },
  });
  assert.equal(missing.found.appStore, false);
  assert.equal(missing.diagnostics.appStore.state, 'missing');
  assert.match(missing.diagnostics.appStore.message, /does not exist/);
  assert.deepEqual(missing.diagnostics.appStore.searched, [
    'fastlane/metadata/com.example.nope/ios',
  ]);

  const empty = readListing(repo, { roots: { appStore: `${SCAN}/ios/review_information` } });
  assert.equal(empty.diagnostics.appStore.state, 'no_listing_files');
  assert.match(empty.diagnostics.appStore.message, /exists but has no listing files/);
  assert.ok(empty.diagnostics.appStore.entries.includes('notes.txt'));
});

test('the diagnostic lists metadata folders that were found but not used, and why', () => {
  const none = readListing({
    'fastlane/Fastfile': '',
    'fastlane/metadata/README.md': 'x',
    'fastlane/metadata/de/notes.md': 'x',
    'app/store/apple/en-US/name.txt': 'Name',
    'app/store/apple/en-US/description.txt': 'Description',
  });
  assert.equal(none.found.appStore, false);
  const d = none.diagnostics.appStore;
  assert.equal(d.state, 'no_listing_files'); // fastlane/metadata exists, with nothing usable in it
  assert.ok(d.searched.some((s) => s.includes('metadata/ios/<locale>/name.txt')));
  const loose = d.unused.find((u) => u.path === 'app/store/apple');
  assert.equal(loose?.store, 'app_store');
  assert.match(loose?.reason ?? '', /not one of the folders that are detected automatically/);
  const empty = d.unused.find((u) => u.path === 'fastlane/metadata');
  assert.equal(empty?.store, null);
  assert.match(empty?.reason ?? '', /no locale folder in it holds listing files/);
  assert.match(empty?.reason ?? '', /README\.md/);
});

test('a folder that is only partly named like a layout is not guessed at', () => {
  // metadata/<x>/<locale> has no ios/android folder: not detected, but reported and selectable.
  const snap = readListing({ 'fastlane/metadata/myapp/en-US/name.txt': 'N' });
  assert.equal(snap.found.appStore, false);
  assert.equal(snap.diagnostics.appStore.unused[0]?.path, 'fastlane/metadata/myapp');
  const chosen = readListing(
    { 'fastlane/metadata/myapp/en-US/name.txt': 'N' },
    { roots: { appStore: 'fastlane/metadata/myapp' } },
  );
  assert.equal(chosen.listing.appStore?.locales['en-US']?.name, 'N');
});

test('checkListingRoot applies the repository path rules', () => {
  for (const ok of ['fastlane/metadata/ios', './fastlane/metadata/', 'metadata', 'a b/c.d']) {
    assert.equal(checkListingRoot(ok), undefined, ok);
  }
  for (const bad of [
    '',
    '   ',
    '/etc',
    '../x',
    'a/../b',
    'a//b',
    'a\\b',
    '.git/hooks',
    'x/.GIT/y',
    'a/./b',
    'a\u0000b',
    'x'.repeat(301),
  ]) {
    assert.notEqual(checkListingRoot(bad), undefined, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------
// Hints

test('a Fastfile that joins variables into metadata_path is evaluated, and ENV defaults are used', () => {
  const repo = weatherApp({ enChangelogs: 1, frChangelogs: 1 });
  const hints = parseMetadataHints([
    { path: 'fastlane/Fastfile', source: repo['fastlane/Fastfile'] as string },
    { path: 'fastlane/Deliverfile', source: repo['fastlane/Deliverfile'] as string },
    { path: 'fastlane/Appfile', source: repo['fastlane/Appfile'] as string },
  ]);
  assert.deepEqual(hints.appStore, ['fastlane/metadata/ios']);
  assert.deepEqual(hints.googlePlay, ['fastlane/metadata/android']);
  assert.deepEqual(hints.apps, []); // ENV["APP_ID"] is not a literal
});

test('a Deliverfile metadata_path string is a hint; comments and unknown values are not', () => {
  const hints = parseMetadataHints([
    {
      path: 'fastlane/Deliverfile',
      source: '# metadata_path "./nope"\nmetadata_path "./store/apple" # trailing\n',
    },
    {
      path: 'fastlane/Fastfile',
      source: [
        'lane :a do',
        '  upload_to_play_store(metadata_path: ENV["PLAY_PATH"], track: "beta")',
        '  upload_to_app_store(metadata_path: some_helper("x"))',
        '  upload_to_play_store(metadata_path: "./store/play")',
        'end',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(hints.appStore, ['fastlane/store/apple', 'store/apple']);
  assert.deepEqual(hints.googlePlay, ['fastlane/store/play', 'store/play']);
  assert.ok(hints.sources.every((s) => s.file.startsWith('fastlane/')));
});

test('a hinted folder is preferred, and works with any name', () => {
  const repo: RepoFiles = {
    'fastlane/Deliverfile': 'metadata_path "./store/apple"\n',
    'fastlane/store/apple/en-US/name.txt': 'Hinted',
    'fastlane/metadata/en-US/name.txt': 'Conventional',
  };
  const hints = parseMetadataHints([
    { path: 'fastlane/Deliverfile', source: repo['fastlane/Deliverfile'] as string },
  ]);
  const snap = readListing(repo, { hints });
  assert.equal(snap.roots.appStore, 'fastlane/store/apple');
  assert.equal(snap.listing.appStore?.locales['en-US']?.name, 'Hinted');
  assert.equal(snap.candidates[0]?.origin, 'hint');
  // Without the hint the conventional folder is read.
  assert.equal(readListing(repo).roots.appStore, 'fastlane/metadata');
});

test('a hint that names a folder with no listing files is only mentioned in the diagnostic', async () => {
  const repo = scannerMonorepo({ cardChangelogs: 1, scanChangelogs: 1 });
  const d = await detectProject(Object.keys(repo), async (p) => repo[p]);
  // The Fastfile defaults to fastlane/metadata/ios, which does not exist in this monorepo.
  assert.deepEqual(d.listing?.hints.appStore, ['fastlane/metadata/ios']);
  assert.equal(
    d.listing?.candidates.every((c) => c.origin === 'convention'),
    true,
  );
  assert.equal(d.listing?.targets.length, 2);
  assert.match(d.warnings.join('\n'), /Several apps or metadata folders were found/);
  const snap = readListing(repo, { hints: d.listing?.hints });
  assert.match(snap.diagnostics.appStore.searched.join('\n'), /named by fastlane\/Fastfile/);
});

// ---------------------------------------------------------------------------------------------
// What is read

test('only the files of the chosen folder are read, and no screenshots, images or review files', async () => {
  const repo = weatherApp({ enChangelogs: 4, frChangelogs: 4 });
  const reads: string[] = [];
  const snap = await loadListing(Object.keys(repo), async (p) => {
    reads.push(p);
    return repo[p];
  });
  assert.equal(snap.found.appStore, true);
  assert.ok(reads.every((p) => p.startsWith('fastlane/metadata/')));
  assert.ok(reads.every((p) => p.endsWith('.txt')));
  assert.ok(
    reads.every(
      (p) =>
        !p.includes('/screenshots/') &&
        !p.includes('/images/') &&
        !p.includes('review_information'),
    ),
  );
  assert.equal(new Set(reads).size, reads.length, 'no file is read twice');
  assert.ok(reads.includes('fastlane/metadata/ios/en-US/name.txt'));
  assert.ok(reads.includes('fastlane/metadata/ios/copyright.txt'));
});

test('release notes: the newest are read, the rest are left alone and reported', async () => {
  const repo = weatherApp({ enChangelogs: 145, frChangelogs: 141 });
  const reads: string[] = [];
  const snap = await loadListing(Object.keys(repo), async (p) => {
    reads.push(p);
    return repo[p];
  });
  const notes = reads.filter((p) => p.includes('/changelogs/'));
  assert.equal(notes.length, 20);
  assert.ok(notes.includes('fastlane/metadata/android/en-US/changelogs/145.txt'));
  assert.ok(notes.includes('fastlane/metadata/android/en-US/changelogs/136.txt'));
  assert.ok(!notes.includes('fastlane/metadata/android/en-US/changelogs/135.txt'));
  assert.ok(reads.length < 50, `${reads.length} reads`);
  assert.match(
    snap.warnings.join('\n'),
    /Only the 10 newest release notes of each locale were read; 266 older ones/,
  );
  // An edit of the shown notes touches only those files: the unread ones are not deleted.
  const after = structuredClone(snap.listing);
  const en = after.googlePlay?.changelogs['en-US'];
  assert.ok(en);
  en['145'] = 'Edited.';
  assert.deepEqual(
    listingChangeSet(snap, after).map((c) => c.path),
    ['fastlane/metadata/android/en-US/changelogs/145.txt'],
  );
  assert.equal(
    listingFilePaths(Object.keys(repo), { maxChangelogs: 1000 }).paths.filter((p) =>
      p.includes('/changelogs/'),
    ).length,
    286,
  );
});

test('the scan prefetches its files together and reads each one once', async () => {
  const repo = weatherApp({ enChangelogs: 2, frChangelogs: 2 });
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  await detectProject(Object.keys(repo), async (p) => {
    calls.push(p);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return repo[p];
  });
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(peak > 1, 'reads overlap');
});
