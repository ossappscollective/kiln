import assert from 'node:assert/strict';
import type { CommitDetail } from '@mrm/connectors';
import { GithubError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootCi, type CiBoot, run } from './ci-test-helpers.ts';
import { clearScanCaches, MAX_COMMIT_FETCHES } from './services/build-scan.ts';
import { refreshRuns } from './services/ci.ts';
import { getRepository } from './services/repositories.ts';

// A fake GitHub modelled on a real fastlane lane (oss-weather): the version code is decided inside
// the run, the lane commits "chore: new build" and tags it `<platform>/<flavor>/<version>/<code>`.
// No live GitHub call is made.

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const at = (minutes: number) => T0 + minutes * MIN;
const sha = (c: string) => c.repeat(40);
const HEAD = sha('a'); // the commit before the bump, the run's head_sha
const BUMP_IOS = sha('b');
const BUMP_ANDROID = sha('c');

const commitOf = (shaValue: string, parents: string[], atMs: number): CommitDetail => ({
  sha: shaValue,
  message: 'chore: new build',
  author: 'github-actions',
  date: atMs,
  committedAt: atMs,
  parents,
});

const releaseRun = (id: string, over: Parameters<typeof run>[1] = {}) =>
  run(id, {
    name: 'release',
    path: '.github/workflows/release.yml',
    displayTitle: 'release',
    headSha: HEAD,
    commitMessage: 'feat: the weather page',
    startedAt: at(0),
    createdAt: at(0),
    updatedAt: at(15),
    ...over,
  });

/** The maintainer's layout: an iOS app and an Android app of one repository, build 312 of version 1.4.0. */
async function stage(db: Parameters<typeof bootCi>[0]) {
  const t = await bootCi(db);
  const iosApp = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }], {
    identifier: 'com.acme.weather',
  });
  const androidApp = await t.seedApp(
    'android',
    [{ version: '1.4.0', build: '312', track: 'production', codes: ['312'] }],
    {
      identifier: 'com.acme.weather.android',
    },
  );
  t.fake.tags = [
    { name: 'ios/appstore/1.3.0/300', sha: sha('1') },
    { name: 'ios/appstore/1.4.0/312', sha: BUMP_IOS },
    { name: 'android/playstore/1.4.0/312', sha: BUMP_ANDROID },
    { name: 'android/github/1.4.0/312', sha: BUMP_ANDROID },
    { name: 'v1.4.0', sha: sha('2') },
  ];
  // The iOS job commits on top of the run head, the Android job on top of the iOS bump.
  t.fake.commits.set(BUMP_IOS, commitOf(BUMP_IOS, [HEAD], at(8)));
  t.fake.commits.set(BUMP_ANDROID, commitOf(BUMP_ANDROID, [BUMP_IOS], at(11)));
  t.fake.runs = [releaseRun('5001')];
  return { t, iosApp, androidApp };
}

async function refresh(t: CiBoot, clock = { now: at(20) }, extra: { tags?: 'auto' | 'skip' } = {}) {
  const repository = await getRepository(t.db, t.workspaceId, t.repositoryId);
  assert.ok(repository);
  const done = await refreshRuns(
    t.context(clock),
    { workspaceId: t.workspaceId, repository, force: true, ...extra },
    { type: 'system', id: 'test' },
  );
  assert.ok(done.ok, done.ok ? '' : String(done.body.message));
}

const builds = async (t: CiBoot, appId: string) =>
  (await t.call(t.owner, 'GET', `/apps/${appId}/builds`)).body;

// ---------------------------------------------------------------------------------------------
// The maintainer's layout

