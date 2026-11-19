import { decideRemoval, decideRoleChange, isRole, type Role } from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { recordAudit } from './audit.ts';
import type { Actor } from './invitations.ts';

export type Member = { userId: string; email: string; displayName: string; role: Role };

const rank: Record<Role, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

export async function listMembers(sql: Sql, workspaceId: string): Promise<Member[]> {
  const rows = await sql.query(
    `SELECT u.id, u.email, u.display_name, m.role FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ?`,
    [workspaceId],
  );
  return rows
    .flatMap((r) =>
      isRole(r.role)
        ? [
            {
              userId: String(r.id),
              email: String(r.email),
              displayName: String(r.display_name),
              role: r.role,
            },
          ]
        : [],
    )
    .sort(
      (a, b) =>
        rank[a.role] - rank[b.role] ||
        a.displayName.localeCompare(b.displayName) ||
        a.userId.localeCompare(b.userId),
    );
}

export type MemberChange =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'last_owner' };

/**
 * Membership changes in one workspace run one at a time (a row lock on Postgres, the single
 * writer on SQLite), so two owners demoting each other cannot leave the workspace without one.
 */
async function lockWorkspace(tx: Sql, workspaceId: string) {
  if (tx.dialect === 'postgres') {
    await tx.query('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
  }
}

async function roleOf(tx: Sql, workspaceId: string, userId: string): Promise<Role | undefined> {
  const [row] = await tx.query(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId],
  );
  return isRole(row?.role) ? row.role : undefined;
}

async function ownerCount(tx: Sql, workspaceId: string): Promise<number> {
  const [row] = await tx.query(
    "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
    [workspaceId],
  );
  return Number(row?.n ?? 0);
}

export async function changeMemberRole(
  db: Database,
  input: { workspaceId: string; userId: string; role: Role },
  actor: Actor,
  now: number,
): Promise<MemberChange> {
  return db.transaction(async (tx): Promise<MemberChange> => {
    await lockWorkspace(tx, input.workspaceId);
    // Read again under the lock: the actor may have been demoted a moment ago.
    const actorRole = await roleOf(tx, input.workspaceId, actor.id);
    const targetRole = await roleOf(tx, input.workspaceId, input.userId);
    if (!actorRole) return { ok: false, reason: 'forbidden' };
    if (!targetRole) return { ok: false, reason: 'not_found' };
    const decision = decideRoleChange({
      actorRole,
      targetRole,
      newRole: input.role,
      ownerCount: await ownerCount(tx, input.workspaceId),
    });
    if (!decision.ok) return decision;
    if (targetRole === input.role) return { ok: true };

    await tx.execute(
      'UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      [input.role, input.workspaceId, input.userId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: actor.id },
      action: 'member.role_change',
      target: { type: 'user', id: input.userId },
      detail: { from: targetRole, to: input.role },
      at: now,
    });
    return { ok: true };
  });
}

export async function removeMember(
  db: Database,
  input: { workspaceId: string; userId: string },
  actor: Actor,
  now: number,
): Promise<MemberChange> {
  return db.transaction(async (tx): Promise<MemberChange> => {
    await lockWorkspace(tx, input.workspaceId);
    const actorRole = await roleOf(tx, input.workspaceId, actor.id);
    const targetRole = await roleOf(tx, input.workspaceId, input.userId);
    if (!actorRole) return { ok: false, reason: 'forbidden' };
    if (!targetRole) return { ok: false, reason: 'not_found' };
    const self = actor.id === input.userId;
    const decision = decideRemoval({
      actorRole,
      self,
      targetRole,
      ownerCount: await ownerCount(tx, input.workspaceId),
    });
    if (!decision.ok) return decision;

    await tx.execute('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
      input.workspaceId,
      input.userId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: actor.id },
      action: 'member.remove',
      target: { type: 'user', id: input.userId },
      detail: { role: targetRole, self },
      at: now,
    });
    return { ok: true };
  });
}
