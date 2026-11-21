import { evaluatePipeline, HOUR_MS, MAX_STALLED_AFTER_HOURS } from '@kiln/core';
import type { Database, Row } from '@kiln/db';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
import { getSettings } from '../../services/workspace-settings.ts';
import { unansweredByApp } from '../reviews/summary.ts';
import { loadPipelineFacts } from './release-pipeline.ts';

/**
 * Two signals about work that waits for a person, sent as events (`release.stalled`, `review.unanswered`) so they flow through
 * the event log, the SSE stream and signed webhooks, like the plan reminders. There is no email and no push notification.
 *
 *  - `release.stalled`: the release of an app has been standing still for more than `release.stalledAfterHours` (0: off). One
 *    reminder per stall EPISODE (a stall is identified by its step and the thing that is stuck, `step:anchor`), and a repeat of
 *    the same episode only after `release.stalledRepeatHours` (0: never). The episode is remembered in `release_stall_reminders`
 *    (one row per app and platform) and forgotten when the stall clears, so the next one is a new episode.
 *  - `review.unanswered`: a digest, at most once per `reviews.unansweredReminderHours` (0, the default: off) per workspace, when
 *    at least one review rated at or below `reviews.unansweredMaxRating` has waited that long without an answer. Counts per app
 *    and the time of the oldest: never a review text, a title or a name.
 *
 * Safe to run often and from several instances sharing one database: the row is changed by a compare-and-swap on the time it
 * was last sent, in the same transaction as the event, so only one run sends. Nothing here calls a store or GitHub. A failing
 * reminder is reported and skipped; a query failure propagates to the caller (the scheduler reports it).
 * Payloads hold ids, versions, numbers and times only; the audit entry too.
 */

export const RELEASE_WATCH_ACTOR = { type: 'system' as const, id: 'release.watch' };
export const DEFAULT_MAX_WATCH_EVENTS_PER_RUN = 100;
/** The most apps named in one `review.unanswered` event. */
export const MAX_DIGEST_APPS = 50;

export type ReleaseWatchOptions = {
  maxPerRun?: number;
  onError?: (message: string, error: unknown) => void;
};

export type ReleaseWatchSummary = {
  /** `release.stalled` events: first reminders of an episode, and repeats. */
  stalled: number;
  stalledRepeats: number;
  /** Rows forgotten because their stall cleared. */
  cleared: number;
  /** `review.unanswered` events. */
  unansweredDigests: number;
  failed: number;
  capped: boolean;
};

/** Everything a `release.stalled` event says; ids, versions and times only. */
type StallReminder = {
  workspaceId: string;
  appId: string;
  appName: string;
  platform: string;
  step: string;
  key: string;
  anchor: string;
  since: number;
  hours: number;
  evidence: { kind: string; id: string; at: number | null }[];
  repeat: boolean;
};

const idOf = (evidence: StallReminder['evidence'], kind: string) =>
  evidence.find((e) => e.kind === kind)?.id ?? null;

