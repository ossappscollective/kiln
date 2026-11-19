import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type Action,
  actions,
  can,
  isRole,
  isTokenRole,
  lowerRole,
  type Role,
  type TokenRole,
  tokenForbiddenActions,
  tokenRoles,
} from '@mrm/core';
import type { Database, Row, Sql } from '@mrm/db';
import { z } from 'zod';
import { recordAudit } from './audit.ts';

/**
 * API tokens for scripts and CI. A token is `mrm_` plus 256 random bits (base64url). Only its
 * SHA-256 is stored, so a leaked database cannot be replayed, and the token is shown once, when it
 * is made. It acts for the person who made it with three further limits: a role ceiling
 * (viewer, member or admin; never owner), optionally a list of apps, and optionally a list of
 * actions. It stops working when it is revoked or expires, and when its creator leaves the
 * workspace. See docs/api/tokens.md.
 */

export const TOKEN_PREFIX = 'mrm_';
/** Shown in lists to tell tokens apart: `mrm_` and the first six random characters. */
const PREFIX_SHOWN = TOKEN_PREFIX.length + 6;
export const MAX_ACTIVE_TOKENS = 100;
/** A token's last-used time is written at most once per this many milliseconds. */
export const LAST_USED_GRANULARITY_MS = 60_000;

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The shape of a token, checked before the database is asked: 256 bits is 43 base64url characters. */
const TOKEN_SHAPE = /^mrm_[A-Za-z0-9_-]{43}$/;
export const looksLikeToken = (value: string) => TOKEN_SHAPE.test(value);

export const createTokenBody = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(tokenRoles),
  /** Limits the token to these apps. Omit for all apps. */
  appIds: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  /** Limits the token to these actions (within the role). Omit for everything the role allows. */
  actions: z.array(z.enum(actions)).min(1).max(actions.length).optional(),
  /** Epoch milliseconds, in the future. Omit for a token that does not expire. */
  expiresAt: z.number().int().positive().optional(),
});
export type CreateTokenInput = z.infer<typeof createTokenBody>;

export type TokenStatus = 'active' | 'revoked' | 'expired';

export type TokenSummary = {
  id: string;
  name: string;
  /** `mrm_` and six more characters, to recognise a token. Not enough to use it. */
  prefix: string;
  role: TokenRole;
  appIds: string[] | null;
  actions: Action[] | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  createdBy: { id: string; name: string | null };
  status: TokenStatus;
};

export type TokenFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: string;
  message?: string;
};

const parseList = (value: unknown): string[] | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
};

const nullable = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toSummary(r: Row, now: number): TokenSummary {
  const revokedAt = nullable(r.revoked_at);
  const expiresAt = nullable(r.expires_at);
  return {
    id: String(r.id),
    name: String(r.name),
    prefix: String(r.prefix),
    role: (isTokenRole(r.role) ? r.role : 'viewer') as TokenRole,
    appIds: parseList(r.app_ids),
    actions: parseList(r.actions) as Action[] | null,
    expiresAt,
    lastUsedAt: nullable(r.last_used_at),
    revokedAt,
    createdAt: Number(r.created_at),
    createdBy: {
      id: String(r.created_by),
      name: r.creator_name === null || r.creator_name === undefined ? null : String(r.creator_name),
    },
    status:
      revokedAt !== null
        ? 'revoked'
        : expiresAt !== null && expiresAt <= now
          ? 'expired'
          : 'active',
  };
}

const SUMMARY_SELECT = `SELECT t.id, t.name, t.prefix, t.role, t.app_ids, t.actions, t.expires_at,
       t.last_used_at, t.revoked_at, t.created_at, t.created_by, u.display_name AS creator_name
  FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by`;

/** The most tokens one list returns (newest first). Revoked and expired ones stay listed. */
export const MAX_TOKENS_LISTED = 200;

