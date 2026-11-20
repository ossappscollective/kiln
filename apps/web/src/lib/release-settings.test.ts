import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRST_RELEASE_MESSAGE, FRACTION_REFUSED_MESSAGE, NEVER_MESSAGE } from '@mrm/core';
import { ApiError } from './api.ts';
import { outcomeView, type PlayCheckAnswer } from './play-check.ts';
import { askedFractionOf, resultRow, type PublishPlan, type StepResult } from './pending.ts';
import { parseDefaultShare, releaseInputsFor, type ReleaseSettingsView } from './release-settings.ts';
import { classifyReleaseFailure } from './store-release.ts';

const view = (over: Partial<ReleaseSettingsView['settings']> = {}, earlier = true): ReleaseSettingsView => ({
  settings: { defaultSharePercent: null, stagedRollout: 'auto', ...over },
  earlierProductionRelease: earlier,
});

test('share start: no setting read means offered and nothing is hidden or invented', () => {
  const r = releaseInputsFor({ view: null, track: 'production', stagedPercent: '' });
  assert.equal(r.offer.offered, true);
  assert.equal(r.share, '');
});

test('share start: the default fills the input, a staged share wins, empty asks', () => {
  assert.equal(releaseInputsFor({ view: view({ defaultSharePercent: 20 }), track: 'production', stagedPercent: '' }).share, '20');
  assert.equal(releaseInputsFor({ view: view({ defaultSharePercent: 20 }), track: 'production', stagedPercent: '5' }).share, '5');
  assert.equal(releaseInputsFor({ view: view(), track: 'production', stagedPercent: '' }).share, '');
});

test('first release in production: no staged rollout, 100%, with the plain sentence', () => {
  const r = releaseInputsFor({ view: view({ defaultSharePercent: 20 }, false), track: 'production', stagedPercent: '5' });
  assert.equal(r.offer.offered, false);
  assert.equal(r.share, '100');
  assert.equal(r.offer.message, FIRST_RELEASE_MESSAGE);
  assert.match(FIRST_RELEASE_MESSAGE, /first release in production: Google Play does not offer a staged rollout for it/);
  // Another track has no such rule.
  assert.equal(releaseInputsFor({ view: view({}, false), track: 'beta', stagedPercent: '' }).offer.offered, true);
});

test('mode matrix: auto, always ask and never', () => {
  const of = (mode: 'auto' | 'always_ask' | 'never', earlier: boolean) =>
    releaseInputsFor({ view: view({ stagedRollout: mode }, earlier), track: 'production', stagedPercent: '' }).offer;
  assert.equal(of('auto', true).offered, true);
  assert.equal(of('auto', false).offered, false);
  assert.equal(of('always_ask', false).offered, true);
  assert.equal(of('always_ask', true).offered, true);
  assert.equal(of('never', true).offered, false);
  assert.equal(of('never', true).message, NEVER_MESSAGE);
});

test('a typed default share: 1 to 100, whole, empty clears', () => {
  assert.deepEqual(parseDefaultShare(''), { ok: true, value: null });
  assert.deepEqual(parseDefaultShare(' 10% '), { ok: true, value: 10 });
  assert.deepEqual(parseDefaultShare('100'), { ok: true, value: 100 });
  for (const bad of ['0', '101', '2.5', 'x', '-1']) assert.deepEqual(parseDefaultShare(bad), { ok: false }, bad);
});

const refusal = (code: string, message: string) => new ApiError(422, code, message, undefined, { error: code, message });

test('a refused staged rollout is said in plain words, only for a share below 100%, and never retried', () => {
  const e = refusal('store_rejected', 'Invalid value for userFraction: a staged rollout is not allowed for this release.');
  assert.equal(classifyReleaseFailure(e, 'release', 0.1).message, FRACTION_REFUSED_MESSAGE);
  assert.equal(classifyReleaseFailure(e, 'preview', 0.1).message, FRACTION_REFUSED_MESSAGE);
  // At 100% or with no share the refusal is not about the share: the store's own words stay.
  assert.match(classifyReleaseFailure(e, 'release', 1).message, /The store refused the request/);
  assert.match(classifyReleaseFailure(e, 'release', null).message, /The store refused the request/);
  // An unknown outcome is never turned into "not accepted".
  const unknown = new ApiError(502, 'write_failed', 'userFraction', undefined, { error: 'write_failed', outcome: 'unknown', message: 'userFraction' });
  assert.notEqual(classifyReleaseFailure(unknown, 'release', 0.1).message, FRACTION_REFUSED_MESSAGE);
  assert.match(FRACTION_REFUSED_MESSAGE, /did not accept a staged rollout for this app/);
  assert.match(FRACTION_REFUSED_MESSAGE, /release to everyone/i);
  assert.match(FRACTION_REFUSED_MESSAGE, /Nothing was retried/);
});

test('a plan step that Google refused for the share says so; other refusals keep the store words', () => {
  const step: StepResult = { type: 'release', status: 'failed', error: 'store_rejected', httpStatus: 422, outcome: 'refused', message: 'The rollout fraction is not allowed.' };
  assert.match(resultRow(step, 0.1).text, /did not accept a staged rollout/);
  assert.match(resultRow(step, 1).text, /The store said: The rollout fraction/);
  assert.match(resultRow(step, null).text, /The store said/);
  const other: StepResult = { ...step, message: 'Version code 5 is too low.' };
  assert.match(resultRow(other, 0.1).text, /The store said: Version code 5/);
  assert.equal(askedFractionOf(null), null);
  const plan = { steps: [{ type: 'release', included: true, request: { type: 'release', userFraction: 0.25 } }] } as unknown as PublishPlan;
  assert.equal(askedFractionOf(plan), 0.25);
});

test('Check with Google Play: a finding about the rollout gets the plain notice', () => {
  const answer: PlayCheckAnswer = {
    outcome: 'errors',
    status: 'inProgress',
    track: 'production',
    versionCodes: ['241'],
    userFraction: 0.1,
    findings: [{ stage: 'validate', message: 'Staged rollout is not available for this app.' }],
  } as unknown as PlayCheckAnswer;
  assert.equal(outcomeView(answer).rolloutNotice, FRACTION_REFUSED_MESSAGE);
  assert.equal(outcomeView({ ...answer, userFraction: null }).rolloutNotice, null);
  assert.equal(outcomeView({ ...answer, findings: [{ stage: 'validate', message: 'Version code too low.' }] }).rolloutNotice, null);
});
