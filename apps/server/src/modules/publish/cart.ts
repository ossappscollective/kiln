import { createHash } from 'node:crypto';
import type { Platform, StoreId } from '@kiln/core';
import type { Database } from '@kiln/db';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { getPolicy } from '../../services/step-up.ts';
import { deleteReplyDraft, REPLY_ENV, type ReviewReplyContext, sendReviewReply } from '../reviews/replies.ts';
import { storeFor } from '../reviews/sync.ts';
import { loadPendingFacts } from './pending.ts';
import { buildStagedView, type StagedContext, unstage } from './staged-changes.ts';
import { applyDraftPush, DRAFT_ENV, type DraftContext, previewDraftPush } from './store-draft.ts';

/**
 * The pending cart of an app (docs/api/pending.md, docs/adr/0054-pending-cart.md): everything that was prepared here and not sent
 * yet, as ONE flat list of typed items, and the two things the cart does with a chosen subset: publish it and discard it.
 *
 * - NO new state. Every item is an adapter over an existing table: staged texts, graphics and release fields (`staged_changes`)
 *   and reply drafts (`review_reply_drafts`). The cart never writes a store itself: publishing calls `applyDraftPush` and
 *   `sendReviewReply`, which keep their switch, claim, re-read, audit and refusal on drift. Submitting, releasing and rollout
 *   steps are irreversible and ask for typed phrases: they are not in the cart (the publish page keeps them).
 * - "Publish" here is what each kind's own send is: a staged change is written to the store as a DRAFT (nothing is submitted),
 *   a reply is public at once. Staged changes are written by ONE push per app, so they form a bundle: all or none (`bundle`).
 *   A request that names only part of a bundle, or an item whose `version` is not the one that was listed, is skipped: nothing
 *   is sent that the person did not see in the cart.
 * - One failure never stops the others. Per item result: ok, failed or skipped, with a reason code. Text of a listing or a reply is
 *   in the list (the staged view and the review inbox show it too) and never in an audit entry or an event.
 */

export const CART_KINDS = ['listing', 'graphics', 'release', 'review_reply'] as const;
export type CartKind = (typeof CART_KINDS)[number];

export type CartReason = {
  code: 'no_right' | 'switch_off' | 'invalid' | 'bundle_blocked' | 'in_progress' | 'outcome_unknown';
  /** The right the caller lacks. */
  action?: string;
  /** The switch that is off. */
  envName?: string;
};

export type CartItem = {
  /** `<kind>:<id of the staged row or set, or the review id>`. */
  id: string;
  kind: CartKind;
  /** A field or slot label, or the reviewer's title. */
  title: string;
  /** Short excerpt of the new text (staged text, release field, reply), whitespace collapsed; null for graphics. */
  summary: string | null;
  /** Short excerpt of what the store has now, when known. */
  before: string | null;
  platform: Platform;
  store: StoreId;
  locale: string | null;
  createdAt: number;
  author: { id: string; name: string | null } | null;
  /** `store_draft`: written as a draft, nothing is submitted. `public_reply`: public as soon as it is sent. */
  risk: 'store_draft' | 'public_reply';
  /** The workspace's step-up policy asks this person to confirm the send again. */
  needsApproval: boolean;
  publishable: boolean;
  reason: CartReason | null;
  canDiscard: boolean;
  /** Items with the same bundle are sent together. Null: alone. */
  bundle: string | null;
  /** Changes when the content does. A publish names it, so a stale list cannot send newer content. */
  version: string;
  counts: Record<string, number>;
  problems: { code: string; severity: 'error' | 'warning'; message: string }[];
  /** Where it was made (the web turns it into a link). */
  ref: { locale?: string; field?: string; slot?: string; reviewId?: string };
  /** Reply items: the review it answers. */
  review?: { rating: number; excerpt: string; language: string | null; territory: string | null; status: string };
};

export type CartRights = {
  push: boolean;
  reply: boolean;
  discardStaged: boolean;
  discardReply: boolean;
};

export type CartContext = {
  db: Database;
  now: () => number;
  draft: DraftContext;
  staged: StagedContext;
  reply: ReviewReplyContext;
};

type Actor = { type: 'user' | 'token' | 'system'; id: string };

