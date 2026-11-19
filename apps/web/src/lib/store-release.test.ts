import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  type ReleasePreview,
  type StoreReleaseConfig,
  type StoreReleaseState,
  canConfirmRelease,
  classifyReleaseFailure,
  mayConfirmAgain,
  parsePercent,
  percentFromFraction,
  percentText,
  releaseBody,
  releaseLine,
  shouldReloadState,
} from './store-release.ts';

const config = (enabled: boolean): StoreReleaseConfig => ({ enabled, envName: 'MRM_STORE_RELEASE_ENABLED', action: 'store.release', minimumRole: 'admin', irreversible: true, note: '' });
const state = (extra: Partial<StoreReleaseState> = {}): StoreReleaseState => ({
  enabled: true,
  inFlight: { release: false, push: false, submit: false },
  unknownOutcome: { release: false, push: false, submit: false },
  ...extra,
});
const line = (extra: Partial<Parameters<typeof releaseLine>[0]> = {}) =>
  releaseLine({ role: 'admin', platform: 'ios', state: state(), stateFailed: false, config: config(true), configFailed: false, fraction: null, ...extra });

test('the share is typed by the person and never implied', () => {
  assert.equal(parsePercent('10'), 0.1);
  assert.equal(parsePercent(' 10 % '), 0.1);
  assert.equal(parsePercent('2,5'), 0.025);
  assert.equal(parsePercent('100'), 1);
  for (const bad of ['', '0', '101', '-1', 'ten', '1.234', '0.001']) assert.equal(parsePercent(bad), null, bad);
  assert.equal(percentText(0.1), '10%');
  assert.equal(percentText(0.025), '2.5%');
  assert.equal(percentFromFraction('0.1'), '10');
  assert.equal(percentFromFraction('2'), '');
  assert.equal(percentFromFraction(null), '');
});

test('the release line: hidden below admin, off, waiting for a share on Android, ready', () => {
  assert.equal(line({ role: 'member' }).kind, 'hidden');
  assert.equal(line({ config: config(false) }).kind, 'off');
  assert.equal(line({ stateFailed: true }).kind, 'note');
  const wait = line({ config: null });
  assert.deepEqual([wait.kind, (wait as { disabled: boolean }).disabled], ['ready', true]);
  const android = line({ platform: 'android' });
  assert.equal((android as { disabled: boolean }).disabled, true);
  assert.match((android as { reason: string }).reason, /never filled in/);
  assert.equal((line({ platform: 'android', fraction: 0.1 }) as { disabled: boolean }).disabled, false);
  assert.equal((line() as { disabled: boolean }).disabled, false);
  const busy = line({ state: state({ inFlight: { release: false, push: true, submit: false } }) });
  assert.equal((busy as { disabled: boolean }).disabled, true);
  const unknown = line({ state: state({ unknownOutcome: { release: true, push: false, submit: false } }) });
  assert.equal((unknown as { button: string }).button, 'Check the store, then preview…');
});

test('the same request goes to the preview and to the release', () => {
  assert.deepEqual(releaseBody('ios', { version: '2.4.0', fraction: null }), { version: '2.4.0' });
  assert.deepEqual(releaseBody('ios', { fraction: 0.5, track: 'production' }), {});
  assert.deepEqual(releaseBody('android', { track: 'production', fraction: 0.1, versionCodes: ['240'], version: '2.4.0' }), { track: 'production', userFraction: 0.1, versionCodes: ['240'] });
  assert.deepEqual(releaseBody('android', { track: 'production', fraction: null }), { track: 'production' });
});

const preview = (extra: Partial<ReleasePreview> = {}): ReleasePreview =>
  ({
    app: { id: 'a', name: 'A', platform: 'android', store: 'googleplay' },
    request: {},
    version: null,
    build: null,
    phasedRelease: null,
    track: 'production',
    release: null,
    others: [],
    audience: { kind: 'percent', userFraction: 0.1, description: '10% of users' },
    irreversible: ['x'],
    releases: true,
    checks: { blocking: [], warnings: [], canRelease: true },
    confirmHash: 'h',
    confirmation: { phrase: 'release com.acme.app production 10%', instruction: '' },
    readAt: 1,
    ...extra,
  }) as ReleasePreview;

test('the typed phrase must be exactly the phrase of the preview, and nothing may block', () => {
  assert.equal(canConfirmRelease(preview(), 'release com.acme.app production 10%'), true);
  assert.equal(canConfirmRelease(preview(), '  release com.acme.app production 10%  '), true);
  assert.equal(canConfirmRelease(preview(), 'release com.acme.app production 50%'), false);
  assert.equal(canConfirmRelease(preview(), 'RELEASE com.acme.app production 10%'), false);
  assert.equal(canConfirmRelease(preview(), ''), false);
  assert.equal(canConfirmRelease(preview({ confirmHash: null, confirmation: null }), 'x'), false);
  assert.equal(canConfirmRelease(preview({ checks: { blocking: [{ code: 'x', severity: 'blocking', message: 'm' }], warnings: [], canRelease: false } }), 'release com.acme.app production 10%'), false);
});

const err = (code: string, body: Record<string, unknown> = {}, status = 409) => new ApiError(status, code, String(body.message ?? code), undefined, { error: code, ...body });

test('errors: nothing is released and the person is told what to do', () => {
  assert.equal(classifyReleaseFailure(err('store_release_disabled', {}, 409)).kind, 'disabled');
  assert.equal(classifyReleaseFailure(err('forbidden', {}, 403)).kind, 'forbidden');
  const mismatch = classifyReleaseFailure(err('confirmation_mismatch', { phrase: 'release x 1.0' }, 422));
  assert.match(mismatch.message, /Type exactly: release x 1\.0/);
  assert.equal(mayConfirmAgain(mismatch), true);
  const blocked = classifyReleaseFailure(err('blocked', { checks: [{ code: 'x', severity: 'blocking', message: 'no' }] }));
  assert.equal(blocked.kind === 'blocked' && blocked.checks.length, 1);
  const changed = classifyReleaseFailure(err('state_changed', { preview: preview() }));
  assert.equal(changed.kind === 'state_changed' && changed.next?.confirmHash, 'h');
  assert.equal(mayConfirmAgain(changed), false);
  assert.equal(shouldReloadState(changed), true);
});

test('an unknown outcome is never confirmed again, and a cut connection during the release is one', () => {
  const unknown = classifyReleaseFailure(err('outcome_unknown', { message: 'No answer.' }));
  assert.equal(unknown.kind, 'outcome_unknown');
  assert.match(unknown.message, /Do not release again yet/);
  assert.equal(mayConfirmAgain(unknown), false);
  const cut = classifyReleaseFailure(new ApiError(0, 'network', 'Cannot reach the server.'), 'release');
  assert.equal(cut.kind, 'outcome_unknown');
  const cutPreview = classifyReleaseFailure(new ApiError(0, 'network', 'Cannot reach the server.'), 'preview');
  assert.equal(cutPreview.kind, 'other');
  const failed = classifyReleaseFailure(err('write_failed', { outcome: 'not_applied', message: 'Refused.' }, 502));
  assert.equal(failed.kind, 'not_applied');
  assert.equal(mayConfirmAgain(failed), true);
  assert.equal(classifyReleaseFailure(err('write_failed', { outcome: 'unknown' }, 502)).kind, 'outcome_unknown');
  assert.equal(classifyReleaseFailure(err('push_outcome_unknown')).kind, 'other_unknown');
});
