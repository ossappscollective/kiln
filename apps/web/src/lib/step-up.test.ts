import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertionToServer,
  attestationToServer,
  base64urlToBytes,
  bytesToBase64url,
  creationOptionsFromServer,
  DEFAULT_COVERED,
  formatRecoveryCode,
  passkeyOnlyButUnsupported,
  primaryFactor,
  RECOVERY_CODE_HINT,
  recoveryCodeComplete,
  recoveryCodesText,
  recoveryFailureMessage,
  recoverySummary,
  recoverySymbols,
  requestOptionsFromServer,
  STEP_UP_ACTIONS,
  securitySummary,
  stepUpMessage,
  stepUpNeed,
  toggleAction,
  webauthnFailureMessage,
  webauthnSupported,
  withStepUp,
} from './step-up.ts';

const required = (extra: Record<string, unknown> = {}) => ({
  status: 403,
  code: 'step_up_required',
  body: {
    error: 'step_up_required',
    action: 'store.release',
    target: 'app-1',
    factors: ['passkey', 'password'],
    reason: 'missing',
    ...extra,
  },
});

test('stepUpNeed reads only step_up_required, with action, target and factors', () => {
  const need = stepUpNeed(required(), 'abc');
  assert.deepEqual(need, {
    action: 'store.release',
    target: { id: 'app-1', hash: 'abc' },
    factors: ['passkey', 'password'],
    reason: 'missing',
  });
  assert.equal(stepUpNeed({ status: 403, code: 'forbidden', body: {} }), undefined);
  assert.equal(
    stepUpNeed({ status: 403, code: 'step_up_not_enrolled', body: {} }),
    undefined,
    'not enrolled is shown as an error, not a dialog',
  );
  assert.equal(stepUpNeed(new Error('x')), undefined);
  assert.equal(stepUpNeed(null), undefined);
});

test('withStepUp retries the same call once with the grant, and nothing else', async () => {
  const calls: (string | undefined)[] = [];
  const ok = await withStepUp(
    async (grant) => {
      calls.push(grant);
      if (!grant) throw required();
      return 'done';
    },
    async (need) => {
      assert.equal(need.target.hash, 'h1');
      return 'sug_1';
    },
    'h1',
  );
  assert.equal(ok, 'done');
  assert.deepEqual(calls, [undefined, 'sug_1']);

  // A second refusal is not asked about again.
  let asked = 0;
  await assert.rejects(
    withStepUp(
      async () => {
        throw required();
      },
      async () => {
        asked++;
        return 'sug_2';
      },
    ),
  );
  assert.equal(asked, 1);

  // Another error is never retried and never asks.
  let runs = 0;
  await assert.rejects(
    withStepUp(
      async () => {
        runs++;
        throw { status: 409, code: 'state_changed', body: {} };
      },
      async () => 'never',
    ),
  );
  assert.equal(runs, 1);

  // Cancelled: the original error goes up and nothing is retried.
  runs = 0;
  await assert.rejects(
    withStepUp(
      async () => {
        runs++;
        throw required();
      },
      async () => undefined,
    ),
  );
  assert.equal(runs, 1);
});

test('every fixed code has a plain sentence; lockout says how long', () => {
  for (const code of [
    'step_up_required',
    'step_up_required_human',
    'step_up_not_enrolled',
    'step_up_failed',
    'step_up_locked',
    'step_up_busy',
    'factor_not_enrolled',
    'webauthn_unavailable',
    'challenge_invalid',
    'passkey_rejected',
    'account_password_used',
  ]) {
    assert.ok(stepUpMessage(code), code);
  }
  assert.equal(stepUpMessage('nope'), undefined);
  assert.match(stepUpMessage('step_up_locked', 30) ?? '', /30 seconds/);
  assert.match(stepUpMessage('step_up_locked', 120) ?? '', /2 minutes/);
  assert.match(stepUpMessage('step_up_not_enrolled') ?? '', /Settings, Security/);
});

test('browser errors become fixed sentences, never the browser text', () => {
  assert.match(
    webauthnFailureMessage({ name: 'NotAllowedError', message: 'secret internals' }),
    /cancelled or timed out/,
  );
  assert.doesNotMatch(
    webauthnFailureMessage({ name: 'NotAllowedError', message: 'secret internals' }),
    /secret/,
  );
  assert.match(webauthnFailureMessage({ name: 'NotSupportedError' }), /password/);
  assert.match(webauthnFailureMessage(undefined), /Try again/);
});