dbTest(
  'the Builds link resolves through the tag, the bump commit and the run, with the default patterns',
  async (db) => {
    const { t, iosApp, androidApp } = await stage(db);
    await refresh(t);

    const ios = (await builds(t, iosApp)).builds[0];
    assert.equal(ios.linkState, 'linked');
    assert.equal(ios.link.source, 'tag');
    assert.equal(ios.link.state, 'linked');
    assert.equal(ios.link.run.id, '5001');
    assert.equal(ios.link.run.workflow, 'release');
    assert.equal(
      ios.link.confidence,
      'high',
      'the bump is a child of the run head and was made while the run ran',
    );
    assert.equal(
      ios.link.commit.sha,
      BUMP_IOS,
      'the commit is the tag commit, not the run head before the bump',
    );
    assert.equal(ios.link.commit.message, 'chore: new build');
    assert.equal(ios.link.commit.url, `https://github.com/acme/app/commit/${BUMP_IOS}`);
    assert.equal(ios.link.evidence.tag, 'ios/appstore/1.4.0/312');
    assert.equal(ios.link.evidence.pattern, '{prefix}{platform}/{flavor}/{version}/{buildNumber}');
    assert.equal(ios.link.evidence.sha, BUMP_IOS);
    assert.deepEqual(ios.link.evidence.parents, [HEAD]);
    assert.equal(ios.link.evidence.runId, '5001');
    assert.match(ios.link.evidence.reason, /tag "ios\/appstore\/1.4.0\/312" has the number/);
    assert.equal(ios.diagnostic, null);

    const android = (await builds(t, androidApp)).builds[0];
    assert.equal(android.linkState, 'linked');
    assert.equal(android.link.run.id, '5001', 'both platform jobs belong to the one release run');
    assert.equal(android.link.commit.sha, BUMP_ANDROID);
    assert.equal(android.link.confidence, 'medium', 'no parent link: the time window alone');
    assert.equal(android.link.evidence.tag, 'android/github/1.4.0/312');

    const stored = await db.query(
      'SELECT source, run_id, head_sha, evidence_json FROM build_links ORDER BY platform',
    );
    assert.deepEqual(
      stored.map((r) => [r.source, r.run_id, r.head_sha]),
      [
        ['tag', '5001', BUMP_ANDROID],
        ['tag', '5001', BUMP_IOS],
      ],
    );
    assert.equal(JSON.parse(String(stored[1]?.evidence_json)).tag, 'ios/appstore/1.4.0/312');
    // One read of the tags and of the releases, one read per distinct commit.
    assert.equal(t.fake.count('listTags'), 1);
    assert.equal(t.fake.count('listReleases'), 1);
    assert.equal(t.fake.count('getCommit'), 2);
  },
);

dbTest(
  'the links outlive the run rows, and a settled build costs no more GitHub reads',
  async (db) => {
    const { t, iosApp } = await stage(db);
    await refresh(t);
    const reads = t.fake.calls.length;
    await refresh(t, { now: at(40) });
    assert.equal(
      t.fake.count('listTags'),
      1,
      'the high and medium links are settled: nothing asked for tags again',
    );
    assert.ok(t.fake.calls.length > reads, 'the runs were read again');
    await db.execute('DELETE FROM workflow_runs');
    const build = (await builds(t, iosApp)).builds[0];
    assert.equal(build.linkState, 'linked');
    assert.equal(build.link.commit.sha, BUMP_IOS);
    assert.equal(build.link.evidence.tag, 'ios/appstore/1.4.0/312');
    assert.equal(build.link.confidence, 'high');
  },
);

dbTest(
  'a tag whose run is not stored is "Tag found" with its commit, and becomes a run link when the run appears',
  async (db) => {
    const { t, iosApp } = await stage(db);
    t.fake.runs = [];
    await refresh(t);
    const found = (await builds(t, iosApp)).builds[0];
    assert.equal(found.linkState, 'tag');
    assert.equal(found.link.state, 'tag');
    assert.equal(found.link.run, null);
    assert.equal(found.link.source, 'tag');
    assert.equal(found.link.commit.sha, BUMP_IOS);
    assert.equal(found.link.evidence.runId, null);
    assert.match(found.link.evidence.noRunReason, /No CI run is stored/);
    assert.equal(found.diagnostic, null);

    // "What changed" works from the tag's commit alone.
    await db.execute(
      `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json, store_updated_at, synced_at)
     VALUES ('rel-old', ?, ?, 'ios', '1.3.0', '', '300', 'live', 'RAW', '{}', NULL, 5)`,
      [iosApp, t.workspaceId],
    );
    t.fake.commits.set(sha('1'), commitOf(sha('1'), [sha('0')], at(-1000)));
    await refresh(t, { now: at(21) + 120_000 });
    const changes = await t.call(
      t.owner,
      'GET',
      `/apps/${iosApp}/builds/changes?platform=ios&build=312&base=300`,
    );
    assert.equal(changes.status, 200);
    assert.equal(changes.body.head.sha, BUMP_IOS);
    assert.equal(changes.body.base.sha, sha('1'));

    // The run shows up (the next refresh, a minute later: the tag lists are read again).
    t.fake.runs = [releaseRun('5001')];
    await refresh(t, { now: at(23) + 120_000 });
    const linked = (await builds(t, iosApp)).builds.find(
      (b: { buildNumber: string }) => b.buildNumber === '312',
    );
    assert.equal(linked.linkState, 'linked');
    assert.equal(linked.link.run.id, '5001');
    assert.equal(linked.link.confidence, 'high');
  },
);

