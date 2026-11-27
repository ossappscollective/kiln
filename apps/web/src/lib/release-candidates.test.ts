import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import {
  type BuildCandidate,
  buildRows,
  type CodeCandidate,
  codeRows,
  codesInTrack,
  createRefusalText,
  createVerdictFor,
  type Eligibility,
  eligibilityView,
  hasTestNotes,
  isTrackName,
  noBuildSentence,
  noCodeSentence,
  sourceRunOf,
  testNotesLine,
  uploadedText,
} from './release-candidates.ts';

const elig = (
  code: string,
  eligible: boolean,
  severity: Eligibility['severity'],
  message = '',
): Eligibility => ({ code, eligible, severity, message });
const build = (
  id: string,
  e: Eligibility | undefined,
  extra: Partial<BuildCandidate> = {},
): BuildCandidate => ({
  id,
  buildNumber: id,
  version: '2.4.0',
  uploadedDate: '2026-11-19T10:30:12Z',
  processingState: 'VALID',
  expired: false,
  selectable: e?.eligible ?? true,
  reason: null,
  attached: false,
  ...(e ? { eligibility: e } : {}),
  ...extra,
});

test('a blocked build is disabled and shows the sentence of the server', () => {
  const v = eligibilityView(
    build('1', elig('wrong_version', false, 'blocked', 'Build 1 belongs to 2.3.0, not 2.4.0.')),
  );
  assert.deepEqual(v, {
    selectable: false,
    tone: 'bad',
    sentence: 'Build 1 belongs to 2.3.0, not 2.4.0.',
    label: 'Cannot be chosen',
  });
});

test('a warning can be chosen and says so; the build of the draft is shown as already chosen', () => {
  const warn = eligibilityView(
    build('1', elig('export_compliance_missing', true, 'warning', 'No export answer.')),
  );
  assert.equal(warn.selectable, true);
  assert.equal(warn.tone, 'warn');
  const attached = eligibilityView(
    build('2', elig('already_attached', false, 'ok', 'It is the build of the version already.')),
  );
  assert.deepEqual(
    [attached.selectable, attached.tone, attached.label],
    [false, 'ok', 'Already chosen'],
  );
});

test('without a sentence the code speaks, and an older server falls back to selectable and reason', () => {
  assert.match(
    eligibilityView(build('1', elig('processing', false, 'blocked', ''))).sentence,
    /still processing/,
  );
  assert.equal(
    eligibilityView(build('1', elig('brand_new_code', false, 'blocked', ''))).sentence,
    'This cannot be chosen now.',
  );
  assert.equal(
    eligibilityView({ selectable: false, reason: 'The build expired.' }).sentence,
    'The build expired.',
  );
  assert.equal(
    eligibilityView({ selectable: false, reason: null }).sentence,
    'This build cannot be chosen now.',
  );
  assert.equal(eligibilityView({ selectable: true }).selectable, true);
});

test('"no eligible builds" always says why', () => {
  assert.match(noBuildSentence([], '2.4.0') as string, /lists no builds/);
  const none = [
    build('1', elig('wrong_version', false, 'blocked', 'x')),
    build('2', elig('wrong_version', false, 'blocked', 'x')),
    build('3', elig('processing', false, 'blocked', 'x')),
  ];
  assert.equal(
    noBuildSentence(none, '2.4.0'),
    '3 builds are listed and none can be chosen now: 2 are for another version than 2.4.0; 1 is still processing.',
  );
  assert.equal(
    noBuildSentence([build('1', elig('ok', true, 'ok', 'fine')), ...none], '2.4.0'),
    null,
  );
  assert.match(
    noBuildSentence([build('9', elig('already_attached', false, 'ok', 'x'))], null) as string,
    /chosen already/,
  );
});

