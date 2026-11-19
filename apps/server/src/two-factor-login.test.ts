import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { createLoginLimiter } from './limiter.ts';
import { LOGIN_CHALLENGE_MAX_ATTEMPTS, LOGIN_CHALLENGE_TTL_MS, MAIL_RESEND_COOLDOWN_MS } from './services/two-factor.ts';
import { PASSWORD } from './testkit.ts';
import { STEP, boot } from './two-factor-test-helpers.ts';

// The second step of signing in (docs/adr/0021-two-factor-and-smtp.md): the policy security.twoFactor = off | optional | admins | all.

type T = Awaited<ReturnType<typeof boot>>;

const setMode = async (t: T, mode: string, cookie = t.owner) => t.send(cookie, 'PUT', '/two-factor/policy', { mode }, await t.manage(cookie));
const second = (t: T, challenge: string, method: string, code: string) => t.raw('POST', '/api/auth/login/two-factor', { challenge, method, code });
const noSession = (res: { headers: Headers }) => assert.equal(res.headers.get('set-cookie'), null, 'no session before the second factor');

dbTest('policy off (the default): signing in is exactly as before, even when a factor is enrolled', async (db) => {
  const t = await boot(db);
  await t.enrollTotp();
  const res = await t.login();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['user']);
  assert.match(res.headers.get('set-cookie') ?? '', /^mrm_session=/);
  assert.equal((await t.send(t.owner, 'GET', '/two-factor/status')).body.login.mode, 'off');
});

dbTest('setting the policy: a confirmation, and not before you have a factor yourself; owners and admins only', async (db) => {
  const t = await boot(db);
  const member = await t.addUser('member', 'bob@example.com');
  assert.equal((await t.send(member.session, 'PUT', '/two-factor/policy', { mode: 'optional' })).status, 403);
  assert.equal((await t.send(t.owner, 'PUT', '/two-factor/policy', { mode: 'optional' })).body.error, 'step_up_required');
  assert.equal((await setMode(t, 'optional')).status, 200);
  // Required for others while you have no way to pass it yourself would lock you out.
  const refused = await setMode(t, 'all');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'two_factor_not_enrolled');
  assert.equal((await t.send(t.owner, 'PUT', '/two-factor/policy', { mode: 'sometimes' }, await t.manage())).status, 400);
  await t.enrollTotp();
  const ok = await setMode(t, 'all');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, 'all');
  assert.equal(ok.body.membersWithoutSecondFactor, 1);
  assert.equal((await t.audits('two_factor.policy_changed')).length, 2);
  assert.match((await t.audits('two_factor.policy_changed'))[1] ?? '', /"from":"optional","to":"all"/);
});

dbTest('optional: a person with an authenticator app must use it after the password; no session starts before', async (db) => {
  const t = await boot(db);
  const secret = await t.enrollTotp();
  assert.equal((await setMode(t, 'optional')).status, 200);
  t.clock.now += STEP;
  const step1 = await t.login();
  assert.equal(step1.status, 200);
  noSession(step1);
  assert.equal(step1.body.twoFactorRequired, true);
  assert.equal(step1.body.enrollmentRequired, false);
  assert.deepEqual(step1.body.methods, ['totp']);
  assert.match(step1.body.challenge, /^lgc_/);
  assert.equal(step1.body.user, undefined, 'the user is not revealed before the second factor');
  assert.equal(step1.headers.get('cache-control'), 'no-store');
  // The challenge is stored only as a hash.
  assert.ok(!JSON.stringify(await db.query('SELECT * FROM login_challenges')).includes(step1.body.challenge));
  // Not a session: the challenge opens nothing else.
  assert.equal((await t.raw('GET', '/api/me', undefined, { cookie: `mrm_session=${step1.body.challenge}` })).status, 401);
  // A wrong code, then the right one.
  const bad = await second(t, step1.body.challenge, 'totp', '000000');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'invalid_second_factor');
  noSession(bad);
  const good = await second(t, step1.body.challenge, 'totp', t.code(secret));
  assert.equal(good.status, 200, good.text);
  const cookie = good.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.match(cookie, /^mrm_session=/);
  assert.equal(good.body.user.email, 'ada@example.com');
  assert.equal((await t.raw('GET', '/api/me', undefined, { cookie })).status, 200);
  // The challenge is spent.
  assert.equal((await second(t, step1.body.challenge, 'totp', t.code(secret))).body.error, 'challenge_invalid');
  assert.equal((await t.audits('auth.second_factor_verified')).length, 1);
  assert.equal((await t.audits('auth.second_factor_failed')).length, 1);
  assert.ok(!(await t.audits('auth.second_factor_failed')).join().includes('000000'));
  // The same code cannot be used for a second sign-in (replay), a fresh one can.
  const again = await t.login();
  assert.equal((await second(t, again.body.challenge, 'totp', t.code(secret))).status, 401);
  t.clock.now += STEP;
  assert.equal((await second(t, again.body.challenge, 'totp', t.code(secret))).status, 200);
});

