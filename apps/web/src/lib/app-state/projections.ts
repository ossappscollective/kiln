import { computeReadiness, findDisplay, groupStoreImages, stagedCountsOf } from '@kiln/core';
import { groupApps } from '../app-groups.ts';
import { stagedUnpushedCount } from '../app-attention.ts';
import { buildOverviewRows } from '../app-overview.ts';
import { platformStatusLines } from '../app-status.ts';
import { appNavCounts } from '../nav-badges.ts';
import { platformGroups, blockingItems } from '../pending.ts';
import { blockerLines, submitBlockedOnly } from '../publish-failure.ts';
import { buildDate } from '../publish-summary.ts';
import type { ReleaseLoad } from '../portfolio.ts';
import { releaseFactsOf } from './release-facts.ts';
import { noteLimit, noteRows } from '../release-notes.ts';
import { buildReleaseTable, liveRowKeys, splitCurrent, type ObsoleteInfo } from '../releases-table.ts';
import { stagedFacts } from '../release-stepper.ts';
import type { PipelineSummaryApp } from '../release-pipeline.ts';
import { itemCount } from '../staged.ts';
import type { ReleaseSummary } from '../types.ts';
import { blockersViewOf } from './blockers.ts';
import { deriveAppState } from './derive.ts';
import {
  analyzeCandidates,
  buildsWithPipeline,
  releasesWithPipeline,
  stallLeftBehind,
} from './candidates.ts';
import { lineOfRecords } from './facts.ts';
import { deriveImagesFacts } from './store-images.ts';
import {
  cartItemCount,
  cartSummaryOf,
  factsOf,
  pendingItemsOf,
  pendingSummaryOf,
  pendingViewOf,
  stagedViewOf,
  storeImagesViewOf,
  type World,
} from './consistency-world.ts';
import type { AppFacts, AppState } from './types.ts';

/**
 * The display surfaces of the app and what each one SHOWS, as a pure function of the world (docs/state-model.md, "Consistency contract").
 *
 * A surface is a screen or a part of one (the sidebar badge, the Portfolio card, the Overview tiles, the Pending page header...). Its
 * `project(world)` returns the FACTS it would draw, by fact key (`pendingCount`, `liveVersion:<record>`, `imageCount:<display>`...),
 * built from the SAME model and derive helpers the component calls today. Where a component computes a fact INLINE, the projection
 * mirrors that logic and says where in `mirrors`: those are exactly the places a migration replaces by the model's one fact. The
 * consistency test (consistency.test.ts) compares every fact key that two surfaces both show.
 *
 * A surface that shows NOTHING for a fact (a badge hidden at zero, a count not drawn while unknown) omits the key. A surface that shows
 * "none" says `null`.
 */

export type FactValue = string | number | boolean | null | readonly string[];
export type Facts = Record<string, FactValue>;
export type Domain = 'images' | 'releases' | 'listing' | 'state';

export type Surface = {
  id: string;
  /** The components that draw it. */
  components: readonly string[];
  /** Where the logic that decides these facts lives TODAY (file:line). A migration replaces each by the model's fact. */
  mirrors: readonly string[];
  project(w: World): Facts;
};

/** The fact keys, by family (a key `imageCount:en-US/ipad_13` belongs to `imageCount`). Adding a fact means adding it here. */
export const FACTS: Readonly<Record<string, { domain: Domain; about: string }>> = {
  pendingCount: { domain: 'state', about: 'how many changes wait to be published (the cart length)' },
  blockingCount: { domain: 'state', about: 'pending items that an error blocks' },
  stagedUnpushed: { domain: 'state', about: 'staged changes not written to the store draft yet' },
  awaitingSubmit: { domain: 'state', about: 'a draft was pushed and waits for its submit (never part of the pending count)' },
  stagedItems: { domain: 'state', about: 'every staged row, pushed ones included (the tray)' },
  stagedAssetSets: { domain: 'images', about: 'staged graphic sets' },
  stagedSetFiles: { domain: 'images', about: 'files of a staged graphic set' },
  phase: { domain: 'state', about: 'what the app is doing (the model phase)' },
  blockerCount: { domain: 'state', about: 'what blocks a submit (current) or the run kept (history)' },
  liveVersion: { domain: 'releases', about: 'the version that is live on a record' },
  latestVersion: { domain: 'releases', about: 'the newest version of a record' },
  candidate: { domain: 'releases', about: 'the build that asks for the next release' },
  obsoleteVersions: { domain: 'releases', about: 'store versions left behind by what is live' },
  unfinishedReleases: { domain: 'releases', about: 'records whose release is left unfinished' },
  newestBuild: { domain: 'releases', about: 'the newest store build of a record' },
  buildDate: { domain: 'releases', about: 'the upload date of the newest build' },
  imageCount: { domain: 'images', about: 'images the store holds for a display' },
  imageGroupCount: { domain: 'images', about: 'images the store holds in one placement group' },
  localeList: { domain: 'listing', about: 'the locales of a record' },
  defaultLocale: { domain: 'listing', about: 'the default locale of a record' },
  notesFilled: { domain: 'listing', about: 'locales that have release notes' },
  notesOver: { domain: 'listing', about: 'locales whose release notes are over the limit' },
};
export const familyOf = (key: string): string => key.split(':')[0] as string;

