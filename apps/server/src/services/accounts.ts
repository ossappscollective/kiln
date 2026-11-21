import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isRole, type Role } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { hashPassword, type ScryptCost, verifyPassword } from '../passwords.ts';
import { recordAudit } from './audit.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type User = { id: string; email: string; displayName: string };
export type WorkspaceSummary = { id: string; name: string; role: Role };

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// A hash to verify against when the email is unknown, so a miss takes as long as a hit.
let decoy: Promise<string> | undefined;

export async function countUsers(sql: Sql): Promise<number> {
  const [row] = await sql.query('SELECT COUNT(*) AS n FROM users');
  return Number(row?.n ?? 0);
}

/**
 * The first account sets the instance up: it becomes the owner of a new workspace. After that
 * this returns 'already_set_up', and more people arrive by invitation (not built yet).
 */
export async function registerFirstUser(
  db: Database,
  input: { email: string; displayName: string; password: string; workspaceName: string },
  options: { now: number; cost?: ScryptCost | undefined },
): Promise<{ user: User; workspaceId: string } | 'already_set_up'> {
  // Cheap check first: a closed instance must not spend a password hash on every request. The
  // check inside the transaction below stays, because two first-run requests can both pass this one.
  if ((await countUsers(db)) > 0) return 'already_set_up';
  const passwordHash = await hashPassword(input.password, options.cost);
  const user: User = {
    id: randomUUID(),
    email: normalizeEmail(input.email),
    displayName: input.displayName.trim(),
  };
  const workspaceId = randomUUID();

  return db.transaction(async (tx) => {
    // Two first-run requests at once must not both win on Postgres. SQLite serializes already.
    if (tx.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(727275)');
    if ((await countUsers(tx)) > 0) return 'already_set_up' as const;

    await tx.execute(
      'INSERT INTO users (id, email, display_name, created_at, password_hash) VALUES (?, ?, ?, ?, ?)',
      [user.id, user.email, user.displayName, options.now, passwordHash],
    );
    await tx.execute('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [
      workspaceId,
      input.workspaceName.trim(),
      options.now,
    ]);
    await tx.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [workspaceId, user.id, 'owner'],
    );
    await recordAudit(tx, {
      workspaceId,
      actor: { type: 'user', id: user.id },
      action: 'workspace.create',
      target: { type: 'workspace', id: workspaceId },
      detail: { name: input.workspaceName.trim(), firstUser: true },
      at: options.now,
    });
    return { user, workspaceId };
  });
}

/**
 * Single-user mode: finds or creates the one local user and its workspace (owner). The user has
 * no password hash, so it cannot log in; sessions come only from the launch secret. Refuses a
 * database that already has other accounts, so switching a hosted database to single-user mode
 * cannot quietly add an owner to it.
 */
export async function ensureLocalUser(
  db: Database,
  options: { email: string; now: number },
): Promise<{ user: User; workspaceId: string; created: boolean } | 'not_a_single_user_database'> {
  return db.transaction(async (tx) => {
    if (tx.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(727275)');
    const [row] = await tx.query('SELECT id, email, display_name FROM users WHERE email = ?', [
      options.email,
    ]);
    if (row) {
      const user: User = {
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
      };
      const [member] = await tx.query(
        'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY workspace_id',
        [user.id],
      );
      return { user, workspaceId: String(member?.workspace_id ?? ''), created: false };
    }
    if ((await countUsers(tx)) > 0) return 'not_a_single_user_database' as const;

    const user: User = { id: randomUUID(), email: options.email, displayName: 'Local user' };
    const workspaceId = randomUUID();
    await tx.execute(
      'INSERT INTO users (id, email, display_name, created_at, password_hash) VALUES (?, ?, ?, ?, NULL)',
      [user.id, user.email, user.displayName, options.now],
    );
    await tx.execute('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [
      workspaceId,
      'My workspace',
      options.now,
    ]);
    await tx.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [workspaceId, user.id, 'owner'],
    );
    await recordAudit(tx, {
      workspaceId,
      actor: { type: 'user', id: user.id },
      action: 'workspace.create',
      target: { type: 'workspace', id: workspaceId },
      detail: { name: 'My workspace', firstUser: true, singleUser: true },
      at: options.now,
    });
    return { user, workspaceId, created: true };
  });
}

export async function verifyLogin(
  sql: Sql,
  email: string,
  password: string,
): Promise<User | undefined> {
  const [row] = await sql.query(
    'SELECT id, email, display_name, password_hash FROM users WHERE email = ?',
    [normalizeEmail(email)],
  );
  const stored = row?.password_hash ? String(row.password_hash) : undefined;
  if (!stored) {
    decoy ??= hashPassword('not-a-real-password');
    await verifyPassword(password, await decoy);
    return undefined;
  }
  if (!(await verifyPassword(password, stored))) return undefined;
  return { id: String(row?.id), email: String(row?.email), displayName: String(row?.display_name) };
}

/** Returns the raw token for the cookie. Only its SHA-256 is stored. */
export async function createSession(
  sql: Sql,
  userId: string,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_MS;
  await sql.execute(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [tokenHash(token), userId, now, expiresAt],
  );
  return { token, expiresAt };
}

export async function resolveSession(
  sql: Sql,
  token: string,
  now: number,
): Promise<User | undefined> {
  const [row] = await sql.query(
    `SELECT u.id, u.email, u.display_name FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
    [tokenHash(token), now],
  );
  return row
    ? { id: String(row.id), email: String(row.email), displayName: String(row.display_name) }
    : undefined;
}

export async function endSession(sql: Sql, token: string): Promise<void> {
  await sql.execute('DELETE FROM sessions WHERE id = ?', [tokenHash(token)]);
}

export async function pruneSessions(sql: Sql, now: number): Promise<number> {
  return sql.execute('DELETE FROM sessions WHERE expires_at <= ?', [now]);
}

export async function listWorkspaces(sql: Sql, userId: string): Promise<WorkspaceSummary[]> {
  const rows = await sql.query(
    `SELECT w.id, w.name, m.role FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY w.name`,
    [userId],
  );
  return rows.flatMap((r) =>
    isRole(r.role) ? [{ id: String(r.id), name: String(r.name), role: r.role }] : [],
  );
}

export async function memberRole(
  sql: Sql,
  workspaceId: string,
  userId: string,
): Promise<Role | undefined> {
  const [row] = await sql.query(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId],
  );
  return isRole(row?.role) ? row.role : undefined;
}
