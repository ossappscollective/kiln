import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { migrate } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { createApp } from './app.ts';
import { createSession } from './services/accounts.ts';
import { createFakeMailer, type FakeMailer } from './services/mailer.ts';
import { LOCKOUT_AFTER, setPolicy } from './services/step-up.ts';
import { base32Decode, totpAt } from './services/totp.ts';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  MAIL_RESEND_COOLDOWN_MS,
  MAIL_USER_PER_HOUR,
  MAIL_WORKSPACE_PER_HOUR,
} from './services/two-factor.ts';
import { cheap } from './testkit.ts';
import { boot, START, STEP } from './two-factor-test-helpers.ts';

// Two-factor authentication (docs/adr/0021-two-factor-and-smtp.md): an authenticator app and emailed codes as step-up factors and,
// in multi-user mode, as the second step of signing in.

const SECRET = randomBytes(32).toString('base64url');

// ----- the authenticator app -------------------------------------------------------------------

dbTest(
  'enrolling an authenticator app: it needs a confirmation, the secret is shown once and stored encrypted, a wrong first code does not enrol',
  async (db) => {
    const t = await boot(db);
    const without = await t.send(t.owner, 'POST', '/two-factor/totp/begin', {});
    assert.equal(without.status, 403);
    assert.equal(without.body.error, 'step_up_required');
    const begun = await t.send(t.owner, 'POST', '/two-factor/totp/begin', {}, await t.manage());
    assert.equal(begun.status, 201);
    assert.equal(begun.headers.get('cache-control'), 'no-store');
    const secret = begun.body.secret as string;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(
      begun.body.uri,
      /^otpauth:\/\/totp\/Mobile%20Release%20Manager:ada%40example\.com\?secret=[A-Z2-7]{32}&issuer=Mobile%20Release%20Manager&algorithm=SHA1&digits=6&period=30$/,
    );
    assert.ok(begun.body.uri.includes(secret));
    // Pending: it does not count as a factor yet.
    assert.equal((await t.send(t.owner, 'GET', '/two-factor/status')).body.totp.state, 'pending');
    const wrong = await t.send(t.owner, 'POST', '/two-factor/totp/confirm', { code: '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'invalid_code');
    assert.equal((await t.send(t.owner, 'GET', '/two-factor/status')).body.totp.state, 'pending');
    const done = await t.send(t.owner, 'POST', '/two-factor/totp/confirm', {
      code: t.code(secret),
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.totp.state, 'active');
    // The secret is encrypted at rest and never comes back.
    const [stored] = await db.query('SELECT secret_enc FROM user_totp');
    assert.ok(!String(stored?.secret_enc).includes(secret));
    const everything = [
      (await t.send(t.owner, 'GET', '/two-factor/status')).text,
      (await t.send(t.owner, 'GET', '/step-up/status')).text,
      ...t.texts,
    ].join('\n');
    assert.ok(
      !everything.replace(begun.text, '').includes(secret),
      'no later answer holds the secret',
    );
    assert.deepEqual(await t.audits('two_factor.totp_enrolled'), ['null']);
    // Already enrolled: set up another only after removing it (a confirmation each time).
    t.clock.now += STEP;
    assert.equal(
      (await t.send(t.owner, 'POST', '/two-factor/totp/begin', {}, await t.manage())).body.error,
      'already_enrolled',
    );
    assert.equal((await t.send(t.owner, 'DELETE', '/two-factor/totp')).status, 403);
    assert.equal(
      (await t.send(t.owner, 'DELETE', '/two-factor/totp', undefined, await t.manage())).status,
      204,
    );
    assert.equal((await t.send(t.owner, 'GET', '/two-factor/status')).body.totp.state, 'none');
  },
);

dbTest(
  'a TOTP code confirms a hard action; a replayed code, an old code and a wrong code do not; wrong ones lock like passwords',
  async (db) => {
    const t = await boot(db);
    const secret = await t.enrollTotp();
    const verify = (c: string, action = 'rollout') =>
      t.send(t.owner, 'POST', '/step-up/verify', { factor: 'totp', action, code: c });
    const good = await verify(t.code(secret));
    assert.equal(good.status, 200, good.text);
    assert.match(good.body.grant, /^sug_/);
    assert.equal(
      (await t.audits('step_up.verified')).filter((d) => d.includes('"factor":"totp"')).length,
      1,
    );
    assert.ok(!(await t.audits('step_up.verified')).join().includes(t.code(secret)));
    // The same code again: a replay.
    const replay = await verify(t.code(secret));
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error, 'step_up_failed');
    assert.equal(replay.body.reason, 'code_already_used');
    // The next step works; one step back (already used) does not; two steps old is expired.
    t.clock.now += STEP;
    assert.equal((await verify(t.code(secret, -1))).status, 403);
    assert.equal((await verify(t.code(secret, -2))).status, 403);
    assert.equal((await verify(t.code(secret))).status, 200);
    // Clock drift: a code from the next step is accepted (once).
    t.clock.now += STEP * 2;
    assert.equal((await verify(t.code(secret, 1))).status, 200);
    // Wrong codes count (the same counter as passwords): the 5th failure in a row locks, even for a right code.
    t.clock.now += STEP * 3;
    const before = (await t.audits('step_up.failed')).length;
    for (let i = 0; i < LOCKOUT_AFTER; i++) {
      const res = await verify('000000');
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'invalid_code');
    }
    assert.equal((await t.audits('step_up.failed')).length - before, LOCKOUT_AFTER);
    const locked = await verify(t.code(secret));
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'step_up_locked');
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    t.clock.now += 31_000;
    assert.equal((await verify(t.code(secret))).status, 200);
    assert.ok((await t.events()).includes('stepup.verified'));
    // Malformed input is a failure, not a crash.
    t.clock.now += STEP;
    assert.equal((await verify('abc')).status, 403);
  },
);

