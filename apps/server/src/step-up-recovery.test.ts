import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { type Database, migrate } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { createApp } from './app.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import {
  generateRecoveryCodes,
  LOCKOUT_AFTER,
  newRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  recoveryStatus,
  spendRecoveryCode,
} from './services/step-up.ts';
import { cheap, PASSWORD } from './testkit.ts';

// Recovery codes (docs/api/step-up.md#recovery-codes, docs/adr/0019-step-up-confirmation.md): ten one-time codes, a third way to confirm,
// and the way back in when the only passkey or confirmation password is lost.

const START = Date.now();
const SECRET = randomBytes(32).toString('base64url');
const FORMAT = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

async function boot(db: Database) {
  const clock = { now: START };
  const t = await bootRepoApp(db, undefined, { now: () => clock.now });
  const [row] = await db.query("SELECT id FROM users WHERE email = 'ada@example.com'");
  const ownerId = String(row?.id);
  const send = async (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };
  const grantFor = async (action: string, target?: { id?: string }, cookie = t.owner) => {
    const res = await send(cookie, 'POST', '/step-up/verify', {
      factor: 'password',
      action,
      ...(target ? { target } : {}),
      password: PASSWORD,
    });
    assert.equal(res.status, 200, res.text);
    return res.body.grant as string;
  };
  /** Ten fresh codes for the owner (a confirmation with the password first). */
  const makeCodes = async () => {
    const res = await send(t.owner, 'POST', '/step-up/recovery-codes', undefined, {
      'x-step-up-grant': await grantFor('step_up.manage'),
    });
    assert.equal(res.status, 201, res.text);
    return res.body.codes as string[];
  };
  const withCode = (code: string, action: string, target?: { id?: string }, cookie = t.owner) =>
    send(cookie, 'POST', '/step-up/verify', {
      factor: 'recovery',
      action,
      ...(target ? { target } : {}),
      code,
    });
  const events = async () =>
    (await db.query('SELECT type, payload FROM events')).map((r) => ({
      type: String(r.type),
      payload: String(r.payload),
    }));
  return { ...t, clock, ownerId, send, grantFor, makeCodes, withCode, events };
}

test('a recovery code is 100 random bits in a typeable form; what is typed is folded, not guessed', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = newRecoveryCode();
    assert.match(code, FORMAT);
    seen.add(code);
  }
  assert.equal(seen.size, 200);
  const code = newRecoveryCode();
  const plain = code.replace(/-/g, '');
  assert.equal(normalizeRecoveryCode(code), plain);
  assert.equal(normalizeRecoveryCode(code.toLowerCase()), plain, 'case does not matter');
  assert.equal(
    normalizeRecoveryCode(` ${code.replace(/-/g, ' ')} `),
    plain,
    'spaces and dashes do not matter',
  );
  assert.equal(normalizeRecoveryCode('O'.repeat(20)), '0'.repeat(20), 'O is 0');
  assert.equal(normalizeRecoveryCode('l'.repeat(20)), '1'.repeat(20), 'l is 1');
  assert.equal(normalizeRecoveryCode(plain.slice(1)), undefined, 'too short');
  assert.equal(normalizeRecoveryCode(`${plain}0`), undefined, 'too long');
  assert.equal(normalizeRecoveryCode(`U${plain.slice(1)}`), undefined, 'U is not a symbol');
});

