import {
  type AnalyticsSource,
  analyticsSources,
  can,
  isAnalyticsSource,
  needsStoreAppId,
  parsePlatform,
  type Role,
  supports,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { enqueue } from '../jobs.ts';
import { ADS_SYNC_QUEUE } from '../modules/ads/sync.ts';
import { ANALYTICS_SYNC_QUEUE } from '../modules/analytics/sync.ts';
import { EAS_STATUS_QUEUE } from '../modules/eas/status-sync.ts';
import { REVIEW_SYNC_QUEUE } from '../modules/reviews/sync.ts';
import { APP_SYNC_QUEUE } from './apps.ts';

/**
 * "Sync" of an app as ONE action (docs/adr/0050-sync-pipeline.md, docs/ux-ia.md): the jobs the app has, queued in the order the worker ranks
 * them, critical first. Nothing here reads a store: it only writes jobs, and the existing handlers do the reading, with their per host limits,
 * credential lanes and backoff. A kind that does not apply to the app, that the actor may not run, or that is already queued or running is
 * left out and says why, so the screen can show it instead of guessing.
 *   app        the store listing and the release state of the record                    (app.sync, needs apps.sync)
 *   reviews    customer reviews                                                          (review.sync, needs reviews.sync)
 *   eas        EAS builds and submissions of the linked Expo project                     (eas.status, needs apps.sync)
 *   analytics  the analytics sources (Apple reports or Google Play bucket)               (analytics.sync, needs analytics.manage)
 *   ads        the Apple Ads reports of the linked ad account (read only, last, non critical)  (ads.sync, needs apps.sync)
 * Products, RevenueCat and TestFlight feedback have no queue yet; the web client runs their own routes after this plan.
 */
export type SyncKind = 'app' | 'reviews' | 'eas' | 'analytics' | 'ads';

export const SYNC_KIND_ORDER: readonly SyncKind[] = ['app', 'reviews', 'eas', 'analytics', 'ads'];

export type SyncAllQuery = {
  without: SyncKind[];
  kinds: SyncKind[] | undefined;
  sources: AnalyticsSource[] | undefined;
};

/**
 * The query of `POST /apps/:id/sync-all`: `without=app`, `kinds=reviews,analytics` (only these; default all) and `sources=play_vitals,...`
 * (only these analytics sources; needs the analytics kind). A page-scoped Sync asks for the kinds it needs. Pure; a bad value says which.
 */
export function parseSyncAllQuery(raw: {
  without?: string | undefined;
  kinds?: string | undefined;
  sources?: string | undefined;
}): { ok: true; query: SyncAllQuery } | { ok: false; message: string } {
  const list = (v: string | undefined): string[] | undefined =>
    v === undefined || v === ''
      ? undefined
      : [
          ...new Set(
            v
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== ''),
          ),
        ];
  if (raw.without !== undefined && raw.without !== 'app')
    return { ok: false, message: '`without` can only be `app`.' };
  const kinds = list(raw.kinds);
  const bad = kinds?.find((k) => !(SYNC_KIND_ORDER as readonly string[]).includes(k));
  if (bad !== undefined)
    return { ok: false, message: `Unknown kind \`${bad}\`. Use ${SYNC_KIND_ORDER.join(', ')}.` };
  const sources = list(raw.sources);
  const badSource = sources?.find((s) => !isAnalyticsSource(s));
  if (badSource !== undefined)
    return {
      ok: false,
      message: `Unknown analytics source \`${badSource}\`. Use ${analyticsSources.join(', ')}.`,
    };
  if (sources !== undefined && kinds !== undefined && !kinds.includes('analytics'))
    return { ok: false, message: '`sources` needs the `analytics` kind.' };
  return {
    ok: true,
    query: {
      without: raw.without === 'app' ? ['app'] : [],
      kinds: kinds as SyncKind[] | undefined,
      sources: sources as AnalyticsSource[] | undefined,
    },
  };
}