const EXCERPT = 140;
const excerpt = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
};
const sha = (parts: readonly string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

type Raw = { kind: CartKind; rawId: string; reviewId?: string };
export type LoadedCart = { items: CartItem[]; raw: Map<string, Raw> };

const order = (a: CartItem, b: CartItem) =>
  CART_KINDS.indexOf(a.kind) - CART_KINDS.indexOf(b.kind) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

async function authorsOf(db: Database, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => id !== '');
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await db.query(
    `SELECT id, display_name FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`,
    unique,
  );
  for (const r of rows) out.set(String(r.id), String(r.display_name));
  return out;
}

/** The cart of an app, from stored state only: no store and no repository is read. */
export async function loadCart(
  ctx: Pick<CartContext, 'db' | 'now' | 'draft' | 'reply'>,
  input: { workspaceId: string; app: ManagedApp; rights: CartRights },
): Promise<LoadedCart> {
  const { db } = ctx;
  const { app, rights, workspaceId } = input;
  const platform = app.platform;
  const store = storeFor(platform);
  const policy = await getPolicy(db, workspaceId);
  const pushApproval = policy.mode === 'hard_actions' && policy.actions.includes('store.push_draft');
  const items: CartItem[] = [];
  const raw = new Map<string, Raw>();
  const authorIds: string[] = [];

  // ----- staged listing texts, graphics and release fields (one push writes them all) -----
  const facts = await loadPendingFacts(db, { workspaceId, appId: app.id, now: ctx.now() });
  if (facts.unpushed.has(app.id)) {
    const view = await buildStagedView({ db, now: ctx.now }, workspaceId, app);
    const bundle = `push:${app.id}`;
    const staged: CartItem[] = [];
    const base = (kind: CartKind, rawId: string) => ({
      id: `${kind}:${rawId}`,
      kind,
      platform,
      store,
      risk: 'store_draft' as const,
      needsApproval: pushApproval,
      canDiscard: rights.discardStaged,
      bundle,
    });
    for (const t of view.text.filter((x) => !x.pushed && x.status !== 'unchanged')) {
      authorIds.push(t.createdBy);
      raw.set(`listing:${t.id}`, { kind: 'listing', rawId: t.id });
      staged.push({
        ...base('listing', t.id),
        title: t.label,
        summary: excerpt(t.value),
        before: excerpt(t.before),
        locale: t.locale,
        createdAt: t.createdAt,
        author: { id: t.createdBy, name: null },
        publishable: true,
        reason: null,
        version: sha(['listing', t.id, t.valueHash]),
        counts: { length: t.value.length },
        problems: t.problems.filter((p) => p.severity !== 'info').map((p) => ({ code: p.code, severity: p.severity as 'error' | 'warning', message: p.message })),
        ref: { locale: t.locale, field: t.field },
      });
    }
    for (const a of view.assets.filter((x) => !x.pushed)) {
      raw.set(`graphics:${a.id}`, { kind: 'graphics', rawId: a.id });
      staged.push({
        ...base('graphics', a.id),
        title: a.label,
        summary: null,
        before: null,
        locale: a.locale,
        createdAt: a.createdAt,
        author: null,
        publishable: true,
        reason: null,
        version: sha(['graphics', a.id, ...a.files.map((f) => f.oid)]),
        counts: { files: a.files.length },
        problems: a.problems.filter((p) => p.severity !== 'info').map((p) => ({ code: p.code, severity: p.severity as 'error' | 'warning', message: p.message })),
        ref: { locale: a.locale, slot: a.slotKey },
      });
    }
    for (const r of (view.release ?? []).filter((x) => !x.pushed && !x.localOnly)) {
      authorIds.push(r.createdBy);
      raw.set(`release:${r.id}`, { kind: 'release', rawId: r.id });
      staged.push({
        ...base('release', r.id),
        title: r.label,
        summary: excerpt(r.value),
        before: null,
        locale: r.locale === '' ? null : r.locale,
        createdAt: r.createdAt,
        author: { id: r.createdBy, name: null },
        publishable: true,
        reason: null,
        version: sha(['release', r.id, r.valueHash]),
        counts: {},
        problems: r.problems.filter((p) => p.severity !== 'info').map((p) => ({ code: p.code, severity: p.severity as 'error' | 'warning', message: p.message })),
        ref: { field: r.field, ...(r.locale ? { locale: r.locale } : {}) },
      });
    }
    // The push refuses while anything staged has an error, and it needs its switch and right: say why, per item.
    const invalid = staged.some((i) => i.problems.some((p) => p.severity === 'error'));
    for (const i of staged) {
      const own = i.problems.some((p) => p.severity === 'error');
      const reason: CartReason | null = !ctx.draft.draftEnabled
        ? { code: 'switch_off', envName: DRAFT_ENV }
        : !rights.push
          ? { code: 'no_right', action: 'store.push_draft' }
          : own
            ? { code: 'invalid' }
            : invalid
              ? { code: 'bundle_blocked' }
              : null;
      i.reason = reason;
      i.publishable = reason === null;
    }
    items.push(...staged);
  }

  // ----- reply drafts (status draft or failed can be sent; the others only say why not) -----
  const drafts = await db.query(
    `SELECT d.review_id, d.status, d.text, d.text_hash, d.created_by, d.created_at, d.updated_at,
            r.rating, r.title, r.body, r.language, r.territory, r.status AS review_status
       FROM review_reply_drafts d JOIN app_reviews r ON r.id = d.review_id
      WHERE d.workspace_id = ? AND d.app_id = ? AND d.status IN ('draft', 'failed', 'sending', 'unknown')`,
    [workspaceId, app.id],
  );
  for (const d of drafts) {
    const reviewId = String(d.review_id);
    const status = String(d.status);
    const createdBy = String(d.created_by);
    authorIds.push(createdBy);
    raw.set(`review_reply:${reviewId}`, { kind: 'review_reply', rawId: reviewId, reviewId });
    const reason: CartReason | null = !ctx.reply.replyEnabled
      ? { code: 'switch_off', envName: REPLY_ENV }
      : !rights.reply
        ? { code: 'no_right', action: 'reviews.reply' }
        : status === 'sending'
          ? { code: 'in_progress' }
          : status === 'unknown'
            ? { code: 'outcome_unknown' }
            : null;
    items.push({
      id: `review_reply:${reviewId}`,
      kind: 'review_reply',
      title: excerpt(d.title === null ? null : String(d.title)) ?? '',
      summary: excerpt(String(d.text)),
      before: null,
      platform,
      store,
      locale: d.language === null ? null : String(d.language),
      createdAt: Number(d.created_at),
      author: { id: createdBy, name: null },
      risk: 'public_reply',
      needsApproval: false,
      publishable: reason === null,
      reason,
      canDiscard: rights.discardReply && status !== 'sending' && status !== 'unknown',
      bundle: null,
      version: String(d.text_hash),
      counts: { length: String(d.text).length },
      problems: [],
      ref: { reviewId },
      review: {
        rating: Number(d.rating),
        excerpt: excerpt(String(d.body)) ?? '',
        language: d.language === null ? null : String(d.language),
        territory: d.territory === null ? null : String(d.territory),
        status,
      },
    });
  }

  const names = await authorsOf(db, authorIds);
  for (const i of items) if (i.author) i.author.name = names.get(i.author.id) ?? null;
  items.sort(order);
  return { items, raw };
}

