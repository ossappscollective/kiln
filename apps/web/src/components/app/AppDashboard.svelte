<!--
  AppDashboard: the Overview of an app. At the top one "Next step" card (NextStep) with ONE primary button chosen by state: the
  release that waits for you, the one in store review, or "Start release" when nothing is going on. "Needs attention" is part of that
  card (new reviews, a failed CI build, listing drift, staged changes not pushed, a pushed draft ready to be submitted, an overdue
  or blocked plan, a failed sync), so nothing is said twice. Under it, three compact platform tiles (what is live, what is in
  flight) and a collapsed "Details" (one group per platform: bundle id, latest release). The last sync sits in each platform card and the analytics line under the cards, always visible. The signals are reads of our own database that the other
  pages make too (reviews summary, builds, listing drift, staged changes, plans); a read that fails or is not allowed is left out.
  Nothing here reads a store or writes anything by itself. Sync lives in the app header's Status button, not here.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), releases (by app id),
  now, syncRuns (changes when a sync finished, so the reads run again).
  Layout (docs/design/mockups/app-overview.dc.html): "Your next step" card, the platform cards side by side (their tint, what is on the store,
  the version in flight with its status), then "Also worth a look" (the rest of the attention list, at most three lines and "Show N more").
  "Running now" lists the GitHub Actions runs of the app's repository that are going (it draws nothing when none is); see
  components/ci/RunningNow.svelte. The run "Start release" starts shows in that same list.
