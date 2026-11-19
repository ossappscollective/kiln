import { createHash, randomUUID } from 'node:crypto';
import {
  APPLE_REPLY_LIMIT,
  AppStoreReviewsConnector,
  checkReplyText,
  normalizeReplyText,
  PLAY_REPLY_LIMIT,
  PlayReviewsConnector,
  ReplyOutcomeUnknownError,
  redactSecrets,
  StoreError,
  StoreRateLimitError,
  type StoreReview,
  type StoreReviewReplyConnector,
  secretStrings,
} from '@mrm/connectors';
import { type ActorType, isApplePlatform } from '@mrm/core';
import type { Database, Param, Row, Sql } from '@mrm/db';
import { credentialKindFor, getApp, type ManagedApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { useCredentialSecret } from './credentials.ts';
import { emitEvent } from './events.ts';
import { type Failure, failure } from './repositories.ts';
import type { ReviewConnectorInput } from './review-sync.ts';
import { getReview, type Review, type StoreKey } from './reviews.ts';

/**
 * Replying to customer reviews: a STORE WRITE (public text, in the store, in the organisation's
 * name). The whole feature is built around never publishing by accident; see
 * docs/adr/0007-review-replies.md and docs/api/reviews.md#replying-to-a-review.
 *
 * - Off unless `replyEnabled` (MRM_REVIEW_REPLY_ENABLED): every function here that changes
 *   anything answers `409 reply_disabled`.
 * - A reply is a DRAFT first (`review_reply_drafts`, one row per review). Sending needs the hash of
 *   the exact text (`confirmHash`), so a client that shows an old draft cannot publish a newer one.
 * - One send in flight per review: an atomic claim (`status = 'sending'`, `claim_at`) that expires
 *   after a TTL. A claim that expired is not trusted: the send may have been applied, so the draft
 *   becomes `unknown` and the review is read back first.
 * - Nothing is retried. A timeout or a 5xx leaves the outcome `unknown`; the review is read back
 *   from the store and the draft settles to `sent`, `failed` or stays `unknown`, with evidence that
 *   never includes the text. Both stores overwrite an earlier reply with the same call, so sending
 *   the same text again cannot double post.
 * - Rate limit per workspace (default 30 sends an hour), counted from the audit log plus the sends
 *   in flight, so it survives restarts and holds across instances.
 * - Audit (`review.reply_draft`, `review.reply_sent`, `review.reply_failed`) and the event
 *   `review.reply_sent` carry ids, the store, the length and the hash. NEVER the text.
 * - No automatic replies and no bulk sends: this file has no loop over reviews and nothing calls it
 *   but the routes, one review per request.
 */

type Actor = { type: ActorType; id: string };

export const REPLY_ENV = 'MRM_REVIEW_REPLY_ENABLED';
export const REPLY_PURPOSE = 'review.reply';
export const DEFAULT_REPLY_TIMEOUT_MS = 60_000;
export const DEFAULT_REPLY_CLAIM_TTL_MS = 120_000;
export const DEFAULT_REPLY_SENDS_PER_HOUR = 30;
export const MAX_REPLY_TEMPLATES = 50;
export const MAX_TEMPLATE_NAME = 80;
export const MAX_TEMPLATE_BODY = 5000;
const HOUR_MS = 60 * 60 * 1000;

export const replyStatuses = ['draft', 'sending', 'sent', 'failed', 'unknown'] as const;
export type ReplyStatus = (typeof replyStatuses)[number];
const isReplyStatus = (v: unknown): v is ReplyStatus =>
  (replyStatuses as readonly string[]).includes(String(v));

/** Longest reply the server accepts for a store (see the connectors for where the numbers come from). */
export const replyLimitFor = (store: StoreKey): number =>
  store === 'googleplay' ? PLAY_REPLY_LIMIT : APPLE_REPLY_LIMIT;

export const hashReplyText = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------
// Context

/** What a translation of a draft needs: the lead wires `translateText` of services/translation.ts here. */
export type TranslateDraft = (input: {
  workspaceId: string;
  text: string;
  target: string;
  source?: string;
}) => Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }>;

export type ReviewReplyConnectorFactory = (
  input: ReviewConnectorInput,
) => StoreReviewReplyConnector;

export const defaultReplyConnectorFactory: ReviewReplyConnectorFactory = (input) =>
  input.kind === 'app_store_connect'
    ? AppStoreReviewsConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        fetch: input.fetch,
      })
    : new PlayReviewsConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      });

export type ReviewReplyContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** MRM_REVIEW_REPLY_ENABLED. */
  replyEnabled: boolean;
  replyConnectorFactory: ReviewReplyConnectorFactory;
  /** Longest one store call may take. Default 60 seconds. */
  replyTimeoutMs?: number;
  /** How long a send in flight is trusted. Default 2 minutes. */
  claimTtlMs?: number;
  /** Sends per workspace per hour. Default 30. */
  sendsPerHour?: number;
  /** Optional seam for translating a draft into the review's language. Absent: the feature is hidden. */
  translateDraft?: TranslateDraft;
};

// ---------------------------------------------------------------------------------------------
// Rows

