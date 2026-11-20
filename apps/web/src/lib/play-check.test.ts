import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StagedChangesView } from '@mrm/core';
import {
  bodyKey,
  canCheck,
  checkBody,
  checkedLine,
  contextOf,
  fractionOf,
  localChecks,
  NO_ERRORS_SENTENCE,
  outcomeView,
  type PlayCheckAnswer,
  proposalOf,
  stateLine,
} from './play-check.ts';
import type { EditableRelease } from './release-candidates.ts';

const editable: EditableRelease = {
  store: 'googleplay',
  platform: 'android',
  track: 'production',
  draft: {
    name: '2.1',
    status: 'draft',
    userFraction: null,
    versionCodes: ['241'],
    notes: [{ locale: 'en-US', text: 'Store text' }],
  },
  others: [{ name: '2.0', status: 'completed', userFraction: null, versionCodes: ['200'], notes: [] }],
};
const staged = (items: { field: string; locale: string; value: string }[]) =>
  ({ release: items }) as unknown as StagedChangesView;

test('staged values win over the store draft in the Confirm step; the release dialog uses the store draft only', () => {
  const view = staged([
    { field: 'release_name', locale: '', value: 'Spring' },
    { field: 'release_notes', locale: 'en-US', value: 'Staged text' },
    { field: 'release_notes', locale: 'de-DE', value: 'Deutsch' },
  ]);
  const base = { track: 'production', codes: ['241'], fraction: 0.1, view, editable };
  const withStaged = proposalOf({ ...base, source: 'staged' });
  assert.equal(withStaged.releaseName, 'Spring');
  assert.deepEqual(withStaged.notes, [
    { locale: 'en-US', text: 'Staged text' },
    { locale: 'de-DE', text: 'Deutsch' },
  ]);
  const store = proposalOf({ ...base, source: 'store' });
  assert.equal(store.releaseName, '2.1');
  assert.deepEqual(store.notes, [{ locale: 'en-US', text: 'Store text' }]);
  // No codes given: the draft's codes.
  assert.deepEqual(proposalOf({ ...base, codes: [], source: 'store' }).versionCodes, ['241']);
});

test('the body: no share is a draft, a share is a rollout, 100% is completed, a bad share is left out', () => {
  const p = (userFraction: number | null) =>
    proposalOf({ source: 'store', track: ' production ', codes: ['241'], fraction: userFraction, view: null, editable });
  assert.deepEqual(checkBody(p(null)), {
    track: 'production',
    versionCodes: ['241'],
    releaseName: '2.1',
    status: 'draft',
    notes: [{ locale: 'en-US', text: 'Store text' }],
  });
  assert.equal(checkBody(p(0.1)).status, 'inProgress');
  assert.equal(checkBody(p(0.1)).userFraction, 0.1);
  assert.equal(checkBody(p(1)).status, 'completed');
  assert.equal(checkBody(p(1)).userFraction, 1);
  assert.equal(checkBody(p(1.5)).userFraction, undefined);
  assert.equal(bodyKey(checkBody(p(0.1))) === bodyKey(checkBody(p(0.2))), false);
});

test('the check cannot be asked while the release is incomplete', () => {
  const p = proposalOf({ source: 'store', track: 'production', codes: [], fraction: null, view: null, editable: null });
  assert.deepEqual(canCheck(p), { ok: false, reason: 'Choose the version codes first.' });
  assert.equal(canCheck({ ...p, versionCodes: ['1'] }).ok, true);
  assert.equal(canCheck({ ...p, versionCodes: ['1'], track: ' ' }).ok, false);
  assert.equal(canCheck({ ...p, versionCodes: ['1'], userFraction: 2 }).ok, false);
});

test('local checks use the track read and the languages that have a listing', () => {
  const p = proposalOf({ source: 'store', track: 'production', codes: ['200'], fraction: 0.1, view: null, editable });
  const codes = localChecks(p, contextOf(editable, ['en-US', 'fr-FR'])).map((c) => c.code);
  assert.deepEqual(codes, ['code_already_live', 'notes_missing']);
});

test('the words: no errors never says there are no warnings, and says the Play Console may still show some', () => {
  const answer: PlayCheckAnswer = {
    store: 'googleplay',
    track: 'production',
    versionCodes: ['241'],
    status: 'inProgress',
    userFraction: 0.1,
    outcome: 'no_errors',
    findings: [],
    committed: false,
    checkedAt: 0,
    note: '',
  };
  const ok = outcomeView(answer);
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.title, 'Google found no errors');
  const text = [ok.title, ...ok.lines].join(' ');
  assert.match(text, /Play Console may still show warnings/);
  assert.match(text, /Nothing was saved or released/);
  assert.doesNotMatch(text, /no warnings/i);
  assert.match(NO_ERRORS_SENTENCE, /Play Console may still show warnings/);
  const bad = outcomeView({ ...answer, outcome: 'errors', findings: [{ stage: 'validate', message: 'Nope.' }] });
  assert.equal(bad.tone, 'bad');
  assert.equal(bad.title, 'Google reported an error');
  assert.deepEqual(bad.findings, ['Nope.']);
  assert.equal(
    outcomeView({ ...answer, outcome: 'errors', findings: [{ stage: 'stage', message: 'a' }, { stage: 'validate', message: 'b' }] }).title,
    'Google reported 2 errors',
  );
  assert.equal(checkedLine(answer), 'Checked as a rollout to 10% in production, version code 241.');
  assert.match(checkedLine({ ...answer, status: 'draft', userFraction: null }), /as a draft/);
  assert.match(checkedLine({ ...answer, status: 'completed', userFraction: 1, versionCodes: ['1', '2'] }), /for everybody \(100%\).*codes 1, 2/);
});

test('the state is explained: draft, rollout, everybody', () => {
  const base = proposalOf({ source: 'store', track: 'production', codes: ['241'], fraction: null, view: null, editable });
  assert.match(stateLine(base), /goes to nobody/);
  assert.match(stateLine({ ...base, userFraction: 0.1 }), /Rolling out to 10%/);
  assert.match(stateLine({ ...base, userFraction: 1 }), /everybody/);
  assert.equal(fractionOf(''), null);
  assert.equal(fractionOf('0.1'), 0.1);
  assert.equal(fractionOf('x'), null);
});
