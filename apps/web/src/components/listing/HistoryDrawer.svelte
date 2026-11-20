<!--
  HistoryDrawer: the timeline of one listing field in one locale, newest first: when each value was
  first seen, where it came from (the store, the repository or a change set) and what it replaced.
  A row is stored only when the value changed, so the timeline has no repeats. Read-only.
  Props: open (bindable), api, workspaceId, appId, target ({ locale, field, label } or null).
  A native <dialog> shown as a side panel, so the focus trap, Escape and the focus return come from
  the browser.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { actorText, describeSource, historySteps, usage, usageText } from '../../lib/listing/drift.ts';
  import type { ListingHistoryEntry } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import DiffText from './DiffText.svelte';

  type Target = { locale: string; field: string; label: string; limit: number | null; unit: 'characters' | 'bytes' };

  let {
    open = $bindable(false),
    api,
    workspaceId,
    appId,
    target,
    now,
  }: { open?: boolean; api: Api; workspaceId: string; appId: string; target: Target | null; now: number } = $props();

  const PAGE = 25;
  const uid = $props.id();

  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;
  let entries = $state<ListingHistoryEntry[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let problem = $state('');
  let generation = 0;

  const steps = $derived(historySteps(entries));
  /** One line above the timeline says what the underlined words are, instead of the same line under every entry. */
  const hasDiff = $derived(
    steps.some((st) => !st.removed && typeof st.previous === 'string' && st.entry.value !== null && st.previous !== st.entry.value),
  );

  const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

  async function load(cursor: string | null) {
    if (!target) return;
    const mine = generation;
    const t = target;
    if (cursor === null) loading = true;
    else loadingMore = true;
    problem = '';
    try {
      const page = await api.appListingHistory(workspaceId, appId, {
        locale: t.locale,
        field: t.field,
        limit: PAGE,
        ...(cursor === null ? {} : { cursor }),
      });
      if (mine !== generation) return;
      entries = cursor === null ? page.items : [...entries, ...page.items];
      nextCursor = page.nextCursor;
    } catch (e) {
      if (mine !== generation) return;
      problem = message(e);
    } finally {
      if (mine === generation) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // A new target (or reopening) starts a new timeline; a late answer for the old one is dropped.
  $effect(() => {
    if (!open || !target) return;
    void target.locale;
    void target.field;
    generation += 1;
    entries = [];
    nextCursor = null;
    untrack(() => void load(null));
  });

  function handleClose() {
    open = false;
    generation += 1;
    opener?.focus();
    opener = null;
  }

  // The backdrop belongs to the dialog element: a click that lands on it is a click outside.
  function handleClick(event: MouseEvent) {
    if (event.target === dialog) open = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="drawer" aria-labelledby="{uid}-title" onclose={handleClose} onclick={handleClick}>
  {#if open && target}
    <div class="surface">
      <header>
        <div>
          <h2 id="{uid}-title">History of {target.label}</h2>
          <p class="muted">Locale {target.locale}. A new entry is stored only when the value changed.</p>
        </div>
        <button type="button" class="ghost icon sm" aria-label="Close" onclick={() => (open = false)}>
          <Icon name="x" />
        </button>
      </header>

      <div class="body">
        {#if loading}
          <div role="status" aria-label="Loading the history" class="stack">
            <Skeleton width="60%" height="16px" />
            <Skeleton width="100%" height="48px" />
            <Skeleton width="40%" height="16px" />
          </div>
        {:else if problem && entries.length === 0}
          <div class="stack">
            <Alert tone="error" title="Could not load the history">{problem}</Alert>
            <div><Button icon="refresh" onclick={() => load(null)}>Try again</Button></div>
          </div>
        {:else if entries.length === 0}
          <p class="muted">
            Nothing is recorded for this field yet. Values are recorded when the app is synced with the store
            and when its repository listing is read.
          </p>
        {:else}
          {#if hasDiff}<p class="muted legend">Underlined words are new compared with the earlier value from the same source.</p>{/if}
          <ol class="timeline">
            {#each steps as step (step.entry.id)}
              {@const e = step.entry}
              <li>
                <div class="head">
                  <Badge tone={e.source === 'store' ? 'info' : e.source === 'repo' ? 'accent' : 'neutral'}>{describeSource(e)}</Badge>
                  <time datetime={new Date(e.observedAt).toISOString()} title={fullTime(e.observedAt)}>{timeAgo(e.observedAt, now)}</time>
                  {#if e.actor}<span class="muted">{actorText(e.actor)}</span>{/if}
                </div>
                {#if step.removed}
                  <p class="removed muted">The field was removed or is empty{step.previous ? ', it was:' : '.'}</p>
                  {#if step.previous}<div class="value old">{step.previous}</div>{/if}
                {:else if typeof step.previous === 'string' && e.value !== null && step.previous !== e.value}
                  <div class="value">
                    <DiffText from={step.previous} to={e.value} side="to" fromName="the earlier value" toName="this value" />
                  </div>
                {:else if e.value !== null}
                  <div class="value">{e.value}</div>
                {/if}
                {#if e.value !== null}
                  {@const u = usage(e.value, target.limit, target.unit)}
                  <p class="meta" class:over={u.over}>{usageText(u)}{#if u.over}<span class="visually-hidden"> (over the limit)</span>{/if}</p>
                {/if}
                {#if step.previous === undefined && nextCursor === null}
                  <p class="meta muted">First recorded value from this source.</p>
                {/if}
              </li>
            {/each}
          </ol>
          {#if problem}<Alert tone="error">{problem}</Alert>{/if}
          {#if nextCursor}
            <div class="more">
              <Button loading={loadingMore} onclick={() => load(nextCursor)}>Load older entries</Button>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog.drawer {
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

  dialog.drawer[open] {
    animation: slide var(--duration-slow) var(--ease);
  }

  dialog.drawer::backdrop {
    background: var(--scrim);
  }

  .surface {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    justify-content: space-between;
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

  .legend {
    margin: 0 0 var(--space-4);
    font-size: var(--text-sm);
  }

  .body {
    flex: 1;
    padding: var(--space-4) var(--space-5) var(--space-6);
    overflow: auto;
  }

  .timeline {
    padding: 0;
    margin: 0;
    list-style: none;
    border-left: 2px solid var(--line);
  }

  li {
    position: relative;
    padding: 0 0 var(--space-6) var(--space-4);
  }

  li::before {
    position: absolute;
    top: 6px;
    left: -6px;
    width: 10px;
    height: 10px;
    content: '';
    background: var(--surface);
    border: 2px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-2);
    font-size: 0.9375rem;
  }

  .value {
    max-height: 14rem;
    font-size: 0.9375rem;
    line-height: 1.5;
    padding: var(--space-2) var(--space-3);
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .value.old {
    color: var(--muted);
  }

  .removed {
    margin: 0 0 var(--space-2);
  }

  .meta {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .meta.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .more {
    margin-top: var(--space-2);
  }

  @keyframes slide {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    dialog.drawer[open] {
      animation: none;
    }
  }
</style>