export type ReplyDraft = {
  id: string;
  reviewId: string;
  appId: string;
  store: StoreKey;
  /** The plain text that goes to the store. */
  text: string;
  /** SHA-256 hex of `text`: repeat it as `confirmHash` to send. */
  textHash: string;
  length: number;
  /** What the store allows. */
  limit: number;
  status: ReplyStatus;
  errorCode: string | null;
  /** How an unknown outcome was settled. Never the text. */
  evidence: Record<string, unknown> | null;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  sentBy: string | null;
  storeResponseId: string | null;
};

/** The state of the reply of a review in one place, for lists. */
export type ReplyState = { status: 'none' | ReplyStatus; sentAt: number | null };

export type ReviewView = Review & { replyDraft: ReplyDraft | null; reply: ReplyState };

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function parseEvidence(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function toDraft(r: Row): ReplyDraft {
  const store = String(r.store) as StoreKey;
  const text = String(r.text);
  return {
    id: String(r.id),
    reviewId: String(r.review_id),
    appId: String(r.app_id),
    store,
    text,
    textHash: String(r.text_hash),
    length: text.length,
    limit: replyLimitFor(store),
    status: isReplyStatus(r.status) ? r.status : 'draft',
    errorCode: str(r.error_code),
    evidence: parseEvidence(r.evidence),
    createdBy: String(r.created_by),
    updatedBy: String(r.updated_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    sentAt: num(r.sent_at),
    sentBy: str(r.sent_by),
    storeResponseId: str(r.store_response_id),
  };
}

const DRAFT_COLUMNS = `id, review_id, app_id, store, text, text_hash, status, error_code, evidence, created_by,
  updated_by, created_at, updated_at, sent_at, sent_by, claim_at, store_response_id`;

async function loadDraft(
  sql: Sql,
  workspaceId: string,
  reviewId: string,
): Promise<(ReplyDraft & { claimAt: number | null }) | undefined> {
  const [row] = await sql.query(
    `SELECT ${DRAFT_COLUMNS} FROM review_reply_drafts WHERE review_id = ? AND workspace_id = ?`,
    [reviewId, workspaceId],
  );
  return row ? { ...toDraft(row), claimAt: num(row.claim_at) } : undefined;
}

export const replyStateOf = (draft: ReplyDraft | null): ReplyState =>
  draft ? { status: draft.status, sentAt: draft.sentAt } : { status: 'none', sentAt: null };

/** Adds `replyDraft` and `reply` to reviews. One query for the whole page. */
export async function attachReplies<T extends Review>(
  sql: Sql,
  workspaceId: string,
  reviews: T[],
): Promise<(T & { replyDraft: ReplyDraft | null; reply: ReplyState })[]> {
  const found = new Map<string, ReplyDraft>();
  for (let i = 0; i < reviews.length; i += 200) {
    const ids = reviews.slice(i, i + 200).map((r) => r.id);
    if (ids.length === 0) continue;
    const rows = await sql.query(
      `SELECT ${DRAFT_COLUMNS} FROM review_reply_drafts WHERE workspace_id = ? AND review_id IN (${ids.map(() => '?').join(', ')})`,
      [workspaceId, ...ids],
    );
    for (const row of rows) found.set(String(row.review_id), toDraft(row));
  }
  return reviews.map((r) => {
    const replyDraft = found.get(r.id) ?? null;
    return { ...r, replyDraft, reply: replyStateOf(replyDraft) };
  });
}

export async function getReviewView(
  sql: Sql,
  workspaceId: string,
  appId: string,
  reviewId: string,
): Promise<ReviewView | undefined> {
  const review = await getReview(sql, workspaceId, appId, reviewId);
  if (!review) return undefined;
  return (await attachReplies(sql, workspaceId, [review]))[0];
}

// ---------------------------------------------------------------------------------------------
// Failures

const disabled = (): Failure =>
  failure(
    409,
    'reply_disabled',
    `Replying to reviews is switched off on this server. Set ${REPLY_ENV}=true to turn it on (see docs/deployment.md).`,
    { envName: REPLY_ENV },
  );

export type ReplyFailure = Failure;

/** The `409 reply_disabled` answer, for routes that check the kill switch before anything else. */
export const replyDisabledFailure = disabled;

/** Free text from a store, cleaned of anything that looks like a credential, and cut. */
const clean = (text: string, secret: string) =>
  redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, 500);

type Mapped = { failure: Failure; code: string };

/** A store refusal as an answer to the person. `secret` is only used to redact. */
function mapStoreError(error: unknown, secret: string): Mapped {
  const make = (
    status: Failure['status'],
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Mapped => ({
    code,
    failure: {
      ...failure(status, code, clean(message, secret), extra),
      ...(headers ? { headers } : {}),
    },
  });
  if (error instanceof StoreRateLimitError) {
    const wait = error.retryAfterSeconds;
    return make(
      429,
      'rate_limited',
      error.message,
      { retryAfterSeconds: wait },
      { 'Retry-After': String(wait) },
    );
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
        return make(422, 'store_auth', error.message);
      case 'forbidden':
      case 'api_disabled':
      case 'unsupported':
        return make(422, 'store_forbidden', error.message);
      case 'not_found':
        return make(422, 'store_not_found', error.message);
      case 'invalid_input':
        return make(422, 'invalid_reply', error.message);
      case 'server':
      case 'network':
        return make(502, 'store_unavailable', error.message);
      default:
        // Any other refusal: the store looked at the request and said no (a 4xx), so nothing was published.
        return make(
          error.status !== undefined && error.status >= 400 && error.status < 500 ? 422 : 502,
          'store_rejected',
          error.message,
        );
    }
  }
  return make(
    502,
    'send_failed',
    'The reply could not be sent. Nothing was published that this server knows of.',
  );
}

class ReplyTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
async function withConnector<T>(
  ctx: ReviewReplyContext,
  input: Omit<ReviewConnectorInput, 'fetch'>,
  job: (connector: StoreReviewReplyConnector) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = (target, init) =>
    baseFetch(target, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ReplyTimeout('timeout'));
    }, ctx.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.replyConnectorFactory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Templates

export type ReplyTemplate = {
  id: string;
  name: string;
  body: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

const toTemplate = (r: Row): ReplyTemplate => ({
  id: String(r.id),
  name: String(r.name),
  body: String(r.body),
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;
export const templatePlaceholders = ['author', 'app'] as const;
const MAX_SUBSTITUTION = 60;

// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const SUBSTITUTION_STRIP =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff<>{}]/g;

/** A name from outside as plain text for the middle of a sentence: no markup, no control characters, one line, short. */
export function plainValue(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(SUBSTITUTION_STRIP, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUBSTITUTION)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/**
 * Fills `{{author}}` (the reviewer's display name, or "there") and `{{app}}`. The values come from a
 * customer and from the store: they are reduced to plain text first (see `plainValue`), so a name
 * like `<b>x</b>` cannot put markup or a line break into a public reply. Pure.
 */
export function renderTemplate(
  body: string,
  values: { author?: string | null; app?: string | null },
): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === 'author') return plainValue(values.author, 'there');
    if (name === 'app') return plainValue(values.app, 'the app');
    return whole;
  });
}

type TemplateInput = { name: string; body: string };

/** Problems with a template, or null: placeholders, markup and control characters are checked like a reply. */
export function checkTemplate(
  input: TemplateInput,
): { field: 'name' | 'body'; message: string } | null {
  const name = input.name.trim();
  if (name === '' || name.length > MAX_TEMPLATE_NAME)
    return { field: 'name', message: `A name of 1 to ${MAX_TEMPLATE_NAME} characters.` };
  const body = normalizeReplyText(input.body);
  const checked = checkReplyText(body, MAX_TEMPLATE_BODY);
  if (!checked.ok) return { field: 'body', message: checked.message };
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (!(templatePlaceholders as readonly string[]).includes(match[1] ?? '')) {
      return {
        field: 'body',
        message: `Unknown placeholder {{${match[1]}}}. Use {{author}} and {{app}}.`,
      };
    }
  }
  if (/\{\{|\}\}/.test(body.replace(PLACEHOLDER, '')))
    return { field: 'body', message: 'A stray {{ or }}. Use {{author}} and {{app}}.' };
  return null;
}

