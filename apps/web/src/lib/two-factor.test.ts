import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passkeyOnlyButUnsupported, primaryFactor, stepUpNeed } from './step-up.ts';
import {
  codeComplete,
  codeDigits,
  defaultSmtpPort,
  firstMethod,
  groupSecret,
  isLoginChallenge,
  LOGIN_MODES,
  loginModeSummary,
  METHOD_LABELS,
  mailFailureMessage,
  mailHintMessage,
  mailTestSummary,
  resendIn,
  smtpProblem,
  smtpSourceLabel,
  twoFactorMessage,
  twoFactorProblem,
  twoFactorSummary,
} from './two-factor.ts';

test('a code field keeps digits only, and a pasted code with spaces is complete', () => {
  assert.equal(codeDigits('123 456'), '123456');
  assert.equal(codeDigits('12a3-4567890'), '123456', 'at most six');
  assert.equal(codeComplete('123456'), true);
  assert.equal(codeComplete('123 456'), true);
  assert.equal(codeComplete('123-456'), true);
  assert.equal(codeComplete('12345'), false);
  assert.equal(codeComplete('1234567'), false);
  assert.equal(codeComplete('abcdef'), false);
});

test('the secret is shown in groups of four', () => {
  assert.equal(groupSecret('JBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP');
  assert.equal(groupSecret('ABCDEF'), 'ABCD EF');
  assert.equal(groupSecret(''), '');
});

test('the login step offers the app first, then email, then a recovery code', () => {
  assert.equal(firstMethod(['recovery', 'email', 'totp']), 'totp');
  assert.equal(firstMethod(['recovery', 'email']), 'email');
  assert.equal(firstMethod(['recovery']), 'recovery');
  assert.equal(firstMethod([]), undefined);
  for (const m of ['totp', 'email', 'recovery'] as const) assert.ok(METHOD_LABELS[m]);
});

test('a login challenge is recognised by its flag and token only', () => {
  assert.equal(
    isLoginChallenge({
      twoFactorRequired: true,
      enrollmentRequired: false,
      challenge: 'lgc_x',
      methods: ['totp'],
    }),
    true,
  );
  assert.equal(isLoginChallenge({ user: { id: 'u1' } }), false);
  assert.equal(isLoginChallenge({ twoFactorRequired: true }), false);
  assert.equal(isLoginChallenge(null), false);
  assert.equal(isLoginChallenge('x'), false);
});

test('summaries name what is on', () => {
  assert.equal(
    twoFactorSummary({ totp: { state: 'none', confirmedAt: null }, email: null }),
    'Not set up',
  );
  assert.equal(
    twoFactorSummary({ totp: { state: 'pending', confirmedAt: null }, email: null }),
    'Not set up',
    'a pending app is not on yet',
  );
  assert.equal(
    twoFactorSummary({ totp: { state: 'active', confirmedAt: 1 }, email: null }),
    'On: authenticator app',
  );
  assert.equal(
    twoFactorSummary({
      totp: { state: 'active', confirmedAt: 1 },
      email: { address: 'a@b.c', verified: true, verifiedAt: 1, usable: true },
    }),
    'On: authenticator app and email',
  );
  assert.equal(
    twoFactorSummary({
      totp: { state: 'none', confirmedAt: null },
      email: { address: 'a@b.c', verified: false, verifiedAt: null, usable: true },
    }),
    'Not set up',
  );
  assert.deepEqual(
    LOGIN_MODES.map((m) => m.value),
    ['off', 'optional', 'admins', 'all'],
  );
  assert.equal(loginModeSummary('admins'), 'Required for owners and admins');
  assert.equal(loginModeSummary('off'), 'Off');
});

test('the resend countdown never goes below zero', () => {
  assert.equal(resendIn(1000, 60, 1000), 60);
  assert.equal(resendIn(1000, 60, 1000 + 59_500), 1);
  assert.equal(resendIn(1000, 60, 1000 + 60_000), 0);
  assert.equal(resendIn(1000, 60, 1000 + 600_000), 0);
});

test('every fixed code has a plain sentence, and a rate limit says how long', () => {
  for (const code of [
    'invalid_code',
    'code_expired',
    'invalid_second_factor',
    'challenge_invalid',
    'wrong_challenge',
    'rate_limited',
    'busy',
    'mail_not_configured',
    'mail_failed',
    'already_enrolled',
    'already_verified',
    'not_started',
    'email_required',
    'invalid_email',
    'two_factor_not_enrolled',
    'single_user_mode',
    'smtp_locked',
    'password_required',
    'address_not_allowed',
  ]) {
    assert.ok(twoFactorMessage(code), code);
  }
  assert.equal(twoFactorMessage('nope'), undefined);
  assert.match(twoFactorMessage('rate_limited', 30) ?? '', /30 seconds/);
  assert.match(twoFactorMessage('rate_limited', 150) ?? '', /3 minutes/);
});

test('a mail failure shows the sentence for its code, plus its hint; nothing from a mail server', () => {
  for (const code of [
    'smtp_not_configured',
    'smtp_connection_failed',
    'smtp_auth_failed',
    'smtp_tls_failed',
    'smtp_rejected',
    'smtp_timeout',
  ]) {
    assert.notEqual(mailFailureMessage(code), mailFailureMessage('something_else'), code);
  }
  assert.equal(mailFailureMessage('weird'), 'The message could not be sent.');
  const problem = twoFactorProblem({
    code: 'mail_failed',
    message: '550 5.1.1 secret@internal',
    body: { code: 'smtp_tls_failed', hint: 'certificate_rejected' },
  });
  assert.match(problem, /secure connection/);
  assert.match(problem, /certificate/);
  assert.doesNotMatch(problem, /550|internal/);
  assert.match(
    twoFactorProblem({
      code: 'address_not_allowed',
      message: 'x',
      body: { hint: 'private_address_blocked' },
    }),
    /MRM_SMTP_ALLOW_PRIVATE_HOSTS/,
  );
  assert.equal(
    twoFactorProblem({
      code: 'too_many_attempts',
      message: 'm',
      body: { message: 'Ask for a new code.' },
    }),
    'Ask for a new code.',
  );
  assert.equal(twoFactorProblem({ code: 'x', message: 'Plain sentence.' }), 'Plain sentence.');
  assert.equal(twoFactorProblem(null), 'Something went wrong. Try again.');
  assert.equal(mailHintMessage(undefined), undefined);
  assert.equal(mailHintMessage('unknown'), undefined);
});

test('the test email result reads as one sentence or two', () => {
  assert.match(mailTestSummary({ ok: true, to: 'me@example.com' }), /me@example\.com/);
  assert.match(mailTestSummary({ ok: false, code: 'smtp_auth_failed' }), /user name or password/);
  assert.match(
    mailTestSummary({ ok: false, code: 'smtp_tls_failed', hint: 'starttls_not_offered' }),
    /STARTTLS/,
  );
});

test('the mail form is checked before it is sent', () => {
  const good = { host: 'smtp.example.com', port: '587', from: 'mrm@example.com' };
  assert.equal(smtpProblem(good), '');
  assert.equal(smtpProblem({ ...good, from: 'Kiln <mrm@example.com>' }), '');
  assert.equal(
    smtpProblem({ ...good, port: '' }),
    '',
    'an empty port means the default for the security setting',
  );
  assert.match(smtpProblem({ ...good, host: '' }), /host name/);
  assert.match(smtpProblem({ ...good, host: 'smtp://smtp.example.com' }), /without smtp:\/\//);
  assert.match(smtpProblem({ ...good, host: 'smtp.example.com:587' }), /without smtp:\/\//);
  assert.equal(smtpProblem({ ...good, host: '::1' }), '', 'an IPv6 address is a host');
  assert.match(smtpProblem({ ...good, port: '70000' }), /1 to 65535/);
  assert.match(smtpProblem({ ...good, port: '25a' }), /1 to 65535/);
  assert.match(smtpProblem({ ...good, from: 'nobody' }), /sender address/);
  assert.equal(defaultSmtpPort('tls'), 465);
  assert.equal(defaultSmtpPort('starttls'), 587);
  assert.equal(defaultSmtpPort('none'), 25);
  assert.match(smtpSourceLabel('env'), /read only/);
  assert.equal(smtpSourceLabel('none'), 'Not set up');
});

test('the confirmation dialog offers the authenticator and email ways', () => {
  assert.equal(primaryFactor(['totp', 'email'], true), 'totp');
  assert.equal(primaryFactor(['email'], false), 'email');
  assert.equal(primaryFactor(['passkey', 'totp'], true), 'passkey');
  assert.equal(primaryFactor(['passkey', 'totp'], false), 'totp');
  assert.equal(primaryFactor(['password', 'totp'], false), 'password');
  assert.equal(
    passkeyOnlyButUnsupported(['passkey', 'totp'], false),
    false,
    'a code is a way out of a passkey-only window',
  );
  assert.equal(passkeyOnlyButUnsupported(['passkey', 'email'], false), false);
  assert.equal(passkeyOnlyButUnsupported(['passkey'], false), true);
  const need = stepUpNeed({
    status: 403,
    code: 'step_up_required',
    body: {
      error: 'step_up_required',
      action: 'store.release',
      factors: ['totp', 'email', 'bogus'],
      reason: 'missing',
    },
  });
  assert.deepEqual(need?.factors, ['totp', 'email']);
});