dbTest(
  'without an authenticator app, the totp factor is not enrolled (409), and it is not offered',
  async (db) => {
    const t = await boot(db);
    const res = await t.send(t.owner, 'POST', '/step-up/verify', {
      factor: 'totp',
      action: 'rollout',
      code: '123456',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'factor_not_enrolled');
    await setPolicy(
      db,
      {
        workspaceId: t.workspaceId,
        userId: t.ownerId,
        policy: { mode: 'hard_actions', actions: ['rollout'], unattended: [] },
      },
      t.clock.now,
    );
    const need = await t.send(t.owner, 'PUT', '/step-up/policy', { mode: 'off' });
    assert.deepEqual(need.body.factors, ['password']);
    const secret = await t.enrollTotp();
    assert.ok(secret);
    const need2 = await t.send(t.owner, 'PUT', '/step-up/policy', { mode: 'off' });
    assert.deepEqual(need2.body.factors, ['password', 'totp']);
  },
);

// ----- email codes ------------------------------------------------------------------------------

dbTest(
  'verifying the account email: the code goes to the account address only, is stored as an HMAC, lasts 10 minutes and has 5 tries',
  async (db) => {
    const t = await boot(db);
    const begun = await t.send(
      t.owner,
      'POST',
      '/two-factor/email/begin',
      { email: 'someone-else@example.com' },
      await t.manage(),
    );
    assert.equal(begun.status, 202, begun.text);
    assert.equal(begun.body.to, 'a**@example.com');
    assert.equal(t.mailer.sent.length, 1);
    assert.deepEqual(
      t.mailer.last()?.to,
      ['ada@example.com'],
      'a requested address is ignored on a server with accounts',
    );
    const code = t.mailer.lastCode() ?? '';
    assert.match(code, /^\d{6}$/);
    const rows = JSON.stringify(await db.query('SELECT * FROM mail_codes'));
    assert.ok(!rows.includes(`"${code}"`) && !rows.includes(code), 'the code is not stored');
    const [row] = await db.query('SELECT code_mac, expires_at, created_at FROM mail_codes');
    assert.match(String(row?.code_mac), /^[0-9a-f]{64}$/);
    assert.equal(Number(row?.expires_at) - Number(row?.created_at), EMAIL_CODE_TTL_MS);
    assert.ok(!begun.text.includes(code));
    // Five wrong tries kill the code, even for the right one afterwards.
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++)
      assert.equal(
        (
          await t.send(t.owner, 'POST', '/two-factor/email/confirm', {
            code: code === '111111' ? '222222' : '111111',
          })
        ).body.error,
        'invalid_code',
      );
    const dead = await t.send(t.owner, 'POST', '/two-factor/email/confirm', { code });
    assert.equal(dead.status, 429);
    assert.equal(dead.body.error, 'too_many_attempts');
    assert.equal((await t.send(t.owner, 'GET', '/two-factor/status')).body.email.verified, false);
    // A fresh code (after the cooldown) works; the old one does not.
    t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
    assert.equal(
      (await t.send(t.owner, 'POST', '/two-factor/email/begin', {}, await t.manage())).status,
      202,
    );
    const next = t.mailer.lastCode() ?? '';
    assert.equal(
      (await t.send(t.owner, 'POST', '/two-factor/email/confirm', { code: next })).status,
      200,
    );
    const status = (await t.send(t.owner, 'GET', '/two-factor/status')).body;
    assert.equal(status.email.verified, true);
    assert.equal(status.email.usable, true);
    // A code works once.
    assert.equal(
      (await t.send(t.owner, 'POST', '/two-factor/email/confirm', { code: next })).status,
      400,
    );
    assert.deepEqual(await t.audits('two_factor.email_verified'), ['null']);
    assert.ok(!t.texts.join('\n').includes(next), 'no answer ever holds a code');
  },
);