test('base64url round trips, with and without padding needs', () => {
  for (const bytes of [
    [],
    [0],
    [251, 255, 254],
    [1, 2, 3, 4],
    Array.from({ length: 70 }, (_, i) => i * 3),
  ]) {
    const encoded = bytesToBase64url(new Uint8Array(bytes));
    assert.doesNotMatch(encoded, /[+/=]/);
    assert.deepEqual(Array.from(base64urlToBytes(encoded)), bytes);
  }
  assert.equal(bytesToBase64url(new Uint8Array([251, 255, 254]).buffer), '-__-');
});

test('server options become buffers; credentials go back as base64url', () => {
  const creation = creationOptionsFromServer({
    challenge: 'AQID',
    user: { id: 'BAUG', name: 'a' },
    excludeCredentials: [{ type: 'public-key', id: 'Bw' }],
    rp: { id: 'localhost' },
  }) as {
    challenge: Uint8Array;
    user: { id: Uint8Array; name: string };
    excludeCredentials: { id: Uint8Array }[];
  };
  assert.deepEqual(Array.from(creation.challenge), [1, 2, 3]);
  assert.deepEqual(Array.from(creation.user.id), [4, 5, 6]);
  assert.deepEqual(Array.from(creation.excludeCredentials[0]?.id ?? []), [7]);
  const request = requestOptionsFromServer({
    challenge: 'AQID',
    rpId: 'localhost',
    allowCredentials: [{ type: 'public-key', id: 'Bw' }],
  }) as { allowCredentials: { id: Uint8Array }[] };
  assert.deepEqual(Array.from(request.allowCredentials[0]?.id ?? []), [7]);
  const buf = (n: number[]) => new Uint8Array(n).buffer;
  assert.deepEqual(
    assertionToServer({
      id: 'x',
      rawId: buf([7]),
      response: { clientDataJSON: buf([1]), authenticatorData: buf([2]), signature: buf([3]) },
    }),
    { id: 'Bw', clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw' },
  );
  assert.deepEqual(
    attestationToServer({
      id: 'x',
      rawId: buf([7]),
      response: {
        clientDataJSON: buf([1]),
        attestationObject: buf([2]),
        getTransports: () => ['internal'],
      },
    }),
    { id: 'Bw', clientDataJSON: 'AQ', attestationObject: 'Ag', transports: ['internal'] },
  );
});

test('support detection and the factor to offer first', () => {
  const fn = () => undefined;
  const credentials = { get: fn, create: fn };
  assert.equal(
    webauthnSupported({
      isSecureContext: true,
      PublicKeyCredential: fn,
      navigator: { credentials },
    }),
    true,
  );
  assert.equal(
    webauthnSupported({
      isSecureContext: false,
      PublicKeyCredential: fn,
      navigator: { credentials },
    }),
    false,
  );
  assert.equal(
    webauthnSupported({ isSecureContext: true, navigator: { credentials } }),
    false,
    'no PublicKeyCredential (a web view)',
  );
  assert.equal(
    webauthnSupported({ isSecureContext: true, PublicKeyCredential: fn, navigator: {} }),
    false,
  );
  assert.equal(primaryFactor(['passkey', 'password'], true), 'passkey');
  assert.equal(primaryFactor(['passkey', 'password'], false), 'password');
  assert.equal(primaryFactor(['passkey'], false), undefined);
  assert.equal(primaryFactor([], true), undefined);
  assert.equal(passkeyOnlyButUnsupported(['passkey'], false), true);
  assert.equal(passkeyOnlyButUnsupported(['passkey', 'password'], false), false);
  assert.equal(passkeyOnlyButUnsupported(['passkey'], true), false);
});

test('the policy list: default, toggling keeps the order', () => {
  assert.equal(DEFAULT_COVERED.indexOf('store.push_draft'), -1);
  assert.equal(STEP_UP_ACTIONS.length, 9);
  assert.deepEqual(toggleAction(['rollout'], 'store.release', true), ['store.release', 'rollout']);
  assert.deepEqual(toggleAction(['store.release', 'rollout'], 'rollout', false), ['store.release']);
  assert.match(
    securitySummary({ policy: { mode: 'off', actions: [], unattended: [] }, enrolled: true }),
    /off/,
  );
  assert.match(
    securitySummary({
      policy: { mode: 'hard_actions', actions: [], unattended: [] },
      enrolled: false,
    }),
    /no way to confirm/,
  );
  assert.match(
    securitySummary({
      policy: { mode: 'hard_actions', actions: [], unattended: [] },
      enrolled: true,
    }),
    /passkey or a password/,
  );
});

test("the classes and defaults are the server's", async () => {
  const server = await import('../../../server/src/services/step-up.ts');
  assert.deepEqual([...STEP_UP_ACTIONS], [...server.stepUpActions]);
  assert.deepEqual([...DEFAULT_COVERED], [...server.defaultCoveredActions]);
});

// ---- Recovery codes ----

test('a need keeps recovery in the offered ways, and drops anything unknown', () => {
  const need = stepUpNeed({
    code: 'step_up_required',
    body: { action: 'rollout', factors: ['passkey', 'recovery', 'carrier-pigeon'] },
  });
  assert.deepEqual(need?.factors, ['passkey', 'recovery']);
});

test('recovery is never the first way offered while a real factor exists', () => {
  assert.equal(primaryFactor(['passkey', 'password', 'recovery'], true), 'passkey');
  assert.equal(primaryFactor(['password', 'recovery'], true), 'password');
  assert.equal(primaryFactor(['passkey', 'recovery'], false), undefined);
  assert.equal(passkeyOnlyButUnsupported(['passkey', 'recovery'], false), true);
});

test('a code is complete at 20 symbols, whatever the case, dashes or spaces', () => {
  assert.equal(recoveryCodeComplete('ABCDE-FGHJK-MNPQR-STVWX'), true);
  assert.equal(recoveryCodeComplete('abcde fghjk mnpqr stvwx'), true);
  assert.equal(recoveryCodeComplete('ABCDEFGHJKMNPQRSTVWX'), true);
  assert.equal(recoveryCodeComplete('ABCDE-FGHJK-MNPQR'), false);
  assert.equal(recoveryCodeComplete('ABCDE-FGHJK-MNPQR-STVWXY'), false);
  assert.equal(recoveryCodeComplete('ABCDE-FGHJK-MNPQR-STVW!'), false);
  assert.equal(recoveryCodeComplete(''), false);
  assert.equal(recoverySymbols(' ab-cd ef '), 'ABCDEF');
});

test('a code is shown in four groups of five; short text is left alone', () => {
  assert.equal(formatRecoveryCode('abcdefghjkmnpqrstvwx'), 'ABCDE-FGHJK-MNPQR-STVWX');
  assert.equal(formatRecoveryCode('abcde-fghjk'), 'abcde-fghjk');
});

test('a wrong recovery code gets its own sentence; other failures do not', () => {
  assert.match(
    recoveryFailureMessage({ code: 'step_up_failed', body: { reason: 'invalid_recovery_code' } }) ??
      '',
    /no longer works/,
  );
  assert.equal(
    recoveryFailureMessage({ code: 'step_up_failed', body: { reason: 'invalid_password' } }),
    undefined,
  );
  assert.equal(recoveryFailureMessage({ code: 'step_up_locked', body: {} }), undefined);
  assert.equal(recoveryFailureMessage(null), undefined);
  assert.match(RECOVERY_CODE_HINT, /works once/);
});

test('the card says what is left, and when to make a new set', () => {
  assert.match(recoverySummary(undefined), /No recovery codes yet/);
  assert.match(
    recoverySummary({ remaining: 0, total: 0, generatedAt: null }),
    /No recovery codes yet/,
  );
  assert.match(
    recoverySummary({ remaining: 0, total: 10, generatedAt: 1 }),
    /Every recovery code has been used/,
  );
  assert.equal(
    recoverySummary({ remaining: 7, total: 10, generatedAt: 1 }),
    '7 of 10 recovery codes left.',
  );
  assert.match(recoverySummary({ remaining: 2, total: 10, generatedAt: 1 }), /Make a new set soon/);
});

test('the downloadable text holds the codes, the day and a keep-offline note, nothing else', () => {
  const text = recoveryCodesText(
    ['AAAAA-AAAAA-AAAAA-AAAAA', 'BBBBB-BBBBB-BBBBB-BBBBB'],
    Date.UTC(2026, 10, 19, 12),
  );
  assert.match(text, /Made 2026-11-19/);
  assert.match(text, /AAAAA-AAAAA-AAAAA-AAAAA\nBBBBB-BBBBB-BBBBB-BBBBB/);
  assert.match(text, /Keep this file offline/);
  assert.ok(text.endsWith('\n'));
});
