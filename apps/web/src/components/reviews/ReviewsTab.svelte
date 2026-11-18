<!--
  ReviewsTab: the customer reviews and ratings of an app, with internal triage and replies. "Read
  reviews now" only reads. Replying is a public store write: it is off unless the server turns it on
  (MRM_REVIEW_REPLY_ENABLED), needs an admin to send, and goes through ReplyDialog (draft, confirm).
  Props: api, workspaceId, role, app, now (ms), refreshKey (changes when the app was synced, so this
  tab reloads).

  Review text is written by customers and is shown as plain text only. It never goes into a URL.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    appendPage,
    defaultFilters,
    filtersToQuery,
    hasActiveFilters,
    lastReadText,
    replaceReview,
    reviewErrorMessage,
    sinceChoices,
    sinceFor,
    sortLabels,
    statusLabel,
    statusOrder,
    storeLabel,
    syncNotices,
    syncSummaryText,
    territoryName,
    toggleIn,
    type Review,
    type ReviewFilters,
    type ReviewSort,
    type ReviewStatus,
    type ReviewsSummary,
  } from '../../lib/reviews.ts';
  import { REPLY_OFF_TEXT, type ReplyConfig } from '../../lib/review-reply.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, Member } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import RatingOverview from './RatingOverview.svelte';
  import ReviewCard from './ReviewCard.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    now,
    refreshKey,
  }: { api: Api; workspaceId: string; role: Role; app: AppSummary; now: number; refreshKey: number } = $props();

  const PAGE = 25;
  const uid = $props.id();

  const canSync = $derived(can(role, 'reviews.sync'));
  const canTriage = $derived(can(role, 'reviews.triage'));

  let summary = $state<ReviewsSummary | null>(null);
  let reviews = $state<Review[]>([]);
  let nextCursor = $state<string | null>(null);
  let members = $state<Member[]>([]);
  /** The server's reply settings; null until known (the reply row waits for it). */
  let replyConfig = $state<ReplyConfig | null>(null);
  let loading = $state(true);
  let listLoading = $state(false);
  let moreLoading = $state(false);
  let loadProblem = $state('');
  let listProblem = $state('');
  let syncing = $state(false);
  let syncProblem = $state('');
  let announcement = $state('');

  let filters = $state<ReviewFilters>(defaultFilters());
  let sinceChoice = $state('all');
  let searchText = $state('');

  /** Ignore a late answer for another app, or for filters that have changed since. */
  let generation = 0;
  let listGeneration = 0;

  const notices = $derived(summary ? syncNotices(summary.sync, now, (at) => timeAgo(at, now)) : []);
  const active = $derived(hasActiveFilters(filters));
  const everStored = $derived((summary?.stored.count ?? 0) > 0);
  const needsAppSync = $derived(app.platform === 'ios' && !app.storeAppId);

  async function loadList(reset: boolean) {
    const mine = reset ? ++listGeneration : listGeneration;
    const owner = generation;
    if (reset) {
      listLoading = true;
      listProblem = '';
    } else {
      moreLoading = true;
    }
    try {
      const page = await api.appReviews(workspaceId, app.id, filtersToQuery(filters, { limit: PAGE, cursor: reset ? null : nextCursor }));
      if (owner !== generation || mine !== listGeneration) return;
      reviews = reset ? page.reviews : appendPage(reviews, page.reviews);
      nextCursor = page.nextCursor;
      if (reset) announcement = `${page.reviews.length}${page.nextCursor ? ' or more' : ''} reviews shown.`;
    } catch (e) {
      if (owner !== generation || mine !== listGeneration) return;
      listProblem = reviewErrorMessage(e, 'load');
    } finally {
      if (owner === generation && mine === listGeneration) {
        listLoading = false;
        moreLoading = false;
      }
    }
  }

  async function loadSummary(): Promise<boolean> {
    const owner = generation;
    try {
      const next = await api.appReviewsSummary(workspaceId, app.id);
      if (owner !== generation) return false;
      summary = next;
      return true;
    } catch (e) {
      if (owner !== generation) return false;
      loadProblem = reviewErrorMessage(e, 'load');
      return false;
    }
  }

  async function loadAll(keep: boolean) {
    const mine = ++generation;
    loadProblem = '';
    if (!keep) {
      loading = true;
      summary = null;
      reviews = [];
      nextCursor = null;
    }
    void api
      .reviewReplyConfig(workspaceId)
      .then((c) => {
        if (mine === generation) replyConfig = c;
      })
      .catch(() => {});
    // The people who can be assigned. Best effort: without them the assignee is just not offered.
    void api
      .members(workspaceId)
      .then((r) => {
        if (mine === generation) members = r.members;
      })
      .catch(() => {});
    await Promise.all([loadSummary(), loadList(true)]);
    if (mine === generation) loading = false;
  }

  /** The app this tab last showed; a different one starts with clean filters. */
  let shownFor = '';

  $effect(() => {
    void refreshKey;
    const key = `${workspaceId}/${app.id}`;
    const fresh = key !== shownFor;
    if (fresh) {
      shownFor = key;
      filters = defaultFilters();
      sinceChoice = 'all';
      searchText = '';
      syncProblem = '';
    }
    untrack(() => void loadAll(!fresh));
  });

  function change(next: Partial<ReviewFilters>) {
    filters = { ...filters, ...next };
    void loadList(true);
  }

  function setSince(id: string) {
    sinceChoice = id;
    const days = sinceChoices.find((c) => c.id === id)?.days ?? null;
    change({ since: sinceFor(days, Date.now()) });
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    change({ q: searchText });
  }

  function clear() {
    filters = defaultFilters();
    sinceChoice = 'all';
    searchText = '';
    void loadList(true);
  }

  async function readNow() {
    if (syncing) return;
    const owner = generation;
    syncing = true;
    syncProblem = '';
    try {
      const done = await api.syncAppReviews(workspaceId, app.id);
      if (owner !== generation) return;
      const text = syncSummaryText(done.sync);
      toast.success(text);
      announcement = text;
      await loadAll(true);
    } catch (e) {
      if (owner !== generation) return;
      syncProblem = reviewErrorMessage(e, 'sync');
      // A failed read is stored on the sync state, so show it.
      await loadSummary();
    } finally {
      if (owner === generation) syncing = false;
    }
  }

  function updated(next: Review) {
    reviews = replaceReview(reviews, next);
    // The counts by status moved: refresh them without touching the list.
    void loadSummary();
  }

  const statusOptions = $derived<{ value: '' | ReviewStatus; label: string }[]>([
    { value: '', label: 'Any status' },
    ...statusOrder.map((s) => ({ value: s, label: statusLabel(s) })),
  ]);
