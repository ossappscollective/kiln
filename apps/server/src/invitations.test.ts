import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { dbTest } from '@mrm/db/testing';
import { createLoginLimiter } from './limiter.ts';
import {
  PASSWORD,
  acceptInvite,
  addMember,
  auditActions,
  boot,
  cookieOf,
  invite,
  registerOwner,
  seedWorkspace,
  send,
} from './testkit.ts';

const DAY = 24 * 60 * 60 * 1000;

dbTest('a created invitation returns its token once and stores only the hash', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const { res, body } = await invite(app, owner.cookie, owner.workspaceId, {
    email: 'Bob@Example.com',
    role: 'member',
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);

  const rows = await db.query('SELECT * FROM invitations');
  assert.equal(rows.length, 1);
  const row = rows[0] ?? {};
  assert.equal(row.token_hash, createHash('sha256').update(body.token).digest('hex'));
  assert.equal(row.email, 'bob@example.com');
  assert.equal(Number(row.expires_at) - Number(row.created_at), 7 * DAY);
  assert.ok(!Object.values(row).some((v) => String(v).includes(body.token)), 'token not stored');

  const list = await app.request(`/api/workspaces/${owner.workspaceId}/invitations`, send('GET', undefined, owner.cookie));
  const text = await list.text();
  assert.doesNotMatch(text, new RegExp(body.token));
  assert.doesNotMatch(text, /token/i);
  assert.equal((JSON.parse(text) as { invitations: unknown[] }).invitations.length, 1);

  const audit = JSON.stringify(await auditActions(db, owner.workspaceId));
  assert.match(audit, /invitation\.create/);
  assert.doesNotMatch(audit, new RegExp(body.token));
});

