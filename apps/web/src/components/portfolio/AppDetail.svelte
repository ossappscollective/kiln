<!--
  AppDetail: one app: when it was synced, its releases grouped by platform and track with their
  place in the lifecycle, a Sync action and (admins) delete.
  Props: api, workspaceId, role, id (the app id from the route).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    appErrorMessage,
    appLabel,
    describeError,
    groupReleases,
    latestRelease,
    platformLabel,
    portfolioHref,
    storeName,
    syncApp,
    syncSummaryText,
  } from '../../lib/portfolio.ts';
  import { releaseHref } from '../../lib/release.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import AssetsTab from '../assets/AssetsTab.svelte';
  import ListingTab from '../listing/ListingTab.svelte';
  import ReviewsTab from '../reviews/ReviewsTab.svelte';
  import BuildsPanel from './BuildsPanel.svelte';
  import PlatformBadge from './PlatformBadge.svelte';
  import ReleaseGroupCard from './ReleaseGroupCard.svelte';
  import ReleaseStatus from './ReleaseStatus.svelte';

  let { api, workspaceId, role, id }: { api: Api; workspaceId: string; role: Role; id: string } = $props();

  const canSync = $derived(can(role, 'apps.sync'));
  const canWrite = $derived(can(role, 'apps.write'));

  let app = $state<AppSummary | null>(null);
  let releases = $state<ReleaseSummary[]>([]);
  let loading = $state(true);
  /** `notFound` has its own message and no retry. */
  let loadError = $state<{ message: string; notFound: boolean } | null>(null);
  let syncing = $state(false);
  /** What the latest sync from this screen said went wrong. Cleared by the next success. */
  let syncProblem = $state('');
  let announcement = $state('');
  let now = $state(Date.now());
  /** The open section: the releases, the store listing (read-only), builds or customer reviews (read-only). */
  let tab = $state('releases');
  /** Counts finished syncs, so the listing tab reloads after one. */
  let syncRuns = $state(0);

  let confirmOpen = $state(false);
  let deleting = $state(false);
  let deleteProblem = $state('');

  /** Ignores a late answer for an app that is no longer open. */
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    loadError = null;
    try {
      const detail = await api.app(workspaceId, id);
      if (mine !== generation) return;
      app = detail.app;
      releases = detail.releases;
      announcement = `Opened ${appLabel(detail.app)}.`;
    } catch (e) {
      if (mine !== generation) return;
      app = null;
      releases = [];
      loadError = {
        message: describeError(e, 'load'),
        notFound: e instanceof ApiError && e.status === 404,
      };
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void workspaceId;
    void id;
    app = null;
    releases = [];
    syncProblem = '';
    syncing = false;
    confirmOpen = false;
    tab = 'releases';
    void load();
  });

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  async function sync() {
    if (!app || syncing) return;
    const target = app;
    const mine = generation;
    syncing = true;
    syncProblem = '';
    const outcome = await syncApp(api, workspaceId, target.id);
    // The person went to another app meanwhile; this screen belongs to that one now.
    if (mine !== generation) return;
    syncing = false;
    now = Date.now();
    syncRuns += 1;
    if (outcome.ok) {
      app = outcome.app;
      releases = outcome.releases;
      const text = syncSummaryText(appLabel(outcome.app), outcome.sync);
      toast.success(text);
      announcement = text;
    } else {
      // A failed sync is stored on the app, so the server sends the app back with the new message.
      if (outcome.app) app = outcome.app;
      syncProblem = outcome.failure.message;
      toast.error(`${appLabel(target)}: ${outcome.failure.message}`);
    }
  }

  async function remove() {
    if (!app) return;
    const target = app;
    deleting = true;
    deleteProblem = '';
    try {
      await api.deleteApp(workspaceId, target.id);
      confirmOpen = false;
      toast.success(`Deleted ${appLabel(target)}. Nothing in the store was changed.`);
      location.hash = portfolioHref;
    } catch (e) {
      deleteProblem = e instanceof ApiError ? appErrorMessage(e, 'delete') : describeError(e, 'delete');
    } finally {
      deleting = false;
    }
  }

  const groups = $derived(groupReleases(releases));
  const latest = $derived(app ? latestRelease(releases, app.platform) : null);
  const failure = $derived(syncProblem || app?.lastSyncError?.trim() || '');
  /** Builds are readable by everyone who can read the app; the listing has its own right. */
  const sections = $derived([
    { id: 'releases', label: 'Releases' },
    ...(can(role, 'listing.read') ? [{ id: 'listing', label: 'Listing' }, { id: 'assets', label: 'Assets' }] : []),
    { id: 'builds', label: 'Builds' },
    ...(can(role, 'reviews.read') ? [{ id: 'reviews', label: 'Reviews' }] : []),
  ]);
