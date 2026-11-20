<!--
  AppDashboard: the Overview of an app. At the top one "Next step" card (NextStep) with ONE primary button chosen by state: the
  release that waits for you, the one in store review, or "Start release" when nothing is going on. "Needs attention" is part of that
  card (new reviews, a failed CI build, listing drift, staged changes not pushed, a pushed draft ready to be submitted, an overdue
  or blocked plan, a failed sync), so nothing is said twice. Under it, three compact platform tiles (what is live, what is in
  flight) and a collapsed "Details" (one group per platform: bundle id, latest release, last sync; then analytics). The signals are reads of our own database that the other
  pages make too (reviews summary, builds, listing drift, staged changes, plans); a read that fails or is not allowed is left out.
  Nothing here reads a store or writes anything by itself. Sync lives in the app header's Status button, not here.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), releases (by app id),
  now, syncRuns (changes when a sync finished, so the reads run again), pending? (the changes waiting as one link for the Next step card).
  Layout (docs/design/mockups/app-overview.dc.html): "Your next step" card, the platform cards side by side (their tint, what is on the store,
  the version in flight with its status), then "Also worth a look" (the rest of the attention list, at most three lines and "Show N more").
  "Running now" lists the GitHub Actions runs of the app's repository that are going (it draws nothing when none is); see
  components/ci/RunningNow.svelte. The run "Start release" starts shows in that same list.
-->
<script lang="ts">
  import { type Role, can, platformLabel } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { type AttentionItem, attentionItems, stagedUnpushedCount } from '../../lib/app-attention.ts';
  import { pipelineStore } from '../../lib/pipeline-store.svelte.ts';
  import type { SummaryStall } from '../../lib/release-pipeline.ts';
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
  import CopyButton from '../ui/CopyButton.svelte';
  import Section from '../ui/Section.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import RunningNow from '../ci/RunningNow.svelte';
  import AnalyticsStrip from '../analytics/AnalyticsStrip.svelte';
  import AttentionList from './AttentionList.svelte';
  import NextStep from './NextStep.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    releases,
    now,
    syncRuns,
    pending = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
    pending?: { text: string; href: string } | null;
  } = $props();

  let newReviews = $state<Record<string, number | undefined>>({});
  let builds = $state<Record<string, AppBuild[] | undefined>>({});
  let drifts = $state<Record<string, ListingDrift | undefined>>({});
  let plans = $state<Record<string, PlanSummary[] | undefined>>({});
  let asoSummaries = $state<Record<string, AsoSummary | undefined>>({});
  let generation = 0;

  // The run started from "Start release": it is shown in "Running now" even when the app's tied runs hide it,
  // and its answers go back to the Next step card so it can look for the build.
  let nextStep = $state<{ observe: (data: ActiveRuns) => void }>();
  let startedRun = $state<StartedRun | null>(null);
  /** What is left of "Needs attention" after the Next step card took its one thing: drawn as "Also worth a look". */
  let rest = $state<AttentionItem[]>([]);

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
    if (can(role, 'apps.read')) void pipelineStore.loadSummary(api, workspaceId);
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
      unfinished: members.reduce<Record<string, SummaryStall | null>>((acc, m) => {
        acc[m.id] = pipelineStore.summary(workspaceId)?.apps.filter((a) => a.app.id === m.id)[0]?.stalled ?? null;
        return acc;
      }, {}),
      submitReady: members.reduce<Record<string, boolean>>((acc, m) => {
        const s = canSubmit(role) ? submitStore.state(m.id) : null;
        acc[m.id] = s !== null && (s.pushed || s.unknownOutcome.submit);
        return acc;
      }, {}),
    }),
  );
</script>

