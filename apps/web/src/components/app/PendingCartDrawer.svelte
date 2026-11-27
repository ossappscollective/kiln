<!--
  PendingCartDrawer: the right panel of the pending cart (docs/adr/0054-pending-cart.md). Everything that was prepared here and not
  sent yet, grouped by kind, one checkbox per row (the staged changes of a record are sent by one push, so they move together), select
  all, "Publish N selected" and "Discard selected" each behind an inline confirm that says how many and to which stores, and after a
  run one result per item. A row that cannot be sent is listed with its reason and cannot be selected. Nothing is published here that
  was not named: the confirm is the review.
  Price changes (docs/adr/0062-price-writes.md) are financial: the confirm names them, warns that stores take time to show a new price, and
  asks for a phrase typed by hand (`CHANGE 2 PRICES MAX 20%`, one per record); nothing is sent until it matches. A dry run reads the store and
  sends nothing. After a run each price says "confirmed by the store" or what the store shows instead.
  Props: open (bindable), rows, groupId, platform (the scope of the page, for the links), loading, error, busy, running (row keys being
  sent), outcomes and report (the last run), dryRun and dryBusy (the last dry run of the prices), onpublish (gets the selection and the typed
  phrases by record) / ondiscard (get the selection), ondryrun, onrefresh, ondismiss.
  A native <dialog> shown as a side panel (focus trap, Escape and the focus return come from the browser), like the other drawers.
