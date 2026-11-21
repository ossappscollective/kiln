import assert from 'node:assert/strict';
import type { Database } from '@kiln/db';
import { createLoginLimiter } from './limiter.ts';
import { hashPassword } from './passwords.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import { createSession } from './services/accounts.ts';
import { createFakeMailer } from './services/mailer.ts';
import { base32Decode, totpAt } from './services/totp.ts';
import { MAIL_RESEND_COOLDOWN_MS } from './services/two-factor.ts';
import { cheap, PASSWORD } from './testkit.ts';

/** The app, a fake mailer, a clock and the calls the two-factor tests share. Not a test file, so the runner skips it. */
export const START = Date.now();
export const STEP = 30_000;

export async function boot(db: Database, overrides: Record<string, unknown> = {}) {
  const clock = { now: START };
  const mailer = createFakeMailer({ now: () => clock.now });
  const t = await bootRepoApp(db, undefined, {
    now: () => clock.now,
    limiter: createLoginLimiter({ max: 1000, now: () => clock.now }),
    ipLimiter: createLoginLimiter({ max: 1000, now: () => clock.now }),
    mail: { mailer },
    ...overrides,
  });
  const [row] = await db.query("SELECT id FROM users WHERE email = 'ada@example.com'");
  const ownerId = String(row?.id);
  const raw = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await t.app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    t.texts.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: (text ? JSON.parse(text) : null) as any,
    };
  };
  const send = (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => raw(method, `/api/workspaces/${t.workspaceId}${path}`, body, { cookie, ...headers });
  const grantFor = async (action: string, cookie = t.owner, target?: { id?: string }) => {
    const res = await send(cookie, 'POST', '/step-up/verify', {
      factor: 'password',
      action,
      ...(target ? { target } : {}),
      password: PASSWORD,
    });
    assert.equal(res.status, 200, res.text);
    return res.body.grant as string;
  };
  const manage = async (cookie = t.owner) => ({
    'x-step-up-grant': await grantFor('step_up.manage', cookie),
  });
  const code = (secret: string, stepOffset = 0) =>
    totpAt(base32Decode(secret) ?? Buffer.alloc(0), clock.now + stepOffset * STEP);
  /** Sets up an authenticator app for the signed-in person; returns its secret. The clock moves one step so the next code is fresh. */
  const enrollTotp = async (cookie = t.owner) => {
    const begun = await send(cookie, 'POST', '/two-factor/totp/begin', {}, await manage(cookie));
    assert.equal(begun.status, 201, begun.text);
    const secret = begun.body.secret as string;
    const done = await send(cookie, 'POST', '/two-factor/totp/confirm', { code: code(secret) });
    assert.equal(done.status, 200, done.text);
    clock.now += STEP;
    return secret;
  };
  /** Verifies the account email of the signed-in person through the mailer. */
  const verifyEmail = async (cookie = t.owner) => {
    const begun = await send(cookie, 'POST', '/two-factor/email/begin', {}, await manage(cookie));
    assert.equal(begun.status, 202, begun.text);
    const done = await send(cookie, 'POST', '/two-factor/email/confirm', {
      code: mailer.lastCode(),
    });
    assert.equal(done.status, 200, done.text);
    clock.now += MAIL_RESEND_COOLDOWN_MS + 1;
  };
  const login = (email = 'ada@example.com', password = PASSWORD) =>
    raw('POST', '/api/auth/login', { email, password });
  const events = async () => (await db.query('SELECT type FROM events')).map((r) => String(r.type));
  const audits = async (action: string) =>
    (await db.query('SELECT detail FROM audit_events WHERE action = ?', [action])).map((r) =>
      String(r.detail),
    );
  /** A member of the workspace with a password (so they can sign in). */
  const addUser = async (role: string, email: string) => {
    const id = `user-${role}`;
    await db.execute(
      'INSERT INTO users (id, email, display_name, created_at, password_hash) VALUES (?, ?, ?, 0, ?)',
      [id, email, role, await hashPassword(PASSWORD, cheap)],
    );
    await db.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [t.workspaceId, id, role],
    );
    const session = `kiln_session=${(await createSession(db, id, START)).token}`;
    return { id, email, session };
  };
  return {
    ...t,
    clock,
    mailer,
    ownerId,
    raw,
    send,
    grantFor,
    manage,
    code,
    enrollTotp,
    verifyEmail,
    login,
    events,
    audits,
    addUser,
  };
}
