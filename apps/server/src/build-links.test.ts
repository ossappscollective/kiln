import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootCi, run, SHA_1, SHA_2, SHA_3 } from './ci-test-helpers.ts';
import type { AppRelease } from './services/apps.ts';
import {
  type BuildRef,
  buildsFromReleases,
  dispatchInputMatcher,
  matchBuilds,
  type RunRef,
  runNumberMatcher,
  runTitleMatcher,
} from './services/build-links.ts';
import { refreshRuns } from './services/ci.ts';
import { getRepository } from './services/repositories.ts';

// Fixtures only: no store and no GitHub is contacted.

const ref = (over: Partial<RunRef> = {}): RunRef => ({
  id: '1',
  workflow: 'iOS release',
  workflowPath: '.github/workflows/ios.yml',
  title: null,
  headSha: SHA_1,
  commitMessage: null,
  event: 'workflow_dispatch',
  runNumber: 7,
  status: 'completed',
  conclusion: 'success',
  inputs: null,
  startedAt: 1_000,
  ...over,
});
const ios = (buildNumber: string): BuildRef => ({ platform: 'ios', buildNumber, version: '2.4.0' });
const android = (buildNumber: string): BuildRef => ({
  platform: 'android',
  buildNumber,
  version: '2.4.0',
});

// ---------------------------------------------------------------------------------------------
// Matchers

test('dispatch_input: an input that names the build number, with the platform in mind', () => {
  const m = (inputs: Record<string, string>, build: BuildRef) =>
    dispatchInputMatcher.match(build, ref({ inputs }));
  assert.ok(m({ build_number: '240' }, ios('240')));
  assert.ok(m({ build_number: '240' }, android('240')), 'a generic name fits both platforms');
  assert.ok(
    m({ 'Build-Number': ' 240 ' }, ios('240')),
    'case, dashes and spaces around the value do not matter',
  );
  assert.ok(m({ ios_build_number: '240' }, ios('240')));
  assert.equal(m({ ios_build_number: '240' }, android('240')), undefined);
  assert.ok(m({ version_code: '241' }, android('241')));
  assert.equal(m({ version_code: '241' }, ios('241')), undefined);
  assert.equal(m({ build_number: '241' }, ios('240')), undefined);
  assert.equal(
    m({ track: '240' }, ios('240')),
    undefined,
    'only inputs that name a build number count',
  );
  assert.equal(dispatchInputMatcher.match(ios('240'), ref({ inputs: null })), undefined);
});

test('run_title: the conventions that ship, and what they must not match', () => {
  const title = (t: string, build: BuildRef, extra: Partial<RunRef> = {}) =>
    runTitleMatcher.match(build, ref({ title: t, ...extra }));
  assert.ok(title('Release 2.4.0 (build 240)', ios('240')));
  assert.ok(
    title('Release 2.4.0 (build 240)', android('240')),
    'a plain "build N" names both platforms',
  );
  assert.ok(title('Build number: 240', ios('240')));
  assert.ok(title('build_number=240', ios('240')));
  assert.ok(title('Build #240 on main', ios('240')));
  assert.ok(title('iOS build 240', ios('240')));
  assert.equal(
    title('iOS build 240', android('240')),
    undefined,
    'a platform prefix limits the match',
  );
  assert.ok(title('Android versionCode 241', android('241')));
  assert.ok(title('Android build 241', android('241')));
  assert.equal(title('Android versionCode 241', ios('241')), undefined);
  assert.ok(title('Deploy version code: 77', android('77')));
  assert.ok(title('Release 2.4.0 (240)', ios('240')));
  assert.ok(title('Release 2.4.0+240', android('240')));

  assert.equal(title('Build 2.4.0', ios('2')), undefined, 'a version is not a build number');
  assert.equal(title('Release 2.4.0', ios('2')), undefined);
  assert.equal(title('Release (build 2400)', ios('240')), undefined, 'whole numbers only');
  assert.equal(title('Release (build 240)', ios('24')), undefined);
  assert.equal(runTitleMatcher.match(ios('240'), ref({ title: null })), undefined);
  // GitHub's default title is the commit message: "fix build 3 failures" is not a build number.
  assert.equal(
    title('fix build 3 failures', ios('3'), { commitMessage: 'fix build 3 failures' }),
    undefined,
  );
  assert.ok(title('fix build 3 failures', ios('3'), { commitMessage: 'something else' }));
});