// ---------------------------------------------------------------------------------------------
// Negative cases

dbTest(
  'no tag at all: unlinked, and the build says what was searched and why nothing matched',
  async (db) => {
    const { t, iosApp } = await stage(db);
    t.fake.tags = [];
    await refresh(t);
    const result = await builds(t, iosApp);
    const [build] = result.builds;
    assert.equal(build.linkState, 'unlinked');
    assert.equal(build.link, null);
    assert.equal(build.diagnostic.code, 'no_tags');
    assert.match(build.diagnostic.message, /no tags or releases/);
    const d = result.diagnostics;
    assert.equal(d.scanOk, true);
    assert.equal(typeof d.scannedAt, 'number');
    assert.equal(d.patterns.source, 'defaults');
    assert.equal(d.patterns.usingDefaults, true);
    assert.ok(d.patterns.tags.includes('{prefix}{platform}/{flavor}/{version}/{buildNumber}'));
    assert.deepEqual(d.tags, { seen: 0, truncated: false, sample: [], targeted: [] });
    assert.deepEqual(d.runs.stored, 1);
    assert.equal(d.canReadTags, true);
  },
);

dbTest('a tag for the other platform is not used, and the reason says so', async (db) => {
  const { t, iosApp, androidApp } = await stage(db);
  t.fake.tags = [{ name: 'android/playstore/1.4.0/312', sha: BUMP_ANDROID }];
  await refresh(t);
  const result = await builds(t, iosApp);
  assert.equal(result.builds[0].linkState, 'unlinked');
  assert.equal(result.builds[0].diagnostic.code, 'other_platform');
  // Only the Android app has a tag it can use, so only its commit is read.
  assert.equal(
    t.fake.count('getCommit'),
    1,
    'no commit is read for a tag that cannot be the build',
  );
  assert.equal((await builds(t, androidApp)).builds[0].linkState, 'linked');
});

dbTest('tags that fit no pattern, and tags with other numbers, are told apart', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.tags = [{ name: 'nightly', sha: sha('1') }];
  await refresh(t);
  const first = await builds(t, iosApp);
  assert.equal(first.builds[0].diagnostic.code, 'no_pattern_fit');
  assert.deepEqual(first.diagnostics.tags.sample, ['nightly']);

  t.fake.tags = [
    { name: 'ios/appstore/1.3.0/300', sha: sha('1') },
    { name: 'ios/appstore/1.3.5/305', sha: sha('2') },
  ];
  await refresh(t, { now: at(30) });
  const second = await builds(t, iosApp);
  assert.equal(second.builds[0].diagnostic.code, 'number_not_found');
  assert.deepEqual(second.diagnostics.newestFit, {
    name: 'ios/appstore/1.3.5/305',
    buildNumber: '305',
  });
  assert.equal(second.diagnostics.fitting, 2);
});

dbTest('two release runs side by side: the link is made, but marked low', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.commits.set(BUMP_IOS, commitOf(BUMP_IOS, [sha('9')], at(8)));
  t.fake.runs = [
    releaseRun('5001'),
    releaseRun('5002', {
      headSha: sha('8'),
      startedAt: at(2),
      createdAt: at(2),
      updatedAt: at(14),
    }),
  ];
  await refresh(t);
  const build = (await builds(t, iosApp)).builds[0];
  assert.equal(build.linkState, 'linked');
  assert.equal(build.link.confidence, 'low');
  assert.match(build.link.evidence.reason, /2 runs qualified/);
  // A low link is looked at again: once a parent tells the runs apart it becomes better.
  t.fake.commits.set(BUMP_IOS, commitOf(BUMP_IOS, [HEAD], at(8)));
  await db.execute('DELETE FROM build_links');
  clearScanCaches(); // commits are cached for a day, as a commit never changes
  await refresh(t, { now: at(30) });
  const better = (await builds(t, iosApp)).builds[0];
  assert.equal(better.link.run.id, '5001');
  assert.equal(better.link.confidence, 'medium');
});

