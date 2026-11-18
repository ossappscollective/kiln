import type { ActorType } from '@mrm/core';
import type { Sql } from '@mrm/db';
import { randomUUID } from 'node:crypto';

export type AuditInput = {
  workspaceId: string;
  actor: { type: ActorType; id: string };
  action: string;
  target?: { type: string; id: string };
  /** Never put secrets here. */
  detail?: Record<string, unknown>;
  at: number;
};

export async function recordAudit(sql: Sql, event: AuditInput): Promise<void> {
  await sql.execute(
    `INSERT INTO audit_events
       (id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      event.workspaceId,
      event.actor.type,
      event.actor.id,
      event.action,
      event.target?.type ?? null,
      event.target?.id ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
      event.at,
    ],
  );
}

export type AuditRow = {
  id: string;
  actorType: string;
  actorId: string;
  /** The person's display name when the actor is a user. */
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  at: number;
};

export async function listAudit(sql: Sql, workspaceId: string, limit = 100): Promise<AuditRow[]> {
  const rows = await sql.query(
    `SELECT a.id, a.actor_type, a.actor_id, u.display_name AS actor_name, a.action,
            a.target_type, a.target_id, a.detail, a.created_at
       FROM audit_events a
       LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
      WHERE a.workspace_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [workspaceId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: String(r.id),
    actorType: String(r.actor_type),
    actorId: String(r.actor_id),
    actorName: (r.actor_name as string | null) ?? null,
    action: String(r.action),
    targetType: (r.target_type as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    detail: r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : null,
    at: Number(r.created_at),
  }));
}
