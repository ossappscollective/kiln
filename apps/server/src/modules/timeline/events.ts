import { randomUUID } from 'node:crypto';
import {
  dateToDay,
  isIsoDate,
  isManualEventKind,
  TIMELINE_MAX_EVENTS_PER_APP as MAX_EVENTS_PER_APP,
  type ManualEventKind,
  manualEventKinds,
  TIMELINE_NOTE_MAX_CHARS as NOTE_MAX,
  SECTION_LOCALE,
  type TimelineEvent,
  type TimelineEventKind,
} from '@kiln/core';
import type { Sql } from '@kiln/db';
import { z } from 'zod';
import { listAppReleases, type ManagedApp } from '../../services/apps.ts';

export { MAX_EVENTS_PER_APP, NOTE_MAX };

/**
 * Where the events of the timeline come from (docs/adr/0053-timeline-and-reports.md). Events Kiln knows by itself are READ from where they
 * live (releases, rollout steps, the audit of listing pushes, experiments, the stored listing history); a person's own events are the table
 * `timeline_events` (migration 57). Nothing here writes to a store. The labels of Kiln's events are codes with parameters: the screens
 * translate them.
 */

export const TITLE_MAX = 120;
const KIND_LIMIT = 400;

const isApple = (app: Pick<ManagedApp, 'platform'>) =>
  app.platform === 'ios' || app.platform === 'macos';

const dayValid = z.string().refine((v) => isIsoDate(v), 'A date as YYYY-MM-DD.');
export const createEventBody = z
  .object({
    kind: z.enum(manualEventKinds),
    day: dayValid,
    title: z.string().trim().min(1).max(TITLE_MAX),
    note: z.string().max(NOTE_MAX).optional(),
  })
  .strict();
export const updateEventBody = z
  .object({
    kind: z.enum(manualEventKinds).optional(),
    day: dayValid.optional(),
    title: z.string().trim().min(1).max(TITLE_MAX).optional(),
    note: z.string().max(NOTE_MAX).optional(),
  })
  .strict();

const base = (
  id: string,
  day: string,
  kind: TimelineEventKind,
  label: { code: string; params: Record<string, string | number> },
  extra: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id,
  day,
  kind,
  origin: 'kiln',
  label,
  title: null,
  note: null,
  version: null,
  liveDay: null,
  waitsForRelease: false,
  ...extra,
});

const clip = (v: unknown, n: number): string => String(v ?? '').slice(0, n);

