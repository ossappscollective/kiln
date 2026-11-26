import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReleaseCandidates } from '@kiln/connectors';
import {
  NO_ORIGIN_SOURCES,
  type OriginArtifact,
  type OriginSources,
  originOfCode,
  withOrigins,
} from './candidate-origin.ts';

const PKG = 'com.acme.android';
const HOUR = 60 * 60_000;
const T0 = 1_900_000_000_000;
const RUN = { runNumber: 41, branch: 'main', commit: 'abc1234', url: 'https://github.test/run/41' };
const art = (number: string, extra: Partial<OriginArtifact> = {}): OriginArtifact => ({
  artifactId: `a${number}`,
  number,
  version: '2.00.1',
  packageId: PKG,
  createdAt: T0,
  run: RUN,
  ...extra,
});
const code = (versionCode: string, names: (string | null)[] = []) => ({
  versionCode,
  inTrack: names.map((name) => ({ name, status: 'completed' })),
});
const sources = (over: Partial<OriginSources>): OriginSources => ({
  ...NO_ORIGIN_SOURCES,
  ...over,
});

test('a cache hit gives the version, the artifact date and the run', () => {
  const o = originOfCode(code('90'), sources({ artifacts: [art('90')] }), PKG);
  assert.deepEqual(o, {
    version: '2.00.1',
    builtAt: T0,
    origin: 'ci',
    builtFrom: 'ci',
    ci: RUN,
    builtGap: null,
    ciExpiredAt: null,
    matchedBy: 'package',
    firstSeenAt: null,
  });
});

test('a store build gives the version, and its upload time only when the store recorded one', () => {
  const store = [{ buildNumber: '89', version: '2.00.0', uploadedAt: null }];
  assert.deepEqual(originOfCode(code('89'), sources({ store }), PKG), {
    version: '2.00.0',
    builtAt: null,
    origin: 'store',
    builtFrom: null,
    builtGap: 'not_read',
    ciExpiredAt: null,
    matchedBy: null,
    firstSeenAt: null,
  });
  const dated = [{ buildNumber: '89', version: '2.00.0', uploadedAt: T0 - HOUR }];
  const o = originOfCode(code('89'), sources({ store: dated }), PKG);
  assert.equal(o.builtAt, T0 - HOUR);
  assert.equal(o.builtFrom, 'store');
});

test('nothing known: everything is null, and a release name is a version hint, never a date', () => {
  assert.deepEqual(originOfCode(code('88'), NO_ORIGIN_SOURCES, PKG), {
    version: null,
    builtAt: null,
    origin: null,
    builtFrom: null,
    builtGap: 'not_read',
    ciExpiredAt: null,
    matchedBy: null,
    firstSeenAt: null,
  });
  const named = originOfCode(code('88', [null, ' 1.15.2 ']), NO_ORIGIN_SOURCES, PKG);
  assert.equal(named.version, '1.15.2');
  assert.equal(named.origin, 'release');
  assert.equal(named.builtAt, null);
  assert.equal(named.ci, undefined);
});

test('sources in conflict: ci wins the version, ci createdAt wins the date, then store', () => {
  const store = [{ buildNumber: '90', version: '2.00.0', uploadedAt: T0 - HOUR }];
  const o = originOfCode(code('90', ['Spring']), sources({ artifacts: [art('90')], store }), PKG);
  assert.equal(o.version, '2.00.1');
  assert.equal(o.origin, 'ci');
  assert.equal(o.builtAt, T0);
  // A file GitHub no longer lists has a version but no date: the store upload time is used for the date.
  const gone = art('90', { createdAt: null, run: null });
  const g = originOfCode(code('90'), sources({ artifacts: [gone], store }), PKG);
  assert.equal(g.version, '2.00.1');
  assert.equal(g.builtAt, T0 - HOUR);
  assert.equal(g.builtFrom, 'store');
  assert.equal(g.ci, undefined);
  // A file with no versionName falls back to the store version.
  const bare = originOfCode(
    code('90'),
    sources({ artifacts: [art('90', { version: null })], store }),
    PKG,
  );
  assert.equal(bare.version, '2.00.0');
  assert.equal(bare.origin, 'store');
  assert.equal(bare.builtFrom, 'ci');
});

