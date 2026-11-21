<!--
  AppSection: the screen of the open page, for the platforms in scope. The existing screens (listing, assets, reviews, builds, workflows,
  test builds, ASO, analytics, release) are mounted as they are, once per platform record where they are per platform; with several
  platforms in scope they sit under an iOS | macOS | Android tab list, one visible at a time.
  Three pages hold several old pages as views, chosen with a small segmented control (ViewSwitch) and kept in the address as `?view=`:
  Store listing (text, graphics), Insights (analytics, ASO and keywords) and Builds (builds, workflows, test builds). The old addresses
  redirect to them (lib/app-nav.ts).
  Props: api, workspaceId, role, section (a page of the left panel, or pending or settings), view (the open view of a page with views,
  '' otherwise), members (records in scope), all? (every record of the app, to tell that a macOS record's reviews are the iOS record's;
  the members when not given), openId (the id in the address), version (an open release or null), releases (by app id), now, syncRuns,
  syncing (by app id), lockedPlatforms? (platforms whose selected version is locked: listing
  and assets are read-only for them), locale? (the locale of the page header).
-->
<script lang="ts">
  import type { Platform, Role } from '@kiln/core';
  import type { Snippet } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { withHeaderParams } from '../../lib/app-header.ts';
  import { type SectionView, withView } from '../../lib/app-nav.ts';
  import type { AppSection } from '../../lib/app-scope.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { reviewsOwner } from '../../lib/reviews/reviews.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AssetsTab from '../assets/AssetsTab.svelte';
  import EasConfigCard from '../eas/EasConfigCard.svelte';
  import EasUpdateCard from '../eas/EasUpdateCard.svelte';
  import ListingMatrix from '../listing/ListingMatrix.svelte';
  import BuildsPanel from '../portfolio/BuildsPanel.svelte';
  import TestBuilds from '../builds/TestBuilds.svelte';
  import PendingChanges from '../publish/PendingChanges.svelte';
  import ProductsTab from '../products/ProductsTab.svelte';
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
  import ViewSwitch from './ViewSwitch.svelte';

  let {
    api,
    workspaceId,
    role,
    section,
    view = '',
    views = [],
    members,
    all,
    openId,
    version,
    releases,
    now,
    syncRuns,
    syncing,
    lockedPlatforms = [],
    locale = null,
    pending = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    section: AppSection;
    /** The open view of a page with views ('' for a page without). */
    view?: string | undefined;
    /** The views the person may open on this page (empty: nothing to switch). */
    views?: readonly SectionView[] | undefined;
    members: AppSummary[];
    all?: AppSummary[] | undefined;
    openId: string;
    version: string | null;
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    syncRuns: number;
    syncing: Record<string, boolean | undefined>;
    lockedPlatforms?: Platform[] | undefined;
    locale?: string | null | undefined;
    /** The pending changes as one link (the Overview puts it in the Next step card), or null. */
    pending?: { text: string; href: string } | null | undefined;
  } = $props();

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
{#snippet products(app: AppSummary)}
  <!-- The in-app purchases of an App Store Connect app are one list for the app, whatever platforms it has: read for the iOS record, like the reviews. -->
  {@const owner = reviewsOwner(app, all ?? members)}
  {#if owner}
    <Alert tone="info" title="These products are read once, for iOS">
      The in-app purchases and subscriptions of an App Store Connect app are shared by its iOS and macOS entries, so they are read and edited under iOS.
      <a href={appAddress(openId, 'products', 'ios')}>Open the iOS products</a>.
    </Alert>
  {:else}
    <ProductsTab {api} {workspaceId} {role} {app} refreshKey={syncRuns} />
  {/if}
{/snippet}
{#snippet builds(app: AppSummary)}
  <div class="stack loose">
    <BuildsPanel {api} {workspaceId} {role} {app} refreshKey={syncRuns} />
    <EasConfigCard {api} {workspaceId} {role} {app} />
    <EasUpdateCard {api} {workspaceId} {role} {app} />
  </div>
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
          idPrefix="{uid}-{section}-{view}"
        />
      </div>
      {#each members as app (app.id)}
        {@const ids = segmentIds(`${uid}-${section}-${view}`, app.platform)}
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

{#snippet switcher(current: AppSection)}
  <div class="switch"><ViewSwitch {views} value={view} hrefFor={(id) => withView(address.hash, current, id)} label="Views of this page" /></div>
{/snippet}

{#if section === 'releases' && version !== null}
  <ReleaseDetail {api} {workspaceId} {role} appId={openId} {version} />
{:else if section === 'releases'}
  <AppReleases {api} {workspaceId} {role} {members} {all} {releases} {now} {syncRuns} />
{:else if section === 'pending'}
  <div class="stack loose">
    <PendingChanges {api} {workspaceId} {role} {members} />
    <!-- Open AI suggestions of staged text (accepted here, then shown in the list above): drawn only when AI is on and one is open. Keyword ideas are accepted in Insights, not here. -->
    {#each members as m (m.id)}
      <AiSuggestions {api} {workspaceId} {role} app={m} platform={address.platform} showPlatform={members.length > 1} exceptKind="keywords" />
    {/each}
  </div>
{:else if section === 'listing'}
  {@render switcher('listing')}
  {#if view === 'graphics'}
    {@render perPlatform(assets)}
  {:else}
    <ListingMatrix
      {api}
      {workspaceId}
      {role}
      {members}
      {now}
      {syncing}
      refreshKey={syncRuns}
      {lockedPlatforms}
      {locale}
      onlocale={(next) => replaceHash(withHeaderParams(location.hash, { locale: next }))}
    />
  {/if}
{:else if section === 'products'}
  {@render perPlatform(products)}
{:else if section === 'reviews'}
  {@render perPlatform(reviews)}
{:else if section === 'builds'}
  {@render switcher('builds')}
  {#if view === 'workflows'}
    <AppWorkflows {api} {workspaceId} {role} {members} {all} />
  {:else if view === 'tests'}
    {@render perPlatform(testBuilds)}
  {:else}
    {@render perPlatform(builds)}
  {/if}
{:else if section === 'insights'}
  {@render switcher('insights')}
  {#if view === 'keywords' || view === 'terms'}
    <AsoSection {api} {workspaceId} {role} {members} {releases} {now} />
  {:else}
    <AnalyticsSection {api} {workspaceId} {role} {members} {now} />
  {/if}
{:else if section === 'settings'}
  <AppSettings {api} {workspaceId} {role} {members} {all} {now} />
{:else}
  <AppDashboard {api} {workspaceId} {role} {members} {all} {releases} {now} {syncRuns} {pending} />
{/if}

<style>
  .platform-tabs {
    justify-content: flex-start;
  }

  .switch {
    margin: 0 0 var(--space-4);
  }
</style>
