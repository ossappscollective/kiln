<!--
  AppSection: the screen of the open section, for the platforms in scope. The existing screens
  (listing, assets, reviews, builds, release) are mounted as they are, once per platform record;
  with both platforms in scope they sit under an iOS | Android tab list, one visible at a time.
  Props: api, workspaceId, role, section, members (records in scope), openId (the id in the
  address), version (an open release or null), releases (by app id), now, syncRuns, syncing (by app
  id), onsync.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import type { Snippet } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { AppSection } from '../../lib/app-scope.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import AssetsTab from '../assets/AssetsTab.svelte';
  import ListingMatrix from '../listing/ListingMatrix.svelte';
  import BuildsPanel from '../portfolio/BuildsPanel.svelte';
  import ReleaseDetail from '../release/ReleaseDetail.svelte';
  import ReviewsTab from '../reviews/ReviewsTab.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import AppDashboard from './AppDashboard.svelte';
  import AppReleases from './AppReleases.svelte';
  import AppSettings from './AppSettings.svelte';

  let {
    api,
    workspaceId,
    role,
    section,
    members,
    openId,
    version,
    releases,
    now,
    syncRuns,
    syncing,
    onsync,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    section: AppSection;
    members: AppSummary[];
    openId: string;
    version: string | null;
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
    syncing: Record<string, boolean | undefined>;
    onsync: (app: AppSummary) => void;
  } = $props();

  const canSync = $derived(can(role, 'apps.sync'));
  const uid = $props.id();

  // The platform shown when both are in scope. Kept while the person moves between tabs of the app.
  let platformTab = $state('');
  const activeTab = $derived(members.find((m) => m.platform === platformTab)?.platform ?? members[0]?.platform ?? '');
</script>

{#snippet assets(app: AppSummary)}
  <AssetsTab {api} {workspaceId} {role} {app} {now} refreshKey={syncRuns} />
{/snippet}
{#snippet reviews(app: AppSummary)}
  <ReviewsTab {api} {workspaceId} {role} {app} {now} refreshKey={syncRuns} />
{/snippet}
{#snippet builds(app: AppSummary)}
  <BuildsPanel {api} {workspaceId} {role} {app} refreshKey={syncRuns} />
{/snippet}

{#snippet perPlatform(render: Snippet<[AppSummary]>)}
  {#if members.length > 1}
    <!-- Both platforms: one tab per platform instead of two full copies stacked. Both stay mounted (the inactive one is hidden), so nothing is read twice. -->
    <div class="stack">
      <div class="row platform-tabs">
        <SegmentTabs
          tabs={members.map((m) => ({ id: m.platform, label: platformLabel(m.platform) }))}
          bind:value={platformTab}
          label="Platform"
          idPrefix="{uid}-{section}"
        />
      </div>
      {#each members as app (app.id)}
        {@const ids = segmentIds(`${uid}-${section}`, app.platform)}
        <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} hidden={activeTab !== app.platform}>
          {@render render(app)}
        </div>
      {/each}
    </div>
  {:else}
    {#each members as app (app.id)}
      <section aria-label="{platformLabel(app.platform)} {section}">
        {@render render(app)}
      </section>
    {/each}
  {/if}
{/snippet}

{#if section === 'releases' && version !== null}
  <ReleaseDetail {api} {workspaceId} {role} appId={openId} {version} />
{:else if section === 'releases'}
  <AppReleases {api} {workspaceId} {role} {members} {releases} {now} {canSync} {syncing} {onsync} {syncRuns} />
{:else if section === 'listing'}
  <ListingMatrix {api} {workspaceId} {role} {members} {now} {syncing} {onsync} refreshKey={syncRuns} />
{:else if section === 'assets'}
  {@render perPlatform(assets)}
{:else if section === 'reviews'}
  {@render perPlatform(reviews)}
{:else if section === 'builds'}
  {@render perPlatform(builds)}
{:else if section === 'settings'}
  <AppSettings {api} {workspaceId} {role} {members} {now} />
{:else}
  <AppDashboard {api} {workspaceId} {role} {members} {releases} {now} {canSync} {syncing} {onsync} {syncRuns} />
{/if}

<style>
  .platform-tabs {
    justify-content: flex-start;
  }
</style>
