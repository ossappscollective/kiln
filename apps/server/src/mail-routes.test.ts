import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { createLoginLimiter } from './limiter.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import { createConfiguredMailer, effectiveSmtp, parseSmtpEnv, readStoredSmtp } from './services/mail-config.ts';
import { MAIL_ERROR_MESSAGES, createFakeMailer, mailErrorCodes, sendMail, setMailer } from './services/mailer.ts';
import { PASSWORD } from './testkit.ts';
import { startFakeSmtp } from './smtp-test-server.ts';

// The mailer interface, the SMTP settings (environment and stored, encrypted) and the mail routes (docs/api/mail.md).

const START = Date.now();
const PW = 'S3cret-smtp-password';

test('parseSmtpEnv: nothing set is "not configured"; defaults follow the security mode; wrong values are refused with a plain sentence', () => {
  assert.deepEqual(parseSmtpEnv({}), { allowPrivateHosts: false });
  assert.deepEqual(parseSmtpEnv({ MRM_SMTP_HOST: '  ', MRM_SMTP_PORT: '' }), { allowPrivateHosts: false });
  assert.deepEqual(parseSmtpEnv({ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'mrm@example.com' }).config, { host: 'mail.example.com', port: 587, secure: 'starttls', from: 'mrm@example.com' });
  assert.equal(parseSmtpEnv({ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'a@example.com', MRM_SMTP_SECURE: 'tls' }).config?.port, 465);
  assert.equal(parseSmtpEnv({ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'a@example.com', MRM_SMTP_SECURE: 'none' }).config?.port, 25);
  const full = parseSmtpEnv({ MRM_SMTP_HOST: '10.0.0.5', MRM_SMTP_PORT: '2525', MRM_SMTP_SECURE: 'starttls', MRM_SMTP_USER: 'u', MRM_SMTP_PASSWORD: PW, MRM_SMTP_FROM: 'Release <r@example.com>', MRM_SMTP_ALLOW_PRIVATE_HOSTS: 'true' });
  assert.deepEqual(full, { allowPrivateHosts: true, config: { host: '10.0.0.5', port: 2525, secure: 'starttls', user: 'u', password: PW, from: 'Release <r@example.com>' } });
  for (const [env, message] of [
    [{ MRM_SMTP_HOST: 'smtp://mail.example.com', MRM_SMTP_FROM: 'a@example.com' }, /MRM_SMTP_HOST/],
    [{ MRM_SMTP_HOST: 'mail.example.com:25', MRM_SMTP_FROM: 'a@example.com' }, /MRM_SMTP_HOST/],
    [{ MRM_SMTP_HOST: 'mail.example.com' }, /MRM_SMTP_FROM/],
    [{ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'not an address' }, /MRM_SMTP_FROM/],
    [{ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'a@example.com', MRM_SMTP_SECURE: 'ssl' }, /MRM_SMTP_SECURE/],
    [{ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'a@example.com', MRM_SMTP_PORT: '99999' }, /MRM_SMTP_PORT/],
    [{ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'a@example.com', MRM_SMTP_PORT: 'x' }, /MRM_SMTP_PORT/],
    [{ MRM_SMTP_ALLOW_PRIVATE_HOSTS: 'yes' }, /MRM_SMTP_ALLOW_PRIVATE_HOSTS/],
    [{ MRM_SMTP_HOST: 'mail.example.com', MRM_SMTP_FROM: 'a@example.com', MRM_SMTP_USER: 'u\nx' }, /line breaks/],
  ] as const) {
    assert.throws(() => parseSmtpEnv(env), message);
  }
});