dbTest('a commit outside every run: "Tag found", with the reason no run was found', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.commits.set(BUMP_IOS, commitOf(BUMP_IOS, [sha('9')], at(600)));
  await refresh(t);
  const build = (await builds(t, iosApp)).builds[0];
  assert.equal(build.linkState, 'tag');
  assert.match(build.link.evidence.noRunReason, /No stored run has bbbbbbb or its parent/);
  assert.equal(build.link.commit.sha, BUMP_IOS);
});

dbTest('a commit GitHub does not know falls back to the release time', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.commits.delete(BUMP_IOS);
  t.fake.releases = [
    {
      id: '9',
      tagName: 'ios/appstore/1.4.0/312',
      name: 'Weather(ios): v1.4.0 Build 312',
      draft: false,
      prerelease: false,
      targetCommitish: 'main',
      createdAt: at(9),
      publishedAt: at(9),
    },
  ];
  await refresh(t);
  const build = (await builds(t, iosApp)).builds[0];
  assert.equal(build.linkState, 'linked');
  assert.equal(build.link.run.id, '5001');
  assert.equal(build.link.confidence, 'medium');
  assert.equal(build.link.evidence.releaseName, 'Weather(ios): v1.4.0 Build 312');
  assert.match(build.link.evidence.reason, /the release was made at/);
});

dbTest('a release name finds the build when the tag name fits no pattern', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.tags = [{ name: 'odd-tag', sha: BUMP_IOS }];
  t.fake.releases = [
    {
      id: '9',
      tagName: 'odd-tag',
      name: 'Weather(ios): v1.4.0 Build 312',
      draft: false,
      prerelease: false,
      targetCommitish: 'main',
      createdAt: at(9),
      publishedAt: at(9),
    },
  ];
  await refresh(t);
  const build = (await builds(t, iosApp)).builds[0];
  assert.equal(build.linkState, 'linked');
  assert.equal(build.link.source, 'release');
  assert.equal(build.link.evidence.kind, 'release');
  assert.equal(build.link.evidence.tag, 'odd-tag');
});

dbTest(
  'the matchers keep priority: a run title wins, and a manual link is never replaced',
  async (db) => {
    const { t, iosApp, androidApp } = await stage(db);
    t.fake.runs = [
      releaseRun('5001'),
      releaseRun('5002', {
        displayTitle: 'Release 1.4.0 (build 312)',
        headSha: sha('7'),
        startedAt: at(500),
        createdAt: at(500),
        updatedAt: at(515),
      }),
    ];
    await refresh(t);
    const ios = (await builds(t, iosApp)).builds[0];
    assert.equal(ios.link.source, 'run_title');
    assert.equal(ios.link.run.id, '5002');
    assert.equal(ios.link.confidence, 'high');
    assert.equal(ios.link.evidence, null);

    // The title matcher links the Android build too (a plain "build N" names both platforms), so
    // make a different run the manual one and check that a refresh leaves it alone.
    const manual = await t.call(t.owner, 'PUT', `/apps/${androidApp}/builds/android/312/link`, {
      runId: '5001',
    });
    assert.equal(manual.status, 200);
    await refresh(t, { now: at(30) });
    const android = (await builds(t, androidApp)).builds[0];
    assert.equal(android.link.manual, true);
    assert.equal(android.link.run.id, '5001');
  },
);

dbTest(
  'a GitHub failure while reading tags is kept as a diagnostic and does not fail the refresh',
  async (db) => {
    const { t, iosApp } = await stage(db);
    t.fake.errors.tags.push(new GithubError('forbidden', 'GitHub refused GET /tags', 403));
    const res = await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
    assert.equal(res.status, 200);
    assert.equal(res.body.refreshed, true);
    const result = await builds(t, iosApp);
    assert.equal(result.diagnostics.scanOk, false);
    assert.match(result.diagnostics.scanError, /refused/);
    assert.equal(result.builds[0].linkState, 'unlinked');
  },
);

dbTest('a connection that cannot read tags is skipped quietly', async (db) => {
  const { t, iosApp } = await stage(db);
  Object.assign(t.fake, { listTags: undefined });
  await refresh(t);
  const result = await builds(t, iosApp);
  assert.equal(result.builds[0].linkState, 'unlinked');
  assert.equal(result.diagnostics.scannedAt, null);
  assert.equal(result.builds[0].diagnostic.code, 'not_searched');
});