export async function listTemplates(sql: Sql, workspaceId: string): Promise<ReplyTemplate[]> {
  const rows = await sql.query(
    'SELECT id, name, body, created_by, created_at, updated_at FROM review_reply_templates WHERE workspace_id = ? ORDER BY name, id',
    [workspaceId],
  );
  return rows.map(toTemplate);
}

export type TemplateResult = { ok: true; template: ReplyTemplate } | Failure;

export async function createTemplate(
  ctx: ReviewReplyContext,
  input: { workspaceId: string; name: string; body: string; actorId: string },
): Promise<TemplateResult> {
  if (!ctx.replyEnabled) return disabled();
  const problem = checkTemplate(input);
  if (problem) return failure(422, 'invalid_template', problem.message, { field: problem.field });
  const at = ctx.now();
  const id = randomUUID();
  const made = await ctx.db.transaction(async (tx) => {
    const [count] = await tx.query(
      'SELECT COUNT(*) AS n FROM review_reply_templates WHERE workspace_id = ?',
      [input.workspaceId],
    );
    if (Number(count?.n ?? 0) >= MAX_REPLY_TEMPLATES) return false;
    await tx.execute(
      `INSERT INTO review_reply_templates (id, workspace_id, name, body, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.name.trim(),
        normalizeReplyText(input.body),
        input.actorId,
        at,
        at,
      ],
    );
    return true;
  });
  if (!made)
    return failure(
      422,
      'too_many_templates',
      `A workspace can have at most ${MAX_REPLY_TEMPLATES} reply templates.`,
    );
  const [row] = await ctx.db.query(
    'SELECT id, name, body, created_by, created_at, updated_at FROM review_reply_templates WHERE id = ?',
    [id],
  );
  return { ok: true, template: toTemplate(row as Row) };
}

export async function updateTemplate(
  ctx: ReviewReplyContext,
  input: { workspaceId: string; id: string; name: string; body: string },
): Promise<TemplateResult> {
  if (!ctx.replyEnabled) return disabled();
  const problem = checkTemplate(input);
  if (problem) return failure(422, 'invalid_template', problem.message, { field: problem.field });
  const changed = await ctx.db.execute(
    'UPDATE review_reply_templates SET name = ?, body = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    [input.name.trim(), normalizeReplyText(input.body), ctx.now(), input.id, input.workspaceId],
  );
  if (changed === 0) return failure(404, 'not_found');
  const [row] = await ctx.db.query(
    'SELECT id, name, body, created_by, created_at, updated_at FROM review_reply_templates WHERE id = ?',
    [input.id],
  );
  return { ok: true, template: toTemplate(row as Row) };
}

export async function deleteTemplate(
  ctx: ReviewReplyContext,
  input: { workspaceId: string; id: string },
): Promise<{ ok: true } | Failure> {
  if (!ctx.replyEnabled) return disabled();
  const removed = await ctx.db.execute(
    'DELETE FROM review_reply_templates WHERE id = ? AND workspace_id = ?',
    [input.id, input.workspaceId],
  );
  return removed === 0 ? failure(404, 'not_found') : { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Drafts

const isStale = (draft: { claimAt: number | null }, now: number, ttl: number) =>
  draft.claimAt === null || now - draft.claimAt >= ttl;

const auditDetail = (
  app: { id: string },
  review: Review,
  draft: Pick<ReplyDraft, 'textHash' | 'length'>,
) => ({
  appId: app.id,
  store: review.store,
  length: draft.length,
  hash: draft.textHash,
});

export type DraftInput = { workspaceId: string; appId: string; reviewId: string; actor: Actor } & (
  | { text: string; templateId?: undefined }
  | { templateId: string; text?: undefined }
);

/**
 * Saves the draft reply of a review (creates it, or replaces the text of the existing one, also a
 * sent or failed one). Refused while a send is in flight or its outcome is unknown. Nothing is sent.
 */
export async function saveReplyDraft(
  ctx: ReviewReplyContext,
  input: DraftInput,
): Promise<{ ok: true; draft: ReplyDraft; changed: boolean } | Failure> {
  if (!ctx.replyEnabled) return disabled();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const review = await getReview(ctx.db, input.workspaceId, app.id, input.reviewId);
  if (!review) return failure(404, 'not_found');

  let source = input.text ?? '';
  if (input.templateId !== undefined) {
    const [row] = await ctx.db.query(
      'SELECT body FROM review_reply_templates WHERE id = ? AND workspace_id = ?',
      [input.templateId, input.workspaceId],
    );
    if (!row) return failure(404, 'template_not_found', 'There is no such reply template.');
    source = renderTemplate(String(row.body), { author: review.authorName, app: app.name });
  }
  const text = normalizeReplyText(source);
  const limit = replyLimitFor(review.store);
  const checked = checkReplyText(text, limit);
  if (!checked.ok) {
    return failure(422, 'invalid_reply', checked.message, {
      problem: checked.problem,
      limit,
      length: text.length,
    });
  }
  const hash = hashReplyText(text);
  const at = ctx.now();
  const ttl = ctx.claimTtlMs ?? DEFAULT_REPLY_CLAIM_TTL_MS;

  const result = await ctx.db.transaction(async (tx) => {
    const existing = await loadDraft(tx, input.workspaceId, review.id);
    if (existing && existing.status === 'sending' && !isStale(existing, at, ttl)) {
      return failure(
        409,
        'send_in_progress',
        'A send of this reply is in progress. Wait for it to finish.',
        { reply: existing },
      );
    }
    if (existing && (existing.status === 'unknown' || existing.status === 'sending')) {
      return failure(
        409,
        'outcome_unknown',
        'It is not known whether the last send of this reply was published. Check the outcome first (send it again to check), then edit.',
        { reply: existing },
      );
    }
    if (existing && existing.textHash === hash && existing.status !== 'sent') {
      return { ok: true as const, draft: existing, changed: false };
    }
    if (existing) {
      await tx.execute(
        `UPDATE review_reply_drafts SET text = ?, text_hash = ?, status = 'draft', error_code = NULL, evidence = NULL,
                sent_at = NULL, sent_by = NULL, claim_at = NULL, store_response_id = NULL, updated_by = ?, updated_at = ?
          WHERE id = ?`,
        [text, hash, input.actor.id, at, existing.id],
      );
    } else {
      await tx.execute(
        `INSERT INTO review_reply_drafts
           (id, workspace_id, app_id, review_id, store, text, text_hash, status, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          app.id,
          review.id,
          review.store,
          text,
          hash,
          input.actor.id,
          input.actor.id,
          at,
          at,
        ],
      );
    }
    const draft = (await loadDraft(tx, input.workspaceId, review.id)) as ReplyDraft;
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'review.reply_draft',
      target: { type: 'review', id: review.id },
      // Ids, the length and the hash: never the text.
      detail: {
        ...auditDetail(app, review, draft),
        change: existing ? 'updated' : 'created',
        ...(input.templateId ? { templateId: input.templateId } : {}),
      },
      at,
    });
    return { ok: true as const, draft, changed: true };
  });
  return result;
}

