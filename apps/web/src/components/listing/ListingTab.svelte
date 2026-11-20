<!--
  ListingTab: the store listing of an app, compared three ways per locale and field: the repository,
  what this tool last knew, and the live store. Read-only toward the store: "Refresh from store" runs
  the app's sync, which only reads. Nothing on this tab pushes, submits or changes a store.
  Props: api, workspaceId, role, app, now (ms), syncing (a sync is running), onrefresh (runs the
  sync; the parent owns it), refreshKey (changes when a sync finished, so this tab reloads).

  Below the texts it shows the sections beyond them (categories, age rating, privacy choices URL,
  app details, screenshot and preview counts; Google Play: image counts and release notes), the
  connector's warnings and the state of the scheduled read. Those are read-only and never part of
  "Pull into repository" (that copies text fields only).

  The one thing it can write is a draft: "Pull into repository" copies the store text of fields
  where the store is ahead (or the two diverged) into the repository's listing files as a draft
  change set. The draft is reviewed and applied (as a pull request or a commit on a new branch of the local clone) in the repository's Change sets tab.
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
  } from '../../lib/listing/drift.ts';
  import {
    canPullField,
    pullDisabledReason,
    pullKey,
    pullableFields,
    pullableInLocale,
    selectedFields,
    summarizePull,
    toggleAllDifferences,
    toggleKey,
  } from '../../lib/listing/pull.ts';
  import {
    cleanWarnings,
    lastAttemptText,
    scheduleView,
  } from '../../lib/listing/sections.ts';
  import { describeError, storeName } from '../../lib/portfolio.ts';
  import { requestChangeSetReview, reviewHref } from '../../lib/repository-intent.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, DriftField, DriftLocale, ListingDrift, LiveListing, PullResult } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import FieldCompare from './FieldCompare.svelte';
  import HistoryDrawer from './HistoryDrawer.svelte';
  import ListingSections from './ListingSections.svelte';
  import PullDialog from './PullDialog.svelte';
  import PullResultSummary from './PullResultSummary.svelte';

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
  // The warnings and the scheduled read come from the live view. They are extras: a failure to load
  // them never hides the comparison.
  let live = $state<LiveListing | null>(null);
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

  let selected = $state<Set<string>>(new Set());
  let pullOpen = $state(false);
  let pullFieldsList = $state<DriftField[]>([]);
  let lastPull = $state<PullResult | null>(null);

  let generation = 0;

  async function load() {
    const mine = ++generation;
    if (drift === null) loading = true;
    else reloading = true;
    loadProblem = '';
    try {
      const [next, nextLive] = await Promise.all([
        api.appListingDrift(workspaceId, app.id),
        api.appListingLive(workspaceId, app.id).catch(() => null),
      ]);
      if (mine !== generation) return;
      drift = next;
      if (nextLive !== null) live = nextLive;
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
      live = null;
      filter = defaultFilter();
      repoProblem = '';
      historyOpen = false;
      selected = new Set();
      pullOpen = false;
      lastPull = null;
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

  const pullReason = $derived(
    pullDisabledReason({ role, repositoryId: app.repositoryId, storeRead: drift !== null && drift.store.readAt !== null }),
  );
  const pullable = $derived(drift ? pullableFields(drift.locales) : []);
  // A reload can change a row; only rows that can still be pulled count as selected.
  const picked = $derived(drift ? selectedFields(drift.locales, selected) : []);
  const allPicked = $derived(pullable.length > 0 && picked.length === pullable.length);

  const labelOf = (field: string): string => {
    for (const locale of drift?.locales ?? []) {
      const found = locale.fields.find((f) => f.field === field);
      if (found) return found.label;
    }
    return field;
  };

  function openPull(fields: DriftField[]) {
    if (pullReason !== null || fields.length === 0) return;
    pullFieldsList = fields;
    pullOpen = true;
  }

  const pullLocale = (locale: DriftLocale) => openPull(pullableInLocale(locale));

  function pulled(result: PullResult) {
    lastPull = result;
    const summary = summarizePull(result);
    if (result.changeSet === null) {
      toast.info(summary.headline);
      return;
    }
    const changeSetId = result.changeSet.id;
    const repositoryId = result.target.repositoryId;
    const options = {
      action: {
        label: 'Review the draft',
        href: reviewHref,
        onclick: () => requestChangeSetReview({ repositoryId, changeSetId }),
      },
    };
    if (summary.tone === 'warn') toast.warning(summary.headline, options);
    else toast.success(summary.headline, options);
    selected = new Set();
  }

  const visible = $derived(drift ? filterLocales(drift.locales, filter) : []);
  const filtering = $derived(filter.status !== 'all' || filter.query.trim() !== '');
  const storeLabel = $derived(drift?.channel === 'editable' ? 'Editable version' : 'Live store');
  const schedule = $derived(scheduleView(live?.schedule, now));
  const warnings = $derived(cleanWarnings(live?.warnings));
  const lastAttempt = $derived(lastAttemptText(live?.schedule, now));
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
      {#if live}
        <div>
          <dt>Scheduled read</dt>
          <dd>
            {schedule.headline}
            <span class="muted"> · {schedule.detail}{lastAttempt ? ` Last attempt ${lastAttempt}.` : ''}</span>
          </dd>
        </div>
      {/if}
    </dl>

    {#if drift.store.error}
      <Alert tone="warn" title="The last read of the store listing failed">
        <p class="alert-text">{drift.store.error}</p>
        <p class="alert-text">The values in the store column are from the last successful read. The release sync is not affected.</p>
      </Alert>
    {/if}
    {#if warnings.length > 0}
      <Alert tone="warn" title="The store read had warnings">
        <ul class="alert-list">
          {#each warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
        </ul>
        <p class="alert-text">Parts of the listing that could not be read are left out, not shown as empty.</p>
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

      {#if lastPull}
        <PullResultSummary
          result={lastPull}
          {labelOf}
          onreview={(r) => r.changeSet && requestChangeSetReview({ repositoryId: r.target.repositoryId, changeSetId: r.changeSet.id })}
          ondismiss={() => (lastPull = null)}
        />
      {/if}

      <div class="pullbar" aria-label="Pull into the repository">
        {#if pullReason !== null}
          <p class="muted pullnote"><Icon name="info" size={14} /> Pulling into the repository is not available. {pullReason}</p>
        {:else if pullable.length === 0}
          <p class="muted pullnote"><Icon name="check" size={14} /> No differences to pull: the repository already has the store's text, or is ahead of it.</p>
        {:else}
          <p class="pullnote">
            {pullable.length} {pullable.length === 1 ? 'field differs' : 'fields differ'} where the store can be pulled into the repository.
          </p>
          <div class="row wrap">
            <label class="check">
              <input
                type="checkbox"
                checked={allPicked}
                onchange={() => (selected = toggleAllDifferences(drift?.locales ?? [], selected))}
              />
              <span>Select all differences</span>
            </label>
            <Button variant="primary" icon="git-pull-request" disabled={picked.length === 0} onclick={() => openPull(picked)}>
              Pull selected into repository…{picked.length > 0 ? ` (${picked.length})` : ''}
            </Button>
          </div>
        {/if}
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
              {#if pullableInLocale(locale).length > 0}
                <span class="locale-pull">
                  <Button size="sm" icon="git-pull-request" disabled={pullReason !== null} onclick={() => pullLocale(locale)}>
                    Pull {locale.locale} into repository ({pullableInLocale(locale).length})
                  </Button>
                </span>
              {/if}
            </header>
            {#each locale.fields as field (field.field)}
              <FieldCompare
                {field}
                {storeLabel}
                {now}
                onhistory={openHistory}
                pullable={canPullField(field)}
                pullDisabled={pullReason}
                selected={selected.has(pullKey(field))}
                onselect={(f, on) => (selected = on ? new Set(selected).add(pullKey(f)) : toggleKey(selected, pullKey(f)))}
                onpull={(f) => openPull([f])}
              />
            {/each}
          </section>
        {/each}
        <p class="muted legend">
          <Icon name="info" size={14} /> In a differing field, words only in the store are struck through and words only in the repository are underlined.
        </p>
      {/if}
    {/if}

    {#if drift.sections && drift.sections.length > 0}
      <ListingSections
        sections={drift.sections}
        platform={drift.platform}
        {now}
        storeReadAt={drift.store.readAt}
        repositoryLinked={app.repositoryId !== null}
      />
    {/if}
  {/if}
</div>

<PullDialog
  bind:open={pullOpen}
  {api}
  {workspaceId}
  {role}
  {app}
  fields={pullFieldsList}
  channel={drift?.channel ?? null}
  onpulled={pulled}
/>

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

  .alert-list {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-5);
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

  .pullbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .pullnote {
    display: flex;
    flex: 1 1 280px;
    gap: var(--space-1);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  .locale-pull {
    margin-left: auto;
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
