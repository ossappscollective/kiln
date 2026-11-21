import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { addMember, auditActions, boot, registerOwner, seedWorkspace, send } from './testkit.ts';

type MemberRow = { userId: string; email: string; displayName: string; role: string };

const list = async (app: Awaited<ReturnType<typeof boot>>['app'], cookie: string, wid: string) => {
  const res = await app.request(`/api/workspaces/${wid}/members`, send('GET', undefined, cookie));
  return {
    status: res.status,
    members: res.status === 200 ? ((await res.json()) as { members: MemberRow[] }).members : [],
  };
};

const setRole = (
  app: Awaited<ReturnType<typeof boot>>['app'],
  cookie: string,
  wid: string,
  userId: string,
  role: string,
) => app.request(`/api/workspaces/${wid}/members/${userId}`, send('PATCH', { role }, cookie));

const remove = (
  app: Awaited<ReturnType<typeof boot>>['app'],
  cookie: string,
  wid: string,
  userId: string,
) => app.request(`/api/workspaces/${wid}/members/${userId}`, send('DELETE', undefined, cookie));

dbTest('members, admins and owners can read the list; viewers cannot', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const member = await addMember(app, owner, 'member@example.com', 'member', 'Mia');
  const viewer = await addMember(app, owner, 'viewer@example.com', 'viewer', 'Vic');
  const admin = await addMember(app, owner, 'admin@example.com', 'admin', 'Al');

  for (const who of [owner, member, admin]) {
    const { status, members } = await list(app, who.cookie, owner.workspaceId);
    assert.equal(status, 200);
    assert.deepEqual(
      members.map((m) => [m.displayName, m.role]),
      [
        ['Ada', 'owner'],
        ['Al', 'admin'],
        ['Mia', 'member'],
        ['Vic', 'viewer'],
      ],
    );
    assert.equal(members[0]?.email, 'ada@example.com');
  }
  assert.equal((await list(app, viewer.cookie, owner.workspaceId)).status, 403);
});

dbTest(
  'the list shows nothing of other workspaces and hides the workspace from outsiders',
  async (db) => {
    const { app, clock } = await boot(db);
    const owner = await registerOwner(app);
    await addMember(app, owner, 'bob@example.com', 'member');
    const other = await seedWorkspace(db, 'Other Co', 'dan@example.com', clock.now);
    assert.equal((await list(app, other.cookie, owner.workspaceId)).status, 404);
    const mine = await list(app, other.cookie, other.workspaceId);
    assert.deepEqual(
      mine.members.map((m) => m.email),
      ['dan@example.com'],
    );
  },
);

dbTest('owners change roles, and each change is audited', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const bob = await addMember(app, owner, 'bob@example.com', 'member');
  assert.equal(
    (await setRole(app, owner.cookie, owner.workspaceId, bob.userId, 'admin')).status,
    204,
  );
  assert.equal(
    (await list(app, owner.cookie, owner.workspaceId)).members.find((m) => m.userId === bob.userId)
      ?.role,
    'admin',
  );
  const change = (await auditActions(db, owner.workspaceId)).find(
    (a) => a.action === 'member.role_change',
  );
  assert.equal(change?.actorId, owner.userId);
  assert.equal(change?.targetId, bob.userId);
  assert.deepEqual(change?.detail, { from: 'member', to: 'admin' });

  // Setting the role someone already has changes nothing and records nothing.
  assert.equal(
    (await setRole(app, owner.cookie, owner.workspaceId, bob.userId, 'admin')).status,
    204,
  );
  const changes = (await auditActions(db, owner.workspaceId)).filter(
    (a) => a.action === 'member.role_change',
  );
  assert.equal(changes.length, 1);

  assert.equal(
    (await setRole(app, owner.cookie, owner.workspaceId, bob.userId, 'root')).status,
    400,
  );
  assert.equal(
    (await setRole(app, owner.cookie, owner.workspaceId, 'no-such-user', 'member')).status,
    404,
  );
});