export async function listTokens(
  sql: Sql,
  workspaceId: string,
  now: number,
): Promise<TokenSummary[]> {
  const rows = await sql.query(
    `${SUMMARY_SELECT} WHERE t.workspace_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    [workspaceId, MAX_TOKENS_LISTED],
  );
  return rows.map((r) => toSummary(r, now));
}

export async function getToken(
  sql: Sql,
  workspaceId: string,
  id: string,
  now: number,
): Promise<TokenSummary | undefined> {
  const [row] = await sql.query(`${SUMMARY_SELECT} WHERE t.workspace_id = ? AND t.id = ?`, [
    workspaceId,
    id,
  ]);
  return row ? toSummary(row, now) : undefined;
}

export async function createToken(
  db: Database,
  input: CreateTokenInput & { workspaceId: string },
  /** The signed-in person, with their role in this workspace. */
  creator: { id: string; role: Role },
  now: number,
): Promise<{ ok: true; token: string; summary: TokenSummary } | TokenFailure> {
  // A token acts for its creator, so it cannot be given more than the creator has.
  if (lowerRole(input.role, creator.role) !== input.role) {
    return {
      ok: false,
      status: 403,
      error: 'role_above_yours',
      message: 'A token cannot have a higher role than the person who creates it.',
    };
  }
  if (input.expiresAt !== undefined && input.expiresAt <= now) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      message: 'The expiry must be in the future.',
    };
  }
  const list = input.actions ? [...new Set(input.actions)] : undefined;
  for (const action of list ?? []) {
    if (tokenForbiddenActions.includes(action)) {
      return {
        ok: false,
        status: 400,
        error: 'action_not_allowed',
        message: `A token can never hold "${action}". Managing tokens, members, credential values and webhooks is for people.`,
      };
    }
    if (!can(input.role, action)) {
      return {
        ok: false,
        status: 400,
        error: 'action_above_role',
        message: `The ${input.role} role does not include "${action}". Pick a higher role or remove it.`,
      };
    }
  }
  const apps = input.appIds ? [...new Set(input.appIds)] : undefined;

  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${secret}`;
  const id = randomUUID();

  const outcome = await db.transaction(async (tx) => {
    if (apps) {
      const found = await tx.query(
        `SELECT id FROM apps WHERE workspace_id = ? AND id IN (${apps.map(() => '?').join(', ')})`,
        [input.workspaceId, ...apps],
      );
      if (found.length !== apps.length) return 'unknown_app' as const;
    }
    const [active] = await tx.query(
      'SELECT COUNT(*) AS n FROM api_tokens WHERE workspace_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
      [input.workspaceId, now],
    );
    if (Number(active?.n ?? 0) >= MAX_ACTIVE_TOKENS) return 'too_many' as const;
    await tx.execute(
      `INSERT INTO api_tokens
         (id, workspace_id, created_by, name, token_hash, prefix, role, app_ids, actions, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        creator.id,
        input.name,
        tokenHash(token),
        token.slice(0, PREFIX_SHOWN),
        input.role,
        apps ? JSON.stringify(apps) : null,
        list ? JSON.stringify(list) : null,
        input.expiresAt ?? null,
        now,
      ],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: creator.id },
      action: 'token.create',
      target: { type: 'token', id },
      detail: {
        name: input.name,
        role: input.role,
        appIds: apps ?? null,
        actions: list ?? null,
        expiresAt: input.expiresAt ?? null,
      },
      at: now,
    });
    return 'ok' as const;
  });
  if (outcome === 'unknown_app') {
    return {
      ok: false,
      status: 400,
      error: 'unknown_app',
      message: 'One of the apps is not in this workspace.',
    };
  }
  if (outcome === 'too_many') {
    return {
      ok: false,
      status: 409,
      error: 'too_many_tokens',
      message: `A workspace can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke some first.`,
    };
  }
  const summary = (await getToken(db, input.workspaceId, id, now)) as TokenSummary;
  return { ok: true, token, summary };
}

/** Revoking is idempotent: an already revoked token answers true and records nothing more. */
export async function revokeToken(
  db: Database,
  input: { workspaceId: string; id: string },
  actor: { type: 'user'; id: string },
  now: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT name, revoked_at FROM api_tokens WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    if (!row) return false;
    if (row.revoked_at !== null && row.revoked_at !== undefined) return true;
    await tx.execute(
      'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
      [now, input.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'token.revoke',
      target: { type: 'token', id: input.id },
      detail: { name: String(row.name) },
      at: now,
    });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Using a token

/** Who a valid bearer token is, as the request handling needs it. */
export type TokenPrincipal = {
  tokenId: string;
  name: string;
  workspaceId: string;
  user: { id: string; email: string; displayName: string };
  /** The ceiling the token was made with. */
  tokenRole: TokenRole;
  /** The creator's role in the workspace now. */
  memberRole: Role;
  /** The lower of the two: what the token may do today. */
  ceiling: Role;
  appIds: string[] | null;
  actions: Action[] | null;
};

/**
 * Finds the token by the hash of what was presented. Undefined when it is unknown, revoked or
 * expired, or when its creator is no longer a member of the workspace (the token then dies with
 * the membership). A creator who was demoted keeps the token, which then holds the lower role.
 */
export async function authenticateToken(
  sql: Sql,
  presented: string,
  now: number,
): Promise<TokenPrincipal | undefined> {
  if (!looksLikeToken(presented)) return undefined;
  const [row] = await sql.query(
    `SELECT t.id, t.name, t.workspace_id, t.role, t.app_ids, t.actions, t.expires_at,
            u.id AS user_id, u.email, u.display_name, m.role AS member_role
       FROM api_tokens t
       JOIN users u ON u.id = t.created_by
       JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = t.created_by
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    [tokenHash(presented), now],
  );
  if (!row || !isTokenRole(row.role) || !isRole(row.member_role)) return undefined;
  return {
    tokenId: String(row.id),
    name: String(row.name),
    workspaceId: String(row.workspace_id),
    user: {
      id: String(row.user_id),
      email: String(row.email),
      displayName: String(row.display_name),
    },
    tokenRole: row.role,
    memberRole: row.member_role,
    ceiling: lowerRole(row.role, row.member_role),
    appIds: parseList(row.app_ids),
    actions: parseList(row.actions) as Action[] | null,
  };
}

/** Records that the token was used, at most once per minute. */
export async function touchToken(sql: Sql, id: string, now: number): Promise<void> {
  await sql.execute(
    'UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
    [now, id, now - LAST_USED_GRANULARITY_MS],
  );
}

/** For a stream that has been open a while: is the token still good, and is its creator still a member? */
export async function tokenStillValid(sql: Sql, tokenId: string, now: number): Promise<boolean> {
  const [row] = await sql.query(
    `SELECT 1 AS ok FROM api_tokens t
       JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = t.created_by
      WHERE t.id = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    [tokenId, now],
  );
  return row !== undefined;
}
