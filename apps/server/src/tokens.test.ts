import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { isBearerOnly } from './http.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import { SESSION_COOKIE } from './routes/auth.ts';
import { listAudit } from './services/audit.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { looksLikeToken, tokenHash } from './services/tokens.ts';
import { seedWorkspace } from './testkit.ts';

type Boot = Awaited<ReturnType<typeof bootRepoApp>>;
type Options = NonNullable<Parameters<typeof bootRepoApp>[2]>;

const boot = (db: Parameters<typeof bootRepoApp>[0], overrides: Options = {}) => bootRepoApp(db, undefined, overrides);

type Input = { name?: string; role?: string; appIds?: string[]; actions?: string[]; expiresAt?: number };

/** Makes a token with the owner's session. Returns the secret and the summary. */
async function makeToken(t: Boot, input: Input = {}, cookie = t.owner) {
  const res = await t.call(cookie, 'POST', '/tokens', { name: 'CI', role: 'admin', ...input });
  return { res, token: res.body?.token as string, summary: res.body?.summary };
}

/** A request with `Authorization: Bearer`, and no cookie. */
const bearer = (
  t: Boot,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  workspace = t.workspaceId,
) =>
  t.app.request(path.startsWith('/api/') ? path : `/api/workspaces/${workspace}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
const json = async (res: Response) => (await res.json()) as Record<string, any>;

async function insertApp(t: Boot, id: string, workspaceId = t.workspaceId) {
  await t.db.execute(
    `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
     VALUES (?, ?, ?, 'ios', ?, 'c', 1)`,
    [id, workspaceId, `App ${id}`, `com.acme.${id}`],
  );
}

// ----- creating and storing -----------------------------------------------------------------

dbTest('a token is mrm_ plus 256 random bits, shown once, and only its SHA-256 is stored', async (db) => {
  const t = await boot(db);
  const { res, token, summary } = await makeToken(t, { name: 'Release CI' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(token, /^mrm_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token.slice(4), 'base64url').length, 32);
  assert.equal(summary.name, 'Release CI');
  assert.equal(summary.role, 'admin');
  assert.equal(summary.status, 'active');
  assert.equal(summary.lastUsedAt, null);
  assert.equal(summary.prefix, token.slice(0, 10));
  assert.equal(JSON.stringify(summary).includes(token), false);

  const [row] = await db.query('SELECT token_hash FROM api_tokens');
  assert.equal(row?.token_hash, createHash('sha256').update(token).digest('hex'));
  // The token is nowhere in the database: not in the table, not in the audit log.
  for (const table of ['api_tokens', 'audit_events', 'events']) {
    const rows = await db.query(`SELECT * FROM ${table}`);
    assert.equal(JSON.stringify(rows).includes(token), false, table);
    assert.equal(JSON.stringify(rows).includes(token.slice(4)), false, table);
  }
  // Listing never shows it again.
  const list = await t.call(t.owner, 'GET', '/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.text.includes(token), false);
  assert.equal(list.body.tokens.length, 1);
  assert.deepEqual(Object.keys(list.body.tokens[0]).sort(), [
    'actions', 'appIds', 'createdAt', 'createdBy', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt', 'role', 'status',
  ]);
  assert.notEqual((await makeToken(t)).token, token);
});

test('tokenHash and looksLikeToken', () => {
  assert.equal(tokenHash('a'), createHash('sha256').update('a').digest('hex'));
  assert.equal(looksLikeToken(`mrm_${'a'.repeat(43)}`), true);
  assert.equal(looksLikeToken(`mrm_${'a'.repeat(42)}`), false);
  assert.equal(looksLikeToken(`xrm_${'a'.repeat(43)}`), false);
  assert.equal(looksLikeToken(`mrm_${'a'.repeat(43)}\n`), false);
});

dbTest('creating and revoking a token is audited, without the token', async (db) => {
  const t = await boot(db);
  const { token, summary } = await makeToken(t, { name: 'CI', role: 'member', actions: ['apps.read'] });
  const created = (await t.auditActions()).find((a) => a.action === 'token.create');
  assert.ok(created);
  assert.equal(created.actorType, 'user');
  assert.equal(created.targetId, summary.id);
  assert.equal(created.detail.includes(token), false);
  assert.match(created.detail, /"role":"member"/);
  await t.call(t.owner, 'DELETE', `/tokens/${summary.id}`);
  assert.ok((await t.auditActions()).some((a) => a.action === 'token.revoke' && a.targetId === summary.id));
});

dbTest('who may make tokens: owners and admins, never owner tokens, not other workspaces', async (db) => {
  const t = await boot(db);
  const admin = await t.addMember('admin');
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  assert.equal((await makeToken(t, {}, admin)).res.status, 201);
  assert.equal((await makeToken(t, {}, member)).res.status, 403);
  assert.equal((await makeToken(t, {}, viewer)).res.status, 403);
  assert.equal((await t.call(member, 'GET', '/tokens')).status, 403);
  assert.equal((await t.call(viewer, 'GET', '/tokens')).status, 403);
  assert.equal((await t.call(admin, 'GET', '/tokens')).status, 200);
  const owner = await makeToken(t, { role: 'owner' });
  assert.equal(owner.res.status, 400);
  assert.equal(owner.res.body.error, 'invalid_request');
  assert.equal((await t.app.request(`/api/workspaces/${t.workspaceId}/tokens`)).status, 401);
  const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
  assert.equal((await t.call(other.cookie, 'GET', '/tokens')).status, 404);
});

dbTest('a token cannot hold forbidden actions, actions above its role, or unknown apps', async (db) => {
  const t = await boot(db);
  const forbidden = await makeToken(t, { actions: ['credentials.write'] });
  assert.equal(forbidden.res.status, 400);
  assert.equal(forbidden.res.body.error, 'action_not_allowed');
  for (const action of ['tokens.manage', 'members.manage', 'webhooks.manage']) {
    assert.equal((await makeToken(t, { actions: [action] })).res.body.error, 'action_not_allowed', action);
  }
  const above = await makeToken(t, { role: 'viewer', actions: ['apps.sync'] });
  assert.equal(above.res.status, 400);
  assert.equal(above.res.body.error, 'action_above_role');
  assert.equal((await makeToken(t, { actions: ['not.an.action'] })).res.status, 400);
  assert.equal((await makeToken(t, { name: '' })).res.status, 400);
  assert.equal((await makeToken(t, { appIds: ['nope'] })).res.body.error, 'unknown_app');
  assert.equal((await makeToken(t, { expiresAt: 5 })).res.status, 400);
});

dbTest('token creation has a body limit', async (db) => {
  const t = await boot(db);
  const res = await t.call(t.owner, 'POST', '/tokens', { name: 'x'.repeat(20_000), role: 'viewer' });
  assert.equal(res.status, 413);
});

// ----- using a token ------------------------------------------------------------------------

dbTest('a bearer token authenticates; a wrong or revoked one does not', async (db) => {
  const t = await boot(db);
  const { token, summary } = await makeToken(t);
  const ok = await bearer(t, token, 'GET', '/apps');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { apps: [] });

  const wrong = await bearer(t, `mrm_${'A'.repeat(43)}`, 'GET', '/apps');
  assert.equal(wrong.status, 401);
  assert.equal((await json(wrong)).error, 'invalid_token');
  assert.match(wrong.headers.get('www-authenticate') ?? '', /invalid_token/);
  assert.equal((await bearer(t, 'garbage', 'GET', '/apps')).status, 401);
  assert.equal((await t.app.request(`/api/workspaces/${t.workspaceId}/apps`)).status, 401);

  assert.equal((await t.call(t.owner, 'DELETE', `/tokens/${summary.id}`)).status, 204);
  assert.equal((await bearer(t, token, 'GET', '/apps')).status, 401);
  // Revoking again is fine and changes nothing.
  assert.equal((await t.call(t.owner, 'DELETE', `/tokens/${summary.id}`)).status, 204);
  assert.equal((await t.call(t.owner, 'GET', '/tokens')).body.tokens[0].status, 'revoked');
  assert.equal((await t.auditActions()).filter((a) => a.action === 'token.revoke').length, 1);
  assert.equal((await t.call(t.owner, 'DELETE', '/tokens/nope')).status, 404);
});

dbTest('an expired token stops working at its expiry', async (db) => {
  const t = await boot(db);
  const soon = Date.now() + 60_000;
  const { token, summary } = await makeToken(t, { expiresAt: soon });
  assert.equal(summary.expiresAt, soon);
  assert.equal((await bearer(t, token, 'GET', '/apps')).status, 200);
  await db.execute('UPDATE api_tokens SET expires_at = ?', [1]);
  assert.equal((await bearer(t, token, 'GET', '/apps')).status, 401);
  assert.equal((await t.call(t.owner, 'GET', '/tokens')).body.tokens[0].status, 'expired');
});

dbTest('last used is recorded, at most once a minute', async (db) => {
  const t = await boot(db);
  const { token } = await makeToken(t);
  assert.equal((await t.call(t.owner, 'GET', '/tokens')).body.tokens[0].lastUsedAt, null);
  await bearer(t, token, 'GET', '/apps');
  const first = (await t.call(t.owner, 'GET', '/tokens')).body.tokens[0].lastUsedAt;
  assert.equal(typeof first, 'number');
  await bearer(t, token, 'GET', '/apps');
  assert.equal((await t.call(t.owner, 'GET', '/tokens')).body.tokens[0].lastUsedAt, first);
});

dbTest('a token dies with its creator’s membership and is lowered by a demotion', async (db) => {
  const t = await boot(db);
  const admin = await t.addMember('admin');
  const id = `user-admin-${t.workspaceId}`;
  const { token } = await makeToken(t, { role: 'admin' }, admin);
  // As admin it may add apps (the body is checked first, so a 400 means it got through).
  assert.equal((await bearer(t, token, 'POST', '/apps', {})).status, 400);
  await db.execute("UPDATE workspace_members SET role = 'viewer' WHERE user_id = ?", [id]);
  assert.equal((await bearer(t, token, 'POST', '/apps', {})).status, 403);
  assert.equal((await bearer(t, token, 'GET', '/apps')).status, 200);
  await db.execute('DELETE FROM workspace_members WHERE user_id = ?', [id]);
  assert.equal((await bearer(t, token, 'GET', '/apps')).status, 401);
});

// ----- what a token may do ------------------------------------------------------------------

dbTest('the role ceiling and the action list limit a token', async (db) => {
  const t = await boot(db);
  const viewer = (await makeToken(t, { role: 'viewer' })).token;
  const member = (await makeToken(t, { role: 'member' })).token;
  const admin = (await makeToken(t, { role: 'admin' })).token;
  const readOnly = (await makeToken(t, { role: 'admin', actions: ['apps.read'] })).token;

  for (const token of [viewer, member, admin, readOnly]) assert.equal((await bearer(t, token, 'GET', '/apps')).status, 200);
  assert.equal((await bearer(t, viewer, 'GET', '/credentials')).status, 403);
  assert.equal((await bearer(t, member, 'GET', '/credentials')).status, 200);
  assert.equal((await bearer(t, admin, 'GET', '/credentials')).status, 200);
  assert.equal((await bearer(t, readOnly, 'GET', '/credentials')).status, 403);
  assert.equal((await bearer(t, member, 'POST', '/apps', {})).status, 403);
  assert.equal((await bearer(t, admin, 'POST', '/apps', {})).status, 400);
  assert.equal((await bearer(t, readOnly, 'POST', '/apps', {})).status, 403);
  // Syncing needs apps.sync: a viewer ceiling has none, a member has it (404: no such app).
  assert.equal((await bearer(t, viewer, 'POST', '/apps/x/sync')).status, 403);
  assert.equal((await bearer(t, member, 'POST', '/apps/x/sync')).status, 404);
  assert.equal((await json(await bearer(t, viewer, 'GET', '/credentials'))).error, 'forbidden');
});

dbTest('no token can manage tokens, members, invitations, credential values or webhooks', async (db) => {
  const t = await boot(db);
  const admin = (await makeToken(t, { role: 'admin' })).token;
  const credential = await t.addCredential();
  const calls: [string, string, unknown?][] = [
    ['GET', '/tokens'],
    ['POST', '/tokens', { name: 'x', role: 'viewer' }],
    ['DELETE', '/tokens/x'],
    ['PATCH', '/members/x', { role: 'viewer' }],
    ['DELETE', '/members/x'],
    ['GET', '/invitations'],
    ['POST', '/invitations', { email: 'a@b.io', role: 'member' }],
    ['POST', '/credentials', { kind: 'github_token', label: 'x', secret: 'y' }],
    ['PUT', `/credentials/${credential}`, { secret: 'y' }],
    ['DELETE', `/credentials/${credential}`],
    ['POST', `/credentials/${credential}/test`],
    ['POST', '/credentials/test', { kind: 'github_token', secret: 'y' }],
    ['GET', '/webhooks'],
    ['POST', '/webhooks', { url: 'https://example.com/h', eventTypes: ['*'] }],
  ];
  for (const [method, path, body] of calls) {
    const res = await bearer(t, admin, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await json(res)).error, 'token_not_allowed', `${method} ${path}`);
  }
  assert.equal((await t.call(t.owner, 'GET', '/credentials')).body.credentials.length, 1);
  // The member list is readable (members.read). /api/me is for sessions only.
  assert.equal((await bearer(t, admin, 'GET', '/members')).status, 200);
  assert.equal((await bearer(t, admin, 'GET', '/api/me')).status, 401);
  // A route that is not in the registry is closed to tokens.
  assert.equal((await bearer(t, admin, 'GET', '/no-such-thing')).status, 403);
});

dbTest('a token works in its own workspace only; another workspace looks absent', async (db) => {
  const t = await boot(db);
  const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
  const mine = (await makeToken(t)).token;
  const res = await bearer(t, mine, 'GET', '/apps', undefined, {}, other.workspaceId);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  assert.equal((await bearer(t, mine, 'GET', '/tokens', undefined, {}, other.workspaceId)).status, 404);
  // A token made in the other workspace does not open this one.
  const made = await t.call(other.cookie, 'POST', '/tokens', { name: 'o', role: 'admin' }, other.workspaceId);
  assert.equal(made.status, 201);
  assert.equal((await bearer(t, made.body.token, 'GET', '/apps')).status, 404);
  assert.equal((await bearer(t, made.body.token, 'GET', '/apps', undefined, {}, other.workspaceId)).status, 200);
  // Lists and revocation are per workspace.
  assert.equal((await t.call(t.owner, 'GET', '/tokens')).body.tokens.length, 1);
  assert.equal((await t.call(t.owner, 'DELETE', `/tokens/${made.body.summary.id}`)).status, 404);
  assert.equal((await t.call(other.cookie, 'DELETE', `/tokens/${made.body.summary.id}`, undefined, other.workspaceId)).status, 204);
});

dbTest('a token limited to apps sees and touches only those', async (db) => {
  const t = await boot(db);
  await insertApp(t, 'a1');
  await insertApp(t, 'a2');
  const { token, summary } = await makeToken(t, { appIds: ['a1'] });
  assert.deepEqual(summary.appIds, ['a1']);
  const list = await json(await bearer(t, token, 'GET', '/apps'));
  assert.deepEqual(list.apps.map((a: { id: string }) => a.id), ['a1']);
  assert.equal((await bearer(t, token, 'GET', '/apps/a1')).status, 200);
  assert.equal((await bearer(t, token, 'GET', '/apps/a2')).status, 404);
  assert.equal((await bearer(t, token, 'POST', '/apps/a2/sync')).status, 404);
  assert.equal((await bearer(t, token, 'DELETE', '/apps/a2')).status, 404);
  // Workspace wide endpoints are closed to it.
  assert.equal((await bearer(t, token, 'GET', '/repositories')).status, 403);
  assert.equal((await bearer(t, token, 'GET', '/credentials')).status, 403);
  assert.equal((await bearer(t, token, 'POST', '/apps', {})).status, 403);
  // The OpenAPI document is not in a workspace.
  assert.equal((await bearer(t, token, 'GET', '/api/openapi.json')).status, 200);
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 2);
});

dbTest('every write by a token is audited as the token, on behalf of its creator', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const read = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].subtitle = 'From CI';
  const { token, summary } = await makeToken(t, { name: 'Release bot', role: 'member' });
  const res = await bearer(t, token, 'POST', `/repositories/${repositoryId}/change-sets`, { summary: 'From CI', listing });
  assert.equal(res.status, 201);
  const row = (await t.auditActions()).find((a) => a.action === 'changeset.create');
  assert.ok(row);
  assert.equal(row.actorType, 'token');
  assert.equal(row.actorId, summary.id);
  const ownerId = String((await db.query('SELECT id FROM users WHERE email = ?', ['ada@example.com']))[0]?.id);
  assert.equal(JSON.parse(row.detail).onBehalfOf, ownerId);
  const entry = (await listAudit(db, t.workspaceId)).find((e) => e.action === 'changeset.create');
  assert.equal(entry?.actorType, 'token');
  assert.equal(entry?.actorName, 'Release bot');
  // The same call with the session is a user.
  assert.equal((await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, { summary: 'By hand', listing })).status, 201);
  const rows = (await t.auditActions()).filter((a) => a.action === 'changeset.create');
  assert.deepEqual(rows.map((r) => r.actorType), ['token', 'user']);
});

dbTest('a role the route reads is capped at the token ceiling: an owner’s member token cannot discard others’ drafts', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const member = await t.addMember('member');
  const { id } = await t.draft(repositoryId, 'Mine', member);
  assert.ok(id);
  const { token } = await makeToken(t, { role: 'member' });
  const refused = await bearer(t, token, 'POST', `/change-sets/${id}/discard`);
  assert.notEqual(refused.status, 200);
  assert.equal((await t.call(t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status, 'draft');
  // The owner's own session may discard it.
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/discard`)).status, 200);
});