test('run_number is opt-in and needs named workflows', () => {
  const m = runNumberMatcher({ workflows: ['ios.yml'], offset: 100 });
  assert.equal(m.id, 'run_number');
  assert.ok(m.match(ios('107'), ref({ runNumber: 7 })));
  assert.equal(m.match(ios('108'), ref({ runNumber: 7 })), undefined);
  const other = ref({
    runNumber: 7,
    workflowPath: '.github/workflows/android.yml',
    workflow: 'Android',
  });
  assert.equal(m.match(ios('107'), other), undefined);
  assert.equal(
    runNumberMatcher({ workflows: [] }).match(ios('7'), ref({ runNumber: 7 })),
    undefined,
  );
});

test('matchBuilds: the first matcher that finds a run wins, a successful newest run is preferred, no sha no link', () => {
  const runs = [
    ref({ id: '10', title: 'build 240', conclusion: 'failure', startedAt: 3_000, headSha: SHA_3 }),
    ref({ id: '11', title: 'build 240', conclusion: 'success', startedAt: 1_000, headSha: SHA_1 }),
    ref({ id: '12', title: 'build 240', conclusion: 'success', startedAt: 2_000, headSha: SHA_2 }),
    ref({ id: '13', title: 'build 241', headSha: null }),
    ref({ id: '14', title: 'noise', inputs: { build_number: '242' }, headSha: SHA_1 }),
  ];
  const builds = [ios('240'), ios('241'), ios('242'), ios('243')];
  const found = matchBuilds(builds, runs, [dispatchInputMatcher, runTitleMatcher]);
  const at = (n: string) => found.get(`ios\u0000${n}`);
  assert.equal(at('240')?.run.id, '12', 'newest of the successful runs');
  assert.equal(at('240')?.candidates, 3);
  assert.equal(at('240')?.matcher, 'run_title');
  assert.equal(at('241'), undefined, 'a run without a commit explains nothing');
  assert.equal(at('242')?.matcher, 'dispatch_input');
  assert.equal(at('243'), undefined);

  // A team can add its own convention: matchers are a plain list.
  const named = {
    id: 'workflow_name',
    description: 'The workflow is called "Release N".',
    match: (b: BuildRef, r: RunRef) =>
      r.workflow === `Release ${b.buildNumber}` ? 'name' : undefined,
  };
  const custom = matchBuilds([ios('7')], [ref({ id: '99', workflow: 'Release 7' })], [named]);
  assert.equal(custom.get('ios\u00007')?.matcher, 'workflow_name');
});

test('buildsFromReleases: iOS builds per version, Android version codes per track, merged by number', () => {
  const release = (over: Partial<AppRelease>): AppRelease => ({
    id: 'r',
    appId: 'a',
    platform: 'android',
    version: '2.4.0',
    track: null,
    build: null,
    status: 'live',
    rawState: 'x',
    rolloutFraction: null,
    versionCodes: null,
    storeUpdatedAt: null,
    syncedAt: 1,
    ...over,
  });
  const builds = buildsFromReleases([
    release({ track: 'internal', versionCodes: ['241', '242'], status: 'draft', version: '2.5.0' }),
    release({ track: 'production', versionCodes: ['241'], status: 'rolling_out' }),
    release({
      track: 'beta',
      build: '240,239',
      versionCodes: null,
      status: 'live',
      version: '2.3.0',
    }),
    release({ platform: 'ios', build: '12', version: '1.0', storeUpdatedAt: 5 }),
    release({ platform: 'ios', build: null, version: '0.9' }),
  ]);
  assert.deepEqual(
    builds.map((b) => `${b.platform}:${b.buildNumber}`),
    ['android:242', 'android:241', 'android:240', 'android:239', 'ios:12'],
    'platform, then the highest number first, compared as numbers',
  );
  const by = new Map(builds.map((b) => [`${b.platform}:${b.buildNumber}`, b]));
  assert.deepEqual(by.get('android:241')?.tracks, ['internal', 'production']);
  assert.equal(
    by.get('android:241')?.status,
    'rolling_out',
    'the most advanced release names the state',
  );
  assert.equal(by.get('android:241')?.version, '2.4.0');
  assert.equal(by.get('android:240')?.version, '2.3.0');
  assert.equal(by.get('ios:12')?.uploadedAt, 5);
});

// ---------------------------------------------------------------------------------------------
// The builds endpoint