dbTest('commit reads are bounded per scan, newest builds first', async (db) => {
  const t = await bootCi(db);
  const total = MAX_COMMIT_FETCHES + 10;
  const releases = Array.from({ length: total }, (_, i) => ({
    version: `1.${i}.0`,
    build: String(1000 + i),
  }));
  const appId = await t.seedApp('ios', releases);
  t.fake.tags = releases.map((r, i) => ({
    name: `ios/appstore/${r.version}/${r.build}`,
    sha: (i + 16).toString(16).repeat(20),
  }));
  for (const tag of t.fake.tags) t.fake.commits.set(tag.sha, commitOf(tag.sha, [sha('9')], at(5)));
  await refresh(t);
  assert.equal(t.fake.count('getCommit'), MAX_COMMIT_FETCHES);
  // Every build still gets its "Tag found" link from the tag itself; only the newest 30 had their commit read.
  const stored = await db.query('SELECT build_number, evidence_json FROM build_links');
  assert.equal(stored.length, total);
  const read = stored
    .filter((r) => (JSON.parse(String(r.evidence_json)).parents ?? []).length > 0)
    .map((r) => String(r.build_number));
  assert.equal(read.length, MAX_COMMIT_FETCHES);
  const newest = releases.slice(-MAX_COMMIT_FETCHES).map((r) => r.build);
  assert.ok(
    read.every((n) => newest.includes(n)),
    'the newest builds were read first',
  );
  const rows = await builds(t, appId);
  assert.ok(rows.builds.some((b: { linkState: string }) => b.linkState === 'tag'));
});

// ---------------------------------------------------------------------------------------------
// A monorepo with a prefix per app

dbTest(
  'two apps of one repository, each with its own prefix, resolve to their own runs',
  async (db) => {
    const t = await bootCi(db);
    const scanner = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }], {
      identifier: 'com.acme.scanner',
    });
    const wallet = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }], {
      identifier: 'com.acme.wallet',
    });
    const HEAD_A = sha('1');
    const HEAD_B = sha('2');
    const SCANNER = sha('3');
    const WALLET = sha('4');
    t.fake.tags = [
      { name: 'scanner-ios/appstore/1.4.0/312', sha: SCANNER },
      { name: 'wallet-ios/appstore/1.4.0/312', sha: WALLET },
    ];
    t.fake.commits.set(SCANNER, commitOf(SCANNER, [HEAD_A], at(8)));
    t.fake.commits.set(WALLET, commitOf(WALLET, [HEAD_B], at(108)));
    t.fake.runs = [
      releaseRun('6001', { headSha: HEAD_A }),
      releaseRun('6002', {
        headSha: HEAD_B,
        startedAt: at(100),
        createdAt: at(100),
        updatedAt: at(115),
      }),
    ];
    // Without conventions neither app finds its tag.
    await refresh(t);
    assert.equal((await builds(t, scanner)).builds[0].linkState, 'unlinked');

    for (const [appId, prefix] of [
      [scanner, 'scanner-'],
      [wallet, 'wallet-'],
    ] as const) {
      const saved = await t.call(t.owner, 'PUT', `${t.base}/build-conventions`, {
        appId,
        tagPatterns: [],
        releasePatterns: [],
        prefix,
      });
      assert.equal(saved.status, 200, saved.text);
    }
    await refresh(t, { now: at(40) });
    const a = (await builds(t, scanner)).builds[0];
    const b = (await builds(t, wallet)).builds[0];
    assert.equal(a.link.run.id, '6001');
    assert.equal(a.link.commit.sha, SCANNER);
    assert.equal(a.link.evidence.tag, 'scanner-ios/appstore/1.4.0/312');
    assert.equal(b.link.run.id, '6002');
    assert.equal(b.link.commit.sha, WALLET);
    assert.equal(b.link.evidence.tag, 'wallet-ios/appstore/1.4.0/312');
  },
);

dbTest('a configured release workflow is used to pick the run', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.runs = [
    releaseRun('5001'),
    releaseRun('5003', {
      name: 'Nightly',
      path: '.github/workflows/nightly.yml',
      displayTitle: 'Nightly',
      headSha: sha('6'),
      startedAt: at(2),
      createdAt: at(2),
      updatedAt: at(40),
    }),
  ];
  const saved = await t.call(t.owner, 'PUT', `${t.base}/build-conventions`, {
    tagPatterns: [],
    releasePatterns: [],
    prefix: '',
    workflow: 'nightly.yml',
  });
  assert.equal(saved.status, 200);
  await refresh(t);
  assert.equal((await builds(t, iosApp)).builds[0].link.run.id, '5003');
  await t.call(t.owner, 'PUT', `${t.base}/build-conventions`, {
    tagPatterns: [],
    releasePatterns: [],
    prefix: '',
    workflow: 'release.yml',
  });
  await db.execute('DELETE FROM build_links');
  await refresh(t, { now: at(60) });
  assert.equal((await builds(t, iosApp)).builds[0].link.run.id, '5001');
});