</script>

<section aria-busy={loading}>
  <p class="back">
    <a href={portfolioHref}><Icon name="chevron-left" size={16} /> Portfolio</a>
  </p>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if loading && !app}
    <div role="status" aria-label="Loading the app">
      <div class="skeleton-head">
        <Skeleton width="240px" height="28px" />
        <Skeleton width="160px" height="16px" />
      </div>
      <div class="card"><div class="stack"><Skeleton width="60%" height="16px" /><Skeleton width="40%" height="16px" /></div></div>
    </div>
  {:else if loadError}
    {#if loadError.notFound}
      <div class="card">
        <EmptyState icon="box" title="App not found" description="This app is not in this workspace. It may have been deleted.">
          {#snippet actions()}
            <Button href={portfolioHref} variant="primary">Back to the portfolio</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="stack">
        <Alert tone="error" title="Could not load the app">{loadError.message}</Alert>
        <div class="row">
          <Button icon="refresh" onclick={load}>Try again</Button>
          <Button href={portfolioHref} variant="ghost">Back to the portfolio</Button>
        </div>
      </div>
    {/if}
  {:else if app}
    <div class="app-head">
      <AppIcon name={app.name} url={app.iconUrl} platform={app.platform} seed={app.id} size="xl" />
      <div class="app-head-main">
    <PageHeader title={app.name} description="{platformLabel(app.platform)} · {storeName(app.platform)} · {app.identifier}">
      {#snippet actions()}
        {#if canSync}
          <Button variant="primary" icon="refresh" loading={syncing} onclick={sync}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
        {/if}
        {#if canWrite}
          <Button variant="danger" icon="trash" disabled={syncing} onclick={() => { deleteProblem = ''; confirmOpen = true; }}>Delete app</Button>
        {/if}
      {/snippet}
    </PageHeader>
      </div>
    </div>

    <div class="stack loose">
      {#if failure}
        <Alert tone="error" title="The last sync failed">
          <p class="alert-text">{failure}</p>
          <p class="alert-text">
            {#if app.lastSyncedAt !== null}
              The releases below are from the last successful sync, {timeAgo(app.lastSyncedAt, now)}.
            {:else}
              No sync has succeeded yet, so there are no releases to show.
            {/if}
          </p>
        </Alert>
      {/if}

      <section class="card" aria-label="About this app">
        <dl class="facts">
          <div>
            <dt>Platform</dt>
            <dd><PlatformBadge platform={app.platform} /></dd>
          </div>
          <div>
            <dt>{app.platform === 'android' ? 'Package name' : 'Bundle ID'}</dt>
            <dd class="row"><code>{app.identifier}</code><CopyButton value={app.identifier} iconOnly label="Copy the identifier" /></dd>
          </div>
          <div>
            <dt>Latest release</dt>
            <dd>
              {#if latest}
                <span class="latest"><strong>{latest.version}</strong> <ReleaseStatus status={latest.status} rawState={latest.rawState} rolloutFraction={latest.rolloutFraction} sentForReviewAt={latest.sentForReviewAt} /> <a href={releaseHref(app.id, latest.version)}>Plan and details<span class="visually-hidden"> for version {latest.version}</span></a></span>
              {:else}
                <span class="muted">None yet</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>
              {#if app.lastSyncedAt !== null}
                <time datetime={new Date(app.lastSyncedAt).toISOString()} title={fullTime(app.lastSyncedAt)}>{timeAgo(app.lastSyncedAt, now)}</time>
              {:else}
                <span class="muted">Never</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd>
              <time datetime={new Date(app.createdAt).toISOString()} title={fullTime(app.createdAt)}>{timeAgo(app.createdAt, now)}</time>
            </dd>
          </div>
        </dl>
      </section>

      {#snippet releasesView(current: AppSummary)}
        {#if groups.length === 0}
          <div class="card">
            <EmptyState
              icon="box"
              title={current.lastSyncedAt === null ? 'Not synced yet' : 'No releases reported'}
              description={current.lastSyncedAt === null
                ? 'Adding an app does not contact the store. A sync reads its versions and tracks.'
                : 'The last sync found no versions or tracks for this app.'}
            >
              {#snippet actions()}
                {#if canSync}
                  <Button variant="primary" icon="refresh" loading={syncing} onclick={sync}>Sync now</Button>
                {:else}
                  <span class="muted">A member or admin can run the first sync.</span>
                {/if}
              {/snippet}
            </EmptyState>
          </div>
        {:else}
          {#each groups as group (group.key)}
            <ReleaseGroupCard {group} {now} />
          {/each}
          <p class="muted snapshot">
            This is a snapshot of the store, not a history. Each sync replaces it, and a version the store no longer reports disappears.
          </p>
        {/if}
      {/snippet}

      {#if can(role, 'apps.read')}
        <Tabs bind:value={tab} label="Sections of this app" tabs={sections}>
          {#snippet panel(id)}
            {#if app && id === 'listing'}
              <ListingTab {api} {workspaceId} {role} {app} {now} {syncing} onrefresh={sync} refreshKey={syncRuns} />
            {:else if app && id === 'assets'}
              <AssetsTab {api} {workspaceId} {role} {app} {now} refreshKey={syncRuns} />
            {:else if app && id === 'reviews'}
              <ReviewsTab {api} {workspaceId} {role} {app} {now} refreshKey={syncRuns} />
            {:else if app && id === 'builds'}
              <BuildsPanel {api} {workspaceId} {role} {app} refreshKey={syncRuns} />
            {:else if app}
              <div class="stack loose">{@render releasesView(app)}</div>
            {/if}
          {/snippet}
        </Tabs>
      {:else}
        {@render releasesView(app)}
      {/if}
    </div>
  {/if}
</section>

{#if canWrite}
  <Modal bind:open={confirmOpen} size="sm" title="Delete this app?" dismissible={!deleting}>
    {#if app}
      <div class="stack">
        <p>
          <strong>{app.name}</strong> ({platformLabel(app.platform)}, {app.identifier}) and its stored releases will be removed from this workspace.
        </p>
        <p class="muted">Nothing in {storeName(app.platform)} is changed. You can add the app again later.</p>
        {#if deleteProblem}<Alert tone="error">{deleteProblem}</Alert>{/if}
      </div>
    {/if}
    {#snippet footer()}
      <Button disabled={deleting} onclick={() => (confirmOpen = false)}>Cancel</Button>
      <Button variant="danger-solid" loading={deleting} onclick={remove}>Delete app</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .app-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
  }
  .app-head-main {
    flex: 1;
    min-width: 0;
  }
  .back {
    margin: 0 0 var(--space-3);
  }

  .back a {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .skeleton-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-6);
  }

  .alert-text {
    margin: var(--space-1) 0 0;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-4) var(--space-6);
    margin: 0;
  }

  .facts dt {
    margin-bottom: var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .latest {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .snapshot {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