dbTest('an email code expires after 10 minutes', async (db) => {
  const t = await boot(db);
  assert.equal(
    (await t.send(t.owner, 'POST', '/two-factor/email/begin', {}, await t.manage())).status,
    202,
  );
  const code = t.mailer.lastCode() ?? '';
  t.clock.now += EMAIL_CODE_TTL_MS;
  const late = await t.send(t.owner, 'POST', '/two-factor/email/confirm', { code });
  assert.equal(late.status, 400);
  assert.equal(late.body.error, 'code_expired');
});

dbTest(
  'sending codes is rate limited: a cooldown, a cap per person per hour, and a cap per workspace per hour',
  async (db) => {
    const t = await boot(db);
    const send = async () =>
      t.send(t.owner, 'POST', '/two-factor/email/begin', {}, await t.manage());
    assert.equal((await send()).status, 202);
    const quick = await send();
    assert.equal(quick.status, 429);
    assert.equal(quick.body.error, 'rate_limited');
    assert.ok(quick.body.retryAfterSeconds >= 1 && quick.body.retryAfterSeconds <= 60);
    assert.equal(quick.headers.get('retry-after'), String(quick.body.retryAfterSeconds));
    assert.equal(t.mailer.sent.length, 1);
    for (let i = 1; i < MAIL_USER_PER_HOUR; i++) {
      t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
      assert.equal((await send()).status, 202, `send ${i + 1}`);
    }
    t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
    const capped = await send();
    assert.equal(capped.status, 429, 'the hourly cap');
    assert.ok(capped.body.retryAfterSeconds > 60);
    t.clock.now += 3_600_000;
    assert.equal((await send()).status, 202, 'an hour later');

    // The workspace cap: other people's codes count against the workspace as a whole.
    const other = await t.addUser('member', 'bob@example.com');
    for (let i = 0; i < MAIL_WORKSPACE_PER_HOUR; i++) {
      await db.execute(
        `INSERT INTO mail_codes (id, user_id, purpose, workspace_id, email, code_mac, attempts, created_at, expires_at, used_at) VALUES (?, ?, 'step_up', ?, 'bob@example.com', 'x', 0, ?, ?, ?)`,
        [`seed-${i}`, other.id, t.workspaceId, t.clock.now - 1000, t.clock.now + 1000, t.clock.now],
      );
    }
    t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
    const full = await send();
    assert.equal(full.status, 429);
    assert.equal(full.body.error, 'rate_limited');
  },
);

dbTest(
  'the email factor: a code mailed for ONE action, session and target confirms exactly that, once',
  async (db) => {
    const t = await boot(db);
    await t.verifyEmail();
    t.mailer.clear();
    const ask = (cookie = t.owner, action = 'rollout', target?: { id?: string }) =>
      t.send(cookie, 'POST', '/step-up/email-code', { action, ...(target ? { target } : {}) });
    const verify = (c: string, action = 'rollout', cookie = t.owner, target?: { id?: string }) =>
      t.send(cookie, 'POST', '/step-up/verify', {
        factor: 'email',
        action,
        ...(target ? { target } : {}),
        code: c,
      });
    assert.equal((await ask()).status, 202);
    assert.deepEqual(t.mailer.last()?.to, ['ada@example.com']);
    const code = t.mailer.lastCode() ?? '';
    // Another action, another person's session: no.
    const second = `mrm_session=${(await createSession(db, t.ownerId, t.clock.now)).token}`;
    assert.equal((await verify(code, 'store.publish')).body.reason, 'code_not_sent');
    assert.equal((await verify(code, 'rollout', second)).body.reason, 'code_not_sent');
    const ok = await verify(code);
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.body.grant, /^sug_/);
    assert.equal(
      (await t.audits('step_up.verified')).filter((d) => d.includes('"factor":"email"')).length,
      1,
    );
    // Spent: a second use fails.
    assert.equal((await verify(code)).status, 403);
    // A target binds too.
    t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
    assert.equal((await ask(t.owner, 'rollout', { id: 'app-1' })).status, 202);
    const bound = t.mailer.lastCode() ?? '';
    assert.equal((await verify(bound, 'rollout', t.owner, { id: 'app-2' })).status, 403);
    assert.equal((await verify(bound, 'rollout', t.owner, { id: 'app-1' })).status, 200);
    // Wrong codes lock like any other factor (the shared counter), and a dead code needs a new mail.
    t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
    await ask();
    const real = t.mailer.lastCode() ?? '';
    for (let i = 0; i < LOCKOUT_AFTER; i++)
      assert.equal((await verify(real === '000000' ? '111111' : '000000')).status, 403);
    assert.equal((await verify(real)).status, 429);
    assert.ok(!t.texts.join('\n').includes(real));
  },
);

