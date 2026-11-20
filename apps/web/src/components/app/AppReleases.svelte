<!--
  AppReleases: the releases tab of an app: a compact table of the releases the store reports for the
  platforms in scope, grouped by version (version, platform, build, status, rollout share, date, CI
  state, plan state), each row opening to its store and plan detail. The default view is what matters
  now (the newest release of each platform, what is live, in progress or planned); the rest is under a
  collapsed "Older releases" with a search. Below it, the "Rollout controls" section (a slim line while
  rollout changes are switched off).
  The plans and the builds are extras: when they cannot be loaded the table still shows the store's
  releases, with the plan and CI cells reading "—".
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), releases (by app id), now,
  syncRuns (changes when a sync finished, so plans and builds reload). Sync lives in the app header's Status button.
  Above the table one "Next step" card (NextStep) with ONE primary button chosen by state: the release that waits for you, the one
  in store review, or "Start release" (opens the dispatch dialog on the app's release workflow, follows the run it started) when nothing
  is going on; the five steps of a release on its way are inside it. Preparing a release by hand ("Prepare without CI", or "Prepare
  release" without a linked repository) opens the stepper (components/release/stepper) in place of the list; the step is kept in the
  address (`&step=`), so the "Release left unfinished" item and a reload land on it.
  The platform scope for links comes from the address.
-->
<script lang="ts">
  import { can, type Role, supports } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { promoteFromHash, withoutPromote } from '../../lib/play-promote.ts';
  import { type StepId, stepFromHash, withStep } from '../../lib/release-stepper.ts';
  import {
    buildReleaseTable,
    defaultReleaseFilter,
    filterGroups,
    splitCurrent,
    type ReleaseFilter,
  } from '../../lib/releases-table.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppBuild, AppSummary, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import { PLANS_ENABLED } from '../../lib/features.ts';
  import ReleaseTable from '../release/ReleaseTable.svelte';
  import NextStep from './NextStep.svelte';
  import ReleaseStepper from '../release/stepper/ReleaseStepper.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import RolloutControls from '../release/RolloutControls.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

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
    all?: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
  } = $props();

  const canReadPlans = $derived(PLANS_ENABLED && can(role, 'plans.read'));

  let plans = $state<Record<string, PlanSummary[] | undefined>>({});
  let plansOk = $state(false);
  let builds = $state<Record<string, AppBuild[] | undefined>>({});
  let filter = $state<ReleaseFilter>(defaultReleaseFilter());
  let generation = 0;

  async function loadExtras(list: AppSummary[]) {
    const mine = ++generation;
    const nextPlans: Record<string, PlanSummary[]> = {};
    const nextBuilds: Record<string, AppBuild[]> = {};
    let allPlans = canReadPlans;
    await Promise.all(
      list.map(async (app) => {
        if (canReadPlans) {
          try {
            nextPlans[app.id] = (await api.appPlans(workspaceId, app.id)).plans;
          } catch {
            allPlans = false;
          }
        }
        try {
          nextBuilds[app.id] = (await api.appBuilds(workspaceId, app.id)).builds;
        } catch {
          // No CI data for this app: its CI cells read "—".
        }
      }),
    );
    if (mine !== generation) return;
    plans = nextPlans;
    plansOk = allPlans;
    builds = nextBuilds;
  }

  // Another app, scope or workspace starts clean; a finished sync loads again. A string key, so a
  // refreshed record (a new object) does not reload.
  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  let shownFor = '';
  $effect(() => {
    void syncRuns;
    const next = key;
    untrack(() => {
      if (next !== shownFor) {
        shownFor = next;
        plans = {};
        plansOk = false;
        builds = {};
        filter = defaultReleaseFilter();
      }
      void loadExtras(members);
    });
  });

  const groups = $derived(
    buildReleaseTable({
      releases,
      plans: plansOk ? plans : null,
      builds,
      appIds: members.map((m) => m.id),
    }),
  );
  // What matters now is the default view; the rest is under "Older releases". The "not live yet" switch
  // applies to both; the search only to the older ones, so the short list stays short.
  const notLive = $derived(filterGroups(groups, { query: '', inProgressOnly: filter.inProgressOnly }));
  const split = $derived(splitCurrent(notLive));
  const olderShown = $derived(filterGroups(split.older, { query: filter.query, inProgressOnly: false }));
  const olderShownCount = $derived(olderShown.reduce((n, g) => n + g.rows.length, 0));
  const visible = $derived(split.current);
  const apps = $derived(
    members.reduce<Record<string, AppSummary | undefined>>((acc, m) => {
      acc[m.id] = m;
      return acc;
    }, {}),
  );
  const empty = $derived(members.filter((m) => (releases[m.id] ?? []).length === 0));
  const filtering = $derived(filter.query.trim() !== '' || filter.inProgressOnly);
  const searching = $derived(filter.query.trim() !== '');
  const scope = $derived(address.platform);

  // "Prepare release": the stepper of the address (`&step=`). While it is open it replaces the table, so the page has one job.
  const canPrepare = $derived(can(role, 'listing.read'));
  const step = $derived<StepId | null>(canPrepare ? stepFromHash(address.hash) : null);
  const uid = $props.id();
  let stepperPlatform = $state('');
  const stepperTab = $derived(members.find((m) => m.platform === stepperPlatform)?.platform ?? members[0]?.platform ?? '');
  // "Promote to production" opens the first step with the track, the codes and the target in the address.
  const promote = $derived(canPrepare && step !== null ? promoteFromHash(address.hash) : null);
  const openStepper = () => replaceHash(withStep(withoutPromote(location.hash), 'build'));
  const closeStepper = () => replaceHash(withStep(withoutPromote(location.hash), null));
  const moveStep = (next: StepId) => replaceHash(withStep(location.hash, next));
</script>

<div class="stack loose">
  {#if step === null}
    <NextStep {api} {workspaceId} {role} {members} {all} {scope} {releases} refreshKey={syncRuns} onprepare={canPrepare ? openStepper : undefined} showRunning />
  {/if}

  {#if step !== null}
    <div class="stack">
      {#if members.length > 1}
        <div class="row">
          <SegmentTabs tabs={members.map((m) => ({ id: m.platform, label: platformLabel(m.platform) }))} bind:value={stepperPlatform} label="Platform" idPrefix="{uid}-prepare" />
        </div>
      {/if}
      {#each members as app (app.id)}
        {@const ids = segmentIds(`${uid}-prepare`, app.platform)}
        <div role={members.length > 1 ? 'tabpanel' : undefined} id={members.length > 1 ? ids.panel : undefined} aria-labelledby={members.length > 1 ? ids.tab : undefined} hidden={members.length > 1 && stepperTab !== app.platform}>
          <ReleaseStepper
            {api}
            {workspaceId}
            {role}
            {app}
            scope={scope}
            appBuilds={builds[app.id] ?? []}
            {releases}
            {step}
            promote={supports(app.platform, 'releaseTracks') ? promote : null}
            onstep={moveStep}
            onclose={closeStepper}
            showPlatform={members.length > 1}
          />
        </div>
      {/each}
    </div>
  {/if}

  {#if step !== null}
    <!-- the steps replace the list while they are open -->
  {:else if groups.length === 0}
    <div class="stack">
      {#each members as app (app.id)}
        <div class="card">
          <EmptyState
            icon="box"
            title={app.lastSyncedAt === null ? `Not synced yet${members.length > 1 ? `: ${platformLabel(app.platform)}` : ''}` : `No releases reported${members.length > 1 ? `: ${platformLabel(app.platform)}` : ''}`}
            description={app.lastSyncedAt === null
              ? 'Adding an app does not contact the store. Open Status in the header and choose Sync now to read its versions and tracks.'
              : 'The last sync found no versions or tracks for this app.'}
          >
          </EmptyState>
        </div>
      {/each}
    </div>
  {:else}
    <Section title="Current and in progress" key="current" variant="plain" count={split.currentCount}>
      {#snippet actions()}
        <div class="filters">
          <label class="check">
            <input type="checkbox" bind:checked={filter.inProgressOnly} />
            <span>Not live yet</span>
          </label>
          <InfoTip label="About this list" align="end">
            <p>
              Shown here: the newest release of each platform, what is live now, what is not live yet{PLANS_ENABLED ? ', and what has a plan' : ''}.
              Everything else is under Older releases.
            </p>
            <p>
              This is a snapshot of the store, not a history. Each sync replaces it, and a version the store no longer reports
              disappears.
            </p>
          </InfoTip>
        </div>
      {/snippet}
      <div class="stack">
      {#if empty.length > 0}
        <p class="muted note">
          {empty.map((m) => platformLabel(m.platform)).join(' and ')}: no releases reported by the last sync.
        </p>
      {/if}

      {#if visible.length === 0}
        <div class="card">
          <EmptyState icon="check-circle" title="Nothing in progress" description="No release matches the filter. The older releases are below.">
            {#snippet actions()}
              {#if filter.inProgressOnly}<Button onclick={() => (filter = defaultReleaseFilter())}>Clear the filter</Button>{/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        <ReleaseTable {api} {workspaceId} {role} groups={visible} {apps} {builds} {now} {scope} showPlatform={members.length > 1} />
      {/if}
      </div>
    </Section>

    {#if split.olderCount > 0}
      <Section title="Older releases" key="older" count={split.olderCount} defaultOpen={false} summary={searching ? `${olderShownCount} match${olderShownCount === 1 ? '' : 'es'}` : 'newest first'}>
        <div class="stack">
          <div class="older-tools">
            <label class="visually-hidden" for="releases-query">Search older releases</label>
            <input id="releases-query" type="search" placeholder="Search version, build or state" bind:value={filter.query} />
            {#if searching}<Button size="sm" variant="ghost" onclick={() => (filter = { ...filter, query: '' })}>Clear the search</Button>{/if}
          </div>
          {#if olderShown.length === 0}
            <p class="muted note">No older release matches the search.</p>
          {:else}
            <ReleaseTable {api} {workspaceId} {role} groups={olderShown} {apps} {builds} {now} {scope} showPlatform={members.length > 1} />
          {/if}
        </div>
      </Section>
    {/if}
  {/if}

  {#if step === null}<RolloutControls {api} {workspaceId} {role} {members} {releases} />{/if}
</div>

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .filters {
    gap: var(--space-2);
  }

  .older-tools {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .older-tools input[type='search'] {
    width: 18rem;
    min-height: var(--control-sm);
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