dbTest(
  'generate: needs a confirmation, shows ten codes once, stores only hashes, and regenerating kills the old ones',
  async (db) => {
    const t = await boot(db);
    assert.equal((await t.send(t.owner, 'GET', '/step-up/status')).body.recovery.remaining, 0);
    const refused = await t.send(t.owner, 'POST', '/step-up/recovery-codes');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'step_up_required', 'a stolen session cannot mint codes');
    assert.equal(refused.body.action, 'step_up.manage');

    const first = await t.makeCodes();
    assert.equal(first.length, RECOVERY_CODE_COUNT);
    assert.equal(new Set(first).size, RECOVERY_CODE_COUNT);
    for (const code of first) assert.match(code, FORMAT);
    const status = (await t.send(t.owner, 'GET', '/step-up/status')).body;
    assert.deepEqual(
      { remaining: status.recovery.remaining, total: status.recovery.total },
      { remaining: 10, total: 10 },
    );
    assert.equal(status.recovery.generatedAt, START);
    assert.equal(
      JSON.stringify(status).includes(first[0] as string),
      false,
      'the status never carries a code',
    );

    // Hashes only.
    const stored = JSON.stringify(await db.query('SELECT * FROM step_up_recovery_codes'));
    for (const code of first)
      assert.equal(stored.includes(code) || stored.includes(code.replace(/-/g, '')), false);

    t.clock.now += 1000;
    const second = await t.makeCodes();
    assert.equal(second.filter((c) => first.includes(c)).length, 0);
    const old = await t.withCode(first[0] as string, 'flags');
    assert.equal(old.status, 403, 'an older code stops working at once');
    assert.equal((await t.withCode(second[0] as string, 'flags')).status, 200);
    assert.equal((await t.send(t.owner, 'GET', '/step-up/status')).body.recovery.remaining, 9);

    const audit = JSON.stringify(
      await db.query("SELECT action, detail FROM audit_events WHERE action LIKE 'step_up.%'"),
    );
    assert.match(audit, /step_up\.recovery_generated/);
    assert.match(audit, /replaced\\":10/);
    for (const code of [...first, ...second])
      assert.equal(
        audit.includes(code) || audit.includes(code.replace(/-/g, '')),
        false,
        'a code is never audited',
      );
  },
);

dbTest(
  'only owners and admins make codes; a person with no way to confirm has nothing to recover',
  async (db) => {
    const t = await boot(db);
    const member = await t.addMember('member');
    const viewer = await t.addMember('viewer');
    const admin = await t.addMember('admin');
    assert.equal((await t.send(member, 'POST', '/step-up/recovery-codes')).status, 403);
    assert.equal((await t.send(viewer, 'POST', '/step-up/recovery-codes')).status, 403);
    assert.equal(
      (await t.send(member, 'GET', '/step-up/status')).body.recovery.remaining,
      0,
      'any member reads their own count',
    );
    // This admin was added without a password, so has no way to confirm and nothing to recover.
    assert.equal(
      (await t.send(admin, 'POST', '/step-up/recovery-codes')).body.error,
      'factor_not_enrolled',
    );
    const outsider = await t.app.request(
      `/api/workspaces/${t.workspaceId}/step-up/recovery-codes`,
      { method: 'POST', headers: { authorization: 'Bearer nope' } },
    );
    assert.equal(outsider.status, 401);
  },
);