test('the fake mailer and the active mailer: sendMail answers a fixed vocabulary and never throws', async () => {
  setMailer(undefined);
  assert.deepEqual(await sendMail({ to: 'a@example.com', subject: 's', text: 't' }), { ok: false, code: 'smtp_not_configured' });
  const fake = createFakeMailer({ now: () => 42 });
  setMailer(fake);
  assert.deepEqual(await sendMail({ to: ['a@example.com', 'b@example.com'], subject: 'Code', text: 'Your code is 123456.', html: '<p>x</p>' }), { ok: true });
  assert.deepEqual(fake.last(), { to: ['a@example.com', 'b@example.com'], subject: 'Code', text: 'Your code is 123456.', html: '<p>x</p>', at: 42 });
  assert.equal(fake.lastCode(), '123456');
  assert.deepEqual(await sendMail({ to: 'bad address', subject: 's', text: 't' }), { ok: false, code: 'smtp_rejected', hint: 'invalid_address' });
  for (const code of mailErrorCodes) {
    fake.failWith = code;
    assert.deepEqual(await sendMail({ to: 'a@example.com', subject: 's', text: 't' }), { ok: false, code });
    assert.ok(MAIL_ERROR_MESSAGES[code].length > 10);
  }
  setMailer({ configured: async () => true, send: async () => { throw new Error('boom: secret detail'); } });
  assert.deepEqual(await sendMail({ to: 'a@example.com', subject: 's', text: 't' }), { ok: false, code: 'smtp_connection_failed' });
  setMailer(undefined);
  assert.deepEqual([...mailErrorCodes], ['smtp_not_configured', 'smtp_connection_failed', 'smtp_auth_failed', 'smtp_tls_failed', 'smtp_rejected', 'smtp_timeout']);
});

async function boot(db: Parameters<typeof bootRepoApp>[0], mail: Record<string, unknown> = { env: { allowPrivateHosts: true }, timeoutMs: 800, totalTimeoutMs: 4000 }) {
  const clock = { now: START };
  const masterKey = randomBytes(32);
  const t = await bootRepoApp(db, undefined, { now: () => clock.now, masterKey, limiter: createLoginLimiter({ max: 1000, now: () => clock.now }), mail });
  const [row] = await db.query("SELECT id FROM users WHERE email = 'ada@example.com'");
  const send = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    t.texts.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return { status: res.status, headers: res.headers, text, body: (text ? JSON.parse(text) : null) as any };
  };
  const grant = async () => {
    const res = await send(t.owner, 'POST', '/step-up/verify', { factor: 'password', action: 'step_up.manage', password: PASSWORD });
    return { 'x-step-up-grant': res.body.grant as string };
  };
  const save = async (value: Record<string, unknown>, cookie = t.owner) => send(cookie, 'PUT', '/mail/settings', value, cookie === t.owner ? await grant() : {});
  return { ...t, clock, masterKey, ownerId: String(row?.id), send, grant, save };
}

dbTest('the SMTP settings are stored ENCRYPTED, the password is never returned, and a change needs a confirmation', async (db) => {
  const t = await boot(db);
  const none = await t.send(t.owner, 'GET', '/mail/settings');
  assert.deepEqual(none.body, { source: 'none', configured: false, locked: false, host: null, port: null, secure: null, user: null, from: null, passwordSet: false, allowPrivateHosts: true });
  const member = await t.addMember('member');
  assert.equal((await t.send(member, 'GET', '/mail/settings')).status, 403);
  assert.equal((await t.send(member, 'PUT', '/mail/settings', { host: 'mail.example.com', secure: 'starttls', from: 'a@example.com' })).status, 403);
  // A stolen session must not be able to repoint the mail server (it receives the emailed codes): a confirmation is needed.
  const value = { host: 'mail.example.com', port: 587, secure: 'starttls', user: 'mrm', password: PW, from: 'Release <mrm@example.com>' };
  assert.equal((await t.send(t.owner, 'PUT', '/mail/settings', value)).body.error, 'step_up_required');
  const saved = await t.save(value);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.body, { source: 'settings', configured: true, locked: false, host: 'mail.example.com', port: 587, secure: 'starttls', user: 'mrm', from: 'Release <mrm@example.com>', passwordSet: true, allowPrivateHosts: true });
  const [row] = await db.query('SELECT key, value_enc FROM instance_settings');
  assert.equal(String(row?.key), 'smtp');
  assert.ok(!String(row?.value_enc).includes(PW) && !String(row?.value_enc).includes('mail.example.com'), 'encrypted at rest');
  assert.deepEqual(await readStoredSmtp(db, t.masterKey), value);
  assert.equal(await readStoredSmtp(db, randomBytes(32)), undefined, 'another master key cannot read it, and that is not an error');
  // Never returned, never audited.
  assert.ok(!t.texts.join('\n').includes(PW));
  const audit = await db.query("SELECT detail FROM audit_events WHERE action = 'mail.settings_changed'");
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(String(audit[0]?.detail)), { host: 'mail.example.com', port: 587, secure: 'starttls', authenticated: true, passwordChanged: true });
});

