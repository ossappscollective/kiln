import { type Platform, STORE_BUILDS_READ_TTL_MS, supports } from '@kiln/core';
import type { Api } from '../api.ts';
import type { BuildsList } from '../builds.ts';
import { readFact, readKeys } from '../facts/invalidate.ts';
import { navSignals } from '../nav-signals.svelte.ts';
import type { EditableRelease, ReleaseCandidates } from '../release-candidates.ts';
import type { NotesHistory } from '../release-notes.ts';
import type { AppPipeline, PipelineSummary } from '../release-pipeline.ts';
import { stagingError } from '../staged.ts';
import type { CrashGroups, TestflightView } from '../testflight.ts';
import type {
  AppBuilds,
  AppDetail,
  AppSummary,
  PlanDetail,
  PlanSummary,
  ReleaseSummary,
} from '../types.ts';
import type { StoreBuildFact } from './candidates.ts';
import { storeBuildFactOf } from './facts.ts';

/**
 * THE release facts of the web app (docs/state-model.md, "Single owners (web)"): what every release surface reads, in ONE place, with ONE
 * read and ONE cache per fact, forgotten by ONE event (`invalidate()` of lib/facts/invalidate.ts forgets the key families this file reads
 * through; nothing here keeps a copy that an event does not reach).
 *
 *   releases        the store versions of each record (`GET apps/{id}`): pushed by the app page (`setReleases`) or read here (`readApp`), read
 *                   by the sidebar, the Overview, the Releases page, the stepper and the model: they can no longer hold different lists.
 *   pipeline        the release pipeline of a record and the workspace summary (`GET release/pipeline`): the next step, the alerts, the strip.
 *   builds          the ONE read of `GET builds/artifacts` per record (store builds with their origin, CI artifacts): the Test builds page, the
 *                   build picker's CI reads, the Publish summary and the candidate model (`storeBuildFactsOf`) all read this entry.
 *   candidates      the builds / version codes a release can use (`GET release/candidates`), the editable version or draft (`.../editable`)
 *   others          the CI-linked builds (`GET builds`), the release plans, earlier release notes, TestFlight: read through the same cache.
 *
 * Every `read*` method is a typed cache read: single flight, the key family says which event makes it old, a failed read is never kept.
 * The components call these (never `api.<read>` themselves: guard rule R1) and keep only their own loading state. The candidate model
 * reads `pipelineOf` and `storeBuildFactsOf`; `ensureRecord` loads both for the records a page shows, so the candidates never wait for
 * a particular card (the Next step card used to be the only thing that read them).
 */

type ReadOptions = { force?: boolean };

let workspace = $state('');
let releasesByApp = $state<Record<string, ReleaseSummary[] | undefined>>({});
let summaries = $state<Record<string, PipelineSummary | undefined>>({});
let summaryFailed = $state<Record<string, boolean | undefined>>({});
let pipelines = $state<Record<string, AppPipeline | undefined>>({});
let buildLists = $state<Record<string, BuildsList | undefined>>({});
const generation: Record<string, number> = {};
const bump = (key: string): number => (generation[key] = (generation[key] ?? 0) + 1);

function scope(workspaceId: string): void {
  if (workspaceId === workspace) return;
  workspace = workspaceId;
  releasesByApp = {};
  summaries = {};
  summaryFailed = {};
  pipelines = {};
  buildLists = {};
}

