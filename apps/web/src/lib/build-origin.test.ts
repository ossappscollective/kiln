import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builtReason,
  latestOf,
  originRun,
  originView,
  readVersionOf,
  sameVersion,
  versionInName,
  versionMismatch,
} from './build-origin.ts';
import {
  type CodeCandidate,
  chosenBuildLine,
  chosenCodeLines,
  codeRows,
} from './release-candidates.ts';

// 24 Nov 2026, 23:38 in the clock of the machine; the age is against a fixed "now" one day later.
const BUILT = Date.UTC(2026, 10, 24, 23, 38);
const NOW = BUILT + 24 * 60 * 60_000 + 60_000;
const RUN = { runNumber: 41, branch: 'main', commit: 'abc1234', url: 'https://github.test/run/41' };

test('a CI hit reads "Version", "Built <date> · <age>" and links the run', () => {
  const v = originView(
    { version: '2.00.1', builtAt: BUILT, origin: 'ci', builtFrom: 'ci', ci: RUN },
    NOW,
  );
  assert.equal(v.versionText, 'Version 2.00.1');
  assert.equal(v.version, '2.00.1');
  assert.equal(v.versionUnknown, false);
  assert.match(v.builtText, /^Built .*2026.* · (yesterday|1 day ago)$/);
  assert.equal(v.builtKnown, true);
  assert.match(v.builtTitle, /CI run #41/);
  assert.match(v.versionTitle, /Read by Kiln/);
  assert.deepEqual(v.run, { text: 'CI run #41', title: 'main · abc1234', url: RUN.url });
});

test('a store build says "Uploaded", a release name is a name, never a read version or a date', () => {
  const store = originView(
    { version: '2.00.0', builtAt: BUILT, origin: 'store', builtFrom: 'store' },
    NOW,
  );
  assert.match(store.builtText, /^Uploaded /);
  assert.equal(store.version, '2.00.0');
  const named = originView(
    { version: '1.15.2', builtAt: null, origin: 'release', builtFrom: null },
    NOW,
  );
  assert.equal(named.versionText, 'Release name 1.15.2');
  assert.equal(named.version, null, 'a release name is not a version read from the file');
  assert.equal(named.versionUnknown, false);
  assert.equal(named.builtKnown, false);
  assert.match(named.versionTitle, /Not read from the file/);
});

test('nothing known says so honestly, for the version and for the date', () => {
  const v = originView({}, NOW);
  assert.equal(v.versionText, 'Version not known: the file was not read by Kiln');
  assert.equal(v.versionUnknown, true);
  assert.equal(v.version, null);
  assert.equal(v.builtText, 'Build date not known');
  assert.equal(v.builtKnown, false);
  assert.match(v.builtTitle, /Build date not available from Google Play/);
  assert.equal(v.run, null);
  assert.equal(originView({ version: '  ', builtAt: null }, NOW).versionUnknown, true);
  assert.equal(readVersionOf({ version: '1.0', origin: 'release' }), null);
  assert.equal(readVersionOf({ version: '1.0', origin: 'ci' }), '1.0');
});

test('a run without a number or a link', () => {
  assert.equal(originRun(undefined), null);
  assert.deepEqual(originRun({ runNumber: null, branch: null, commit: null, url: null }), {
    text: 'CI run',
    title: 'CI run',
    url: null,
  });
});

test('Latest: the newest known build date, unless an undated code above it could be newer', () => {
  const a = { id: '90', buildNumber: '90', builtAt: BUILT };
  const b = { id: '89', buildNumber: '89', builtAt: BUILT - 1000 };
  assert.equal(latestOf([b, a]), '90');
  assert.equal(latestOf([{ id: '88', buildNumber: '88', builtAt: null }, a, b]), '90');
  assert.equal(
    latestOf([{ id: '91', buildNumber: '91', builtAt: null }, a, b]),
    null,
    'an undated higher code may be newer',
  );
  assert.equal(latestOf([{ id: '91', buildNumber: '91', builtAt: null }]), null, 'no date known');
  assert.equal(latestOf([]), null);
  assert.equal(
    latestOf([
      { id: '7', buildNumber: '7', builtAt: 5 },
      { id: '8', buildNumber: '8', builtAt: 5 },
    ]),
    '8',
    'a tie goes to the higher number',
  );
});

test('versions: what a release name says, and when two writings are the same version', () => {
  assert.equal(versionInName('2.00.1'), '2.00.1');
  assert.equal(versionInName('2.00.1 (hotfix)'), '2.00.1');
  assert.equal(versionInName('Spring release'), null);
  assert.equal(versionInName(null), null);
  assert.equal(sameVersion('2.00.1', '2.0.1'), true);
  assert.equal(sameVersion('2.1', '2.1.0'), true);
  assert.equal(sameVersion('2.00.0', '2.00.1'), false);
  assert.equal(sameVersion('2.0-beta', '2.0-beta'), true);
});

test('the mismatch warning: only a version read from a file or the store against a version the release says', () => {
  assert.equal(
    versionMismatch({ version: '2.00.0' }, '2.00.1'),
    'This build is version 2.00.0, but you are releasing 2.00.1.',
  );
  assert.equal(versionMismatch({ version: '2.00.1' }, '2.0.1'), null);
  assert.equal(versionMismatch({ version: null }, '2.00.1'), null);
  assert.equal(versionMismatch({ version: '2.00.0' }, 'Spring release'), null);
  assert.equal(versionMismatch({ version: '2.00.0' }, null), null);
});

const code = (versionCode: string, extra: Partial<CodeCandidate> = {}): CodeCandidate => ({
  versionCode,
  source: 'bundle',
  sha256: null,
  inTrack: [],
  ...extra,
});

test('code rows carry the origin and the Latest mark, sorted as before (newest code first)', () => {
  const rows = codeRows(
    [
      code('88', {
        inTrack: [{ name: '1.15.2', status: 'completed' }],
        version: '1.15.2',
        origin: 'release',
      }),
      code('90', { version: '2.00.1', builtAt: BUILT, origin: 'ci', builtFrom: 'ci', ci: RUN }),
      code('89', { version: '2.00.0', builtAt: BUILT - 86_400_000, origin: 'ci', builtFrom: 'ci' }),
    ],
    [],
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.versionCode),
    ['90', '89', '88'],
  );
  assert.deepEqual(
    rows.map((r) => r.latest),
    [true, false, false],
  );
  assert.equal(rows[0]?.version, '2.00.1');
  assert.equal(rows[2]?.version, null, 'a release name is not a read version');
  assert.equal(rows[2]?.origin.versionText, 'Release name 1.15.2');
  assert.equal(rows[0]?.origin.run?.url, RUN.url);
  // An older server sends none of the fields: nothing is claimed.
  const old = codeRows([code('5')], [], NOW);
  assert.equal(old[0]?.origin.versionUnknown, true);
  assert.equal(old[0]?.latest, false);
});

