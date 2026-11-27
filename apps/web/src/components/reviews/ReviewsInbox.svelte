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
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { onMount, untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appReviewsHref } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { unansweredCount } from '../../lib/nav-badges.ts';
  import { navSignals } from '../../lib/app-state/pending-facade.ts';
  import { tint } from '../../lib/tint/store.svelte.ts';
  import { appOptions, filterSummaryText, pruneAppIds, selectedOptions } from '../../lib/reviews/app-filter.ts';
  import { replyOffText, type ReplyConfig } from '../../lib/reviews/reply.ts';
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
  } from '../../lib/reviews/reviews.ts';
  import { isReviewsAddress, reviewFromHash, shortcutHints, withReview } from '../../lib/reviews/split.ts';
  import { filtersButtonText, inboxPopoverFilterCount, statusChips, statusesAfterChip } from '../../lib/reviews/toolbar.ts';
  import { splitView } from '../../lib/split-view.svelte.ts';
  import type { AppSummary, Member } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import AppFilter from './AppFilter.svelte';
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
  const options = $derived(appOptions(apps, summary?.apps));
  const summaryLine = $derived(filterSummaryText(filters, options));
  const chosenNames = $derived(selectedOptions(options, filters.appIds).map((o) => o.name).join(t('reviews:appFilter.and')));
  // The palette of every app on screen (from the cache at once, else read from its icon), for the tint of the rows.
  $effect(() => {
    const seen: Record<string, true> = {};
    for (const r of reviews) {
      if (seen[r.app.id]) continue;
      seen[r.app.id] = true;
      const icon = iconUrls[r.app.id];
      if (icon) untrack(() => tint.track(r.app.id, icon));
    }
  });
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
        // An app of the address that this person cannot see (another workspace, a deleted app) is dropped, with no chip and no request for it.
        const visible = pruneAppIds(filters.appIds, appOptions(r.apps, null), true);
        if (visible.length !== filters.appIds.length) change({ appIds: visible });
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
    if (splitView.active) return;
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
  title={t('reviews:inbox.title')}
  description={t('reviews:inbox.description')}
/>