dbTest('role escalation by admins, members and viewers is refused', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const admin = await addMember(app, owner, 'admin@example.com', 'admin');
  const admin2 = await addMember(app, owner, 'admin2@example.com', 'admin');
  const member = await addMember(app, owner, 'member@example.com', 'member');
  const viewer = await addMember(app, owner, 'viewer@example.com', 'viewer');
  const w = owner.workspaceId;

  // An admin may move members and viewers between member and viewer, nothing else.
  assert.equal((await setRole(app, admin.cookie, w, viewer.userId, 'member')).status, 204);
  assert.equal((await setRole(app, admin.cookie, w, viewer.userId, 'admin')).status, 403);
  assert.equal((await setRole(app, admin.cookie, w, viewer.userId, 'owner')).status, 403);
  assert.equal((await setRole(app, admin.cookie, w, admin2.userId, 'member')).status, 403);
  assert.equal((await setRole(app, admin.cookie, w, owner.userId, 'member')).status, 403);
  assert.equal((await setRole(app, admin.cookie, w, admin.userId, 'owner')).status, 403);

  // Members and viewers cannot change anyone, themselves included.
  assert.equal((await setRole(app, member.cookie, w, member.userId, 'admin')).status, 403);
  assert.equal((await setRole(app, viewer.cookie, w, viewer.userId, 'owner')).status, 403);
  assert.equal((await setRole(app, member.cookie, w, viewer.userId, 'viewer')).status, 403);

  const roles = Object.fromEntries(
    (await list(app, owner.cookie, w)).members.map((m) => [m.email, m.role]),
  );
  assert.deepEqual(roles, {
    'ada@example.com': 'owner',
    'admin@example.com': 'admin',
    'admin2@example.com': 'admin',
    'member@example.com': 'member',
    'viewer@example.com': 'member',
  });
});

dbTest(
  'the last owner can be neither demoted nor removed; with a second owner they can',
  async (db) => {
    const { app } = await boot(db);
    const owner = await registerOwner(app);
    const bob = await addMember(app, owner, 'bob@example.com', 'member');
    const w = owner.workspaceId;

    const demote = await setRole(app, owner.cookie, w, owner.userId, 'admin');
    assert.equal(demote.status, 409);
    assert.equal(((await demote.json()) as { error: string }).error, 'last_owner');
    const leave = await remove(app, owner.cookie, w, owner.userId);
    assert.equal(leave.status, 409);
    assert.equal(((await leave.json()) as { error: string }).error, 'last_owner');
    assert.equal((await list(app, owner.cookie, w)).members.length, 2);

    // Promote Bob to owner; now Ada may step down.
    assert.equal((await setRole(app, owner.cookie, w, bob.userId, 'owner')).status, 204);
    assert.equal((await setRole(app, owner.cookie, w, owner.userId, 'admin')).status, 204);
    // Bob is the last owner now.
    assert.equal((await setRole(app, bob.cookie, w, bob.userId, 'member')).status, 409);
    assert.equal((await remove(app, bob.cookie, w, bob.userId)).status, 409);
    // An admin (Ada, now) cannot remove the last owner either.
    assert.equal((await remove(app, owner.cookie, w, bob.userId)).status, 403);
  },
);

dbTest('two owners demoting each other at once leave one owner', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const bob = await addMember(app, owner, 'bob@example.com', 'member');
  const w = owner.workspaceId;
  await setRole(app, owner.cookie, w, bob.userId, 'owner');

  const results = await Promise.all([
    setRole(app, owner.cookie, w, bob.userId, 'viewer'),
    setRole(app, bob.cookie, w, owner.userId, 'viewer'),
  ]);
  // The loser is refused: either as the last owner (409) or because the winner already demoted them (403).
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses[0], 204);
  assert.ok(statuses[1] === 403 || statuses[1] === 409, `second was ${statuses[1]}`);
  const owners = (await list(app, owner.cookie, w)).members.filter((m) => m.role === 'owner');
  assert.equal(owners.length, 1);
});