-->
<script lang="ts">
  import { playLiveUnconfirmed } from '../../lib/play-live.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { can, platformLabel, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { type AttentionItem, attentionItems, stagedUnpushedCount } from '../../lib/app-attention.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import type { SummaryStall } from '../../lib/release-pipeline.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { scopeRunsToApps } from '../../lib/running.ts';
  import { type StartedRun, isStartedRun } from '../../lib/start-release.ts';
  import { buildMatrix, modeCounts } from '../../lib/listing/matrix.ts';
  import { releaseFactsOf } from '../../lib/app-state/release-facts.ts';
  import { copyIdentifierLabel, identifierLabel, trackLabel } from '../../lib/portfolio.ts';
  import { stagedStore, submitStore } from '../../lib/app-state/pending-facade.ts';
  import { canSubmit } from '../../lib/store-submit.ts';
  import type { AsoSummary } from '../../lib/aso/aso.ts';
  import { listingStore } from '../../lib/app-state/listing-store.svelte.ts';
  import type { ActiveRuns, AppBuild, AppSummary, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import ReleaseStatus from '../portfolio/ReleaseStatus.svelte';
  import SyncStatus from '../portfolio/SyncStatus.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Section from '../ui/Section.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import RunningNow from '../ci/RunningNow.svelte';
  import AnalyticsStrip from '../analytics/AnalyticsStrip.svelte';
  import ExpoOverviewCard from '../eas/ExpoOverviewCard.svelte';
  import { PLANS_ENABLED } from '../../lib/features.ts';
  import AttentionList from './AttentionList.svelte';
  import NextStep from './NextStep.svelte';
  import { scopeFor } from '../../lib/app-state/derive.ts';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    releases,
    now,
    syncRuns,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[] | undefined;
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
  } = $props();

  // The release candidates of the records shown (the model's one answer; the card above reads the same): the tile of a platform with nothing in flight says what is ready.
  const modelRecords = $derived(all ?? members);
  const modelState = $derived(appStateStore.of({ workspaceId, role, records: modelRecords, scope: scopeFor(modelRecords, members), releases }));

  let newReviews = $state<Record<string, number | undefined>>({});
  let builds = $state<Record<string, AppBuild[] | undefined>>({});
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
        // The store side of the listing is the one store read: the same view the Listing page draws its grid from.
        jobs.push(listingStore.load(api, workspaceId, app.id).then(ignore));
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
      if (PLANS_ENABLED && can(role, 'plans.read')) {
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
    if (can(role, 'apps.read')) appStateStore.loadPipelineSummary(api, workspaceId);
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
        const drift = listingStore.of(workspaceId, m.id)?.drift ?? null;
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
        acc[m.id] = appStateStore.stalledApps(workspaceId, releases).filter((a) => a.app.id === m.id)[0]?.stalled ?? null;
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
      {@const facts = releaseFactsOf(list, app.platform)}
      {@const live = facts.live}
      {@const candidate = modelState.candidates.filter((c) => c.appId === app.id)[0]}
      {@const inFlight = facts.inFlight}
      <section class="card tile {app.platform}" aria-label={t('app:dash.tileLabel', { platform: platformLabel(app.platform) })}>
        <div class="tile-head">
          <PlatformBadge platform={app.platform} tinted />
          <span class="spacer"></span>
          <a href={appAddress(app.id, 'releases', null, inFlight?.version ?? null)} aria-label={t('app:dash.openReleasesFor', { platform: platformLabel(app.platform) })}>{t('app:dash.openReleases')}</a>
        </div>
        <dl class="facts">
          <div>
            <dt>{t('app:dash.onStore')}</dt>
            <dd class="big">{#if live}{live.version}{:else}<span class="muted">{app.lastSyncedAt === null ? t('app:status.notSynced') : t('app:dash.noneReported')}</span>{/if}</dd>
          </div>
          <div>
            {#if inFlight}
              <dt>{t('app:dash.version', { version: inFlight.version })}</dt>
              <dd><ReleaseStatus status={inFlight.status} rawState={inFlight.rawState} rolloutFraction={inFlight.rolloutFraction} sentForReviewAt={inFlight.sentForReviewAt} unconfirmed={playLiveUnconfirmed(inFlight)} /></dd>
            {:else if candidate}
              <dt>{t('state:candidate.ready')}</dt>
              <dd>{#if candidate.offer.enabled && candidate.offer.href}<a href={candidate.offer.href} data-testid="tile-candidate">{candidate.offer.label}</a>{:else}<span class="muted" title={candidate.offer.disabledReason ?? undefined}>{candidate.offer.label}</span>{/if}</dd>
            {:else}
              <dt>{t('app:dash.inFlight')}</dt>
              <dd class="muted">{t('app:dash.nothing')}</dd>
            {/if}
          </div>
          <div>
            <dt>{t('app:dash.lastSynced')}</dt>
            <dd><SyncStatus {app} {now} /></dd>
          </div>
        </dl>
      </section>
    {/each}
  </div>

  <ExpoOverviewCard {api} {workspaceId} {role} {members} {now} refreshKey={syncRuns} />

  <AnalyticsStrip {api} {workspaceId} {members} {now} refreshKey={syncRuns} />

  {#if rest.length > 0}
    <AttentionList title={t('app:dash.alsoWorth')} items={rest} {api} {workspaceId} {role} {members} />
  {/if}

  <Section title={t('app:dash.details')} key="details" defaultOpen={false} summary={members.map((m) => m.identifier).join(' · ')}>
    <div class="stack">
      {#each members as app (app.id)}
        {@const latest = releaseFactsOf(releases[app.id] ?? [], app.platform).latest}
        <section class="group" aria-label={t('app:dash.detailsLabel', { platform: platformLabel(app.platform) })}>
        <h3 class="group-head"><PlatformBadge platform={app.platform} tinted /></h3>
        <dl class="detail">
          <div>
            <dt>{identifierLabel(app.platform)}</dt>
            <dd class="ident">
              <code>{app.identifier}</code>
              <CopyButton value={app.identifier} iconOnly label={copyIdentifierLabel(app.platform)} />
            </dd>
          </div>
          <div>
            <dt>{t('app:dash.latestRelease')}</dt>
            <dd>
              {#if latest}
                <strong>{latest.version}</strong>
                {#if latest.track && latest.track !== 'production'}<span class="muted">{trackLabel(latest.track)}</span>{/if}
                <ReleaseStatus status={latest.status} rawState={latest.rawState} rolloutFraction={latest.rolloutFraction} sentForReviewAt={latest.sentForReviewAt} />
                <a href={appAddress(app.id, 'releases', null, latest.version)} aria-label={t('app:dash.planAndDetailsFor', { version: latest.version })}>{t('app:dash.planAndDetails')}</a>
              {:else}
                <span class="muted">{app.lastSyncedAt === null ? t('app:status.notSynced') : t('app:dash.noReleasesReported')}</span>
              {/if}
            </dd>
          </div>
        </dl>
        </section>
      {/each}
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
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-display);
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