// ---------------------------------------------------------------------------------------------
// Conventions: rights, validation, audit

dbTest(
  'conventions: viewers read, admins write, members cannot; a non-member gets 404',
  async (db) => {
    const t = await bootCi(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    const path = `${t.base}/build-conventions`;
    const body = { tagPatterns: ['rel-{buildNumber}'], releasePatterns: [], prefix: '' };

    const read = await t.call(viewer, 'GET', path);
    assert.equal(read.status, 200);
    assert.equal(read.body.stored, null);
    assert.equal(read.body.effective.source, 'defaults');
    assert.equal(read.body.effective.usingDefaultTags, true);
    assert.ok(
      read.body.defaults.tagPatterns.includes(
        '{prefix}{platform}/{flavor}/{version}/{buildNumber}',
      ),
    );
    assert.ok(read.body.defaults.releasePatterns.length > 0);

    assert.equal((await t.call(viewer, 'PUT', path, body)).status, 403);
    assert.equal((await t.call(member, 'PUT', path, body)).status, 403);
    assert.equal((await t.call(outsider, 'GET', path)).status, 404);
    assert.equal((await t.call(outsider, 'PUT', path, body)).status, 404);
    assert.equal(
      (await t.call(outsider, 'GET', path, undefined, 'other')).status,
      404,
      'the repository id is unknown in another workspace',
    );
    assert.equal((await t.call(outsider, 'PUT', path, body, 'other')).status, 404);
    assert.equal((await t.call(outsider, 'GET', `${path}/tags`)).status, 404);
    assert.equal((await t.call(viewer, 'GET', `${path}/tags`)).status, 403);
    assert.equal(t.fake.calls.length, 0, 'a refused request never reaches GitHub');

    const saved = await t.call(admin, 'PUT', path, { ...body, workflow: 'release.yml' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.stored.tagPatterns[0], 'rel-{buildNumber}');
    assert.equal(saved.body.stored.workflow, 'release.yml');
    assert.equal(saved.body.stored.appId, null);
    assert.equal(saved.body.effective.usingDefaultTags, false);
    assert.equal(saved.body.effective.usingDefaultReleases, true);
    assert.equal(saved.body.effective.source, 'repository');
    assert.equal(
      (await t.call(viewer, 'GET', path)).body.stored.tagPatterns[0],
      'rel-{buildNumber}',
    );

    const audit = (await t.auditActions()).find((a) => a.action === 'build.conventions');
    assert.ok(audit);
    assert.equal(audit.targetId, t.repositoryId);
    assert.deepEqual(JSON.parse(audit.detail).tagPatterns, ['rel-{buildNumber}']);
    assert.equal(JSON.parse(audit.detail).workflow, 'release.yml');
  },
);

dbTest(
  'conventions of one app override the repository, and are checked against the repository',
  async (db) => {
    const t = await bootCi(db);
    const appId = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }]);
    const stranger = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }], {
      repositoryId: null,
      identifier: 'com.acme.other',
    });
    const path = `${t.base}/build-conventions`;
    await t.call(t.owner, 'PUT', path, {
      tagPatterns: ['repo-{buildNumber}'],
      releasePatterns: [],
    });
    const own = await t.call(t.owner, 'PUT', path, {
      appId,
      tagPatterns: ['app-{buildNumber}'],
      releasePatterns: [],
      prefix: 'x-',
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.effective.source, 'app');
    assert.deepEqual(own.body.effective.tagPatterns, ['app-{buildNumber}']);
    assert.equal(own.body.repository.tagPatterns[0], 'repo-{buildNumber}');
    const forApp = await t.call(t.owner, 'GET', `${path}?appId=${appId}`);
    assert.equal(forApp.body.stored.prefix, 'x-');
    assert.equal(
      (await t.call(t.owner, 'GET', path)).body.stored.tagPatterns[0],
      'repo-{buildNumber}',
    );
    // An app that is not of this repository.
    assert.equal(
      (
        await t.call(t.owner, 'PUT', path, {
          appId: stranger,
          tagPatterns: [],
          releasePatterns: [],
        })
      ).status,
      422,
    );
    assert.equal(
      (await t.call(t.owner, 'PUT', path, { appId: 'nope', tagPatterns: [], releasePatterns: [] }))
        .status,
      422,
    );
    assert.equal((await t.call(t.owner, 'GET', `${path}?appId=nope`)).status, 404);
    // Saving again replaces, not adds.
    await t.call(t.owner, 'PUT', path, { appId, tagPatterns: [], releasePatterns: [] });
    assert.equal((await db.query('SELECT id FROM build_conventions')).length, 2);
  },
);

