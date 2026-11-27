import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ArtifactMeta, buildNumberOfBuild, joinBuildOrigin, originOfBuild } from './builds.ts';

/**
 * The build origin join shared by TestFlight and Play (audit releases.md F8, F11): version name, number, date, origin and why a date is
 * missing; and the build number read from a structured field, never from a localised title.
 */

const artifact = (over: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  artifactId: 'a1',
  number: '412',
  version: '2.0.0',
  packageId: 'com.acme.app',
  createdAt: 1_700_000_000_000,
  run: { runNumber: 31, branch: 'main', commit: 'abc1234', url: 'https://ci/31' },
  ...over,
});

const row = (over = {}) => ({ buildNumber: '412', version: null, uploadedAt: null, ...over });
const APP = 'com.acme.app';

test('Android build 412 inspected in CI: the date and the version name come from the CI file, the run is attached', () => {
  const o = originOfBuild(row({ releaseNames: ['Spring release'] }), {
    artifacts: [artifact()],
    packageId: APP,
  });
  assert.equal(o.builtAt, 1_700_000_000_000);
  assert.equal(o.builtFrom, 'ci');
  assert.equal(o.version, '2.0.0');
  assert.equal(o.origin, 'ci');
  assert.equal(o.ci?.runNumber, 31);
  assert.equal(o.matchedBy, 'package');
  assert.equal(o.builtGap, null);
});

test('TestFlight build with an upload time but no CI file: the store date and version, origin store', () => {
  const o = originOfBuild(row({ buildNumber: '90', version: '1.19.0', uploadedAt: 5_000 }), {
    artifacts: [],
  });
  assert.deepEqual(
    [o.builtAt, o.builtFrom, o.version, o.origin, o.builtGap],
    [5_000, 'store', '1.19.0', 'store', null],
  );
});

test('CI date beats the store upload time', () => {
  const o = originOfBuild(row({ version: '1.0', uploadedAt: 9_999_999_999_999 }), {
    artifacts: [artifact()],
    packageId: APP,
  });
  assert.equal(o.builtAt, 1_700_000_000_000);
  assert.equal(o.builtFrom, 'ci');
});

test('a Play code known only by its release name: a name, never a date', () => {
  const o = originOfBuild(row({ releaseNames: [' ', 'Spring release'] }), { artifacts: [] });
  assert.equal(o.version, 'Spring release');
  assert.equal(o.origin, 'release');
  assert.equal(o.builtAt, null);
  assert.equal(o.builtGap, 'not_read');
});

test('why there is no date: not read, no repository, file gone, GitHub unreachable or no access', () => {
  const gap = (sources: Parameters<typeof originOfBuild>[1]) =>
    originOfBuild(row(), sources).builtGap;
  assert.equal(gap({ artifacts: [] }), 'not_read');
  assert.equal(gap({ artifacts: [], ciLinked: false }), 'no_repository');
  const gone = artifact({ createdAt: null, run: null, expiresAt: 77 });
  assert.equal(gap({ artifacts: [gone], packageId: APP }), 'file_gone');
  assert.equal(originOfBuild(row(), { artifacts: [gone], packageId: APP }).ciExpiredAt, 77);
  assert.equal(
    gap({ artifacts: [gone], packageId: APP, listing: 'unreachable' }),
    'github_unreachable',
  );
  assert.equal(
    gap({ artifacts: [gone], packageId: APP, listing: 'no_access' }),
    'github_no_access',
  );
  assert.equal(
    gap({ artifacts: [gone], packageId: APP, listing: 'no_repository' }),
    'no_repository',
  );
  assert.equal(
    gap({ artifacts: [gone], packageId: APP, listing: 'not_asked' }),
    'github_unreachable',
  );
});

test('first seen is never a build date', () => {
  const o = originOfBuild(row({ firstSeenAt: 123 }), { artifacts: [] });
  assert.equal(o.builtAt, null);
  assert.equal(o.firstSeenAt, 123);
});

test('an artifact of another package is ignored, unless it is the only one with that number (said so)', () => {
  const other = artifact({ packageId: 'com.acme.app.beta' });
  const only = originOfBuild(row(), { artifacts: [other], packageId: APP });
  assert.equal(only.matchedBy, 'build_number_only');
  assert.equal(only.builtAt, 1_700_000_000_000);
  const two = originOfBuild(row(), {
    artifacts: [other, artifact({ artifactId: 'a2', packageId: 'com.other' })],
    packageId: APP,
  });
  assert.equal(two.matchedBy, null);
  assert.equal(two.builtAt, null);
});

test('several artifacts carry one number (a re-run): the earliest wins', () => {
  const o = originOfBuild(row(), {
    artifacts: [
      artifact({ artifactId: 'b', createdAt: 2_000, version: '2.0.1' }),
      artifact({ artifactId: 'a', createdAt: 1_000, version: '2.0.0' }),
    ],
    packageId: APP,
  });
  assert.equal(o.builtAt, 1_000);
  assert.equal(o.version, '2.0.0');
});

test('joinBuildOrigin keeps the rows and their order and adds the origin; TestFlight and Play both use it', () => {
  const rows = [
    { buildNumber: '412', version: null, uploadedAt: null, track: 'internal' },
    { buildNumber: '90', version: '1.19.0', uploadedAt: 5, track: null },
  ];
  const joined = joinBuildOrigin(rows, { artifacts: [artifact()], packageId: APP });
  assert.deepEqual(
    joined.map((r) => r.buildNumber),
    ['412', '90'],
  );
  assert.equal(joined[0]?.track, 'internal');
  assert.equal(joined[0]?.builtFrom, 'ci');
  assert.equal(joined[1]?.builtFrom, 'store');
  assert.deepEqual(joinBuildOrigin([], { artifacts: [] }), []);
});

test('buildNumberOfBuild reads structured fields, never a title (Spanish "Compilacion 240" used to give null silently)', () => {
  assert.equal(buildNumberOfBuild({ buildNumber: '240' }), '240');
  assert.equal(buildNumberOfBuild({ buildNumber: ' 240 ' }), '240');
  assert.equal(buildNumberOfBuild({ versionCode: 412 }), '412');
  assert.equal(buildNumberOfBuild({ buildNumber: null, number: '7' }), '7');
  assert.equal(buildNumberOfBuild({ buildNumber: '' }), null);
  assert.equal(buildNumberOfBuild({}), null);
  assert.equal(buildNumberOfBuild({ title: 'Compilación 240' } as never), null);
});

test('builds are not read on this server: the gap says so (enable build reads), unless a repository is missing or a file was read', () => {
  const gap = (sources: Parameters<typeof originOfBuild>[1]) =>
    originOfBuild(row(), sources).builtGap;
  assert.equal(gap({ artifacts: [], readsEnabled: false }), 'reads_disabled');
  assert.equal(gap({ artifacts: [], readsEnabled: false, ciLinked: false }), 'no_repository');
  assert.equal(gap({ artifacts: [], readsEnabled: true }), 'not_read');
  // A file read before the switch was turned off still gives its date.
  assert.equal(
    originOfBuild(row(), { artifacts: [artifact()], packageId: APP, readsEnabled: false }).builtGap,
    null,
  );
});