test('the chosen builds for Confirm: version, date and the mismatch warning', () => {
  const known = [
    code('90', { version: '2.00.0', builtAt: BUILT, origin: 'ci', builtFrom: 'ci' }),
    code('91'),
  ];
  const [a, b] = chosenCodeLines(['90', '91', '92'], known, '2.00.1', NOW);
  assert.equal(a?.title, 'Version code 90');
  assert.equal(a?.mismatch, 'This build is version 2.00.0, but you are releasing 2.00.1.');
  assert.equal(b?.origin.versionUnknown, true);
  assert.equal(b?.mismatch, null);
  assert.equal(chosenCodeLines(['90'], known, '2.00.0', NOW)[0]?.mismatch, null);
  assert.equal(chosenCodeLines(['90'], known, null, NOW)[0]?.mismatch, null);
  // App Store: the store's version and upload time; a missing one is not blamed on a file.
  const apple = chosenBuildLine(
    {
      id: 'b1',
      buildNumber: '412',
      version: '2.4.0',
      uploadedDate: '2026-11-19T10:30:12Z',
      processingState: 'VALID',
      expired: false,
      selectable: true,
      reason: null,
      attached: false,
    },
    '2.5.0',
    NOW,
  );
  assert.equal(apple?.title, 'Build 412');
  assert.equal(apple?.origin.versionText, 'Version 2.4.0');
  assert.match(apple?.origin.builtText ?? '', /^Uploaded /);
  assert.equal(apple?.sayUnknown, false);
  assert.match(apple?.mismatch ?? '', /version 2.4.0, but you are releasing 2.5.0/);
  assert.equal(chosenBuildLine(undefined, '2.5.0', NOW), null);
});

