import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can, type InvitableRole, invitableBy, isRole, type Role } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { hashPassword, type ScryptCost } from '../passwords.ts';
import { createSession, normalizeEmail, type User } from './accounts.ts';
import { recordAudit } from './audit.ts';

/** An invitation link works for this long. One constant, so a later setting can replace it. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Only this hash is stored, so a copy of the database cannot be used to join a workspace. */
export const hashInvitationToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export type Invitation = {
  id: string;
  email: string;
  role: InvitableRole;
  createdAt: number;
  expiresAt: number;
  createdByName: string | null;
};

export type Actor = { id: string; role: Role };

export async function createInvitation(
  db: Database,
  input: { workspaceId: string; email: string; role: InvitableRole },
  actor: Actor,
  now: number,
): Promise<{ invitation: Invitation; token: string } | 'already_member' | 'already_invited'> {
  const email = normalizeEmail(input.email);
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const expiresAt = now + INVITATION_TTL_MS;

  return db.transaction(async (tx) => {
    const [member] = await tx.query(
      `SELECT 1 AS found FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.email = ?`,
      [input.workspaceId, email],
    );
    if (member) return 'already_member' as const;
    const [pending] = await tx.query(
      `SELECT 1 AS found FROM invitations
        WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > ?`,
      [input.workspaceId, email, now],
    );
    if (pending) return 'already_invited' as const;

    await tx.execute(
      `INSERT INTO invitations
         (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        email,
        input.role,
        hashInvitationToken(token),
        actor.id,
        now,
        expiresAt,
      ],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: actor.id },
      action: 'invitation.create',
      target: { type: 'invitation', id },
      // The token is never recorded.
      detail: { email, role: input.role },
      at: now,
    });
    const [creator] = await tx.query('SELECT display_name FROM users WHERE id = ?', [actor.id]);
    return {
      invitation: {
        id,
        email,
        role: input.role,
        createdAt: now,
        expiresAt,
        createdByName: creator ? String(creator.display_name) : null,
      },
      token,
    };
  });
}

/** Pending means not accepted, not revoked and not expired. Never includes tokens. */
export async function listPendingInvitations(
  sql: Sql,
  workspaceId: string,
  now: number,
): Promise<Invitation[]> {
  const rows = await sql.query(
    `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, u.display_name
       FROM invitations i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.workspace_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > ?
      ORDER BY i.created_at DESC, i.id`,
    [workspaceId, now],
  );
  return rows.flatMap((r) =>
    isRole(r.role) && r.role !== 'owner'
      ? [
          {
            id: String(r.id),
            email: String(r.email),
            role: r.role as InvitableRole,
            createdAt: Number(r.created_at),
            expiresAt: Number(r.expires_at),
            createdByName: r.display_name ? String(r.display_name) : null,
          },
        ]
      : [],
  );
}

export async function revokeInvitation(
  db: Database,
  input: { workspaceId: string; id: string },
  actor: Actor,
  now: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT email, role FROM invitations WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    const changed = await tx.execute(
      `UPDATE invitations SET revoked_at = ?
        WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      [now, input.id, input.workspaceId],
    );
    if (changed === 0) return false;
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: actor.id },
      action: 'invitation.revoke',
      target: { type: 'invitation', id: input.id },
      detail: { email: String(row?.email ?? ''), role: String(row?.role ?? '') },
      at: now,
    });
    return true;
  });
}

export type InvitationPreview = {
  workspaceName: string;
  email: string;
  role: InvitableRole;
  valid: true;
};

type Row = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: InvitableRole;
};

/**
 * The invitation for a token, only while it can still be accepted. That includes: the person who
 * made it must still be a member who may invite that role. An admin who was demoted or removed
 * after sending a link (or an owner who was, for an admin link) must not leave a working door
 * behind, so this is checked again here, at preview and at accept time, not only when it was made.
 */