test('the source run of a build is its linked run, or a plain reason', () => {
  const linked = {
    buildNumber: '412',
    linkState: 'linked' as const,
    link: { run: { workflow: 'release.yml', title: 'Release 2.4', url: 'https://x/1' } },
  };
  assert.deepEqual(sourceRunOf('412', [linked as never]), {
    text: 'release.yml Release 2.4',
    url: 'https://x/1',
  });
  assert.equal(
    sourceRunOf('413', [linked as never]).text,
    'No CI run linked (this build is not in the builds of the app yet)',
  );
  assert.equal(
    sourceRunOf('412', [{ buildNumber: '412', linkState: 'tag', link: null }]).text,
    'A tag carries this number, but no CI run was found',
  );
  assert.equal(
    sourceRunOf('412', [{ buildNumber: '412', linkState: 'unlinked', link: null }]).text,
    'No CI run linked',
  );
  assert.equal(sourceRunOf(null, []).text, 'No CI run linked');
});

test('the upload time is written in UTC', () => {
  assert.equal(uploadedText('2026-11-19T10:30:12Z'), 'Nov 19, 2026, 10:30 AM UTC');
  assert.equal(uploadedText(null), 'date unknown');
  assert.equal(uploadedText('not a date'), 'date unknown');
});

test('TestFlight notes: read, empty, not read and failed are told apart', () => {
  assert.match(
    testNotesLine({ read: true, locales: [{ locale: 'en-US', text: 'a', truncated: false }] }),
    /1 language\./,
  );
  assert.match(testNotesLine({ read: true, locales: [] }), /has none/);
  assert.match(testNotesLine({ read: false, locales: [] }), /newest eight/);
  assert.match(testNotesLine({ read: false, locales: [], error: 'forbidden' }), /may not read/);
  assert.match(testNotesLine({ read: false, locales: [], error: 'rate_limited' }), /limiting/);
  assert.match(testNotesLine(undefined), /did not say/);
  assert.equal(
    hasTestNotes({ read: true, locales: [{ locale: 'en-US', text: 'a', truncated: false }] }),
    true,
  );
  assert.equal(hasTestNotes({ read: false, locales: [] }), false);
});

test('build rows carry the number, the date, the run and the eligibility', () => {
  const rows = buildRows(
    [build('412', elig('ok', true, 'ok', 'Processed.'))],
    [{ buildNumber: '412', linkState: 'unlinked', link: null }],
  );
  assert.equal(rows[0]?.title, 'Build 412');
  assert.equal(rows[0]?.uploaded, 'Nov 19, 2026, 10:30 AM UTC');
  assert.equal(rows[0]?.run.text, 'No CI run linked');
  assert.equal(rows[0]?.eligibility.selectable, true);
});

const code = (
  versionCode: string,
  inTrack: { name: string | null; status: string }[],
  e?: Eligibility,
): CodeCandidate => ({
  versionCode,
  source: 'bundle',
  sha256: null,
  inTrack,
  ...(e ? { eligibility: e } : {}),
});

test('version codes: the codes of the source track come first, then the newest', () => {
  const codes = [
    code('10', []),
    code('12', []),
    code('11', [{ name: 'Beta', status: 'completed' }]),
  ];
  const rows = codeRows(codes, codesInTrack(codes));
  assert.deepEqual(
    rows.map((r) => r.versionCode),
    ['11', '12', '10'],
  );
  assert.equal(rows[0]?.where, 'Beta (completed)');
  assert.equal(rows[0]?.inSource, true);
});

test('no codes to add says why', () => {
  assert.match(noCodeSentence([], 'production') as string, /no uploaded version codes/);
  const rows = codeRows([
    code(
      '1',
      [{ name: 'a', status: 'inProgress' }],
      elig('already_live', false, 'blocked', 'live'),
    ),
    code('2', [], elig('already_in_draft', false, 'ok', 'draft')),
  ]);
  assert.equal(
    noCodeSentence(rows, 'production'),
    '2 version codes are listed and none can be added: 1 is in a release of production that is live or rolling out; 1 is in the draft already.',
  );
  assert.equal(
    noCodeSentence(codeRows([code('3', [], elig('ok', true, 'ok', 'fine'))]), 'production'),
    null,
  );
});

