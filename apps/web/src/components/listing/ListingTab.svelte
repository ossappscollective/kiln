<!--
  ListingTab: the store listing of an app, compared three ways per locale and field: the repository,
  what this tool last knew, and the live store. Read-only toward the store: "Refresh from store" runs
  the app's sync, which only reads. Nothing on this tab pushes, submits or changes a store.
  Props: api, workspaceId, role, app, now (ms), syncing (a sync is running), onrefresh (runs the
  sync; the parent owns it), refreshKey (changes when a sync finished, so this tab reloads).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    DRIFT_ORDER,
    defaultFilter,
    driftSummaryText,
    filterLocales,
    isEmptyDrift,
    localeName,
    localeSummary,
    shortRef,
    statusLabel,
    type DriftFilter,
  } from '../../lib/listing-drift.ts';
  import { describeError, storeName } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, DriftField, ListingDrift } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import FieldCompare from './FieldCompare.svelte';
  import HistoryDrawer from './HistoryDrawer.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    now,
    syncing,
    onrefresh,
    refreshKey,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    now: number;
    syncing: boolean;
    onrefresh: () => void;
    refreshKey: number;
  } = $props();

  const canSync = $derived(can(role, 'apps.sync'));
  const canReadRepo = $derived(can(role, 'repositories.scan') && app.repositoryId !== null);

  let drift = $state<ListingDrift | null>(null);
  let loading = $state(true);
  let reloading = $state(false);
  let loadProblem = $state('');
  let filter = $state<DriftFilter>(defaultFilter());
  let repoReading = $state(false);
  let repoProblem = $state('');
  let announcement = $state('');

  let historyOpen = $state(false);
  let historyTarget = $state<{
    locale: string;
    field: string;
    label: string;
    limit: number | null;
    unit: 'characters' | 'bytes';
  } | null>(null);

  let generation = 0;

  async function load() {
    const mine = ++generation;
    if (drift === null) loading = true;
    else reloading = true;
    loadProblem = '';
    try {
      const next = await api.appListingDrift(workspaceId, app.id);
      if (mine !== generation) return;
      drift = next;
      announcement = `Listing compared: ${driftSummaryText(next)}.`;
    } catch (e) {
      if (mine !== generation) return;
      loadProblem = describeError(e, 'load');
    } finally {
      if (mine === generation) {
        loading = false;
        reloading = false;
      }
    }
  }

  /** The app this tab last showed, so a finished sync reloads without clearing the view. */
  let shownFor = '';

  // A different app or workspace starts clean; a different app, workspace or finished sync loads.
  $effect(() => {
    void refreshKey;
    const key = `${workspaceId}/${app.id}`;
    if (key !== shownFor) {
      shownFor = key;
      drift = null;
      filter = defaultFilter();
      repoProblem = '';
      historyOpen = false;
    }
    // `load` reads state it also writes; only the keys above should re-run this.
    untrack(() => void load());
  });

  async function readRepository() {
    if (repoReading) return;
    repoReading = true;
    repoProblem = '';
    try {
      const result = await api.refreshAppRepoListing(workspaceId, app.id);
      if (!result.found) {
        toast.warning('The repository has no store listing for this app. Check the listing settings of the repository.');
      } else {
        const ref = shortRef('repo', result.ref);
        toast.success(
          `Read the repository listing${ref ? ` at ${ref}` : ''}: ${result.changed} changed, ${result.removed} removed, ${result.unchanged} unchanged.`,
        );
      }
      await load();
    } catch (e) {
      repoProblem = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
      toast.error(repoProblem);
    } finally {
      repoReading = false;
    }
  }

  function openHistory(field: DriftField) {
    historyTarget = { locale: field.locale, field: field.field, label: field.label, limit: field.limit, unit: field.unit };
    historyOpen = true;
  }

  const visible = $derived(drift ? filterLocales(drift.locales, filter) : []);
  const filtering = $derived(filter.status !== 'all' || filter.query.trim() !== '');
  const storeLabel = $derived(drift?.channel === 'editable' ? 'Editable version' : 'Live store');
  const statusOptions = $derived(
    drift
      ? [
          { value: 'all', label: 'All fields' },
          { value: 'differing', label: 'Only differing' },
          ...DRIFT_ORDER.map((s) => ({ value: s, label: `${statusLabel(s)} (${drift?.summary[s] ?? 0})` })),
        ]
      : [],
  );
</script>