// ---------------------------------------------------------------------------------------------
// Shared inputs

const ids = (w: World): string[] => w.records.map((r) => r.id);
const inScope = (w: World) => w.records.filter((r) => w.scope === 'both' || r.platform === w.scope);
const appState = (w: World, releases: AppFacts['releases'] = w.releases): AppState =>
  deriveAppState(factsOf(w, releases), w.scope);
const sorted = (list: readonly string[]): string[] => [...list].sort();

/**
 * The release lists a screen holds: the pages load them for their own records, so the sidebar (it holds none) and the Portfolio / the
 * Dashboard (each its own) pass different lists to the same model.
 */
const noReleases: AppFacts['releases'] = {};

/**
 * The apps of the pipeline summary that are left unfinished, as the model answers.
 * mirrors: apps/web/src/lib/app-state/app-state-store.svelte.ts:312 `stalledApps` (a method of the rune store with this exact body).
 */
function stalledOf(w: World, releases: AppFacts['releases'] | undefined): PipelineSummaryApp[] {
  return (w.pipelineSummary?.apps ?? []).map((a) => {
    if (a.stalled === null) return a;
    const id = a.app.id;
    const p = w.pipelines[id] ?? null;
    const analysis = analyzeCandidates({
      appId: id,
      platform: a.app.platform,
      releases: releasesWithPipeline(id, a.app.platform, releases?.[id], p),
      builds: buildsWithPipeline(a.app.platform, w.storeBuilds[id] ?? null, p),
    });
    return stallLeftBehind(a.stalled, analysis) ? { ...a, stalled: null } : a;
  });
}
const unfinishedIn = (apps: readonly PipelineSummaryApp[], recordIds: readonly string[]): number =>
  apps.filter((a) => a.stalled !== null && !a.stalled.stale && recordIds.indexOf(a.app.id) >= 0).length;

const loadsOf = (w: World): Record<string, ReleaseLoad> => {
  const out: Record<string, ReleaseLoad> = {};
  for (const r of w.records) out[r.id] = { state: 'ready', releases: w.releases[r.id] ?? [] };
  return out;
};
const lineOf = (w: World, appIds: readonly string[]) =>
  lineOfRecords({ cart: cartSummaryOf(w), pendingSummary: pendingSummaryOf(w) }, appIds);

const versionOf = (r: ReleaseSummary | null | undefined): string | null => r?.version ?? null;
const displayKey = (locale: string, device: string | null) => `${locale}/${device ?? ''}`;

/** The model's own newest build per record: the candidate when there is one. */
const candidateOf = (s: AppState, appId: string): string | null => {
  const c = s.candidates.find((x) => x.appId === appId);
  return c ? `${c.plan.candidate.version}#${c.plan.candidate.buildNumber}` : null;
};

// ---------------------------------------------------------------------------------------------
// The surfaces