dbTest(
  'conventions: patterns that are too long, unsafe or wrong are refused with the reason',
  async (db) => {
    const t = await bootCi(db);
    const path = `${t.base}/build-conventions`;
    const put = (body: unknown) => t.call(t.owner, 'PUT', path, body);
    const issues = (res: Awaited<ReturnType<typeof put>>) => JSON.stringify(res.body.issues);

    const noNumber = await put({ tagPatterns: ['v{version}'], releasePatterns: [] });
    assert.equal(noNumber.status, 400);
    assert.match(issues(noNumber), /needs \{buildNumber\}/);
    assert.match(
      issues(await put({ tagPatterns: ['{buildNumber}-{unknown}'], releasePatterns: [] })),
      /not a placeholder/,
    );
    // Things that would be expensive or unsafe as a regular expression are refused, not run.
    for (const pattern of [
      '*a*b*{buildNumber}',
      '**{buildNumber}',
      `${'a'.repeat(121)}{buildNumber}`,
    ]) {
      const res = await put({ tagPatterns: [], releasePatterns: [pattern] });
      assert.equal(res.status, 400, pattern.slice(0, 20));
    }
    assert.equal(
      (await put({ tagPatterns: ['a b-{buildNumber}'], releasePatterns: [] })).status,
      400,
      'a tag has no spaces',
    );
    assert.equal(
      (
        await put({
          tagPatterns: Array.from({ length: 22 }, (_, i) => `t${i}-{buildNumber}`),
          releasePatterns: [],
        })
      ).status,
      400,
    );
    assert.equal(
      (await put({ tagPatterns: ['{buildNumber}', '{buildNumber}'], releasePatterns: [] })).status,
      400,
    );
    assert.equal(
      (await put({ tagPatterns: [], releasePatterns: [], prefix: '(a+)+$' })).status,
      400,
    );
    assert.equal(
      (await put({ tagPatterns: [], releasePatterns: [], prefix: 'x'.repeat(50) })).status,
      400,
    );
    assert.equal(
      (await put({ tagPatterns: [], releasePatterns: [], workflow: '../x' })).status,
      400,
    );
    assert.equal(
      (await put({ tagPatterns: [], releasePatterns: [], extra: true })).status,
      400,
      'unknown keys',
    );
    assert.equal((await put({ tagPatterns: 'nope', releasePatterns: [] })).status, 400);
    assert.equal(
      (await db.query('SELECT id FROM build_conventions')).length,
      0,
      'refused bodies store nothing',
    );
    // Regex syntax is only text, so it is accepted and means nothing special.
    assert.equal(
      (await put({ tagPatterns: ['(a+)+$.-{buildNumber}'], releasePatterns: [] })).status,
      200,
    );
    // The body is small by design.
    const big = await put({ tagPatterns: [], releasePatterns: [], pad: 'x'.repeat(20_000) });
    assert.equal(big.status, 413);
    assert.equal((await db.query('SELECT id FROM build_conventions')).length, 1);
  },
);

// ---------------------------------------------------------------------------------------------
// The tag list for the pattern preview

dbTest('the tag list for the preview is read once, cached, bounded and audited', async (db) => {
  const { t } = await stage(db);
  t.fake.releases = [
    {
      id: '1',
      name: 'Weather(ios): v1.4.0 Build 312',
      tagName: 'ios/appstore/1.4.0/312',
      draft: false,
      prerelease: false,
      publishedAt: at(9),
      createdAt: at(9),
    },
  ];
  const viewer = await t.addMember('viewer');
  const admin = await t.addMember('admin');
  const path = `${t.base}/build-conventions/tags`;
  const first = await t.call(admin, 'GET', path);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.tags.length, 5);
  assert.deepEqual(first.body.tags[1], { name: 'ios/appstore/1.4.0/312', sha: BUMP_IOS });
  assert.equal(first.body.releases[0].name, 'Weather(ios): v1.4.0 Build 312');
  assert.equal(first.body.tagsTruncated, false);
  assert.equal(t.fake.count('listTags'), 1);
  assert.equal(t.fake.count('listReleases'), 1);
  const second = await t.call(admin, 'GET', path);
  assert.equal(second.status, 200);
  assert.equal(t.fake.count('listTags'), 1, 'served from the cache');
  const uses = (await t.auditActions()).filter(
    (a) => a.action === 'credential.use' && a.detail.includes('ci.tags'),
  );
  assert.equal(uses.length, 1);
  assert.equal(
    (await t.call(viewer, 'GET', path)).status,
    403,
    'reading tags uses the credential: a right of a scan',
  );
});

