import { randomBytes, randomUUID } from 'node:crypto';
import { type Database, migrate } from '@kiln/db';
import { createApp } from './app.ts';
import { createSession } from './services/accounts.ts';

/** Shared by the invitation and member tests. Not a test file, so the runner skips it. */
export const PASSWORD = 'correct horse battery staple';
export const cheap = { N: 1024, r: 8, p: 1 };

export async function boot(db: Database, overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  await migrate(db);
  const clock = { now: 1_800_000_000_000 };
  const app = createApp({
    db,
    masterKey: randomBytes(32),
    version: '1.2.3',
    cost: cheap,
    now: () => clock.now,
    ...overrides,
  });
  return { app, db, clock };
}

export type App = Awaited<ReturnType<typeof boot>>['app'];

export const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

export const send = (
  method: string,
  body?: unknown,
  cookie?: string,
  extra: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(cookie ? { cookie } : {}),
    ...extra,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export async function registerOwner(app: App, email = 'ada@example.com') {
  const res = await app.request(
    '/api/auth/register',
    send('POST', { email, displayName: 'Ada', password: PASSWORD, workspaceName: 'Acme Apps' }),
  );
  const body = (await res.json()) as { workspaceId: string; user: { id: string } };
  return { cookie: cookieOf(res), workspaceId: body.workspaceId, userId: body.user.id };
}

type Json = Record<string, unknown>;

export async function invite(
  app: App,
  cookie: string,
  workspaceId: string,
  input: { email: string; role: string },
) {
  const res = await app.request(
    `/api/workspaces/${workspaceId}/invitations`,
    send('POST', input, cookie),
  );
  return { res, body: (await res.json()) as Json & { token: string; invitation: { id: string } } };
}

export const acceptInvite = (app: App, token: string, body: unknown = {}, cookie?: string) =>
  app.request(`/api/invitations/${token}/accept`, send('POST', body, cookie));

/** Invites `email` and accepts as a new account. Returns that person's session cookie and id. */
export async function addMember(
  app: App,
  owner: { cookie: string; workspaceId: string },
  email: string,
  role: 'admin' | 'member' | 'viewer',
  displayName = email.split('@')[0] ?? 'person',
) {
  const { body } = await invite(app, owner.cookie, owner.workspaceId, { email, role });
  const res = await acceptInvite(app, body.token, { displayName, password: PASSWORD });
  const accepted = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), userId: accepted.user.id, status: res.status };
}

/**
 * A second workspace with its own owner, made directly in the database (there is no endpoint
 * for a second workspace yet). Gives the owner a session.
 */
export async function seedWorkspace(db: Database, name: string, ownerEmail: string, now: number) {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)', [
    userId,
    ownerEmail,
    `Owner of ${name}`,
    now,
  ]);
  await db.execute('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [
    workspaceId,
    name,
    now,
  ]);
  await db.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
    workspaceId,
    userId,
    'owner',
  ]);
  const { token } = await createSession(db, userId, now);
  return { userId, workspaceId, cookie: `kiln_session=${token}` };
}

export async function auditActions(db: Database, workspaceId: string) {
  const rows = await db.query(
    'SELECT action, actor_id, target_id, detail FROM audit_events WHERE workspace_id = ? ORDER BY created_at, id',
    [workspaceId],
  );
  return rows.map((r) => ({
    action: String(r.action),
    actorId: String(r.actor_id),
    targetId: r.target_id ? String(r.target_id) : null,
    detail: r.detail ? (JSON.parse(String(r.detail)) as Json) : null,
  }));
}
