import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { type Database, migrate } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { Hono } from 'hono';
import { createApp } from './app.ts';
import type { AppEnv } from './http.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import { createSession } from './services/accounts.ts';
import {
  defaultCoveredActions,
  enableStepUpAutoApprove,
  LOCKOUT_AFTER,
  lockoutMs,
  requireStepUp,
  setPolicy,
  stepUpActions,
} from './services/step-up.ts';
import { makeAuthenticator } from './step-up-test-helpers.ts';
import { cheap, PASSWORD } from './testkit.ts';

const START = Date.now();
const SECRET = randomBytes(32).toString('base64url');

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
  const policy = (mode: 'off' | 'hard_actions', extra: Record<string, unknown> = {}) =>
    send(t.owner, 'PUT', '/step-up/policy', { mode, ...extra });
  /** A grant for the owner by password. */
  const grantFor = async (
    action: string,
    target?: { id?: string; hash?: string },
    cookie = t.owner,
  ) => {
    const res = await send(cookie, 'POST', '/step-up/verify', {
      factor: 'password',
      action,
      ...(target ? { target } : {}),
      password: PASSWORD,
    });
    assert.equal(res.status, 200, res.text);
    return res.body.grant as string;
  };
  const del = (id: string, grant?: string, cookie = t.owner) =>
    send(
      cookie,
      'DELETE',
      `/credentials/${id}`,
      undefined,
      grant ? { 'x-step-up-grant': grant } : {},
    );
  const events = async () =>
    (await db.query('SELECT type, payload FROM events')).map((r) => ({
      type: String(r.type),
      payload: String(r.payload),
    }));
  return { ...t, clock, ownerId, send, policy, grantFor, del, events };
}

dbTest(
  'policy off (the default): every gated route behaves as before, and the status says so',
  async (db) => {
    const t = await boot(db);
    const status = await t.send(t.owner, 'GET', '/step-up/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.policy.mode, 'off');
    assert.deepEqual(status.body.policy.actions, defaultCoveredActions);
    assert.equal(status.body.factors.password.kind, 'account');
    assert.equal(status.body.enrolled, true);
    assert.equal(status.body.supported.webauthn, true);
    const credential = await t.addCredential();
    assert.equal((await t.del(credential)).status, 204, 'no grant needed');
    const flag = await t.send(t.owner, 'PUT', '/settings', { 'analytics.enabled': true });
    assert.equal(flag.status, 200);
    assert.equal(JSON.stringify(status.body).includes('hash'), false, 'no hash is ever returned');
  },
);

dbTest(
  'policy on: a missing grant is 403 step_up_required with the action; nothing is done',
  async (db) => {
    const t = await boot(db);
    const a = await t.addCredential();
    assert.equal((await t.policy('hard_actions')).status, 200);
    const res = await t.del(a);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'step_up_required');
    assert.equal(res.body.action, 'credential.delete');
    assert.equal(res.body.target, a);
    assert.deepEqual(res.body.factors, ['password']);
    assert.equal(res.body.reason, 'missing');
    assert.equal(
      (await t.send(t.owner, 'GET', '/credentials')).body.credentials.length,
      1,
      'the credential is still there',
    );
    // A grant in the URL is never read.
    const viaUrl = await t.send(
      t.owner,
      'DELETE',
      `/credentials/${a}?stepUp=${await t.grantFor('credential.delete', { id: a })}`,
    );
    assert.equal(viaUrl.status, 403);
    // Turning a feature on is a hard action too, but turning it off is not.
    const flag = await t.send(t.owner, 'PUT', '/settings', { 'analytics.enabled': true });
    assert.equal(flag.body.error, 'step_up_required');
    assert.equal(flag.body.action, 'flags');
    assert.equal(
      (await t.send(t.owner, 'PUT', '/settings', { 'analytics.enabled': false })).status,
      200,
    );
  },
);

