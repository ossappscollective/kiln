<script lang="ts">
  import { can, type Role } from '@mrm/core';
  import { ApiError, type Api } from '../lib/api.ts';
  import {
    categoryLabel,
    clockTime,
    describeEventParts,
    eventCategory,
    eventVisual,
    fullTime,
    groupByDay,
  } from '../lib/format.ts';
  import type { AuditEvent } from '../lib/types.ts';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Icon from './ui/Icon.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Section from './ui/Section.svelte';
  import SectionsToggle from './ui/SectionsToggle.svelte';
  import Skeleton from './ui/Skeleton.svelte';
  import { type IconName, isIconName } from './ui/icons.ts';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const allowed = $derived(can(role, 'audit.read'));
  let events = $state<AuditEvent[] | null>(null);
  let error = $state('');
  let refreshing = $state(false);
  let category = $state('all');
  let actor = $state('all');

  async function load() {
    error = '';
    refreshing = true;
    try {
      events = (await api.audit(workspaceId)).events;
    } catch (e) {
      events = null;
      error = e instanceof ApiError ? e.message : 'Could not load the audit log.';
    } finally {
      refreshing = false;
    }
  }

  $effect(() => {
    void workspaceId;
    events = null;
    category = 'all';
    actor = 'all';
    if (allowed) void load();
  });

  const actorKey = (e: AuditEvent) => `${e.actorType}:${e.actorId}`;
  const actorName = (e: AuditEvent) =>
    e.actorName ?? (e.actorType === 'user' ? 'Someone' : e.actorType.charAt(0).toUpperCase() + e.actorType.slice(1));

  const categories = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const e of events ?? []) counts.set(eventCategory(e.action), (counts.get(eventCategory(e.action)) ?? 0) + 1);
    return [...counts].map(([id, count]) => ({ id, count, label: categoryLabel(id) }));
  });

  const actors = $derived.by(() => {
    const seen = new Map<string, string>();
    for (const e of events ?? []) if (!seen.has(actorKey(e))) seen.set(actorKey(e), actorName(e));
    return [...seen].map(([id, label]) => ({ id, label }));
  });

  const filtered = $derived(
    (events ?? []).filter(
      (e) => (category === 'all' || eventCategory(e.action) === category) && (actor === 'all' || actorKey(e) === actor),
    ),
  );
  const groups = $derived(groupByDay(filtered));
  const filtering = $derived(category !== 'all' || actor !== 'all');

  function clearFilters() {
    category = 'all';
    actor = 'all';
  }

  const iconFor = (action: string): IconName => {
    const name = eventVisual(action).icon;
    return isIconName(name) ? name : 'history';
  };
</script>

<PageHeader title="Audit log" description="Every change to credentials and workspace settings, newest first.">
  {#snippet actions()}
    {#if allowed}
      <Button icon="refresh" loading={refreshing && events !== null} onclick={load}>Refresh</Button>
    {/if}
  {/snippet}
</PageHeader>

{#if !allowed}
  <Alert tone="info">Your role does not include the audit log.</Alert>
{:else if error}
  <div class="stack">
    <Alert tone="error">{error}</Alert>
    <Button icon="refresh" onclick={load}>Try again</Button>
  </div>
{:else if events === null}
  <div class="card" role="status" aria-label="Loading the audit log">
    {#each [0, 1, 2, 3, 4] as i (i)}
      <div class="skeleton-row">
        <Skeleton width="28px" height="28px" circle />
        <div class="skeleton-text">
          <Skeleton width="{60 - i * 5}%" height="14px" />
          <Skeleton width="80px" height="12px" />
        </div>
      </div>
    {/each}
  </div>
{:else if events.length === 0}
  <div class="card">
    <EmptyState
      icon="history"
      title="No activity yet"
      description="Changes to credentials and workspace settings will show up here."
    />
  </div>
{:else}
  <div class="toolbar">
    <div class="chips" role="group" aria-label="Filter by type">
      <button type="button" class="bare chip" aria-pressed={category === 'all'} onclick={() => (category = 'all')}>
        All <span class="count">{events.length}</span>
      </button>
      {#each categories as c (c.id)}
        <button type="button" class="bare chip" aria-pressed={category === c.id} onclick={() => (category = c.id)}>
          {c.label} <span class="count">{c.count}</span>
        </button>
      {/each}
    </div>
    <SectionsToggle />
    {#if actors.length > 1}
      <div class="actor">
        <label class="visually-hidden" for="audit-actor">Filter by person</label>
        <select id="audit-actor" bind:value={actor}>
          <option value="all">Everyone</option>
          {#each actors as a (a.id)}<option value={a.id}>{a.label}</option>{/each}
        </select>
      </div>
    {/if}
  </div>

  {#if groups.length === 0}
    <div class="card">
      <EmptyState icon="search" title="No events match" description="Try a different type or person.">
        {#snippet actions()}<Button onclick={clearFilters}>Clear filters</Button>{/snippet}
      </EmptyState>
    </div>
  {:else}
    <div class="stack loose">
      {#each groups as group (group.key)}
        <Section title={group.label} key="day.{group.key}" level={2} count={group.items.length}>
            <ol class="timeline">
              {#each group.items as event (event.id)}
                {@const visual = eventVisual(event.action)}
                {@const parts = describeEventParts(event)}
                <li>
                  <span class="node {visual.tone}"><Icon name={iconFor(event.action)} /></span>
                  <p class="what"><strong>{parts.who}</strong> {parts.what}</p>
                  <time class="muted" datetime={new Date(event.at).toISOString()} title={fullTime(event.at)}>
                    {clockTime(event.at)}
                  </time>
                </li>
              {/each}
            </ol>
        </Section>
      {/each}
    </div>
    {#if filtering}
      <p class="muted summary">
        Showing {filtered.length} of {events.length} events. <button type="button" class="link" onclick={clearFilters}>Clear filters</button>
      </p>
    {/if}
  {/if}
{/if}

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-5);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .chip {
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    transition:
      background-color var(--duration-fast) var(--ease),
      border-color var(--duration-fast) var(--ease),
      color var(--duration-fast) var(--ease);
  }

  .chip:hover {
    color: var(--ink);
    border-color: var(--line-hover);
  }

  .chip[aria-pressed='true'] {
    color: var(--accent);
    background: var(--accent-bg);
    border-color: transparent;
  }

  .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }

  .actor select {
    width: auto;
    min-width: 160px;
    min-height: var(--control-sm);
    font-size: var(--text-sm);
  }

  .timeline {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .timeline li {
    position: relative;
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: start;
    padding-bottom: var(--space-5);
  }

  .timeline li:last-child {
    padding-bottom: 0;
  }

  .timeline li:not(:last-child)::before {
    position: absolute;
    top: 32px;
    bottom: 4px;
    left: 13.5px;
    width: 1px;
    content: '';
    background: var(--line);
  }

  .node {
    display: grid;
    width: 28px;
    height: 28px;
    color: var(--muted);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: 50%;
    place-items: center;
  }

  .node.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }

  .node.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }

  .node.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .what {
    padding-top: var(--space-1);
    overflow-wrap: anywhere;
  }

  time {
    padding-top: var(--space-1);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .skeleton-row {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3) 0;
  }

  .skeleton-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-2);
  }

  .summary {
    margin-top: var(--space-4);
    font-size: var(--text-sm);
  }

  @media (max-width: 479px) {
    .timeline li {
      grid-template-columns: 28px minmax(0, 1fr);
    }

    time {
      grid-column: 2;
      padding-top: 0;
    }
  }
</style>
