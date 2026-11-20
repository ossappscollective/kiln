import {
  evaluatePipeline,
  isGooglePlatform,
  type Pipeline,
  type PipelineBuildFact,
  type PipelineFacts,
  type PipelineRunFact,
  type PipelineState,
  type PipelineVersionFact,
  type Platform,
  parsePlatform,
  RELEASE_STATES,
  type ReleaseState,
} from '@mrm/core';
import type { Sql } from '@mrm/db';
import { releasesSentHere, sentAtOf } from './apps.ts';
import { effectiveConventions, listConventions } from './build-conventions.ts';
import { RELEASE_WORKFLOW } from './build-tags.ts';
import { RUN_COLUMNS, runCountsForApp, runViews, type WorkflowRunView } from './ci-runs.ts';
import { getSettings } from './workspace-settings.ts';

/**
 * The release pipeline of an app (docs/api/release-pipeline.md): where its release is between a CI run and "live", and whether it
 * is stalled. The facts come from this server's own tables only (the stored runs, the builds and releases of the last store sync,
 * the links between builds and runs), so reading it never asks GitHub or a store and costs a few queries per workspace.
 * The judgement is `evaluatePipeline` in `@mrm/core`.
 */

/** Runs older than this are not part of a release in flight. */
export const PIPELINE_RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RUNS_READ = 2000;
const STATES = new Set<string>(RELEASE_STATES);

type Row = Record<string, unknown>;
type AppRow = {
  id: string;
  name: string;
  platform: Platform;
  repositoryId: string | null;
  lastSyncedAt: number | null;
};