dbTest('accepting creates the account, membership, session and audit events', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'Bob@Example.com', role: 'member' });

  const preview = await app.request(`/api/invitations/${body.token}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    workspaceName: 'Acme Apps',
    email: 'bob@example.com',
    role: 'member',
    valid: true,
  });

  const res = await acceptInvite(app, body.token, {
    displayName: ' Bob ',
    password: PASSWORD,
    email: 'someone-else@example.com', // ignored: the address comes from the invitation
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/i);
  const cookie = cookieOf(res);
  const accepted = (await res.json()) as { user: { id: string; email: string; displayName: string }; workspaceId: string; role: string };
  assert.equal(accepted.user.email, 'bob@example.com');
  assert.equal(accepted.user.displayName, 'Bob');
  assert.equal(accepted.workspaceId, owner.workspaceId);
  assert.equal(accepted.role, 'member');

  const me = (await (await app.request('/api/me', send('GET', undefined, cookie))).json()) as {
    workspaces: { id: string; role: string }[];
  };
  assert.deepEqual(me.workspaces.map((w) => [w.id, w.role]), [[owner.workspaceId, 'member']]);

  const login = await app.request('/api/auth/login', send('POST', { email: 'BOB@example.com', password: PASSWORD }));
  assert.equal(login.status, 200);

  const [stored] = await db.query('SELECT accepted_at, accepted_by FROM invitations');
  assert.equal(stored?.accepted_by, accepted.user.id);
  assert.ok(Number(stored?.accepted_at) > 0);

  const audit = await auditActions(db, owner.workspaceId);
  // The test clock stands still, so events share a timestamp and their order is not defined.
  assert.deepEqual(audit.map((a) => a.action).sort(), ['invitation.accept', 'invitation.create', 'workspace.create']);
  assert.equal(audit.find((a) => a.action === 'invitation.create')?.actorId, owner.userId);
  const accept = audit.find((a) => a.action === 'invitation.accept');
  assert.equal(accept?.actorId, accepted.user.id);
  assert.deepEqual(accept?.detail, { email: 'bob@example.com', role: 'member', newAccount: true });

  // The link is spent, and says nothing more than "not found".
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 404);
  assert.equal((await acceptInvite(app, body.token, { displayName: 'X', password: PASSWORD })).status, 404);
  const pending = (await (await app.request(`/api/workspaces/${owner.workspaceId}/invitations`, send('GET', undefined, owner.cookie))).json()) as { invitations: unknown[] };
  assert.equal(pending.invitations.length, 0);
});

dbTest('single use under concurrency: exactly one accept wins', async (db) => {
  // A roomy limit: this test is about single use. The default limit would answer 429 to the sixth.
  const { app } = await boot(db, { inviteLimiter: createLoginLimiter({ max: 100 }) });
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'viewer' });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => acceptInvite(app, body.token, { displayName: `Bob ${i}`, password: PASSWORD })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 404, 404, 404, 404, 404]);
  const [users] = await db.query("SELECT COUNT(*) AS n FROM users WHERE email = 'bob@example.com'");
  assert.equal(Number(users?.n), 1);
  const [members] = await db.query('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?', [owner.workspaceId]);
  assert.equal(Number(members?.n), 2);
  const accepts = (await auditActions(db, owner.workspaceId)).filter((a) => a.action === 'invitation.accept');
  assert.equal(accepts.length, 1);
});

dbTest('an invitation expires after seven days', async (db) => {
  const { app, clock } = await boot(db);
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });

  clock.now += 7 * DAY - 1;
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 200);

  clock.now += 1;
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 404);
  assert.equal((await acceptInvite(app, body.token, { displayName: 'Bob', password: PASSWORD })).status, 404);
  const pending = (await (await app.request(`/api/workspaces/${owner.workspaceId}/invitations`, send('GET', undefined, owner.cookie))).json()) as { invitations: unknown[] };
  assert.equal(pending.invitations.length, 0);
  const [users] = await db.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(Number(users?.n), 1);
});

dbTest('revoking stops the link, is audited, and cannot repeat', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });
  const url = `/api/workspaces/${owner.workspaceId}/invitations/${body.invitation.id}`;

  assert.equal((await app.request(url, send('DELETE', undefined, owner.cookie))).status, 204);
  assert.equal((await app.request(url, send('DELETE', undefined, owner.cookie))).status, 404);
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 404);
  assert.equal((await acceptInvite(app, body.token, { displayName: 'Bob', password: PASSWORD })).status, 404);
  assert.ok((await auditActions(db, owner.workspaceId)).some((a) => a.action === 'invitation.revoke' && a.targetId === body.invitation.id));

  // A new invitation for the same address is possible after a revoke.
  const again = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });
  assert.equal(again.res.status, 201);
});

dbTest('unknown, expired, used and revoked tokens all look the same', async (db) => {
  const { app, clock } = await boot(db);
  const owner = await registerOwner(app);
  const make = async (email: string) => (await invite(app, owner.cookie, owner.workspaceId, { email, role: 'member' })).body;
  const used = await make('used@example.com');
  await acceptInvite(app, used.token, { displayName: 'U', password: PASSWORD });
  const revoked = await make('revoked@example.com');
  await app.request(`/api/workspaces/${owner.workspaceId}/invitations/${revoked.invitation.id}`, send('DELETE', undefined, owner.cookie));
  const expired = await make('expired@example.com');
  clock.now += 8 * DAY;

  const seen = new Set<string>();
  for (const token of [randomBytes(32).toString('base64url'), used.token, revoked.token, expired.token]) {
    for (const res of [await app.request(`/api/invitations/${token}`), await acceptInvite(app, token, { displayName: 'X', password: PASSWORD })]) {
      assert.equal(res.status, 404);
      seen.add(await res.text());
    }
  }
  assert.deepEqual([...seen], ['{"error":"not_found"}']);
});

dbTest('role escalation: only owners invite admins, nobody invites owners, members cannot invite', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const admin = await addMember(app, owner, 'admin@example.com', 'admin');
  const member = await addMember(app, owner, 'member@example.com', 'member');
  const viewer = await addMember(app, owner, 'viewer@example.com', 'viewer');
  assert.equal(admin.status, 201);

  const asAdmin = (role: string) => invite(app, admin.cookie, owner.workspaceId, { email: `${role}-x@example.com`, role });
  assert.equal((await asAdmin('admin')).res.status, 403);
  assert.equal((await asAdmin('owner')).res.status, 400);
  assert.equal((await asAdmin('member')).res.status, 201);
  assert.equal((await asAdmin('viewer')).res.status, 201);

  for (const who of [member, viewer]) {
    const res = await invite(app, who.cookie, owner.workspaceId, { email: 'z@example.com', role: 'viewer' });
    assert.equal(res.res.status, 403);
    const list = await app.request(`/api/workspaces/${owner.workspaceId}/invitations`, send('GET', undefined, who.cookie));
    assert.equal(list.status, 403);
  }
  const ownerInvitesAdmin = await invite(app, owner.cookie, owner.workspaceId, { email: 'new-admin@example.com', role: 'admin' });
  assert.equal(ownerInvitesAdmin.res.status, 201);
  assert.equal((await invite(app, owner.cookie, owner.workspaceId, { email: 'o@example.com', role: 'owner' })).res.status, 400);

  // Revoking is a management action too.
  const pending = await invite(app, owner.cookie, owner.workspaceId, { email: 'p@example.com', role: 'member' });
  const revokeUrl = `/api/workspaces/${owner.workspaceId}/invitations/${pending.body.invitation.id}`;
  assert.equal((await app.request(revokeUrl, send('DELETE', undefined, member.cookie))).status, 403);
});

dbTest('email binding: a new account takes the invited address, a signed-in user must match it', async (db) => {
  const { app, clock } = await boot(db);
  const owner = await registerOwner(app);
  const bob = await addMember(app, owner, 'bob@example.com', 'member');
  const carol = await addMember(app, owner, 'carol@example.com', 'member');
  const other = await seedWorkspace(db, 'Other Co', 'dan@example.com', clock.now);

  // Dan's workspace invites Bob (mixed case) who already has an account here.
  const { body } = await invite(app, other.cookie, other.workspaceId, { email: 'BOB@Example.COM', role: 'viewer' });

  // Anonymous: the account exists, so it must sign in first. The invitation is not spent.
  const anon = await acceptInvite(app, body.token, { displayName: 'Bob', password: PASSWORD });
  assert.equal(anon.status, 409);
  assert.deepEqual(await anon.json(), { error: 'account_exists' });

  // Signed in as someone else.
  const wrong = await acceptInvite(app, body.token, {}, carol.cookie);
  assert.equal(wrong.status, 403);
  assert.deepEqual(await wrong.json(), { error: 'email_mismatch' });
  const [still] = await db.query('SELECT accepted_at FROM invitations WHERE id = ? AND accepted_at IS NOT NULL', [body.invitation.id]);
  assert.equal(still, undefined);

  // Signed in as Bob: no password, no new cookie, a second membership.
  const ok = await acceptInvite(app, body.token, {}, bob.cookie);
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get('set-cookie'), null);
  const me = (await (await app.request('/api/me', send('GET', undefined, bob.cookie))).json()) as {
    workspaces: { id: string; role: string }[];
  };
  assert.deepEqual(
    me.workspaces.map((w) => w.role).sort(),
    ['member', 'viewer'],
  );
  assert.ok((await auditActions(db, other.workspaceId)).some((a) => a.action === 'invitation.accept' && a.actorId === bob.userId));
});

dbTest('accepting while already a member answers 409 and does not spend the link', async (db) => {
  const { app, clock } = await boot(db);
  const owner = await registerOwner(app);
  const bob = await addMember(app, owner, 'bob@example.com', 'member');
  const other = await seedWorkspace(db, 'Other Co', 'dan@example.com', clock.now);
  const { body } = await invite(app, other.cookie, other.workspaceId, { email: 'bob@example.com', role: 'member' });
  // Bob is added to Other Co by some other route while the invitation is pending.
  await db.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [other.workspaceId, bob.userId, 'viewer']);
  const res = await acceptInvite(app, body.token, {}, bob.cookie);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'already_member' });
  const [row] = await db.query('SELECT accepted_at FROM invitations WHERE id = ?', [body.invitation.id]);
  assert.equal(row?.accepted_at, null);
  // Inviting a current member is refused up front.
  const dup = await invite(app, owner.cookie, owner.workspaceId, { email: 'BOB@example.com', role: 'viewer' });
  assert.equal(dup.res.status, 409);
  assert.equal(dup.body.error, 'already_member');
});

dbTest('a second pending invitation for the same address is refused', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });
  const again = await invite(app, owner.cookie, owner.workspaceId, { email: 'Bob@example.com', role: 'viewer' });
  assert.equal(again.res.status, 409);
  assert.equal(again.body.error, 'already_invited');
});

dbTest('accept validates the new account and keeps the invitation usable after a bad form', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });

  const short = await acceptInvite(app, body.token, { displayName: 'Bob', password: 'short' });
  assert.equal(short.status, 400);
  const noName = await acceptInvite(app, body.token, { password: PASSWORD });
  assert.equal(noName.status, 400);
  assert.equal((await acceptInvite(app, body.token, {})).status, 400);
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 200);
  assert.equal((await acceptInvite(app, body.token, { displayName: 'Bob', password: PASSWORD })).status, 201);
});

dbTest('invitations are scoped to their workspace', async (db) => {
  const { app, clock } = await boot(db);
  const owner = await registerOwner(app);
  const other = await seedWorkspace(db, 'Other Co', 'dan@example.com', clock.now);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });

  const base = `/api/workspaces/${owner.workspaceId}/invitations`;
  // Dan is no member of Acme: the workspace looks like it does not exist.
  assert.equal((await app.request(base, send('GET', undefined, other.cookie))).status, 404);
  assert.equal((await invite(app, other.cookie, owner.workspaceId, { email: 'x@example.com', role: 'member' })).res.status, 404);
  assert.equal((await app.request(`${base}/${body.invitation.id}`, send('DELETE', undefined, other.cookie))).status, 404);
  // Through his own workspace's URL, the id of Acme's invitation is not found either.
  const ownBase = `/api/workspaces/${other.workspaceId}/invitations/${body.invitation.id}`;
  assert.equal((await app.request(ownBase, send('DELETE', undefined, other.cookie))).status, 404);
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 200);

  // The list of one workspace never shows the other's.
  await invite(app, other.cookie, other.workspaceId, { email: 'eve@example.com', role: 'viewer' });
  const mine = (await (await app.request(base, send('GET', undefined, owner.cookie))).json()) as { invitations: { email: string }[] };
  assert.deepEqual(mine.invitations.map((i) => i.email), ['bob@example.com']);
});

dbTest('management endpoints need a session', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const base = `/api/workspaces/${owner.workspaceId}`;
  assert.equal((await app.request(`${base}/invitations`)).status, 401);
  assert.equal((await app.request(`${base}/invitations`, send('POST', { email: 'a@b.co', role: 'member' }))).status, 401);
  assert.equal((await app.request(`${base}/members`)).status, 401);
});

dbTest('repeated bad attempts on one link are rate limited, and other links are not affected', async (db) => {
  const inviteLimiter = createLoginLimiter({ max: 3 });
  const { app } = await boot(db, { inviteLimiter });
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'bob@example.com', role: 'member' });
  const bad = randomBytes(32).toString('base64url');
  for (let i = 0; i < 3; i++) assert.equal((await app.request(`/api/invitations/${bad}`)).status, 404);
  const blocked = await app.request(`/api/invitations/${bad}`);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await acceptInvite(app, bad, { displayName: 'X', password: PASSWORD })).status, 429);
  assert.equal((await app.request(`/api/invitations/${body.token}`)).status, 200);
});

dbTest('rejected accepts count against the link', async (db) => {
  const inviteLimiter = createLoginLimiter({ max: 2 });
  const { app, clock } = await boot(db, { inviteLimiter });
  const owner = await registerOwner(app);
  const carol = await addMember(app, owner, 'carol@example.com', 'member');
  const other = await seedWorkspace(db, 'Other Co', 'dan@example.com', clock.now);
  const { body } = await invite(app, other.cookie, other.workspaceId, { email: 'bob@example.com', role: 'member' });
  assert.equal((await acceptInvite(app, body.token, {}, carol.cookie)).status, 403);
  assert.equal((await acceptInvite(app, body.token, {}, carol.cookie)).status, 403);
  assert.equal((await acceptInvite(app, body.token, {}, carol.cookie)).status, 429);
});

dbTest('registration stays closed; invitations are the only way in', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  await addMember(app, owner, 'bob@example.com', 'member');
  const res = await app.request(
    '/api/auth/register',
    send('POST', { email: 'eve@example.com', displayName: 'Eve', password: PASSWORD, workspaceName: 'Mine' }),
  );
  assert.equal(res.status, 403);
});

dbTest('single-user mode turns every invitation endpoint off', async (db) => {
  const PORT = 8787;
  const secret = randomBytes(32).toString('base64url');
  const { app } = await boot(db, { singleUser: { launchSecret: secret, port: PORT } });
  const host = { host: `127.0.0.1:${PORT}` };
  const launch = await app.request(`/api/auth/launch?secret=${encodeURIComponent(secret)}`, { headers: host });
  const cookie = cookieOf(launch);
  assert.ok(cookie);
  const me = (await (await app.request('/api/me', { headers: { ...host, cookie } })).json()) as {
    workspaces: { id: string }[];
  };
  const wid = me.workspaces[0]?.id;

  const expected = { error: 'disabled_in_single_user_mode' };
  const check = async (res: Response) => {
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, expected.error);
  };
  await check(await app.request(`/api/workspaces/${wid}/invitations`, { headers: { ...host, cookie } }));
  await check(
    await app.request(`/api/workspaces/${wid}/invitations`, send('POST', { email: 'a@b.co', role: 'member' }, cookie, host)),
  );
  await check(await app.request('/api/invitations/sometoken', { headers: host }));
  await check(await app.request('/api/invitations/sometoken/accept', send('POST', {}, undefined, host)));
});

dbTest('a link from someone who can no longer invite that role stops working, at preview and at accept', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const alice = await addMember(app, owner, 'alice@example.com', 'admin');

  const fresh = async (email: string) =>
    (await invite(app, alice.cookie, owner.workspaceId, { email, role: 'member' })).body.token;
  const bob = await fresh('bob@example.com');
  const carol = await fresh('carol@example.com');
  const dan = await fresh('dan@example.com');
  assert.equal((await app.request(`/api/invitations/${bob}`)).status, 200, 'works while alice is an admin');

  // Demoted to member: may no longer invite.
  await db.execute('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [
    'member',
    owner.workspaceId,
    alice.userId,
  ]);
  assert.equal((await app.request(`/api/invitations/${bob}`)).status, 404);
  assert.equal((await acceptInvite(app, bob, { displayName: 'Bob', password: PASSWORD })).status, 404);

  // Removed from the workspace.
  await db.execute('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
    owner.workspaceId,
    alice.userId,
  ]);
  assert.equal((await acceptInvite(app, carol, { displayName: 'Carol', password: PASSWORD })).status, 404);

  // Nobody was added, and no account was created.
  const [n] = await db.query("SELECT COUNT(*) AS n FROM users WHERE email IN ('bob@example.com','carol@example.com')");
  assert.equal(Number(n?.n), 0);

  // Restored as admin, the links work again (the check is live, nothing was revoked).
  await db.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
    owner.workspaceId,
    alice.userId,
    'admin',
  ]);
  assert.equal((await acceptInvite(app, dan, { displayName: 'Dan', password: PASSWORD })).status, 201);
});

dbTest('an admin link for an admin role dies when the owner who made it is no longer an owner', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email: 'erin@example.com', role: 'admin' });
  await db.execute('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [
    'admin',
    owner.workspaceId,
    owner.userId,
  ]);
  assert.equal((await acceptInvite(app, body.token, { displayName: 'Erin', password: PASSWORD })).status, 404);
});