/** Deletes the draft (or the record of a sent reply; the store keeps what it published). */
export async function deleteReplyDraft(
  ctx: ReviewReplyContext,
  input: { workspaceId: string; appId: string; reviewId: string; actor: Actor },
): Promise<{ ok: true } | Failure> {
  if (!ctx.replyEnabled) return disabled();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const review = await getReview(ctx.db, input.workspaceId, app.id, input.reviewId);
  if (!review) return failure(404, 'not_found');
  const at = ctx.now();
  const ttl = ctx.claimTtlMs ?? DEFAULT_REPLY_CLAIM_TTL_MS;
  return ctx.db.transaction(async (tx) => {
    const existing = await loadDraft(tx, input.workspaceId, review.id);
    if (!existing) return failure(404, 'no_draft', 'There is no draft reply for this review.');
    if (
      existing.status === 'unknown' ||
      (existing.status === 'sending' && !isStale(existing, at, ttl))
    ) {
      return failure(
        409,
        existing.status === 'sending' ? 'send_in_progress' : 'outcome_unknown',
        'The draft cannot be deleted while a send is in progress or its outcome is unknown.',
        {
          reply: existing,
        },
      );
    }
    await tx.execute('DELETE FROM review_reply_drafts WHERE id = ?', [existing.id]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'review.reply_draft',
      target: { type: 'review', id: review.id },
      detail: {
        ...auditDetail(app, review, existing),
        change: 'deleted',
        wasStatus: existing.status,
      },
      at,
    });
    return { ok: true as const };
  });
}