dbTest(
  'the email factor needs a verified address and a working mail server; failures use fixed codes',
  async (db) => {
    const t = await boot(db);
    // Not verified yet.
    const none = await t.send(t.owner, 'POST', '/step-up/email-code', { action: 'rollout' });
    assert.equal(none.status, 409);
    assert.equal(none.body.error, 'factor_not_enrolled');
    assert.equal(
      (
        await t.send(t.owner, 'POST', '/step-up/verify', {
          factor: 'email',
          action: 'rollout',
          code: '123456',
        })
      ).status,
      409,
    );
    await t.verifyEmail();
    // The server cannot send.
    t.mailer.failWith = 'smtp_timeout';
    const failed = await t.send(t.owner, 'POST', '/step-up/email-code', { action: 'rollout' });
    assert.equal(failed.status, 502);
    assert.deepEqual(
      { error: failed.body.error, code: failed.body.code },
      { error: 'mail_failed', code: 'smtp_timeout' },
    );
    assert.match(failed.body.message, /did not answer in time/);
    t.mailer.failWith = undefined;
    t.mailer.isConfigured = false;
    t.clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
    const off = await t.send(t.owner, 'POST', '/step-up/email-code', { action: 'rollout' });
    assert.equal(off.status, 409);
    assert.equal(off.body.error, 'mail_not_configured');
    // A code that could not be mailed cannot be used.
    const [open] = await db.query('SELECT COUNT(*) AS n FROM mail_codes WHERE used_at IS NULL');
    assert.equal(Number(open?.n), 0);
  },
);

dbTest(
  'single-user mode: the authenticator app and the email are step-up factors only; the person says which address; no sign-in policy',
  async (db) => {
    await migrate(db);
    const clock = { now: START };
    const mailer: FakeMailer = createFakeMailer({ now: () => clock.now });
    const app = createApp({
      db,
      masterKey: randomBytes(32),
      version: 't',
      cost: cheap,
      now: () => clock.now,
      mail: { mailer },
      singleUser: { launchSecret: SECRET, port: 8787 },
    });
    const host = { host: '127.0.0.1:8787' };
    const launch = await app.request(`/api/auth/launch?secret=${SECRET}`, { headers: host });
    const cookie = launch.headers.get('set-cookie')?.split(';')[0] ?? '';
    const status = await (
      await app.request('/api/auth/status', { headers: { ...host, cookie } })
    ).json();
    const me = await (await app.request('/api/me', { headers: { ...host, cookie } })).json();
    const ws = (me as { workspaces: { id: string }[] }).workspaces[0]?.id;
    assert.ok(status && ws);
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await app.request(`/api/workspaces/${ws}${path}`, {
        method,
        headers: {
          ...host,
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
      return { status: res.status, text, body: (text ? JSON.parse(text) : null) as any };
    };
    const st = (await call('GET', '/two-factor/status')).body;
    assert.equal(st.login.supported, false);
    assert.equal(st.emailAddressEditable, true);
    // The first factor needs no confirmation (nothing to confirm with yet): an authenticator app.
    const begun = await call('POST', '/two-factor/totp/begin', {});
    assert.equal(begun.status, 201);
    assert.match(begun.body.uri, /^otpauth:\/\/totp\/Mobile%20Release%20Manager:This%20computer\?/);
    const secret = begun.body.secret as string;
    assert.equal(
      (
        await call('POST', '/two-factor/totp/confirm', {
          code: totpAt(base32Decode(secret) ?? Buffer.alloc(0), clock.now),
        })
      ).status,
      200,
    );
    clock.now += STEP;
    // Now enrolled: it confirms a hard action, and changing factors needs a confirmation.
    const grant = await call('POST', '/step-up/verify', {
      factor: 'totp',
      action: 'step_up.manage',
      code: totpAt(base32Decode(secret) ?? Buffer.alloc(0), clock.now),
    });
    assert.equal(grant.status, 200, grant.text);
    assert.equal(
      (await call('POST', '/two-factor/email/begin', { email: 'me@example.com' })).status,
      403,
    );
    clock.now += STEP;
    const again = await call('POST', '/step-up/verify', {
      factor: 'totp',
      action: 'step_up.manage',
      code: totpAt(base32Decode(secret) ?? Buffer.alloc(0), clock.now),
    });
    const begin = await call(
      'POST',
      '/two-factor/email/begin',
      { email: 'me@example.com' },
      { 'x-step-up-grant': again.body.grant },
    );
    assert.equal(begin.status, 202, begin.text);
    assert.deepEqual(mailer.last()?.to, ['me@example.com']);
    assert.equal(
      (await call('POST', '/two-factor/email/confirm', { code: mailer.lastCode() })).status,
      200,
    );
    assert.equal((await call('GET', '/two-factor/status')).body.email.address, 'me@example.com');
    // No address given: asked for.
    assert.equal(
      (await call('PUT', '/two-factor/policy', { mode: 'all' })).body.error,
      'single_user_mode',
    );
    // Sign-in does not exist here.
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@y.io', password: 'x' }),
    });
    assert.equal(login.status, 403);
  },
);