dbTest(
  'a code confirms a hard action once; a wrong code counts like a wrong password and locks; the rest is audited without the code',
  async (db) => {
    const t = await boot(db);
    const credential = await t.addCredential();
    const codes = await t.makeCodes();
    assert.equal(
      (
        await t.send(
          t.owner,
          'PUT',
          '/step-up/policy',
          { mode: 'hard_actions' },
          { 'x-step-up-grant': await t.grantFor('step_up.manage') },
        )
      ).status,
      200,
    );
    const missing = await t.send(t.owner, 'DELETE', `/credentials/${credential}`);
    assert.deepEqual(
      missing.body.factors,
      ['password', 'recovery'],
      'the dialog is told a code is an option',
    );

    const grant = await t.withCode(
      (codes[2] as string).toLowerCase().replace(/-/g, ' '),
      'credential.delete',
      { id: credential },
    );
    assert.equal(grant.status, 200, grant.text);
    assert.match(grant.body.grant, /^sug_/);
    assert.equal(
      (
        await t.send(t.owner, 'DELETE', `/credentials/${credential}`, undefined, {
          'x-step-up-grant': grant.body.grant,
        })
      ).status,
      204,
    );
    const again = await t.withCode(codes[2] as string, 'credential.delete');
    assert.equal(again.status, 403, 'one use');
    assert.equal(again.body.error, 'step_up_failed');
    assert.equal(again.body.reason, 'invalid_recovery_code');
    assert.equal((await t.send(t.owner, 'GET', '/step-up/status')).body.recovery.remaining, 9);

    // Parallel use of the same code: exactly one wins.
    const [a, b] = await Promise.all([
      t.withCode(codes[3] as string, 'flags'),
      t.withCode(codes[3] as string, 'flags'),
    ]);
    assert.equal(
      [a.status, b.status].filter((x) => x === 200).length,
      1,
      'exactly one request wins',
    );
    assert.ok([a.status, b.status].every((x) => x === 200 || x === 403 || x === 429));

    // The failure count is shared with the password: five wrong codes lock confirmation.
    t.clock.now += 5000;
    // (The parallel loser above was already a failed attempt, so the lock can come one wrong code
    // early; it must come within LOCKOUT_AFTER wrong codes and never before the first.)
    let wrong = 0;
    for (; wrong < LOCKOUT_AFTER; wrong++) {
      const status = (await t.withCode('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'flags')).status;
      if (status === 429) break;
      assert.equal(status, 403);
    }
    assert.ok(wrong >= LOCKOUT_AFTER - 1, 'locked only after the failures');
    const locked = await t.withCode(codes[4] as string, 'flags');
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'step_up_locked');
    const lockedPassword = await t.send(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'flags',
      password: PASSWORD,
    });
    assert.equal(lockedPassword.status, 429, 'the lockout covers every way to confirm');
    t.clock.now += 30_001;
    assert.equal(
      (await t.withCode(codes[4] as string, 'flags')).status,
      200,
      'a right code after the wait',
    );

    const audit = await db.query(
      "SELECT action, detail FROM audit_events WHERE action LIKE 'step_up.%' ORDER BY created_at, id",
    );
    assert.ok(audit.some((r) => r.action === 'step_up.recovery_used'));
    assert.ok(
      audit.some(
        (r) =>
          r.action === 'step_up.failed' &&
          JSON.parse(String(r.detail)).reason === 'invalid_recovery_code',
      ),
    );
    const everything = JSON.stringify(audit) + JSON.stringify(await t.events());
    for (const code of codes)
      assert.equal(
        everything.includes(code) || everything.includes(code.replace(/-/g, '')),
        false,
        'no code in an audit row or an event',
      );
    assert.equal(everything.includes('ZZZZZ'), false, 'not even a wrong one');
    assert.equal(everything.includes('sug_'), false);
    const used = (await t.events()).filter((e) => e.type === 'stepup.recovery_used');
    assert.equal(used.length, 3, 'one event per code used');
    assert.match(used[0]?.payload ?? '', /"remaining":\d/);
  },
);

dbTest(
  'with no code left, a recovery verification is 409 factor_not_enrolled; a person with none left is not offered one',
  async (db) => {
    const t = await boot(db);
    const res = await t.withCode('AAAAA-AAAAA-AAAAA-AAAAA', 'flags');
    assert.equal(res.status, 409);
    assert.deepEqual(
      { error: res.body.error, reason: res.body.reason },
      { error: 'factor_not_enrolled', reason: 'recovery' },
    );
    assert.equal(
      (await t.send(t.owner, 'GET', '/step-up/status')).body.lockedUntil,
      null,
      'asking is not a failure',
    );
  },
);

