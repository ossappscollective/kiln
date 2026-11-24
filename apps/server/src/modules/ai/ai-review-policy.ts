import {
  defaultReviewAiPolicy,
  isReviewAiDetail,
  normalizeReviewAiPolicy,
  type ReviewAiEffective,
  type ReviewAiPolicyStored,
  type ReviewAiSwitch,
  resolveReviewAiPolicy,
  type ShapedReview,
  shapeReviewForAi,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { recordAudit } from '../../services/audit.ts';
import { listReviews } from '../reviews/service.ts';
import { type AiActor, type AiFailure, aiFail, readAiConfig } from './ai-config.ts';

/**
 * What reviews of an app may be sent to the AI provider (docs/adr/0065-ai-review-privacy-and-competitor-schedule.md).
 *
 * The workspace setting is the CEILING (`ai.reviewsToAi`, `ai.competitorReviewsToAi`): an app can only narrow it. The app's own row
 * (`ai_app_review_policy`, migration 67) holds the choice (on, off or follow the workspace), what is sent (full, text, ratings) and
 * whether emails, links, phone-like numbers and @handles are replaced. It is enforced in `buildRun` (service.ts), the one place that builds
 * the input of every task, before anything is read for a prompt: the browser never decides.
 */

/** Tasks whose input holds reviews of the app itself. */
export const OWN_REVIEW_TASKS: ReadonlySet<string> = new Set([
  'review_summary',
  'review_classify',
  'fix_next',
  'review_reply_draft',
  'keyword_ideas_reviews',
]);
/** The ones that cannot work without review text (the summary can: it becomes statistical). */
const TEXT_TASKS: ReadonlySet<string> = new Set(
  [...OWN_REVIEW_TASKS].filter((t) => t !== 'review_summary'),
);
/** The suggestions made from review text that "Delete AI summaries" removes. */
export const SUMMARY_TASKS = ['review_summary', 'fix_next'] as const;

export type AppReviewPolicy = {
  stored: ReviewAiPolicyStored;
  effective: ReviewAiEffective;
  ceiling: { ownReviews: boolean; competitorReviews: boolean };
  updatedAt: number | null;
  updatedBy: string | null;
};

const asSwitch = (v: unknown): ReviewAiSwitch => (v === 'on' || v === 'off' ? v : null);

export async function getStoredPolicy(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<{ stored: ReviewAiPolicyStored; updatedAt: number | null; updatedBy: string | null }> {
  const [row] = await sql.query(
    'SELECT own_reviews, competitor_reviews, detail, redact, updated_at, updated_by FROM ai_app_review_policy WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, appId],
  );
  if (!row) return { stored: defaultReviewAiPolicy(), updatedAt: null, updatedBy: null };
  return {
    stored: {
      ownReviews: asSwitch(row.own_reviews),
      competitorReviews: asSwitch(row.competitor_reviews),
      detail: isReviewAiDetail(row.detail) ? row.detail : 'text',
      redact: Number(row.redact) !== 0,
    },
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

/** The policy in force for an app: its own row under the workspace ceiling. */
export async function getAppReviewPolicy(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppReviewPolicy> {
  const [{ stored, updatedAt, updatedBy }, config] = await Promise.all([
    getStoredPolicy(sql, workspaceId, appId),
    readAiConfig(sql, workspaceId),
  ]);
  const ceiling = {
    ownReviews: config.values.reviewsToAi,
    competitorReviews: config.values.competitorReviewsToAi,
  };
  return {
    stored,
    effective: resolveReviewAiPolicy(ceiling, stored),
    ceiling,
    updatedAt,
    updatedBy,
  };
}

/** `ai_reviews_disabled` (409) when reviews of this app may not go to the provider, `ai_reviews_need_text` (409) when only ratings may. null: go on. */
export function gateReviewTask(effective: ReviewAiEffective, taskId: string): AiFailure | null {
  if (!OWN_REVIEW_TASKS.has(taskId)) return null;
  if (!effective.own.allowed) {
    const workspace = effective.own.reason === 'workspace_off';
    return aiFail(
      409,
      'ai_reviews_disabled',
      workspace
        ? 'Sending reviews to the AI provider is turned off for this workspace. Nothing was sent.'
        : 'Sending reviews to the AI provider is turned off for this app in its settings. Nothing was sent.',
      {
        reason: effective.own.reason,
        ...coded(workspace ? 'ai.reviewsDisabledWorkspace' : 'ai.reviewsDisabledApp'),
      },
    );
  }
  if (effective.detail === 'ratings' && TEXT_TASKS.has(taskId)) {
    return aiFail(
      409,
      'ai_reviews_need_text',
      'This app only lets star ratings and counts go to the AI provider, and this task needs review text. Nothing was sent.',
      { reason: 'ratings_only', ...coded('ai.reviewsNeedText') },
    );
  }
  return null;
}

/**
 * Gate for the reviews of followed competitors. No task sends them yet; any future one MUST call this before it builds its input
 * (a test pins that the answer follows the ceiling and the app's choice).
 */
export function gateCompetitorReviews(effective: ReviewAiEffective): AiFailure | null {
  if (effective.competitor.allowed) return null;
  const workspace = effective.competitor.reason === 'workspace_off';
  return aiFail(
    409,
    'ai_reviews_disabled',
    workspace
      ? 'Sending competitor reviews to the AI provider is turned off for this workspace. Nothing was sent.'
      : 'Sending competitor reviews to the AI provider is turned off for this app in its settings. Nothing was sent.',
    {
      reason: effective.competitor.reason,
      kind: 'competitor',
      ...coded(workspace ? 'ai.reviewsDisabledWorkspace' : 'ai.reviewsDisabledApp'),
    },
  );
}

export type PolicyChange = { field: string; from: unknown; to: unknown };

/** Saves the choice of an app. Audited with who and from → to per field (values are switches and modes, never text). */
export async function setAppReviewPolicy(
  db: Database,
  input: { workspaceId: string; appId: string; actor: AiActor; body: unknown; at: number },
): Promise<{ ok: true; policy: AppReviewPolicy; changes: PolicyChange[] } | AiFailure> {
  const before = (await getStoredPolicy(db, input.workspaceId, input.appId)).stored;
  const checked = normalizeReviewAiPolicy(input.body, before);
  if (!checked.ok)
    return aiFail(400, 'invalid_request', 'The review settings are not valid.', {
      issues: checked.issues,
    });
  const next = checked.value;
  const changes: PolicyChange[] = [];
  for (const field of ['ownReviews', 'competitorReviews', 'detail', 'redact'] as const)
    if (before[field] !== next[field])
      changes.push({ field, from: before[field], to: next[field] });
  if (changes.length > 0) {
    await db.transaction(async (tx) => {
      const updated = await tx.execute(
        'UPDATE ai_app_review_policy SET own_reviews = ?, competitor_reviews = ?, detail = ?, redact = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND app_id = ?',
        [
          next.ownReviews,
          next.competitorReviews,
          next.detail,
          next.redact ? 1 : 0,
          input.actor.id,
          input.at,
          input.workspaceId,
          input.appId,
        ],
      );
      if (Number(updated) === 0) {
        await tx.execute(
          'INSERT INTO ai_app_review_policy (app_id, workspace_id, own_reviews, competitor_reviews, detail, redact, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.appId,
            input.workspaceId,
            next.ownReviews,
            next.competitorReviews,
            next.detail,
            next.redact ? 1 : 0,
            input.actor.id,
            input.at,
          ],
        );
      }
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'ai.review_policy_update',
        target: { type: 'app', id: input.appId },
        detail: { appId: input.appId, changes },
        at: input.at,
      });
    });
  }
  return {
    ok: true,
    policy: await getAppReviewPolicy(db, input.workspaceId, input.appId),
    changes,
  };
}

/**
 * "Delete AI summaries for this app": the stored suggestions made from review text (summaries and what-to-fix reports). The tags of single
 * reviews and everything else stay. Audited with the count.
 */
export async function deleteAppSummaries(
  db: Database,
  input: { workspaceId: string; appId: string; actor: AiActor; at: number },
): Promise<number> {
  return db.transaction(async (tx) => {
    const deleted = Number(
      await tx.execute(
        `DELETE FROM ai_suggestions WHERE workspace_id = ? AND app_id = ? AND task IN (${SUMMARY_TASKS.map(() => '?').join(', ')})`,
        [input.workspaceId, input.appId, ...SUMMARY_TASKS],
      ),
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'ai.summaries_delete',
      target: { type: 'app', id: input.appId },
      detail: { appId: input.appId, deleted },
      at: input.at,
    });
    return deleted;
  });
}

export const SAMPLE_REVIEWS = 3;

export type PayloadPreview = {
  allowed: boolean;
  reason: 'workspace_off' | 'app_off' | null;
  detail: ReviewAiEffective['detail'];
  redact: boolean;
  /** The newest reviews as they would be sent, cut as the summary cuts them (title 80, text 280). */
  reviews: ShapedReview[];
  sampleOf: number;
};

/** What WOULD be sent for the first three reviews, built by the same shaping function the tasks use. Nothing is sent anywhere. */
export async function previewReviewPayload(
  sql: Sql,
  workspaceId: string,
  appId: string,
  policy: AppReviewPolicy,
): Promise<PayloadPreview> {
  const page = await listReviews(
    sql,
    workspaceId,
    appId,
    {},
    { sort: 'newest', limit: SAMPLE_REVIEWS },
  );
  const rows = 'error' in page ? [] : page.reviews.slice(0, SAMPLE_REVIEWS);
  return {
    allowed: policy.effective.own.allowed,
    reason: policy.effective.own.reason,
    detail: policy.effective.detail,
    redact: policy.effective.redact,
    reviews: rows.map((r) =>
      shapeReviewForAi(
        {
          rating: r.rating,
          title: r.title,
          body: r.body,
          authorName: r.authorName,
          language: r.language,
          appVersion: r.appVersion,
          createdAt: r.createdAt,
        },
        policy.effective,
        { titleChars: 80, textChars: 280 },
      ),
    ),
    sampleOf: rows.length,
  };
}
