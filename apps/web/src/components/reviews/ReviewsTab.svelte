<!--
  ReviewsTab: the customer reviews and ratings of an app, with internal triage and replies. "Read
  reviews now" only reads. Replying is a public store write: it is off unless the server turns it on
  (MRM_REVIEW_REPLY_ENABLED), needs an admin to send, and goes through ReplyDialog (draft, confirm).
  Props: api, workspaceId, role, app, now (ms), refreshKey (changes when the app was synced, so this
  tab reloads).
  Platform scope: the app record is one platform; the app section mounts one tab per platform in scope.
  Also here: a quick filter for low ratings (the server's threshold), and for translation a toggle that
  shows or hides every translation and "Translate all visible", which sends the stored text of the
  reviews in the list that need it to the workspace's translation provider, 25 at a time, one request
  after the other, and stops at the first failure.

  On wide screens (lib/review-split.ts) the list is a dense list with the selected review in full beside it
  (ReviewSplit; the selection is kept in the address as `?review=<id>`); narrow screens keep the cards.

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
    leavesFilters,
    neighborAfterRemoval,
    replaceReview,
    reviewErrorMessage,
    sinceChoices,
    sinceFor,
    sortLabels,
    storeLabel,
    syncNotices,
    syncSummaryText,
    territoryName,
    toggleIn,
    type Review,
    type ReviewFilters,
    type ReviewSort,
    type ReviewsSummary,
  } from '../../lib/reviews.ts';
  import { REPLY_OFF_TEXT, type ReplyConfig } from '../../lib/review-reply.ts';
  import {
    type ReviewTranslation,
    canTranslate,
    translationErrorMessage,
  } from '../../lib/review-translation.ts';
  import {
    isLowOnly,
    mergeTranslations,
    pendingTranslationBatches,
    ratingsWithLowOnly,
    translateAllLabel,
    unansweredChip,
    unansweredFilters,
  } from '../../lib/reviews-tab.ts';
  import { filtersButtonText, popoverFilterCount, statsLine, statusChips, statusesAfterChip } from '../../lib/reviews-toolbar.ts';
  import { averageText } from '../../lib/reviews.ts';
  import Section from '../ui/Section.svelte';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { type TranslationConfig, languageName, loadTranslationConfig } from '../../lib/settings.ts';
  import { splitView } from '../../lib/split-view.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, Member } from '../../lib/types.ts';
  import { reviewsLead } from '../../lib/page-lead.ts';
  import Alert from '../ui/Alert.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatChip from '../ui/StatChip.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import RatingOverview from './RatingOverview.svelte';
  import ReviewCard from './ReviewCard.svelte';
  import ReviewsAi from './ReviewsAi.svelte';
  import ReviewSplit from './ReviewSplit.svelte';
  import { isReviewsAddress, reviewFromHash, withReview } from '../../lib/review-split.ts';

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
  /** The workspace's translation settings; null until known or when the person cannot read them. */
  let translationConfig = $state<TranslationConfig | null>(null);
  let translations = $state<Record<string, ReviewTranslation | undefined>>({});
  let showTranslations = $state(true);
  let translatingAll = $state(false);
  let translateProblem = $state('');
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
  let moreOpen = $state(false);

  /** Ignore a late answer for another app, or for filters that have changed since. */
  let generation = 0;
  let listGeneration = 0;

  const notices = $derived(summary ? syncNotices(summary.sync, now, (at) => timeAgo(at, now)) : []);
  const active = $derived(hasActiveFilters(filters));
  /** The filters behind the "Filters" popover that are on (the status chips and the search show themselves). */
  const moreActive = $derived(popoverFilterCount(filters, sinceChoice));
  const chips = $derived(statusChips(summary?.byStatus ?? {}, filters.statuses));
  const everStored = $derived((summary?.stored.count ?? 0) > 0);
  const needsAppSync = $derived(app.platform !== 'android' && !app.storeAppId);

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
      // The sidebar badge of this app reads the same count (fresher than the workspace summary).
      if (next.unanswered) navSignals.setUnansweredByApp(workspaceId, { [app.id]: next.unanswered.count });
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
    void loadTranslationConfig(api, workspaceId).then((c) => {
      if (mine === generation) translationConfig = c;
    });
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
      translations = {};
      translateProblem = '';
      showTranslations = true;
    }
    untrack(() => void loadAll(!fresh));
  });

  function change(next: Partial<ReviewFilters>) {
    filters = { ...filters, ...next };
    void loadList(true);
  }

  const chip = $derived(unansweredChip(summary?.unanswered, now));
  const lead = $derived(reviewsLead({ loaded: summary !== null, stored: summary?.stored.count ?? 0, chip }));
  /** The unanswered filter is on: no developer response (and the ratings the count covers). */
  const showingUnanswered = $derived(filters.response === 'no');

  function showUnanswered() {
    sinceChoice = 'all';
    searchText = '';
    filters = { ...defaultFilters(), ...unansweredFilters(summary?.unanswered?.maxRating ?? 5) };
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

  const translationOn = $derived(
    canTranslate(role) && translationConfig !== null && translationConfig.enabled && translationConfig.mode !== 'off',
  );
  const pendingBatches = $derived(translationConfig ? pendingTranslationBatches(reviews, translationConfig.target, translations) : []);
  const pendingCount = $derived(pendingBatches.reduce((n, b) => n + b.length, 0));
  const anyTranslated = $derived(Object.keys(translations).some((id) => translations[id] !== undefined));
  const lowOnly = $derived(summary ? isLowOnly(filters.ratings, summary.lowRatingThreshold) : false);

  /** One request per 25 reviews, one after the other. Stops at the first failure and says which. Nothing is retried. */
  async function translateAll() {
    if (translatingAll || !translationConfig || pendingBatches.length === 0) return;
    const owner = generation;
    const batches = pendingBatches;
    const target = translationConfig.target;
    translatingAll = true;
    translateProblem = '';
    try {
      for (const ids of batches) {
        const done = await api.translateReviews(workspaceId, app.id, { reviewIds: ids, target });
        if (owner !== generation) return;
        translations = mergeTranslations(translations, done.translations);
      }
      showTranslations = true;
    } catch (e) {
      if (owner !== generation) return;
      translateProblem = translationErrorMessage(e);
    } finally {
      if (owner === generation) translatingAll = false;
    }
  }

  /** The next page of the list (the button, and the keyboard of the list and detail view). */
  function loadMore() {
    if (!moreLoading && nextCursor !== null) void loadList(false);
  }

  function updated(next: Review) {
    if (leavesFilters(next, filters)) {
      // It no longer fits the filter (triaged under "New"): it leaves the list and the next one is selected.
      const neighbor = neighborAfterRemoval(reviews.map((r) => r.id), next.id);
      if (isReviewsAddress(location.hash) && reviewFromHash(location.hash) === next.id) {
        history.replaceState(history.state, '', withReview(location.hash, neighbor));
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      reviews = reviews.filter((r) => r.id !== next.id);
    } else {
      reviews = replaceReview(reviews, next);
    }
    // The counts by status moved: refresh them without touching the list.
    void loadSummary();
  }
</script>

<section class="reviews stack" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#snippet readButton(primary: boolean)}
    {#if canSync}
      <Button variant={primary ? 'primary' : 'secondary'} icon="refresh" loading={syncing} disabled={needsAppSync} onclick={readNow}>Read reviews now</Button>
    {/if}
  {/snippet}

  <PageLead
    testid={chip ? 'unanswered-chip' : 'reviews-lead'}
    tone={lead.tone}
    headline={lead.headline}
    hint={summary ? lastReadText(summary.sync, (at) => timeAgo(at, now)) : undefined}
  >
    {#snippet aside()}
      <span class="row wrap">
        <InfoTip label="About the reviews of this app" buttonText="About reviews" align="start" width="26rem">
          <p>
            What customers wrote in {storeLabel(summary?.app.store ?? (app.platform === 'android' ? 'googleplay' : 'appstoreconnect'))},
            read from the store and kept here for your team. This is a copy for triage: reading and triage change nothing in the store. A reply does, and goes through its own confirmation.
          </p>
          {#if summary?.retentionDays}<p class="muted">Reviews older than {summary.retentionDays} days are deleted automatically.</p>{/if}
          {#if summary?.retentionDays === 0}<p class="muted">Reviews are kept until the app is deleted.</p>{/if}
        </InfoTip>
        {#if replyConfig && !replyConfig.enabled}
          <StatusPill tone="info" label="Replying is switched off" stateKey="reviews.reply-off">
            <p>{REPLY_OFF_TEXT}</p>
          </StatusPill>
        {/if}
      </span>
    {/snippet}
    {#snippet actions()}
      {#if lead.primary === 'show' && chip}
        <Button variant="primary" aria-label={chip.label} disabled={showingUnanswered} onclick={showUnanswered}>{showingUnanswered ? 'Showing unanswered' : 'Show unanswered'}</Button>
      {/if}
      {#if lead.primary !== 'none'}{@render readButton(lead.primary === 'read')}{/if}
    {/snippet}
  </PageLead>

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
      <Section title="Rating summary" key="summary" variant="plain" level={2} summary={`${averageText(summary.stored.average)} · ${statsLine(summary.stored)}`}>
      <div class="statsrow">
        <RatingOverview {summary} />
      </div>
      </Section>

      <ReviewsAi {api} {workspaceId} {role} {app} reviewIds={reviews.map((r) => r.id)} />

      <form class="toolbar" onsubmit={search} role="search" aria-label="Filter reviews">
        <label class="searchbox">
          <Icon name="search" size={14} />
          <input id="{uid}-q" type="search" aria-label="Search the review text" maxlength="100" placeholder="Search reviews" bind:value={searchText} autocomplete="off" />
        </label>
        <ul class="chips" aria-label="Status">
          {#each chips as c (c.status)}
            <li>
              <StatChip label={c.label} value={c.count ?? ''} tone={c.status === 'new' ? 'info' : 'neutral'} pressed={c.pressed} onclick={() => change({ statuses: statusesAfterChip(filters.statuses, c.status) })} />
            </li>
          {/each}
        </ul>
        <InfoTip label="Filters" buttonText={filtersButtonText(moreActive)} icon="filter" align="end" width="min(26rem, 92vw)" bind:open={moreOpen}>
          <div class="filter-grid">
            <fieldset class="ratings">
              <legend>Rating</legend>
              {#each [5, 4, 3, 2, 1] as n (n)}
                <label class="check">
                  <input type="checkbox" checked={filters.ratings.includes(n)} onchange={() => change({ ratings: toggleIn(filters.ratings, n) })} />
                  {n}<Icon name="star-filled" size={12} /><span class="visually-hidden"> {n === 1 ? 'star' : 'stars'}</span>
                </label>
              {/each}
            </fieldset>
            {#if summary.lowRatingThreshold > 0}
              <label class="check">
                <input
                  type="checkbox"
                  checked={lowOnly}
                  onchange={() => change({ ratings: ratingsWithLowOnly(!lowOnly, summary?.lowRatingThreshold ?? 0) })}
                />
                Low ratings only ({summary.lowRatingThreshold} {summary.lowRatingThreshold === 1 ? 'star' : 'stars'} or less)
              </label>
            {/if}
            <div class="field">
              <label for="{uid}-sort">Sort</label>
              <select id="{uid}-sort" value={filters.sort} onchange={(e) => change({ sort: e.currentTarget.value as ReviewSort })}>
                {#each Object.entries(sortLabels) as [value, label] (value)}<option {value}>{label}</option>{/each}
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
              <label for="{uid}-language">Language</label>
              <select id="{uid}-language" value={filters.language} onchange={(e) => change({ language: e.currentTarget.value })}>
                <option value="">Any</option>
                {#each summary.stored.languages as l (l.value)}<option value={l.value}>{l.value} ({l.count})</option>{/each}
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
              <label for="{uid}-version">Version</label>
              <select id="{uid}-version" value={filters.version} onchange={(e) => change({ version: e.currentTarget.value })}>
                <option value="">Any version</option>
                {#each summary.stored.byVersion as v (v.version)}<option value={v.version}>{v.version} ({v.count})</option>{/each}
              </select>
            </div>
            <div class="field">
              <label for="{uid}-since">Written</label>
              <select id="{uid}-since" value={sinceChoice} onchange={(e) => setSince(e.currentTarget.value)}>
                {#each sinceChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
              </select>
            </div>
          </div>
          {#if translationOn && translationConfig}
            <div class="translate-bar">
              <Button size="sm" icon="globe" loading={translatingAll} disabled={pendingCount === 0 || translatingAll} onclick={translateAll}>
                {translateAllLabel(pendingCount, languageName(translationConfig.target))}
              </Button>
              <label class="check">
                <input type="checkbox" bind:checked={showTranslations} disabled={!anyTranslated} />
                Show translations
              </label>
              <p class="muted small">The stored text of those reviews is sent to the translation provider, 25 at a time.</p>
            </div>
          {/if}
        </InfoTip>
        {#if active}<Button variant="ghost" size="sm" onclick={clear}>Clear filters</Button>{/if}
      </form>
      {#if translateProblem}<Alert tone="error" title="Translation stopped">{translateProblem}</Alert>{/if}

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
          {#if splitView.active}
            <ReviewSplit
              compact={splitView.drawer}
              {api}
              {workspaceId}
              {role}
              {reviews}
              appName={app.name}
              {members}
              {canTriage}
              {replyConfig}
              lowThreshold={summary.lowRatingThreshold}
              {now}
              {translations}
              ontranslate={(t) => (translations = mergeTranslations(translations, [t]))}
              {showTranslations}
              settled={!listLoading}
              hasMore={nextCursor !== null}
              {moreLoading}
              onmore={loadMore}
              onsearch={() => document.getElementById(`${uid}-q`)?.focus()}
              onchange={updated}
            />
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
                    translation={translations[review.id]}
                    ontranslate={(t) => (translations = mergeTranslations(translations, [t]))}
                    {showTranslations}
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

  .statsrow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: center;
    justify-content: space-between;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .searchbox {
    display: flex;
    flex: 1 1 12rem;
    gap: var(--space-2);
    align-items: center;
    min-width: 10rem;
    max-width: 22rem;
    color: var(--muted);
  }

  .searchbox input {
    flex: 1;
    min-width: 0;
    min-height: var(--control-md);
    font-size: 0.9375rem;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ratings {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    grid-column: 1 / -1;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .ratings legend {
    float: left;
    margin-right: var(--space-2);
    padding: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .ratings .check {
    gap: var(--space-1);
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .filter-grid > .check {
    grid-column: 1 / -1;
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .translate-bar {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  .more {
    display: flex;
    justify-content: center;
    margin-top: var(--space-3);
  }
</style>