/** Sends one stall reminder. Returns false when another run already did (the compare-and-swap lost). */
async function sendStall(
  db: Database,
  r: StallReminder,
  existing: Row | undefined,
  at: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    let sentCount = 1;
    if (existing === undefined) {
      const added = await tx.execute(
        `INSERT INTO release_stall_reminders (app_id, platform, workspace_id, episode_key, step, first_sent_at, last_sent_at, sent_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
        [r.appId, r.platform, r.workspaceId, r.key, r.step, at, at],
      );
      if (added === 0) return false;
    } else {
      const sameEpisode = String(existing.episode_key) === r.key;
      sentCount = sameEpisode ? Number(existing.sent_count) + 1 : 1;
      const changed = await tx.execute(
        `UPDATE release_stall_reminders
            SET episode_key = ?, step = ?, first_sent_at = ?, last_sent_at = ?, sent_count = ?
          WHERE app_id = ? AND platform = ? AND workspace_id = ? AND episode_key = ? AND last_sent_at = ?`,
        [
          r.key,
          r.step,
          sameEpisode ? Number(existing.first_sent_at) : at,
          at,
          sentCount,
          r.appId,
          r.platform,
          r.workspaceId,
          String(existing.episode_key),
          Number(existing.last_sent_at),
        ],
      );
      if (changed === 0) return false;
    }
    await emitEvent(tx, {
      workspaceId: r.workspaceId,
      type: 'release.stalled',
      subject: { appId: r.appId },
      payload: {
        appId: r.appId,
        appName: r.appName,
        platform: r.platform,
        step: r.step,
        episode: r.key,
        since: r.since,
        hours: r.hours,
        runId: idOf(r.evidence, 'run'),
        buildNumber: idOf(r.evidence, 'build'),
        version: idOf(r.evidence, 'version'),
        evidence: r.evidence,
        repeat: r.repeat,
        sentCount,
        actor: RELEASE_WATCH_ACTOR,
      },
      at,
    });
    await recordAudit(tx, {
      workspaceId: r.workspaceId,
      actor: RELEASE_WATCH_ACTOR,
      action: 'release.reminder',
      target: { type: 'app', id: r.appId },
      detail: {
        platform: r.platform,
        step: r.step,
        episode: r.key,
        repeat: r.repeat,
        sentCount,
        event: 'release.stalled',
      },
      at,
    });
    return true;
  });
}

async function stallRound(
  db: Database,
  workspaceId: string,
  at: number,
  summary: ReleaseWatchSummary,
  room: () => number,
  report: NonNullable<ReleaseWatchOptions['onError']>,
) {
  const loaded = await loadPipelineFacts(db, { workspaceId, now: at });
  const { stalledAfterHours, stalledRepeatHours } = loaded.settings;
  const rows = await db.query(
    'SELECT app_id, platform, episode_key, step, first_sent_at, last_sent_at, sent_count FROM release_stall_reminders WHERE workspace_id = ?',
    [workspaceId],
  );
  const remembered = new Map(
    rows.map((r) => [`${String(r.app_id)}\u0000${String(r.platform)}`, r]),
  );
  const seen = new Set<string>();
  for (const facts of loaded.facts) {
    const mapKey = `${facts.appId}\u0000${facts.platform}`;
    seen.add(mapKey);
    const existing = remembered.get(mapKey);
    const stall = stalledAfterHours > 0 ? evaluatePipeline(facts).stalled : null;
    if (stall === null) {
      // The stall cleared (or the signal was turned off): forget the episode, so the next stall is a new one.
      if (existing !== undefined) {
        summary.cleared += await db.execute(
          'DELETE FROM release_stall_reminders WHERE app_id = ? AND platform = ? AND workspace_id = ? AND episode_key = ?',
          [facts.appId, facts.platform, workspaceId, String(existing.episode_key)],
        );
      }
      continue;
    }
    // A stall older than the stale limit is shown but never reminded.
    if (stall.stale) continue;
    const sameEpisode = existing !== undefined && String(existing.episode_key) === stall.key;
    if (sameEpisode) {
      if (stalledRepeatHours <= 0) continue;
      if (at - Number(existing?.last_sent_at) < stalledRepeatHours * HOUR_MS) continue;
    }
    if (room() <= 0) {
      summary.capped = true;
      continue;
    }
    const app = loaded.apps.get(facts.appId);
    try {
      const sent = await sendStall(
        db,
        {
          workspaceId,
          appId: facts.appId,
          appName: app?.name ?? '',
          platform: facts.platform,
          step: stall.step,
          key: stall.key,
          anchor: stall.anchor,
          since: stall.since,
          hours: stall.hours,
          evidence: stall.evidence.map((e) => ({ kind: e.kind, id: e.id, at: e.at })),
          repeat: sameEpisode,
        },
        existing,
        at,
      );
      if (sent) {
        if (sameEpisode) summary.stalledRepeats++;
        else summary.stalled++;
      }
    } catch (error) {
      summary.failed++;
      report(`release stall reminder for app ${facts.appId} failed`, error);
    }
  }
  // Rows of apps that are gone are forgotten too.
  for (const [mapKey, row] of remembered) {
    if (seen.has(mapKey)) continue;
    summary.cleared += await db.execute(
      'DELETE FROM release_stall_reminders WHERE app_id = ? AND platform = ? AND workspace_id = ?',
      [String(row.app_id), String(row.platform), workspaceId],
    );
  }
}

/** The digest of one workspace, when it is due. Returns true when an event was sent. */
async function unansweredDigest(
  db: Database,
  workspaceId: string,
  at: number,
  hours: number,
  maxRating: number,
): Promise<boolean> {
  const waiting = await unansweredByApp(db, workspaceId, {
    maxRating,
    olderThan: at - hours * HOUR_MS,
  });
  if (waiting.size === 0) return false;
  const [last] = await db.query(
    'SELECT last_sent_at FROM review_unanswered_reminders WHERE workspace_id = ?',
    [workspaceId],
  );
  if (last && at - Number(last.last_sent_at) < hours * HOUR_MS) return false;
  const names = new Map(
    (
      await db.query('SELECT id, name, platform FROM apps WHERE workspace_id = ?', [workspaceId])
    ).map((a) => [String(a.id), a]),
  );
  const perApp = [...waiting]
    .filter(([appId]) => names.has(appId))
    .map(([appId, v]) => ({
      appId,
      appName: String(names.get(appId)?.name),
      platform: String(names.get(appId)?.platform),
      count: v.count,
      oldestAt: v.oldestAt,
    }))
    .sort((a, b) => (a.oldestAt ?? 0) - (b.oldestAt ?? 0) || a.appId.localeCompare(b.appId));
  if (perApp.length === 0) return false;
  const count = perApp.reduce((n, a) => n + a.count, 0);
  const oldestAt = perApp.reduce<number | null>(
    (m, a) => (a.oldestAt === null ? m : m === null ? a.oldestAt : Math.min(m, a.oldestAt)),
    null,
  );
  return db.transaction(async (tx) => {
    if (last === undefined) {
      const added = await tx.execute(
        'INSERT INTO review_unanswered_reminders (workspace_id, last_sent_at, last_count, last_oldest_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [workspaceId, at, count, oldestAt],
      );
      if (added === 0) return false;
    } else {
      const changed = await tx.execute(
        'UPDATE review_unanswered_reminders SET last_sent_at = ?, last_count = ?, last_oldest_at = ? WHERE workspace_id = ? AND last_sent_at = ?',
        [at, count, oldestAt, workspaceId, Number(last.last_sent_at)],
      );
      if (changed === 0) return false;
    }
    await emitEvent(tx, {
      workspaceId,
      type: 'review.unanswered',
      subject: {},
      payload: {
        count,
        apps: perApp.slice(0, MAX_DIGEST_APPS),
        appsTotal: perApp.length,
        oldestAt,
        waitingHours: hours,
        maxRating,
        actor: RELEASE_WATCH_ACTOR,
      },
      at,
    });
    await recordAudit(tx, {
      workspaceId,
      actor: RELEASE_WATCH_ACTOR,
      action: 'review.reminder',
      target: { type: 'workspace', id: workspaceId },
      detail: { count, apps: perApp.length, hours, maxRating, event: 'review.unanswered' },
      at,
    });
    return true;
  });
}

/** One pass over every workspace. `at` is the clock (epoch milliseconds). */
export async function sendReleaseWatch(
  db: Database,
  at: number,
  options: ReleaseWatchOptions = {},
): Promise<ReleaseWatchSummary> {
  const report = options.onError ?? ((message, error) => console.error(message, error));
  const max = Math.max(1, Math.trunc(options.maxPerRun ?? DEFAULT_MAX_WATCH_EVENTS_PER_RUN));
  const summary: ReleaseWatchSummary = {
    stalled: 0,
    stalledRepeats: 0,
    cleared: 0,
    unansweredDigests: 0,
    failed: 0,
    capped: false,
  };
  const sent = () => summary.stalled + summary.stalledRepeats + summary.unansweredDigests;
  const workspaces = await db.query('SELECT id FROM workspaces ORDER BY id');
  for (const w of workspaces) {
    const workspaceId = String(w.id);
    try {
      await stallRound(db, workspaceId, at, summary, () => max - sent(), report);
    } catch (error) {
      summary.failed++;
      report(`release stall check of workspace ${workspaceId} failed`, error);
    }
    try {
      const values = (await getSettings(db, workspaceId)).values;
      const hours = Math.min(
        Number(values['reviews.unansweredReminderHours']),
        MAX_STALLED_AFTER_HOURS,
      );
      if (hours > 0) {
        if (sent() >= max) summary.capped = true;
        else if (
          await unansweredDigest(
            db,
            workspaceId,
            at,
            hours,
            Number(values['reviews.unansweredMaxRating']),
          )
        )
          summary.unansweredDigests++;
      }
    } catch (error) {
      summary.failed++;
      report(`unanswered reviews digest of workspace ${workspaceId} failed`, error);
    }
  }
  return summary;
}