<div class="stack loose">
  <NextStep
    bind:this={nextStep}
    {api}
    {workspaceId}
    {role}
    {members}
    {all}
    scope={address.platform}
    attention={items}
    {releases}
    refreshKey={syncRuns}
    onstarted={(s) => (startedRun = s)}
    {pending}
    onitems={(list) => (rest = list)}
  />

  {#if showRunning}
    <RunningNow
      {api}
      {workspaceId}
      {repositoryIds}
      apps={members}
      stateKey="ci.running.recent.app"
      ondata={(d) => nextStep?.observe(d)}
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

  <div class="tiles">
    {#each members as app (app.id)}
      {@const list = releases[app.id] ?? []}
      {@const latest = latestRelease(list, app.platform)}
      {@const live = liveRelease(list, app.platform)}
      {@const inFlight = latest && (!live || latest.version !== live.version || latest.status !== 'live') ? latest : null}
      <section class="card tile {app.platform}" aria-label="{platformLabel(app.platform)} summary">
        <div class="tile-head">
          <PlatformBadge platform={app.platform} tinted />
          <span class="spacer"></span>
          <a href={appAddress(app.id, 'releases', null, inFlight?.version ?? null)}>Open releases<span class="visually-hidden"> for {platformLabel(app.platform)}</span></a>
        </div>
        <dl class="facts">
          <div>
            <dt>On the store</dt>
            <dd class="big">{#if live}{live.version}{:else}<span class="muted">{app.lastSyncedAt === null ? 'Not synced yet' : 'None reported'}</span>{/if}</dd>
          </div>
          <div>
            {#if inFlight}
              <dt>Version {inFlight.version}</dt>
              <dd><ReleaseStatus status={inFlight.status} rawState={inFlight.rawState} rolloutFraction={inFlight.rolloutFraction} sentForReviewAt={inFlight.sentForReviewAt} /></dd>
            {:else}
              <dt>In flight</dt>
              <dd class="muted">Nothing</dd>
            {/if}
          </div>
        </dl>
      </section>
    {/each}
  </div>

  {#if rest.length > 0}
    <AttentionList title="Also worth a look" items={rest} {api} {workspaceId} {role} {members} />
  {/if}

  <Section title="Details" key="details" defaultOpen={false} summary={members.map((m) => m.identifier).join(' · ')}>
    <div class="stack">
      {#each members as app (app.id)}
        {@const latest = latestRelease(releases[app.id] ?? [], app.platform)}
        <section class="group" aria-label="{platformLabel(app.platform)} details">
        <h3 class="group-head"><PlatformBadge platform={app.platform} tinted /></h3>
        <dl class="detail">
          <div>
            <dt>{app.platform === 'android' ? 'Package name' : 'Bundle ID'}</dt>
            <dd class="ident">
              <code>{app.identifier}</code>
              <CopyButton value={app.identifier} iconOnly label="Copy the {app.platform === 'android' ? 'package name' : 'bundle ID'}" />
            </dd>
          </div>
          <div>
            <dt>Latest release</dt>
            <dd>
              {#if latest}
                <strong>{latest.version}</strong>
                {#if latest.track && latest.track !== 'production'}<span class="muted">{trackLabel(latest.track)}</span>{/if}
                <ReleaseStatus status={latest.status} rawState={latest.rawState} rolloutFraction={latest.rolloutFraction} sentForReviewAt={latest.sentForReviewAt} />
                <a href={appAddress(app.id, 'releases', null, latest.version)}>Plan and details<span class="visually-hidden"> for version {latest.version}</span></a>
              {:else}
                <span class="muted">{app.lastSyncedAt === null ? 'Not synced yet' : 'No releases reported'}</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd><SyncStatus {app} {now} /></dd>
          </div>
        </dl>
        </section>
      {/each}
      <AnalyticsStrip {api} {workspaceId} {members} {now} refreshKey={syncRuns} />
    </div>
  </Section>
</div>

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: var(--space-4);
    align-items: stretch;
  }

  /* Each platform card carries its tint on the left edge, as in the mockup; the name and the glyph carry the meaning too. */
  .tile {
    --tint: var(--line-strong);

    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-left: 6px solid var(--tint);
    border-radius: var(--radius-xl);
  }

  .tile.ios {
    --tint: color-mix(in srgb, var(--platform-ios-ink) 55%, var(--platform-ios-bg));
  }

  .tile.macos {
    --tint: color-mix(in srgb, var(--platform-macos-ink) 55%, var(--platform-macos-bg));
  }

  .tile.android {
    --tint: color-mix(in srgb, var(--platform-android-ink) 55%, var(--platform-android-bg));
  }

  .tile-head {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-8);
    width: 100%;
    margin: 0;
  }

  .big {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
  }

  .facts dt,
  .detail dt {
    margin-bottom: 2px;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd,
  .detail dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .latest {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  /* The details of each platform are one group with its own heading. */
  .group {
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .group-head {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
  }

  .detail {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-3) var(--space-4);
    margin: 0;
  }

  /* The bundle id wraps, so a narrow window never cuts it off. */
  .ident {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .ident code {
    overflow-wrap: anywhere;
    word-break: break-all;
  }
</style>