<div class="stack loose listing" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  <div class="intro">
    <p class="muted">
      Compares each listing field of {storeName(app.platform)} between the repository, what this tool last
      knew, and the live store. This view only reads: it never changes the store. To change a listing, make a
      change set on the repository.
    </p>
    <div class="row wrap">
      {#if canSync}
        <Button variant="primary" icon="refresh" loading={syncing} onclick={onrefresh}>{syncing ? 'Reading…' : 'Refresh from store'}</Button>
      {/if}
      {#if canReadRepo}
        <Button icon="git-branch" loading={repoReading} onclick={readRepository}>{repoReading ? 'Reading…' : 'Read repository'}</Button>
      {/if}
    </div>
  </div>

  {#if repoProblem}
    <Alert tone="error" title="Could not read the repository" ondismiss={() => (repoProblem = '')}>{repoProblem}</Alert>
  {/if}

  {#if loading && !drift}
    <div role="status" aria-label="Loading the listing" class="stack">
      <Skeleton width="50%" height="16px" />
      <div class="card"><div class="stack"><Skeleton width="30%" height="16px" /><Skeleton width="100%" height="64px" /></div></div>
    </div>
  {:else if loadProblem && !drift}
    <div class="stack">
      <Alert tone="error" title="Could not load the listing">{loadProblem}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if drift}
    {#if loadProblem}
      <Alert tone="error" title="Could not update the comparison">{loadProblem} The values below are from before.</Alert>
    {/if}

    <dl class="sources">
      <div>
        <dt>{storeName(app.platform)}</dt>
        <dd>
          {#if drift.store.readAt !== null}
            read <time datetime={new Date(drift.store.readAt).toISOString()} title={fullTime(drift.store.readAt)}>{timeAgo(drift.store.readAt, now)}</time>
            {#if drift.channel === 'editable'}<span class="muted"> · shows the editable version: no version is live yet</span>{/if}
          {:else}
            <span class="muted">not read yet</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt>Repository</dt>
        <dd>
          {#if app.repositoryId === null}
            <span class="muted">not linked to this app</span>
          {:else if drift.repo.readAt !== null}
            read <time datetime={new Date(drift.repo.readAt).toISOString()} title={fullTime(drift.repo.readAt)}>{timeAgo(drift.repo.readAt, now)}</time>
            {#if drift.repo.ref}<span class="muted"> · at <code>{shortRef('repo', drift.repo.ref)}</code></span>{/if}
          {:else}
            <span class="muted">not read yet</span>
          {/if}
        </dd>
      </div>
    </dl>

    {#if drift.store.error}
      <Alert tone="warn" title="The last read of the store listing failed">
        <p class="alert-text">{drift.store.error}</p>
        <p class="alert-text">The values in the store column are from the last successful read. The release sync is not affected.</p>
      </Alert>
    {/if}
    {#if drift.repo.error && app.repositoryId !== null}
      <Alert tone="warn" title="The last read of the repository listing failed">
        <p class="alert-text">{drift.repo.error}</p>
      </Alert>
    {/if}

    {#if isEmptyDrift(drift)}
      <div class="card">
        <EmptyState
          icon="file-text"
          title="No listing values yet"
          description={drift.store.readAt === null
            ? 'The listing is read when the app is synced. Refresh from the store to read the name, description and the other fields.'
            : 'The store and the repository have no listing values to compare. A new app may not have a listing yet.'}
        >
          {#snippet actions()}
            {#if canSync}
              <Button variant="primary" icon="refresh" loading={syncing} onclick={onrefresh}>Refresh from store</Button>
            {:else}
              <span class="muted">A member or admin can refresh the listing.</span>
            {/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="toolbar">
        <p class="summary" aria-live="polite">{driftSummaryText(drift)}{reloading ? ' · updating…' : ''}</p>
        <div class="filters">
          <label class="visually-hidden" for="listing-status-{app.id}">Show</label>
          <select id="listing-status-{app.id}" bind:value={filter.status}>
            {#each statusOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <label class="visually-hidden" for="listing-query-{app.id}">Search the listing</label>
          <input id="listing-query-{app.id}" type="search" placeholder="Search locale or text" bind:value={filter.query} />
        </div>
      </div>

      {#if visible.length === 0}
        <div class="card">
          <EmptyState icon="search" title="No fields match" description="Change the filter or the search to see more.">
            {#snippet actions()}
              {#if filtering}<Button onclick={() => (filter = defaultFilter())}>Clear the filter</Button>{/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        {#each visible as locale (locale.locale)}
          <section class="card flush locale" aria-label="Locale {locale.locale}">
            <header>
              <h3>{locale.locale}</h3>
              <span class="muted">{localeName(locale.locale) === locale.locale ? '' : `${localeName(locale.locale)} · `}{localeSummary(locale)}</span>
            </header>
            {#each locale.fields as field (field.field)}
              <FieldCompare {field} {storeLabel} {now} onhistory={openHistory} />
            {/each}
          </section>
        {/each}
        <p class="muted legend">
          <Icon name="info" size={14} /> In a differing field, words only in the store are struck through and words only in the repository are underlined.
        </p>
      {/if}
    {/if}
  {/if}
</div>

<HistoryDrawer bind:open={historyOpen} {api} {workspaceId} appId={app.id} target={historyTarget} {now} />

<style>
  .intro {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-6);
    align-items: center;
    justify-content: space-between;
  }

  .intro p {
    flex: 1 1 320px;
    max-width: 62ch;
    margin: 0;
    font-size: var(--text-sm);
  }

  .alert-text {
    margin: var(--space-1) 0 0;
  }

  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-8);
    margin: 0;
    font-size: var(--text-sm);
  }

  .sources dt {
    display: inline;
    font-weight: var(--weight-semibold);
  }

  .sources dt::after {
    content: ': ';
  }

  .sources dd {
    display: inline;
    margin: 0;
  }

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
    gap: var(--space-2);
  }

  .filters select {
    min-width: 12rem;
  }

  .filters input {
    min-width: 14rem;
  }

  .locale > header {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: baseline;
    padding: var(--space-3) var(--space-4);
  }

  .locale h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .legend {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