// ----- cookies, same-origin and rate limits ---------------------------------------------------

dbTest('bearer requests skip the same-origin check; cookie requests keep it, with or without a bearer header', async (db) => {
  const t = await boot(db);
  const { token } = await makeToken(t);
  const evil = { origin: 'https://evil.example' };
  const post = (headers: Record<string, string>) =>
    t.app.request(`/api/workspaces/${t.workspaceId}/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    });

  // A cookie request from another origin is refused, as before.
  const cookieEvil = await post({ cookie: t.owner, ...evil });
  assert.equal(cookieEvil.status, 403);
  assert.equal((await json(cookieEvil)).error, 'bad_origin');
  // So is one that also has a bearer header: the cookie decides.
  assert.equal((await post({ cookie: t.owner, authorization: `Bearer ${token}`, ...evil })).status, 403);
  // A bearer request with no cookie is not tied to a browser, so Origin does not matter.
  assert.equal((await bearer(t, token, 'POST', '/apps', {}, evil)).status, 400);
  // An invalid token from another origin is a 401, not a pass.
  assert.equal((await bearer(t, 'mrm_x', 'POST', '/apps', {}, evil)).status, 401);
  // With the cookie, the bearer header is not what authenticates, so garbage in it changes nothing...
  const withGarbage = await t.app.request(`/api/workspaces/${t.workspaceId}/apps`, {
    headers: { cookie: t.owner, authorization: 'Bearer garbage' },
  });
  assert.equal(withGarbage.status, 200);
  // ...and a bad cookie next to a good token does not fall through to the token.
  const badCookie = await t.app.request(`/api/workspaces/${t.workspaceId}/apps`, {
    headers: { cookie: `${SESSION_COOKIE}=nope`, authorization: `Bearer ${token}` },
  });
  assert.equal(badCookie.status, 401);
  // A same-origin cookie request without an Origin header works as ever.
  assert.equal((await t.call(t.owner, 'POST', '/apps', {})).status, 400);
});

test('isBearerOnly: a bearer header and no session cookie', () => {
  const c = (headers: Record<string, string>) =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as Parameters<typeof isBearerOnly>[0];
  assert.equal(isBearerOnly(c({ authorization: 'Bearer mrm_abc' })), true);
  assert.equal(isBearerOnly(c({ authorization: 'bearer mrm_abc', cookie: 'theme=dark' })), true);
  assert.equal(isBearerOnly(c({ authorization: 'Bearer mrm_abc', cookie: `${SESSION_COOKIE}=abc` })), false);
  assert.equal(isBearerOnly(c({ authorization: 'Bearer mrm_abc', cookie: `a=b; ${SESSION_COOKIE}=` })), false);
  assert.equal(isBearerOnly(c({ authorization: 'Bearer mrm_abc', cookie: `x${SESSION_COOKIE}=1` })), true);
  assert.equal(isBearerOnly(c({ authorization: 'Basic abc' })), false);
  assert.equal(isBearerOnly(c({})), false);
});

dbTest('tokens have their own rate limit per token; cookie requests are not counted', async (db) => {
  const t = await boot(db, { tokens: { limiter: createTestLimiter({ limit: 3 }) } });
  const a = (await makeToken(t, { name: 'a' })).token;
  const b = (await makeToken(t, { name: 'b' })).token;
  for (let i = 0; i < 3; i++) assert.equal((await bearer(t, a, 'GET', '/apps')).status, 200);
  const limited = await bearer(t, a, 'GET', '/apps');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await json(limited)).error, 'rate_limited');
  assert.equal((await bearer(t, b, 'GET', '/apps')).status, 200);
  for (let i = 0; i < 6; i++) assert.equal((await t.call(t.owner, 'GET', '/apps')).status, 200);
});

dbTest('bad tokens count against the client address', async (db) => {
  const { createLoginLimiter } = await import('./limiter.ts');
  const t = await boot(db, { trustProxy: true, tokens: { badTokenLimiter: createLoginLimiter({ max: 3 }) } });
  const { token } = await makeToken(t);
  const from = (ip: string) => ({ 'x-forwarded-for': ip });
  for (let i = 0; i < 3; i++) assert.equal((await bearer(t, 'mrm_bad', 'GET', '/apps', undefined, from('203.0.113.9'))).status, 401);
  const blocked = await bearer(t, token, 'GET', '/apps', undefined, from('203.0.113.9'));
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  // Another address is unaffected.
  assert.equal((await bearer(t, token, 'GET', '/apps', undefined, from('203.0.113.10'))).status, 200);
});
