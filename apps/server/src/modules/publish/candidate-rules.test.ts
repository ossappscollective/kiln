import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildCandidate, ReleaseCandidates } from '@kiln/connectors';
import type { AppRelease } from '../../services/apps.ts';
import { createVerdictOf, refusalSentence, withReleaseRules } from './candidate-rules.ts';

const release = (over: Partial<AppRelease>): AppRelease => ({
  id: over.id ?? `r-${over.version}`,
  appId: 'a1',
  platform: 'ios',
  version: '1.0.0',
  track: null,
  build: null,
  status: 'live',
  rawState: '',
  rolloutFraction: null,
  versionCodes: null,
  storeUpdatedAt: null,
  statusSince: null,
  syncedAt: 0,
  ...over,
});
const build = (buildNumber: string, version: string, over: Partial<BuildCandidate> = {}): BuildCandidate => ({
  id: `b${buildNumber}`,
  buildNumber,
  version,
  uploadedDate: '2026-11-19T10:30:12Z',
  processingState: 'VALID',
  expired: false,
  selectable: true,
  reason: null,
  attached: false,
  eligibility: { eligible: true, severity: 'ok', code: 'ok', message: 'ok' },
  exportCompliance: 'answered',
  testNotes: { read: false, locales: [] },
  ...over,
});
const read = (builds: BuildCandidate[], editable = false): ReleaseCandidates => ({
  store: 'appstoreconnect',
  platform: 'ios',
  version: editable ? { id: 'v', versionString: '2.0.0', state: 'PREPARE_FOR_SUBMISSION' } : null,
  builds,
  attachedBuildId: null,
  truncatedAt: null,
});
const builds = (r: ReleaseCandidates) => (r.store === 'appstoreconnect' ? (r.builds as (BuildCandidate & { create: ReturnType<typeof createVerdictOf> | null })[]) : []);

test('create verdict: the rule of core, per build (invalid, exists, not higher, editable in the way)', () => {
  const live = release({ version: '1.19.0', build: '88' });
  assert.equal(createVerdictOf('2.0.1', [live]).creatable, true);
  assert.equal(createVerdictOf('2.0.1.9', [live]).refusal, 'invalid_version');
  assert.equal(createVerdictOf('1.19.0', [live]).refusal, 'version_exists');
  const inReview = release({ version: '2.5.0', status: 'in_review' });
  const notHigher = createVerdictOf('2.0.1', [live, inReview]);
  assert.equal(notHigher.refusal, 'not_higher');
  assert.equal(notHigher.newestFixed, '2.5.0');
  const draft = release({ version: '1.11.6', status: 'draft' });
  const editable = createVerdictOf('2.0.1', [live, draft]);
  assert.equal(editable.refusal, 'editable_version_exists');
  assert.equal(editable.editableVersion, '1.11.6');
  assert.match(refusalSentence(editable), /1\.11\.6 can still be edited/);
});

test('release/candidates: every build says whether its version can be created; a build with no version to attach to is no dead end', () => {
  const live = release({ version: '1.19.0', build: '88' });
  const none = withReleaseRules(
    read([
      build('95', '2.0.1', {
        eligibility: { eligible: false, severity: 'blocked', code: 'no_editable_version', message: 'Create the next version in App Store Connect first.' },
      }),
    ]),
    { appId: 'a1', releases: [live] },
  );
  const [b] = builds(none);
  assert.equal(b?.create?.creatable, true);
  assert.match(b?.eligibility.message ?? '', /Create version 2\.0\.1 from this page first/);

  const refused = withReleaseRules(
    read([
      build('95', '1.19.0', {
        eligibility: { eligible: false, severity: 'blocked', code: 'no_editable_version', message: 'x' },
      }),
    ]),
    { appId: 'a1', releases: [live] },
  );
  assert.equal(builds(refused)[0]?.create?.refusal, 'version_exists');
  assert.match(builds(refused)[0]?.eligibility.message ?? '', /cannot be created: Version 1\.19\.0 already exists/);
});

test('release/candidates: a build already used by a version in review is blocked (in_flight); one not newer than live is a warning (older_than_live)', () => {
  const releases = [
    release({ version: '1.19.0', build: '88' }),
    release({ version: '2.0.0', status: 'in_review', build: '90' }),
  ];
  const out = builds(
    withReleaseRules(read([build('90', '2.0.0'), build('92', '1.11.6'), build('95', '2.1.0')], true), {
      appId: 'a1',
      releases,
    }),
  );
  const by = (n: string) => out.find((b) => b.buildNumber === n);
  assert.equal(by('90')?.eligibility.code, 'in_flight');
  assert.equal(by('90')?.eligibility.eligible, false);
  assert.equal(by('92')?.eligibility.code, 'older_than_live');
  assert.equal(by('92')?.eligibility.severity, 'warning');
  assert.equal(by('92')?.eligibility.eligible, true);
  assert.equal(by('95')?.eligibility.code, 'ok');
});

test('release/candidates: an expired build keeps the connector verdict; Google Play reads pass through', () => {
  const live = release({ version: '1.19.0', build: '88' });
  const expired = build('92', '1.11.6', {
    eligibility: { eligible: false, severity: 'blocked', code: 'expired', message: 'expired' },
  });
  assert.equal(builds(withReleaseRules(read([expired]), { appId: 'a1', releases: [live] }))[0]?.eligibility.code, 'expired');
  const play: ReleaseCandidates = { store: 'googleplay', platform: 'android', track: 'internal', codes: [] };
  assert.equal(withReleaseRules(play, { appId: 'a1', releases: [live] }), play);
});
