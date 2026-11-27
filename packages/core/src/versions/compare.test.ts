import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareBuildNumbers,
  compareReleases,
  compareVersions,
  isCreatableVersion,
  isReadableVersion,
  naturalCompare,
  newestBuildFirst,
  newestReleaseFirst,
  newestVersionFirst,
  parseVersion,
  sameVersion,
  tryCompareBuildNumbers,
  tryCompareReleases,
  tryCompareVersions,
} from './compare.ts';

/**
 * The ONE comparator (audit releases.md section 3: six implementations that disagreed). Every row of the old tables is pinned here:
 * `2.0.0-beta` vs `2.0.0`, `2.00.1.90`, `1.10.0` vs `1.9.2`, `parseInt` parts, `localeCompare` numeric, `Number(buildNumber)`.
 */

type Row = [string, string, -1 | 0 | 1 | null];

const TABLE: Row[] = [
  ['1.11.6', '1.19.0', -1],
  ['1.10.0', '1.9.2', 1],
  ['2.00.1', '1.19.0', 1],
  ['2.00.1', '2.0.1', 0],
  ['1.0', '1.0.0', 0],
  ['2', '2.0.0', 0],
  ['1.26.2', '1.26.10', -1],
  // four parts
  ['2.00.1.90', '2.00.1', 1],
  ['2.00.1.90', '2.00.2', -1],
  ['2.0.1.0', '2.0.1', 0],
  // a leading v
  ['v1.2.0', '1.2.0', 0],
  ['V1.2.0', '1.2.0', 0],
  // pre-release is lower than the release, the old tables said: older (portfolio), unknown (candidates), NaN (core), equal (insights)
  ['2.0.0-beta', '2.0.0', -1],
  ['2.0.0-beta', '1.0.0', 1],
  ['2.0.0-beta', '2.0.0-rc.1', -1],
  ['2.0.0-rc.1', '2.0.0-rc.2', -1],
  ['2.0.0-rc.2', '2.0.0-rc.10', -1],
  ['2.0.0-1', '2.0.0-beta', -1],
  ['2.0.0-beta', '2.0.0-beta.1', -1],
  ['2.0.0-BETA', '2.0.0-beta', 0],
  // build metadata is ignored
  ['2.0.0+7', '2.0.0+9', 0],
  ['2.0.0-beta+7', '2.0.0', -1],
  // unreadable: five parts, words, empty
  ['1.2.3.4.5', '1.0.0', null],
  ['', '1.0.0', null],
  ['next', '1.0.0', null],
  ['1.x', '1.0.0', null],
  ['2.0.0-', '2.0.0', null],
];

test('tryCompareVersions: the table, in both directions; unreadable is null (never judged)', () => {
  for (const [a, b, want] of TABLE) {
    assert.equal(tryCompareVersions(a, b), want, `${a} vs ${b}`);
    assert.equal(tryCompareVersions(b, a), want === null ? null : want === 0 ? 0 : -want, `${b} vs ${a}`);
  }
  assert.equal(tryCompareVersions(null, '1.0'), null);
  assert.equal(tryCompareVersions('1.0', undefined), null);
});