<section class="inbox stack loose" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if replyConfig && !replyConfig.enabled}
    <Alert tone="info" title={t('reviews:reply.offTitle')}>{replyOffText()}</Alert>
  {/if}

  {#if summaryProblem && !summary}
    <Alert tone="error" title={t('reviews:inbox.summaryFailed')}>{summaryProblem}</Alert>
  {:else if summary}
    <div class="strip" aria-label={t('reviews:inbox.summary')}>
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
        <li class="muted"><T key="reviews:inbox.averageStored" params={{ value: averageText(summary.totals.average) }} /></li>
      </ul>
      <InfoTip label={t('reviews:overview.aboutLabel')} buttonText={t('reviews:overview.about')} align="end" width="min(28rem, 92vw)">
        <p>{t('reviews:inbox.lowRatingNote', { label: summary.label, count: lowThreshold })}</p>
        {#if oldestNote}<p class="muted" data-testid="unanswered-oldest">{oldestNote}</p>{/if}
        {#if busiest.length > 0}
          <p class="eyebrow">{t('reviews:inbox.busiest')}</p>
          <ul class="apps" aria-label={t('reviews:inbox.busiest')}>
            {#each busiest as row (row.app.id)}
              <li>
                <button type="button" class="app-chip" onclick={() => focusApp(row.app.id)}>
                  <AppIcon name={row.app.name} url={iconUrls[row.app.id] ?? null} platform={row.app.platform} size="xs" labelled={true} />
                  <span class="app-name">{row.app.name}</span>
                  <span class="muted small">{t('reviews:inbox.appCounts', { newCount: row.new, unanswered: row.unanswered, low: row.lowRating })}</span>
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
        title={noApps ? t('reviews:inbox.noApps') : t('reviews:inbox.nothingRead')}
        description={noApps ? t('reviews:inbox.noAppsHint') : t('reviews:inbox.nothingReadHint')}
      >
        {#snippet actions()}<Button variant="primary" href="#/portfolio">{t('reviews:inbox.goPortfolio')}</Button>{/snippet}
      </EmptyState>
    </div>
  {:else}
    <form class="toolbar" onsubmit={search} role="search" aria-label={t('reviews:inbox.filter')}>
      <label class="searchbox">
        <Icon name="search" size={14} />
        <input id="{uid}-q" bind:this={searchEl} type="search" aria-label={t('reviews:inbox.searchLabel')} maxlength="100" placeholder={t('reviews:inbox.searchPlaceholder')} bind:value={searchText} autocomplete="off" />
      </label>
      <AppFilter {options} selected={filters.appIds} onchange={(ids) => change({ appIds: ids })} />
      <ul class="chips" aria-label={t('reviews:card.status')}>
        {#each chips as c (c.status)}
          <li>
            <StatChip label={c.label} value={c.count ?? ''} tone={c.status === 'new' ? 'info' : 'neutral'} pressed={c.pressed} onclick={() => change({ statuses: statusesAfterChip(filters.statuses, c.status) })} />
          </li>
        {/each}
      </ul>
      <InfoTip label={t('reviews:toolbar.filters')} buttonText={filtersButtonText(moreActive)} icon="filter" align="end" width="min(30rem, 92vw)">
        <div class="filter-grid">
          <fieldset class="ratings">
            <legend>{t('reviews:inbox.rating')}</legend>
            {#each [5, 4, 3, 2, 1] as n (n)}
              <label class="check">
                <input type="checkbox" checked={filters.ratings.includes(n)} onchange={() => change({ ratings: toggleIn(filters.ratings, n) })} />
                {t('reviews:overview.stars', { count: n })}
              </label>
            {/each}
          </fieldset>
          <div class="field">
            <label for="{uid}-platform">{t('reviews:inbox.store')}</label>
            <select id="{uid}-platform" value={filters.platform} onchange={(e) => change({ platform: e.currentTarget.value as InboxFilters['platform'] })}>
              <option value="">{t('reviews:inbox.allStores')}</option>
              <option value="ios">App Store</option>
              <option value="android">Google Play</option>
            </select>
          </div>
          <div class="field">
            <label for="{uid}-sort">{t('reviews:inbox.sort')}</label>
            <select id="{uid}-sort" value={filters.sort} onchange={(e) => change({ sort: e.currentTarget.value as ReviewSort })}>
              {#each Object.entries(sortLabels) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-response">{t('reviews:card.developerResponse')}</label>
            <select id="{uid}-response" value={filters.response} onchange={(e) => change({ response: e.currentTarget.value as InboxFilters['response'] })}>
              <option value="">{t('reviews:inbox.either')}</option>
              <option value="no">{t('reviews:inbox.unanswered')}</option>
              <option value="yes">{t('reviews:inbox.hasResponse')}</option>
            </select>
          </div>
          <div class="field">
            <label for="{uid}-assignee">{t('reviews:card.assignee')}</label>
            <select id="{uid}-assignee" value={filters.assignee} onchange={(e) => change({ assignee: e.currentTarget.value })}>
              <option value="">{t('reviews:inbox.anyone')}</option>
              <option value="me">{t('reviews:inbox.me')}</option>
              <option value="unassigned">{t('reviews:card.nobody')}</option>
              {#each members as member (member.userId)}<option value={member.userId}>{member.displayName}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-within">{t('reviews:inbox.written')}</label>
            <select id="{uid}-within" value={filters.within} onchange={(e) => change({ within: e.currentTarget.value as InboxFilters['within'] })}>
              {#each withinChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="{uid}-version">{t('reviews:overview.colVersion')}</label>
            <input id="{uid}-version" type="text" maxlength="100" value={filters.version} onchange={(e) => change({ version: e.currentTarget.value })} autocomplete="off" />
          </div>
          <div class="field">
            <label for="{uid}-territory">{t('reviews:inbox.territory')}</label>
            <input id="{uid}-territory" type="text" maxlength="10" value={filters.territory} onchange={(e) => change({ territory: e.currentTarget.value })} placeholder={t('reviews:inbox.territoryExample')} autocomplete="off" />
            {#if filters.territory}<p class="hint">{territoryName(filters.territory)}</p>{/if}
          </div>
          <div class="field">
            <label for="{uid}-language">{t('reviews:inbox.language')}</label>
            <input id="{uid}-language" type="text" maxlength="12" value={filters.language} onchange={(e) => change({ language: e.currentTarget.value })} placeholder={t('reviews:inbox.languageExample')} autocomplete="off" />
          </div>
        </div>
        <p class="hint keys">
          <span>{t('reviews:inbox.keyboard')}</span>
          {#each shortcutHints() as hint (hint.id)}
            <span class="shortcut">{#each hint.keys as key (key)}<kbd>{key}</kbd>{' '}{/each}{hint.label}</span>
          {/each}
        </p>
      </InfoTip>
      {#if active}<Button variant="ghost" size="sm" onclick={clear}>{t('reviews:inbox.clear')}</Button>{/if}
    </form>

    {#if summaryLine}
      <p class="filter-summary muted" data-testid="filter-summary">
        {summaryLine}
        {#if filters.appIds.length > 0}<button type="button" class="bare link" onclick={() => change({ appIds: [] })}>{t('reviews:appFilter.all')}</button>{/if}
      </p>
    {/if}

    <div class="list" aria-busy={loading}>
      {#if problem}
        <Alert tone="error" title={t('reviews:inbox.loadFailed')}>{problem}</Alert>
        <div><Button icon="refresh" onclick={() => void loadList(true)}>{t('common:action.tryAgain')}</Button></div>
      {:else if loading && reviews.length === 0}
        <div role="status" aria-label={t('reviews:inbox.loading')}><Skeleton height="140px" /></div>
      {:else if reviews.length === 0}
        <div class="card">
          <EmptyState icon="filter" title={t('reviews:inbox.noMatch')} description={filters.appIds.length > 0 ? t('reviews:appFilter.emptyApps', { apps: chosenNames }) : t('reviews:inbox.noMatchHint')}>
            {#snippet actions()}
              {#if filters.appIds.length > 0}<Button onclick={() => change({ appIds: [] })}>{t('reviews:appFilter.all')}</Button>{/if}
              <Button onclick={clear}>{t('reviews:inbox.clear')}</Button>
            {/snippet}
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
              <li data-app-tint={tint.style(review.app.id) ? '' : undefined} style={tint.style(review.app.id) || undefined}>
                <p class="from">
                  <AppIcon name={review.app.name} url={iconUrls[review.app.id] ?? null} platform={review.app.platform} size="xs" labelled={true} />
                  <span class="app-name">{review.app.name}</span>
                  <PlatformBadge platform={review.app.platform} />
                  <a class="link sm" href={appReviewsHref(review.app.id)} title={t('reviews:split.openAppTitle')}>{t('reviews:split.openApp')}</a>
                  <span class="muted small">{timeAgo(review.createdAt, now)}</span>
                </p>
                <div class="neutral" data-tint-reset>
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
                </div>
              </li>
            {/each}
          </ul>
          {#if nextCursor}
            <div class="more-row"><Button loading={moreLoading} onclick={() => void loadList(false)}>{t('reviews:split.showMore')}</Button></div>
          {:else}
            <p class="muted small">{t('reviews:split.everyReview')}</p>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .keys {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-3);
  }

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

  .ratings {
    display: flex;
    flex-wrap: wrap;
    grid-column: 1 / -1;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .ratings legend {
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
    /* The app's colour at the start edge (a shadow: nothing moves). --app-accent exists only on a tinted row; otherwise it is transparent. */
    box-shadow: inset 3px 0 0 var(--app-accent, transparent);
    padding-inline-start: var(--space-3);
  }

  /* The review itself keeps the default accent: only the row's edge, the icon ring and the app name wear the app's colours. */
  .neutral {
    display: contents;
  }

  .from :global(.app-icon) {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 3px var(--app-accent, transparent);
  }

  .from .app-name {
    color: var(--app-accent-ink, inherit);
  }

  .filter-summary {
    margin: 0;
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