export async function getCart(
  ctx: Pick<CartContext, 'db' | 'now' | 'draft' | 'reply'>,
  input: { workspaceId: string; appId: string; rights: CartRights },
): Promise<{ ok: true; items: CartItem[]; generatedAt: number } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const { items } = await loadCart(ctx, { workspaceId: input.workspaceId, app, rights: input.rights });
  return { ok: true, items, generatedAt: ctx.now() };
}

// ---------------------------------------------------------------------------------------------
// Publish and discard a subset

export type CartResult = {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  /** Why it failed or was skipped: a cart code (`not_pending`, `changed_since_review`, `bundle_incomplete`, a reason code of the item) or the code the store step answered. */
  reason: string | null;
  httpStatus?: number;
};

export type CartRequestItem = { id: string; version: string };

const failed = (id: string, f: Failure): CartResult => ({ id, status: 'failed', reason: f.body.error, httpStatus: f.status });

export async function publishCart(
  ctx: CartContext,
  input: { workspaceId: string; appId: string; items: CartRequestItem[]; rights: CartRights; actor: Actor },
): Promise<{ ok: true; results: CartResult[]; remaining: number } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const cart = await loadCart(ctx, { workspaceId: input.workspaceId, app, rights: input.rights });
  const byId = new Map(cart.items.map((i) => [i.id, i]));
  const asked = new Map<string, string>();
  for (const i of input.items) if (!asked.has(i.id)) asked.set(i.id, i.version);
  const results = new Map<string, CartResult>();
  const bundles = new Map<string, { status: CartResult['status']; reason: string | null; httpStatus?: number }>();

  for (const [id, version] of asked) {
    const item = byId.get(id);
    if (!item) {
      results.set(id, { id, status: 'skipped', reason: 'not_pending' });
      continue;
    }
    if (item.version !== version) {
      results.set(id, { id, status: 'skipped', reason: 'changed_since_review' });
      continue;
    }
    if (!item.publishable) {
      results.set(id, { id, status: 'skipped', reason: item.reason?.code ?? 'not_publishable' });
      continue;
    }
    if (item.kind === 'review_reply') {
      const done = await sendReviewReply(ctx.reply, {
        workspaceId: input.workspaceId,
        appId: app.id,
        reviewId: item.ref.reviewId ?? '',
        confirmHash: item.version,
        actor: input.actor,
      });
      results.set(id, done.ok ? { id, status: 'ok', reason: null } : failed(id, done));
      continue;
    }
    // A staged change: one push for the whole bundle, only when the person named every member at the version listed.
    const bundle = item.bundle ?? '';
    let outcome = bundles.get(bundle);
    if (!outcome) {
      const members = cart.items.filter((i) => i.bundle === bundle);
      const missing = members.some((m) => !asked.has(m.id));
      const stale = members.some((m) => asked.get(m.id) !== m.version);
      if (missing) outcome = { status: 'skipped', reason: 'bundle_incomplete' };
      else if (stale) outcome = { status: 'skipped', reason: 'changed_since_review' };
      else {
        const preview = await previewDraftPush(ctx.draft, {
          workspaceId: input.workspaceId,
          appId: app.id,
          actor: input.actor,
        });
        if (!preview.ok) outcome = { status: 'failed', reason: preview.body.error, httpStatus: preview.status };
        else {
          const pushed = await applyDraftPush(ctx.draft, {
            workspaceId: input.workspaceId,
            appId: app.id,
            confirmHash: preview.preview.confirmHash,
            actor: input.actor,
          });
          outcome = pushed.ok
            ? { status: 'ok', reason: null }
            : { status: 'failed', reason: pushed.body.error, httpStatus: pushed.status };
        }
      }
      bundles.set(bundle, outcome);
    }
    results.set(id, { id, ...outcome });
  }

  const list = [...results.values()];
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'pending.cart_published',
    target: { type: 'app', id: app.id },
    detail: {
      appId: app.id,
      requested: list.length,
      ok: list.filter((r) => r.status === 'ok').length,
      failed: list.filter((r) => r.status === 'failed').length,
      skipped: list.filter((r) => r.status === 'skipped').length,
      outcomes: list.map((r) => ({ id: r.id, status: r.status, reason: r.reason })),
    },
    at: ctx.now(),
  });
  const after = await loadCart(ctx, { workspaceId: input.workspaceId, app, rights: input.rights });
  return { ok: true, results: list, remaining: after.items.length };
}