export type SyncSkipReason = 'forbidden' | 'not_linked' | 'off' | 'not_ready' | 'already_queued';

export type SyncPlanEntry =
  | { kind: SyncKind; state: 'queued'; jobId: string }
  | { kind: SyncKind; state: 'skipped'; reason: SyncSkipReason };

/** The facts the plan depends on, read once. Pure input of `planKinds`, so the decision can be tested without a database. */
export type SyncFacts = {
  platform: string | undefined;
  hasStoreAppId: boolean;
  /** A macOS record that shares its App Store Connect app with an iOS record: the reviews are the iOS record's. */
  reviewsOwnedByIos: boolean;
  easLinked: boolean;
  analyticsEnabled: boolean;
  analyticsAppleReady: boolean;
  /** The app has an Apple Ads link whose credential is still an Apple Ads credential. */
  adsLinked: boolean;
  queued: ReadonlySet<SyncKind>;
};

export type SyncDecision = { kind: SyncKind } & (
  | { run: true }
  | { run: false; reason: SyncSkipReason }
);

/** Which kinds to queue, in order. Pure. */
export function planKinds(role: Role, facts: SyncFacts): SyncDecision[] {
  const skip = (kind: SyncKind, reason: SyncSkipReason): SyncDecision => ({
    kind,
    run: false,
    reason,
  });
  const run = (kind: SyncKind): SyncDecision => ({ kind, run: true });
  const decide = (kind: SyncKind): SyncDecision => {
    if (facts.queued.has(kind)) return skip(kind, 'already_queued');
    switch (kind) {
      case 'app':
        return can(role, 'apps.sync') ? run(kind) : skip(kind, 'forbidden');
      case 'reviews': {
        if (!can(role, 'reviews.sync')) return skip(kind, 'forbidden');
        const platform = facts.platform === undefined ? undefined : parsePlatform(facts.platform);
        if (platform === undefined) return skip(kind, 'not_ready');
        if ((needsStoreAppId(platform) && !facts.hasStoreAppId) || facts.reviewsOwnedByIos)
          return skip(kind, 'not_ready');
        return run(kind);
      }
      case 'eas':
        if (!can(role, 'apps.sync')) return skip(kind, 'forbidden');
        return facts.easLinked ? run(kind) : skip(kind, 'not_linked');
      case 'analytics': {
        if (!can(role, 'analytics.manage')) return skip(kind, 'forbidden');
        if (!facts.analyticsEnabled) return skip(kind, 'off');
        const platform = facts.platform === undefined ? undefined : parsePlatform(facts.platform);
        if (platform === undefined) return skip(kind, 'not_ready');
        return supports(platform, 'appleAnalyticsReports') && !facts.analyticsAppleReady
          ? skip(kind, 'not_ready')
          : run(kind);
      }
      case 'ads':
        if (!can(role, 'apps.sync')) return skip(kind, 'forbidden');
        return facts.adsLinked ? run(kind) : skip(kind, 'not_linked');
    }
  };
  return SYNC_KIND_ORDER.map(decide);
}

const QUEUES: Record<SyncKind, string> = {
  app: APP_SYNC_QUEUE,
  reviews: REVIEW_SYNC_QUEUE,
  eas: EAS_STATUS_QUEUE,
  analytics: ANALYTICS_SYNC_QUEUE,
  ads: ADS_SYNC_QUEUE,
};

const needle = (appId: string): string => `%"appId":"${appId.replace(/[%_"\\]/g, '')}"%`;