dbTest(
  'removing members: owners anyone, admins only members and viewers, and each is audited',
  async (db) => {
    const { app } = await boot(db);
    const owner = await registerOwner(app);
    const admin = await addMember(app, owner, 'admin@example.com', 'admin');
    const admin2 = await addMember(app, owner, 'admin2@example.com', 'admin');
    const member = await addMember(app, owner, 'member@example.com', 'member');
    const viewer = await addMember(app, owner, 'viewer@example.com', 'viewer');
    const w = owner.workspaceId;

    assert.equal((await remove(app, admin.cookie, w, admin2.userId)).status, 403);
    assert.equal((await remove(app, admin.cookie, w, owner.userId)).status, 403); // an admin may not touch owners, sole or not
    assert.equal((await remove(app, member.cookie, w, viewer.userId)).status, 403);
    assert.equal((await remove(app, admin.cookie, w, viewer.userId)).status, 204);
    assert.equal((await remove(app, admin.cookie, w, viewer.userId)).status, 404);
    assert.equal((await remove(app, owner.cookie, w, admin2.userId)).status, 204);

    const removed = (await auditActions(db, w)).filter((a) => a.action === 'member.remove');
    assert.deepEqual(removed.map((a) => a.targetId).sort(), [admin2.userId, viewer.userId].sort());
    assert.ok(removed.every((a) => a.detail?.self === false));
    // The removed viewer is no longer a member: the workspace disappears for them.
    assert.equal((await list(app, viewer.cookie, w)).status, 404);
    const me = (await (
      await app.request('/api/me', send('GET', undefined, viewer.cookie))
    ).json()) as { workspaces: unknown[] };
    assert.deepEqual(me.workspaces, []);
  },
);

dbTest('a person may remove themselves, and the audit event says so', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const member = await addMember(app, owner, 'member@example.com', 'member');
  const viewer = await addMember(app, owner, 'viewer@example.com', 'viewer');
  const w = owner.workspaceId;
  assert.equal((await remove(app, viewer.cookie, w, viewer.userId)).status, 204);
  assert.equal((await remove(app, member.cookie, w, member.userId)).status, 204);
  const events = (await auditActions(db, w)).filter((a) => a.action === 'member.remove');
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.detail?.self === true && e.actorId === e.targetId));
  assert.deepEqual(
    (await list(app, owner.cookie, w)).members.map((m) => m.userId),
    [owner.userId],
  );
});

dbTest('member changes never cross workspaces', async (db) => {
  const { app, clock } = await boot(db);
  const owner = await registerOwner(app);
  const bob = await addMember(app, owner, 'bob@example.com', 'member');
  const dan = await seedWorkspace(db, 'Other Co', 'dan@example.com', clock.now);

  // Dan is not in Acme at all.
  assert.equal(
    (await setRole(app, dan.cookie, owner.workspaceId, bob.userId, 'viewer')).status,
    404,
  );
  assert.equal((await remove(app, dan.cookie, owner.workspaceId, bob.userId)).status, 404);
  // Bob is not in Other Co: his id is not found there, so Dan cannot change or remove him.
  assert.equal((await setRole(app, dan.cookie, dan.workspaceId, bob.userId, 'viewer')).status, 404);
  assert.equal((await remove(app, dan.cookie, dan.workspaceId, bob.userId)).status, 404);
  assert.equal(
    (await list(app, owner.cookie, owner.workspaceId)).members.find((m) => m.userId === bob.userId)
      ?.role,
    'member',
  );
});

dbTest('member endpoints need a session', async (db) => {
  const { app } = await boot(db);
  const owner = await registerOwner(app);
  const res = await app.request(
    `/api/workspaces/${owner.workspaceId}/members/${owner.userId}`,
    send('DELETE'),
  );
  assert.equal(res.status, 401);
});