test('compareVersions is TOTAL: never null or NaN, unreadable sorts lowest, stable among themselves', () => {
  for (const [a, b, want] of TABLE) {
    const got = compareVersions(a, b);
    assert.ok(got === -1 || got === 0 || got === 1, `${a} vs ${b} = ${got}`);
    if (want !== null) assert.equal(got, want, `${a} vs ${b}`);
  }
  assert.equal(compareVersions('', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', 'next'), 1);
  assert.equal(compareVersions(null, undefined), 0);
  assert.equal(compareVersions('', null), 0);
  assert.equal(compareVersions('alpha', 'beta'), -1);
  assert.equal(compareVersions('b2', 'b10'), -1);
  const mixed = ['1.9.2', 'next', '1.10.0', '', '2.0.0-beta', '2.0.0', null, '1.9'];
  const sorted = mixed.slice().sort(compareVersions);
  assert.deepEqual(sorted.slice(3), ['1.9', '1.9.2', '1.10.0', '2.0.0-beta', '2.0.0']);
  assert.deepEqual(
    ['1.9', '2.0.0', '1.10.0'].sort(newestVersionFirst),
    ['2.0.0', '1.10.0', '1.9'],
  );
});

test('parseVersion keeps the parts and the pre-release', () => {
  assert.deepEqual(parseVersion('v2.00.1-rc.1+5'), { parts: [2, 0, 1], pre: ['rc', '1'] });
  assert.deepEqual(parseVersion(' 3 '), { parts: [3], pre: [] });
  assert.equal(parseVersion('1.2.3.4.5'), null);
  assert.equal(parseVersion(null), null);
  assert.equal(isReadableVersion('2.0.1.90'), true);
  assert.equal(isReadableVersion('v'), false);
});

test('sameVersion: written alike or not; unreadable ones compare as text', () => {
  assert.equal(sameVersion('2.00.1', '2.0.1'), true);
  assert.equal(sameVersion('2.1', '2.1.0'), true);
  assert.equal(sameVersion('2.1', '2.1.1'), false);
  assert.equal(sameVersion('2.0.0-beta', '2.0.0'), false);
  assert.equal(sameVersion(' next ', 'next'), true);
  assert.equal(sameVersion('', ''), false);
  assert.equal(sameVersion(null, '1.0'), false);
});

test('build numbers: numbers, dotted numbers, text; total vs judged', () => {
  const rows: [string | null, string | null, -1 | 0 | 1 | null][] = [
    ['95', '88', 1],
    ['100', '99', 1],
    ['9', '10', -1],
    ['090', '90', 0],
    ['1.2.3', '1.2.10', -1],
    ['1.2', '1.2.0', 0],
    ['95', null, null],
    [null, null, null],
    ['b12', '95', null],
    ['b12', 'b12', null],
  ];
  for (const [a, b, want] of rows) assert.equal(tryCompareBuildNumbers(a, b), want, `${a} vs ${b}`);
  // The old Number(buildNumber) subtraction: NaN for a dotted number, 0 for text.
  assert.equal(compareBuildNumbers('1.2.10', '1.2.3'), 1);
  assert.equal(compareBuildNumbers('b12', 'b9'), 1);
  assert.equal(compareBuildNumbers('b12', '5'), -1);
  assert.equal(compareBuildNumbers('5', 'b12'), 1);
  assert.equal(compareBuildNumbers(null, '1'), -1);
  assert.equal(compareBuildNumbers('', null), 0);
  assert.deepEqual(['9', '100', '10', 'x1'].sort(newestBuildFirst), ['100', '10', '9', 'x1']);
});

test('naturalCompare: digit runs are numbers, case does not matter', () => {
  assert.equal(naturalCompare('file2', 'file10'), -1);
  assert.equal(naturalCompare('A1', 'a1'), 0);
  assert.equal(naturalCompare('a', 'a1'), -1);
});

test('compareReleases: version first, the build number breaks the tie between two builds of one version', () => {
  assert.equal(compareReleases({ version: '1.19.0', build: '90' }, { version: '1.19.0', build: '88' }), 1);
  assert.equal(compareReleases({ version: '1.18.9', build: '900' }, { version: '1.19.0', build: '88' }), -1);
  assert.equal(compareReleases({ version: '1.19.0', build: null }, { version: '1.19.0', build: '88' }), -1);
  // judged
  assert.equal(tryCompareReleases({ version: '1.19.0', build: '90' }, { version: '1.19.0', build: '88' }), 1);
  assert.equal(tryCompareReleases({ version: '1.19.0', build: '88' }, { version: '1.19.0', build: '88' }), 0);
  assert.equal(tryCompareReleases({ version: '1.19.0', build: null }, { version: '1.19.0', build: '88' }), 0);
  assert.equal(tryCompareReleases({ version: 'next', build: '1' }, { version: '1.19.0', build: '88' }), null);
  assert.deepEqual(
    [
      { version: '1.19.0', build: '88' },
      { version: '1.19.0', build: '90' },
      { version: '1.20.0', build: '1' },
    ].sort(newestReleaseFirst).map((r) => `${r.version}/${r.build}`),
    ['1.20.0/1', '1.19.0/90', '1.19.0/88'],
  );
});

test('isCreatableVersion: one to three whole numbers, what the server accepts', () => {
  for (const ok of ['1', '1.0', '10.20.30', '2.00.1']) assert.equal(isCreatableVersion(ok), true, ok);
  for (const bad of ['', '1.', '.1', '1.2.3.4', '2.00.1.90', 'v1.2', '1.2-beta', ' 1.2', '1..2'])
    assert.equal(isCreatableVersion(bad), false, bad);
  // readable but not creatable: the two sets are deliberately different
  assert.equal(isReadableVersion('2.00.1.90'), true);
  assert.equal(isCreatableVersion('2.00.1.90'), false);
});
