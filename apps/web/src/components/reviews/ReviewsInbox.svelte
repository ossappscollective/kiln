<!--
  ReviewsInbox: the customer reviews of every app in one list, for triage and replies.
  Props (from the shell): api, workspaceId, role.

  A copy kept on this server: reading and triage change nothing in a store; a reply is public in the
  store and goes through ReplyDialog (draft, confirm, an admin sends). The summary strip counts new,
  unanswered and low rated reviews per app and says what the numbers are computed from.

  The filters live in the address (`#/reviews?rating=1,2&apps=ID`), so a view can be shared and
  survives a reload. Keyboard: j and k move between reviews, t marks the review triaged, r opens its
  reply, / goes to the search box. Shortcuts never fire while typing or while a dialog is open.

  On wide screens (lib/review-split.ts) the reviews are a dense list with the selected review in full beside
  it (ReviewSplit); the selected review is kept in the address as `?review=<id>`. Narrow screens keep the cards
  and the keyboard above.

  Review text is written by customers: plain text only, never markup, never in a URL.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { onMount, untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appReviewsHref } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { unansweredCount } from '../../lib/nav-badges.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { appLabel } from '../../lib/portfolio.ts';
  import { REPLY_OFF_TEXT, type ReplyConfig } from '../../lib/review-reply.ts';
  import {
    appendInboxPage,
    averageText,
    busiestApps,
    defaultInboxFilters,
    hasActiveInboxFilters,
    inboxAnnouncement,
    inboxFiltersToQuery,
    inboxHref,
    inboxFiltersToSearch,
    moveIndex,
    parseInboxHash,
    quickViewFilters,
    quickViews,
    leavesFilters,
    neighborAfterRemoval,
    replaceInboxReview,
    reviewErrorMessage,
    shortcutFor,
    sortLabels,
    summaryStripText,
    unansweredNote,
    territoryName,
    toggleIn,
    withinChoices,
    type InboxFilters,
    type InboxReview,
    type QuickView,
    type Review,
    type ReviewSort,
    type WorkspaceReviewsSummary,
  } from '../../lib/reviews.ts';
  import { isReviewsAddress, reviewFromHash, withReview } from '../../lib/review-split.ts';
  import { filtersButtonText, inboxPopoverFilterCount, statusChips, statusesAfterChip } from '../../lib/reviews-toolbar.ts';
  import { splitView } from '../../lib/split-view.svelte.ts';
  import type { AppSummary, Member } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatChip from '../ui/StatChip.svelte';
  import ReviewCard from './ReviewCard.svelte';
  import ReviewSplit from './ReviewSplit.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const PAGE = 25;
  const uid = $props.id();
  const canTriage = $derived(can(role, 'reviews.triage'));

  const initial = parseInboxHash(location.hash);
  let filters = $state<InboxFilters>(initial);
  let searchText = $state(initial.q);
  let apps = $state<AppSummary[]>([]);
  let members = $state<Member[]>([]);
  let summary = $state<WorkspaceReviewsSummary | null>(null);
  let replyConfig = $state<ReplyConfig | null>(null);
  let reviews = $state<InboxReview[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let moreLoading = $state(false);
  let problem = $state('');
  let summaryProblem = $state('');
  let announcement = $state('');
  let now = $state(Date.now());
  let focusId = $state('');
  let searchEl = $state<HTMLInputElement>();
  let cards = $state<Record<string, ReviewCard | undefined>>({});

  let listGeneration = 0;

  const active = $derived(hasActiveInboxFilters(filters));
  const lowThreshold = $derived(summary?.lowRatingThreshold ?? 2);
  const iconUrls = $derived(
    apps.reduce<Record<string, string | null>>((acc, a) => {
      acc[a.id] = a.iconUrl ?? null;
      return acc;
    }, {}),
  );
  const busiest = $derived(summary ? busiestApps(summary.apps, 6) : []);
  const oldestNote = $derived(summary ? unansweredNote(summary, now) : null);
  const noApps = $derived(!loading && summary !== null && summary.apps.length === 0);
  const nothingStored = $derived(summary !== null && summary.totals.total === 0);
  const moreActive = $derived(inboxPopoverFilterCount(filters));
  /** The workspace summary counts only the new ones; the other chips show no number. */
  const chips = $derived(statusChips(summary ? { new: summary.totals.new } : {}, filters.statuses));

  onMount(() => {
    const tick = setInterval(() => {
      now = Date.now();
    }, 60_000);
    // A link from elsewhere (an app's page, a bookmark) changes only the address.
    const onhash = () => {
      if (!/^#\/reviews(\?|$)/.test(location.hash)) return;
      const next = parseInboxHash(location.hash);
      if (inboxFiltersToSearch(next) === inboxFiltersToSearch(filters)) return;
      filters = next;
      searchText = next.q;
      void loadList(true);
    };
    window.addEventListener('hashchange', onhash);
    return () => {
      clearInterval(tick);
      window.removeEventListener('hashchange', onhash);
    };
  });

  async function loadList(reset: boolean) {
    const mine = reset ? ++listGeneration : listGeneration;
    if (reset) {
      loading = true;
      problem = '';
    } else {
      moreLoading = true;
    }
    try {
      const page = await api.workspaceReviews(
        workspaceId,
        inboxFiltersToQuery(filters, Date.now(), { limit: PAGE, cursor: reset ? null : nextCursor }),
      );
      if (mine !== listGeneration) return;
      reviews = reset ? page.reviews : appendInboxPage(reviews, page.reviews);
      nextCursor = page.nextCursor;
      if (reset) {
        focusId = '';
        announcement = inboxAnnouncement(page.reviews.length, page.nextCursor !== null);
      }
    } catch (e) {
      if (mine !== listGeneration) return;
      problem = reviewErrorMessage(e, 'load');
    } finally {
      if (mine === listGeneration) {
        loading = false;
        moreLoading = false;
      }
    }
  }

  async function loadSummary() {
    try {
      summary = await api.workspaceReviewsSummary(workspaceId);
      navSignals.setUnanswered(workspaceId, unansweredCount(summary));
      summaryProblem = '';
    } catch (e) {
      summaryProblem = reviewErrorMessage(e, 'load');
    }
  }

  function loadAll() {
    // Best effort: without these the inbox still works (no app names in the filter, no assignees).
    void api
      .apps(workspaceId)
      .then((r) => {
        apps = r.apps;
        navSignals.setApps(workspaceId, r.apps);
      })
      .catch(() => {});
    void api.members(workspaceId).then((r) => (members = r.members)).catch(() => {});
    void api.reviewReplyConfig(workspaceId).then((c) => (replyConfig = c)).catch(() => {});
    void loadSummary();
    void loadList(true);
  }

  let shownFor = '';
  $effect(() => {
    if (shownFor === workspaceId) return;
    shownFor = workspaceId;
    untrack(loadAll);
  });

  function remember() {
    // replaceState: no history entry per filter click, and no hashchange for the shell to handle.
    // The selected review stays in the address; the list and detail view picks the first one again if the new list lacks it.
    history.replaceState(history.state, '', withReview(inboxHref(filters), reviewFromHash(location.hash)));
  }

  function change(next: Partial<InboxFilters>) {
    filters = { ...filters, ...next };
    remember();
    void loadList(true);
  }

  function applyQuick(id: QuickView['id']) {
    const next = quickViewFilters(id, lowThreshold);
    filters = next;
    searchText = '';
    remember();
    void loadList(true);
  }

  function focusApp(appId: string) {
    filters = { ...defaultInboxFilters(), appIds: [appId] };
    searchText = '';
    remember();
    void loadList(true);
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    change({ q: searchText.trim().slice(0, 100) });
  }

  function clear() {
    filters = defaultInboxFilters();
    searchText = '';
    remember();
    void loadList(true);
  }

  function updated(next: Review) {
    if (leavesFilters(next, filters)) {
      // It no longer fits the filter (triaged under "New"): it leaves the list and the next one is selected.
      const neighbor = neighborAfterRemoval(reviews.map((r) => r.id), next.id);
      if (reviewFromHash(location.hash) === next.id && isReviewsAddress(location.hash)) {
        history.replaceState(history.state, '', withReview(location.hash, neighbor));
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      reviews = reviews.filter((r) => r.id !== next.id);
    } else {
      reviews = replaceInboxReview(reviews, next);
    }
    void loadSummary();
  }

  // ----- keyboard ----------------------------------------------------------------------------

  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || target.closest('dialog') !== null;
  }

  function focusIndex(index: number) {
    const review = reviews[index];
    if (!review) return;
    focusId = review.id;
    const el = document.getElementById(`review-${review.id}`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }

  function loadMore() {
    if (!moreLoading && nextCursor !== null) void loadList(false);
  }

  function onKey(event: KeyboardEvent) {
    // The list and detail view has its own keys (ReviewSplit).
    if (splitView.wide) return;
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
    const action = shortcutFor({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      typing: isTyping(event.target),
    });
    if (!action) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inList = target !== null && target.closest('.cards') !== null;
    // The arrow keys and Home and End scroll the page: they only move between reviews from inside the list.
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') && !inList) return;
    const current = reviews.findIndex((r) => r.id === focusId);
    if (action === 'search') {
      event.preventDefault();
      searchEl?.focus();
    } else if (action === 'triage' || action === 'reply') {
      const review = reviews[current];
      if (!review) return;
      event.preventDefault();
      if (action === 'triage') void cards[review.id]?.markTriaged();
      else cards[review.id]?.openReply();
    } else {
      event.preventDefault();
      focusIndex(moveIndex(current, reviews.length, action));
    }
  }

  function onFocusIn(event: FocusEvent) {
    const article = event.target instanceof HTMLElement ? event.target.closest('article[id^="review-"]') : null;
    if (article) focusId = article.id.slice('review-'.length);
  }
</script>

<svelte:window onkeydown={onKey} />

<PageHeader
  title="Reviews"
  description="What customers wrote about every app, kept on this server for your team to triage and answer. Reading and triage change nothing in a store."
/>

<section class="inbox stack loose" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if replyConfig && !replyConfig.enabled}
    <Alert tone="info" title="Replying is switched off">{REPLY_OFF_TEXT}</Alert>
  {/if}

  {#if summaryProblem && !summary}
    <Alert tone="error" title="The summary could not be loaded">{summaryProblem}</Alert>
  {:else if summary}
    <div class="strip" aria-label="Summary">
      <p class="visually-hidden">{summaryStripText(summary.totals)}</p>
      <ul class="quick">
        {#each quickViews as view (view.id)}
          <li>
            <button type="button" class="bare quickview" onclick={() => applyQuick(view.id)}>
              {#if view.id === 'new'}<strong>{summary.totals.new}</strong>
              {:else if view.id === 'unanswered'}<strong>{summary.totals.unanswered}</strong>
              {:else if view.id === 'low'}<strong>{summary.totals.lowRating}</strong>{/if}
              <span>{view.label}</span>
            </button>
          </li>
        {/each}
        <li class="muted"><strong>{averageText(summary.totals.average)}</strong> average of stored reviews</li>
      </ul>
      <InfoTip label="About these numbers" buttonText="About the numbers" align="end" width="min(28rem, 92vw)">
        <p>{summary.label}. Low rating means {lowThreshold} stars or fewer; ignored reviews are not counted as unanswered or low.</p>
        {#if oldestNote}<p class="muted" data-testid="unanswered-oldest">{oldestNote}</p>{/if}
        {#if busiest.length > 0}
          <p class="eyebrow">Apps with reviews to look at</p>
          <ul class="apps" aria-label="Apps with reviews to look at">
            {#each busiest as row (row.app.id)}
              <li>
                <button type="button" class="app-chip" onclick={() => focusApp(row.app.id)}>
                  <AppIcon name={row.app.name} url={iconUrls[row.app.id] ?? null} platform={row.app.platform} size="xs" labelled={true} />
                  <span class="app-name">{row.app.name}</span>
                  <span class="muted small">{row.new} new, {row.unanswered} unanswered, {row.lowRating} low</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </InfoTip>
    </div>
  {/if}

  {#if noApps || (nothingStored && !active && !loading && !problem)}
    <div class="card">
      <EmptyState
        icon="inbox"
        title={noApps ? 'No apps yet' : 'No reviews have been read yet'}
        description={noApps
          ? 'Add an app in the Portfolio. Its reviews then appear here.'
          : 'Open an app and read its reviews from the store on its Reviews tab. Reviews are kept here after that and appear in this inbox.'}
      >
        {#snippet actions()}<Button variant="primary" href="#/portfolio">Go to the portfolio</Button>{/snippet}
      </EmptyState>
    </div>
  {:else}
    <form class="toolbar" onsubmit={search} role="search" aria-label="Filter reviews">
      <label class="searchbox">
        <Icon name="search" size={14} />
        <input id="{uid}-q" bind:this={searchEl} type="search" aria-label="Search the review text" maxlength="100" placeholder="Search reviews" bind:value={searchText} autocomplete="off" />
      </label>
      <ul class="chips" aria-label="Status">
        {#each chips as c (c.status)}
          <li>
            <StatChip label={c.label} value={c.count ?? ''} tone={c.status === 'new' ? 'info' : 'neutral'} pressed={c.pressed} onclick={() => change({ statuses: statusesAfterChip(filters.statuses, c.status) })} />
          </li>
        {/each}
      </ul>
      <InfoTip label="Filters" buttonText={filtersButtonText(moreActive)} icon="filter" align="end" width="min(30rem, 92vw)">
        <div class="filter-grid">
          <fieldset class="ratings">
            <legend>Rating</legend>
            {#each [5, 4, 3, 2, 1] as n (n)}
              <label class="check">
                <input type="checkbox" checked={filters.ratings.includes(n)} onchange={() => change({ ratings: toggleIn(filters.ratings, n) })} />
                {n} {n === 1 ? 'star' : 'stars'}
              </label>
            {/each}
          </fieldset>
          <div class="field">
            <label for="{uid}-platform">Store</label>
            <select id="{uid}-platform" value={filters.platform} onchange={(e) => change({ platform: e.currentTarget.value as InboxFilters['platform'] })}>
              <option value="">All stores</option>
              <option value="ios">App Store</option>
              <option value="android">Google Play</option>
            </select>
          </div>
          <div class="field">
            <label for="{uid}-sort">Sort</label>
            <select id="{uid}-sort" value={filters.sort} onchange={(e) => change({ sort: e.currentTarget.value as ReviewSort })}>
              {#each Object.entries(sortLabels) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-response">Developer response</label>
            <select id="{uid}-response" value={filters.response} onchange={(e) => change({ response: e.currentTarget.value as InboxFilters['response'] })}>
              <option value="">Either</option>
              <option value="no">Unanswered</option>
              <option value="yes">Has a response</option>
            </select>
          </div>
          <div class="field">
            <label for="{uid}-assignee">Assigned to</label>
            <select id="{uid}-assignee" value={filters.assignee} onchange={(e) => change({ assignee: e.currentTarget.value })}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="unassigned">Nobody</option>
              {#each members as member (member.userId)}<option value={member.userId}>{member.displayName}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-within">Written</label>
            <select id="{uid}-within" value={filters.within} onchange={(e) => change({ within: e.currentTarget.value as InboxFilters['within'] })}>
              {#each withinChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-version">Version</label>
            <input id="{uid}-version" type="text" maxlength="100" value={filters.version} onchange={(e) => change({ version: e.currentTarget.value })} autocomplete="off" />
          </div>
          <div class="field">
            <label for="{uid}-territory">Country or region code</label>
            <input id="{uid}-territory" type="text" maxlength="10" value={filters.territory} onchange={(e) => change({ territory: e.currentTarget.value })} placeholder="for example US" autocomplete="off" />
            {#if filters.territory}<p class="hint">{territoryName(filters.territory)}</p>{/if}
          </div>
          <div class="field">
            <label for="{uid}-language">Language code</label>
            <input id="{uid}-language" type="text" maxlength="12" value={filters.language} onchange={(e) => change({ language: e.currentTarget.value })} placeholder="for example en" autocomplete="off" />
          </div>
          {#if apps.length > 0}
            <fieldset class="app-list">
              <legend>Apps (none chosen means all)</legend>
              {#each apps as app (app.id)}
                <label class="check">
                  <input type="checkbox" checked={filters.appIds.includes(app.id)} onchange={() => change({ appIds: toggleIn(filters.appIds, app.id) })} />
                  {appLabel(app)}
                </label>
              {/each}
            </fieldset>
          {/if}
        </div>
        <p class="hint">
          Keyboard: <kbd>j</kbd> and <kbd>k</kbd> move between reviews, <kbd>Enter</kbd> opens one in the detail view, <kbd>t</kbd> marks one triaged, <kbd>r</kbd> opens its reply, <kbd>/</kbd> searches.
        </p>
      </InfoTip>
      {#if active}<Button variant="ghost" size="sm" onclick={clear}>Clear filters</Button>{/if}
    </form>

    <div class="list" aria-busy={loading}>
      {#if problem}
        <Alert tone="error" title="Reviews could not be loaded">{problem}</Alert>
        <div><Button icon="refresh" onclick={() => void loadList(true)}>Try again</Button></div>
      {:else if loading && reviews.length === 0}
        <div role="status" aria-label="Loading reviews"><Skeleton height="140px" /></div>
      {:else if reviews.length === 0}
        <div class="card">
          <EmptyState icon="filter" title="No review matches" description="Change or clear the filters to see more.">
            {#snippet actions()}<Button onclick={clear}>Clear filters</Button>{/snippet}
          </EmptyState>
        </div>
      {:else}
        {#if splitView.wide}
          <ReviewSplit
            {api}
            {workspaceId}
            {role}
            {reviews}
            showApp={true}
            {iconUrls}
            {members}
            {canTriage}
            {replyConfig}
            {lowThreshold}
            {now}
            settled={!loading}
            hasMore={nextCursor !== null}
            {moreLoading}
            onmore={loadMore}
            onsearch={() => searchEl?.focus()}
            onchange={updated}
            showKeys={false}
          />
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <ul class="cards" onfocusin={onFocusIn}>
            {#each reviews as review (review.id)}
              <li>
                <p class="from">
                  <AppIcon name={review.app.name} url={iconUrls[review.app.id] ?? null} platform={review.app.platform} size="xs" labelled={true} />
                  <span class="app-name">{review.app.name}</span>
                  <PlatformBadge platform={review.app.platform} showLabel={false} />
                  <a class="link sm" href={appReviewsHref(review.app.id)} title="Opens the reviews of this app.">Open app</a>
                  <span class="muted small">{timeAgo(review.createdAt, now)}</span>
                </p>
                <ReviewCard
                  bind:this={cards[review.id]}
                  {api}
                  {workspaceId}
                  appId={review.app.id}
                  appName={review.app.name}
                  {role}
                  {replyConfig}
                  {review}
                  {members}
                  {canTriage}
                  {lowThreshold}
                  {now}
                  onchange={updated}
                />
              </li>
            {/each}
          </ul>
          {#if nextCursor}
            <div class="more-row"><Button loading={moreLoading} onclick={() => void loadList(false)}>Show more reviews</Button></div>
          {:else}
            <p class="muted small">That is every review that matches.</p>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: center;
    justify-content: space-between;
  }

  .quick,
  .apps,
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: baseline;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .quick {
    font-size: var(--text-sm);
  }

  .quickview {
    display: inline-flex;
    gap: var(--space-1);
    align-items: baseline;
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
    color: var(--muted);
    cursor: pointer;
  }

  .quickview strong {
    font-size: var(--text-md);
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .quickview:hover span {
    text-decoration: underline;
  }

  .apps {
    flex-direction: column;
    align-items: stretch;
  }

  .app-chip {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-1) var(--space-3);
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .app-chip:hover {
    border-color: var(--accent);
  }

  .app-name {
    font-weight: 600;
    overflow-wrap: anywhere;
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
    min-height: var(--control-sm);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .ratings,
  .app-list {
    display: flex;
    flex-wrap: wrap;
    grid-column: 1 / -1;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .ratings legend,
  .app-list legend {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .cards {
    flex-direction: column;
  }

  .cards > li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .from {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .more-row {
    display: flex;
    justify-content: center;
  }

  kbd {
    padding: 0 var(--space-1);
    font-family: inherit;
    font-size: var(--text-xs);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
</style>