/** Translates a draft with the injected seam. `translation_unavailable` when nothing is injected. */
export async function translateReplyDraft(
  ctx: ReviewReplyContext,
  input: { workspaceId: string; text: string; target: string; source?: string },
): Promise<{ ok: true; text: string } | Failure> {
  if (!ctx.replyEnabled) return disabled();
  if (!ctx.translateDraft) {
    return failure(409, 'translation_unavailable', 'Translation is not set up on this server.');
  }
  const done = await ctx.translateDraft({
    workspaceId: input.workspaceId,
    text: input.text,
    target: input.target,
    ...(input.source ? { source: input.source } : {}),
  });
  if (!done.ok) return failure(422, done.code, done.message);
  // The translation is a suggestion: it goes through the same checks when it is saved as a draft.
  return { ok: true, text: done.text };
}

// ---------------------------------------------------------------------------------------------
// Sending

export type SendResult =
  | { ok: true; reply: ReplyDraft; review: ReviewView; confirmedByReread: boolean }
  | Failure;

type ReadBack =
  | { kind: 'matched'; review: StoreReview }
  | { kind: 'no_match'; review: StoreReview }
  | { kind: 'unreadable'; reason: string };

async function readBack(
  ctx: ReviewReplyContext,
  input: Omit<ReviewConnectorInput, 'fetch'>,
  storeReviewId: string,
  text: string,
): Promise<ReadBack> {
  try {
    const found = await withConnector(ctx, input, (connector) =>
      connector.getReview(storeReviewId),
    );
    if (!found) return { kind: 'unreadable', reason: 'review_not_returned' };
    const response = found.developerResponse;
    if (response && normalizeReplyText(response.body) === text)
      return { kind: 'matched', review: found };
    return { kind: 'no_match', review: found };
  } catch (error) {
    return {
      kind: 'unreadable',
      reason:
        error instanceof ReplyTimeout
          ? 'timeout'
          : error instanceof StoreError
            ? error.kind
            : 'error',
    };
  }
}

const responseJson = (r: { body: string; at?: number | null; state?: string | null }): string =>
  JSON.stringify({ body: r.body, at: r.at ?? null, state: r.state ?? null });

/**
 * Sends the draft of a review to its store, once. `confirmHash` must be the hash of the draft as it
 * is now. See the file comment for the safety model; the answer is either the settled reply and the
 * review, or a failure that says what to do (`reply` in its body is the current state of the reply).
 */
