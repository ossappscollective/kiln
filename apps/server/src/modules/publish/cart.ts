import { createHash } from 'node:crypto';
import type { Platform, StoreId } from '@kiln/core';
import type { Database } from '@kiln/db';
import { getApp, listApps, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { getPolicy } from '../../services/step-up.ts';
import { lastStoreImages } from '../listing/store-images.ts';
import {
  confirmationFailure,
  type PriceItemResult,
  phraseMatches,
  sendPrices,
} from '../monetization/price-publish.ts';
import {
  PRICE_ENV,
  type PriceContext,
  priceSwitch,
  type StagedPrice,
} from '../monetization/price-shared.ts';
import {
  listStagedPrices,
  type StagedPriceView,
  unstagePrice,
  viewOf,
} from '../monetization/price-stage.ts';
import {
  deleteReplyDraft,
  REPLY_ENV,
  type ReviewReplyContext,
  sendReviewReply,
} from '../reviews/replies.ts';
import { storeFor } from '../reviews/sync.ts';
import { metadataLock } from './metadata-lock.ts';
import { loadPendingFacts } from './pending.ts';
import { type Publishing, publishingOf } from './publishing.ts';
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

export const CART_KINDS = ['listing', 'graphics', 'release', 'price', 'review_reply'] as const;
export type CartKind = (typeof CART_KINDS)[number];

export type CartReason = {
  code:
    | 'no_right'
    | 'switch_off'
    | 'workspace_off'
    | 'metadata_locked'
    | 'invalid'
    | 'bundle_blocked'
    | 'in_progress'
    | 'outcome_unknown';
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
  risk: 'store_draft' | 'public_reply' | 'financial';
  /** The workspace's step-up policy asks this person to confirm the send again. Always true for a price (it also needs the typed phrase). */
  needsApproval: boolean;
  publishable: boolean;
  reason: CartReason | null;
  canDiscard: boolean;
  /** Items with the same bundle are sent together. Null: alone. */
  bundle: string | null;
  /** Changes when the content does. A publish names it, so a stale list cannot send newer content. */
  version: string;
  /** Graphics: `files` (after), `before` (the images the last store read held for the set, when there was one), `uploads`. */
  counts: Record<string, number>;
  /** Graphics: addresses (`GET .../staged/assets/blob?oid=`, same origin) of up to four uploaded files of the set. Empty otherwise. */
  thumbs: string[];
  problems: { code: string; severity: 'error' | 'warning'; message: string }[];
  /** Where it was made (the web turns it into a link). */
  ref: { locale?: string; field?: string; slot?: string; reviewId?: string };
  /** Price items: before and after per territory (minor units), percent change, date, what happens to existing subscribers. */
  price?: StagedPriceView;
  /** Reply items: the review it answers. */
  review?: {
    rating: number;
    excerpt: string;
    language: string | null;
    territory: string | null;
    status: string;
  };
};

export type CartRights = {
  push: boolean;
  reply: boolean;
  discardStaged: boolean;
  discardReply: boolean;
  /** `monetization.price`: may send prices (staging needs it too). */
  price: boolean;
};

export type CartContext = {
  db: Database;
  now: () => number;
  draft: DraftContext;
  staged: StagedContext;
  reply: ReviewReplyContext;
  price: PriceContext;
};

type Actor = { type: 'user' | 'token' | 'system'; id: string };

const EXCERPT = 140;
const excerpt = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
};
const sha = (parts: readonly string[]) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

type Raw = { kind: CartKind; rawId: string; reviewId?: string };
export type LoadedCart = { items: CartItem[]; raw: Map<string, Raw> };

