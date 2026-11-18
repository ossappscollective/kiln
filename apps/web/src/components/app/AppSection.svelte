<!--
  AppSection: the screen of the open section, for the platforms in scope. The existing screens
  (listing, assets, reviews, builds, release) are mounted as they are, once per platform record;
  with both platforms in scope they are stacked under a platform heading.
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
  import PlatformBadge from '../ui/PlatformBadge.svelte';
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
  <div class="stack loose">
    {#each members as app (app.id)}
      <section aria-label="{platformLabel(app.platform)} {section}">
        {#if members.length > 1}<h2 class="plat"><PlatformBadge platform={app.platform} tinted /></h2>{/if}
        {@render render(app)}
      </section>
    {/each}
  </div>
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
  <AppDashboard {members} {releases} {now} {canSync} {syncing} {onsync} />
{/if}

<style>
  .plat {
    margin: 0 0 var(--space-3);
    font-size: var(--text-base);
  }
</style>