dbTest('a wrong password still answers invalid_credentials and never reveals whether a second factor exists', async (db) => {
  const t = await boot(db);
  await t.enrollTotp();
  await setMode(t, 'optional');
  const res = await t.login('ada@example.com', 'wrong wrong wrong');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
  assert.equal((await t.login('nobody@example.com', PASSWORD)).body.error, 'invalid_credentials');
});

dbTest('five wrong second factors kill the challenge; a challenge expires after five minutes; signing in again replaces it', async (db) => {
  const t = await boot(db);
  const secret = await t.enrollTotp();
  await setMode(t, 'optional');
  const a = await t.login();
  for (let i = 0; i < LOGIN_CHALLENGE_MAX_ATTEMPTS; i++) assert.equal((await second(t, a.body.challenge, 'totp', '000000')).status, 401);
  const dead = await second(t, a.body.challenge, 'totp', t.code(secret));
  assert.equal(dead.status, 401);
  assert.equal(dead.body.error, 'challenge_invalid', 'the right code no longer works on a dead challenge');
  noSession(dead);
  // Expiry.
  const b = await t.login();
  t.clock.now += LOGIN_CHALLENGE_TTL_MS;
  assert.equal((await second(t, b.body.challenge, 'totp', t.code(secret))).body.error, 'challenge_invalid');
  // A newer sign-in replaces the older challenge.
  const c = await t.login();
  const d = await t.login();
  assert.equal((await second(t, c.body.challenge, 'totp', t.code(secret))).body.error, 'challenge_invalid');
  assert.equal((await second(t, d.body.challenge, 'totp', t.code(secret))).status, 200);
  assert.equal((await second(t, 'lgc_nope', 'totp', '123456')).body.error, 'challenge_invalid');
  assert.equal((await t.raw('POST', '/api/auth/login/two-factor', { challenge: 'x', method: 'sms', code: '1' })).status, 400);
});

dbTest('guesses at the second factor count against the per-email limiter too: a known password does not buy unlimited tries', async (db) => {
  const t = await boot(db, { limiter: createLoginLimiter({ max: 5 }) });
  const secret = await t.enrollTotp();
  await setMode(t, 'optional');
  // login attempt 1 (kept: no reset while a second factor is pending), then four wrong guesses = 5 counted, the next is refused.
  const a = await t.login();
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await second(t, a.body.challenge, 'totp', '000000')).status;
  assert.equal(last, 429);
  const blocked = await t.login();
  assert.equal(blocked.status, 429, 'and so is signing in again');
  assert.ok(secret);
});

dbTest('a recovery code is the fallback when the phone is gone; it works once', async (db) => {
  const t = await boot(db);
  await t.enrollTotp();
  const made = await t.send(t.owner, 'POST', '/step-up/recovery-codes', undefined, await t.manage());
  assert.equal(made.status, 201);
  const codes = made.body.codes as string[];
  await setMode(t, 'optional');
  const a = await t.login();
  assert.deepEqual(a.body.methods, ['totp', 'recovery']);
  assert.equal((await second(t, a.body.challenge, 'recovery', 'AAAAA-AAAAA-AAAAA-AAAAA')).status, 401);
  const ok = await second(t, a.body.challenge, 'recovery', codes[0] ?? '');
  assert.equal(ok.status, 200, ok.text);
  const b = await t.login();
  assert.equal((await second(t, b.body.challenge, 'recovery', codes[0] ?? '')).status, 401, 'spent');
  assert.equal((await second(t, b.body.challenge, 'recovery', codes[1] ?? '')).status, 200);
});

dbTest('an emailed code is a second factor at sign-in: bound to that sign-in, once, 10 minutes', async (db) => {
  const t = await boot(db);
  await t.verifyEmail();
  assert.equal((await t.send(t.owner, 'PUT', '/two-factor/policy', { mode: 'optional' }, await t.manage())).status, 200);
  const a = await t.login();
  assert.deepEqual(a.body.methods, ['email']);
  assert.equal(t.mailer.sent.length, 1, 'signing in alone sends nothing');
  t.mailer.clear();
  const sent = await t.raw('POST', '/api/auth/login/two-factor/email-code', { challenge: a.body.challenge });
  assert.equal(sent.status, 202);
  assert.deepEqual(t.mailer.last()?.to, ['ada@example.com']);
  const code = t.mailer.lastCode() ?? '';
  // Another sign-in cannot use it.
  const b = await t.login();
  assert.equal((await second(t, b.body.challenge, 'email', code)).status, 401);
  // The first challenge was replaced by the second sign-in: ask again on the new one.
  t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
  assert.equal((await t.raw('POST', '/api/auth/login/two-factor/email-code', { challenge: b.body.challenge })).status, 202);
  const code2 = t.mailer.lastCode() ?? '';
  const ok = await second(t, b.body.challenge, 'email', code2);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(!t.texts.join('\n').includes(code2));
  // Mail not set up: the email method is not offered.
  t.mailer.isConfigured = false;
  assert.deepEqual((await t.login()).body.methods, []);
});