const GAPS = {
  not_read: /^Build date not known: Kiln has not read this build yet$/,
  file_gone: /^Build date not known: the CI file is gone$/,
  github_unreachable: /^Build date not known: GitHub could not be reached$/,
  github_no_access: /^Build date not known: Kiln cannot read the CI builds of this app$/,
  no_repository: /^Build date not known: no CI repository is linked to this app$/,
} as const;

test('a missing build date says why, one sentence per reason the server gives', () => {
  for (const [gap, text] of Object.entries(GAPS)) {
    const v = originView({ builtAt: null, builtGap: gap as keyof typeof GAPS }, NOW);
    assert.match(v.builtText, text, gap);
    assert.equal(v.builtKnown, false);
    assert.equal(v.reason?.key, gap);
    assert.notEqual(v.builtTitle, '', gap);
  }
  // Only a code Kiln has not read can be helped by reading the CI builds.
  assert.equal(builtReason({ builtGap: 'not_read' })?.readable, true);
  for (const gap of [
    'file_gone',
    'github_unreachable',
    'github_no_access',
    'no_repository',
  ] as const)
    assert.equal(builtReason({ builtGap: gap })?.readable, false, gap);
  assert.equal(builtReason({ builtAt: BUILT, builtGap: null }), null, 'a known date has no reason');
});

test('the expired file says when GitHub dropped it, when that is known', () => {
  const on = originView({ builtAt: null, builtGap: 'file_gone', ciExpiredAt: BUILT }, NOW);
  assert.match(on.builtText, /^Build date not known: the CI file is gone \(expired .*2026.*\)$/);
});

test('Google Play gives no date: said plainly when the server says nothing else is known, and after the CI builds were read', () => {
  const none = originView({ builtAt: null, builtGap: null }, NOW);
  assert.equal(none.builtText, 'Build date not known: Google Play does not provide a build date');
  assert.equal(none.reason?.readable, false);
  const tried = originView({ builtAt: null, builtGap: 'not_read' }, NOW, { ciTried: true });
  assert.match(tried.builtText, /none of the recent CI builds has this version code/);
  assert.equal(tried.reason?.key, 'not_in_ci');
  assert.equal(tried.reason?.readable, false, 'asking again would find nothing new');
  // A server that sends no reason (older) or an App Store build: the plain sentence, no claim.
  assert.equal(originView({}, NOW).reason, null);
});

test('matched by build number only is said on the row; first seen is not a build date', () => {
  const v = originView(
    {
      version: '2.00.1',
      builtAt: BUILT,
      origin: 'ci',
      builtFrom: 'ci',
      matchedBy: 'build_number_only',
      ci: RUN,
    },
    NOW,
  );
  assert.equal(v.matchNote, 'Matched by build number only');
  assert.match(v.matchTitle, /another package/);
  assert.equal(originView({ matchedBy: 'package' }, NOW).matchNote, null);
  const seen = originView({ builtAt: null, builtGap: 'not_read', firstSeenAt: BUILT }, NOW);
  assert.match(seen.firstSeenText ?? '', /^First seen by Kiln .*2026/);
  assert.match(seen.firstSeenTitle, /does not provide the build date/);
  assert.equal(seen.builtKnown, false, 'first seen never becomes the build date');
  assert.match(seen.builtText, /^Build date not known/);
  // With a real build date the first-seen line is not shown.
  assert.equal(
    originView({ builtAt: BUILT, builtFrom: 'ci', firstSeenAt: BUILT }, NOW).firstSeenText,
    null,
  );
});

test('the Latest badge ignores first seen', () => {
  const rows = codeRows(
    [
      {
        versionCode: '90',
        source: 'bundle',
        sha256: null,
        inTrack: [],
        eligibility: { eligible: true, code: 'ok', severity: 'info', message: '' },
        builtAt: null,
        builtGap: 'not_read',
        firstSeenAt: BUILT,
      },
      {
        versionCode: '89',
        source: 'bundle',
        sha256: null,
        inTrack: [],
        eligibility: { eligible: true, code: 'ok', severity: 'info', message: '' },
        builtAt: BUILT,
        builtFrom: 'ci',
        origin: 'ci',
        version: '2.00.0',
      },
    ] as unknown as CodeCandidate[],
    [],
    NOW,
  );
  // An undated higher code could be the newer one, so nothing is marked.
  assert.equal(rows.filter((r) => r.latest).length, 0);
});
