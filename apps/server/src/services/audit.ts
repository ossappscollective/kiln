import type { ActorType } from '@mrm/core';
import type { Sql } from '@mrm/db';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { eventFromAudit, emitEvent } from './events.ts';

export type AuditInput = {
  workspaceId: string;
  actor: { type: ActorType; id: string };
  action: string;
  target?: { type: string; id: string };
  /** Never put secrets here. */
  detail?: Record<string, unknown>;
  at: number;
};

/**
 * Set for the length of a request that was authenticated with an API token. The routes build their
 * actor from the signed-in user (`{ type: 'user', id }`); while this is set, an audit event whose
 * actor is that user is recorded as the token instead, with the person it acts for in the detail.
 * One place, so no route can forget it and a new route is attributed correctly from the start.
 */
export type TokenActing = { tokenId: string; userId: string };
const acting = new AsyncLocalStorage<TokenActing>();
export const runAsToken = <T>(token: TokenActing, fn: () => T): T => acting.run(token, fn);

export async function recordAudit(sql: Sql, input: AuditInput): Promise<void> {
  const token = acting.getStore();
  const viaToken = token && input.actor.type === 'user' && input.actor.id === token.userId;
  const event: AuditInput = viaToken
    ? {
        ...input,
        actor: { type: 'token', id: token.tokenId },
        detail: { ...input.detail, onBehalfOf: token.userId },
      }
    : input;
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
  // The events that follow from audited actions (change sets, failed credential tests).
  const emitted = eventFromAudit(event);
  if (emitted) await emitEvent(sql, emitted);
}

export type AuditRow = {
  id: string;
  actorType: string;
  actorId: string;
  /** The person's display name when the actor is a user, the token's name when it is a token. */
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  at: number;
};

/** The most events one request returns. */
export const MAX_AUDIT_LIMIT = 500;

export async function listAudit(sql: Sql, workspaceId: string, limit = 100): Promise<AuditRow[]> {
  const rows = await sql.query(
    `SELECT a.id, a.actor_type, a.actor_id, COALESCE(u.display_name, t.name) AS actor_name, a.action,
            a.target_type, a.target_id, a.detail, a.created_at
       FROM audit_events a
       LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
       LEFT JOIN api_tokens t ON a.actor_type = 'token' AND t.id = a.actor_id
      WHERE a.workspace_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [workspaceId, Math.trunc(Math.min(Math.max(limit, 1), MAX_AUDIT_LIMIT))],
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
