import { createHash } from 'node:crypto';
import {
  type AiReviewTags,
  type AiReviewTopic,
  type AiSentiment,
  type AiSeverity,
  aiReviewTopics,
  aiSentiments,
  aiSeverities,
} from '@mrm/core';
import type { Sql } from '@mrm/db';

/**
 * The tags the assistant gave reviews (table `review_classifications`, migration 41, docs/adr/0024-ai-features.md).
 *
 * They are ADVISORY labels: they change nothing about a review (its status, its assignee, its reply). The table is also the cache that makes
 * classifying cheap: a review whose text hash and classifier version match a row is never sent again. A row holds a hash of the text,
 * never the text. The tags of a deleted app go with it (`deleteAiData`), and those of a review that no longer exist are purged (`purgeAiData`).
 */

/** The hash that says whether the text of a review is still the text that was tagged. */
export const reviewTextHash = (review: {
  title: string | null;
  body: string;
  rating: number;
}): string =>
  createHash('sha256')
    .update(`${review.rating}\n${review.title ?? ''}\n${review.body}`, 'utf8')
    .digest('hex');

export type StoredTags = AiReviewTags & {
  taskVersion: number;
  textHash: string;
  createdAt: number;
};

const asTopic = (v: string): AiReviewTopic =>
  (aiReviewTopics as readonly string[]).indexOf(v) !== -1 ? (v as AiReviewTopic) : 'other';

function toTags(r: Record<string, unknown>): StoredTags {
  let topics: AiReviewTopic[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.topics));
    if (Array.isArray(parsed))
      topics = parsed.filter((t): t is string => typeof t === 'string').map(asTopic);
  } catch {
    topics = [];
  }
  const sentiment = String(r.sentiment);
  const severity = String(r.severity);
  return {
    reviewId: String(r.review_id),
    topics,
    sentiment:
      (aiSentiments as readonly string[]).indexOf(sentiment) !== -1
        ? (sentiment as AiSentiment)
        : 'neutral',
    severity:
      (aiSeverities as readonly string[]).indexOf(severity) !== -1
        ? (severity as AiSeverity)
        : 'none',
    language: r.language === null || r.language === undefined ? null : String(r.language),
    needsReply: Number(r.needs_reply) === 1,
    taskVersion: Number(r.task_version),
    textHash: String(r.text_hash),
    createdAt: Number(r.created_at),
  };
}

const COLUMNS =
  'review_id, task_version, text_hash, topics, sentiment, severity, language, needs_reply, created_at';
const MAX_IDS = 200;

/** The stored tags of the given reviews of an app (at most 200 ids at a time). */
export async function getReviewTags(
  sql: Sql,
  workspaceId: string,
  appId: string,
  reviewIds: string[],
): Promise<Map<string, StoredTags>> {
  const out = new Map<string, StoredTags>();
  const ids = [...new Set(reviewIds)].slice(0, MAX_IDS);
  if (ids.length === 0) return out;
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM review_classifications WHERE workspace_id = ? AND app_id = ? AND review_id IN (${ids.map(() => '?').join(', ')})`,
    [workspaceId, appId, ...ids],
  );
  for (const row of rows) {
    const tags = toTags(row);
    out.set(tags.reviewId, tags);
  }
  return out;
}

/** Stores (or replaces) the tags of reviews, with the hash of the text they were made from. */
export async function saveReviewTags(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    taskVersion: number;
    provider: string;
    model: string;
    at: number;
    items: { tags: AiReviewTags; textHash: string }[];
  },
): Promise<void> {
  for (const { tags, textHash } of input.items) {
    await sql.execute(
      'DELETE FROM review_classifications WHERE review_id = ? AND workspace_id = ?',
      [tags.reviewId, input.workspaceId],
    );
    await sql.execute(
      `INSERT INTO review_classifications
         (review_id, workspace_id, app_id, task_version, text_hash, topics, sentiment, severity, language, needs_reply, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tags.reviewId,
        input.workspaceId,
        input.appId,
        input.taskVersion,
        textHash,
        JSON.stringify(tags.topics),
        tags.sentiment,
        tags.severity,
        tags.language,
        tags.needsReply ? 1 : 0,
        input.provider,
        input.model,
        input.at,
      ],
    );
  }
}