dbTest('a grant is bound to its action, target, session, time and single use', async (db) => {
  const t = await boot(db);
  const a = await t.addCredential();
  const b = await t.addCredential('github_token', 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await t.policy('hard_actions');

  // The right password gives a grant that lasts 5 minutes.
  const wrong = await t.send(t.owner, 'POST', '/step-up/verify', {
    factor: 'password',
    action: 'credential.delete',
    password: 'not it',
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'step_up_failed');
  assert.equal(wrong.body.reason, 'invalid_password');
  const ok = await t.send(t.owner, 'POST', '/step-up/verify', {
    factor: 'password',
    action: 'credential.delete',
    target: { id: a },
    password: PASSWORD,
  });
  assert.equal(ok.body.expiresAt, START + 5 * 60_000);
  assert.match(ok.body.grant, /^sug_[A-Za-z0-9_-]{43}$/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  // Wrong target, wrong action: refused, and not spent.
  assert.equal((await t.del(b, ok.body.grant)).body.reason, 'mismatch');
  const other = await t.grantFor('store.release', { id: a });
  assert.equal((await t.del(a, other)).body.reason, 'mismatch');
  // Another session of the same person.
  const second = `kiln_session=${(await createSession(db, t.ownerId, START)).token}`;
  assert.equal((await t.del(a, ok.body.grant, second)).body.reason, 'mismatch');
  // Garbage.
  assert.equal((await t.del(a, 'sug_nope')).body.reason, 'invalid');

  // Right use, once.
  assert.equal((await t.del(a, ok.body.grant)).status, 204);
  const again = await t.del(a, ok.body.grant);
  assert.equal(again.status, 403);
  assert.equal(again.body.reason, 'used');

  // Expired.
  const late = await t.grantFor('credential.delete', { id: b });
  t.clock.now += 5 * 60_000 + 1;
  const expired = await t.del(b, late);
  assert.equal(expired.body.error, 'step_up_required');
  assert.equal(expired.body.reason, 'expired');
  const fresh = await t.grantFor('credential.delete', { id: b });
  assert.equal((await t.del(b, fresh)).status, 204);
});

dbTest(
  'a grant bound to a hash cannot be used with another; the body field stepUp works like the header',
  async (db) => {
    const t = await boot(db);
    await t.policy('hard_actions');
    const hash = 'a'.repeat(64);
    const bound = await t.grantFor('analytics.enable_apple', { id: 'app-1', hash });
    // The analytics route reads confirmHash from the body; it is refused before anything is looked up.
    const wrongHash = await t.send(
      t.owner,
      'POST',
      '/apps/app-1/analytics/apple/enable',
      { confirmHash: 'b'.repeat(64) },
      { 'x-step-up-grant': bound },
    );
    assert.equal(wrongHash.status, 403);
    assert.equal(wrongHash.body.reason, 'mismatch');
    const viaBody = await t.send(t.owner, 'POST', '/apps/app-1/analytics/apple/enable', {
      confirmHash: hash,
      stepUp: bound,
    });
    assert.notEqual(
      viaBody.body?.error,
      'step_up_required',
      'the guard let it through (the app does not exist)',
    );
    const flagGrant = await t.grantFor('flags', { id: 'analytics.enabled' });
    const flag = await t.send(t.owner, 'PUT', '/settings', {
      'analytics.enabled': true,
      stepUp: flagGrant,
    });
    assert.equal(flag.status, 200, flag.text);
    assert.equal(flag.body.values['analytics.enabled'], true);
  },
);

dbTest('a class the policy does not cover is free; the list is validated', async (db) => {
  const t = await boot(db);
  const a = await t.addCredential();
  const set = await t.policy('hard_actions', { actions: ['store.release'] });
  assert.deepEqual(set.body.policy.actions, ['store.release']);
  assert.equal((await t.del(a)).status, 204, 'credential.delete is not covered');
  assert.equal((await t.policy('hard_actions', { actions: ['nope'] })).status, 400);
});

dbTest(
  'lockout: five wrong passwords lock confirmation, doubling; success resets; failures are audited and become events',
  async (db) => {
    assert.equal(lockoutMs(LOCKOUT_AFTER - 1), 0);
    assert.equal(lockoutMs(LOCKOUT_AFTER), 30_000);
    assert.equal(lockoutMs(LOCKOUT_AFTER + 1), 60_000);
    assert.equal(lockoutMs(99), 15 * 60_000);
    const t = await boot(db);
    await t.policy('hard_actions');
    const wrong = () =>
      t.send(t.owner, 'POST', '/step-up/verify', {
        factor: 'password',
        action: 'flags',
        password: 'wrong wrong wrong',
      });
    const right = () =>
      t.send(t.owner, 'POST', '/step-up/verify', {
        factor: 'password',
        action: 'flags',
        password: PASSWORD,
      });
    for (let i = 0; i < LOCKOUT_AFTER; i++) assert.equal((await wrong()).status, 403);
    const locked = await right();
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'step_up_locked');
    assert.equal(locked.headers.get('retry-after'), '30');
    assert.equal(
      (await t.send(t.owner, 'GET', '/step-up/status')).body.lockedUntil,
      START + 30_000,
    );
    t.clock.now += 30_001;
    assert.equal((await wrong()).status, 403, 'the 6th wrong answer');
    const longer = await right();
    assert.equal(longer.status, 429);
    assert.equal(longer.headers.get('retry-after'), '60');
    t.clock.now += 60_001;
    assert.equal((await right()).status, 200);
    assert.equal(
      (await t.send(t.owner, 'GET', '/step-up/status')).body.lockedUntil,
      null,
      'a success resets the count',
    );
    assert.equal((await wrong()).status, 403);
    assert.equal((await right()).status, 200, 'one miss after a success locks nothing');

    const audit = await db.query(
      "SELECT action, detail FROM audit_events WHERE action LIKE 'step_up.%' ORDER BY created_at, id",
    );
    const failed = audit.filter((r) => r.action === 'step_up.failed');
    assert.equal(failed.length, LOCKOUT_AFTER + 2);
    assert.ok(
      failed.some((r) => JSON.parse(String(r.detail)).failedCount === LOCKOUT_AFTER),
      'the count is in the audit row',
    );
    const everything = JSON.stringify(audit) + JSON.stringify(await t.events());
    assert.equal(everything.includes(PASSWORD), false);
    assert.equal(everything.includes('wrong wrong wrong'), false);
    assert.equal(
      everything.includes('sug_'),
      false,
      'a grant is never audited or sent as an event',
    );
    const types = (await t.events()).map((e) => e.type);
    assert.ok(types.includes('stepup.failed') && types.includes('stepup.verified'));
  },
);

for (const kind of ['es256', 'eddsa'] as const) {
  dbTest(
    `passkeys (${kind}): enrol, confirm with the passkey, replay, rollback, wrong origin, expiry, removal`,
    async (db) => {
      const t = await boot(db);
      const key = makeAuthenticator(kind);
      const a = await t.addCredential();
      await t.policy('hard_actions');

      // Enrolling needs a fresh confirmation, because the person can already confirm (the account password).
      const options = await t.send(t.owner, 'POST', '/step-up/passkeys/register/options', {});
      assert.equal(options.status, 200, options.text);
      assert.equal(options.body.publicKey.authenticatorSelection.userVerification, 'required');
      assert.equal(options.body.publicKey.attestation, 'none');
      assert.equal(options.body.publicKey.rp.id, 'localhost');
      assert.deepEqual(
        options.body.publicKey.pubKeyCredParams.map((p: { alg: number }) => p.alg),
        [-7, -8],
      );
      const body = {
        challengeId: options.body.challengeId,
        name: 'MacBook Touch ID',
        credential: key.register(options.body.publicKey.challenge),
      };
      const bare = await t.send(t.owner, 'POST', '/step-up/passkeys/register/verify', body);
      assert.equal(bare.status, 403);
      assert.equal(bare.body.action, 'step_up.manage');
      // A challenge is spent by the first try: a bad attestation burns it.
      const badOrigin = {
        ...body,
        credential: key.register(options.body.publicKey.challenge, {
          origin: 'https://evil.example',
        }),
      };
      const rejected = await t.send(
        t.owner,
        'POST',
        '/step-up/passkeys/register/verify',
        badOrigin,
        { 'x-step-up-grant': await t.grantFor('step_up.manage') },
      );
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.reason, 'bad_origin');
      const options2 = await t.send(t.owner, 'POST', '/step-up/passkeys/register/options', {});
      const added = await t.send(
        t.owner,
        'POST',
        '/step-up/passkeys/register/verify',
        {
          challengeId: options2.body.challengeId,
          name: 'MacBook Touch ID',
          credential: key.register(options2.body.publicKey.challenge),
        },
        { 'x-step-up-grant': await t.grantFor('step_up.manage') },
      );
      assert.equal(added.status, 201, added.text);
      assert.equal(added.body.passkey.name, 'MacBook Touch ID');
      const status = await t.send(t.owner, 'GET', '/step-up/status');
      assert.deepEqual(
        status.body.factors.passkeys.map((p: { name: string }) => p.name),
        ['MacBook Touch ID'],
      );
      assert.equal(
        JSON.stringify(status.body).includes(key.credentialId),
        false,
        'credential ids are not listed',
      );
      assert.deepEqual((await t.send(t.owner, 'DELETE', `/credentials/${a}`)).body.factors, [
        'passkey',
        'password',
      ]);

      // The same authenticator cannot be added twice.
      const options3 = await t.send(t.owner, 'POST', '/step-up/passkeys/register/options', {});
      const dup = await t.send(
        t.owner,
        'POST',
        '/step-up/passkeys/register/verify',
        {
          challengeId: options3.body.challengeId,
          name: 'again',
          credential: key.register(options3.body.publicKey.challenge),
        },
        { 'x-step-up-grant': await t.grantFor('step_up.manage') },
      );
      assert.equal(dup.body.reason, 'already_registered');

      // Confirm with the passkey.
      const assertionOptions = async () => {
        // Failed checks count towards the lockout, as they should; each step here starts after it ended.
        t.clock.now += 16 * 60_000;
        const res = await t.send(t.owner, 'POST', '/step-up/passkeys/assertion/options', {
          action: 'credential.delete',
          target: { id: a },
        });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.publicKey.userVerification, 'required');
        assert.equal(res.body.publicKey.allowCredentials[0].id, key.credentialId);
        return res.body as { challengeId: string; publicKey: { challenge: string } };
      };
      const verify = (
        o: { challengeId: string },
        assertion: unknown,
        action = 'credential.delete',
        cookie = t.owner,
      ) =>
        t.send(cookie, 'POST', '/step-up/verify', {
          factor: 'passkey',
          action,
          target: { id: a },
          challengeId: o.challengeId,
          assertion,
        });

      const good = await assertionOptions();
      const signed = key.assert(good.publicKey.challenge, { counter: 5 });
      const done = await verify(good, signed);
      assert.equal(done.status, 200, done.text);
      assert.equal((await t.del(a, done.body.grant)).status, 204);
      // Replay of the same assertion: the challenge is spent.
      const replay = await verify(good, signed);
      assert.equal(replay.status, 403);
      assert.equal(replay.body.error, 'step_up_failed');
      assert.equal(replay.body.reason, 'invalid_passkey');
      // Counter rollback: a new challenge, but the counter did not go up.
      const rollback = await assertionOptions();
      assert.equal(
        (await verify(rollback, key.assert(rollback.publicKey.challenge, { counter: 5 }))).status,
        403,
      );
      // Wrong origin, wrong challenge, wrong signature, another action than the challenge was issued for.
      const o1 = await assertionOptions();
      assert.equal(
        (
          await verify(
            o1,
            key.assert(o1.publicKey.challenge, { counter: 6, origin: 'https://evil.example' }),
          )
        ).status,
        403,
      );
      const o2 = await assertionOptions();
      assert.equal((await verify(o2, key.assert('AAAA', { counter: 6 }))).status, 403);
      const o3 = await assertionOptions();
      assert.equal(
        (
          await verify(
            o3,
            key.assert(o3.publicKey.challenge, {
              counter: 6,
              signWith: makeAuthenticator(kind).privateKey,
            }),
          )
        ).status,
        403,
      );
      const o4 = await assertionOptions();
      assert.equal(
        (await verify(o4, key.assert(o4.publicKey.challenge, { counter: 6 }), 'store.release'))
          .status,
        403,
      );
      // A challenge issued to another session of the same person.
      const o5 = await assertionOptions();
      const second = `kiln_session=${(await createSession(db, t.ownerId, t.clock.now)).token}`;
      assert.equal(
        (
          await verify(
            o5,
            key.assert(o5.publicKey.challenge, { counter: 7 }),
            'credential.delete',
            second,
          )
        ).status,
        403,
      );
      // Expiry: a challenge lasts 2 minutes.
      const o6 = await assertionOptions();
      t.clock.now += 2 * 60_000 + 1;
      assert.equal(
        (await verify(o6, key.assert(o6.publicKey.challenge, { counter: 8 }))).status,
        403,
      );
      // After all that the stored counter is still 5: a higher one works.
      const o7 = await assertionOptions();
      assert.equal(
        (await verify(o7, key.assert(o7.publicKey.challenge, { counter: 9 }))).status,
        200,
      );

      // Removal needs a confirmation too.
      const id = status.body.factors.passkeys[0].id;
      assert.equal(
        (await t.send(t.owner, 'DELETE', `/step-up/passkeys/${id}`)).body.action,
        'step_up.manage',
      );
      assert.equal(
        (
          await t.send(t.owner, 'DELETE', `/step-up/passkeys/${id}`, undefined, {
            'x-step-up-grant': await t.grantFor('step_up.manage'),
          })
        ).status,
        204,
      );
      assert.deepEqual((await t.send(t.owner, 'GET', '/step-up/status')).body.factors.passkeys, []);
      const failures = (
        await db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'step_up.failed'")
      )[0];
      assert.ok(Number(failures?.n) >= 6, 'failed passkey checks are counted');
    },
  );
}