const order = (a: CartItem, b: CartItem) =>
  CART_KINDS.indexOf(a.kind) - CART_KINDS.indexOf(b.kind) ||
  a.createdAt - b.createdAt ||
  (a.id < b.id ? -1 : 1);

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
  ctx: Pick<CartContext, 'db' | 'now' | 'draft' | 'reply' | 'price'>,
  input: { workspaceId: string; app: ManagedApp; rights: CartRights },
): Promise<LoadedCart> {
  const { db } = ctx;
  const { app, rights, workspaceId } = input;
  const platform = app.platform;
  const store = storeFor(platform);
  const policy = await getPolicy(db, workspaceId);
  const pushApproval =
    policy.mode === 'hard_actions' && policy.actions.includes('store.push_draft');
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
        thumbs: [],
        problems: t.problems
          .filter((p) => p.severity !== 'info')
          .map((p) => ({
            code: p.code,
            severity: p.severity as 'error' | 'warning',
            message: p.message,
          })),
        ref: { locale: t.locale, field: t.field },
      });
    }
    const lastStore = lastStoreImages(workspaceId, app.id);
    for (const a of view.assets.filter((x) => !x.pushed)) {
      const before = lastStore
        ? lastStore.sets
            .filter(
              (s) => s.locale === a.locale && s.kind === a.slot.kind && s.device === a.slot.device,
            )
            .reduce((n, s) => n + s.files.length, 0)
        : null;
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
        version: sha(['graphics', a.id, ...(a.cleared ? ['cleared'] : []), ...a.files.map((f) => f.oid)]),
        counts: {
          files: a.files.length,
          uploads: a.files.filter((f) => f.upload).length,
          ...(before === null ? {} : { before }),
        },
        thumbs: a.files
          .filter((f) => f.upload)
          .slice(0, 4)
          .map(
            (f) =>
              `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(app.id)}/staged/assets/blob?oid=${f.oid}`,
          ),
        problems: a.problems
          .filter((p) => p.severity !== 'info')
          .map((p) => ({
            code: p.code,
            severity: p.severity as 'error' | 'warning',
            message: p.message,
          })),
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
        thumbs: [],
        problems: r.problems
          .filter((p) => p.severity !== 'info')
          .map((p) => ({
            code: p.code,
            severity: p.severity as 'error' | 'warning',
            message: p.message,
          })),
        ref: { field: r.field, ...(r.locale ? { locale: r.locale } : {}) },
      });
    }
    // The push refuses while anything staged has an error, and it needs its switch and right: say why, per item.
    const invalid = staged.some((i) => i.problems.some((p) => p.severity === 'error'));
    // The push refuses a locked app (a live version): every staged item says so, whatever else is true of it.
    const locked = (await metadataLock(db, workspaceId, app)).locked;
    for (const i of staged) {
      const own = i.problems.some((p) => p.severity === 'error');
      const reason: CartReason | null = !ctx.draft.draftEnabled
        ? { code: 'switch_off', envName: DRAFT_ENV }
        : !rights.push
          ? { code: 'no_right', action: 'store.push_draft' }
          : locked
            ? { code: 'metadata_locked' }
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

  // ----- price changes (a financial write: its own table, never part of the draft push; each product is independent) -----
  const stagedPrices = await listStagedPrices(db, workspaceId, app.id);
  if (stagedPrices.length > 0) {
    const sw = await priceSwitch(ctx.price, workspaceId);
    const snapshot = await db.query(
      'SELECT product_id, plan_id, territory, currency, amount FROM store_product_prices WHERE app_id = ? AND workspace_id = ?',
      [app.id, workspaceId],
    );
    const [claim] = await db.query('SELECT status FROM store_price_claims WHERE app_id = ?', [
      app.id,
    ]);
    for (const p of stagedPrices) {
      authorIds.push(p.createdBy);
      raw.set(`price:${p.id}`, { kind: 'price', rawId: p.id });
      const view = viewOf(p);
      const current = snapshot
        .filter(
          (r) =>
            String(r.product_id) === p.change.productId &&
            String(r.plan_id) === (p.change.planId ?? ''),
        )
        .map((r) => ({
          territory: String(r.territory),
          currency: String(r.currency),
          amount: String(r.amount),
        }));
      // The synced price moved since this was staged: the cart says so, and a send would refuse it anyway.
      const moved = p.change.lines.some(
        (l) => current.find((c) => c.territory === l.territory)?.amount !== l.currentAmount,
      );
      const reason: CartReason | null = !ctx.price.enabled
        ? { code: 'switch_off', envName: PRICE_ENV }
        : !sw.workspaceEnabled
          ? { code: 'workspace_off' }
          : !rights.price
            ? { code: 'no_right', action: 'monetization.price' }
            : claim
              ? { code: String(claim.status) === 'unknown' ? 'outcome_unknown' : 'in_progress' }
              : moved
                ? { code: 'invalid' }
                : null;
      items.push({
        id: `price:${p.id}`,
        kind: 'price',
        title: p.change.planId ? `${p.change.productId} · ${p.change.planId}` : p.change.productId,
        summary: null,
        before: null,
        platform,
        store,
        locale: null,
        createdAt: p.createdAt,
        author: { id: p.createdBy, name: null },
        risk: 'financial',
        needsApproval: true,
        publishable: reason === null,
        reason,
        canDiscard: rights.discardStaged,
        bundle: null,
        version: p.valueHash,
        counts: { territories: p.change.lines.length },
        thumbs: [],
        problems: moved
          ? [
              {
                code: 'stale_price',
                severity: 'error',
                message:
                  'The synced price changed since this was staged. Discard it and stage it again.',
              },
            ]
          : [],
        ref: { field: p.change.productId },
        price: view,
      });
    }
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
      thumbs: [],
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
  ctx: Pick<CartContext, 'db' | 'now' | 'draft' | 'reply' | 'price'>,
  input: {
    workspaceId: string;
    appId: string;
    rights: CartRights;
    claimTtlMs?: number | undefined;
  },
): Promise<
  { ok: true; items: CartItem[]; publishing: Publishing | null; generatedAt: number } | Failure
> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const { items } = await loadCart(ctx, {
    workspaceId: input.workspaceId,
    app,
    rights: input.rights,
  });
  // A batch publish of this app that runs now (see `publishing.ts`): its items are being written, so the screens show them as such.
  const publishing = await publishingOf(ctx.db, {
    workspaceId: input.workspaceId,
    appId: app.id,
    now: ctx.now(),
    ttlMs: input.claimTtlMs,
  });
  return { ok: true, items, publishing, generatedAt: ctx.now() };
}