export const SURFACES: readonly Surface[] = [
  {
    id: 'topBar',
    components: ['components/app/PendingCartButton.svelte'],
    mirrors: ['lib/app-state/app-state-store.svelte.ts:243 topBar() -> deriveTopBar (model)'],
    project(w) {
      const b = appState(w).badge;
      const out: Facts = {};
      if (b.kind === 'pending') {
        out.pendingCount = b.count;
        out.phase = 'changes_pending';
      } else if (b.kind === 'publishing') {
        out.pendingCount = b.count;
        out.phase = 'publishing';
      } else if (b.kind === 'failed') {
        out.pendingCount = b.count;
        out.phase = b.ready === true ? 'ready_to_submit' : 'publish_failed';
      }
      return out;
    },
  },
  {
    id: 'sidebarBadge',
    components: ['components/Shell.svelte'],
    mirrors: [
      'components/Shell.svelte:108-126 appCounts (lineOf + appNavCounts)',
      'components/Shell.svelte:118 stalledApps(workspaceId, navSignals.releasesOf(workspaceId)) (the lists the pages pushed into navSignals)',
    ],
    project(w) {
      const out: Facts = {};
      const line = lineOf(w, ids(w));
      if (line !== null && line.count > 0) out.pendingCount = line.count;
      const unfinished = appNavCounts({ memberIds: ids(w), unanswered: {}, stalled: stalledOf(w, w.releases) }).releases;
      if (unfinished !== null) out.unfinishedReleases = unfinished;
      return out;
    },
  },
  {
    id: 'appSwitcherChip',
    components: ['components/Shell.svelte', 'components/publish/PendingChip.svelte'],
    mirrors: ['components/Shell.svelte:136 switcherList (lineOf per group)'],
    project(w) {
      const line = lineOf(w, ids(w));
      const out: Facts = {};
      if (line !== null && line.count > 0) out.pendingCount = line.count;
      if (line !== null && line.blocking > 0) out.blockingCount = line.blocking;
      return out;
    },
  },
  {
    id: 'boardCard',
    components: ['components/dashboard/Board.svelte', 'components/dashboard/BoardCard.svelte'],
    mirrors: ['components/dashboard/Board.svelte:113 appStateStore.lineOf(workspaceId, [card.appId]) (the model line of the record)'],
    project(w) {
      const out: Facts = {};
      // One card per record: each shows the model's line for its own record (a count of 0 is not drawn).
      for (const r of w.records) {
        const line = lineOf(w, [r.id]);
        if (line !== null && line.count > 0) out[`pendingCount:${r.id}`] = line.count;
      }
      return out;
    },
  },
  {
    id: 'alertPendingStale',
    components: ['components/alerts/AlertInbox.svelte'],
    mirrors: [
      'apps/server/src/modules/alerts/evaluator.ts pendingStaleFound (the staged ITEMS a push would write, modules/publish/staged-unpushed.ts: one per text, set and field)',
    ],
    project(w) {
      // The alert says how many staged items wait (the cart rule, never a row per file); it names no count when none waits.
      const n = w.records.reduce((sum, r) => sum + cartItemCount(w, r.id), 0);
      return n > 0 ? { stagedUnpushed: n } : {};
    },
  },
  {
    id: 'portfolioCard',
    components: ['components/Portfolio.svelte', 'components/portfolio/AppTable.svelte'],
    mirrors: [
      'components/Portfolio.svelte:94 stalledApps(workspaceId, releaseLists) (the lists this page loaded)',
      'lib/app-overview.ts:107 buildOverviewRows (composes the row from four sources)',
      'components/portfolio/AppTable.svelte:58 releaseFactsOf over the page-loaded list',
    ],
    project(w) {
      const groups = groupApps(w.records);
      const loads = loadsOf(w);
      const pipelineApps = w.pipelineSummary === null ? null : stalledOf(w, w.releases);
      const rows = buildOverviewRows(groups, loads, null, pipelineApps, (appIds) => lineOf(w, appIds));
      const out: Facts = {};
      for (const row of rows) {
        if (row.pending != null && row.pending.count > 0) out.pendingCount = row.pending.count;
        if (row.unfinished.length > 0) out.unfinishedReleases = row.unfinished.length;
        for (const m of row.group.members) {
          const list = w.releases[m.id] ?? [];
          const facts = releaseFactsOf(list, m.platform);
          out[`latestVersion:${m.id}`] = versionOf(facts.latest);
          out[`liveVersion:${m.id}`] = versionOf(facts.live);
        }
      }
      return out;
    },
  },
  {
    id: 'appDashboardTiles',
    components: ['components/app/AppDashboard.svelte'],
    mirrors: [
      'components/app/AppDashboard.svelte:263 releaseFactsOf (live = liveOf: a phased release is live)',
      'components/app/AppDashboard.svelte:258 modelState.candidates',
    ],
    project(w) {
      const out: Facts = {};
      const s = appState(w);
      for (const m of inScope(w)) {
        const list = w.releases[m.id] ?? [];
        const facts = releaseFactsOf(list, m.platform);
        out[`liveVersion:${m.id}`] = versionOf(facts.live);
        out[`latestVersion:${m.id}`] = versionOf(facts.latest);
        const c = candidateOf(s, m.id);
        if (c !== null) {
          out[`candidate:${m.id}`] = c;
          out[`newestBuild:${m.id}`] = c;
        }
      }
      return out;
    },
  },
  {
    id: 'appDashboardAttention',
    components: ['components/app/AppDashboard.svelte'],
    mirrors: [
      'components/app/AppDashboard.svelte:206 stagedUnpushedCount(stagedStore.view(m.id)) (a third "staged" number)',
      'components/app/AppDashboard.svelte:212 stalledApps(workspaceId, releases).filter(...)',
    ],
    project(w) {
      const out: Facts = {};
      const members = inScope(w);
      out.stagedUnpushed = members.reduce((n, m) => n + stagedUnpushedCount(stagedViewOf(w, m.id)), 0);
      const left = unfinishedIn(stalledOf(w, w.releases), members.map((m) => m.id));
      if (left > 0) out.unfinishedReleases = left;
      return out;
    },
  },
  {
    id: 'nextStep',
    components: ['components/app/NextStep.svelte'],
    mirrors: ['lib/app-state/derive.ts:329 deriveAppState (model)', 'components/app/NextStep.svelte:86 blocked = appState.failures.find(...)'],
    project(w) {
      const s = appState(w);
      const out: Facts = {
        phase: s.phase,
        pendingCount: s.pendingCount,
        blockingCount: s.blockingCount,
      };
      for (const m of inScope(w)) {
        const c = candidateOf(s, m.id);
        if (c !== null) {
          out[`candidate:${m.id}`] = c;
          out[`newestBuild:${m.id}`] = c;
        }
        const obsolete = s.obsolete.filter((o) => o.appId === m.id);
        if (obsolete.length > 0) {
          out[`obsoleteVersions:${m.id}`] = sorted(obsolete.map((o) => o.version));
          out[`liveVersion:${m.id}`] = obsolete[0]?.liveVersion ?? null;
        }
      }
      const blocked = s.failures.find((f) => f.blockers !== null);
      if (blocked?.blockers?.state === 'blocked') out.blockerCount = blocked.blockers.current.length;
      if (blocked?.blockers?.state === 'ready') out.blockerCount = 0;
      return out;
    },
  },
  {
    id: 'pendingCartDrawer',
    components: ['components/app/PendingCart.svelte', 'components/app/PendingCartDrawer.svelte'],
    mirrors: ['components/app/PendingCart.svelte:87 count = appState.pendingCount (model)'],
    project(w) {
      return { pendingCount: appState(w).pendingCount };
    },
  },
  {
    id: 'pendingCartRows',
    components: ['components/app/PendingCart.svelte'],
    mirrors: ['components/app/PendingCart.svelte:102 api.appPendingCart (rows from an own fetch: the length of the cart)'],
    project(w) {
      return { pendingCount: inScope(w).reduce((n, m) => n + cartItemCount(w, m.id), 0) };
    },
  },
  {
    id: 'pendingHeader',
    components: ['components/publish/PendingChanges.svelte'],
    mirrors: [
      'components/publish/PendingChanges.svelte numbers (appState.pendingCount, blockingCount, awaitingSubmitCount: the model, summed over the records)',
    ],
    project(w) {
      const s = appState(w);
      const out: Facts = { pendingCount: s.pendingCount, blockingCount: s.blockingCount };
      if (s.awaitingSubmitCount > 0) out.awaitingSubmit = s.awaitingSubmitCount;
      return out;
    },
  },
  {
    id: 'pendingChangesStaged',
    components: ['components/publish/PendingChanges.svelte'],
    mirrors: [
      'components/publish/PendingChanges.svelte groupNumbers.staged (appStateStore.lineOf(...).stagedUnpushed, the summary line of the record)',
      'lib/pending.ts blockingItems (the rows with an error)',
    ],
    project(w) {
      const views = w.records.map((r) => pendingViewOf(w, r.id));
      const groups = platformGroups(views);
      const staged = groups.reduce((n, g) => n + (lineOf(w, [g.appId])?.stagedUnpushed ?? 0), 0);
      return { stagedUnpushed: staged, blockingCount: blockingItems(groups).length };
    },
  },
  {
    id: 'workspacePending',
    components: ['components/pending/WorkspacePending.svelte'],
    mirrors: ['lib/cart-summary.ts pendingRows (the cart summary merged per product)'],
    project(w) {
      return { pendingCount: cartSummaryOf(w).apps.reduce((n, a) => n + a.count, 0) };
    },
  },
  {
    id: 'releasesTable',
    components: ['components/release/ReleaseTable.svelte', 'components/app/AppReleases.svelte'],
    mirrors: [
      'lib/releases-table.ts:381 liveRowKeys (liveOf over the rows)',
      'lib/releases-table.ts:284 buildReleaseTable (sorts with its own compareReleases)',
      'components/release/ReleaseTable.svelte:180 row.obsolete.liveVersion (the model)',
    ],
    project(w) {
      const s = appState(w);
      const members = inScope(w);
      const obsolete: Record<string, ObsoleteInfo> = {};
      for (const o of s.obsolete) obsolete[o.releaseId] = { liveVersion: o.liveVersion, href: null, linkLabel: null };
      const groups = buildReleaseTable({ releases: w.releases, plans: null, builds: {}, appIds: members.map((m) => m.id), obsolete });
      const split = splitCurrent(groups);
      const liveKeys = liveRowKeys(groups);
      const out: Facts = {};
      for (const m of members) {
        const live = split.current
          .flatMap((g) => g.rows)
          .filter((r) => r.appId === m.id && liveKeys.get(r.platform) === r.key)
          .map((r) => r.version)[0];
        out[`liveVersion:${m.id}`] = live ?? null;
        const c = candidateOf(s, m.id);
        if (c !== null) out[`candidate:${m.id}`] = c;
      }
      return out;
    },
  },
  {
    id: 'releasesObsoleteBadge',
    components: ['components/release/ReleaseTable.svelte'],
    mirrors: [
      'components/release/ReleaseTable.svelte:180 row.obsolete.liveVersion ("Outdated: X is live": the model\'s live, drawn on a table that marks live by `status === "live"`)',
      'lib/releases-table.ts:394 splitCurrent',
    ],
    project(w) {
      const s = appState(w);
      const obsolete: Record<string, ObsoleteInfo> = {};
      for (const o of s.obsolete) obsolete[o.releaseId] = { liveVersion: o.liveVersion, href: null, linkLabel: null };
      const groups = buildReleaseTable({ releases: w.releases, plans: null, builds: {}, appIds: inScope(w).map((m) => m.id), obsolete });
      const out: Facts = {};
      for (const g of groups)
        for (const row of g.rows)
          if (row.obsolete !== null) {
            const key = `obsoleteVersions:${row.appId}`;
            out[key] = sorted([...((out[key] as string[] | undefined) ?? []), row.version]);
            out[`liveVersion:${row.appId}`] = row.obsolete.liveVersion;
          }
      return out;
    },
  },
  {
    id: 'shellStatus',
    components: ['components/Shell.svelte'],
    mirrors: ['components/Shell.svelte:129 platformStatusLines(group.members, navSignals.releasesOf) (the lists the pages pushed into navSignals)'],
    project(w) {
      const out: Facts = {};
      for (const line of platformStatusLines(w.records, w.releases))
        {
          const rec = w.records.find((r) => r.platform === line.platform);
          if (rec) out[`latestVersion:${rec.id}`] = line.version;
        }
      return out;
    },
  },
  {
    id: 'buildsPanel',
    components: ['components/builds/TestBuilds.svelte', 'components/portfolio/BuildsPanel.svelte'],
    mirrors: ['components/builds/TestBuilds.svelte: api.buildArtifacts (own read; the model has its own storeBuildsStore of the same rows)'],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const rows = (w.storeBuilds[m.id] ?? []).filter((b) => b.uploadedAt !== null);
        if (rows.length === 0) continue;
        const newest = rows.slice().sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))[0];
        if (newest === undefined) continue;
        out[`newestBuild:${m.id}`] = `${newest.version}#${newest.buildNumber}`;
        out[`buildDate:${m.id}`] = String(newest.uploadedAt);
      }
      return out;
    },
  },
  {
    id: 'pipelineCard',
    components: ['components/release/ReleaseStepper.svelte', 'components/release/ReleasePipeline.svelte'],
    mirrors: ['lib/app-state/candidates.ts:453 buildsWithPipeline (the pipeline knows ONE build: its latest)'],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const b = w.pipelines[m.id]?.pipeline.latest.build;
        if (b === null || b === undefined) continue;
        out[`newestBuild:${m.id}`] = `${b.version ?? ''}#${b.buildNumber}`;
        const at = (b as { uploadedAt?: number | null; firstSeenAt?: number | null }).uploadedAt ?? (b as { firstSeenAt?: number | null }).firstSeenAt ?? null;
        if (at !== null) out[`buildDate:${m.id}`] = String(at);
      }
      return out;
    },
  },
  {
    id: 'publishSummary',
    components: ['components/publish/PublishSummary.svelte'],
    mirrors: [
      'components/publish/PublishSummary.svelte:62-71 api.appListingLive (own read: the first channel that names a default language)',
      'components/publish/PublishSummary.svelte:73-80 api.appBuilds + buildDate (own read of the database rows)',
    ],
    project(w) {
      const out: Facts = {};
      const s = appState(w);
      for (const m of inScope(w)) {
        const channels = w.listing[m.id] ?? [];
        if (channels.length > 0) out[`defaultLocale:${m.id}`] = channels.map((c) => c.defaultLanguage).find((l) => l !== null && l !== undefined) ?? null;
        const best = s.analysis[m.id]?.best;
        if (best && m.platform === 'ios') {
          const d = buildDate(
            { kind: 'apple', platform: m.platform, version: best.version, numbers: [best.buildNumber] },
            (w.appBuilds[m.id] ?? []) as never,
          );
          if (d?.state === 'known') out[`buildDate:${m.id}`] = String(d.at);
        }
      }
      return out;
    },
  },
  {
    id: 'publishFailure',
    components: ['components/publish/PublishFailure.svelte'],
    mirrors: ['components/publish/PublishFailure.svelte:91 (view.state === "blocked" ? view.current : line.blockers) (the model view)'],
    project(w) {
      const out: Facts = {};
      const f = appState(w).failures.find((x) => x.blockers !== null);
      const view = f?.blockers;
      if (f && view) {
        const step = f.run.results.find((r) => r.status === 'skipped' && r.reason === 'blocked');
        if (view.state === 'blocked') out.blockerCount = view.current.length;
        else if (view.state === 'ready') out.blockerCount = 0;
        else out.blockerCount = blockerLines({ blockers: step?.blockers ?? [] }).length;
      }
      return out;
    },
  },
  {
    id: 'publishDialogFailure',
    components: ['components/publish/PublishDialog.svelte', 'components/publish/PublishFailure.svelte'],
    mirrors: ['components/publish/PublishDialog.svelte blockers={appStateStore.blockersFor(...)} (the model view: the run\'s list is history)'],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const run = w.lastRun[m.id];
        if (!run || !submitBlockedOnly(run)) continue;
        const view = blockersViewOf(run, w.readiness[m.id] ?? null, w.now);
        const step = run.results.find((r) => r.status === 'skipped' && r.reason === 'blocked');
        if (view?.state === 'blocked') out.blockerCount = view.current.length;
        else if (view?.state === 'ready') out.blockerCount = 0;
        else out.blockerCount = blockerLines({ blockers: step?.blockers ?? [] }).length;
      }
      return out;
    },
  },
  {
    id: 'stagedTray',
    components: ['components/listing/StagedTray.svelte', 'components/listing/StagedTrayApp.svelte'],
    mirrors: [],
    project(w) {
      const out: Facts = { stagedItems: inScope(w).reduce((n, m) => n + itemCount(stagedViewOf(w, m.id)), 0) };
      // The graphic sets a push would send (core `stagedCountsOf`, the family the tray's text uses).
      const sets = inScope(w).reduce((n, m) => n + stagedCountsOf(stagedViewOf(w, m.id)).unpushedSets, 0);
      if (sets > 0) out.stagedAssetSets = sets;
      return out;
    },
  },
  {
    id: 'releaseStepStaged',
    components: ['components/release/stepper/StepAssets.svelte', 'components/release/stepper/ReleaseStepper.svelte'],
    mirrors: [],
    project(w) {
      const out: Facts = {};
      let assets = 0;
      let total = 0;
      let unpushed = 0;
      for (const m of inScope(w)) {
        const f = stagedFacts(stagedViewOf(w, m.id));
        assets += f.unpushedAssets;
        total += f.total;
        unpushed += f.unpushed;
      }
      out.stagedItems = total;
      out.stagedUnpushed = unpushed;
      if (assets > 0) out.stagedAssetSets = assets;
      return out;
    },
  },
  {
    id: 'pendingCartGraphics',
    components: ['components/app/PendingCart.svelte'],
    mirrors: [],
    project(w) {
      const out: Facts = {};
      let sets = 0;
      for (const m of inScope(w)) {
        // The cart's "before" is the display as the store holds it: every group of it (the cart reads `groupStoreImages` too).
        const displays = groupStoreImages(storeImagesViewOf(w, m.id));
        for (const a of stagedViewOf(w, m.id).assets.filter((x) => !x.pushed)) {
          sets += 1;
          const before = findDisplay(displays, { locale: a.locale, kind: a.slot.kind, device: a.slot.device })?.counts.merged ?? 0;
          if (before > 0) out[`imageCount:${displayKey(a.locale, a.slot.device)}`] = before;
          out[`stagedSetFiles:${displayKey(a.locale, a.slot.device)}`] = a.files.length;
        }
      }
      if (sets > 0) out.stagedAssetSets = sets;
      return out;
    },
  },
  {
    id: 'graphicsTab',
    components: ['components/assets/StoreGraphics.svelte'],
    mirrors: [],
    project(w) {
      const out: Facts = {};
      let staged = 0;
      for (const m of inScope(w).filter((r) => r.platform !== 'android')) {
        // What the tab draws: the web store's derivation (store-images.ts), from the view and the staged view.
        const facts = deriveImagesFacts({
          platform: m.platform,
          channel: 'editable',
          view: storeImagesViewOf(w, m.id),
          staged: stagedViewOf(w, m.id),
          urls: { thumb: () => '', file: () => '', blob: () => '', repo: () => '' },
        });
        for (const l of facts.graphicSets)
          for (const set of l.sets) {
            const key = displayKey(set.locale, set.device);
            if (set.staged) {
              staged += 1;
              out[`stagedSetFiles:${key}`] = set.rows.length;
            } else out[`imageCount:${key}`] = set.rows.length;
            for (const g of set.groups) out[`imageGroupCount:${key}/${g.target}`] = g.count;
          }
      }
      out.stagedAssetSets = staged;
      return out;
    },
  },
  {
    id: 'assetsTab',
    components: ['components/assets/AssetsTab.svelte', 'components/assets/AssetGallery.svelte'],
    mirrors: [],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w).filter((r) => r.platform !== 'android')) {
        // The counts next to the repository's (`facts.side`, core `storeSideOf`): the PRIMARY group of a display, named as such.
        const side = deriveImagesFacts({
          platform: m.platform,
          channel: 'editable',
          view: storeImagesViewOf(w, m.id),
          staged: null,
          urls: { thumb: () => '', file: () => '', blob: () => '', repo: () => '' },
        }).side;
        for (const c of side?.counts ?? []) {
          const key = displayKey(c.locale, c.device);
          if (c.groups === undefined) out[`imageCount:${key}`] = c.count;
          else out[`imageGroupCount:${key}/${c.target}`] = c.count;
        }
      }
      return out;
    },
  },
  {
    id: 'releaseStepAssets',
    components: ['components/release/stepper/StepAssets.svelte'],
    mirrors: [],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w).filter((r) => r.platform !== 'android')) {
        // The comparison pairs each display through core's `groupStoreImages` (the server's diff and the table of the step read the same
        // groups): a display of several groups is one row per group, named by it; a display of one group is its count.
        for (const d of groupStoreImages(storeImagesViewOf(w, m.id))) {
          const key = displayKey(d.locale, d.device);
          if (d.groups.length > 1) for (const g of d.groups) out[`imageGroupCount:${key}/${g.target}`] = g.count;
          else out[`imageCount:${key}`] = d.counts.primary;
        }
      }
      return out;
    },
  },
  {
    id: 'listingGrid',
    components: ['components/listing/ListingTab.svelte', 'components/listing/ListingMatrix.svelte'],
    mirrors: ['apps/server/src/modules/listing/live.ts:903-940 getDrift (the live channel, plus every locale of the editable one: `copyOf`)'],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const channels = w.listing[m.id] ?? [];
        if (channels.length === 0) continue;
        out[`localeList:${m.id}`] = sorted([...new Set(channels.flatMap((c) => c.locales))]);
      }
      return out;
    },
  },
  {
    id: 'insightsChecks',
    components: ['components/insights/ListingChecks.svelte'],
    mirrors: [
      'apps/server/src/modules/insights/service.ts:184-187 channels.find(live) ONLY, locales whose language key is null dropped',
      'apps/server/src/modules/insights/service.ts:202 base locale = details.defaultLanguage, else en-US, else the first',
    ],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const channels = w.listing[m.id] ?? [];
        if (channels.length === 0) continue;
        const live = channels.find((c) => c.channel === 'live');
        if (live) out[`localeList:${m.id}`] = sorted(live.locales);
        const names = channels.flatMap((c) => c.locales);
        out[`defaultLocale:${m.id}`] = live?.defaultLanguage ?? (names.indexOf('en-US') >= 0 ? 'en-US' : (names[0] ?? null));
      }
      return out;
    },
  },
  {
    id: 'fixBar',
    components: ['components/insights/FixBar.svelte'],
    mirrors: ['apps/server/src/modules/publish/listing-fixes.ts:73 union of the live then the editable locales (its own read)'],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const channels = w.listing[m.id] ?? [];
        if (channels.length === 0) continue;
        out[`localeList:${m.id}`] = sorted([...new Set(channels.flatMap((c) => c.locales))]);
      }
      return out;
    },
  },
  {
    id: 'releaseStepNotes',
    components: ['components/release/stepper/ReleaseStepper.svelte', 'components/release/stepper/StepNotes.svelte'],
    mirrors: [
      'components/release/stepper/ReleaseStepper.svelte:306-309 locales = editable else the first channel',
      'components/release/stepper/ReleaseStepper.svelte:147 notes { withText, over } from noteRows',
      'lib/release-notes.ts:436 over: draft.length > limit (UTF-16 units, untrimmed)',
    ],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const channels = w.listing[m.id] ?? [];
        const places = w.notes[m.id];
        if (channels.length > 0) {
          const pick = channels.find((c) => c.channel === 'editable') ?? channels[0];
          out[`localeList:${m.id}`] = sorted(pick?.locales ?? []);
        }
        if (places && channels.length > 0) {
          const pick = channels.find((c) => c.channel === 'editable') ?? channels[0];
          const rows = noteRows({ platform: m.platform, locales: pick?.locales ?? [], drafts: {}, store: places.store, staged: places.staged });
          out[`notesFilled:${m.id}`] = rows.filter((r) => r.draft.trim() !== '').length;
          out[`notesOver:${m.id}`] = rows.filter((r) => r.over).length;
        }
      }
      return out;
    },
  },
  {
    id: 'planReadiness',
    components: ['components/release/PlanOverview.svelte'],
    mirrors: ['packages/core/src/release/release-plan.ts:118 computeReadiness (plan notes only; code points; its own limit)'],
    project(w) {
      const out: Facts = {};
      for (const m of inScope(w)) {
        const places = w.notes[m.id];
        if (!places || Object.keys(places.plan).length === 0) continue;
        const r = computeReadiness({
          items: [],
          notes: Object.keys(places.plan).map((locale) => ({ locale, text: places.plan[locale] ?? '' })),
          platform: m.platform === 'android' ? 'android' : 'ios',
        });
        out[`notesFilled:${m.id}`] = r.notes.filled;
        out[`notesOver:${m.id}`] = r.notes.tooLong.length;
      }
      return out;
    },
  },
];