type Booted = Awaited<ReturnType<typeof bootCi>>;
const linkRoute = (appId: string, platform: string, build: string) =>
  `/apps/${appId}/builds/${platform}/${build}/link`;

/** Reads the runs from the fake GitHub now, whatever the spacing between reads. */
async function refresh(t: Booted, now = Date.now()) {
  const repository = await getRepository(t.db, t.workspaceId, t.repositoryId);
  assert.ok(repository);
  const done = await refreshRuns(
    t.context({ now }),
    { workspaceId: t.workspaceId, repository, force: true },
    { type: 'system', id: 'test' },
  );
  assert.ok(done.ok);
}

dbTest('builds: linked by a run title and by a dispatch input, unlinked otherwise', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('ios', [
    { version: '2.4.0', build: '240', status: 'rolling_out', uploadedAt: 1_700_000_000_000 },
    { version: '2.3.0', build: '239' },
    { version: '2.2.0', build: '238' },
    { version: '2.1.0', build: null },
  ]);
  t.fake.runs = [
    run('1001', {
      displayTitle: 'Release 2.4.0 (build 240)',
      headSha: SHA_2,
      commitMessage: 'Fix the crash\n\nwith details',
    }),
    run('1000', { displayTitle: 'noise' }),
  ];
  await refresh(t);
  // Run 1000 is the one this tool dispatched for build 239.
  await db.execute(
    `UPDATE workflow_runs SET inputs_json = '{"build_number":"239"}' WHERE run_id = '1000'`,
  );

  const res = await t.call(t.owner, 'GET', `/apps/${appId}/builds`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.repository, { id: t.repositoryId, owner: 'acme', repo: 'app' });
  assert.deepEqual(
    res.body.matchers.map((m: { id: string }) => m.id),
    ['dispatch_input', 'run_title'],
  );
  assert.deepEqual(
    res.body.builds.map((b: { buildNumber: string }) => b.buildNumber),
    ['240', '239', '238'],
  );
  const [b240, b239, b238] = res.body.builds;

  assert.equal(b240.platform, 'ios');
  assert.equal(b240.version, '2.4.0');
  assert.equal(b240.status, 'rolling_out');
  assert.equal(b240.uploadedAt, 1_700_000_000_000);
  assert.equal(b240.linkState, 'linked');
  assert.equal(b240.link.source, 'run_title');
  assert.equal(b240.link.manual, false);
  assert.equal(b240.link.run.id, '1001');
  assert.equal(b240.link.run.status, 'completed');
  assert.equal(b240.link.run.conclusion, 'success');
  assert.equal(b240.link.run.url, 'https://github.com/acme/app/actions/runs/1001');
  assert.deepEqual(b240.link.commit, {
    sha: SHA_2,
    shortSha: '2222222',
    message: 'Fix the crash',
    url: `https://github.com/acme/app/commit/${SHA_2}`,
  });
  assert.equal(b239.link.source, 'dispatch_input');
  assert.equal(b239.link.commit.sha, SHA_1);
  assert.equal(b238.linkState, 'unlinked');
  assert.equal(b238.link, null);
});

dbTest('builds: Android version codes link through the title, one number per row', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('android', [
    { version: '2.4.0', build: '241,242', track: 'production', codes: ['241', '242'] },
    { version: '2.4.0', build: '242', track: 'internal', codes: ['242'], status: 'draft' },
  ]);
  t.fake.runs = [
    run('1100', {
      displayTitle: 'Android versionCode 242',
      headSha: SHA_3,
      path: '.github/workflows/android.yml',
    }),
  ];
  await refresh(t);
  const res = await t.call(t.owner, 'GET', `/apps/${appId}/builds`);
  const [b242, b241] = res.body.builds;
  assert.equal(b242.buildNumber, '242');
  assert.deepEqual(b242.tracks, ['internal', 'production']);
  assert.equal(b242.linkState, 'linked');
  assert.equal(b241.buildNumber, '241');
  assert.equal(b241.linkState, 'unlinked');
});

dbTest('builds: an app without a repository lists its builds, all unlinked', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }], {
    repositoryId: null,
  });
  const res = await t.call(t.owner, 'GET', `/apps/${appId}/builds`);
  assert.equal(res.status, 200);
  assert.equal(res.body.repository, null);
  assert.equal(res.body.builds[0].linkState, 'unlinked');
  assert.equal((await t.call(t.owner, 'GET', '/apps/nope/builds')).status, 404);
});

