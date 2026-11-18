import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  SUBMIT_ENV,
  type StoreSubmitConfig,
  type SubmitCheck,
  type SubmitPreview,
  type SubmitState,
  canConfirmSubmit,
  canSubmit,
  checkText,
  classifySubmitFailure,
  confirmationMatches,
  isSubmitPreview,
  localeLine,
  mayConfirmAgain,
  pushDetail,
  releaseStatement,
  resultText,
  shouldReloadState,
  submitBody,
  submitLine,
  trackLine,
  versionLine,
} from './store-submit.ts';

const HASH = 'a'.repeat(64);

const config = (over: Partial<StoreSubmitConfig> = {}): StoreSubmitConfig => ({
  enabled: true,
  envName: SUBMIT_ENV,
  action: 'store.submit',
  minimumRole: 'admin',
  irreversible: true,
  releases: false,
  note: 'n',
  ...over,
});

const state = (over: Partial<SubmitState> = {}): SubmitState => ({
  enabled: true,
  pushed: true,
  push: { pushedAt: 1000, pushedBy: 'Ana', versionString: '2.1', texts: 3, assetSets: 1 },
  inFlight: { submit: false, push: false },
  unknownOutcome: { submit: false, push: false },
  ...over,
});

const preview = (over: Partial<SubmitPreview> = {}): SubmitPreview => ({
  app: { id: 'a1', name: 'Acme', platform: 'ios', store: 'app_store' },
  version: { id: 'v1', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION', releaseType: 'MANUAL' },
  build: { id: 'b1', version: '77', processingState: 'VALID', expired: false },
  contents: { locales: [], pushed: null, includesChangesNotPushedHere: false },
  tracks: [],
  irreversible: ['x'],
  submits: true,
  releases: false,
  checks: { blocking: [], warnings: [], canSubmit: true },
  confirmHash: HASH,
  confirmation: { phrase: 'submit com.acme.app 2.1', instruction: 'Type it.' },
  readAt: 5,
  ...over,
});

const err = (status: number, code: string, body: Record<string, unknown> = {}, retryAfter?: number) =>
  new ApiError(status, code, `msg ${code}`, retryAfter, { message: `msg ${code}`, ...body });

const base = { role: 'admin' as const, state: state(), stateFailed: false, config: config(), configFailed: false };

test('only admin and owner may submit; a member and a viewer see nothing', () => {
  assert.equal(canSubmit('owner'), true);
  assert.equal(canSubmit('admin'), true);
  assert.equal(canSubmit('member'), false);
  assert.equal(canSubmit('viewer'), false);
  assert.deepEqual(submitLine({ ...base, role: 'member' }), { kind: 'hidden' });
  assert.deepEqual(submitLine({ ...base, role: 'viewer' }), { kind: 'hidden' });
});

test('the line is hidden until a draft push is recorded', () => {
  assert.deepEqual(submitLine({ ...base, state: null }), { kind: 'hidden' });
  assert.deepEqual(submitLine({ ...base, state: state({ pushed: false, push: null }) }), { kind: 'hidden' });
});

test('a failed read of the state is a muted line with a retry, a failed switch read keeps the text without a button', () => {
  const failed = submitLine({ ...base, state: null, stateFailed: true });
  assert.equal(failed.kind, 'note');
  assert.equal(failed.kind === 'note' && failed.retry, true);
  const noConfig = submitLine({ ...base, config: null, configFailed: true });
  assert.equal(noConfig.kind, 'note');
});

test('ready: the button only when the switch is on', () => {
  const line = submitLine(base);
  assert.deepEqual(line, { kind: 'ready', text: 'Draft pushed — ready to submit?', button: 'Submit for review…', disabled: false, reason: null });
  const loading = submitLine({ ...base, config: null });
  assert.equal(loading.kind === 'ready' && loading.disabled, true);
});

test('switched off: one line and a note that names the variable, no button', () => {
  const line = submitLine({ ...base, config: config({ enabled: false }) });
  assert.equal(line.kind, 'off');
  assert.ok(line.kind === 'off' && line.note.includes('MRM_STORE_SUBMIT_ENABLED'));
  assert.ok(line.kind === 'off' && line.note.includes('=true'));
  // A blank name from the server falls back to the documented one.
  const blank = submitLine({ ...base, config: config({ enabled: false, envName: '' }) });
  assert.ok(blank.kind === 'off' && blank.note.includes(SUBMIT_ENV));
});

test('a submit or a push in flight disables the button; an unknown outcome asks for a new preview', () => {
  const running = submitLine({ ...base, state: state({ inFlight: { submit: true, push: false } }) });
  assert.equal(running.kind === 'ready' && running.disabled, true);
  const unknown = submitLine({ ...base, state: state({ unknownOutcome: { submit: true, push: false } }) });
  assert.ok(unknown.kind === 'ready' && unknown.text === 'Last submit: outcome unknown' && unknown.button.includes('preview'));
  // An unknown outcome shows the line even when the push record is gone.
  assert.equal(submitLine({ ...base, state: state({ pushed: false, push: null, unknownOutcome: { submit: true, push: false } }) }).kind, 'ready');
});

test('the push detail', () => {
  assert.equal(pushDetail(null, () => 'x'), '');
  assert.equal(pushDetail(state().push, () => '2 hours ago'), '2.1 · pushed 2 hours ago by Ana');
});

test('the typed phrase: exact, case-sensitive, surrounding spaces ignored', () => {
  assert.equal(confirmationMatches('submit com.acme.app 2.1', 'submit com.acme.app 2.1'), true);
  assert.equal(confirmationMatches('  submit com.acme.app 2.1  ', 'submit com.acme.app 2.1'), true);
  assert.equal(confirmationMatches('Submit com.acme.app 2.1', 'submit com.acme.app 2.1'), false);
  assert.equal(confirmationMatches('submit com.acme.app', 'submit com.acme.app 2.1'), false);
  assert.equal(confirmationMatches('', ''), false);
  assert.equal(confirmationMatches('x', null), false);
});

test('the confirm button needs no blocking item, a hash, a phrase and the typed phrase', () => {
  assert.equal(canConfirmSubmit(preview(), 'submit com.acme.app 2.1'), true);
  assert.equal(canConfirmSubmit(preview(), 'submit'), false);
  const warning: SubmitCheck = { code: 'open_review_submission', severity: 'warning', message: 'w' };
  assert.equal(canConfirmSubmit(preview({ checks: { blocking: [], warnings: [warning], canSubmit: true } }), 'submit com.acme.app 2.1'), true, 'a warning does not block');
  const blocker: SubmitCheck = { code: 'no_build', severity: 'blocking', message: 'b' };
  assert.equal(canConfirmSubmit(preview({ checks: { blocking: [blocker], warnings: [], canSubmit: false } }), 'submit com.acme.app 2.1'), false);
  assert.equal(canConfirmSubmit(preview({ confirmHash: null, confirmation: null }), 'submit com.acme.app 2.1'), false);
  assert.equal(canConfirmSubmit(preview({ checks: { blocking: [], warnings: [], canSubmit: false } }), 'submit com.acme.app 2.1'), false);
});

test('the request carries the hash and the typed text; nothing without a hash', () => {
  assert.deepEqual(submitBody(preview(), 'submit com.acme.app 2.1'), { confirmHash: HASH, confirmation: 'submit com.acme.app 2.1' });
  assert.equal(submitBody(preview({ confirmHash: null }), 'x'), null);
});

test('preview wording', () => {
  assert.equal(versionLine(preview()), 'Version 2.1 (PREPARE_FOR_SUBMISSION), release type MANUAL');
  assert.equal(versionLine({ app: { ...preview().app, platform: 'android' }, version: null }), 'The changes held back in Google Play');
  assert.equal(
    localeLine({ locale: 'en-US', textFields: 5, screenshotSets: [{ target: 'iphone', device: null, images: 3 }, { target: 'ipad', device: null, images: 1 }] }),
    'en-US: 5 text fields, 2 screenshot sets (4 images)',
  );
  assert.equal(localeLine({ locale: 'de', textFields: 1, screenshotSets: [] }), 'de: 1 text field, no screenshots');
  assert.equal(
    trackLine({ track: 'production', releases: [{ name: '2.0', status: 'inProgress', userFraction: 0.1, versionCodes: [20] }] }),
    'production: 2.0, inProgress, 10% of users, version code 20',
  );
  assert.equal(trackLine({ track: 'beta', releases: [] }), 'beta: no release');
  assert.equal(checkText({ code: 'missing_text', severity: 'blocking', message: 'Empty', locale: 'de', item: 'title' }), 'Empty (de / title)');
  assert.ok(releaseStatement('ios').includes('does not release'));
  assert.ok(releaseStatement('android').includes('does not publish'));
});

test('the preview shape guard', () => {
  assert.equal(isSubmitPreview(preview()), true);
  assert.equal(isSubmitPreview({}), false);
  assert.equal(isSubmitPreview(null), false);
});

test('every error code of the submit gets a sentence and a kind', () => {
  assert.equal(classifySubmitFailure(err(409, 'store_submit_disabled')).kind, 'disabled');
  assert.ok(classifySubmitFailure(err(409, 'store_submit_disabled')).message.includes(SUBMIT_ENV));
  assert.equal(classifySubmitFailure(err(403, 'forbidden')).kind, 'forbidden');
  assert.equal(classifySubmitFailure(err(409, 'nothing_pushed')).kind, 'nothing_pushed');
  const mismatch = classifySubmitFailure(err(422, 'confirmation_mismatch', { phrase: 'submit a 1' }));
  assert.ok(mismatch.kind === 'mismatch' && mismatch.message.includes('submit a 1'));
  const blocked = classifySubmitFailure(err(409, 'blocked', { checks: [{ code: 'no_build', severity: 'blocking', message: 'No build' }] }));
  assert.ok(blocked.kind === 'blocked' && blocked.checks.length === 1);
  assert.equal(classifySubmitFailure(err(409, 'write_in_progress')).kind, 'write_in_progress');
  assert.equal(classifySubmitFailure(err(409, 'push_outcome_unknown')).kind, 'push_unknown');
  assert.equal(classifySubmitFailure(err(409, 'outcome_unknown')).kind, 'outcome_unknown');
  assert.equal(classifySubmitFailure(err(502, 'write_failed', { outcome: 'not_applied' })).kind, 'not_applied');
  assert.equal(classifySubmitFailure(err(502, 'write_failed')).kind, 'outcome_unknown', 'no outcome stated: treated as unknown');
  assert.equal(classifySubmitFailure(err(409, 'changes_in_review')).kind, 'other');
  const limited = classifySubmitFailure(err(429, 'rate_limited', {}, 30));
  assert.ok(limited.kind === 'rate_limited' && limited.retryAfter === 30 && limited.message.includes('never retries'));
  for (const code of ['no_editable_version', 'store_auth', 'store_forbidden', 'store_not_found', 'store_rejected', 'store_unavailable', 'timeout', 'app_not_synced', 'credential_unreadable']) {
    assert.equal(classifySubmitFailure(err(422, code)).kind, 'other', code);
  }
});

test('state_changed brings the new preview, or a sentence to preview again', () => {
  const next = preview({ confirmHash: 'b'.repeat(64) });
  const changed = classifySubmitFailure(err(409, 'state_changed', { preview: next }));
  assert.ok(changed.kind === 'state_changed' && changed.next?.confirmHash === 'b'.repeat(64));
  const without = classifySubmitFailure(err(409, 'state_changed', { preview: { junk: true } }));
  assert.ok(without.kind === 'state_changed' && without.next === null);
});

test('a cut connection or a 5xx during the submit is an unknown outcome; during a preview it is just an error', () => {
  assert.equal(classifySubmitFailure(new ApiError(0, 'network', 'Cannot reach the server.')).kind, 'outcome_unknown');
  assert.equal(classifySubmitFailure(new ApiError(500, 'error', 'boom')).kind, 'outcome_unknown');
  assert.equal(classifySubmitFailure(new ApiError(0, 'network', 'x'), 'preview').kind, 'other');
  assert.equal(classifySubmitFailure(new Error('x')).kind, 'other');
  assert.ok(classifySubmitFailure(err(409, 'outcome_unknown')).message.includes('Do not submit again'));
});

test('only a failure that sent nothing may be confirmed again, never an unknown outcome', () => {
  const kinds: [string, boolean][] = [
    ['confirmation_mismatch', true],
    ['write_in_progress', true],
    ['outcome_unknown', false],
    ['store_unavailable', false],
    ['rate_limited', false],
    ['blocked', false],
  ];
  for (const [code, again] of kinds) assert.equal(mayConfirmAgain(classifySubmitFailure(err(409, code))), again, code);
  assert.equal(mayConfirmAgain(classifySubmitFailure(err(502, 'write_failed', { outcome: 'not_applied' }))), true);
  assert.equal(mayConfirmAgain(classifySubmitFailure(new ApiError(0, 'network', 'x'))), false);
});

test('which failures read the state again', () => {
  assert.equal(shouldReloadState(classifySubmitFailure(err(409, 'outcome_unknown'))), true);
  assert.equal(shouldReloadState(classifySubmitFailure(err(409, 'nothing_pushed'))), true);
  assert.equal(shouldReloadState(classifySubmitFailure(err(422, 'confirmation_mismatch'))), false);
});

test('the result always says nothing was released', () => {
  const text = resultText({
    app: { id: 'a', name: 'A', platform: 'ios', store: 'app_store' },
    version: { id: 'v', versionString: '2.1' },
    submission: null,
    via: 'review_submission',
    submitted: true,
    released: false,
    confirmedByReread: true,
    submittedAt: 1,
    note: '',
  });
  assert.ok(text.includes('App Review') && text.includes('2.1') && text.includes('reading it back') && text.endsWith('Nothing was released or published.'));
});
