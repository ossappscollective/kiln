import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BuildCandidate,
  buildRows,
  type CodeCandidate,
  codeRows,
  codesInTrack,
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

test('the upload time is plain UTC text', () => {
  assert.equal(uploadedText('2026-11-19T10:30:12Z'), '2026-11-19 10:30 UTC');
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
  assert.equal(rows[0]?.uploaded, '2026-11-19 10:30 UTC');
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
