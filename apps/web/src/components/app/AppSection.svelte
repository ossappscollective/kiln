<!--
  AppSection: the screen of the open section, for the platforms in scope. The existing screens
  (listing, assets, reviews, builds, release) are mounted as they are, once per platform record;
  with several platforms in scope they sit under an iOS | macOS | Android tab list, one visible at a time.
  Props: api, workspaceId, role, section, members (records in scope), all? (every record of the app, to
  tell that a macOS record's reviews are the iOS record's; the members when not given), openId (the id in the
  address), version (an open release or null), releases (by app id), now, syncRuns, syncing (by app
  id), onsync, lockedPlatforms? (platforms whose selected version is locked: listing and assets are read-only for
  them), locale? (the locale of the page header).
-->
<script lang="ts">
  import { type Platform, type Role, can } from '@mrm/core';
  import type { Snippet } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { withHeaderParams } from '../../lib/app-header.ts';
  import type { AppSection } from '../../lib/app-scope.ts';
  import { appAddress, appWorkflowsHref } from '../../lib/app-scope.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { reviewsOwner } from '../../lib/reviews.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import AssetsTab from '../assets/AssetsTab.svelte';
  import ListingMatrix from '../listing/ListingMatrix.svelte';
  import BuildsPanel from '../portfolio/BuildsPanel.svelte';
  import TestBuilds from '../builds/TestBuilds.svelte';
  import PendingChanges from '../publish/PendingChanges.svelte';
  import ReleaseDetail from '../release/ReleaseDetail.svelte';
  import ReviewsTab from '../reviews/ReviewsTab.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import AsoSection from '../aso/AsoSection.svelte';
  import AnalyticsSection from '../analytics/AnalyticsSection.svelte';
  import AppDashboard from './AppDashboard.svelte';
  import AppReleases from './AppReleases.svelte';
  import AppWorkflows from './AppWorkflows.svelte';
  import AppSettings from './AppSettings.svelte';

  let {
    api,
    workspaceId,
    role,
    section,
    members,
    all,
    openId,
    version,
    releases,
    now,
    syncRuns,
    syncing,
    onsync,
    lockedPlatforms = [],
    locale = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    section: AppSection;
    members: AppSummary[];
    all?: AppSummary[];
    openId: string;
    version: string | null;
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
    syncing: Record<string, boolean | undefined>;
    onsync: (app: AppSummary) => void;
    lockedPlatforms?: Platform[];
    locale?: string | null;
  } = $props();

  const canSync = $derived(can(role, 'apps.sync'));
  const uid = $props.id();

  // The platform shown when both are in scope. Kept while the person moves between tabs of the app.
  let platformTab = $state('');
  const activeTab = $derived(members.find((m) => m.platform === platformTab)?.platform ?? members[0]?.platform ?? '');
</script>

{#snippet assets(app: AppSummary)}
  <AssetsTab {api} {workspaceId} {role} {app} {now} refreshKey={syncRuns} locked={lockedPlatforms.indexOf(app.platform) >= 0} {locale} />
{/snippet}
{#snippet reviews(app: AppSummary)}
  {@const owner = reviewsOwner(app, all ?? members)}
  {#if owner}
    <Alert tone="info" title="These reviews are read once, for iOS">
      The customer reviews of an App Store Connect app are shared by its iOS and macOS entries, so they are kept and triaged under iOS.
      <a href={appAddress(openId, 'reviews', 'ios')}>Open the iOS reviews</a>.
    </Alert>
  {:else}
    <ReviewsTab {api} {workspaceId} {role} {app} {now} refreshKey={syncRuns} />
  {/if}
{/snippet}
{#snippet builds(app: AppSummary)}
  <BuildsPanel {api} {workspaceId} {role} {app} refreshKey={syncRuns} />
{/snippet}
{#snippet testBuilds(app: AppSummary)}
  <TestBuilds {api} {workspaceId} {role} {app} refreshKey={syncRuns} />
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
  <AppReleases {api} {workspaceId} {role} {members} {all} {releases} {now} {canSync} {syncing} {onsync} {syncRuns} />
{:else if section === 'pending'}
  <div class="stack loose">
    <PendingChanges {api} {workspaceId} {role} {members} />
    <!-- Open AI suggestions (a staged-text proposal is accepted here, then shows in the list above): drawn only when AI is on and one is open. -->
    {#each members as m (m.id)}
      <AiSuggestions {api} {workspaceId} {role} app={m} platform={address.platform} showPlatform={members.length > 1} />
    {/each}
  </div>
{:else if section === 'listing'}
  <ListingMatrix
    {api}
    {workspaceId}
    {role}
    {members}
    {now}
    {syncing}
    {onsync}
    refreshKey={syncRuns}
    {lockedPlatforms}
    {locale}
    onlocale={(next) => replaceHash(withHeaderParams(location.hash, { locale: next }))}
  />
{:else if section === 'assets'}
  {@render perPlatform(assets)}
{:else if section === 'reviews'}
  {@render perPlatform(reviews)}
{:else if section === 'workflows'}
  <AppWorkflows {api} {workspaceId} {role} {members} {all} />
{:else if section === 'builds'}
  <div class="row workflows-link">
    <Button href={appWorkflowsHref(openId, address.platform)} icon="play" size="sm">Workflows</Button>
    <span class="muted text-sm">Run the GitHub workflows that make these builds, and follow them.</span>
  </div>
  {@render perPlatform(builds)}
{:else if section === 'test-builds'}
  {@render perPlatform(testBuilds)}
{:else if section === 'aso'}
  <AsoSection {api} {workspaceId} {role} {members} {releases} {now} />
{:else if section === 'analytics'}
  <AnalyticsSection {api} {workspaceId} {role} {members} {now} />
{:else if section === 'settings'}
  <AppSettings {api} {workspaceId} {role} {members} {all} {now} />
{:else}
  <AppDashboard {api} {workspaceId} {role} {members} {all} {releases} {now} {canSync} {syncing} {onsync} {syncRuns} />
{/if}

<style>
  .platform-tabs {
    justify-content: flex-start;
  }

  .workflows-link {
    margin: 0 0 var(--space-3);
  }
</style>