export type PipelineApp = {
  id: string;
  name: string;
  platform: Platform;
  store: 'appstoreconnect' | 'googleplay';
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** A run counts as a release run for an app when it was started for it, or its workflow looks like one that ships builds. */
function releaseLike(run: WorkflowRunView, appId: string, preferred: string | null): boolean {
  if (run.appIds.indexOf(appId) !== -1) return true;
  const names = [run.workflow, run.workflowPath, run.workflowPath?.split('/').pop()];
  if (preferred !== null) {
    const wanted = preferred.toLowerCase();
    return names.some((n) => n?.toLowerCase() === wanted);
  }
  return names.some((n) => n !== undefined && n !== null && RELEASE_WORKFLOW.test(n));
}

const runFact = (r: WorkflowRunView): PipelineRunFact => ({
  id: r.id,
  workflow: r.workflow,
  runNumber: r.runNumber,
  status: r.status,
  conclusion: r.conclusion,
  active: r.active,
  startedAt: r.startedAt,
  updatedAt: r.updatedAt,
  url: r.url,
});

/**
 * The facts of the apps of a workspace (all of them, or `appIds`). One query per table, however many apps. An app that is not
 * found is left out.
 */
export async function loadPipelineFacts(
  sql: Sql,
  input: {
    workspaceId: string;
    appIds?: readonly string[] | undefined;
    now: number;
    /**
     * Screens only: a Google Play release this server sent in the last days reads "in review" (Google reports no review state).
     * Not for the release watch: its "stalled" signals must not run on a state Google never reported.
     */
    sentForReview?: boolean | undefined;
  },
): Promise<{
  facts: PipelineFacts[];
  apps: Map<string, PipelineApp>;
  settings: { stalledAfterHours: number; stalledRepeatHours: number };
}> {
  const { workspaceId, now } = input;
  const settings = (await getSettings(sql, workspaceId)).values;
  const stalledAfterHours = Number(settings['release.stalledAfterHours']);
  const stalledRepeatHours = Number(settings['release.stalledRepeatHours']);
  const wanted = input.appIds === undefined ? undefined : new Set(input.appIds);
  const appRows = (
    await sql.query(
      `SELECT a.id, a.name, a.platform, a.last_synced_at,
            (SELECT r.id FROM repositories r WHERE r.id = a.repository_id AND r.workspace_id = a.workspace_id) AS repository_id
       FROM apps a WHERE a.workspace_id = ? ORDER BY a.name, a.id`,
      [workspaceId],
    )
  )
    .filter((r) => wanted === undefined || wanted.has(String(r.id)))
    .map(
      (r): AppRow => ({
        id: String(r.id),
        name: String(r.name),
        platform: (parsePlatform(String(r.platform)) ?? 'ios') as Platform,
        repositoryId: str(r.repository_id),
        lastSyncedAt: num(r.last_synced_at),
      }),
    );
  const apps = new Map<string, PipelineApp>(
    appRows.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        platform: a.platform,
        store: isGooglePlatform(a.platform) ? 'googleplay' : 'appstoreconnect',
      },
    ]),
  );
  if (appRows.length === 0)
    return { facts: [], apps, settings: { stalledAfterHours, stalledRepeatHours } };

  const releases = await sql.query(
    `SELECT app_id, platform, version, track, build, status, raw_state, details_json, status_since, synced_at
       FROM app_releases WHERE workspace_id = ?`,
    [workspaceId],
  );
  const builds = await sql.query(
    `SELECT app_id, platform, build_number, version, processing_state, raw_state, expired, uploaded_at, first_seen_at
       FROM app_builds WHERE workspace_id = ?`,
    [workspaceId],
  );
  const links = await sql.query(
    'SELECT app_id, platform, build_number, run_id FROM build_links WHERE workspace_id = ?',
    [workspaceId],
  );

  const repositoryIds = [
    ...new Set(appRows.flatMap((a) => (a.repositoryId ? [a.repositoryId] : []))),
  ];
  let runs: WorkflowRunView[] = [];
  const preferred = new Map<string, string | null>();
  if (repositoryIds.length > 0) {
    const marks = repositoryIds.map(() => '?').join(', ');
    const rows = await sql.query(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs
        WHERE workspace_id = ? AND repository_id IN (${marks}) AND started_at >= ?
        ORDER BY started_at DESC, id DESC LIMIT ?`,
      [workspaceId, ...repositoryIds, now - PIPELINE_RUN_WINDOW_MS, MAX_RUNS_READ],
    );
    runs = await runViews(sql, rows);
    for (const repositoryId of repositoryIds) {
      const conventions = await listConventions(sql, workspaceId, repositoryId);
      for (const a of appRows) {
        if (a.repositoryId === repositoryId)
          preferred.set(a.id, effectiveConventions(conventions, a.id).workflow);
      }
    }
  }

  const facts: PipelineFacts[] = [];
  for (const app of appRows) {
    const linkOf = new Map<string, string>();
    for (const l of links) {
      if (
        String(l.app_id) === app.id &&
        String(l.platform) === app.platform &&
        String(l.run_id) !== ''
      )
        linkOf.set(String(l.build_number), String(l.run_id));
    }
    const forApp = runs.filter(
      (r) => r.repositoryId === app.repositoryId && runCountsForApp(r, app.id),
    );
    const linkedRunIds = new Set(linkOf.values());
    const appRuns = forApp
      .filter(
        (r) => linkedRunIds.has(r.id) || releaseLike(r, app.id, preferred.get(app.id) ?? null),
      )
      .map(runFact);

    const buildFacts: PipelineBuildFact[] = builds
      .filter((b) => String(b.app_id) === app.id && String(b.platform) === app.platform)
      .map((b) => {
        const state = String(b.processing_state);
        return {
          buildNumber: String(b.build_number),
          version: str(b.version),
          state:
            state === 'processing' || state === 'processed' || state === 'invalid'
              ? state
              : 'unknown',
          rawState: str(b.raw_state),
          expired: b.expired === null || b.expired === undefined ? null : Number(b.expired) === 1,
          uploadedAt: num(b.uploaded_at),
          firstSeenAt: Number(b.first_seen_at),
          runId: linkOf.get(String(b.build_number)) ?? null,
        };
      });

    const sent =
      input.sentForReview === true && app.platform === 'android'
        ? await releasesSentHere(sql, workspaceId, app.id)
        : [];
    const versionFacts: PipelineVersionFact[] = releases
      .filter((r) => String(r.app_id) === app.id && String(r.platform) === app.platform)
      .map((r) => {
        const status = str(r.status);
        const details = parseDetails(r.details_json);
        const track = str(r.track);
        const known = status !== null && STATES.has(status) ? (status as ReleaseState) : null;
        const inReview =
          sent.length > 0 &&
          (known === 'live' || known === 'rolling_out') &&
          sentAtOf(sent, track === '' ? null : track, details.versionCodes) !== null;
        return {
          version: String(r.version),
          track: track === null || track === '' ? null : track,
          status: inReview ? ('in_review' as ReleaseState) : known,
          rawState: String(r.raw_state),
          build: str(r.build),
          versionCodes: details.versionCodes,
          rolloutFraction: details.rolloutFraction,
          // A row written before the sync recorded the time of the move: its last sync is the best lower bound.
          since: inReview ? now : Number(r.status_since ?? r.synced_at),
        };
      });

    facts.push({
      appId: app.id,
      platform: app.platform,
      now,
      stalledAfterHours,
      lastSyncedAt: app.lastSyncedAt,
      runs: appRuns,
      builds: buildFacts,
      versions: versionFacts,
    });
  }
  return { facts, apps, settings: { stalledAfterHours, stalledRepeatHours } };
}

function parseDetails(raw: unknown): {
  versionCodes: string[] | null;
  rolloutFraction: number | null;
} {
  if (typeof raw !== 'string') return { versionCodes: null, rolloutFraction: null };
  try {
    const v = JSON.parse(raw) as { versionCodes?: unknown; rolloutFraction?: unknown } | null;
    const codes = v?.versionCodes;
    return {
      versionCodes: Array.isArray(codes) ? codes.map(String) : null,
      rolloutFraction: typeof v?.rolloutFraction === 'number' ? v.rolloutFraction : null,
    };
  } catch {
    return { versionCodes: null, rolloutFraction: null };
  }
}

export type AppPipeline = { app: PipelineApp; pipeline: Pipeline; lastSyncedAt: number | null };

/** The pipeline of one app, or undefined when the app is not in the workspace. */
export async function appPipeline(
  sql: Sql,
  input: { workspaceId: string; appId: string; now: number },
): Promise<AppPipeline | undefined> {
  const loaded = await loadPipelineFacts(sql, {
    workspaceId: input.workspaceId,
    appIds: [input.appId],
    now: input.now,
    sentForReview: true,
  });
  const f = loaded.facts[0];
  const app = loaded.apps.get(input.appId);
  if (!f || !app) return undefined;
  return { app, pipeline: evaluatePipeline(f), lastSyncedAt: f.lastSyncedAt };
}

export type PipelineSummaryApp = {
  app: PipelineApp;
  state: PipelineState;
  waitingOn: Pipeline['waitingOn'];
  since: number | null;
  summary: string;
  lastSyncedAt: number | null;
  stalled: {
    step: string;
    label: string;
    message: string;
    hours: number;
    since: number;
    stale: boolean;
    evidence: { kind: string; id: string; at: number | null }[];
  } | null;
};

export type PipelineSummary = {
  /** The workspace setting `release.stalledAfterHours` (0: the signal is off). */
  stalledAfterHours: number;
  apps: PipelineSummaryApp[];
  totals: { apps: number; stalled: number; byState: Record<string, number> };
  generatedAt: number;
};

/** The pipelines of every app of the workspace (or of `appIds`), one line each, with the stalled ones first. */
export async function pipelineSummary(
  sql: Sql,
  input: { workspaceId: string; appIds?: readonly string[] | undefined; now: number },
): Promise<PipelineSummary> {
  const loaded = await loadPipelineFacts(sql, { ...input, sentForReview: true });
  const apps: PipelineSummaryApp[] = [];
  const byState: Record<string, number> = {};
  for (const f of loaded.facts) {
    const p = evaluatePipeline(f);
    const app = loaded.apps.get(f.appId) as PipelineApp;
    byState[p.state] = (byState[p.state] ?? 0) + 1;
    apps.push({
      app,
      state: p.state,
      waitingOn: p.waitingOn,
      since: p.since,
      summary: p.summary,
      lastSyncedAt: f.lastSyncedAt,
      stalled: p.stalled
        ? {
            step: p.stalled.step,
            label: p.stalled.label,
            message: p.stalled.message,
            hours: p.stalled.hours,
            since: p.stalled.since,
            stale: p.stalled.stale,
            evidence: p.stalled.evidence.map((e) => ({ kind: e.kind, id: e.id, at: e.at })),
          }
        : null,
    });
  }
  // Stalled first (fresh before stale, oldest stall first), then the others in name order (the order they came in).
  const rank = (a: PipelineSummaryApp) => (a.stalled === null ? 2 : a.stalled.stale ? 1 : 0);
  apps.sort(
    (a, b) => rank(a) - rank(b) || (a.stalled && b.stalled ? a.stalled.since - b.stalled.since : 0),
  );
  return {
    stalledAfterHours: loaded.settings.stalledAfterHours,
    apps,
    totals: {
      apps: apps.length,
      stalled: apps.filter((a) => a.stalled !== null && !a.stalled.stale).length,
      byState,
    },
    generatedAt: input.now,
  };
}