dbTest('admins: owners and admins must have a factor, members need not; a person with a factor is never offered enrolment', async (db) => {
  const t = await boot(db);
  const member = await t.addUser('member', 'bob@example.com');
  const admin = await t.addUser('admin', 'cy@example.com');
  await t.enrollTotp();
  assert.equal((await setMode(t, 'admins')).status, 200);
  // A member with no factor signs in as before.
  const m = await t.login('bob@example.com');
  assert.equal(m.status, 200);
  assert.deepEqual(Object.keys(m.body), ['user']);
  // An admin with none must set one up first.
  const a = await t.login('cy@example.com');
  assert.equal(a.body.twoFactorRequired, true);
  assert.equal(a.body.enrollmentRequired, true);
  assert.deepEqual(a.body.methods, ['totp', 'email']);
  noSession(a);
  // The challenge for enrolment cannot be used as a second-factor challenge, and the other way round.
  assert.equal((await second(t, a.body.challenge, 'totp', '123456')).status, 409);
  const begun = await t.raw('POST', '/api/auth/login/enroll/totp', { challenge: a.body.challenge });
  assert.equal(begun.status, 201);
  assert.match(begun.body.uri, /^otpauth:\/\/totp\/Mobile%20Release%20Manager:cy%40example\.com\?secret=/);
  const wrong = await t.raw('POST', '/api/auth/login/enroll/totp/confirm', { challenge: a.body.challenge, code: '000000' });
  assert.equal(wrong.status, 401);
  noSession(wrong);
  const done = await t.raw('POST', '/api/auth/login/enroll/totp/confirm', { challenge: a.body.challenge, code: t.code(begun.body.secret) });
  assert.equal(done.status, 200, done.text);
  assert.match(done.headers.get('set-cookie') ?? '', /^mrm_session=/);
  assert.equal((await t.audits('two_factor.enrolled_at_login')).length, 1);
  // Next time it is a second factor, not an enrolment.
  t.clock.now += STEP;
  const next = await t.login('cy@example.com');
  assert.equal(next.body.enrollmentRequired, false);
  assert.deepEqual(next.body.methods, ['totp']);
  // The enrolment endpoints refuse a verify-kind challenge: a stolen password cannot add a second factor to an account that has one.
  const sneaky = await t.raw('POST', '/api/auth/login/enroll/totp', { challenge: next.body.challenge });
  assert.equal(sneaky.status, 409);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM user_totp WHERE confirmed_at IS NOT NULL')).map((r) => Number(r.n))[0], 2);
  assert.ok(member && admin);
});

dbTest('all: everyone must have a factor; a member sets one up by email at sign-in when mail works, and only by app when it does not', async (db) => {
  const t = await boot(db);
  await t.addUser('member', 'bob@example.com');
  await t.enrollTotp();
  assert.equal((await setMode(t, 'all')).status, 200);
  const a = await t.login('bob@example.com');
  assert.equal(a.body.enrollmentRequired, true);
  const sent = await t.raw('POST', '/api/auth/login/enroll/email', { challenge: a.body.challenge });
  assert.equal(sent.status, 202, sent.text);
  assert.deepEqual(t.mailer.last()?.to, ['bob@example.com']);
  const wrong = await t.raw('POST', '/api/auth/login/enroll/email/confirm', { challenge: a.body.challenge, code: '000000' });
  assert.equal(wrong.status, 401);
  const done = await t.raw('POST', '/api/auth/login/enroll/email/confirm', { challenge: a.body.challenge, code: t.mailer.lastCode() });
  assert.equal(done.status, 200, done.text);
  assert.match(done.headers.get('set-cookie') ?? '', /^mrm_session=/);
  // Mail not set up: only the app can be offered.
  await t.addUser('viewer', 'vi@example.com');
  t.mailer.isConfigured = false;
  const v = await t.login('vi@example.com');
  assert.deepEqual(v.body.methods, ['totp']);
  const noMail = await t.raw('POST', '/api/auth/login/enroll/email', { challenge: v.body.challenge });
  assert.equal(noMail.status, 409);
  assert.equal(noMail.body.error, 'mail_not_configured');
});

dbTest('the second-factor routes are public like login but only answer for a live challenge, and leak nothing', async (db) => {
  const t = await boot(db);
  const res = await t.raw('POST', '/api/auth/login/two-factor/email-code', { challenge: 'lgc_unknown' });
  assert.equal(res.status, 401);
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'message']);
  const big = await t.raw('POST', '/api/auth/login/two-factor', { challenge: 'x'.repeat(5000), method: 'totp', code: '1' });
  assert.equal(big.status, 400);
});
