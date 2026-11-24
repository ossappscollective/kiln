<!--
  ReviewSplit: the reviews as a dense list on the left and the selected review in full on the right, for
  wide screens (lib/review-split.ts; narrow screens keep the card list of their own screen).
  Props: api, workspaceId, role, reviews (the loaded list, in order), appName (the app of every review, for
  the per-app tab; the inbox sets `app` on each review instead), showApp (a line with the app in each row),
  iconUrls, members, canTriage, replyConfig, lowThreshold, now (ms), translations / ontranslate /
  showTranslations (kept by the Reviews tab), settled (false while the list is being read again: the address
  is not rewritten then), hasMore, moreLoading, onmore (read the next page), onsearch (the `/` key), onchange
  (a review changed: the triage or reply of the card), showKeys, compact (800 to 1100 px wide: the list takes the whole width and the
  selected review opens as a drawer from the right when a row is chosen; Escape or Close shuts it, j and k keep moving while it is open).

  The selection is kept in the address (`?review=<id>`), so a link opens on that review and a reload keeps
  it. It is the first review until one is chosen, and it survives a triage or a re-read. If the address asks for
  a review that is further down, the next pages are read (a few) to find it.
  Keyboard (the shortcuts of lib/reviews.ts): j and k or the arrows move, Enter opens the review (focus goes
  to it), t marks it triaged, r opens its reply dialog, / goes to the search box. Nothing fires while typing or
  while a dialog is open. The detail is the ordinary ReviewCard: its triage form, translation and reply dialog
  (draft, check, confirmation) are unchanged. Nothing here sends or changes anything by itself.

  Review text is written by customers: plain text only, never markup, never in a URL.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { tint } from '../../lib/tint/store.svelte.ts';
  import type { Role } from '@kiln/core';
  import { onMount, tick, untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
  import type { ReplyConfig } from '../../lib/reviews/reply.ts';
  import type { ReviewTranslation } from '../../lib/reviews/translation.ts';
  import {
    isReviewsAddress,
    appReviewHref,
    moveSelection,
    resolveSelection,
    reviewFromHash,
    rowByline,
    rowDate,
    shortcutHints,
    rowReplyText,
    rowTitle,
    shouldFindMore,
    shouldWriteAddress,
    rowDotTone,
    withReview,
  } from '../../lib/reviews/split.ts';
  import {
    type InboxApp,
    type Review,
    isLowRating,
    ratingText,
    shortcutFor,
    statusLabel,
  } from '../../lib/reviews/reviews.ts';
  import { platformById } from '../../lib/stores.ts';
  import type { Member } from '../../lib/types.ts';
  import AppIcon from '../ui/AppIcon.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import ReviewCard from './ReviewCard.svelte';

  type SplitReview = Review & { app?: InboxApp };

  let {
    api,
    workspaceId,
    role,
    reviews,
    appName = '',
    showApp = false,
    iconUrls = {},
    members,
    canTriage,
    replyConfig = null,
    lowThreshold,
    now,
    translations = {},
    ontranslate = undefined,
    showTranslations = true,
    settled = true,
    hasMore,
    moreLoading,
    onmore,
    onsearch = undefined,
    onchange,
    showKeys = true,
    compact = false,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    reviews: SplitReview[];
    appName?: string | undefined;
    showApp?: boolean | undefined;
    iconUrls?: Record<string, string | null> | undefined;
    members: Member[];
    canTriage: boolean;
    replyConfig?: ReplyConfig | null | undefined;
    lowThreshold: number;
    now: number;
    translations?: Record<string, ReviewTranslation | undefined>;
    ontranslate?: ((t: ReviewTranslation) => void) | undefined;
    showTranslations?: boolean | undefined;
    settled?: boolean | undefined;
    hasMore: boolean;
    moreLoading: boolean;
    onmore: () => void;
    onsearch?: (() => void) | undefined;
    onchange: (updated: Review) => void;
    showKeys?: boolean | undefined;
    compact?: boolean | undefined;
  } = $props();

  const uid = $props.id();

  let root = $state<HTMLElement>();
  let listEl = $state<HTMLElement>();
  let detailEl = $state<HTMLElement>();
  let card = $state<ReviewCard>();
  /** Compact only: the drawer with the selected review is open. */
  let drawerOpen = $state(false);
  /** The review the address asked for, or the one chosen last. Resolved against the list below. */
  const asked = isReviewsAddress(location.hash) ? reviewFromHash(location.hash) : null;
  let wanted = $state<string | null>(asked);
  /** True while the review the address asked for is looked for (it may be further down the list than the first page). */
  let seeking = $state(asked !== null);
  /** Pages read only to find the asked review. */
  let findPages = 0;

  const ids = $derived(reviews.map((r) => r.id));
  const selectedId = $derived(resolveSelection(ids, wanted));
  const selected = $derived(reviews.find((r) => r.id === selectedId) ?? null);

  /** A tab of the other platform is mounted but hidden: it never answers keys or rewrites the address. */
  const isVisible = (): boolean => root !== undefined && root.isConnected && root.closest('[hidden]') === null;

  function choose(id: string, focusRow: boolean) {
    findPages = 0;
    seeking = false;
    wanted = id;
    writeAddress(id);
    if (focusRow) void focusRowOf(id);
  }

  function writeAddress(id: string | null) {
    if (!isReviewsAddress(location.hash)) return;
    const next = withReview(location.hash, id);
    // replaceState: no history entry for each review, and no hashchange for the shell to handle.
    if (next !== location.hash) history.replaceState(history.state, '', next);
  }

  function rowOf(id: string): HTMLElement | null {
    return listEl?.querySelector<HTMLElement>(`[data-review="${CSS.escape(id)}"]`) ?? null;
  }

  /** Scrolls the list (not the page) just enough to show the row. */
  function reveal(id: string) {
    const item = rowOf(id)?.parentElement;
    if (!listEl || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (bottom > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bottom - listEl.clientHeight;
  }

  async function focusRowOf(id: string) {
    await Promise.resolve();
    rowOf(id)?.focus({ preventScroll: true });
  }

  function focusDetail() {
    detailEl?.querySelector<HTMLElement>('article')?.focus();
  }

  /** Compact only: shows the selected review in the drawer and puts focus in it. */
  async function openDrawer() {
    if (!compact) return;
    drawerOpen = true;
    await tick();
    focusDetail();
  }

  function closeDrawer() {
    drawerOpen = false;
    if (selectedId !== null) void focusRowOf(selectedId);
  }

  // Leaving the compact layout (the window grew) closes the drawer, so the side by side view starts clean.
  $effect(() => {
    if (!compact) drawerOpen = false;
  });

  // The first review is the selection until one is chosen: make the address say so, once the list is settled
  // and the asked review is not still being looked for.
  $effect(() => {
    if (root === undefined) return;
    const id = selectedId;
    const inAddress = isReviewsAddress(location.hash) ? reviewFromHash(location.hash) : null;
    if (!seeking && shouldWriteAddress(id, inAddress, settled) && untrack(isVisible)) writeAddress(id);
  });

  // The address asks for a review that is further down the list: read a few more pages to find it. When it is
  // found, or not there, the selection is whatever the list has (a review that left the list, after a filter
  // changed, is replaced by the first one for good).
  $effect(() => {
    if (!settled || root === undefined) return;
    if (!seeking) {
      if (selectedId !== null && selectedId !== wanted) wanted = selectedId;
      return;
    }
    if (selectedId === wanted || !untrack(isVisible)) {
      seeking = false;
      return;
    }
    if (moreLoading) return;
    if (shouldFindMore(ids, wanted, hasMore, findPages)) {
      findPages += 1;
      untrack(onmore);
    } else {
      seeking = false;
    }
  });

  // A new selection shows from its top, and the list shows its row.
  $effect(() => {
    const id = selectedId;
    if (id === null) return;
    untrack(() => {
      if (detailEl) detailEl.scrollTop = 0;
      reveal(id);
    });
  });

  onMount(() => {
    // A link followed while this screen is open (a review in a notification, another review of the inbox).
    const onhash = () => {
      if (!isReviewsAddress(location.hash)) return;
      const next = reviewFromHash(location.hash);
      if (next !== null && next !== wanted) {
        findPages = 0;
        seeking = true;
        wanted = next;
      }
    };
    window.addEventListener('hashchange', onhash);
    return () => window.removeEventListener('hashchange', onhash);
  });

  // ----- keyboard ----------------------------------------------------------------------------

  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || target.closest('dialog') !== null;
  }

  function onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || !isVisible() || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && compact && drawerOpen) {
      event.preventDefault();
      closeDrawer();
      return;
    }
    const action = shortcutFor({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      typing: isTyping(event.target),
    });
    if (!action) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inList = target !== null && listEl !== undefined && listEl.contains(target);
    // The arrow keys and Home and End scroll the page: they only move between reviews from inside the list.
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') && !inList) return;
    if (action === 'search') {
      if (!onsearch) return;
      event.preventDefault();
      onsearch();
    } else if (action === 'triage' || action === 'reply') {
      if (!selected) return;
      event.preventDefault();
      if (action === 'triage') void card?.markTriaged();
      else card?.openReply();
    } else {
      event.preventDefault();
      const next = moveSelection(ids, selectedId, action);
      if (next !== null) choose(next, inList);
      // Past the last loaded review: read the next page, as the button below does.
      if (action === 'next' && next === selectedId && hasMore && !moreLoading) onmore();
    }
  }

  function onRowKey(event: KeyboardEvent, id: string) {
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    choose(id, false);
    if (compact) void openDrawer();
    else focusDetail();
  }

  const appNameOf = (review: SplitReview): string => review.app?.name ?? appName;
