<!--
  AlertBell: the alert inbox in the top bar. A button with the unread count (the text says it, not only the colour) opens a short list of
  the newest alerts with "Mark all read" and a link to the whole inbox. The count and the list come from alertStore (lib/alert-store.svelte.ts).
  Props: api, workspaceId.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { alertStore } from '../../lib/alert-store.svelte.ts';
  import { badgeCount, severityLabels } from '../../lib/alerts.ts';
  import { floating } from '../../lib/floating.ts';
  import { timeAgo } from '../../lib/format.ts';
  import Icon from '../ui/Icon.svelte';

  let { api, workspaceId }: { api: Api; workspaceId: string } = $props();

  let open = $state(false);
  let host = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();
  let error = $state('');

  const label = $derived(alertStore.unread > 0 ? `Alerts, ${alertStore.unread} unread` : 'Alerts');

  function close(refocus: boolean) {
    open = false;
    if (refocus) button?.focus();
  }

  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (open && next && host && !host.contains(next)) open = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      close(true);
    }
  }

  async function markAll() {
    error = '';
    try {
      const result = await api.markAlertsRead(workspaceId, { all: true });
      alertStore.setUnread(result.unreadCount);
      await alertStore.refresh(api, workspaceId);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not mark the alerts as read.';
    }
  }
</script>

<div class="bell" bind:this={host} {onfocusout} {onkeydown} role="presentation">
  <button
    bind:this={button}
    type="button"
    class="bare bell-button"
    aria-label={label}
    aria-haspopup="true"
    aria-expanded={open}
    aria-controls="alert-menu"
    onclick={() => (open = !open)}
  >
    <Icon name="bell" size={18} />
    {#if alertStore.unread > 0}<span class="count" aria-hidden="true">{badgeCount(alertStore.unread)}</span>{/if}
  </button>

  {#if open}
    <div id="alert-menu" class="panel" role="group" aria-label="Newest alerts" use:floating={{ anchor: button ?? null, align: 'end', gap: 8 }}>
      <div class="head">
        <strong>Alerts</strong>
        <button type="button" class="link" disabled={alertStore.unread === 0} onclick={markAll}>Mark all read</button>
      </div>
      {#if error}<p class="problem" role="alert">{error}</p>{/if}
      {#if alertStore.items.length === 0}
        <p class="empty muted">{alertStore.loaded ? 'No alerts yet.' : 'Loading alerts.'}</p>
      {:else}
        <ul>
          {#each alertStore.items as a (a.id)}
            <li class:unread={!a.read}>
              <p class="title">
                {#if !a.read}<span class="visually-hidden">Unread. </span>{/if}{a.title}
                {#if a.count > 1}<span class="muted"> ({a.count} times)</span>{/if}
              </p>
              <p class="meta muted">{severityLabels[a.severity]} · {timeAgo(a.lastAt)}{a.resolvedAt !== null ? ' · resolved' : ''}</p>
            </li>
          {/each}
        </ul>
      {/if}
      <a class="all" href="#/alerts" onclick={() => close(false)}>Open the alert inbox</a>
    </div>
  {/if}
</div>

<style>
  .bell {
    position: relative;
    display: flex;
  }
  .bell-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--space-10);
    height: var(--space-10);
    border-radius: var(--radius-md);
    color: var(--muted);
  }
  .bell-button:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }
  .count {
    position: absolute;
    top: 2px;
    right: 0;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--danger-solid);
    color: var(--danger-solid-ink);
    font-size: 11px;
    font-weight: var(--weight-semibold);
    line-height: 16px;
    text-align: center;
  }
  .panel {
    inset: auto;
    width: min(360px, calc(100vw - var(--space-4)));
    max-height: 70vh;
    overflow: auto;
    margin: 0;
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow-lg);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .link:disabled {
    color: var(--muted);
    cursor: default;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }
  li.unread .title {
    font-weight: var(--weight-semibold);
  }
  .title,
  .meta {
    margin: 0;
  }
  .meta {
    font-size: var(--text-sm);
  }
  .empty {
    margin: var(--space-2) 0;
  }
  .problem {
    margin: 0 0 var(--space-2);
    color: var(--danger-solid);
    font-size: var(--text-sm);
  }
  .all {
    display: block;
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }
</style>