/** The word a test can use to say how long the notes limit is (shown by the stepper and by the plan). */
export const NOTES_LIMIT_OF = noteLimit;

// ---------------------------------------------------------------------------------------------
// Comparing

/** A canonical text of a value (lists compare as sets). */
export const canon = (v: FactValue): string => (Array.isArray(v) ? JSON.stringify(sorted(v)) : JSON.stringify(v));

export type Disagreement = {
  scenario: string;
  factKey: string;
  domain: Domain;
  /** Every surface that shows the key, with the value it shows. */
  shown: { surface: string; value: FactValue }[];
  surfaces: string[];
  mirrors: string[];
};

/** Every fact key shown by two or more surfaces whose values differ, for one world. */
export function disagreementsOf(w: World, surfaces: readonly Surface[] = SURFACES): Disagreement[] {
  const byKey = new Map<string, { surface: Surface; value: FactValue }[]>();
  for (const s of surfaces) {
    const facts = s.project(w);
    for (const [key, value] of Object.entries(facts)) byKey.set(key, [...(byKey.get(key) ?? []), { surface: s, value }]);
  }
  const out: Disagreement[] = [];
  for (const [key, list] of [...byKey].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length < 2) continue;
    if (new Set(list.map((x) => canon(x.value))).size < 2) continue;
    const family = familyOf(key);
    out.push({
      scenario: w.name,
      factKey: key,
      domain: FACTS[family]?.domain ?? 'state',
      shown: list.map((x) => ({ surface: x.surface.id, value: x.value })),
      surfaces: list.map((x) => x.surface.id).sort(),
      mirrors: [...new Set(list.flatMap((x) => x.surface.mirrors))].sort(),
    });
  }
  return out;
}

/** The pending items of a record, as the per-app view lists them (for the report of a scenario). */
export const itemsOfRecord = pendingItemsOf;