// ---------------------------------------------------------------------------------------------
// The preview of one item (docs/adr/0067-diff-and-preview.md): the full before and after the list only excerpts

/** Longest text of one side that a detail carries (the longest listing text is 4000 characters); the rest is cut and flagged. */
export const DETAIL_TEXT_MAX = 8000;
/** Most images per side in a graphics detail. */
export const DETAIL_IMAGES_MAX = 30;

export type CartImageRef = {
  position: number;
  name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /** A same origin address of Kiln's own image routes (staged blob, repository file, store thumbnail proxy); never a store address. */
  url: string;
};

export type CartDetail = {
  id: string;
  kind: CartKind;
  /** The item's `version`: a client keeps a detail only while it is the version of the listed item. */
  version: string;
  /** Listing text and release field: the text now in the store (null: not known here) and the staged text. */
  text?: {
    field: string;
    locale: string | null;
    before: string | null;
    after: string;
    limit: number | null;
    unit: 'characters' | 'bytes';
    truncated: boolean;
  };
  /** Graphics: the images of the set the last store read held (null: there was no read) and the staged files, in order. */
  graphics?: {
    before: CartImageRef[] | null;
    beforeReadAt: number | null;
    after: CartImageRef[];
    truncated: boolean;
  };
  /** Review reply: the draft and the review it answers. */
  reply?: {
    text: string;
    truncated: boolean;
    review: {
      rating: number;
      title: string | null;
      body: string;
      language: string | null;
      territory: string | null;
      truncated: boolean;
    };
  };
};

const cut = (value: string): { text: string; truncated: boolean } =>
  value.length > DETAIL_TEXT_MAX
    ? { text: value.slice(0, DETAIL_TEXT_MAX), truncated: true }
    : { text: value, truncated: false };
const baseName = (path: string): string | null => path.split('/').pop() || null;

/**
 * One item of the cart with its full before and after text, or its before and after images. Reads stored state only, with the right
 * of the cart itself (`listing.read`); an id that is not in this app's cart (or not in this workspace) is `404 not_found`.
 */