-->
<script lang="ts">
  import type { Platform } from '@kiln/core';
  import { tick } from 'svelte';
  import { t } from '../../lib/i18n/t.ts';
  import type { Api } from '../../lib/api.ts';
  import type { LastPublish } from '../../lib/pending.ts';
  import { type Expanded, expansionOf, noneExpanded, PREVIEW_KEYS, pruneExpanded, toggleAll, toggleExpanded } from '../../lib/app-state/pending-facade.ts';
  import { issueText, money, samePhrase, verificationText } from '../../lib/prices.ts';
  import type { PriceDryRunItem } from '../../lib/types.ts';
  import { appAddress, type PlatformScope } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import type { Publishing } from '../../lib/publishing.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { openSubmitChecklist } from '../../lib/app-state/panel.svelte.ts';
  import FailureAnchor from '../app-state/FailureAnchor.svelte';
  import type { GuardedAction, Verdict } from '../../lib/app-state/types.ts';
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
    pricePhrases,
    prune,
    rowsForLocale,
    reasonText,
    resultText,
    reviewScope,
    RISK_KEYS,
    type Selection,
    selectAll,
    STATUS_KEYS,
    STORE_KEYS,
    tally,
    toggle,
  } from '../../lib/pending-cart.ts';
  import CartGraphicsDetail from './CartGraphicsDetail.svelte';
  import CartRowPreview from './CartRowPreview.svelte';
  import CartPriceDetail from './CartPriceDetail.svelte';
  import PublishFailure from '../publish/PublishFailure.svelte';
  import PublishingStatus from '../publish/PublishingStatus.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    rows,
    groupId,
    platform,
    loading,
    error,
    busy,
    running,
    report,
    focusLocale = null,
    publishing = [],
    failures = [],
    can,
    dryRun = null,
    dryBusy = false,
    onpublish,
    ondiscard,
    ondryrun,
    onreview,
    onrefresh,
    ondismiss,
    now,
  }: {
    open?: boolean | undefined;
    /** For the row previews (the detail of an item is read when its row is first expanded). */
    api: Api;
    workspaceId: string;
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
    /** The records of this app whose publish runs now: a status row each, and their rows (already marked) are "being published". */
    publishing?: readonly { appId: string; platform: Platform; entry: Publishing }[] | undefined;
    /** The last publish of a record that did not go through ("Last publish failed: ..."), until it is dismissed. */
    failures?: readonly { appId: string; run: LastPublish; name: string; platform: Platform }[] | undefined;
    /** What each action may do now (the state model's verdicts): Publish, Review and Discard are off with its reason. */
    can: (action: GuardedAction) => Verdict;
    /** The last dry run of price items (read only: nothing was sent). */
    dryRun?: { items: { key: string; title: string; item: PriceDryRunItem }[]; writesEnabled: boolean; failed: string } | null | undefined;
    dryBusy?: boolean | undefined;
    onpublish: (selection: Selection, confirmations: Readonly<Record<string, string>>) => void;
    ondiscard: (selection: Selection) => void;
    ondryrun: (selection: Selection) => void;
    onreview: (selection: Selection) => void;
    onrefresh: () => void;
    ondismiss: () => void;
    now: number;
  } = $props();

  const uid = $props.id();
  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;
  let selection = $state<Selection>(noSelection);
  let confirming = $state<'publish' | 'discard' | null>(null);
  /** Rows whose preview is open: collapsed by default, kept for the time the drawer is open. */
  let expanded = $state<Expanded>(noneExpanded);
  let confirmBox = $state<HTMLElement>();
  let reportBox = $state<HTMLElement>();
  /** What was typed for the price phrase, by record (a publish is one request per record, each with its own phrase). */
  let typed = $state<Record<string, string>>({});

  /** The verdicts of the three actions of the footer, from the state model (a publish that runs, a role, nothing to publish). */
  const pushVerdict = $derived(can('push'));
  const publishVerdict = $derived(can('publish'));
  const discardVerdict = $derived(can('discard'));
  const beingPublished = $derived(new Set(publishing.map((p) => p.appId)));
  const groups = $derived(groupRows(rows));
  const focused = $derived(focusLocale === null ? new Set<string>() : new Set(rowsForLocale(rows, focusLocale).map((r) => r.key)));
  const counts = $derived<CartCounts>(countsOf(rows, selection));
  const all = $derived(allState(rows, selection));
  const expansion = $derived(expansionOf(expanded, rows));
  const canDiscardSome = $derived(rows.some((r) => selection.has(r.key) && r.canDiscard));
  const hasStaged = $derived(rows.some((r) => r.bundle !== null));
  const sums = $derived(report ? tally(report.outcomes) : { ok: 0, failed: 0, skipped: 0 });
  const listed = $derived(report ? outcomeRows(report.rows, report.outcomes) : []);
  /** Why a whole request failed (the server's code and message), once, not on every row. */
  const details = $derived(report ? [...new Set(Object.values(report.outcomes).flatMap((o) => (o.detail ? [o.detail] : [])))] : []);
  /** Whether "Review and publish" has a staged change to plan (the selection, or everything when nothing is selected). */
  const review = $derived(reviewScope(rows, selection));
  const phrases = $derived(pricePhrases(rows, selection));
  const phraseOk = $derived(phrases.every((p) => samePhrase(typed[p.appId] ?? '', p.phrase)));
  const platformName = (appId: string) => {
    const p = rows.find((r) => r.appId === appId)?.platform;
    return p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : String(p ?? '');
  };
  const storeText = (list: readonly CartRow['store'][]) => list.map((s) => t(STORE_KEYS[s])).join(', ');

  // The list changes under a selection (a refresh, a run): keep what is still there.
  $effect(() => {
    selection = prune(rows, selection);
    if (selection.size === 0) confirming = null;
    expanded = pruneExpanded(expanded, rows);
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
    expanded = noneExpanded;
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
    typed = {};
    await tick();
    confirmBox?.querySelector('button')?.focus();
  }

  function go() {
    const kind = confirming;
    confirming = null;
    // The selection stays while the run is in flight (the button says how many are being sent); what was sent leaves the list, and the effect above drops it.
    if (kind === 'publish') onpublish(selection, phrases.length > 0 ? typed : {});
    else if (kind === 'discard') ondiscard(selection);
    typed = {};
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
        {#each publishing as p (p.appId)}
          <PublishingStatus publishing={p.entry} platform={p.platform} appId={p.appId} {workspaceId} canInterrupt />
        {/each}
        {#each failures as f (f.appId)}
          <FailureAnchor appId={f.appId}>
            <PublishFailure run={f.run} appName={f.name} platform={f.platform} blockers={f.blockers} oncheck={() => void appStateStore.checkAgain(api, workspaceId, f.appId)} onsubmit={() => openSubmitChecklist(f.appId)} ondismiss={() => appStateStore.dismissFailure(api, workspaceId, f.appId)} />
          </FailureAnchor>
        {/each}
        {#if report}
          <div class="report" role="status" tabindex="-1" bind:this={reportBox} data-testid="cart-report">
            <div class="report-head">
              <strong>{t('app:cart.report.summary', { ok: sums.ok, failed: sums.failed, skipped: sums.skipped })}</strong>
              <Button size="sm" variant="ghost" onclick={ondismiss}>{t('app:cart.report.dismiss')}</Button>
            </div>
            {#each details as detail (detail)}<p class="muted small" data-testid="cart-report-detail">{detail}</p>{/each}
            <ul>
              {#each listed as { row, outcome } (row.key)}
                <li>
                  <Badge tone={outcomeTone(outcome)}>{t(STATUS_KEYS[outcome.status])}</Badge>
                  <span class="r-title">{row.title}</span>
                  {#if outcome.status !== 'ok'}<span class="muted">{resultText(outcome.reason)}</span>{/if}
                  {#if outcome.price}
                    <span class="verify" class:good={outcome.price.verification === 'confirmed'}>{verificationText(outcome.price)}</span>
                    {#each outcome.price.lines.filter((l) => l.outcome === 'failed' || l.outcome === 'unknown') as l (l.territory)}
                      <span class="muted line-fail">{t('app:cart.price.lineFailed', { territory: l.territory, amount: money(l.after, l.currency), outcome: l.outcome === 'unknown' ? t('app:cart.price.lineUnknown') : t('app:cart.price.lineRefused') })}</span>
                    {/each}
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if dryRun}
          <div class="dry" role="status" data-testid="cart-dry-run">
            <strong>{t('app:cart.dryRun.title')}</strong>
            <p class="muted">{t('app:cart.dryRun.note')}</p>
            {#if dryRun.failed}<Alert tone="error">{dryRun.failed}</Alert>{/if}
            {#if !dryRun.writesEnabled}<Alert tone="warn">{t('app:cart.dryRun.switchOff')}</Alert>{/if}
            <ul>
              {#each dryRun.items as d (d.key)}
                <li>
                  <span class="r-title">{d.title}</span>
                  {#if d.item.error}
                    <Badge tone="bad">{t('app:cart.dryRun.error')}</Badge> <span>{d.item.error.message}</span>
                  {:else if d.item.issues.length > 0}
                    <Badge tone="bad">{t('app:cart.dryRun.refused')}</Badge>
                    <ul class="issues">{#each d.item.issues as issue}<li>{issueText(issue, d.item.summary.currencies[0])}</li>{/each}</ul>
                  {:else if d.item.preview}
                    <Badge tone="ok">{t('app:cart.dryRun.wouldSend')}</Badge>
                    <span class="muted">{d.item.preview.mode === 'store' ? t('app:cart.dryRun.storeChecked') : t('app:cart.dryRun.noStoreCheck')}</span>
                    {#if d.item.preview.mode === 'local'}
                      <ul class="issues">{#each d.item.preview.requests as r}<li><span class="mono">{r.method} {r.path}</span> {r.summary}</li>{/each}</ul>
                    {/if}
                  {/if}
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
          {#if publishing.length === 0}<p class="muted">{t('app:cart.empty')}</p>{/if}
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
          <div class="expand-all">
            <Button size="sm" variant="ghost" icon={expansion === 'all' ? 'chevron-up' : 'chevron-down'} onclick={() => (expanded = toggleAll(expanded, rows))}>
              {expansion === 'all' ? t('app:cart.preview.collapseAll') : t('app:cart.preview.expandAll')}
            </Button>
          </div>
          {#if hasStaged}<p class="muted note">{t('app:cart.bundleNote')}</p>{/if}

          {#each groups as group (group.kind)}
            <section aria-labelledby="{uid}-{group.kind}">
              <h3 id="{uid}-{group.kind}">{t(GROUP_KEYS[group.kind])} <span class="muted">({group.rows.length})</span></h3>
              <ul class="rows">
                {#each group.rows as row (row.key)}
                  {@const state = running.has(row.key) ? 'running' : null}
                  <li class="cart-row" class:blocked={!row.publishable} class:publishing={beingPublished.has(row.appId)} class:focused={focused.has(row.key)} data-row-key={row.key}>
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
                        <button
                          type="button"
                          class="ghost icon sm chevron"
                          aria-expanded={expanded.has(row.key)}
                          aria-controls="{uid}-{row.key}-p"
                          aria-label={t(PREVIEW_KEYS[expanded.has(row.key) ? 'collapse' : 'expand'], { title: row.title || t(GROUP_KEYS[row.kind]) })}
                          onclick={() => (expanded = toggleExpanded(expanded, row.key))}
                        >
                          <Icon name={expanded.has(row.key) ? 'chevron-up' : 'chevron-down'} />
                        </button>
                        <strong class="title">{row.title || t(GROUP_KEYS[row.kind])}</strong>
                        <Badge>{row.platform === 'ios' ? 'iOS' : row.platform === 'android' ? 'Android' : row.platform}</Badge>
                        {#if row.locale}<Badge>{row.locale}</Badge>{/if}
                        <Badge tone={row.risk === 'public_reply' || row.risk === 'financial' ? 'warn' : 'neutral'}>{t(RISK_KEYS[row.risk])}</Badge>
                        {#if state}<Badge tone="info" icon="refresh">{t(STATUS_KEYS.running)}</Badge>{:else if beingPublished.has(row.appId)}<Badge tone="info" icon="refresh">{t('publish:publishing.itemBadge')}</Badge>{/if}
                      </div>
                      <div id="{uid}-{row.key}-d" class="detail">
                        {#if row.review}
                          <p class="quote muted">{t('app:cart.reviewLine', { stars: stars(row.review.rating), excerpt: row.review.excerpt })}</p>
                        {/if}
                        {#if row.kind === 'price' && row.price}
                          <CartPriceDetail price={row.price} />
                        {:else if row.kind === 'graphics'}
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
                      {#if expanded.has(row.key)}
                        <CartRowPreview {api} {workspaceId} {row} id="{uid}-{row.key}-p" />
                      {/if}
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
              {#if counts.prices > 0}
                <div class="financial">
                  <p><strong>{t('app:cart.confirm.prices', { count: counts.prices })}</strong></p>
                  <p>{t('app:cart.confirm.pricesDelay')}</p>
                  {#each phrases as ph (ph.appId)}
                    <label class="phrase">
                      <span>{phrases.length > 1 ? t('app:cart.confirm.typeFor', { platform: platformName(ph.appId) }) : t('app:cart.confirm.type')} <code class="mono">{ph.phrase}</code></span>
                      <input
                        type="text"
                        autocomplete="off"
                        autocapitalize="characters"
                        spellcheck="false"
                        value={typed[ph.appId] ?? ''}
                        oninput={(e) => (typed = { ...typed, [ph.appId]: e.currentTarget.value })}
                        aria-invalid={(typed[ph.appId] ?? '') !== '' && !samePhrase(typed[ph.appId] ?? '', ph.phrase)}
                        data-testid="price-phrase"
                      />
                    </label>
                  {/each}
                </div>
              {/if}
              {#if counts.needsApproval}<p class="muted">{t('app:cart.confirm.approval')}</p>{/if}
              <div class="row">
                <Button variant="primary" disabled={!phraseOk} onclick={go}>{t('app:cart.confirm.go')}</Button>
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
              <Button variant="primary" loading={busy} disabled={busy || counts.selected === 0 || !pushVerdict.enabled} title={pushVerdict.reason ?? undefined} onclick={() => ask('publish')}>
                {t('app:cart.publish', { count: counts.selected })}
              </Button>
              <Button disabled={busy || review.none || !publishVerdict.enabled} title={publishVerdict.reason ?? undefined} onclick={() => onreview(selection)}>
                {t('app:cart.reviewAndPublish')}
              </Button>
              {#if counts.prices > 0}
                <Button loading={dryBusy} disabled={busy || dryBusy} onclick={() => ondryrun(selection)}>{t('app:cart.dryRun.button')}</Button>
              {/if}
              <Button variant="danger" disabled={busy || !canDiscardSome || !discardVerdict.enabled} title={discardVerdict.reason ?? undefined} onclick={() => ask('discard')}>{t('app:cart.discard')}</Button>
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

  .expand-all {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--space-2);
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

  .financial {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    border-radius: var(--radius-md);
    color: var(--warn-ink);
  }
  .financial p {
    margin: 0;
  }
  .phrase {
    display: grid;
    gap: var(--space-1);
  }
  .phrase input {
    width: 100%;
  }
  .dry {
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .dry p {
    margin: 0;
  }
  .dry ul,
  .issues {
    margin: 0;
    padding-left: var(--space-4);
  }
  .verify.good {
    color: var(--ok-ink);
  }
  .line-fail {
    display: block;
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
