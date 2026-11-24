import {
  type PriceChange,
  type PriceIssue,
  priceConfirmationPhrase,
  samePhrase,
  staleLines,
  summarizePriceChange,
  utcDate,
  validatePriceChange,
} from '@kiln/core';
import {
  type LivePrices,
  PriceDriftError,
  type PriceLineOutcome,
  priceMismatches,
  type PriceApplyResult,
  type PricePreviewResult,
  type StorePriceWriteConnector,
} from '@kiln/connectors';
import type { Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import type { ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { PRICE_PURPOSE, type PriceContext, type StagedPrice } from './price-shared.ts';
import { type Actor, connect, mapStoreError, StoreTimeout, withConnector } from './shared.ts';
import { readStoredProductRef } from './snapshot.ts';

/**
 * Sending staged prices to the store and showing what would be sent (docs/adr/0062-price-writes.md). Called by the cart's publish, which has
 * already checked the switches, the right, step-up and the typed phrase. What is done here, per item and never retried: take the claim (one
 * price write in flight per app), read the LIVE prices (and Apple's price points), validate again against them, write only if the store still
 * shows what the person saw, read back and compare, audit the amounts and the actor, and drop the staged row only when the store confirms it.
 * One failure never blocks the others.
 */

export type PriceItemResult = {
  status: 'ok' | 'failed';
  /** A code: the store's translated code, a validation code, or `partial`, `outcome_unknown`, `write_in_progress`. */
  reason: string | null;
  httpStatus?: number | undefined;
  detail: {
    productId: string;
    lines: {
      territory: string;
      currency: string;
      before: string;
      after: string;
      outcome: PriceLineOutcome['outcome'];
      code?: string | undefined;
    }[];
    /** `confirmed`: the re-read shows the asked prices. `store_shows`: it shows other prices (`mismatches`). `unverified`: it could not be read. */
    verification: 'confirmed' | 'store_shows' | 'unverified' | 'not_sent';
    mismatches: { territory: string; expected: string; actual: string | null }[];
    migration?: { requested: boolean; outcome: string; code?: string | undefined } | undefined;
    issues?: PriceIssue[] | undefined;
  };
};

/** The phrase the person must type for these items: count of products and the largest change. */
export function phraseFor(rows: readonly StagedPrice[]): string {
  const largest = rows.reduce((m, r) => Math.max(m, summarizePriceChange(r.change).largestBp), 0);
  return priceConfirmationPhrase(rows.length, largest);
}
export const phraseMatches = (typed: string | undefined, rows: readonly StagedPrice[]): boolean =>
  typeof typed === 'string' && samePhrase(typed, phraseFor(rows));

export const confirmationFailure = (): Failure =>
  failure(
    422,
    'confirmation_mismatch',
    'The confirmation phrase is not the one for these price changes. Nothing was sent.',
    coded('prices.confirmationMismatch'),
  );

// ---------------------------------------------------------------------------------------------
// The claim: one price write in flight per app

type Claim = { appId: string; at: number };

async function takeClaim(
  ctx: PriceContext,
  workspaceId: string,
  appId: string,
  actor: Actor,
): Promise<{ ok: true; claim: Claim } | Failure> {
  const claim: Claim = { appId, at: ctx.now() };
  const insert = () =>
    ctx.db.execute(
      "INSERT INTO store_price_claims (app_id, workspace_id, status, claimed_by, claim_at) VALUES (?, ?, 'writing', ?, ?) ON CONFLICT (app_id) DO NOTHING",
      [appId, workspaceId, actor.id, claim.at],
    );
  const busy = () =>
    failure(
      409,
      'write_in_progress',
      'A price change for this app is in progress. Wait for it to finish.',
      coded('prices.busy'),
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await ctx.db.query(
    'SELECT status, claim_at FROM store_price_claims WHERE app_id = ?',
    [appId],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the last price change of this app reached the store. Run a dry run: it reads the store and shows where it stands. Nothing was sent.',
      coded('prices.unknownState'),
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ctx.claimTtlMs) return busy();
  const taken = await ctx.db.execute(
    "UPDATE store_price_claims SET claim_at = ?, claimed_by = ?, workspace_id = ? WHERE app_id = ? AND status = 'writing' AND claim_at = ?",
    [claim.at, actor.id, workspaceId, appId, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
}
const releaseClaim = (sql: Sql, c: Claim) =>
  sql.execute(
    "DELETE FROM store_price_claims WHERE app_id = ? AND claim_at = ? AND status = 'writing'",
    [c.appId, c.at],
  );
const markUnknown = (sql: Sql, c: Claim) =>
  sql.execute(
    "UPDATE store_price_claims SET status = 'unknown' WHERE app_id = ? AND claim_at = ? AND status = 'writing'",
    [c.appId, c.at],
  );
/** A successful live read settles an unknown outcome: the person sees where the store stands. */
const clearUnknown = (sql: Sql, appId: string) =>
  sql.execute("DELETE FROM store_price_claims WHERE app_id = ? AND status = 'unknown'", [appId]);

// ---------------------------------------------------------------------------------------------

const lineDetail = (change: PriceChange, outcomes: readonly PriceLineOutcome[]) =>
  change.lines.map((l) => {
    const o = outcomes.find((x) => x.territory === l.territory);
    return {
      territory: l.territory,
      currency: l.currency,
      before: l.currentAmount,
      after: l.newAmount,
      outcome: o?.outcome ?? ('not_sent' as const),
      ...(o?.code ? { code: o.code } : {}),
    };
  });

const emptyDetail = (row: StagedPrice, issues?: PriceIssue[]): PriceItemResult['detail'] => ({
  productId: row.change.productId,
  lines: lineDetail(row.change, []),
  verification: 'not_sent',
  mismatches: [],
  ...(issues ? { issues } : {}),
});

const needsPoints = (change: PriceChange) => change.store === 'appstoreconnect';

async function validateLive(
  ctx: PriceContext,
  connector: StorePriceWriteConnector,
  ref: { productId: string; kind: PriceChange['kind']; storeRef: string | null },
  change: PriceChange,
): Promise<{ live: LivePrices; issues: PriceIssue[] }> {
  const live = await connector.readPrices(ref, change.planId);
  const points = needsPoints(change)
    ? await connector.pricePoints(ref, [...new Set(change.lines.map((l) => l.territory))])
    : undefined;
  const issues = validatePriceChange(change, {
    current: live.current,
    pricePoints: points,
    today: utcDate(ctx.now()),
    limits: ctx.limits,
  });
  return { live, issues };
}

/** The first problem of a validation as a reason code the cart shows (a store-neutral sentence is looked up by the web). */
const reasonOf = (issues: readonly PriceIssue[]): string => {
  const first = issues[0]?.code ?? 'invalid';
  return first === 'stale_price'
    ? 'stale_price'
    : first === 'currency_mismatch'
      ? 'currency_mismatch'
      : first.startsWith('price_point') || first === 'amount_not_price_point'
        ? 'price_point_invalid'
        : first === 'ack_required'
          ? 'acknowledgement_required'
          : 'invalid_price';
};

export async function sendPrices(
  ctx: PriceContext,
  input: { workspaceId: string; app: ManagedApp; rows: StagedPrice[]; actor: Actor },
): Promise<Map<string, PriceItemResult>> {
  const out = new Map<string, PriceItemResult>();
  const failAll = (
    f: Failure,
    detail: (r: StagedPrice) => PriceItemResult['detail'] = (r) => emptyDetail(r),
  ) => {
    for (const row of input.rows)
      out.set(row.id, {
        status: 'failed',
        reason: f.body.error,
        httpStatus: f.status,
        detail: detail(row),
      });
    return out;
  };
  const claimed = await takeClaim(ctx, input.workspaceId, input.app.id, input.actor);
  if (!claimed.ok) return failAll(claimed);
  const conn = await connect(ctx, input.workspaceId, input.app, PRICE_PURPOSE, input.actor);
  if (!conn.ok) {
    await releaseClaim(ctx.db, claimed.claim);
    return failAll(conn);
  }
  let unknown = false;
  try {
    for (const row of input.rows) {
      const result = await sendOne(ctx, input, conn.connection, row, () => {
        unknown = true;
      });
      out.set(row.id, result);
    }
  } finally {
    if (unknown) await markUnknown(ctx.db, claimed.claim);
    else await releaseClaim(ctx.db, claimed.claim);
  }
  return out;
}

async function sendOne(
  ctx: PriceContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
  connection: {
    input: Parameters<typeof withConnector<StorePriceWriteConnector, unknown>>[1];
    secret: string;
  },
  row: StagedPrice,
  onUnknown: () => void,
): Promise<PriceItemResult> {
  const { change } = row;
  const audit = (action: string, detail: Record<string, unknown>) =>
    recordAudit(ctx.db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action,
      target: { type: 'app', id: input.app.id },
      detail: {
        appId: input.app.id,
        productId: change.productId,
        store: change.store,
        planId: change.planId,
        effectiveDate: change.effectiveDate,
        existingSubscribers: change.existingSubscribers,
        ...detail,
      },
      at: ctx.now(),
    });
  const refused = async (
    code: string,
    status: number,
    extra: Partial<PriceItemResult['detail']> = {},
  ): Promise<PriceItemResult> => {
    await audit('price.change_failed', {
      outcome: 'refused',
      code,
      lines: change.lines.map((l) => ({
        territory: l.territory,
        currency: l.currency,
        before: l.currentAmount,
        after: l.newAmount,
      })),
    });
    return {
      status: 'failed',
      reason: code,
      httpStatus: status,
      detail: { ...emptyDetail(row), ...extra },
    };
  };
  const stored = await readStoredProductRef(
    ctx.db,
    input.workspaceId,
    input.app.id,
    change.productId,
  );
  if (!stored) return refused('product_not_found', 404);
  const ref = { productId: stored.productId, kind: stored.kind, storeRef: stored.storeRef };
  try {
    return await withConnector(ctx.factory, connection.input, ctx.timeoutMs, async (connector) => {
      // 1. The live prices, and every rule again against them.
      const { issues } = await validateLive(ctx, connector, ref, change);
      await clearUnknown(ctx.db, input.app.id);
      if (issues.length > 0)
        return refused(reasonOf(issues), issues[0]?.code === 'stale_price' ? 409 : 422, { issues });
      // 2. The write, only if the store still shows what the person saw (the connector reads again and calls the guard).
      let applied: PriceApplyResult;
      try {
        applied = await connector.apply(
          ref,
          change,
          (l) => staleLines(change, l.current).length === 0,
          ctx.now(),
        );
      } catch (error) {
        if (error instanceof PriceDriftError) return refused('stale_price', 409);
        throw error;
      }
      // 3. Read back and compare, whatever the answers were (a lost answer may still have been applied).
      let after: LivePrices | undefined;
      try {
        after = await connector.readPrices(ref, change.planId);
      } catch {
        after = undefined;
      }
      const mismatches = after ? priceMismatches(change, after, utcDate(ctx.now())) : [];
      const outcomes = applied.lines.map((o): PriceLineOutcome => {
        // A line the store did not confirm is no longer "applied"; one with an unknown answer that the store shows is applied.
        if (
          o.outcome === 'unknown' &&
          after &&
          !mismatches.some((m) => m.territory === o.territory)
        )
          return { ...o, outcome: 'applied' };
        return o;
      });
      const okLines = outcomes.filter(
        (o) => o.outcome === 'applied' || o.outcome === 'already_applied',
      );
      const verification: PriceItemResult['detail']['verification'] = !after
        ? 'unverified'
        : mismatches.length === 0
          ? 'confirmed'
          : 'store_shows';
      const stillUnknown =
        outcomes.some((o) => o.outcome === 'unknown') ||
        (outcomes.some((o) => o.outcome === 'applied') && !after);
      if (stillUnknown) onUnknown();
      const allOk = okLines.length === change.lines.length && verification === 'confirmed';
      const detail: PriceItemResult['detail'] = {
        productId: change.productId,
        lines: lineDetail(change, outcomes),
        verification,
        mismatches,
        ...(applied.migration
          ? {
              migration: {
                requested: applied.migration.requested,
                outcome: applied.migration.outcome,
                ...(applied.migration.code ? { code: applied.migration.code } : {}),
              },
            }
          : {}),
      };
      const summary = summarizePriceChange(change);
      await audit(allOk ? 'price.changed' : 'price.change_failed', {
        outcome: allOk
          ? 'confirmed'
          : stillUnknown
            ? 'unknown'
            : okLines.length > 0
              ? 'partial'
              : 'failed',
        verification,
        largestBp: summary.largestBp,
        lines: detail.lines.map((l, i) => ({
          ...l,
          percentBp: summary.lines[i]?.percentBp ?? null,
        })),
        mismatches,
        ...(detail.migration ? { migration: detail.migration } : {}),
      });
      if (allOk) {
        await ctx.db.execute('DELETE FROM staged_price_changes WHERE id = ? AND value_hash = ?', [
          row.id,
          row.valueHash,
        ]);
        return { status: 'ok', reason: null, detail };
      }
      const firstCode = outcomes.find((o) => o.outcome === 'failed')?.code;
      return {
        status: 'failed',
        reason: stillUnknown
          ? 'outcome_unknown'
          : okLines.length > 0
            ? 'partial'
            : (firstCode ?? 'store_rejected'),
        httpStatus: stillUnknown ? 409 : 422,
        detail,
      };
    });
  } catch (error) {
    if (error instanceof StoreTimeout) {
      onUnknown();
      await audit('price.change_failed', { outcome: 'unknown', code: 'timeout' });
      return {
        status: 'failed',
        reason: 'outcome_unknown',
        httpStatus: 504,
        detail: emptyDetail(row),
      };
    }
    const mapped = mapStoreError(error, connection.secret);
    await audit('price.change_failed', { outcome: 'failed', code: mapped.code });
    return {
      status: 'failed',
      reason: mapped.code,
      httpStatus: mapped.failure.status,
      detail: emptyDetail(row),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Dry run

export type DryRunItem = {
  id: string;
  productId: string;
  summary: ReturnType<typeof summarizePriceChange>;
  /** What the pure validation says against the LIVE prices; empty means it would be sent. */
  issues: PriceIssue[];
  /** The store's own validation (`store`) or the requests that would be sent (`local`). Null when the live read failed. */
  preview: PricePreviewResult | null;
  error: { code: string; message: string } | null;
};

/** Reads the store and shows what a send would do. Writes nothing, takes no claim, needs no phrase. */
export async function dryRunPrices(
  ctx: PriceContext,
  input: { workspaceId: string; app: ManagedApp; rows: StagedPrice[]; actor: Actor },
): Promise<{ ok: true; items: DryRunItem[] } | Failure> {
  const conn = await connect(ctx, input.workspaceId, input.app, PRICE_PURPOSE, input.actor);
  if (!conn.ok) return conn;
  const items: DryRunItem[] = [];
  for (const row of input.rows) {
    const base = {
      id: row.id,
      productId: row.change.productId,
      summary: summarizePriceChange(row.change),
    };
    const stored = await readStoredProductRef(
      ctx.db,
      input.workspaceId,
      input.app.id,
      row.change.productId,
    );
    if (!stored) {
      items.push({
        ...base,
        issues: [],
        preview: null,
        error: { code: 'product_not_found', message: 'No such product. Sync the app first.' },
      });
      continue;
    }
    const ref = { productId: stored.productId, kind: stored.kind, storeRef: stored.storeRef };
    try {
      const item = await withConnector(
        ctx.factory,
        conn.connection.input,
        ctx.timeoutMs,
        async (connector) => {
          const { issues } = await validateLive(ctx, connector, ref, row.change);
          await clearUnknown(ctx.db, input.app.id);
          // The store's validation runs only for a change that passes ours: never ask a store about a change Kiln would refuse.
          const preview =
            issues.length === 0 ? await connector.preview(ref, row.change, ctx.now()) : null;
          return { ...base, issues, preview, error: null };
        },
      );
      items.push(item);
    } catch (error) {
      const mapped =
        error instanceof StoreTimeout
          ? {
              code: 'timeout',
              failure: failure(504, 'timeout', 'The store did not answer in time.'),
            }
          : mapStoreError(error, conn.connection.secret);
      items.push({
        ...base,
        issues: [],
        preview: null,
        error: { code: mapped.code, message: String(mapped.failure.body.message ?? '') },
      });
    }
  }
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'price.dry_run',
    target: { type: 'app', id: input.app.id },
    detail: {
      appId: input.app.id,
      items: items.map((i) => ({
        productId: i.productId,
        issues: i.issues.map((x) => x.code),
        mode: i.preview?.mode ?? null,
        error: i.error?.code ?? null,
      })),
    },
    at: ctx.now(),
  });
  return { ok: true, items };
}