export async function sendReviewReply(
  ctx: ReviewReplyContext,
  input: {
    workspaceId: string;
    appId: string;
    reviewId: string;
    confirmHash: string;
    actor: Actor;
  },
): Promise<SendResult> {
  if (!ctx.replyEnabled) return disabled();
  const { db } = ctx;
  const workspaceId = input.workspaceId;
  const app = await getApp(db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const review = await getReview(db, workspaceId, app.id, input.reviewId);
  if (!review) return failure(404, 'not_found');
  const found = await loadDraft(db, workspaceId, review.id);
  if (!found) return failure(404, 'no_draft', 'There is no draft reply for this review.');
  const view = (draft: ReplyDraft) => ({ reply: draft });

  if (input.confirmHash !== found.textHash) {
    return failure(
      409,
      'stale_draft',
      'The draft has changed since it was shown. Review the current text and confirm again.',
      {
        ...view(found),
        currentHash: found.textHash,
      },
    );
  }
  if (found.status === 'sent') {
    return failure(409, 'already_sent', 'This exact reply has already been sent.', view(found));
  }
  const ttl = ctx.claimTtlMs ?? DEFAULT_REPLY_CLAIM_TTL_MS;
  let now = ctx.now();
  let previous: ReplyStatus = found.status;
  if (found.status === 'sending') {
    if (!isStale(found, now, ttl)) {
      return failure(
        409,
        'send_in_progress',
        'A send of this reply is already in progress.',
        view(found),
      );
    }
    // The process that was sending is gone or stuck: it may or may not have reached the store.
    await db.execute(
      `UPDATE review_reply_drafts SET status = 'unknown', error_code = 'claim_expired', claim_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND (claim_at IS NULL OR claim_at <= ?)`,
      [now, found.id, now - ttl],
    );
    previous = 'unknown';
  }

  // The claim: one send in flight per review, decided by the database, not by this process.
  const claimed = await db.execute(
    `UPDATE review_reply_drafts SET status = 'sending', claim_at = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND text_hash = ? AND status IN ('draft', 'failed', 'unknown')`,
    [now, now, input.actor.id, found.id, found.textHash],
  );
  if (claimed === 0) {
    const current = await loadDraft(db, workspaceId, review.id);
    if (!current) return failure(404, 'no_draft', 'There is no draft reply for this review.');
    if (current.textHash !== input.confirmHash)
      return failure(409, 'stale_draft', 'The draft has changed since it was shown.', {
        ...view(current),
        currentHash: current.textHash,
      });
    if (current.status === 'sent')
      return failure(409, 'already_sent', 'This exact reply has already been sent.', view(current));
    return failure(
      409,
      'send_in_progress',
      'A send of this reply is already in progress.',
      view(current),
    );
  }
  previous = previous === 'sending' ? 'unknown' : previous;
  const claimId = found.id;

  /** Gives the claim back without recording a failure (nothing was tried at the store). */
  const release = async (to: ReplyStatus, errorCode: string | null = null) => {
    await db.execute(
      `UPDATE review_reply_drafts SET status = ?, claim_at = NULL, error_code = ?, updated_at = ? WHERE id = ? AND status = 'sending'`,
      [to, errorCode, ctx.now(), claimId],
    );
  };
  const refusal = async (f: Failure, to: ReplyStatus = previous, code: string | null = null) => {
    await release(to, code);
    const draft = await loadDraft(db, workspaceId, review.id);
    return draft ? { ...f, body: { ...f.body, reply: draft } } : f;
  };

  // ----- the store's credential
  const [credential] = await db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential)
    return refusal(
      failure(422, 'credential_not_found', 'The credential of this app no longer exists.'),
    );
  if (String(credential.kind) !== credentialKindFor[app.platform]) {
    return refusal(
      failure(422, 'credential_kind', "This app's credential is not the kind its platform needs."),
    );
  }
  if (isApplePlatform(app.platform) && !app.storeAppId) {
    return refusal(
      failure(
        422,
        'app_not_synced',
        'The App Store id of this app is not known yet. Sync the app first.',
      ),
    );
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: REPLY_PURPOSE },
      input.actor,
      ctx.now(),
    );
  } catch {
    return refusal(
      failure(
        422,
        'credential_unreadable',
        'The credential could not be decrypted. Enter its secret again.',
      ),
    );
  }
  if (secret === undefined)
    return refusal(
      failure(422, 'credential_not_found', 'The credential of this app no longer exists.'),
    );
  const connection: Omit<ReviewConnectorInput, 'fetch'> = {
    kind: credentialKindFor[app.platform],
    secret,
    identifier: app.identifier,
    storeAppId: app.storeAppId,
  };

  // ----- an unknown outcome is checked, not sent again
  if (previous === 'unknown') {
    return settle(ctx, {
      app,
      review,
      draft: found,
      actor: input.actor,
      connection,
      secret,
      cause: found.errorCode === 'claim_expired' ? 'claim_expired' : 'recheck',
    });
  }

  // ----- the limit of the store, then the rate limit of the workspace
  const limit = replyLimitFor(review.store);
  const checked = checkReplyText(found.text, limit);
  if (!checked.ok) {
    return refusal(
      failure(422, 'invalid_reply', checked.message, {
        problem: checked.problem,
        limit,
        length: found.text.length,
      }),
    );
  }
  now = ctx.now();
  const budget = ctx.sendsPerHour ?? DEFAULT_REPLY_SENDS_PER_HOUR;
  const [used] = await db.query(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM audit_events
      WHERE workspace_id = ? AND action IN ('review.reply_sent', 'review.reply_failed') AND created_at > ?`,
    [workspaceId, now - HOUR_MS],
  );
  const [inFlight] = await db.query(
    `SELECT COUNT(*) AS n FROM review_reply_drafts WHERE workspace_id = ? AND status = 'sending' AND id <> ?`,
    [workspaceId, claimId],
  );
  if (Number(used?.n ?? 0) + Number(inFlight?.n ?? 0) >= budget) {
    const oldest = used?.oldest === null || used?.oldest === undefined ? now : Number(used.oldest);
    const wait = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
    const f = failure(
      429,
      'rate_limited',
      `Too many replies were sent from this workspace in the last hour (the limit is ${budget}). Try again in ${Math.ceil(wait / 60)} minutes.`,
      {
        retryAfterSeconds: wait,
      },
    );
    return refusal({ ...f, headers: { 'Retry-After': String(wait) } });
  }

  // ----- the write (never retried)
  let result: Awaited<ReturnType<StoreReviewReplyConnector['replyToReview']>> | undefined;
  let unknownReason: string | undefined;
  try {
    result = await withConnector(ctx, connection, (connector) =>
      connector.replyToReview({ reviewId: review.storeReviewId, text: found.text }),
    );
  } catch (error) {
    if (error instanceof ReplyOutcomeUnknownError || error instanceof ReplyTimeout) {
      unknownReason = error instanceof ReplyTimeout ? 'timeout' : 'network';
    } else {
      const mapped = mapStoreError(error, secret);
      return fail(ctx, {
        app,
        review,
        draft: found,
        actor: input.actor,
        code: mapped.code,
        mapped: mapped.failure,
      });
    }
  }
  if (unknownReason !== undefined) {
    await db.execute(
      `UPDATE review_reply_drafts SET status = 'unknown', error_code = ?, claim_at = NULL, updated_at = ? WHERE id = ?`,
      [unknownReason, ctx.now(), claimId],
    );
    return settle(ctx, {
      app,
      review,
      draft: found,
      actor: input.actor,
      connection,
      secret,
      cause: unknownReason,
    });
  }
  return markSent(ctx, {
    app,
    review,
    draft: found,
    actor: input.actor,
    via: 'store',
    ...(result?.storeResponseId !== undefined ? { storeResponseId: result.storeResponseId } : {}),
    ...(result?.state !== undefined ? { state: result.state } : {}),
    ...(result?.repliedAt !== undefined ? { repliedAt: result.repliedAt } : {}),
    connection,
  });
}

type Settle = {
  app: ManagedApp;
  review: Review;
  draft: ReplyDraft;
  actor: Actor;
  connection: Omit<ReviewConnectorInput, 'fetch'>;
  secret: string;
  cause: string;
};

/**
 * An outcome that is not known: read the review back and decide. The reply is `sent` when the
 * store shows exactly this text, `failed` when the review is readable and shows something else (the
 * draft is kept and may be sent again: both stores overwrite, so it cannot double post; the store
 * can lag, which the message says) and stays `unknown` when the review cannot be read.
 */
async function settle(ctx: ReviewReplyContext, s: Settle): Promise<SendResult> {
  const { db } = ctx;
  const read = await readBack(ctx, s.connection, s.review.storeReviewId, s.draft.text);
  const at = ctx.now();
  const evidence = {
    cause: s.cause,
    checkedAt: at,
    check: read.kind,
    ...(read.kind === 'unreadable' ? { reason: read.reason } : {}),
    ...(read.kind !== 'unreadable'
      ? {
          hadResponse: read.review.developerResponse !== undefined,
          ...(read.review.developerResponse?.state
            ? { responseState: read.review.developerResponse.state }
            : {}),
        }
      : {}),
  };
  if (read.kind === 'matched') {
    const response = read.review.developerResponse;
    return markSent(ctx, {
      app: s.app,
      review: s.review,
      draft: s.draft,
      actor: s.actor,
      via: 'reread',
      evidence,
      ...(response?.storeResponseId !== undefined
        ? { storeResponseId: response.storeResponseId }
        : {}),
      ...(response?.state !== undefined ? { state: response.state } : {}),
      ...(response?.at !== undefined ? { repliedAt: response.at } : {}),
      connection: s.connection,
      skipReread: true,
    });
  }
  if (read.kind === 'no_match') {
    // Keep the store's current answer in the inbox while we are here.
    await refreshResponse(db, s.review, read.review).catch(() => undefined);
    const f = failure(
      502,
      'send_failed',
      'The store did not answer, and reading the review back shows a different reply, so the reply was not published. The draft is kept. The store can be slow to show a new reply: check the review before sending again (sending the same text again replaces, it does not duplicate).',
      { outcome: 'not_applied' },
    );
    return fail(ctx, {
      app: s.app,
      review: s.review,
      draft: s.draft,
      actor: s.actor,
      code: 'not_applied',
      mapped: f,
      evidence,
      outcome: 'failed',
    });
  }
  await db.execute(
    `UPDATE review_reply_drafts SET status = 'unknown', claim_at = NULL, evidence = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(evidence), at, s.draft.id],
  );
  const workspaceId = await workspaceOf(db, s.draft.id);
  const draft = (await loadDraft(db, workspaceId, s.review.id)) ?? s.draft;
  await recordAudit(db, {
    workspaceId,
    actor: s.actor,
    action: 'review.reply_failed',
    target: { type: 'review', id: s.review.id },
    detail: { ...auditDetail(s.app, s.review, s.draft), code: s.cause, outcome: 'unknown' },
    at,
  });
  return failure(
    409,
    'outcome_unknown',
    'It is not known whether the reply was published: the store did not answer and the review could not be read back. Check the review in the store, then send again to check the outcome here.',
    { reply: draft },
  );
}