test('several artifacts with one code: the earliest one; another package never matches', () => {
  const later = art('90', { artifactId: 'b', createdAt: T0 + HOUR, version: '9.9.9' });
  const o = originOfCode(code('90'), sources({ artifacts: [later, art('90')] }), PKG);
  assert.equal(o.builtAt, T0);
  assert.equal(o.version, '2.00.1');
  // Two files of another package: ambiguous, so neither is taken (a single one is the build-number fallback, below).
  const others = [
    art('90', { packageId: 'com.other' }),
    art('90', { artifactId: 'z', packageId: 'com.other.beta' }),
  ];
  assert.equal(originOfCode(code('90'), sources({ artifacts: others }), PKG).version, null);
  const unknownPkg = art('90', { packageId: null });
  assert.equal(
    originOfCode(code('90'), sources({ artifacts: [unknownPkg] }), PKG).version,
    '2.00.1',
  );
  // another build number never matches
  assert.equal(originOfCode(code('91'), sources({ artifacts: [art('90')] }), PKG).version, null);
});

test('withOrigins adds the fields to every Google Play code and leaves an App Store read alone', () => {
  const read = {
    store: 'googleplay',
    platform: 'android',
    track: 'production',
    codes: [
      {
        versionCode: '90',
        source: 'bundle',
        sha256: null,
        inTrack: [],
        eligibility: { eligible: true },
      },
      {
        versionCode: '89',
        source: 'apk',
        sha256: null,
        inTrack: [],
        eligibility: { eligible: true },
      },
    ],
  } as unknown as ReleaseCandidates;
  const out = withOrigins(read, sources({ artifacts: [art('90')] }), PKG);
  assert.equal(out.store, 'googleplay');
  if (out.store !== 'googleplay') return;
  const [a, b] = out.codes as unknown as { version: string | null; source: string; ci?: unknown }[];
  assert.equal(a?.version, '2.00.1');
  assert.equal(a?.source, 'bundle', 'the code keeps its own source');
  assert.deepEqual(a?.ci, RUN);
  assert.equal(b?.version, null);
  assert.equal(b?.ci, undefined);
  const apple = {
    store: 'appstoreconnect',
    platform: 'ios',
    builds: [],
  } as unknown as ReleaseCandidates;
  assert.equal(withOrigins(apple, NO_ORIGIN_SOURCES, PKG), apple);
});

test('a package that differs only by case still matches; a flavor suffix falls back to the build number, said so', () => {
  const upper = art('90', { packageId: 'COM.Acme.Android' });
  const a = originOfCode(code('90'), sources({ artifacts: [upper] }), PKG);
  assert.equal(a.matchedBy, 'package');
  const beta = art('90', { packageId: 'com.acme.android.beta' });
  const b = originOfCode(code('90'), sources({ artifacts: [beta] }), PKG);
  assert.equal(b.matchedBy, 'build_number_only');
  assert.equal(b.version, '2.00.1');
  assert.equal(b.builtAt, T0);
  // A strict match wins over a mismatching file with the same code.
  const both = originOfCode(
    code('90'),
    sources({ artifacts: [beta, art('90', { artifactId: 'x', version: '3.0.0' })] }),
    PKG,
  );
  assert.equal(both.matchedBy, 'package');
  assert.equal(both.version, '3.0.0');
});

test('why a date is missing: not read, file gone, GitHub unreachable or without access, no repository', () => {
  const noDate = art('90', { createdAt: null, run: null, expiresAt: T0 - HOUR });
  const gone = originOfCode(code('90'), sources({ artifacts: [noDate], listing: 'ok' }), PKG);
  assert.equal(gone.builtGap, 'file_gone');
  assert.equal(gone.ciExpiredAt, T0 - HOUR);
  assert.equal(gone.version, '2.00.1');
  for (const [listing, gap] of [
    ['unreachable', 'github_unreachable'],
    ['no_access', 'github_no_access'],
    ['no_repository', 'no_repository'],
  ] as const)
    assert.equal(
      originOfCode(code('90'), sources({ artifacts: [noDate], listing }), PKG).builtGap,
      gap,
    );
  assert.equal(
    originOfCode(code('88'), sources({ artifacts: [noDate] }), PKG).builtGap,
    'not_read',
  );
  assert.equal(
    originOfCode(code('88'), sources({ ciLinked: false }), PKG).builtGap,
    'no_repository',
  );
  // A known date has no gap.
  assert.equal(originOfCode(code('90'), sources({ artifacts: [art('90')] }), PKG).builtGap, null);
});

test('first seen by the sync is kept apart from the build date', () => {
  const store = [{ buildNumber: '89', version: null, uploadedAt: null, firstSeenAt: T0 - HOUR }];
  const o = originOfCode(code('89'), sources({ store }), PKG);
  assert.equal(o.firstSeenAt, T0 - HOUR);
  assert.equal(o.builtAt, null);
  assert.equal(o.builtFrom, null);
  assert.equal(o.builtGap, 'not_read');
});