test('track names follow the server rule', () => {
  assert.equal(isTrackName('production'), true);
  assert.equal(isTrackName(' beta '), true);
  assert.equal(isTrackName(''), false);
  assert.equal(isTrackName('-x'), false);
});

test('build rows carry the age of the upload and mark the newest build Latest', () => {
  const now = Date.parse('2026-11-21T10:30:12Z');
  const rows = buildRows(
    [
      build('413', elig('ok', true, 'ok', 'ok'), { uploadedDate: '2026-11-20T10:30:12Z' }),
      build('412', elig('ok', true, 'ok', 'ok'), { uploadedDate: '2026-11-19T10:30:12Z' }),
      build('411', elig('ok', true, 'ok', 'ok'), { uploadedDate: null }),
    ],
    [],
    now,
  );
  assert.deepEqual(
    rows.map((r) => r.latest),
    [true, false, false],
  );
  assert.equal(rows[0]?.uploadedAge, 'yesterday');
  assert.equal(rows[1]?.uploadedAge, '2 days ago');
  assert.equal(rows[2]?.uploadedAge, null);
});

test('the build number of a picker row is the structured one: a Spanish title ("Compilacion 240") gives the same number as English', () => {
  try {
    useLocale('es');
    const rows = buildRows([build('240', elig('ok', true, 'ok'), { buildNumber: '240' })], [], Date.now());
    assert.match(rows[0]?.title ?? '', /240/);
    assert.notEqual(rows[0]?.title, 'Build 240', 'the title is translated, so a parse of it would fail');
    assert.equal(rows[0]?.buildNumber, '240');
  } finally {
    useLocale('en');
  }
  const unknown = buildRows([build('x', undefined, { buildNumber: null as never })], [], Date.now());
  assert.equal(unknown[0]?.buildNumber, null);
});

test('a create the store would refuse is said in words, never offered: the verdict of the server, per version the person typed', () => {
  const ok = { version: '2.0.1', creatable: true, refusal: null, reasons: [], editableVersion: null, newestFixed: null } as const;
  const exists = { ...ok, version: '1.19.0', creatable: false, refusal: 'version_exists', reasons: ['version_exists'] } as const;
  const low = { ...ok, version: '2.0.0', creatable: false, refusal: 'not_higher', reasons: ['not_higher'], newestFixed: '2.5.0' } as const;
  assert.equal(createRefusalText(ok), null);
  assert.equal(createRefusalText(undefined), null);
  assert.match(createRefusalText(exists) ?? '', /1\.19\.0 already exists in App Store Connect/);
  assert.match(createRefusalText(low) ?? '', /2\.0\.0 must be higher than 2\.5\.0/);
  assert.match(
    createRefusalText({ ...ok, creatable: false, refusal: 'editable_version_exists', editableVersion: '1.11.6' }) ?? '',
    /Version 1\.11\.6 can still be edited/,
  );
  const builds = [{ create: exists }, { create: ok }, {}];
  // "1.19" and "1.19.0" are one version: the typed spelling does not hide the refusal.
  assert.equal(createVerdictFor(builds, ' 1.19 ')?.refusal, 'version_exists');
  assert.equal(createVerdictFor(builds, '2.0.1')?.creatable, true);
  assert.equal(createVerdictFor(builds, '3.0.0'), null, 'a version no build has: nothing is claimed');
  assert.equal(createVerdictFor(builds, ''), null);
});

test('the new eligibility codes read like the others: in flight blocks, older than live is a warning', () => {
  const inFlight = eligibilityView({ eligibility: elig('in_flight', false, 'blocked', '') });
  assert.equal(inFlight.selectable, false);
  assert.match(inFlight.sentence, /in review or waiting to be released already uses this build/);
  const old = eligibilityView({ eligibility: elig('older_than_live', true, 'warning', '') });
  assert.equal(old.selectable, true);
  assert.equal(old.tone, 'warn');
  assert.match(old.sentence, /not newer than what is live/);
});