dbTest('API tokens cannot reach any two-factor, email-code or mail route', async (db) => {
  const t = await boot(db);
  const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'CI', role: 'admin' });
  const bearer = { authorization: `Bearer ${minted.body.token}` };
  const routes: [string, string, unknown?][] = [
    ['GET', '/two-factor/status'],
    ['POST', '/two-factor/totp/begin', {}],
    ['POST', '/two-factor/totp/confirm', { code: '123456' }],
    ['DELETE', '/two-factor/totp'],
    ['POST', '/two-factor/email/begin', {}],
    ['POST', '/two-factor/email/confirm', { code: '123456' }],
    ['DELETE', '/two-factor/email'],
    ['POST', '/step-up/email-code', { action: 'rollout' }],
    ['PUT', '/two-factor/policy', { mode: 'off' }],
    ['DELETE', `/two-factor/members/${t.ownerId}`],
    ['GET', '/mail/settings'],
    [
      'PUT',
      '/mail/settings',
      { host: 'mail.example.com', secure: 'starttls', from: 'a@example.com' },
    ],
    ['DELETE', '/mail/settings'],
    ['POST', '/mail/test', {}],
  ];
  for (const [method, path, body] of routes) {
    const res = await t.raw(method, `/api/workspaces/${t.workspaceId}${path}`, body, bearer);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(res.text, /token_not_allowed/, `${method} ${path}`);
  }
  // Nothing was changed, and no mail was sent.
  assert.equal(t.mailer.sent.length, 0);
  assert.equal((await db.query('SELECT 1 FROM instance_settings')).length, 0);
});

dbTest(
  'resetting a member: owners reset anyone but themselves, admins only members and viewers, always with a confirmation',
  async (db) => {
    const t = await boot(db);
    const member = await t.addUser('member', 'bob@example.com');
    const admin = await t.addUser('admin', 'cy@example.com');
    await db.execute(
      "INSERT INTO user_totp (user_id, secret_enc, confirmed_at, last_step, created_at) VALUES (?, 'x', 1, NULL, 1)",
      [member.id],
    );
    await db.execute(
      "INSERT INTO user_mail (user_id, email, verified_at, created_at) VALUES (?, 'bob@example.com', 1, 1)",
      [member.id],
    );
    const reset = (cookie: string, userId: string, headers: Record<string, string> = {}) =>
      t.send(cookie, 'DELETE', `/two-factor/members/${userId}`, undefined, headers);
    assert.equal((await reset(member.session, admin.id)).status, 403, 'a member cannot');
    assert.equal((await reset(t.owner, member.id)).status, 403, 'a confirmation is needed');
    assert.equal((await reset(t.owner, t.ownerId, await t.manage())).status, 403, 'not yourself');
    assert.equal(
      (await reset(admin.session, t.ownerId)).status === 403,
      true,
      'an admin cannot reset the owner',
    );
    assert.equal((await reset(t.owner, member.id, await t.manage())).status, 204);
    assert.equal((await db.query('SELECT 1 FROM user_totp')).length, 0);
    assert.equal((await db.query('SELECT 1 FROM user_mail')).length, 0);
    assert.equal((await t.audits('two_factor.reset')).length, 1);
    assert.equal((await reset(t.owner, 'nobody', await t.manage())).status, 404);
  },
);