dbTest('a failed read of the tags is an error for the preview, never an empty list', async (db) => {
  const { t } = await stage(db);
  t.fake.errors.tags.push(
    new GithubError('forbidden', 'Resource not accessible by integration', 403),
  );
  const failed = await t.call(t.owner, 'GET', `${t.base}/build-conventions/tags`);
  assert.ok(failed.status >= 400, String(failed.status));
  assert.ok(failed.body.error);
  assert.equal(failed.body.tags, undefined);
});

// ---------------------------------------------------------------------------------------------
// Re-run matching

dbTest(
  '"Re-run matching" reads GitHub again for one app, audits, and is a right of a scan',
  async (db) => {
    const { t, iosApp, androidApp } = await stage(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const path = `/apps/${iosApp}/builds/rematch`;
    assert.equal((await t.call(viewer, 'POST', path)).status, 403);
    assert.equal(t.fake.calls.length, 0, 'a refused request never reaches GitHub');
    assert.equal((await t.call(t.owner, 'POST', '/apps/nope/builds/rematch')).status, 404);

    const done = await t.call(member, 'POST', path);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.rematch.error, null);
    assert.equal(done.body.rematch.scanned, true);
    assert.equal(done.body.builds[0].link.run.id, '5001');
    // Only this app was matched: the other app's build stays as it was.
    assert.equal((await builds(t, androidApp)).builds[0].linkState, 'unlinked');
    assert.equal(t.fake.count('getCommit'), 1, 'only the iOS commit was read');
    const audit = (await t.auditActions()).find((a) => a.action === 'build.rematch');
    assert.ok(audit);
    assert.equal(audit.targetId, iosApp);

    // A settled build is not searched again, so a second press costs no tag read ...
    const reads = t.fake.count('listTags');
    const again = await t.call(member, 'POST', path);
    assert.equal(again.status, 200);
    assert.equal(again.body.rematch.scanned, false);
    assert.equal(t.fake.count('listTags'), reads);
    // ... while an app with an unlinked build reads again at once, bypassing the cache of the tags.
    assert.equal((await t.call(member, 'POST', `/apps/${androidApp}/builds/rematch`)).status, 200);
    assert.equal(t.fake.count('listTags'), reads + 1);
    assert.equal((await builds(t, androidApp)).builds[0].linkState, 'linked');
  },
);

dbTest('"Re-run matching" reports a tag failure and keeps the rest of the answer', async (db) => {
  const { t, iosApp } = await stage(db);
  t.fake.errors.tags.push(
    new GithubError('forbidden', 'Resource not accessible by integration', 403),
  );
  const done = await t.call(t.owner, 'POST', `/apps/${iosApp}/builds/rematch`);
  assert.equal(done.status, 200, done.text);
  assert.equal(typeof done.body.rematch.error, 'string');
  assert.equal(done.body.builds[0].linkState, 'unlinked');
  assert.equal(done.body.builds[0].diagnostic.code, 'scan_failed');
});

dbTest('"Re-run matching" needs a linked repository, and is limited to 6 a minute', async (db) => {
  const t = await bootCi(db);
  const unlinked = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }], {
    repositoryId: null,
    identifier: 'com.acme.free',
  });
  const refused = await t.call(t.owner, 'POST', `/apps/${unlinked}/builds/rematch`);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'no_repository');

  const appId = await t.seedApp('ios', [{ version: '1.4.0', build: '312' }]);
  // The refused request above used one of the six.
  for (let i = 0; i < 5; i += 1) {
    const ok = await t.call(t.owner, 'POST', `/apps/${appId}/builds/rematch`);
    assert.equal(ok.status, 200, `try ${i}: ${ok.text}`);
  }
  const limited = await t.call(t.owner, 'POST', `/apps/${appId}/builds/rematch`);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