</script>

<svelte:window onkeydown={onKey} />

<div class="split" class:compact bind:this={root}>
  <div class="pane list-pane" bind:this={listEl}>
    <ul class="rows" aria-label={t('reviews:split.list')}>
      {#each reviews as review (review.id)}
        {@const current = review.id === selectedId}
        {@const reply = rowReplyText(review)}
        {@const byline = rowByline(review)}
        {@const rowTint = showApp && review.app ? tint.style(review.app.id) : ''}
        <li class="item" class:current data-app-tint={rowTint ? '' : undefined} style={rowTint || undefined}>
          <button
            type="button"
            class="row"
            data-review={review.id}
            aria-current={current ? 'true' : undefined}
            onclick={() => {
              choose(review.id, false);
              void openDrawer();
            }}
            onkeydown={(event) => onRowKey(event, review.id)}
          >
            <span class="line">
              <span class="stars" role="img" aria-label={ratingText(review.rating)}>
                {#each [1, 2, 3, 4, 5] as n (n)}<Icon name={n <= review.rating ? 'star-filled' : 'star'} size={12} />{/each}
              </span>
              <span class="title" class:unread={review.status === 'new'}>{rowTitle(review)}</span>
              <time class="when" datetime={new Date(review.createdAt).toISOString()} title={fullTime(review.createdAt)}>{rowDate(review.createdAt, now)}</time>
            </span>
            <span class="line sub">
              <span class="dot {rowDotTone(review)}" aria-hidden="true"></span>
              <span class="status">{statusLabel(review.status)}</span>
              {#if reply}<span class="reply">{reply}</span>{/if}
              <span class="by" title={review.authorName ?? ''}>{byline}</span>
              <Badge>{platformById(review.platform).label}</Badge>
            </span>
            {#if showApp && review.app}
              <span class="line sub appline">
                <AppIcon name={review.app.name} url={iconUrls[review.app.id] ?? null} platform={review.app.platform} size="xs" labelled={true} />
                <span class="by">{review.app.name}</span>
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
    <div class="foot">
      {#if hasMore}
        <Button size="sm" loading={moreLoading} onclick={onmore}>{t('reviews:split.showMore')}</Button>
      {:else}
        <p class="muted small">{t('reviews:split.everyReview')}</p>
      {/if}
      {#if showKeys}
        <p class="hint keys">
          {#each shortcutHints() as hint (hint.id)}
            <span class="shortcut">{#each hint.keys as key (key)}<kbd>{key}</kbd>{' '}{/each}{hint.label}</span>
          {/each}
        </p>
      {/if}
    </div>
  </div>

  <div class="pane detail-pane" class:drawer={compact} hidden={compact && !drawerOpen} bind:this={detailEl} aria-label={t('reviews:split.selected')} role="region" id="{uid}-detail">
    {#if compact}
      <div class="drawer-head">
        <span class="muted small">{t('reviews:split.review')}</span>
        <Button size="sm" variant="ghost" icon="x" aria-label={t('reviews:split.closeReview')} onclick={closeDrawer}>{t('common:action.close')}</Button>
      </div>
    {/if}
    {#if selected}
      {#key selected.id}
        {#if selected.app}
          <p class="from">
            <AppIcon name={selected.app.name} url={iconUrls[selected.app.id] ?? null} platform={selected.app.platform} size="xs" labelled={true} />
            <span class="app-name">{selected.app.name}</span>
            <a class="link sm" href={appReviewHref(selected.app.id, selected.id, selected.app.platform)} title={t('reviews:split.openAppTitle')}>{t('reviews:split.openApp')}</a>
          </p>
        {/if}
        <ReviewCard
          bind:this={card}
          full={true}
          {api}
          {workspaceId}
          appId={selected.app?.id ?? selected.appId}
          appName={appNameOf(selected)}
          {role}
          {replyConfig}
          review={selected}
          {members}
          {canTriage}
          {lowThreshold}
          {now}
          translation={translations[selected.id]}
          {ontranslate}
          {showTranslations}
          {onchange}
        />
      {/key}
    {/if}
  </div>
</div>

<style>
  .keys {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-3);
  }

  .split {
    display: grid;
    grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  /* Both columns stay in view and scroll on their own, so the list and the review are side by side. */
  .pane {
    position: sticky;
    top: var(--space-3);
    max-height: calc(100vh - var(--space-8));
    overflow-y: auto;
  }

  .list-pane {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .split.compact {
    grid-template-columns: minmax(0, 1fr);
  }

  .split.compact .list-pane {
    position: static;
    max-height: none;
    overflow: visible;
  }

  /* 800 to 1100 px: the review opens from the right over the list, which keeps its whole width. */
  .detail-pane.drawer {
    position: fixed;
    inset: 0 0 0 auto;
    z-index: var(--z-overlay);
    width: min(34rem, 94vw);
    max-height: none;
    padding: var(--space-4);
    background: var(--surface);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
  }

  .detail-pane[hidden] {
    display: none;
  }

  .drawer-head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }

  .detail-pane {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    min-width: 0;
    border-bottom: 1px solid var(--line);
    /* In the inbox a row wears its app's colour at the start edge (--app-accent exists only on a tinted row). */
    border-left: 3px solid var(--app-accent, transparent);
  }

  .appline :global(.app-icon) {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 3px var(--app-accent, transparent);
  }

  .appline .by {
    color: var(--app-accent-ink, inherit);
  }

  .item.current {
    background: var(--accent-bg);
    border-left-color: var(--accent);
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: stretch;
    width: 100%;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;
  }

  .row:hover {
    background: var(--surface-sunken);
  }

  .item.current .row:hover {
    background: transparent;
  }

  .line {
    box-sizing: border-box;
    display: flex;
    width: 100%;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .sub {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .stars {
    display: inline-flex;
    flex: none;
    color: var(--warn);
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title.unread {
    font-weight: var(--weight-semibold);
  }

  .when {
    flex: none;
    font-size: var(--text-sm);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    background: var(--muted);
    border-radius: var(--radius-full);
  }

  .dot.info {
    background: var(--info);
  }

  .dot.ok {
    background: var(--ok);
  }

  .dot.none {
    background: transparent;
  }

  .status,
  .reply {
    flex: none;
    white-space: nowrap;
  }

  .reply::before {
    content: '· ';
  }

  .by {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .appline .by {
    text-align: left;
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-3);
  }

  .foot p {
    margin: 0;
  }

  .small {
    font-size: var(--text-sm);
  }

  .from {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .app-name {
    font-weight: 600;
    overflow-wrap: anywhere;
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