/** Every event Kiln derives for an app, unsorted. Small: a few hundred rows at most per source. */
export async function kilnEvents(
  sql: Sql,
  workspaceId: string,
  app: Pick<ManagedApp, 'id' | 'platform'>,
): Promise<TimelineEvent[]> {
  const out: TimelineEvent[] = [];
  const params = [app.id, workspaceId];

  // Versions that came out (or began a staged rollout): the day the tool first saw them in that state.
  // Through `listAppReleases`: a Google Play release sent from here in the last days is "in review" (the one overlay), not out yet.
  const releases = (await listAppReleases(sql, workspaceId, app.id))
    .filter((r) => r.status === 'live' || r.status === 'rolling_out')
    .sort((a, b) => b.syncedAt - a.syncedAt)
    .slice(0, KIND_LIMIT);
  for (const r of releases) {
    const since = r.statusSince ?? r.syncedAt;
    const version = clip(r.version, 40);
    out.push(
      base(
        `k:release:${r.id}`,
        dateToDay(since),
        'release',
        {
          code: r.status === 'rolling_out' ? 'releaseRollingOut' : 'release',
          params: { version, ...(r.track ? { track: clip(r.track, 40) } : {}) },
        },
        { version },
      ),
    );
  }

  // Phased rollout steps a person (or the store) marked done.
  const steps = await sql.query(
    `SELECT s.id, s.percent, s.done_at, p.version FROM plan_rollout_steps s JOIN release_plans p ON p.id = s.plan_id
      WHERE p.app_id = ? AND s.workspace_id = ? AND s.status = 'done' AND s.done_at IS NOT NULL ORDER BY s.done_at DESC LIMIT ${KIND_LIMIT}`,
    params,
  );
  for (const r of steps) {
    const version = clip(r.version, 40);
    out.push(
      base(
        `k:step:${String(r.id)}`,
        dateToDay(Number(r.done_at)),
        'rollout',
        { code: 'rolloutStep', params: { version, percent: Number(r.percent) } },
        { version },
      ),
    );
  }

  // Pushes to a store draft (texts and graphics): the audit row has counts only.
  const pushes = await sql.query(
    `SELECT id, detail, created_at FROM audit_events
      WHERE workspace_id = ? AND target_type = 'app' AND target_id = ? AND action = 'listing.draft_pushed' ORDER BY created_at DESC LIMIT ${KIND_LIMIT}`,
    [workspaceId, app.id],
  );
  for (const r of pushes) {
    let detail: Record<string, unknown> = {};
    try {
      detail = r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : {};
    } catch {
      detail = {};
    }
    const day = dateToDay(Number(r.created_at));
    const sets = Number(detail.assetSets ?? 0);
    const texts = Number(detail.texts ?? 0);
    if (sets > 0) {
      out.push(
        base(
          `k:push:${String(r.id)}:graphics`,
          day,
          'graphics',
          { code: 'graphics', params: { count: sets } },
          { waitsForRelease: isApple(app) },
        ),
      );
    }
    if (texts > 0) {
      out.push(
        base(
          `k:push:${String(r.id)}:text`,
          day,
          'listing_text',
          { code: 'listingText', params: { count: texts } },
          { waitsForRelease: isApple(app) },
        ),
      );
    }
  }

  // Experiments read from the store, and the manual tracker.
  const experiments = await sql.query(
    `SELECT item_id, name, starts_at, ends_at FROM store_experiments WHERE app_id = ? AND workspace_id = ? AND kind = 'experiment'`,
    params,
  );
  for (const r of experiments) {
    const name = clip(r.name, 80);
    if (r.starts_at !== null && r.starts_at !== undefined)
      out.push(
        base(
          `k:exp:${String(r.item_id)}:start`,
          dateToDay(Number(r.starts_at)),
          'experiment_started',
          { code: 'experimentStarted', params: { name } },
        ),
      );
    if (r.ends_at !== null && r.ends_at !== undefined)
      out.push(
        base(`k:exp:${String(r.item_id)}:end`, dateToDay(Number(r.ends_at)), 'experiment_ended', {
          code: 'experimentEnded',
          params: { name },
        }),
      );
  }
  const notes = await sql.query(
    `SELECT id, name, started_on, ended_on FROM store_experiment_notes WHERE app_id = ? AND workspace_id = ? AND kind = 'experiment'`,
    params,
  );
  for (const r of notes) {
    const name = clip(r.name, 80);
    if (r.started_on)
      out.push(
        base(`k:note:${String(r.id)}:start`, String(r.started_on), 'experiment_started', {
          code: 'experimentStarted',
          params: { name },
        }),
      );
    if (r.ended_on)
      out.push(
        base(`k:note:${String(r.id)}:end`, String(r.ended_on), 'experiment_ended', {
          code: 'experimentEnded',
          params: { name },
        }),
      );
  }

  // The live listing text changed in the store after it was first read: a change Kiln did not make (or made and read back).
  const drift = await sql.query(
    `SELECT s.observed_at FROM listing_snapshots s
      WHERE s.workspace_id = ? AND s.app_id = ? AND s.source = 'store' AND s.channel = 'live' AND s.locale <> ?
        AND EXISTS (SELECT 1 FROM listing_snapshots p WHERE p.workspace_id = s.workspace_id AND p.app_id = s.app_id AND p.locale = s.locale
                      AND p.field = s.field AND p.channel = s.channel AND p.source = s.source AND p.platform = s.platform AND p.observed_at < s.observed_at)
      ORDER BY s.observed_at DESC LIMIT 2000`,
    [workspaceId, app.id, SECTION_LOCALE],
  );
  const perDay = new Map<string, number>();
  for (const r of drift) {
    const day = dateToDay(Number(r.observed_at));
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  for (const [day, count] of perDay)
    out.push(
      base(`k:drift:${day}`, day, 'listing_drift', { code: 'listingDrift', params: { count } }),
    );

  // A followed App Store competitor changed its public listing (docs/adr/0056-competitor-listing-watch.md): one event per competitor and day.
  // Rating drift alone is not an event. The kinds are codes; the screens translate them.
  const rival = await sql.query(
    `SELECT c.competitor_id, c.detected_at, c.kinds, k.name FROM aso_competitor_changes c JOIN aso_competitors k ON k.id = c.competitor_id
      WHERE c.workspace_id = ? AND c.app_id = ? ORDER BY c.detected_at DESC LIMIT ${KIND_LIMIT}`,
    [workspaceId, app.id],
  );
  const rivalDays = new Map<string, { name: string; day: string; kinds: Set<string> }>();
  for (const r of rival) {
    const day = dateToDay(Number(r.detected_at));
    const key = `${String(r.competitor_id)}:${day}`;
    const entry = rivalDays.get(key) ?? { name: clip(r.name, 80), day, kinds: new Set<string>() };
    for (const kind of String(r.kinds).split(','))
      if (kind !== '' && kind !== 'rating' && kind !== 'ratingCount') entry.kinds.add(kind);
    rivalDays.set(key, entry);
  }
  for (const [key, e] of rivalDays) {
    if (e.kinds.size === 0) continue;
    out.push(
      base(`k:rival:${key}`, e.day, 'competitor_change', {
        code: 'competitorChange',
        params: { name: e.name, kinds: Array.from(e.kinds).join(',') },
      }),
    );
  }
  return out;
}

type Row = Record<string, unknown>;
const manualOf = (r: Row): TimelineEvent => ({
  id: `m:${String(r.id)}`,
  day: String(r.day),
  kind: (isManualEventKind(r.kind) ? r.kind : 'other') as ManualEventKind,
  origin: 'manual',
  label: null,
  title: String(r.title),
  note: r.note ? String(r.note) : null,
  version: null,
  liveDay: null,
  waitsForRelease: false,
});

export async function manualEvents(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<TimelineEvent[]> {
  const rows = await sql.query(
    'SELECT id, kind, day, title, note FROM timeline_events WHERE workspace_id = ? AND app_id = ? ORDER BY day DESC, id LIMIT ?',
    [workspaceId, appId, MAX_EVENTS_PER_APP],
  );
  return rows.map(manualOf);
}

export const countManual = async (sql: Sql, workspaceId: string, appId: string): Promise<number> =>
  Number(
    (
      await sql.query(
        'SELECT COUNT(*) AS n FROM timeline_events WHERE workspace_id = ? AND app_id = ?',
        [workspaceId, appId],
      )
    )[0]?.n ?? 0,
  );

export async function insertManual(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    actorId: string;
    at: number;
    event: z.infer<typeof createEventBody>;
  },
): Promise<TimelineEvent> {
  const id = randomUUID();
  await sql.execute(
    `INSERT INTO timeline_events (id, workspace_id, app_id, kind, day, title, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.appId,
      input.event.kind,
      input.event.day,
      input.event.title,
      input.event.note ?? '',
      input.actorId,
      input.at,
      input.at,
    ],
  );
  return manualOf({
    id,
    kind: input.event.kind,
    day: input.event.day,
    title: input.event.title,
    note: input.event.note ?? '',
  });
}

export async function getManual(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<TimelineEvent | undefined> {
  const rows = await sql.query(
    'SELECT id, kind, day, title, note FROM timeline_events WHERE workspace_id = ? AND app_id = ? AND id = ?',
    [workspaceId, appId, id],
  );
  return rows[0] ? manualOf(rows[0]) : undefined;
}

export async function saveManual(
  sql: Sql,
  input: { workspaceId: string; appId: string; id: string; at: number; event: TimelineEvent },
): Promise<void> {
  await sql.execute(
    'UPDATE timeline_events SET kind = ?, day = ?, title = ?, note = ?, updated_at = ? WHERE workspace_id = ? AND app_id = ? AND id = ?',
    [
      input.event.kind,
      input.event.day,
      input.event.title ?? '',
      input.event.note ?? '',
      input.at,
      input.workspaceId,
      input.appId,
      input.id,
    ],
  );
}

export async function deleteManual(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<number> {
  return sql.execute(
    'DELETE FROM timeline_events WHERE workspace_id = ? AND app_id = ? AND id = ?',
    [workspaceId, appId, id],
  );
}