async function readFacts(
  db: Database,
  workspaceId: string,
  appId: string,
): Promise<SyncFacts | null> {
  const [app] = await db.query(
    'SELECT platform, store_app_id FROM apps WHERE id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  if (!app) return null;
  const storeAppId =
    app.store_app_id === null || app.store_app_id === undefined ? '' : String(app.store_app_id);
  const [ios] =
    String(app.platform) === 'macos' && storeAppId !== ''
      ? await db.query(
          "SELECT id FROM apps WHERE workspace_id = ? AND platform = 'ios' AND store_app_id = ?",
          [workspaceId, storeAppId],
        )
      : [];
  const [eas] = await db.query(
    "SELECT 1 AS ok FROM app_expo_links l JOIN credentials c ON c.id = l.credential_id AND c.workspace_id = l.workspace_id AND c.kind = 'expo' WHERE l.app_id = ? AND l.workspace_id = ?",
    [appId, workspaceId],
  );
  const [ads] = await db.query(
    "SELECT 1 AS ok FROM app_ads_links l JOIN credentials c ON c.id = l.credential_id AND c.workspace_id = l.workspace_id AND c.kind = 'apple_ads' WHERE l.app_id = ? AND l.workspace_id = ?",
    [appId, workspaceId],
  );
  const settings = await db.query(
    "SELECT key, value_json FROM workspace_settings WHERE workspace_id = ? AND key IN ('analytics.enabled', 'analytics.appleVendorNumber')",
    [workspaceId],
  );
  const setting = (key: string) => settings.find((s) => String(s.key) === key);
  const vendor = /^"[0-9]{5,12}"$/.test(
    String(setting('analytics.appleVendorNumber')?.value_json ?? ''),
  );
  const [request] = await db.query(
    "SELECT 1 AS ok FROM analytics_report_requests WHERE app_id = ? AND status = 'active'",
    [appId],
  );
  const queued = new Set<SyncKind>();
  for (const kind of SYNC_KIND_ORDER) {
    const [job] = await db.query(
      "SELECT 1 AS ok FROM jobs WHERE queue = ? AND status IN ('queued', 'running') AND payload LIKE ?",
      [QUEUES[kind], needle(appId)],
    );
    if (job) queued.add(kind);
  }
  return {
    platform: String(app.platform),
    hasStoreAppId: storeAppId !== '',
    reviewsOwnedByIos: ios !== undefined,
    easLinked: eas !== undefined,
    analyticsEnabled: String(setting('analytics.enabled')?.value_json ?? '') === 'true',
    analyticsAppleReady: request !== undefined || vendor,
    adsLinked: ads !== undefined,
    queued,
  };
}

/** Queues the jobs of one app (critical first) and says what happened to each kind; null for an unknown app. */
export async function enqueueAppSyncAll(
  ctx: { db: Database; now: () => number },
  input: {
    workspaceId: string;
    appId: string;
    role: Role;
    requestedBy: string;
    /** Kinds the caller has just run itself (the web client runs `app` directly to show the result at once). */
    without?: readonly SyncKind[];
    /** Only these kinds (a page-scoped Sync); the others are not in the plan at all. Default: every kind. */
    kinds?: readonly SyncKind[] | undefined;
    /** Only these analytics sources (a retry of the failed ones); the analytics kind reads all sources when absent. */
    sources?: readonly AnalyticsSource[] | undefined;
  },
): Promise<SyncPlanEntry[] | null> {
  const facts = await readFacts(ctx.db, input.workspaceId, input.appId);
  if (!facts) return null;
  const out: SyncPlanEntry[] = [];
  const now = ctx.now();
  for (const d of planKinds(input.role, facts)) {
    if (input.without?.includes(d.kind) || (input.kinds && !input.kinds.includes(d.kind))) continue;
    if (!d.run) {
      out.push({ kind: d.kind, state: 'skipped', reason: d.reason });
      continue;
    }
    const jobId = await enqueue(
      ctx.db,
      QUEUES[d.kind],
      {
        workspaceId: input.workspaceId,
        appId: input.appId,
        requestedBy: input.requestedBy,
        ...(d.kind === 'analytics' && input.sources && input.sources.length > 0
          ? { sources: [...input.sources] }
          : {}),
      },
      { now },
    );
    out.push({ kind: d.kind, state: 'queued', jobId });
  }
  return out;
}
