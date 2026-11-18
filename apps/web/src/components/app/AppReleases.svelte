<!--
  AppReleases: the releases tab of an app: a compact table of the releases the store reports for the
  platforms in scope, grouped by version (version, platform, build, status, rollout share, date, CI
  state, plan state), each row opening to its store and plan detail. Below it, a visible but
  disabled "Rollout controls" section (store writes are not built yet).
  The plans and the builds are extras: when they cannot be loaded the table still shows the store's
  releases, with the plan and CI cells reading "—".
  Props: api, workspaceId, role, members (the records in scope), releases (by app id), now, canSync,
  syncing (by app id), onsync, syncRuns (changes when a sync finished, so plans and builds reload).
  The platform scope for links comes from the address.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import {
    buildReleaseTable,
    defaultReleaseFilter,
    filterGroups,
    tableSummary,
    type ReleaseFilter,
  } from '../../lib/releases-table.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppBuild, AppSummary, PlanSummary, ReleaseSummary } from '../../lib/types.ts';
  import ReleaseTable from '../release/ReleaseTable.svelte';
  import RolloutControls from '../release/RolloutControls.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
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
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    canSync: boolean;
    syncing: Record<string, boolean | undefined>;
    onsync: (app: AppSummary) => void;
    syncRuns: number;
  } = $props();

  const canReadPlans = $derived(can(role, 'plans.read'));

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
  const visible = $derived(filterGroups(groups, filter));
  const apps = $derived(
    members.reduce<Record<string, AppSummary | undefined>>((acc, m) => {
      acc[m.id] = m;
      return acc;
    }, {}),
  );
  const empty = $derived(members.filter((m) => (releases[m.id] ?? []).length === 0));
  const filtering = $derived(filter.query.trim() !== '' || filter.inProgressOnly);
  const scope = $derived(address.platform);
</script>

<div class="stack loose">
  {#if groups.length === 0}
    <div class="stack">
      {#each members as app (app.id)}
        <div class="card">
          <EmptyState
            icon="box"
            title={app.lastSyncedAt === null ? `Not synced yet${members.length > 1 ? `: ${platformLabel(app.platform)}` : ''}` : `No releases reported${members.length > 1 ? `: ${platformLabel(app.platform)}` : ''}`}
            description={app.lastSyncedAt === null
              ? 'Adding an app does not contact the store. A sync reads its versions and tracks.'
              : 'The last sync found no versions or tracks for this app.'}
          >
            {#snippet actions()}
              {#if canSync}
                <Button variant="primary" icon="refresh" loading={syncing[app.id] === true} onclick={() => onsync(app)}>Sync now</Button>
              {:else}
                <span class="muted">A member or admin can run the first sync.</span>
              {/if}
            {/snippet}
          </EmptyState>
        </div>
      {/each}
    </div>
  {:else}
    <div class="toolbar">
      <p class="summary" aria-live="polite">{tableSummary(visible)}</p>
      <div class="filters">
        <label class="check">
          <input type="checkbox" bind:checked={filter.inProgressOnly} />
          <span>Not live yet</span>
        </label>
        <label class="visually-hidden" for="releases-query">Search releases</label>
        <input id="releases-query" type="search" placeholder="Search version, build or state" bind:value={filter.query} />
      </div>
    </div>

    {#if empty.length > 0}
      <p class="muted note">
        {empty.map((m) => platformLabel(m.platform)).join(' and ')}: no releases reported by the last sync.
      </p>
    {/if}

    {#if visible.length === 0}
      <div class="card">
        <EmptyState icon="search" title="No releases match" description="Change the filter or the search to see more.">
          {#snippet actions()}
            {#if filtering}<Button onclick={() => (filter = defaultReleaseFilter())}>Clear the filter</Button>{/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <ReleaseTable {api} {workspaceId} {role} groups={visible} {apps} {builds} {now} {scope} showPlatform={members.length > 1} />
    {/if}
  {/if}

  <p class="muted note snapshot">
    This is a snapshot of the store, not a history. Each sync replaces it, and a version the store no longer reports disappears.
  </p>

  <RolloutControls />
</div>

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .summary {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .filters input[type='search'] {
    min-width: 14rem;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
