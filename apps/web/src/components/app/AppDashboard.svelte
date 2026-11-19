<!--
  AppDashboard: the first screen of an app, in two columns. On the left, one compact card per platform
  in scope: the latest release, what is live and the state of the last sync. On the right, "Needs
  attention": new reviews, a failed CI build, listing drift, staged changes not pushed, a pushed draft
  that is ready to be submitted (admin and up; the button opens a preview first), an overdue or
  blocked plan, a failed sync. It is built from reads of our own database that the other tabs make too
  (reviews summary, builds, listing drift, staged changes, plans); a read that fails or is not allowed
  is left out, and a kind of item with nothing to show is not drawn. With nothing to flag, the cards use
  the whole width. Nothing here reads a store or writes anything by itself: the submit button only opens a dialog,
  whose preview reads the store and whose confirmation is the one write.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), releases (by app id), now, canSync,
  syncing (by app id), onsync, syncRuns (changes when a sync finished, so the reads run again).
  Above the cards, "Running now" lists the GitHub Actions runs of the app's repository that are going
  (it draws nothing when none is); see components/ci/RunningNow.svelte. Above it, "Start release"
  (StartRelease): the run it starts shows in that same list, and "Prepare release" appears when its build does.
-->
<script lang="ts">
  import { type Role, can, platformLabel } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { attentionItems, stagedUnpushedCount } from '../../lib/app-attention.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { scopeRunsToApps } from '../../lib/running.ts';
  import { type StartedRun, isStartedRun } from '../../lib/start-release.ts';
  import { buildMatrix, modeCounts } from '../../lib/listing-matrix.ts';
  import { latestRelease, liveRelease, trackLabel } from '../../lib/portfolio.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import { submitStore } from '../../lib/store-submit-store.svelte.ts';
  import type { AsoSummary } from '../../lib/aso.ts';
  import type { ActiveRuns, AppBuild, AppSummary, ListingDrift, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import ReleaseStatus from '../portfolio/ReleaseStatus.svelte';
  import SyncStatus from '../portfolio/SyncStatus.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import RunningNow from '../ci/RunningNow.svelte';
  import AttentionList from './AttentionList.svelte';
  import StartRelease from './StartRelease.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    releases,
    now,
    canSync,
    syncing,
    onsync,
    syncRuns,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    canSync: boolean;
    syncing: Record<string, boolean | undefined>;
    onsync: (app: AppSummary) => void;
    syncRuns: number;
  } = $props();

  let newReviews = $state<Record<string, number | undefined>>({});
  let builds = $state<Record<string, AppBuild[] | undefined>>({});
  let drifts = $state<Record<string, ListingDrift | undefined>>({});
  let plans = $state<Record<string, PlanSummary[] | undefined>>({});
  let asoSummaries = $state<Record<string, AsoSummary | undefined>>({});
  let generation = 0;

  // The run started from "Start release": it is shown in "Running now" even when the app's tied runs hide it,
  // and its answers go back to StartRelease so it can look for the build.
  let startRelease = $state<{ observe: (data: ActiveRuns) => void }>();
  let startedRun = $state<StartedRun | null>(null);

  // Running now: the runs of the repositories of this app. They are tied to the app when started for it
  // or when they are its release workflow (the build conventions); otherwise the repository's are shown.
  const repositoryIds = $derived([...new Set(members.map((m) => m.repositoryId).filter((id): id is string => id !== null))]);
  let releaseWorkflows = $state<Record<string, string | null>>({});
  let conventionsGeneration = 0;
  const showRunning = $derived(can(role, 'repositories.read') && repositoryIds.length > 0);

  $effect(() => {
    if (!showRunning) return;
    const list = members.filter((m) => m.repositoryId !== null);
    const mine = ++conventionsGeneration;
    for (const app of list) {
      api
        .buildConventions(workspaceId, app.repositoryId as string, app.id)
        .then((view) => {
          if (mine === conventionsGeneration) releaseWorkflows[app.id] = view.effective.workflow ?? null;
        })
        .catch(() => undefined);
    }
  });

  async function loadSignals(list: AppSummary[]) {
    const mine = ++generation;
    const reads = list.map(async (app) => {
      const jobs: Promise<void>[] = [];
      const ignore = (_: unknown) => undefined;
      if (can(role, 'reviews.read')) {
        jobs.push(
          api
            .appReviewsSummary(workspaceId, app.id)
            .then((s) => {
              if (mine === generation) newReviews[app.id] = s.byStatus.new;
            })
            .catch(ignore),
        );
      }
      jobs.push(
        api
          .appBuilds(workspaceId, app.id)
          .then((b) => {
            if (mine === generation) builds[app.id] = b.builds;
          })
          .catch(ignore),
      );
      if (can(role, 'listing.read')) {
        jobs.push(
          api
            .appListingDrift(workspaceId, app.id)
            .then((d) => {
              if (mine === generation) drifts[app.id] = d;
            })
            .catch(ignore),
        );
        jobs.push(stagedStore.load(api, workspaceId, app.id).then(ignore));
      }
      if (canSubmit(role)) {
        // Whether a pushed draft waits to be submitted (our own database) and the server's switch. Reads only.
        jobs.push(submitStore.load(api, workspaceId, app.id).then(ignore));
        jobs.push(submitStore.loadConfig(api, workspaceId));
      }
      if (can(role, 'aso.read')) {
        // One summary per app record, our own database: big rank drops and competitor changes for "Needs attention".
        jobs.push(
          api
            .asoSummary(workspaceId, app.id)
            .then((s) => {
              if (mine === generation) asoSummaries[app.id] = s;
            })
            .catch(ignore),
        );
      }
      if (can(role, 'plans.read')) {
        jobs.push(
          api
            .appPlans(workspaceId, app.id)
            .then((p) => {
              if (mine === generation) plans[app.id] = p.plans;
            })
            .catch(ignore),
        );
      }
      await Promise.all(jobs);
    });
    await Promise.all(reads);
  }

  // Another app or scope starts clean; a finished sync reads again. A string key, so a refreshed
  // record (a new object) does not.
  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  let shownFor = '';
  $effect(() => {
    void syncRuns;
    const next = key;
    untrack(() => {
      if (next !== shownFor) {
        shownFor = next;
        newReviews = {};
        builds = {};
        drifts = {};
        plans = {};
        asoSummaries = {};
      }
      void loadSignals(members);
    });
  });

  const items = $derived(
    attentionItems({
      apps: members.map((m) => ({ id: m.id, platform: m.platform, lastSyncError: m.lastSyncError })),
      scope: address.platform,
      newReviews,
      builds,
      driftLocales: members.reduce<Record<string, number>>((acc, m) => {
        const drift = drifts[m.id];
        acc[m.id] = drift ? modeCounts(buildMatrix([{ platform: m.platform, drift }]).rows).differing : 0;
        return acc;
      }, {}),
      stagedUnpushed: members.reduce<Record<string, number>>((acc, m) => {
        acc[m.id] = stagedUnpushedCount(stagedStore.view(m.id));
        return acc;
      }, {}),
      plans,
      aso: asoSummaries,
      submitReady: members.reduce<Record<string, boolean>>((acc, m) => {
        const s = canSubmit(role) ? submitStore.state(m.id) : null;
        acc[m.id] = s !== null && (s.pushed || s.unknownOutcome.submit);
        return acc;
      }, {}),
    }),
  );