async function findUsable(sql: Sql, token: string, now: number): Promise<Row | undefined> {
  const [row] = await sql.query(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role,
            (SELECT m.role FROM workspace_members m
              WHERE m.workspace_id = i.workspace_id AND m.user_id = i.created_by) AS creator_role
       FROM invitations i JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > ?`,
    [hashInvitationToken(token), now],
  );
  if (!row || !isRole(row.role) || row.role === 'owner') return undefined;
  const creator = row.creator_role;
  if (!isRole(creator) || !can(creator, 'members.manage')) return undefined;
  if (!(invitableBy(creator) as readonly string[]).includes(row.role)) return undefined;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    email: String(row.email),
    role: row.role as InvitableRole,
  };
}

export async function previewInvitation(
  sql: Sql,
  token: string,
  now: number,
): Promise<InvitationPreview | undefined> {
  const found = await findUsable(sql, token, now);
  return (
    found && {
      workspaceName: found.workspaceName,
      email: found.email,
      role: found.role,
      valid: true,
    }
  );
}

export type AcceptResult =
  | {
      ok: true;
      user: User;
      workspaceId: string;
      role: Role;
      sessionToken?: string | undefined;
      expiresAt?: number | undefined;
    }
  | { ok: false; reason: 'invalid' | 'email_mismatch' | 'account_exists' | 'already_member' };

/** A failed INSERT on the unique email: someone made that account a moment ago. */
export const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /unique|duplicate key/i.test(error.message);

/**
 * Spends the invitation and adds the person to the workspace. Either:
 * - `signedIn` is the current user, whose email must match the invitation: they are added; or
 * - no one is signed in and `displayName` and `password` are given: the account is created
 *   (the email comes from the invitation) and a session is started.
 * Single use: the invitation is claimed by one UPDATE whose WHERE clause holds every condition,
 * and the number of rows it changed says who won. Everything else happens in the same transaction.
 */
export async function acceptInvitation(
  db: Database,
  token: string,
  input: {
    signedIn?: User | undefined;
    displayName?: string | undefined;
    password?: string | undefined;
  },
  options: { now: number; cost?: ScryptCost | undefined },
): Promise<AcceptResult> {
  const { now } = options;
  // Cheap check first, so an unusable token never costs a password hash.
  if (!(await findUsable(db, token, now))) return { ok: false, reason: 'invalid' };

  const passwordHash =
    !input.signedIn && input.password
      ? await hashPassword(input.password, options.cost)
      : undefined;

  return db.transaction(async (tx): Promise<AcceptResult> => {
    const invitation = await findUsable(tx, token, now);
    if (!invitation) return { ok: false, reason: 'invalid' };

    let user: User;
    let created = false;
    if (input.signedIn) {
      if (normalizeEmail(input.signedIn.email) !== invitation.email) {
        return { ok: false, reason: 'email_mismatch' };
      }
      user = input.signedIn;
      const [already] = await tx.query(
        'SELECT 1 AS found FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
        [invitation.workspaceId, user.id],
      );
      if (already) return { ok: false, reason: 'already_member' };
    } else {
      const [existing] = await tx.query('SELECT 1 AS found FROM users WHERE email = ?', [
        invitation.email,
      ]);
      if (existing) return { ok: false, reason: 'account_exists' };
      user = {
        id: randomUUID(),
        email: invitation.email,
        displayName: (input.displayName ?? '').trim(),
      };
      created = true;
    }

    const claimed = await tx.execute(
      `UPDATE invitations SET accepted_at = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      [now, invitation.id, now],
    );
    if (claimed === 0) return { ok: false, reason: 'invalid' };

    if (created) {
      await tx.execute(
        'INSERT INTO users (id, email, display_name, created_at, password_hash) VALUES (?, ?, ?, ?, ?)',
        [user.id, user.email, user.displayName, now, passwordHash ?? null],
      );
    }
    // accepted_by points at users, so it is set once the user row exists.
    await tx.execute('UPDATE invitations SET accepted_by = ? WHERE id = ?', [
      user.id,
      invitation.id,
    ]);
    await tx.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [invitation.workspaceId, user.id, invitation.role],
    );
    await recordAudit(tx, {
      workspaceId: invitation.workspaceId,
      actor: { type: 'user', id: user.id },
      action: 'invitation.accept',
      target: { type: 'invitation', id: invitation.id },
      detail: { email: invitation.email, role: invitation.role, newAccount: created },
      at: now,
    });
    const session = created ? await createSession(tx, user.id, now) : undefined;
    return {
      ok: true,
      user,
      workspaceId: invitation.workspaceId,
      role: invitation.role,
      sessionToken: session?.token,
      expiresAt: session?.expiresAt,
    };
  });
}