</script>

<section class="reviews stack loose" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  <div class="intro">
    <p class="muted">
      What customers wrote in {storeLabel(summary?.app.store ?? (app.platform === 'ios' ? 'appstoreconnect' : 'googleplay'))},
      read from the store and kept here for your team. This is a copy for triage: reading and triage change nothing in the store. A reply does, and goes through its own confirmation.
    </p>
    <div class="intro-actions">
      {#if canSync}
        <Button variant="primary" icon="refresh" loading={syncing} disabled={needsAppSync} onclick={readNow}>Read reviews now</Button>
      {/if}
    </div>
  </div>

  {#if replyConfig && !replyConfig.enabled}
    <Alert tone="info" title="Replying is switched off">{REPLY_OFF_TEXT}</Alert>
  {/if}

  {#if needsAppSync}
    <Alert tone="warn" title="Sync the app first">
      The App Store id of this app is not known yet. Sync the app from the Releases tab, then read its reviews.
    </Alert>
  {/if}

  {#if syncProblem}<Alert tone="error" title="Reading reviews failed">{syncProblem}</Alert>{/if}
  {#each notices as notice (notice.text)}
    <Alert tone={notice.tone === 'error' ? (syncProblem ? 'info' : 'error') : notice.tone}>{notice.text}</Alert>
  {/each}

  {#if loading && !summary}
    <div role="status" aria-label="Loading reviews"><Skeleton height="160px" /></div>
  {:else if loadProblem && !summary}
    <Alert tone="error" title="Reviews could not be loaded">{loadProblem}</Alert>
    <div><Button icon="refresh" onclick={() => void loadAll(false)}>Try again</Button></div>
  {:else if summary}
    <p class="muted small">
      {lastReadText(summary.sync, (at) => timeAgo(at, now))}
      {#if summary.sync.lastSuccessAt !== null}<span class="faint">({fullTime(summary.sync.lastSuccessAt)})</span>{/if}
      {#if summary.retentionDays}Reviews older than {summary.retentionDays} days are deleted automatically.{/if}
      {#if summary.retentionDays === 0}Reviews are kept until the app is deleted.{/if}
    </p>

    {#if !everStored && !active}
      <div class="card">
        <EmptyState
          icon="inbox"
          title={summary.sync.lastSuccessAt === null ? 'No reviews have been read yet' : 'No reviews stored'}
          description={summary.sync.lastSuccessAt === null
            ? app.platform === 'android'
              ? 'Read them from Google Play with this app’s credential. Google Play only returns the last 7 days, and only reviews with a comment, so read often.'
              : 'Read them from App Store Connect with this app’s credential. The first read stores what is there and raises no alerts.'
            : app.platform === 'android'
              ? 'The last read found no review in the last 7 days. Google Play only returns reviews with a comment.'
              : 'The store returned no reviews for this app.'}
        >
          {#snippet actions()}
            {#if canSync && !needsAppSync}
              <Button variant="primary" icon="refresh" loading={syncing} onclick={readNow}>Read reviews now</Button>
            {:else if !canSync}
              <span class="muted">A member or admin can read the reviews.</span>
            {/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <RatingOverview {summary} />

      <form class="filters card" onsubmit={search} aria-label="Filter reviews">
        <fieldset class="ratings">
          <legend>Rating</legend>
          {#each [5, 4, 3, 2, 1] as n (n)}
            <label class="check">
              <input type="checkbox" checked={filters.ratings.includes(n)} onchange={() => change({ ratings: toggleIn(filters.ratings, n) })} />
              {n} {n === 1 ? 'star' : 'stars'}
            </label>
          {/each}
        </fieldset>

        <div class="filter-grid">
          <div class="field">
            <label for="{uid}-status">Status</label>
            <select
              id="{uid}-status"
              value={filters.statuses[0] ?? ''}
              onchange={(e) => change({ statuses: e.currentTarget.value === '' ? [] : [e.currentTarget.value as ReviewStatus] })}
            >
              {#each statusOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-response">Developer response</label>
            <select id="{uid}-response" value={filters.response} onchange={(e) => change({ response: e.currentTarget.value as ReviewFilters['response'] })}>
              <option value="">Either</option>
              <option value="no">No response yet</option>
              <option value="yes">Has a response</option>
            </select>
          </div>
          <div class="field">
            <label for="{uid}-version">Version</label>
            <select id="{uid}-version" value={filters.version} onchange={(e) => change({ version: e.currentTarget.value })}>
              <option value="">Any version</option>
              {#each summary.stored.byVersion as v (v.version)}<option value={v.version}>{v.version} ({v.count})</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-territory">Country or region</label>
            <select id="{uid}-territory" value={filters.territory} onchange={(e) => change({ territory: e.currentTarget.value })}>
              <option value="">Any</option>
              {#each summary.stored.territories as t (t.value)}<option value={t.value}>{territoryName(t.value)} ({t.count})</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-language">Language</label>
            <select id="{uid}-language" value={filters.language} onchange={(e) => change({ language: e.currentTarget.value })}>
              <option value="">Any</option>
              {#each summary.stored.languages as l (l.value)}<option value={l.value}>{l.value} ({l.count})</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-since">Written</label>
            <select id="{uid}-since" value={sinceChoice} onchange={(e) => setSince(e.currentTarget.value)}>
              {#each sinceChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-sort">Sort</label>
            <select id="{uid}-sort" value={filters.sort} onchange={(e) => change({ sort: e.currentTarget.value as ReviewSort })}>
              {#each Object.entries(sortLabels) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </div>
        </div>

        <div class="search-row">
          <div class="field grow">
            <label for="{uid}-q">Search the text</label>
            <input id="{uid}-q" type="search" maxlength="100" placeholder="a word or phrase" bind:value={searchText} autocomplete="off" />
          </div>
          <Button type="submit" icon="search">Search</Button>
          {#if active}<Button variant="ghost" onclick={clear}>Clear filters</Button>{/if}
        </div>
      </form>

      <div class="list" aria-busy={listLoading}>
        {#if listProblem}
          <Alert tone="error" title="Reviews could not be loaded">{listProblem}</Alert>
          <div><Button icon="refresh" onclick={() => void loadList(true)}>Try again</Button></div>
        {:else if listLoading && reviews.length === 0}
          <div role="status" aria-label="Loading reviews"><Skeleton height="120px" /></div>
        {:else if reviews.length === 0}
          <div class="card">
            <EmptyState
              icon="filter"
              title="No review matches"
              description="Change or clear the filters to see more."
            >
              {#snippet actions()}<Button onclick={clear}>Clear filters</Button>{/snippet}
            </EmptyState>
          </div>
        {:else}
          <ul class="cards">
            {#each reviews as review (review.id)}
              <li>
                <ReviewCard
                  {api}
                  {workspaceId}
                  appId={app.id}
                  appName={app.name}
                  {role}
                  {replyConfig}
                  {review}
                  {members}
                  {canTriage}
                  lowThreshold={summary.lowRatingThreshold}
                  {now}
                  onchange={updated}
                />
              </li>
            {/each}
          </ul>
          {#if nextCursor}
            <div class="more"><Button loading={moreLoading} onclick={() => void loadList(false)}>Show more reviews</Button></div>
          {:else}
            <p class="muted small">That is every review that matches.</p>
          {/if}
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .faint {
    color: var(--faint);
  }

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

  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .ratings {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .ratings legend {
    float: left;
    margin-right: var(--space-3);
    padding: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
  }

  .search-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .grow {
    flex: 1 1 240px;
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .more {
    display: flex;
    justify-content: center;
    margin-top: var(--space-3);
  }
</style>