export const releaseFactsStore = {
  // ---- releases

  /** The releases of the records a page loaded, by record id (what the sidebar, the Overview and the model read). */
  releasesOf(workspaceId: string): Record<string, ReleaseSummary[] | undefined> {
    return workspaceId === workspace ? releasesByApp : {};
  },
  setReleases(workspaceId: string, appId: string, releases: readonly ReleaseSummary[]): void {
    scope(workspaceId);
    releasesByApp = { ...releasesByApp, [appId]: [...releases] };
  },
  /** One record with its releases (`GET apps/{id}`); the releases are kept for every other surface. Throws like the api. */
  async readApp(api: Api, workspaceId: string, appId: string): Promise<AppDetail> {
    const detail = await api.app(workspaceId, appId);
    releaseFactsStore.setReleases(workspaceId, appId, detail.releases);
    return detail;
  },

  /** The apps of the workspace (kept a minute by the app list). Throws when it cannot be read, like the api. */
  async readApps(api: Api, workspaceId: string): Promise<AppSummary[]> {
    const list = await navSignals.ensureApps(api, workspaceId);
    if (list === null) return (await api.apps(workspaceId)).apps;
    return list;
  },

  // ---- pipeline

  pipelineSummary(workspaceId: string): PipelineSummary | null {
    return summaries[workspaceId] ?? null;
  },
  pipelineSummaryFailed(workspaceId: string): boolean {
    return summaryFailed[workspaceId] === true;
  },
  /** Reads the workspace summary. Returns '' when it worked, else a sentence. */
  async loadPipelineSummary(api: Api, workspaceId: string): Promise<string> {
    const mine = bump(`summary/${workspaceId}`);
    try {
      const out = await api.releasePipelineSummary(workspaceId);
      if (mine === generation[`summary/${workspaceId}`]) {
        summaries[workspaceId] = out;
        summaryFailed[workspaceId] = false;
      }
      return '';
    } catch (e) {
      if (mine === generation[`summary/${workspaceId}`]) summaryFailed[workspaceId] = true;
      return stagingError(e);
    }
  },
  pipelineOf(appId: string): AppPipeline | null {
    return pipelines[appId] ?? null;
  },
  /** One record's pipeline, through the read cache (a page that shows several parts of it asks once). Throws like the api. */
  async readPipeline(
    api: Api,
    workspaceId: string,
    appId: string,
    options: ReadOptions = {},
  ): Promise<AppPipeline> {
    scope(workspaceId);
    const mine = bump(`pipeline/${appId}`);
    const out = await readFact('pipeline', {
      workspaceId,
      key: readKeys.pipeline(appId),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.releasePipeline(workspaceId, appId),
    });
    if (mine === generation[`pipeline/${appId}`]) pipelines[appId] = out;
    return out;
  },
  /** The model's read of a pipeline: never throws, returns '' when it worked, else a sentence. */
  async loadPipeline(api: Api, workspaceId: string, appId: string, force = false): Promise<string> {
    try {
      await releaseFactsStore.readPipeline(api, workspaceId, appId, { force });
      return '';
    } catch (e) {
      return stagingError(e);
    }
  },

  // ---- builds: the ONE read of `GET builds/artifacts`

  /** The builds of a record as last read (store rows with their origin, CI artifacts), or null. */
  buildsOf(appId: string): BuildsList | null {
    return buildLists[appId] ?? null;
  },
  /** The store rows as the candidate model's facts (TestFlight rows, Play version codes), or null until read. */
  storeBuildFactsOf(appId: string): readonly StoreBuildFact[] | null {
    const list = buildLists[appId];
    return list === undefined ? null : list.store.map(storeBuildFactOf);
  },
  /** The builds of a record through the read cache: the Test builds page, the picker and the Publish summary share this entry. Throws like the api. */
  async readBuilds(
    api: Api,
    workspaceId: string,
    appId: string,
    options: ReadOptions = {},
  ): Promise<BuildsList> {
    scope(workspaceId);
    const mine = bump(`builds/${appId}`);
    const out = await readFact('storeBuilds', {
      workspaceId,
      key: readKeys.storeBuilds(appId),
      ttlMs: STORE_BUILDS_READ_TTL_MS,
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.buildArtifacts(workspaceId, appId),
    });
    if (mine === generation[`builds/${appId}`]) buildLists[appId] = out;
    return out;
  },
  /** The model's read: never throws (the candidates fall back to the newest build of the pipeline). */
  async loadBuilds(api: Api, workspaceId: string, appId: string, force = false): Promise<void> {
    try {
      await releaseFactsStore.readBuilds(api, workspaceId, appId, { force });
    } catch {
      // Not read: the model knows the pipeline's newest build instead.
    }
  },
  /**
   * The facts the candidates are made of, for the records a page shows (the pipeline of each, and the store builds of an App Store record),
   * in the same refresh. Called by the app page, not by a card: the Releases page, the stepper and the Next step card all see them.
   */
  ensureRecord(
    api: Api,
    workspaceId: string,
    records: readonly { id: string; platform: Platform }[],
    options: { force?: boolean } = {},
  ): void {
    for (const r of records) {
      void releaseFactsStore.loadPipeline(api, workspaceId, r.id, options.force === true);
      if (!supports(r.platform, 'releaseTracks'))
        void releaseFactsStore.loadBuilds(api, workspaceId, r.id, options.force === true);
    }
  },

  // ---- candidates and the editable release

  /** The builds or version codes a release can use. `track`: Google Play only. Throws like the api. */
  readCandidates(
    api: Api,
    workspaceId: string,
    appId: string,
    track: string | null,
    options: ReadOptions = {},
  ): Promise<{ candidates: ReleaseCandidates }> {
    scope(workspaceId);
    return readFact('candidates', {
      workspaceId,
      key: readKeys.candidates(appId, track === null ? '' : track.trim()),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () =>
        api.releaseCandidates(workspaceId, appId, track === null ? {} : { track: track.trim() }),
    });
  },
  /** The editable App Store version, or the draft release of a Google Play track. Throws like the api (`no_editable_version`). */
  readEditable(
    api: Api,
    workspaceId: string,
    appId: string,
    track: string | null,
    options: ReadOptions = {},
  ): Promise<{ editable: EditableRelease }> {
    scope(workspaceId);
    return readFact('editable', {
      workspaceId,
      key: readKeys.editable(appId, track === null ? '' : track.trim()),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () =>
        api.releaseEditable(workspaceId, appId, track === null ? undefined : track.trim()),
    });
  },

  // ---- the rest of what a release page reads

  /** The builds Kiln linked to CI runs (`GET builds`). Throws like the api. */
  readAppBuilds(
    api: Api,
    workspaceId: string,
    appId: string,
    options: ReadOptions = {},
  ): Promise<AppBuilds> {
    scope(workspaceId);
    return readFact('appBuilds', {
      workspaceId,
      key: readKeys.appBuilds(appId),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.appBuilds(workspaceId, appId),
    });
  },
  /** The release plans of an app. Throws like the api. */
  readPlans(
    api: Api,
    workspaceId: string,
    appId: string,
    options: ReadOptions = {},
  ): Promise<{ plans: PlanSummary[] }> {
    scope(workspaceId);
    return readFact('plans', {
      workspaceId,
      key: readKeys.plans(appId, ''),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.appPlans(workspaceId, appId),
    });
  },
  /** One release plan with its items and notes. Throws like the api. */
  readPlan(
    api: Api,
    workspaceId: string,
    appId: string,
    planId: string,
    options: ReadOptions = {},
  ): Promise<{ plan: PlanDetail }> {
    scope(workspaceId);
    return readFact('plans', {
      workspaceId,
      key: readKeys.plans(appId, planId),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.plan(workspaceId, appId, planId),
    });
  },
  /** The "what is new" texts earlier releases used. `question` names the query for the cache. Throws like the api. */
  readNotesHistory(
    api: Api,
    workspaceId: string,
    appId: string,
    query: Parameters<Api['releaseNotesHistory']>[2],
    options: ReadOptions = {},
  ): Promise<{ history: NotesHistory }> {
    scope(workspaceId);
    const q = query ?? {};
    const question = [
      q.platform ?? '',
      q.locale ?? '',
      q.limit ?? '',
      q.track ?? '',
      (q.codes ?? []).join(','),
    ].join('|');
    return readFact('notesHistory', {
      workspaceId,
      key: readKeys.notesHistory(appId, question),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.releaseNotesHistory(workspaceId, appId, query),
    });
  },
  /** The TestFlight feedback list of an app for a query string. Throws like the api. */
  readTestflight(
    api: Api,
    workspaceId: string,
    appId: string,
    query: string,
    options: ReadOptions = {},
  ): Promise<TestflightView> {
    scope(workspaceId);
    return readFact('testflight', {
      workspaceId,
      key: readKeys.testflight(appId, query),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.appTestflight(workspaceId, appId, query),
    });
  },
  /** The crash groups of the TestFlight feedback of an app. Throws like the api. */
  readTestflightCrashGroups(
    api: Api,
    workspaceId: string,
    appId: string,
    options: ReadOptions = {},
  ): Promise<CrashGroups> {
    scope(workspaceId);
    return readFact('testflight', {
      workspaceId,
      key: readKeys.testflight(appId, 'crash-groups'),
      ...(options.force === undefined ? {} : { force: options.force }),
      load: () => api.appTestflightCrashGroups(workspaceId, appId),
    });
  },
};