async function workspaceOf(sql: Sql, draftId: string): Promise<string> {
  const [row] = await sql.query('SELECT workspace_id FROM review_reply_drafts WHERE id = ?', [
    draftId,
  ]);
  return String(row?.workspace_id ?? '');
}

/** A refusal or a failure at the store: the draft is kept as `failed` (or `unknown`), audited, and the answer says why. */
async function fail(
  ctx: ReviewReplyContext,
  s: {
    app: ManagedApp;
    review: Review;
    draft: ReplyDraft;
    actor: Actor;
    code: string;
    mapped: Failure;
    evidence?: Record<string, unknown>;
    outcome?: 'failed';
  },
): Promise<Failure> {
  const { db } = ctx;
  const at = ctx.now();
  const workspaceId = await workspaceOf(db, s.draft.id);
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE review_reply_drafts SET status = 'failed', error_code = ?, claim_at = NULL, evidence = ?, updated_at = ? WHERE id = ?`,
      [s.code, s.evidence ? JSON.stringify(s.evidence) : null, at, s.draft.id],
    );
    await recordAudit(tx, {
      workspaceId,
      actor: s.actor,
      action: 'review.reply_failed',
      target: { type: 'review', id: s.review.id },
      detail: {
        ...auditDetail(s.app, s.review, s.draft),
        code: s.code,
        outcome: s.outcome ?? 'failed',
      },
      at,
    });
  });
  const draft = await loadDraft(db, workspaceId, s.review.id);
  return { ...s.mapped, body: { ...s.mapped.body, ...(draft ? { reply: draft } : {}) } };
}

/** Copies what the store shows as the developer response into the stored review. Best effort. */
async function refreshResponse(sql: Sql, review: Review, fresh: StoreReview): Promise<void> {
  const response = fresh.developerResponse;
  await sql.execute('UPDATE app_reviews SET developer_response = ?, fetched_at = ? WHERE id = ?', [
    response ? responseJson(response) : null,
    Date.now(),
    review.id,
  ]);
}

async function markSent(
  ctx: ReviewReplyContext,
  s: {
    app: ManagedApp;
    review: Review;
    draft: ReplyDraft;
    actor: Actor;
    via: 'store' | 'reread';
    storeResponseId?: string;
    state?: string;
    repliedAt?: number;
    evidence?: Record<string, unknown>;
    connection: Omit<ReviewConnectorInput, 'fetch'>;
    skipReread?: boolean;
  },
): Promise<SendResult> {
  const { db } = ctx;
  const at = ctx.now();
  const workspaceId = await workspaceOf(db, s.draft.id);
  const evidence = s.evidence ?? { via: s.via };
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE review_reply_drafts SET status = 'sent', sent_at = ?, sent_by = ?, claim_at = NULL, error_code = NULL,
              evidence = ?, store_response_id = ?, updated_at = ?
        WHERE id = ?`,
      [at, s.actor.id, JSON.stringify(evidence), s.storeResponseId ?? null, at, s.draft.id],
    );
    // What the store accepted, so the inbox shows the reply at once; a re-read below (or the next
    // sync) replaces it with what the store says.
    await tx.execute(
      `UPDATE app_reviews SET developer_response = ?, fetched_at = ?,
              status = CASE WHEN status = 'new' THEN 'triaged' ELSE status END,
              status_changed_at = CASE WHEN status = 'new' THEN ? ELSE status_changed_at END,
              status_changed_by = CASE WHEN status = 'new' THEN ? ELSE status_changed_by END
        WHERE id = ?`,
      [
        responseJson({ body: s.draft.text, at: s.repliedAt ?? at, state: s.state ?? null }),
        at,
        at,
        s.actor.id,
        s.review.id,
      ],
    );
    await recordAudit(tx, {
      workspaceId,
      actor: s.actor,
      action: 'review.reply_sent',
      target: { type: 'review', id: s.review.id },
      detail: {
        ...auditDetail(s.app, s.review, s.draft),
        via: s.via,
        ...(s.state ? { state: s.state } : {}),
        ...(s.review.status === 'new' ? { statusFrom: 'new', statusTo: 'triaged' } : {}),
      },
      at,
    });
    // Ids only: never the reply text, the review text or a name.
    await emitEvent(tx, {
      workspaceId,
      type: 'review.reply_sent',
      subject: { appId: s.app.id },
      payload: {
        reviewId: s.review.id,
        storeReviewId: s.review.storeReviewId,
        appId: s.app.id,
        store: s.review.store,
        actor: { type: s.actor.type, id: s.actor.id },
      },
      at,
    });
  });

  // Best effort: ask the store what it shows now.
  if (!s.skipReread) {
    try {
      const fresh = await withConnector(
        ctx,
        { ...s.connection, secret: s.connection.secret },
        (connector) => connector.getReview(s.review.storeReviewId),
      );
      if (fresh?.developerResponse) await refreshResponse(db, s.review, fresh);
    } catch {
      // The sync converges on the store's truth.
    }
  }
  const reply = (await loadDraft(db, workspaceId, s.review.id)) as ReplyDraft;
  const reviewView = (await getReviewView(db, workspaceId, s.app.id, s.review.id)) as ReviewView;
  return { ok: true, reply, review: reviewView, confirmedByReread: s.via === 'reread' };
}

// ---------------------------------------------------------------------------------------------
// Config shown to the UI

export type ReplyConfig = {
  enabled: boolean;
  envName: string;
  limits: { appstoreconnect: number; googleplay: number };
  sendsPerHour: number;
  translation: { available: boolean };
  templates: { max: number; placeholders: readonly string[] };
};

export const replyConfig = (
  ctx: Pick<ReviewReplyContext, 'replyEnabled' | 'sendsPerHour' | 'translateDraft'>,
): ReplyConfig => ({
  enabled: ctx.replyEnabled,
  envName: REPLY_ENV,
  limits: { appstoreconnect: APPLE_REPLY_LIMIT, googleplay: PLAY_REPLY_LIMIT },
  sendsPerHour: ctx.sendsPerHour ?? DEFAULT_REPLY_SENDS_PER_HOUR,
  translation: { available: ctx.translateDraft !== undefined },
  templates: { max: MAX_REPLY_TEMPLATES, placeholders: templatePlaceholders },
});

// Param is imported for the types of callers that build their own queries.
export type { Param };
