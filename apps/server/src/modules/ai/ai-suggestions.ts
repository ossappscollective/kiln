import {
  type AiAcceptedRef,
  type AiProposal,
  type AiProposalKind,
  type AiProvider,
  type AiSuggestionStatus,
  type AiSuggestionView,
  type AiTaskId,
  aiLimits,
  isAiTaskId,
} from '@kiln/core';
import type { Row, Sql } from '@kiln/db';
import { USAGE_RETENTION_MS } from './ai-usage.ts';

/**
 * Storage of AI suggestions (table `ai_suggestions`, migration 30). A suggestion is a PROPOSAL: the validated and
 * post-processed output of one run, with its provenance (task and version, provider, model, a hash of the data sent) and
 * the usage. It holds no prompt and no raw model output. A reply draft proposal does hold the draft text, and a listing
 * proposal the proposed text: that is the product of the task and what a person reads; it is deleted with the app and after
 * `aiLimits.suggestionRetentionDays` days.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type NewSuggestion = {
  id: string;
  workspaceId: string;
  appId: string;
  task: AiTaskId;
  taskVersion: number;
  kind: AiProposalKind;
  provider: AiProvider;
  model: string;
  scope: Record<string, unknown>;
  proposal: AiProposal;
  inputHash: string;
  inputTokens: number;
  outputTokens: number;
  createdBy: string;
  at: number;
};

export async function insertSuggestion(sql: Sql, s: NewSuggestion): Promise<void> {
  await sql.execute(
    `INSERT INTO ai_suggestions
       (id, workspace_id, app_id, task, task_version, kind, status, provider, model, scope, proposal, input_hash,
        input_tokens, output_tokens, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      s.workspaceId,
      s.appId,
      s.task,
      s.taskVersion,
      s.kind,
      s.provider,
      s.model,
      JSON.stringify(s.scope),
      JSON.stringify(s.proposal),
      s.inputHash,
      Math.max(0, Math.floor(s.inputTokens)),
      Math.max(0, Math.floor(s.outputTokens)),
      s.createdBy,
      s.at,
    ],
  );
}

const parseJson = <T>(raw: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
};

export function toSuggestionView(r: Row): AiSuggestionView {
  return {
    id: String(r.id),
    appId: String(r.app_id),
    task: String(r.task) as AiTaskId,
    taskVersion: Number(r.task_version),
    kind: String(r.kind) as AiProposalKind,
    status: String(r.status) as AiSuggestionStatus,
    provider: String(r.provider) as AiProvider,
    model: String(r.model),
    proposal: parseJson<AiProposal>(r.proposal, {
      kind: 'keywords',
      store: 'app_store',
      country: '',
      locale: '',
      items: [],
    }),
    scope: parseJson<Record<string, unknown>>(r.scope, {}),
    inputHash: String(r.input_hash),
    usage: { inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens) },
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    decidedBy: r.decided_by === null || r.decided_by === undefined ? null : String(r.decided_by),
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : Number(r.decided_at),
    accepted:
      r.accepted === null || r.accepted === undefined
        ? null
        : parseJson<AiAcceptedRef | null>(r.accepted, null),
  };
}

const COLUMNS = `id, workspace_id, app_id, task, task_version, kind, status, provider, model, scope, proposal, input_hash,
  input_tokens, output_tokens, created_by, created_at, decided_by, decided_at, accepted`;

export async function getSuggestion(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<AiSuggestionView | undefined> {
  const [row] = await sql.query(
    `SELECT ${COLUMNS} FROM ai_suggestions WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  );
  return row ? toSuggestionView(row) : undefined;
}

export const DEFAULT_SUGGESTIONS_PAGE = 20;
export const MAX_SUGGESTIONS_PAGE = 100;

export async function listSuggestions(
  sql: Sql,
  workspaceId: string,
  appId: string,
  filter: { status?: AiSuggestionStatus; task?: string; limit?: number } = {},
): Promise<AiSuggestionView[]> {
  const where = ['workspace_id = ?', 'app_id = ?'];
  const params: (string | number)[] = [workspaceId, appId];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.task && isAiTaskId(filter.task)) {
    where.push('task = ?');
    params.push(filter.task);
  }
  const limit = Math.max(
    1,
    Math.min(MAX_SUGGESTIONS_PAGE, Math.floor(filter.limit ?? DEFAULT_SUGGESTIONS_PAGE)),
  );
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM ai_suggestions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    params,
  );
  return rows.map(toSuggestionView);
}

/**
 * Moves a suggestion out of `proposed`, once: the UPDATE only matches while it is still proposed, so two people (or two
 * clicks) cannot both accept. Returns false when it was no longer proposed.
 */