dbTest('the saved password is kept only while host, port and user are unchanged; otherwise it must be typed again', async (db) => {
  const t = await boot(db);
  const base = { host: 'mail.example.com', port: 587, secure: 'starttls', user: 'mrm', password: PW, from: 'mrm@example.com' };
  assert.equal((await t.save(base)).status, 200);
  const { password: _omit, ...noPassword } = base;
  // Same target, no password: kept.
  assert.equal((await t.save({ ...noPassword, from: 'other@example.com' })).body.passwordSet, true);
  assert.equal((await readStoredSmtp(db, t.masterKey))?.password, PW);
  // The password is never sent to a host it was not saved for.
  for (const changed of [{ host: 'evil.example.net' }, { port: 25 }, { user: 'someone' }]) {
    const res = await t.save({ ...noPassword, ...changed });
    assert.equal(res.status, 400, JSON.stringify(changed));
    assert.equal(res.body.error, 'password_required');
  }
  assert.equal((await readStoredSmtp(db, t.masterKey))?.host, 'mail.example.com');
  // An empty password removes it.
  assert.equal((await t.save({ ...noPassword, password: '' })).body.passwordSet, false);
  // Validation: no scheme in the host, no line break in the user, a real from address.
  for (const bad of [{ host: 'smtp://x.com' }, { user: 'a\nb' }, { from: 'nope' }, { secure: 'ssl' }, { port: 70000 }, { extra: 1 }]) {
    assert.equal((await t.save({ ...base, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await t.send(t.owner, 'DELETE', '/mail/settings')).body.error, 'step_up_required');
  const cleared = await t.send(t.owner, 'DELETE', '/mail/settings', undefined, await t.grant());
  assert.equal(cleared.body.configured, false);
  assert.equal((await db.query('SELECT 1 FROM instance_settings')).length, 0);
  assert.equal((await db.query("SELECT 1 FROM audit_events WHERE action = 'mail.settings_cleared'")).length, 1);
});

dbTest('the address policy: a loopback or private mail host is refused unless the operator allows it; the metadata address never', async (db) => {
  const t = await boot(db, { env: { allowPrivateHosts: false } });
  const value = { secure: 'none', from: 'mrm@example.com' };
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '::1']) {
    const res = await t.save({ ...value, host });
    assert.equal(res.status, 400, host);
    assert.equal(res.body.error, 'address_not_allowed', host);
    assert.equal(res.body.hint, 'private_address_blocked');
    assert.match(res.body.message, /MRM_SMTP_ALLOW_PRIVATE_HOSTS=true/);
  }
  assert.equal((await t.save({ ...value, host: '169.254.169.254' })).body.hint, 'host_not_allowed');
  assert.equal((await db.query('SELECT 1 FROM instance_settings')).length, 0);
  assert.equal((await t.send(t.owner, 'GET', '/mail/settings')).body.allowPrivateHosts, false);
});

dbTest('when the environment sets the mail server it wins, shows read-only and cannot be edited or cleared; the password is not returned', async (db) => {
  const env = parseSmtpEnv({ MRM_SMTP_HOST: '10.0.0.8', MRM_SMTP_USER: 'u', MRM_SMTP_PASSWORD: PW, MRM_SMTP_FROM: 'mrm@example.com', MRM_SMTP_ALLOW_PRIVATE_HOSTS: 'true' });
  const t = await boot(db, { env });
  const got = await t.send(t.owner, 'GET', '/mail/settings');
  assert.deepEqual(got.body, { source: 'env', configured: true, locked: true, host: '10.0.0.8', port: 587, secure: 'starttls', user: 'u', from: 'mrm@example.com', passwordSet: true, allowPrivateHosts: true });
  assert.equal((await t.save({ host: 'other.example.com', secure: 'tls', from: 'x@example.com' })).body.error, 'smtp_locked');
  assert.equal((await t.send(t.owner, 'DELETE', '/mail/settings', undefined, await t.grant())).body.error, 'smtp_locked');
  assert.ok(!t.texts.join('\n').includes(PW));
  assert.equal((await effectiveSmtp(db, t.masterKey, env)).source, 'env');
});

dbTest('Send test email: the real client against a real SMTP server; fixed failure codes; rate limited; only to yourself', async (db) => {
  const server = await startFakeSmtp({ auth: { user: 'mrm', password: PW } });
  try {
    const t = await boot(db);
    const test = (body?: unknown, cookie = t.owner) => t.send(cookie, 'POST', '/mail/test', body);
    // Not set up.
    const first = await test({});
    assert.deepEqual({ ok: first.body.ok, code: first.body.code }, { ok: false, code: 'smtp_not_configured' });
    assert.match(first.body.message, /No mail server is set up/);
    assert.equal((await t.save({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mrm', password: PW, from: 'Release Manager <mrm@example.com>' })).status, 200);
    const ok = await test();
    assert.deepEqual(ok.body, { ok: true, to: 'ada@example.com' });
    const got = server.messages[0];
    assert.deepEqual(got?.to, ['ada@example.com']);
    assert.equal(got?.user, 'mrm');
    assert.match(got?.data ?? '', /Subject: Test message from Mobile Release Manager/);
    assert.match(got?.data ?? '', /multipart\/alternative/);
    // Anyone else's address: refused (this is not a relay).
    const other = await test({ to: 'victim@example.com' });
    assert.equal(other.status, 403);
    assert.equal(server.messages.length, 1);
    assert.equal((await test({ to: 'ADA@example.com' })).body.ok, true);
    // A wrong password and a dead server answer with a code, never with what the server said.
    assert.equal((await t.save({ host: '127.0.0.1', port: server.port, secure: 'none', user: 'mrm', password: 'wrong', from: 'mrm@example.com' })).status, 200);
    const denied = await test();
    assert.deepEqual({ ok: denied.body.ok, code: denied.body.code }, { ok: false, code: 'smtp_auth_failed' });
    assert.ok(!denied.text.includes('535') && !denied.text.includes('credentials'));
    await server.close();
    const down = await test();
    assert.equal(down.body.code, 'smtp_connection_failed');
    // The audit trail has the outcome as a code and nothing else.
    const audits = (await db.query("SELECT detail FROM audit_events WHERE action = 'mail.test_sent'")).map((r) => String(r.detail)).sort();
    assert.deepEqual(audits, ['{"ok":false,"code":"smtp_auth_failed"}', '{"ok":false,"code":"smtp_connection_failed"}', '{"ok":false,"code":"smtp_not_configured"}', '{"ok":true}', '{"ok":true}']);
    // Five an hour... in ten minutes: the sixth is refused.
    const wait = await test();
    assert.equal(wait.status, 429);
    assert.ok(Number(wait.headers.get('retry-after')) >= 1);
    t.clock.now += 11 * 60_000;
    assert.equal((await test()).status, 200);
    assert.ok(!t.texts.join('\n').includes(PW));
  } finally {
    await server.close();
  }
});

dbTest('a mailer built on the stored settings sends over SMTP and a saved change applies at once', async (db) => {
  const a = await startFakeSmtp();
  const b = await startFakeSmtp();
  try {
    const t = await boot(db);
    const mailer = createConfiguredMailer({ db, masterKey: t.masterKey, env: { allowPrivateHosts: true }, timeoutMs: 800, totalTimeoutMs: 4000 });
    assert.equal(await mailer.configured(), false);
    assert.deepEqual(await mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), { ok: false, code: 'smtp_not_configured' });
    await t.save({ host: '127.0.0.1', port: a.port, secure: 'none', from: 'mrm@example.com' });
    assert.equal(await mailer.configured(), true);
    assert.deepEqual(await mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), { ok: true });
    await t.save({ host: '127.0.0.1', port: b.port, secure: 'none', from: 'mrm@example.com' });
    assert.deepEqual(await mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), { ok: true });
    assert.equal(a.messages.length, 1);
    assert.equal(b.messages.length, 1);
  } finally {
    await a.close();
    await b.close();
  }
});