dbTest('a refresh stores the links it finds, which then outlive the run rows', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
  t.fake.runs = [run('1200', { displayTitle: 'iOS build 240', headSha: SHA_2 })];
  await refresh(t);
  const stored = await db.query('SELECT source, run_id, head_sha, linked_by FROM build_links');
  assert.deepEqual(
    stored.map((r) => [r.source, r.run_id, r.head_sha, r.linked_by]),
    [['run_title', '1200', SHA_2, null]],
  );

  await db.execute('DELETE FROM workflow_runs');
  const res = await t.call(t.owner, 'GET', `/apps/${appId}/builds`);
  const [build] = res.body.builds;
  assert.equal(build.linkState, 'linked');
  assert.equal(build.link.commit.sha, SHA_2);
  assert.equal(
    build.link.run.url,
    'https://github.com/acme/app/actions/runs/1200',
    'the stored link keeps the run address',
  );
  assert.equal(build.link.run.status, 'unknown');
});

dbTest('a manual link wins over the matchers, is audited, and can be removed', async (db) => {
  const t = await bootCi(db);
  const member = await t.addMember('member');
  const appId = await t.seedApp('ios', [
    { version: '2.4.0', build: '240' },
    { version: '2.3.0', build: '239' },
  ]);
  t.fake.runs = [
    run('1301', { displayTitle: 'build 240', headSha: SHA_1 }),
    run('1302', { displayTitle: 'something else', headSha: SHA_3, commitMessage: 'Manual one' }),
  ];
  await refresh(t);

  const linked = await t.call(member, 'PUT', linkRoute(appId, 'ios', '240'), { runId: '1302' });
  assert.equal(linked.status, 200);
  const link = linked.body.build.link;
  assert.equal(link.source, 'manual');
  assert.equal(link.manual, true);
  assert.equal(link.run.id, '1302');
  assert.equal(link.commit.sha, SHA_3);
  assert.equal(link.commit.message, 'Manual one');
  assert.equal(link.linkedBy, `user-member-${t.workspaceId}`);

  // A later read of GitHub, with a newer run for the same number, does not replace it.
  t.fake.runs = [run('1303', { displayTitle: 'build 240', headSha: SHA_2 })];
  await refresh(t);
  const after = await t.call(t.owner, 'GET', `/apps/${appId}/builds`);
  assert.equal(after.body.builds[0].link.run.id, '1302');
  assert.equal(after.body.builds[0].link.manual, true);

  const audits = (await t.auditActions()).filter((a) => a.action === 'build.link');
  assert.equal(audits.length, 1);
  const detail = JSON.parse(audits[0]?.detail ?? '{}');
  assert.equal(detail.buildNumber, '240');
  assert.equal(detail.runId, '1302');

  const removed = await t.call(member, 'DELETE', linkRoute(appId, 'ios', '240'));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.build.link.manual, false);
  assert.equal(removed.body.build.link.source, 'run_title', 'what the matcher finds applies again');
  assert.equal((await t.auditActions()).filter((a) => a.action === 'build.unlink').length, 1);
  assert.equal(
    (await t.call(member, 'DELETE', linkRoute(appId, 'ios', '240'))).status,
    404,
    'nothing manual left',
  );
  assert.equal((await t.call(member, 'DELETE', linkRoute(appId, 'ios', '239'))).status, 404);
});

dbTest('manual linking checks the build, the run and the repository', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
  const bare = await t.seedApp('ios', [{ version: '1.0', build: '1' }], {
    repositoryId: null,
    identifier: 'com.acme.bare',
  });
  const noSha = run('1401');
  delete noSha.headSha;
  t.fake.runs = [noSha];
  const put = (id: string, platform: string, build: string, runId: string) =>
    t.call(t.owner, 'PUT', linkRoute(id, platform, build), { runId });

  assert.equal((await put(appId, 'ios', '999', '1401')).body.error, 'build_not_found');
  assert.equal((await put(appId, 'android', '240', '1401')).body.error, 'build_not_found');
  assert.equal((await put(bare, 'ios', '1', '1401')).body.error, 'no_repository');
  assert.equal((await put('nope', 'ios', '240', '1401')).status, 404);
  assert.equal((await put(appId, 'ios', '240', '404404')).body.error, 'run_not_found');
  assert.equal((await put(appId, 'ios', '240', '1401')).body.error, 'run_without_commit');
  assert.equal((await put(appId, 'ios', '240', 'abc')).status, 400);
  assert.equal((await put(appId, 'windows', '240', '1')).status, 400);
  assert.equal((await t.call(t.owner, 'PUT', linkRoute(appId, 'ios', '240'), {})).status, 400);

  t.fake.errors.getRun.push(new GithubError('forbidden', 'GitHub refused', 403));
  assert.equal((await put(appId, 'ios', '240', '777')).body.error, 'github_forbidden');
  assert.equal((await db.query('SELECT id FROM build_links')).length, 0);
});