dbTest('passkeys need a secure origin: an IP address is refused with a clear code', async (db) => {
  const t = await boot(db);
  const res = await t.app.request(
    `http://192.168.1.5/api/workspaces/${t.workspaceId}/step-up/passkeys/register/options`,
    {
      method: 'POST',
      headers: { cookie: t.owner, 'content-type': 'application/json' },
      body: '{}',
    },
  );
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, 'webauthn_unavailable');
  assert.equal((await t.send(t.owner, 'GET', '/step-up/status')).body.supported.rpId, 'localhost');
});

dbTest(
  'the policy: admins change it, others cannot; weakening an active policy needs a confirmation; tokens cannot reach these routes',
  async (db) => {
    const t = await boot(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    assert.equal(
      (await t.send(viewer, 'PUT', '/step-up/policy', { mode: 'hard_actions' })).status,
      403,
    );
    assert.equal(
      (await t.send(member, 'PUT', '/step-up/policy', { mode: 'hard_actions' })).status,
      403,
    );
    assert.equal(
      (await t.send(viewer, 'GET', '/step-up/status')).status,
      200,
      'any member reads the status',
    );
    const on = await t.send(admin, 'PUT', '/step-up/policy', { mode: 'hard_actions' });
    assert.equal(on.status, 200);
    assert.equal(on.body.enrolled, false, 'this admin has no way to confirm yet');
    // Hard actions are refused with a way forward, for someone who cannot confirm.
    const refused = await t.send(admin, 'PUT', '/settings', { 'analytics.enabled': true });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'step_up_not_enrolled');
    assert.match(refused.body.message, /Settings, Security/);
    // Weakening needs a confirmation: the owner has a way, the admin does not.
    assert.equal(
      (await t.send(admin, 'PUT', '/step-up/policy', { mode: 'off' })).body.error,
      'step_up_not_enrolled',
    );
    const noGrant = await t.policy('off');
    assert.equal(noGrant.status, 403);
    assert.equal(noGrant.body.action, 'step_up.manage');
    assert.equal(
      (
        await t.send(
          t.owner,
          'PUT',
          '/step-up/policy',
          { mode: 'off' },
          { 'x-step-up-grant': await t.grantFor('step_up.manage') },
        )
      ).status,
      200,
    );
    assert.equal(
      (await db.query("SELECT action FROM audit_events WHERE action = 'step_up.policy_changed'"))
        .length,
      2,
    );
    // API tokens may not even reach the step-up routes.
    const minted = await t.call(t.owner, 'POST', '/tokens', { name: 'CI', role: 'admin' });
    const viaToken = await t.app.request(`/api/workspaces/${t.workspaceId}/step-up/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(viaToken.status, 403);
    assert.match(await viaToken.text(), /token_not_allowed/);
  },
);

dbTest(
  'single-user mode: not enrolled until a confirmation password is set; it is hashed and needs confirming to change',
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
    const credential = (
      await call('POST', '/credentials', {
        kind: 'github_token',
        label: 'x',
        secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      })
    ).body.credential.id as string;
    assert.equal((await call('PUT', '/step-up/policy', { mode: 'hard_actions' })).status, 200);
    const status = await call('GET', '/step-up/status');
    assert.equal(status.body.enrolled, false);
    assert.equal(status.body.factors.confirmationPasswordSettable, true);
    assert.equal(
      (await call('DELETE', `/credentials/${credential}`)).body.error,
      'step_up_not_enrolled',
    );
    assert.equal(
      (await call('PUT', '/step-up/policy', { mode: 'off' })).body.error,
      'step_up_not_enrolled',
      'cannot weaken without a way to confirm',
    );
    assert.equal(
      (await call('PUT', '/step-up/confirmation-password', { password: 'short' })).status,
      400,
    );
    assert.equal(
      (await call('PUT', '/step-up/confirmation-password', { password: 'my confirmation phrase' }))
        .status,
      204,
    );
    const stored = (await db.query('SELECT confirmation_hash FROM step_up_users'))[0];
    assert.match(String(stored?.confirmation_hash), /^scrypt\$/);
    assert.equal(String(stored?.confirmation_hash).includes('my confirmation phrase'), false);
    // Changing it needs a confirmation with the current one.
    assert.equal(
      (await call('PUT', '/step-up/confirmation-password', { password: 'another long phrase' }))
        .body.action,
      'step_up.manage',
    );
    assert.equal(
      (await call('DELETE', `/credentials/${credential}`)).body.error,
      'step_up_required',
    );
    const target = { id: credential };
    assert.equal(
      (
        await call('POST', '/step-up/verify', {
          factor: 'password',
          action: 'credential.delete',
          target,
          password: 'not my phrase',
        })
      ).status,
      403,
    );
    const good = await call('POST', '/step-up/verify', {
      factor: 'password',
      action: 'credential.delete',
      target,
      password: 'my confirmation phrase',
    });
    assert.equal(good.status, 200);
    assert.equal(
      (
        await call('DELETE', `/credentials/${credential}`, undefined, {
          'x-step-up-grant': good.body.grant,
        })
      ).status,
      204,
    );
  },
);

dbTest(
  'a server with accounts confirms with the account password: no separate confirmation password',
  async (db) => {
    const t = await boot(db);
    assert.equal(
      (
        await t.send(t.owner, 'PUT', '/step-up/confirmation-password', {
          password: 'a perfectly long phrase',
        })
      ).status,
      409,
    );
  },
);

dbTest(
  'the guard: an API token is refused unless the class is unattended; a person needs a grant; the demo flag approves',
  async (db) => {
    const t = await boot(db);
    const guardApp = new Hono<AppEnv>();
    let asToken = true;
    guardApp.use('*', async (c, next) => {
      c.set('user', { id: t.ownerId, email: 'ada@example.com', displayName: 'Ada' });
      if (asToken) c.set('token', { tokenId: 'tok-1' } as never);
      await next();
    });
    guardApp.post(
      '/api/workspaces/:workspaceId/act',
      async (c) =>
        (await requireStepUp({ db, now: () => t.clock.now }, c, 'store.release')) ??
        c.json({ done: true }),
    );
    const act = () => guardApp.request(`/api/workspaces/${t.workspaceId}/act`, { method: 'POST' });
    const policy = (unattended: string[]) =>
      setPolicy(
        db,
        {
          workspaceId: t.workspaceId,
          userId: t.ownerId,
          policy: {
            mode: 'hard_actions',
            actions: ['store.release'],
            unattended: unattended as never,
          },
        },
        t.clock.now,
      );
    assert.equal((await act()).status, 200, 'policy off');
    await policy([]);
    const refused = await act();
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, 'step_up_required_human');
    assert.equal(
      Number(
        (
          await db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'step_up.refused'")
        )[0]?.n,
      ),
      1,
    );
    await policy(['store.release']);
    assert.equal((await act()).status, 200, 'allowed unattended by an admin');
    await policy([]);
    asToken = false;
    assert.equal(((await (await act()).json()) as { error: string }).error, 'step_up_required');
    enableStepUpAutoApprove(db);
    assert.equal((await act()).status, 200, 'demo auto-approve');
  },
);

dbTest('the real API: a token on a covered action gets step_up_required_human', async (db) => {
  const t = await boot(db);
  await t.policy('hard_actions');
  const minted = await t.call(t.owner, 'POST', '/tokens', {
    name: 'CI',
    role: 'admin',
    actions: ['analytics.manage'],
  });
  const res = await t.app.request(
    `/api/workspaces/${t.workspaceId}/apps/app-1/analytics/apple/enable`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmHash: 'a'.repeat(64) }),
    },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, 'step_up_required_human');
  const asPerson = await t.send(t.owner, 'POST', '/apps/app-1/analytics/apple/enable', {
    confirmHash: 'a'.repeat(64),
  });
  assert.equal(asPerson.body.error, 'step_up_required');
});

test('the classes of hard actions are the documented ones', () => {
  assert.deepEqual(
    [...stepUpActions],
    [
      'store.publish',
      'store.submit',
      'store.release',
      'rollout',
      'internal_sharing',
      'analytics.enable_apple',
      'credential.delete',
      'flags',
      'store.push_draft',
      'store.price',
    ],
  );
  assert.equal(defaultCoveredActions.includes('store.push_draft'), false);
  assert.equal(defaultCoveredActions.includes('store.price'), true, 'sending prices is covered by default');
});
