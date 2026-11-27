<!--
  PendingCart: the pending changes of an app (docs/adr/0054-pending-cart.md) and the work behind them. The button is in the top bar
  (PendingCartButton, next to the account menu): this component only feeds it the UI plumbing (`cartButton`: pulse, open state, how to
  open the drawer) and clears it when the app is left; what the button SAYS comes from the state model (`appStateStore`). Hidden with none (and on the pending page, which is the review). It opens the right drawer (PendingCartDrawer).
  When a page stages something (`announceCartAdded`), the button pulses once (not with reduced motion) and a toast says "Added to pending changes".
  The count is announced politely.
  Nothing is sent without the drawer's confirm; publish and discard go through the server's per item routes, one request per record.
  Props: api, workspaceId, role, groupId (the app in the address), members (the records in the page's platform scope: the drawer covers
  exactly what the top bar counts), platform (the page scope).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { type Role } from '@kiln/core';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { PUBLISH_AGAIN_EVENT, stepsToRepeat } from '../../lib/app-state/actions.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { cartButton, resetCartButton } from '../../lib/cart-button.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    CART_ADDED_EVENT,
    CART_OPEN_EVENT,
    type CartRow,
    takeQueuedCartOpen,
    discardRequests,
    failAll,
    markBeingPublished,
    mergeResults,
    type Outcomes,
    publishRequests,
    reviewScope,
    type Selection,
    selectedRows,
    toRows,
  } from '../../lib/pending-cart.ts';
  import { PUBLISHED_EVENT } from '../../lib/app-page.ts';
  import type { StepRequest } from '../../lib/pending.ts';
  import { onInvalidated } from '../../lib/facts/invalidate.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { classifyPriceFailure } from '../../lib/prices.ts';
  import type { AppSummary, PriceDryRunItem } from '../../lib/types.ts';
  import PublishDialog from '../publish/PublishDialog.svelte';
  import PendingCartDrawer from './PendingCartDrawer.svelte';

  let {
    api,
    workspaceId,
    role,
    groupId,
    members,
    platform,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    groupId: string;
    members: readonly AppSummary[];
    platform: PlatformScope | null;
  } = $props();

  let rows = $state<CartRow[]>([]);
  let loading = $state(false);
  let error = $state('');
  let open = $state(false);
  let focusLocale = $state<string | null>(null);
  let busy = $state(false);
  let running = $state<ReadonlySet<string>>(new Set());
  let report = $state<{ rows: CartRow[]; outcomes: Outcomes; kind: 'publish' | 'discard' } | null>(null);
  let announce = $state('');
  /** The last dry run of the price items: what the store says about them. Read only; nothing was sent. */
  let dryRun = $state<{ items: { key: string; title: string; item: PriceDryRunItem }[]; writesEnabled: boolean; failed: string } | null>(null);
  let dryBusy = $state(false);
  let now = $state(Date.now());
  let generation = 0;
  let loadedOnce = false;
  let lastToast = 0;

  const ids = $derived(members.map((m) => m.id));
  /** What is true about the records of the drawer (the state model): which publish runs, which failed, what each action may do. */
  const appState = $derived(appStateStore.of({ workspaceId, role, records: members, scope: 'both' }));
  /** The records whose publish runs now: their items are being written. */
  const publishing = $derived(appState.publishing);
  /** A publish that did not go through and has ended: its one line, until dismissed or a new publish starts. */
  const failures = $derived(appState.failures);
  const shownRows = $derived(markBeingPublished(rows, new Set(publishing.map((p) => p.appId))));
  const count = $derived(appState.pendingCount);
  // Each step that starts or ends changes what the cart holds (the pushed items leave it): read it again, once per change.
  let stepKey = '';
  $effect(() => {
    const key = publishing.map((p) => `${p.appId}:${p.entry.currentStep ?? ''}:${p.entry.stepStartedAt ?? ''}`).join('|');
    if (key === stepKey) return;
    const first = stepKey === '';
    stepKey = key;
    if (!first && key !== '') untrack(() => void refresh());
  });

  async function refresh(): Promise<void> {
    const mine = ++generation;
    loading = true;
    try {
      const lists = await Promise.all(ids.map(async (id) => toRows(id, (await api.appPendingCart(workspaceId, id)).cart.items)));
      if (mine !== generation) return;
      rows = lists.flat();
      error = '';
      now = Date.now();
    } catch (e) {
      if (mine !== generation) return;
      error = e instanceof ApiError ? e.message : t('app:cart.loadFailed');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  // Read the cart for these records on mount and whenever the app's records change.
  $effect(() => {
    void ids.join(',');
    loadedOnce = false;
    rows = [];
    // Another app: nothing of the previous one (open drawer, report, dry run, error, running rows) is carried over.
    open = false;
    error = '';
    report = null;
    dryRun = null;
    running = new Set();
    focusLocale = null;
    announce = '';
    untrack(() => {
      // Only once the records are known: before that the effect would use the request up and the reset above would close the drawer again.
      if (ids.length > 0 && takeQueuedCartOpen(groupId)) open = true;
      void refresh();
    });
  });

  // A polite announcement of the count, but not the first load.
  $effect(() => {
    const n = count;
    untrack(() => {
      if (loadedOnce) announce = t('app:cart.countAnnounce', { count: n });
      if (!loading) loadedOnce = true;
    });
  });

  $effect(() => {
    cartButton.expanded = open;
  });
  $effect(() => {
    cartButton.appIds = ids;
  });
  $effect(() => {
    cartButton.press = () => {
      focusLocale = null;
      open = true;
    };
    return resetCartButton;
  });

  onMount(() => {
    const onAdded = () => {
      void refresh().then(() => {
        cartButton.pulse = false;
        requestAnimationFrame(() => (cartButton.pulse = true));
        setTimeout(() => (cartButton.pulse = false), 900);
        const at = Date.now();
        if (at - lastToast > 2500 && !open) {
          lastToast = at;
          toast.success(t('app:cart.added'), { action: { label: t('app:cart.review'), onclick: () => (open = true) }, timeout: 4000 });
        }
      });
    };
    const onPublished = () => void refresh();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    // A discard, an unstage or a publish anywhere (not only in this cart) reads the cart again.
    const offStaged = onInvalidated((i) => {
      if (i.event !== 'staged_changed' && i.event !== 'publish' && i.event !== 'store_read' && i.event !== 'sync') return;
      if (i.event === 'staged_changed' && i.reason === 'stage') return;
      if (i.appIds.length === 0 || i.appIds.some((id) => ids.includes(id))) void refresh();
    });
    // "2 staged" on a locale row: open the drawer on that locale's items.
    const onOpen = (e: Event) => {
      focusLocale = (e as CustomEvent<{ locale?: string | null }>).detail?.locale ?? null;
      open = true;
      void refresh();
    };
    // "Publish again" (the Next step card, the top bar): the plan dialog opens for that record, on the steps the failed run had.
    const onPublishAgain = (e: Event) => {
      const id = (e as CustomEvent<{ appId?: string }>).detail?.appId;
      const target = members.find((m) => m.id === id);
      if (target === undefined) return;
      e.preventDefault();
      const run = appState.failures.find((f) => f.appId === target.id)?.run ?? null;
      reviewTargets = [target];
      reviewSteps = stepsToRepeat(run);
      open = false;
      reviewing = true;
    };
    window.addEventListener(PUBLISH_AGAIN_EVENT, onPublishAgain);
    window.addEventListener(CART_OPEN_EVENT, onOpen);
    window.addEventListener(CART_ADDED_EVENT, onAdded);
    window.addEventListener(PUBLISHED_EVENT, onPublished);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      offStaged();
      window.removeEventListener(PUBLISH_AGAIN_EVENT, onPublishAgain);
      window.removeEventListener(CART_OPEN_EVENT, onOpen);
      window.removeEventListener(CART_ADDED_EVENT, onAdded);
      window.removeEventListener(PUBLISHED_EVENT, onPublished);
      document.removeEventListener('visibilitychange', onFocus);
    };
  });

  const codeOf = (e: unknown) => (e instanceof ApiError ? (e.code || 'other') : 'network');
  const detailOf = (e: unknown) => (e instanceof ApiError ? `${e.code || e.status}: ${e.message}` : e instanceof Error ? e.message : '');

  /** The dry run of the selected price items: reads the live prices of each (the store's own check where there is one) and sends nothing. */
  async function dryRunPrices(selection: Selection) {
    const chosen = selectedRows(rows, selection).filter((r) => r.kind === 'price');
    if (chosen.length === 0) return;
    dryBusy = true;
    dryRun = null;
    const items: { key: string; title: string; item: PriceDryRunItem }[] = [];
    let failed = '';
    let writesEnabled = true;
    for (const appId of new Set(chosen.map((r) => r.appId))) {
      const mine = chosen.filter((r) => r.appId === appId);
      try {
        const done = await api.dryRunStagedPrices(workspaceId, appId, mine.map((r) => r.id));
        writesEnabled = writesEnabled && done.dryRun.writesEnabled;
        for (const item of done.dryRun.items) {
          const row = mine.find((r) => r.id === `price:${item.id}`);
          items.push({ key: row?.key ?? `${appId}|price:${item.id}`, title: row?.title ?? item.productId, item });
        }
      } catch (e) {
        failed = classifyPriceFailure(e).message;
      }
    }
    dryRun = { items, writesEnabled, failed };
    dryBusy = false;
  }

  async function publish(selection: Selection, confirmations: Readonly<Record<string, string>> = {}) {
    const snapshot = selectedRows(rows, selection);
    busy = true;
    running = new Set(snapshot.map((r) => r.key));
    report = null;
    dryRun = null;
    let outcomes: Outcomes = {};
    for (const [appId, items] of publishRequests(rows, selection)) {
      try {
        // A store draft write is a step-up action when the workspace asks for it: the call is made once more with the grant.
        const done = await confirmed((grant) => api.publishPendingCart(workspaceId, appId, items, grant, confirmations[appId]));
        outcomes = mergeResults(outcomes, appId, done.result.results);
      } catch (e) {
        outcomes = failAll(outcomes, appId, items.map((i) => i.id), codeOf(e), detailOf(e));
      }
    }
    report = { rows: snapshot, outcomes, kind: 'publish' };
    running = new Set();
    busy = false;
    await refresh();
  }

  /** "Review and publish": the plan dialog opens right here, for the apps of the selection and (when only part is selected) the draft push alone. */
  let reviewing = $state(false);
  let reviewTargets = $state<AppSummary[]>([]);
  let reviewSteps = $state<StepRequest[] | null>(null);
  function review(selection: Selection) {
    const scope = reviewScope(rows, selection);
    if (scope.none) return;
    reviewTargets = members.filter((m) => scope.appIds.includes(m.id));
    reviewSteps = scope.steps;
    if (reviewTargets.length === 0) return;
    open = false;
    reviewing = true;
  }

  async function discard(selection: Selection) {
    const snapshot = selectedRows(rows, selection).filter((r) => r.canDiscard);
    busy = true;
    running = new Set(snapshot.map((r) => r.key));
    report = null;
    let outcomes: Outcomes = {};
    for (const [appId, list] of discardRequests(rows, selection)) {
      try {
        const done = await api.discardPendingCart(workspaceId, appId, list);
        outcomes = mergeResults(outcomes, appId, done.result.results);
      } catch (e) {
        outcomes = failAll(outcomes, appId, list, codeOf(e), detailOf(e));
      }
    }
    report = { rows: snapshot, outcomes, kind: 'discard' };
    running = new Set();
    busy = false;
    await refresh();
  }
</script>

<div class="live visually-hidden" role="status" aria-live="polite">{announce}</div>

<PendingCartDrawer
  bind:open
  {api}
  {workspaceId}
  rows={shownRows}
  {publishing}
  {failures}
  can={(action) => appState.canDo(action)}
  {groupId}
  {platform}
  {loading}
  {error}
  {busy}
  {running}
  {report}
  {focusLocale}
  {now}
  {dryRun}
  {dryBusy}
  onpublish={publish}
  ondryrun={dryRunPrices}
  ondiscard={discard}
  onrefresh={refresh}
  onreview={review}
  ondismiss={() => (report = null)}
/>

{#if reviewing}
  <PublishDialog bind:open={reviewing} {api} {workspaceId} {role} targets={reviewTargets} steps={reviewSteps} onchanged={() => { void refresh(); void appStateStore.refresh(api, workspaceId, ids); }} />
{/if}