dbTest(
  'single-user mode: a lost confirmation password is replaced with a code, a lost only passkey is removed with one',
  async (db) => {
    await migrate(db);
    const app = createApp({
      db,
      masterKey: randomBytes(32),
      version: 't',
      cost: cheap,
      singleUser: { launchSecret: SECRET, port: 8787 },
    });
    const host = { host: '127.0.0.1:8787' };
    const launch = await app.request(`/api/auth/launch?secret=${SECRET}`, { headers: host });
    const cookie = launch.headers.get('set-cookie')?.split(';')[0] ?? '';
    const me = (await (await app.request('/api/me', { headers: { ...host, cookie } })).json()) as {
      workspaces: { id: string }[];
    };
    const w = me.workspaces[0]?.id ?? '';
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await app.request(`/api/workspaces/${w}${path}`, {
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
      // biome-ignore lint/suspicious/noExplicitAny: loose
      return {
        status: res.status,
        headers: res.headers,
        body: (text ? JSON.parse(text) : null) as any,
      };
    };
    // No way to confirm yet: nothing to recover.
    assert.equal((await call('POST', '/step-up/recovery-codes')).body.error, 'factor_not_enrolled');
    assert.equal(
      (await call('PUT', '/step-up/confirmation-password', { password: 'my first long phrase' }))
        .status,
      204,
    );
    const verify = (body: Record<string, unknown>) => call('POST', '/step-up/verify', body);
    const made = await call('POST', '/step-up/recovery-codes', undefined, {
      'x-step-up-grant': (
        await verify({
          factor: 'password',
          action: 'step_up.manage',
          password: 'my first long phrase',
        })
      ).body.grant,
    });
    assert.equal(made.status, 201);
    const codes = made.body.codes as string[];
    assert.equal(
      (
        await call(
          'PUT',
          '/step-up/policy',
          { mode: 'hard_actions' },
          {
            'x-step-up-grant': (
              await verify({ factor: 'recovery', action: 'step_up.manage', code: codes[0] })
            ).body.grant,
          },
        )
      ).status,
      200,
    );

    // The password is forgotten: a code is the grant for replacing it.
    const replace = await call('PUT', '/step-up/confirmation-password', {
      password: 'a brand new long phrase',
    });
    assert.equal(replace.body.action, 'step_up.manage');
    assert.deepEqual(replace.body.factors, ['password', 'recovery']);
    const viaCode = await verify({ factor: 'recovery', action: 'step_up.manage', code: codes[1] });
    assert.equal(viaCode.status, 200);
    assert.equal(
      (
        await call(
          'PUT',
          '/step-up/confirmation-password',
          { password: 'a brand new long phrase' },
          { 'x-step-up-grant': viaCode.body.grant },
        )
      ).status,
      204,
    );
    assert.equal(
      (await verify({ factor: 'password', action: 'flags', password: 'my first long phrase' }))
        .status,
      403,
      'the old password is gone',
    );
    assert.equal(
      (await verify({ factor: 'password', action: 'flags', password: 'a brand new long phrase' }))
        .status,
      200,
    );

    // A passkey that is the only factor and was lost: remove it with a code. (The row stands for a real passkey: the ceremony has its own tests.)
    const [user] = await db.query('SELECT user_id FROM step_up_users');
    const userId = String(user?.user_id);
    await db.execute('UPDATE step_up_users SET confirmation_hash = NULL WHERE user_id = ?', [
      userId,
    ]);
    await db.execute(
      "INSERT INTO step_up_credentials (id, user_id, credential_id, public_key, alg, name, created_at) VALUES ('p1', ?, 'cred-1', 'k', -7, 'Lost phone', 1)",
      [userId],
    );
    assert.equal((await call('GET', '/step-up/status')).body.factors.passkeys.length, 1);
    assert.equal((await call('DELETE', '/step-up/passkeys/p1')).body.action, 'step_up.manage');
    const removeGrant = await verify({
      factor: 'recovery',
      action: 'step_up.manage',
      code: codes[2],
    });
    assert.equal(
      (
        await call('DELETE', '/step-up/passkeys/p1', undefined, {
          'x-step-up-grant': removeGrant.body.grant,
        })
      ).status,
      204,
    );
    const after = (await call('GET', '/step-up/status')).body;
    assert.equal(
      after.enrolled,
      false,
      'no way to confirm left, so the first new one needs nothing',
    );
    assert.equal(after.recovery.remaining, 7);
    assert.equal(
      (await call('PUT', '/step-up/confirmation-password', { password: 'one more long phrase' }))
        .status,
      204,
    );
  },
);

dbTest(
  'spendRecoveryCode: a code is one use, for its person only, whatever the case or dashes',
  async (db) => {
    await migrate(db);
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1), ('u2', 'b@x.io', 'B', 1)",
    );
    const { codes, replaced } = await generateRecoveryCodes(db, 'u1', 5);
    assert.equal(replaced, 0);
    assert.equal(codes.length, 10);
    assert.deepEqual(await recoveryStatus(db, 'u2'), { remaining: 0, total: 0, generatedAt: null });
    assert.equal(
      await spendRecoveryCode(db, 'u2', codes[0] as string, 6),
      false,
      "another person's code is nothing",
    );
    assert.equal(await spendRecoveryCode(db, 'u1', 'not a code', 6), false);
    assert.equal(await spendRecoveryCode(db, 'u1', (codes[0] as string).toLowerCase(), 6), true);
    assert.equal(await spendRecoveryCode(db, 'u1', codes[0] as string, 7), false);
    assert.equal((await recoveryStatus(db, 'u1')).remaining, 9);
    assert.equal(
      Number(
        (await db.query('SELECT used_at FROM step_up_recovery_codes WHERE used_at IS NOT NULL'))[0]
          ?.used_at,
      ),
      6,
    );
  },
);
