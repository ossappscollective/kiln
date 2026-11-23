<!--
  PendingCartDrawer: the right panel of the pending cart (docs/adr/0054-pending-cart.md). Everything that was prepared here and not
  sent yet, grouped by kind, one checkbox per row (the staged changes of a record are sent by one push, so they move together), select
  all, "Publish N selected" and "Discard selected" each behind an inline confirm that says how many and to which stores, and after a
  run one result per item. A row that cannot be sent is listed with its reason and cannot be selected. Nothing is published here that
  was not named: the confirm is the review.
  Props: open (bindable), rows, groupId, platform (the scope of the page, for the links), loading, error, busy, running (row keys being
  sent), outcomes and report (the last run), onpublish / ondiscard (get the selection), onrefresh, ondismiss.
  A native <dialog> shown as a side panel (focus trap, Escape and the focus return come from the browser), like the other drawers.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { appAddress, type PlatformScope } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import {
    allState,
    type CartCounts,
    type CartOutcome,
    type CartRow,
    countsOf,
    GROUP_KEYS,
    groupRows,
    noSelection,
    type Outcomes,
    outcomeRows,
    placeOf,
    prune,
    rowsForLocale,
    reasonText,
    resultText,
    RISK_KEYS,
    type Selection,
    selectAll,
    STATUS_KEYS,
    STORE_KEYS,
    tally,
    toggle,
  } from '../../lib/pending-cart.ts';
  import CartGraphicsDetail from './CartGraphicsDetail.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    open = $bindable(false),
    rows,
    groupId,
    platform,
    loading,
    error,
    busy,
    running,
    report,
    focusLocale = null,
    onpublish,
    ondiscard,
    onrefresh,
    ondismiss,
    now,
  }: {
    open?: boolean | undefined;
    rows: readonly CartRow[];
    groupId: string;
    platform: PlatformScope | null;
    loading: boolean;
    error: string;
    busy: boolean;
    running: ReadonlySet<string>;
    report: { rows: CartRow[]; outcomes: Outcomes; kind: 'publish' | 'discard' } | null;
    /** Open scrolled to the items of this locale (from the "2 staged" chip of the listing grid), which are marked. */
    focusLocale?: string | null | undefined;
    onpublish: (selection: Selection) => void;
    ondiscard: (selection: Selection) => void;
    onrefresh: () => void;
    ondismiss: () => void;
    now: number;
  } = $props();

  const uid = $props.id();
  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;
  let selection = $state<Selection>(noSelection);
  let confirming = $state<'publish' | 'discard' | null>(null);
  let confirmBox = $state<HTMLElement>();
  let reportBox = $state<HTMLElement>();

  const groups = $derived(groupRows(rows));
  const focused = $derived(focusLocale === null ? new Set<string>() : new Set(rowsForLocale(rows, focusLocale).map((r) => r.key)));
  const counts = $derived<CartCounts>(countsOf(rows, selection));
  const all = $derived(allState(rows, selection));
  const canDiscardSome = $derived(rows.some((r) => selection.has(r.key) && r.canDiscard));
  const hasStaged = $derived(rows.some((r) => r.bundle !== null));
  const sums = $derived(report ? tally(report.outcomes) : { ok: 0, failed: 0, skipped: 0 });
  const listed = $derived(report ? outcomeRows(report.rows, report.outcomes) : []);
  const storeText = (list: readonly CartRow['store'][]) => list.map((s) => t(STORE_KEYS[s])).join(', ');

  // The list changes under a selection (a refresh, a run): keep what is still there.
  $effect(() => {
    selection = prune(rows, selection);
    if (selection.size === 0) confirming = null;
  });

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Opened from a locale's "N staged" chip: bring the first of its items into view.
  $effect(() => {
    const key = open ? [...focused][0] : undefined;
    if (key === undefined) return;
    void tick().then(() => {
      const el = [...(dialog?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find((e) => e.dataset.rowKey === key);
      el?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  });

  // After a run the result is announced and read first: focus goes to it.
  $effect(() => {
    if (report) void tick().then(() => reportBox?.focus());
  });

  function handleClose() {
    open = false;
    confirming = null;
    opener?.focus();
    opener = null;
  }

  // A run in flight is not dismissed by Escape: its result would be lost.
  function handleCancel(event: Event) {
    if (busy) event.preventDefault();
  }

  function handleClick(event: MouseEvent) {
    if (event.target === dialog && !busy) open = false;
  }

  async function ask(kind: 'publish' | 'discard') {
    confirming = kind;
    await tick();
    confirmBox?.querySelector('button')?.focus();
  }

  function go() {
    const kind = confirming;
    confirming = null;
    if (kind === 'publish') onpublish(selection);
    else if (kind === 'discard') ondiscard(selection);
    selection = noSelection;
  }

  const outcomeTone = (o: CartOutcome) => (o.status === 'ok' ? 'ok' : o.status === 'failed' ? 'bad' : 'warn');
  const stars = (n: number) => t('app:cart.stars', { count: n });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="cart-drawer"
  aria-labelledby="{uid}-title"
  onclose={handleClose}
  oncancel={handleCancel}
  onclick={handleClick}
  data-testid="pending-cart"
>
  {#if open}
    <div class="surface" aria-busy={busy}>
      <header>
        <div>
          <h2 id="{uid}-title">{t('app:cart.title')}</h2>
          <p class="muted">{t('app:cart.intro')}</p>
        </div>
        <button type="button" class="ghost icon sm" aria-label={t('common:action.close')} disabled={busy} onclick={() => (open = false)}>
          <Icon name="x" />
        </button>
      </header>

      <div class="body">
        {#if report}
          <div class="report" role="status" tabindex="-1" bind:this={reportBox} data-testid="cart-report">
            <div class="report-head">
              <strong>{t('app:cart.report.summary', { ok: sums.ok, failed: sums.failed, skipped: sums.skipped })}</strong>
              <Button size="sm" variant="ghost" onclick={ondismiss}>{t('app:cart.report.dismiss')}</Button>
            </div>
            <ul>
              {#each listed as { row, outcome } (row.key)}
                <li>
                  <Badge tone={outcomeTone(outcome)}>{t(STATUS_KEYS[outcome.status])}</Badge>
                  <span class="r-title">{row.title}</span>
                  {#if outcome.status !== 'ok'}<span class="muted">{resultText(outcome.reason)}</span>{/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if loading && rows.length === 0}
          <div class="stack" role="status" aria-label={t('app:cart.title')}>
            <Skeleton width="100%" height="56px" />
            <Skeleton width="100%" height="56px" />
          </div>
        {:else if error && rows.length === 0}
          <div class="stack">
            <Alert tone="error">{error}</Alert>
            <div><Button icon="refresh" onclick={onrefresh}>{t('common:action.tryAgain')}</Button></div>
          </div>
        {:else if rows.length === 0}
          <p class="muted">{t('app:cart.empty')}</p>
        {:else}
          <label class="check all">
            <input
              type="checkbox"
              checked={all === 'all'}
              indeterminate={all === 'some'}
              disabled={busy || counts.selectable === 0}
              onchange={() => (selection = all === 'all' ? noSelection : selectAll(rows))}
            />
            <span>{t('app:cart.selectAll')}</span>
            <span class="muted count" aria-live="polite">{t('app:cart.selectedCount', { selected: counts.selected, total: counts.selectable })}</span>
          </label>
          {#if hasStaged}<p class="muted note">{t('app:cart.bundleNote')}</p>{/if}

          {#each groups as group (group.kind)}
            <section aria-labelledby="{uid}-{group.kind}">
              <h3 id="{uid}-{group.kind}">{t(GROUP_KEYS[group.kind])} <span class="muted">({group.rows.length})</span></h3>
              <ul class="rows">
                {#each group.rows as row (row.key)}
                  {@const state = running.has(row.key) ? 'running' : null}
                  <li class="cart-row" class:blocked={!row.publishable} class:focused={focused.has(row.key)} data-row-key={row.key}>
                    <label class="pick">
                      <input
                        type="checkbox"
                        checked={selection.has(row.key)}
                        disabled={busy || !row.publishable}
                        onchange={() => (selection = toggle(rows, selection, row.key))}
                        aria-describedby="{uid}-{row.key}-d"
                      />
                      <span class="visually-hidden">{row.title || t(GROUP_KEYS[row.kind])}</span>
                    </label>
                    <div class="main">
                      <div class="line">
                        <strong class="title">{row.title || t(GROUP_KEYS[row.kind])}</strong>
                        <Badge>{row.platform === 'ios' ? 'iOS' : row.platform === 'android' ? 'Android' : row.platform}</Badge>
                        {#if row.locale}<Badge>{row.locale}</Badge>{/if}
                        <Badge tone={row.risk === 'public_reply' ? 'warn' : 'neutral'}>{t(RISK_KEYS[row.risk])}</Badge>
                        {#if state}<Badge tone="info" icon="refresh">{t(STATUS_KEYS.running)}</Badge>{/if}
                      </div>
                      <div id="{uid}-{row.key}-d" class="detail">
                        {#if row.review}
                          <p class="quote muted">{t('app:cart.reviewLine', { stars: stars(row.review.rating), excerpt: row.review.excerpt })}</p>
                        {/if}
                        {#if row.kind === 'graphics'}
                          <CartGraphicsDetail files={row.counts.files ?? 0} before={row.counts.before ?? null} thumbs={row.thumbs ?? []} />
                        {:else if row.summary !== null}
                          <p class="diff">
                            {#if row.before !== null}
                              {t('app:cart.diff', { before: row.before, after: row.summary })}
                            {:else}
                              {t('app:cart.diffNew', { after: row.summary })}
                            {/if}
                          </p>
                        {/if}
                        {#each row.problems.filter((p) => p.severity === 'error') as p}
                          <p class="problem">{t('app:cart.fixFirst', { message: p.message })}</p>
                        {/each}
                        {#if !row.publishable && row.reason}
                          <p class="reason">{reasonText(row.reason.code)}</p>
                        {/if}
                      </div>
                      <p class="meta muted">
                        {#if row.author?.name}{row.author.name} · {/if}{timeAgo(row.createdAt, now)} ·
                        <a href={placeOf(row, groupId, platform)} onclick={() => (open = false)} aria-label={t('app:cart.openRow', { title: row.title || t(GROUP_KEYS[row.kind]) })}>{t('app:cart.open')}</a>
                      </p>
                    </div>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
          <p class="muted note"><a href={appAddress(groupId, 'pending', platform)} onclick={() => (open = false)}>{t('app:cart.publishPage')}</a> {t('app:cart.publishPageHint')}</p>
        {/if}
      </div>

      {#if rows.length > 0}
        <footer>
          {#if confirming === 'publish'}
            <div class="confirm" role="group" bind:this={confirmBox} aria-label={t('app:cart.confirm.publishTitle', { count: counts.selected })}>
              <strong>{t('app:cart.confirm.publishTitle', { count: counts.selected })}</strong>
              {#if counts.drafts > 0}<p>{t('app:cart.confirm.drafts', { count: counts.drafts, stores: storeText(counts.draftStores) })}</p>{/if}
              {#if counts.replies > 0}<p>{t('app:cart.confirm.replies', { count: counts.replies, stores: storeText(counts.replyStores) })}</p>{/if}
              {#if counts.needsApproval}<p class="muted">{t('app:cart.confirm.approval')}</p>{/if}
              <div class="row">
                <Button variant="primary" onclick={go}>{t('app:cart.confirm.go')}</Button>
                <Button onclick={() => (confirming = null)}>{t('common:action.cancel')}</Button>
              </div>
            </div>
          {:else if confirming === 'discard'}
            <div class="confirm" role="group" bind:this={confirmBox} aria-label={t('app:cart.confirm.discardTitle', { count: counts.selected })}>
              <strong>{t('app:cart.confirm.discardTitle', { count: counts.selected })}</strong>
              <p>{t('app:cart.confirm.discardBody')}</p>
              <div class="row">
                <Button variant="danger-solid" onclick={go}>{t('app:cart.confirm.discardGo')}</Button>
                <Button onclick={() => (confirming = null)}>{t('common:action.cancel')}</Button>
              </div>
            </div>
          {:else}
            <div class="row actions">
              <Button variant="primary" loading={busy} disabled={busy || counts.selected === 0} onclick={() => ask('publish')}>
                {t('app:cart.publish', { count: counts.selected })}
              </Button>
              <Button variant="danger" disabled={busy || !canDiscardSome} onclick={() => ask('discard')}>{t('app:cart.discard')}</Button>
            </div>
          {/if}
        </footer>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  dialog.cart-drawer {
    width: min(560px, 100%);
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    padding: 0;
    margin: 0 0 0 auto;
    overflow: hidden;
    color: var(--ink);
    background: var(--surface);
    border: 0;
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
  }

  dialog.cart-drawer[open] {
    animation: cart-slide var(--duration-slow) var(--ease);
  }

  dialog.cart-drawer::backdrop {
    background: var(--scrim);
  }

  /* Header and footer fixed, .body the one scroll container: min-height 0 lets a flex child shrink below its content so it can scroll. */
  .surface {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
    flex: none;
    padding: var(--space-5);
    border-bottom: 1px solid var(--line);
  }

  header h2 {
    font-size: var(--text-lg);
  }

  header p {
    margin: var(--space-1) 0 0;
    font-size: 0.9375rem;
  }

  .body {
    flex: 1;
    min-height: 0;
    padding: var(--space-4) var(--space-5) var(--space-6);
    overflow: auto;
    overscroll-behavior: contain;
    scroll-padding: var(--space-5);
  }

  .body > :global(*) {
    flex-shrink: 0;
  }

  footer {
    flex: none;
    padding: var(--space-4) var(--space-5) calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    background: var(--surface);
    border-top: 1px solid var(--line);
  }

  .actions,
  .confirm .row {
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .confirm p {
    margin: var(--space-1) 0;
  }

  .check.all {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-2);
  }

  .count {
    margin-left: auto;
    font-size: var(--text-sm);
  }

  .note {
    margin: 0 0 var(--space-4);
    font-size: var(--text-sm);
  }

  section {
    margin-top: var(--space-5);
  }

  h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .rows,
  .report ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .cart-row {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }

  /* The items of the locale the drawer was opened for: a tint and a stripe (never colour alone). */
  .cart-row.focused {
    padding-inline: var(--space-3);
    background: var(--accent-bg);
    border-radius: var(--radius-md);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .cart-row.blocked .title {
    color: var(--muted);
  }

  .pick {
    display: flex;
    padding-top: var(--space-1);
  }

  .main {
    flex: 1;
    min-width: 0;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .detail p,
  .meta {
    margin: var(--space-1) 0 0;
    overflow-wrap: anywhere;
  }

  .diff,
  .quote {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .problem,
  .reason {
    color: var(--warn-ink);
  }

  .meta {
    font-size: var(--text-sm);
  }

  .report {
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .report-head {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .report li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2) 0 0;
  }

  .r-title {
    font-weight: 500;
  }

  @keyframes cart-slide {
    from {
      opacity: 0;
      transform: translateX(24px);
    }
  }
</style>
