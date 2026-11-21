import { getRevenueCatApp, readRevenueCatConfiguration } from '@kiln/connectors';
import { type ActorType, supports } from '@kiln/core';
import type { Database } from '@kiln/db';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import { REVENUECAT_SYNC_PURPOSE, revenueCatClientFor, revenueCatFailure } from './client.ts';
import type { RevenueCatDeps } from './index.ts';
import { getRevenueCatLink, notSupportedFailure } from './link.ts';
import { recordRevenueCatFailure, replaceRevenueCatSnapshot } from './snapshot.ts';

/**
 * Reading the RevenueCat configuration of a linked app and keeping a copy (docs/adr/0039-revenuecat.md). READ ONLY: a sync asks
 * RevenueCat for lists and changes nothing there. It is the second step of "Sync products" (modules/monetization), after the store, and
 * it also runs alone (`POST .../revenuecat/sync`). A failed sync keeps the last good copy and says what went wrong. It never touches
 * the store snapshot, and the store step never decides whether it runs.
 */

type Actor = { type: ActorType; id: string };

export const DEFAULT_REVENUECAT_SYNC_TIMEOUT_MS = 120_000;

export type RevenueCatSyncContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps: RevenueCatDeps | undefined;
};

export type RevenueCatSyncResult = {
  products: number;
  entitlements: number;
  offerings: number;
  /** Products of the RevenueCat project that belong to its other apps, left out. */
  otherAppProducts: number;
  /** False when a cap ended the read early: the copy may be missing items and "not found" warnings are not raised from it. */
  complete: boolean;
  warnings: string[];
  syncedAt: number;
};

/** What the products sync reports for its RevenueCat step: the result, or a code and a fixed sentence. */
export type RevenueCatStep =
  | ({ ok: true } & RevenueCatSyncResult)
  | { ok: false; code: string; message: string; retryAfterSeconds?: number };

export const notLinkedFailure = (): Failure =>
  failure(422, 'revenuecat_not_linked', 'This app is not linked to a RevenueCat project. Link it in the app settings first.');

export async function syncRevenueCat(
  ctx: RevenueCatSyncContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<Outcome<{ result: RevenueCatSyncResult }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'revenueCat')) return notSupportedFailure();
  const link = await getRevenueCatLink(ctx.db, input.workspaceId, app.id);
  if (!link) return notLinkedFailure();
  const at = ctx.now();
  /** A failure to reach RevenueCat's data: kept on the app so the screen says what went wrong, and answered. A rate limit is "wait", not a failed sync. */
  const failed = async (f: Failure): Promise<Failure> => {
    await recordRevenueCatFailure(ctx.db, {
      workspaceId: input.workspaceId,
      appId: app.id,
      message: String(f.body.message ?? f.body.error),
      at,
      streak: f.status !== 429,
    });
    return f;
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.deps?.syncTimeoutMs ?? DEFAULT_REVENUECAT_SYNC_TIMEOUT_MS);
  try {
    const opened = await revenueCatClientFor(ctx.db, ctx.masterKey, input.workspaceId, link.credentialId, ctx.deps, {
      actor: input.actor,
      purpose: REVENUECAT_SYNC_PURPOSE,
      now: at,
      signal: controller.signal,
    });
    if (!opened.ok) return failed(opened);
    let config: Awaited<ReturnType<typeof readRevenueCatConfiguration>>;
    try {
      // The linked app may have been deleted at RevenueCat: say so instead of showing an empty list.
      if (!(await getRevenueCatApp(opened.client, link.projectId, link.revenueCatAppId))) {
        return failed(
          failure(422, 'revenuecat_app_missing', 'RevenueCat no longer has the linked app. Link the app again in the app settings.'),
        );
      }
      config = await readRevenueCatConfiguration(opened.client, { projectId: link.projectId, appId: link.revenueCatAppId });
    } catch (error) {
      if (timedOut) return failed(failure(504, 'timeout', 'RevenueCat did not answer in time. Try again in a minute.'));
      return failed(revenueCatFailure(error, opened.secret));
    }
    await ctx.db.transaction(async (tx) => {
      await replaceRevenueCatSnapshot(tx, {
        workspaceId: input.workspaceId,
        appId: app.id,
        projectId: link.projectId,
        credentialId: link.credentialId,
        config,
        at,
      });
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'revenuecat.synced',
        target: { type: 'app', id: app.id },
        // Counts only: never a name, an id of RevenueCat or a response.
        detail: {
          appId: app.id,
          products: config.products.length,
          entitlements: config.entitlements.length,
          offerings: config.offerings.length,
          complete: config.complete,
          warnings: config.warnings.length,
        },
        at,
      });
    });
    return {
      ok: true,
      result: {
        products: config.products.length,
        entitlements: config.entitlements.length,
        offerings: config.offerings.length,
        otherAppProducts: config.otherAppProducts,
        complete: config.complete,
        warnings: config.warnings,
        syncedAt: at,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The RevenueCat step of "Sync products": null when the app has no link (nothing to do, nothing reported); else the result of
 * `syncRevenueCat` as a step. It never throws, so it can never fail the store sync that runs before it.
 */
export async function revenueCatStep(
  ctx: RevenueCatSyncContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<RevenueCatStep | null> {
  try {
    if (!(await getRevenueCatLink(ctx.db, input.workspaceId, input.appId))) return null;
    const done = await syncRevenueCat(ctx, input);
    if (done.ok) return { ok: true, ...done.result };
    const wait = done.body.retryAfterSeconds;
    return {
      ok: false,
      code: done.body.error,
      message: String(done.body.message ?? done.body.error),
      ...(typeof wait === 'number' ? { retryAfterSeconds: wait } : {}),
    };
  } catch {
    // The error text is dropped on purpose: it could echo what was sent.
    return { ok: false, code: 'revenuecat_failed', message: 'The RevenueCat read could not be completed. Try again in a moment.' };
  }
}
