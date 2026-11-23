<!--
  PendingCart: the floating "pending changes" button of an app (docs/adr/0054-pending-cart.md) and the work behind it. Bottom right,
  above the mobile safe area and above a sticky save bar, showing how many changes wait; hidden with none (and on the pending page,
  which is the review). It opens the right drawer (PendingCartDrawer). When a page stages something (`announceCartAdded`), the
  button pulses once (not with reduced motion) and a toast says "Added to pending changes". The count is announced politely.
  Nothing is sent without the drawer's confirm; publish and discard go through the server's per item routes, one request per record.
  Props: api, workspaceId, groupId (the app in the address), members (its records), platform (the page scope), hidden.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    CART_ADDED_EVENT,
    type CartRow,
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
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Icon from '../ui/Icon.svelte';
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
  let pulse = $state(false);
  let busy = $state(false);
  let running = $state<ReadonlySet<string>>(new Set());
  let report = $state<{ rows: CartRow[]; outcomes: Outcomes; kind: 'publish' | 'discard' } | null>(null);
  let announce = $state('');
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
    untrack(() => void refresh());
  });

  // A polite announcement of the count, but not the first load.
  $effect(() => {
    const n = count;
    untrack(() => {
      if (loadedOnce) announce = t('app:cart.countAnnounce', { count: n });
      if (!loading) loadedOnce = true;
    });
  });

  // The button says where the toast is not: while it shows, the toasts stand above it.
  $effect(() => {
    document.documentElement.style.setProperty('--cart-clearance', visible ? '4.5rem' : '0px');
    return () => document.documentElement.style.removeProperty('--cart-clearance');
  });

  onMount(() => {
    const onAdded = () => {
      void refresh().then(() => {
        pulse = false;
        requestAnimationFrame(() => (pulse = true));
        setTimeout(() => (pulse = false), 900);
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
    window.addEventListener(CART_ADDED_EVENT, onAdded);
    window.addEventListener(PUBLISHED_EVENT, onPublished);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener(CART_ADDED_EVENT, onAdded);
      window.removeEventListener(PUBLISHED_EVENT, onPublished);
      document.removeEventListener('visibilitychange', onFocus);
    };
  });

  const codeOf = (e: unknown) => (e instanceof ApiError ? (e.code || 'other') : 'network');

  async function publish(selection: Selection) {
    const snapshot = selectedRows(rows, selection);
    busy = true;
    running = new Set(snapshot.map((r) => r.key));
    report = null;
    let outcomes: Outcomes = {};
    for (const [appId, items] of publishRequests(rows, selection)) {
      try {
        // A store draft write is a step-up action when the workspace asks for it: the call is made once more with the grant.
        const done = await confirmed((grant) => api.publishPendingCart(workspaceId, appId, items, grant));
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

{#if visible}
  <button
    type="button"
    class="cart-fab"
    class:pulse
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={t('app:cart.openAria', { count })}
    data-testid="pending-cart-button"
    onclick={() => (open = true)}
  >
    <Icon name="upload" size={18} />
    <span class="label">{t('app:cart.fabLabel')}</span>
    <span class="count" aria-hidden="true">{count}</span>
  </button>
{/if}

<PendingCartDrawer
  bind:open
  {rows}
  {groupId}
  {platform}
  {loading}
  {error}
  {busy}
  {running}
  {report}
  {now}
  onpublish={publish}
  ondiscard={discard}
  onrefresh={refresh}
  ondismiss={() => (report = null)}
/>

<style>
  /*
    Every rule is written as `button.cart-fab...`: the global `button:hover:not(:disabled)` (app.css) has the specificity of
    (0,2,1) and a plain scoped `.cart-fab` rule loses to it, which painted the hovered button with --surface-hover (white) under
    the white label: only the count chip stayed visible. Same trap as FilterChip. Colours of the label and the icon are
    --accent-ink on the gradient in EVERY state (a tested pair), and no state may use a surface background.
  */
  button.cart-fab {
    position: fixed;
    right: var(--space-4);
    bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-overlay);
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-lg);
    padding: 0 var(--space-4);
    font: inherit;
    font-weight: 600;
    color: var(--accent-ink);
    cursor: pointer;
    background: linear-gradient(135deg, var(--primary-from), var(--primary-to));
    border: 0;
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-lg);
    transition:
      transform var(--duration-fast) var(--ease),
      filter var(--duration-fast) var(--ease),
      box-shadow var(--duration-fast) var(--ease);
  }

  /* A sticky save bar sits at the bottom of the page: stay above it instead of covering its buttons. */
  :global(body:has(.savebar)) button.cart-fab {
    bottom: calc(var(--space-4) + 4.5rem + env(safe-area-inset-bottom, 0px));
  }

  /* Hover: the same gradient a little brighter and lifted; colour, icon and label do not change. */
  button.cart-fab:hover:not(:disabled) {
    color: var(--accent-ink);
    background: linear-gradient(135deg, var(--primary-from), var(--primary-to));
    filter: brightness(1.08);
    transform: translateY(-1px);
    box-shadow: var(--shadow-lg);
  }

  button.cart-fab:focus-visible {
    outline: var(--ring);
    outline-offset: 3px;
    box-shadow: var(--shadow-lg), var(--halo);
  }

  /* Pressed (and open: the drawer it controls is showing): pushed back down, a touch darker. */
  button.cart-fab:active:not(:disabled),
  button.cart-fab[aria-expanded='true'] {
    color: var(--accent-ink);
    background: linear-gradient(135deg, var(--primary-from), var(--primary-to));
    filter: brightness(0.94);
    transform: translateY(0);
    box-shadow: var(--shadow-md);
  }

  button.cart-fab:disabled {
    color: var(--accent-ink);
    cursor: not-allowed;
    filter: saturate(0.5);
    opacity: 0.6;
    box-shadow: var(--shadow-sm);
  }

  .count {
    display: inline-grid;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 var(--space-1);
    place-items: center;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    background: var(--surface);
    border-radius: var(--radius-full);
  }

  button.cart-fab.pulse {
    animation: cart-pulse 700ms var(--ease);
  }

  @keyframes cart-pulse {
    40% {
      transform: scale(1.12);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    button.cart-fab {
      transition: none;
    }

    button.cart-fab:hover:not(:disabled) {
      transform: none;
    }

    button.cart-fab.pulse {
      animation: none;
    }
  }

  @media (max-width: 480px) {
    .label {
      display: none;
    }
  }
</style>