export async function cartItemDetail(
  ctx: Pick<CartContext, 'db' | 'now' | 'draft' | 'reply' | 'price'>,
  input: { workspaceId: string; appId: string; id: string; rights: CartRights },
): Promise<{ ok: true; detail: CartDetail } | Failure> {
  const { db } = ctx;
  const { workspaceId } = input;
  const app = await getApp(db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const { items, raw } = await loadCart(ctx, { workspaceId, app, rights: input.rights });
  const item = items.find((i) => i.id === input.id);
  const ref = raw.get(input.id);
  if (!item || !ref) return failure(404, 'not_found');
  const detail: CartDetail = { id: item.id, kind: item.kind, version: item.version };
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(app.id)}`;
  if (item.kind === 'listing' || item.kind === 'release' || item.kind === 'graphics') {
    const view = await buildStagedView({ db, now: ctx.now }, workspaceId, app);
    if (item.kind === 'listing') {
      const t = view.text.find((x) => x.id === ref.rawId);
      if (!t) return failure(404, 'not_found');
      const after = cut(t.value);
      const before = t.before === null ? null : cut(t.before);
      detail.text = {
        field: t.field,
        locale: t.locale,
        before: before?.text ?? null,
        after: after.text,
        limit: t.limit,
        unit: t.unit,
        truncated: after.truncated || (before?.truncated ?? false),
      };
    } else if (item.kind === 'release') {
      const r = (view.release ?? []).find((x) => x.id === ref.rawId);
      if (!r) return failure(404, 'not_found');
      const after = cut(r.value);
      detail.text = {
        field: r.field,
        locale: r.locale === '' ? null : r.locale,
        before: null,
        after: after.text,
        limit: r.maxLength,
        unit: 'characters',
        truncated: after.truncated,
      };
    } else {
      const a = view.assets.find((x) => x.id === ref.rawId);
      if (!a) return failure(404, 'not_found');
      const files = a.files.slice(0, DETAIL_IMAGES_MAX).map((f) => ({
        position: f.position,
        name: baseName(f.path),
        width: f.width,
        height: f.height,
        bytes: f.bytes,
        url: f.upload
          ? `${base}/staged/assets/blob?oid=${encodeURIComponent(f.oid)}`
          : `${base}/assets/file?path=${encodeURIComponent(f.path)}${f.commit ? `&commit=${encodeURIComponent(f.commit)}` : ''}`,
      }));
      const last = lastStoreImages(workspaceId, app.id);
      const before = last
        ? last.sets
            .filter(
              (s) => s.locale === a.locale && s.kind === a.slot.kind && s.device === a.slot.device,
            )
            .flatMap((s) => s.files)
            .sort((x, y) => x.position - y.position)
            .slice(0, DETAIL_IMAGES_MAX)
            .map((f) => ({
              position: f.position,
              name: f.name,
              width: f.width,
              height: f.height,
              bytes: f.bytes,
              url: `${base}/assets/store/thumb?ref=${encodeURIComponent(f.ref)}&size=640`,
            }))
        : null;
      detail.graphics = {
        before,
        beforeReadAt: last?.readAt ?? null,
        after: files,
        truncated: a.files.length > DETAIL_IMAGES_MAX,
      };
    }
  } else if (item.kind === 'review_reply') {
    const [d] = await db.query(
      `SELECT d.text, r.rating, r.title, r.body, r.language, r.territory
         FROM review_reply_drafts d JOIN app_reviews r ON r.id = d.review_id
        WHERE d.workspace_id = ? AND d.app_id = ? AND d.review_id = ?`,
      [workspaceId, app.id, ref.rawId],
    );
    if (!d) return failure(404, 'not_found');
    const text = cut(String(d.text));
    const body = cut(String(d.body ?? ''));
    detail.reply = {
      text: text.text,
      truncated: text.truncated,
      review: {
        rating: Number(d.rating),
        title: d.title === null ? null : String(d.title),
        body: body.text,
        language: d.language === null ? null : String(d.language),
        territory: d.territory === null ? null : String(d.territory),
        truncated: body.truncated,
      },
    };
  }
  return { ok: true, detail };
}

// ---------------------------------------------------------------------------------------------
// The workspace-wide count (the nav badge): how many items every app's cart holds, no payload per item

export type CartSummaryApp = {
  /** Both `appId` and `id`, so a token limited to some apps is filtered by the usual rule. */
  appId: string;
  id: string;
  app: { id: string; name: string; platform: Platform; store: StoreId };
  /** Items in this app's cart (exactly the length of its `GET /apps/{id}/pending/cart`). */
  count: number;
  kinds: Partial<Record<CartKind, number>>;
};
export type CartSummary = {
  /** Only apps with something in the cart. */
  apps: CartSummaryApp[];
  totals: { apps: number; count: number };
  generatedAt: number;
};

/** Apps read per request at most (the cost is one cart per app that has anything; the rest of the apps cost no cart at all). */
export const CART_SUMMARY_MAX_APPS = 200;

/**
 * `GET /pending/cart-summary`: the count of every cart of the workspace, from stored state. Three small queries find the apps that
 * hold anything (a staged change, a staged price, a reply draft); only those have their cart built, by the very function behind the
 * app's own cart, so the numbers cannot drift. `appIds` limits the apps (a token limited to some apps).
 */
export async function cartSummary(
  ctx: Pick<CartContext, 'db' | 'now' | 'draft' | 'reply' | 'price'>,
  input: { workspaceId: string; appIds?: readonly string[] | undefined; rights: CartRights },
): Promise<CartSummary> {
  const { db } = ctx;
  const { workspaceId } = input;
  const holding = new Set<string>();
  for (const sql of [
    'SELECT DISTINCT app_id FROM staged_changes WHERE workspace_id = ? AND (pushed_hash IS NULL OR pushed_hash <> value_hash)',
    'SELECT DISTINCT app_id FROM staged_price_changes WHERE workspace_id = ?',
    "SELECT DISTINCT app_id FROM review_reply_drafts WHERE workspace_id = ? AND status IN ('draft', 'failed', 'sending', 'unknown')",
  ]) {
    for (const r of await db.query(sql, [workspaceId])) holding.add(String(r.app_id));
  }
  const wanted = input.appIds === undefined ? undefined : new Set(input.appIds);
  const candidates = (await listApps(db, workspaceId))
    .filter((a) => holding.has(a.id) && (wanted === undefined || wanted.has(a.id)))
    .slice(0, CART_SUMMARY_MAX_APPS);
  const lines: CartSummaryApp[] = [];
  for (const app of candidates) {
    const { items } = await loadCart(ctx, { workspaceId, app, rights: input.rights });
    if (items.length === 0) continue;
    const kinds: Partial<Record<CartKind, number>> = {};
    for (const i of items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    lines.push({
      appId: app.id,
      id: app.id,
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      count: items.length,
      kinds,
    });
  }
  lines.sort(
    (a, b) =>
      b.count - a.count || a.app.name.localeCompare(b.app.name) || a.appId.localeCompare(b.appId),
  );
  return {
    apps: lines,
    totals: { apps: lines.length, count: lines.reduce((n, l) => n + l.count, 0) },
    generatedAt: ctx.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// Publish and discard a subset

export type CartResult = {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  /** Why it failed or was skipped: a cart code (`not_pending`, `changed_since_review`, `bundle_incomplete`, a reason code of the item) or the code the store step answered. */
  reason: string | null;
  httpStatus?: number;
  /** Price items: what the store did per territory and whether a re-read confirms it. */
  price?: PriceItemResult['detail'];
};

export type CartRequestItem = { id: string; version: string };

const failed = (id: string, f: Failure): CartResult => ({
  id,
  status: 'failed',
  reason: f.body.error,
  httpStatus: f.status,
});

export async function publishCart(
  ctx: CartContext,
  input: {
    workspaceId: string;
    appId: string;
    items: CartRequestItem[];
    rights: CartRights;
    actor: Actor;
    confirmation?: string | undefined;
  },
): Promise<{ ok: true; results: CartResult[]; remaining: number } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const cart = await loadCart(ctx, { workspaceId: input.workspaceId, app, rights: input.rights });
  const byId = new Map(cart.items.map((i) => [i.id, i]));
  const asked = new Map<string, string>();
  for (const i of input.items) if (!asked.has(i.id)) asked.set(i.id, i.version);
  const results = new Map<string, CartResult>();
  const bundles = new Map<
    string,
    { status: CartResult['status']; reason: string | null; httpStatus?: number }
  >();

  // Prices: the typed phrase is checked for exactly the price items that would be sent, BEFORE anything is sent (a mismatch sends nothing at all,
  // not even a reply). Each product is independent, so any subset may be named; a product's territories always go together.
  const sendable = [...asked]
    .map(([id, version]) => ({ id, version, item: byId.get(id) }))
    .filter((x) => x.item?.kind === 'price' && x.item.version === x.version && x.item.publishable);
  const priceRows: StagedPrice[] = [];
  if (sendable.length > 0) {
    const all = await listStagedPrices(ctx.db, input.workspaceId, app.id);
    for (const s of sendable) {
      const row = all.find((r) => `price:${r.id}` === s.id);
      if (row) priceRows.push(row);
    }
    if (priceRows.length > 0 && !phraseMatches(input.confirmation, priceRows))
      return confirmationFailure();
  }
  const priceResults =
    priceRows.length > 0
      ? await sendPrices(ctx.price, {
          workspaceId: input.workspaceId,
          app,
          rows: priceRows,
          actor: input.actor,
        })
      : new Map<string, PriceItemResult>();

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
    if (item.kind === 'price') {
      const rowId = item.id.slice('price:'.length);
      const sent = priceResults.get(rowId);
      results.set(
        id,
        sent
          ? {
              id,
              status: sent.status,
              reason: sent.reason,
              ...(sent.httpStatus !== undefined ? { httpStatus: sent.httpStatus } : {}),
              price: sent.detail,
            }
          : { id, status: 'skipped', reason: 'not_pending' },
      );
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
        if (!preview.ok)
          outcome = { status: 'failed', reason: preview.body.error, httpStatus: preview.status };
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
      item.kind === 'price'
        ? await unstagePrice(ctx.price, {
            workspaceId: input.workspaceId,
            appId: app.id,
            id: raw.rawId,
            actor: input.actor,
          })
        : item.kind === 'review_reply'
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