</script>

<div class="start-row"><StartRelease bind:this={startRelease} {api} {workspaceId} {role} {members} {all} scopeIsBoth={members.length > 1} showRunning={false} onstarted={(s) => (startedRun = s)} /></div>

{#if showRunning}
  <RunningNow
    {api}
    {workspaceId}
    {repositoryIds}
    apps={members}
    stateKey="ci.running.recent.app"
    ondata={(d) => startRelease?.observe(d)}
    scope={(runs) => {
      const base = scopeRunsToApps(
        runs,
        members.map((m) => ({ id: m.id, repositoryId: m.repositoryId, workflow: releaseWorkflows[m.id] ?? null })),
      );
      const started = startedRun;
      const extra = started ? runs.filter((r) => isStartedRun(r, started) && base.runs.indexOf(r) < 0) : [];
      return extra.length > 0 ? { ...base, runs: [...base.runs, ...extra] } : base;
    }}
  />
{/if}

<div class="layout" class:split={items.length > 0}>
  <div class="cards">
    {#each members as app (app.id)}
      {@const list = releases[app.id] ?? []}
      {@const latest = latestRelease(list, app.platform)}
      {@const live = liveRelease(list, app.platform)}
      <section class="card" aria-label="{platformLabel(app.platform)} summary">
        <div class="row between">
          <div class="row ident">
            <PlatformBadge platform={app.platform} tinted />
            <code>{app.identifier}</code>
            <CopyButton value={app.identifier} iconOnly label="Copy the {app.platform === 'android' ? 'package name' : 'bundle ID'}" />
          </div>
          {#if canSync}
            <Button size="sm" icon="refresh" loading={syncing[app.id] === true} onclick={() => onsync(app)}>Sync</Button>
          {/if}
        </div>
        <dl class="facts">
          <div class="wide">
            <dt>Latest release</dt>
            <dd>
              {#if latest}
                <span class="latest">
                  <strong>{latest.version}</strong>
                  {#if latest.track && latest.track !== 'production'}<span class="muted">{trackLabel(latest.track)}</span>{/if}
                  <ReleaseStatus status={latest.status} rawState={latest.rawState} rolloutFraction={latest.rolloutFraction} />
                  <a href={appAddress(app.id, 'releases', null, latest.version)}>Plan and details<span class="visually-hidden"> for version {latest.version}</span></a>
                </span>
              {:else}
                <span class="muted">{app.lastSyncedAt === null ? 'Not synced yet' : 'No releases reported'}</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Live now</dt>
            <dd>{#if live}<strong>{live.version}</strong>{:else}<span class="muted">None reported</span>{/if}</dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd><SyncStatus {app} {now} /></dd>
          </div>
        </dl>
      </section>
    {/each}
  </div>

  {#if items.length > 0}
    <aside aria-label="Needs attention"><AttentionList {items} {api} {workspaceId} {role} {members} /></aside>
  {/if}
</div>

<style>
  .start-row:has(:global(.head)) {
    margin-bottom: var(--space-4);
  }

  .layout {
    display: grid;
    gap: var(--space-4);
    align-items: start;
  }

  .layout.split {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: var(--space-4);
    align-items: start;
  }

  .card {
    padding: var(--space-4);
  }

  .ident {
    min-width: 0;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3) var(--space-4);
    margin: var(--space-3) 0 0;
  }

  .facts .wide {
    grid-column: 1 / -1;
  }

  .facts dt {
    margin-bottom: 2px;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .latest {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  @media (max-width: 960px) {
    .layout.split {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