export async function decideSuggestion(
  sql: Sql,
  input: {
    workspaceId: string;
    id: string;
    status: 'accepted' | 'dismissed';
    actorId: string;
    at: number;
    accepted?: AiAcceptedRef;
  },
): Promise<boolean> {
  const changed = await sql.execute(
    `UPDATE ai_suggestions SET status = ?, decided_by = ?, decided_at = ?, accepted = ?
      WHERE workspace_id = ? AND id = ? AND status = 'proposed'`,
    [
      input.status,
      input.actorId,
      input.at,
      input.accepted ? JSON.stringify(input.accepted) : null,
      input.workspaceId,
      input.id,
    ],
  );
  return Number(changed) > 0;
}

/** Puts an accepted suggestion back to `proposed` when the mechanism it was handed to refused (the claim is released). */
export async function reopenSuggestion(sql: Sql, workspaceId: string, id: string): Promise<void> {
  await sql.execute(
    `UPDATE ai_suggestions SET status = 'proposed', decided_by = NULL, decided_at = NULL, accepted = NULL
      WHERE workspace_id = ? AND id = ? AND status = 'accepted' AND accepted IS NULL`,
    [workspaceId, id],
  );
}

/** Rewrites the proposal of a suggestion that is still open (a partial accept marks the items it took). False when it was no longer proposed. */
export async function updateProposal(
  sql: Sql,
  workspaceId: string,
  id: string,
  proposal: AiProposal,
): Promise<boolean> {
  const changed = await sql.execute(
    "UPDATE ai_suggestions SET proposal = ? WHERE workspace_id = ? AND id = ? AND status = 'proposed'",
    [JSON.stringify(proposal), workspaceId, id],
  );
  return Number(changed) > 0;
}

/** Records what an accepted suggestion created. */
export async function recordAccepted(
  sql: Sql,
  workspaceId: string,
  id: string,
  accepted: AiAcceptedRef,
): Promise<void> {
  await sql.execute('UPDATE ai_suggestions SET accepted = ? WHERE workspace_id = ? AND id = ?', [
    JSON.stringify(accepted),
    workspaceId,
    id,
  ]);
}

/** Deletes everything AI knows about an app (called when the app is deleted). Usage rows keep no app text; their app id is cleared. */
export async function deleteAiData(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  await sql.execute('DELETE FROM ai_suggestions WHERE workspace_id = ? AND app_id = ?', [
    workspaceId,
    appId,
  ]);
  // The context a person wrote for the app and the tags the assistant gave its reviews (docs/adr/0024-ai-features.md) go with it.
  await sql.execute('DELETE FROM ai_app_context WHERE workspace_id = ? AND app_id = ?', [
    workspaceId,
    appId,
  ]);
  await sql.execute('DELETE FROM review_classifications WHERE workspace_id = ? AND app_id = ?', [
    workspaceId,
    appId,
  ]);
  await sql.execute('UPDATE ai_usage SET app_id = NULL WHERE workspace_id = ? AND app_id = ?', [
    workspaceId,
    appId,
  ]);
}

/** Retention: suggestions older than the retention window and usage rows older than 400 days. Returns the rows deleted. */
export async function purgeAiData(sql: Sql, now: number): Promise<number> {
  const suggestions = await sql.execute('DELETE FROM ai_suggestions WHERE created_at < ?', [
    now - aiLimits.suggestionRetentionDays * DAY_MS,
  ]);
  const usage = await sql.execute('DELETE FROM ai_usage WHERE created_at < ?', [
    now - USAGE_RETENTION_MS,
  ]);
  // Tags of reviews that no longer exist (pruned or deleted).
  const tags = await sql.execute(
    'DELETE FROM review_classifications WHERE review_id NOT IN (SELECT id FROM app_reviews)',
  );
  return Number(suggestions) + Number(usage) + Number(tags);
}