export async function discardCart(
  ctx: CartContext,
  input: { workspaceId: string; appId: string; ids: string[]; rights: CartRights; actor: Actor },
): Promise<{ ok: true; results: CartResult[]; remaining: number } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const cart = await loadCart(ctx, { workspaceId: input.workspaceId, app, rights: input.rights });
  const byId = new Map(cart.items.map((i) => [i.id, i]));
  const results: CartResult[] = [];
  for (const id of [...new Set(input.ids)]) {
    const item = byId.get(id);
    const raw = cart.raw.get(id);
    if (!item || !raw) {
      results.push({ id, status: 'skipped', reason: 'not_pending' });
      continue;
    }
    if (!item.canDiscard) {
      results.push({ id, status: 'skipped', reason: 'no_right' });
      continue;
    }
    const done =
      item.kind === 'review_reply'
        ? await deleteReplyDraft(ctx.reply, {
            workspaceId: input.workspaceId,
            appId: app.id,
            reviewId: raw.rawId,
            actor: input.actor,
          })
        : await unstage(ctx.staged, {
            workspaceId: input.workspaceId,
            appId: app.id,
            id: raw.rawId,
            actor: input.actor,
          });
    results.push(done.ok ? { id, status: 'ok', reason: null } : failed(id, done));
  }
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'pending.cart_discarded',
    target: { type: 'app', id: app.id },
    detail: {
      appId: app.id,
      requested: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      outcomes: results.map((r) => ({ id: r.id, status: r.status, reason: r.reason })),
    },
    at: ctx.now(),
  });
  const after = await loadCart(ctx, { workspaceId: input.workspaceId, app, rights: input.rights });
  return { ok: true, results, remaining: after.items.length };
}
