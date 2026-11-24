<!--
  PendingCart: the pending changes of an app (docs/adr/0054-pending-cart.md) and the work behind them. The button is in the top bar
  (PendingCartButton, next to the account menu): this component only feeds it (`cartButton`: count, pulse, open state) and clears it
  when the app is left. Hidden with none (and on the pending page, which is the review). It opens the right drawer (PendingCartDrawer).
  When a page stages something (`announceCartAdded`), the button pulses once (not with reduced motion) and a toast says "Added to pending changes".
  The count is announced politely.
  Nothing is sent without the drawer's confirm; publish and discard go through the server's per item routes, one request per record.
  Props: api, workspaceId, groupId (the app in the address), members (its records), platform (the page scope), hidden.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
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
    mergeResults,
    type Outcomes,
    publishRequests,
    type Selection,
    selectedRows,
    toRows,
  } from '../../lib/pending-cart.ts';
  import { PUBLISHED_EVENT } from '../../lib/app-page.ts';
  import { onStagedChanged } from '../../lib/staged-sync.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { classifyPriceFailure } from '../../lib/prices.ts';
  import type { AppSummary, PriceDryRunItem } from '../../lib/types.ts';
  import PendingCartDrawer from './PendingCartDrawer.svelte';

  let {
    api,
    workspaceId,
    groupId,
    members,
    platform,
    hidden = false,
  }: {
    api: Api;
    workspaceId: string;
    groupId: string;
    members: readonly Pick<AppSummary, 'id'>[];
    platform: PlatformScope | null;
    hidden?: boolean | undefined;
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
  const count = $derived(rows.length);
  const visible = $derived(!hidden && count > 0);

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

  // The top bar button reads these; leaving the app (or the page that hides it) takes it away.
  $effect(() => {
    cartButton.visible = visible;
    cartButton.count = count;
  });
  $effect(() => {
    cartButton.expanded = open;
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
    const offStaged = onStagedChanged((d) => {
      if (d.reason !== 'stage' && ids.includes(d.appId)) void refresh();
    });
    // "2 staged" on a locale row: open the drawer on that locale's items.
    const onOpen = (e: Event) => {
      focusLocale = (e as CustomEvent<{ locale?: string | null }>).detail?.locale ?? null;
      open = true;
      void refresh();
    };
    window.addEventListener(CART_OPEN_EVENT, onOpen);
    window.addEventListener(CART_ADDED_EVENT, onAdded);
    window.addEventListener(PUBLISHED_EVENT, onPublished);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      offStaged();
      window.removeEventListener(CART_OPEN_EVENT, onOpen);
      window.removeEventListener(CART_ADDED_EVENT, onAdded);
      window.removeEventListener(PUBLISHED_EVENT, onPublished);
      document.removeEventListener('visibilitychange', onFocus);
    };
  });

  const codeOf = (e: unknown) => (e instanceof ApiError ? (e.code || 'other') : 'network');

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
        outcomes = failAll(outcomes, appId, items.map((i) => i.id), codeOf(e));
      }
    }
    report = { rows: snapshot, outcomes, kind: 'publish' };
    running = new Set();
    busy = false;
    await refresh();
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
        outcomes = failAll(outcomes, appId, list, codeOf(e));
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
  {rows}
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
  ondismiss={() => (report = null)}
/>