// ---------------------------------------------------------------------------------------------
// What changed

dbTest(
  'what changed: the commits between a build and the previous linked one, newest first, cached',
  async (db) => {
    const t = await bootCi(db);
    const appId = await t.seedApp('ios', [
      { version: '2.4.0', build: '240' },
      { version: '2.3.0', build: '239' },
      { version: '2.2.0', build: '238' },
    ]);
    t.fake.runs = [
      run('1501', { displayTitle: 'build 240', headSha: SHA_3 }),
      run('1500', { displayTitle: 'build 238', headSha: SHA_1 }),
    ];
    await refresh(t);

    const res = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/builds/changes?platform=ios&build=240`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(t.fake.calls.filter((c) => c.name === 'compareCommits')[0]?.args, [
      SHA_1,
      SHA_3,
    ]);
    assert.deepEqual(
      res.body.base,
      { buildNumber: '238', version: '2.2.0', sha: SHA_1, shortSha: '1111111' },
      '239 is unlinked, so 238 is the base',
    );
    assert.equal(res.body.head.buildNumber, '240');
    assert.equal(res.body.status, 'ahead');
    assert.equal(res.body.totalCommits, 2);
    assert.equal(res.body.truncated, false);
    assert.deepEqual(
      res.body.commits.map((c: { title: string; shortSha: string }) => [c.title, c.shortSha]),
      [
        ['Second change', '3333333'],
        ['First change', '2222222'],
      ],
    );
    assert.equal(res.body.commits[1].author, 'Ada');
    assert.equal(res.body.commits[1].message, 'First change\n\nbody');

    await t.call(t.owner, 'GET', `/apps/${appId}/builds/changes?platform=ios&build=240&base=238`);
    assert.equal(t.fake.count('compareCommits'), 1, 'the same pair of commits is kept for a while');
  },
);

dbTest('what changed: explains why it cannot answer', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('ios', [
    { version: '2.4.0', build: '240' },
    { version: '2.3.0', build: '239' },
  ]);
  const bare = await t.seedApp('ios', [{ version: '1.0', build: '1' }], {
    repositoryId: null,
    identifier: 'com.acme.bare',
  });
  const get = (id: string, query: string) =>
    t.call(t.owner, 'GET', `/apps/${id}/builds/changes?${query}`);

  assert.equal((await get(appId, 'platform=ios&build=999')).body.error, 'build_not_found');
  assert.equal((await get(appId, 'platform=ios&build=240')).body.error, 'build_not_linked');
  assert.equal((await get(bare, 'platform=ios&build=1')).body.error, 'no_repository');
  assert.equal((await get(appId, 'platform=ios')).status, 400);
  assert.equal((await get(appId, 'platform=tv&build=1')).status, 400);
  assert.equal((await get('nope', 'platform=ios&build=1')).status, 404);

  t.fake.runs = [run('1601', { displayTitle: 'build 240', headSha: SHA_3 })];
  await refresh(t);
  assert.equal((await get(appId, 'platform=ios&build=240')).body.error, 'no_base_build');
  assert.equal(
    (await get(appId, 'platform=ios&build=240&base=239')).body.error,
    'build_not_linked',
  );

  // Two builds from one commit: identical, and GitHub is not asked.
  t.fake.runs = [run('1602', { displayTitle: 'build 239', headSha: SHA_3 })];
  await refresh(t);
  const same = await get(appId, 'platform=ios&build=240');
  assert.equal(same.status, 200);
  assert.equal(same.body.status, 'identical');
  assert.deepEqual(same.body.commits, []);
  assert.equal(t.fake.count('compareCommits'), 0);

  // GitHub does not know the commit any more: its answer is passed on.
  t.fake.runs = [run('1603', { displayTitle: 'build 239', headSha: SHA_1 })];
  await refresh(t);
  t.fake.errors.compare.push(new GithubError('not_found', 'GitHub could not find the commit', 404));
  assert.equal((await get(appId, 'platform=ios&build=240')).body.error, 'github_not_found');
});
