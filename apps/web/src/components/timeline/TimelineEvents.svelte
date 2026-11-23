<!--
  TimelineEvents: the Timeline section of Insights, Timeline (`?view=timeline`, docs/adr/0053-timeline-and-reports.md): a vertical list of what
  happened to the app, newest day first, one heading per day. Kiln events (releases, rollout steps, listing pushes, experiments) are read from
  what Kiln stored; a person's own notes are added here ("Add note", needs `aso.write`) and can be deleted by whoever may add them.
  Filters: kind chips (FilterChip, none pressed means every kind), the platform scope of the page header and the range bar above. The count
  of what matches is announced in a polite live region. A long list is cut into pages of PAGE_SIZE with "Show more" (a burst on one day too).
  The view model is lib/timeline/timeline.ts. Reads stored data only. Props: api, workspaceId, role, members (records in scope), range, now,
  refreshKey (changes when a sync ended).
-->
<script lang="ts">
  import { type Role, type TimelineEventKind, can, dateToDay } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import type { ResolvedRange } from '../../lib/analytics/analytics.ts';
  import { formatDay } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import {
    PAGE_SIZE,
    type TimelineEntry,
    dayHeading,
    entriesOf,
    entryKey,
    eventHref,
    eventText,
    filterEntries,
    kindCounts,
    kindIcons,
    kindLabelKeys,
    manualId,
    pageOf,
    toggleKind,
    windowFor,
  } from '../../lib/timeline/timeline.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import FilterChip from '../ui/FilterChip.svelte';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import NoteDialog from './NoteDialog.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    range,
    now,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; range: ResolvedRange; now: number; refreshKey?: number | undefined } = $props();

  const today = $derived(dateToDay(now));
  const several = $derived(members.length > 1);
  const canWrite = $derived(can(role, 'aso.write'));

  let all = $state<TimelineEntry[]>([]);
  let loaded = $state(false);
  let failed = $state(0);
  let message = $state('');
  let cut = $state(false);
  let generation = 0;

  async function load() {
    const mine = ++generation;
    const w = windowFor(range.from, range.to);
    const reads: Awaited<ReturnType<Api['appTimeline']>>[] = [];
    let bad = 0;
    let text = '';
    await Promise.all(
      members.map(async (m) => {
        try {
          reads.push(await api.appTimeline(workspaceId, m.id, w.from, w.to));
        } catch (e) {
          bad += 1;
          if (e instanceof ApiError) text = e.message;
        }
      }),
    );
    if (mine !== generation) return;
    all = entriesOf(reads);
    failed = bad;
    message = text;
    cut = w.cut;
    loaded = true;
  }
  const readKey = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}/${range.from}/${range.to}/${refreshKey}`);
  $effect(() => {
    void readKey;
    untrack(() => void load());
  });

  let kinds = $state<ReadonlySet<TimelineEventKind>>(new Set());
  let limit = $state(PAGE_SIZE);
  // A new filter or range starts on the first page again.
  $effect(() => {
    void kinds;
    void readKey;
    limit = PAGE_SIZE;
  });

  const counts = $derived(kindCounts(all));
  // A chip whose kind is gone from the data (another range) does not stay pressed.
  const active = $derived(new Set([...kinds].filter((k) => counts.some((c) => c.kind === k))));
  const filtered = $derived(filterEntries(all, active));
  const page = $derived(pageOf(filtered, limit));

  let noteOpen = $state(false);
  let removing = $state('');
  async function remove(e: TimelineEntry) {
    removing = entryKey(e);
    try {
      await api.deleteTimelineEvent(workspaceId, e.appId, manualId(e));
      toast.success(t('timeline:list.removed'));
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('timeline:list.removeFailed'));
    } finally {
      removing = '';
    }
  }
  const whenLive = (e: TimelineEntry): string | null =>
    e.waitsForRelease ? (e.liveDay ? t('timeline:list.liveOn', { date: formatDay(e.liveDay, true) }) : t('timeline:list.waits')) : null;
</script>

<div class="events stack" data-testid="timeline-events">
  <div class="bar">
    <div class="chips" role="group" aria-label={t('timeline:filter.label')}>
      <FilterChip label={t('timeline:filter.all')} count={all.length} pressed={active.size === 0} onclick={() => (kinds = new Set())} />
      {#each counts as c (c.kind)}
        <FilterChip label={t(kindLabelKeys[c.kind])} count={c.count} pressed={active.has(c.kind)} onclick={() => (kinds = toggleKind(active, c.kind))} />
      {/each}
    </div>
    {#if canWrite}<Button variant="secondary" size="sm" icon="plus" onclick={() => (noteOpen = true)}>{t('timeline:add.open')}</Button>{/if}
  </div>

  <p class="visually-hidden" role="status" aria-live="polite" data-testid="result-count">
    {#if loaded}{t('timeline:list.result', { count: filtered.length })}{/if}
  </p>

  {#if !loaded}
    <div class="stack" role="status" aria-label={t('timeline:list.loading')}>
      <Skeleton width="30%" height="16px" />
      <Skeleton width="100%" height="48px" />
      <Skeleton width="100%" height="48px" />
    </div>
  {:else}
    {#if failed > 0}
      <Alert tone={failed === members.length ? 'error' : 'warn'} title={t('timeline:list.failed', { count: failed })}>{message}</Alert>
    {/if}
    {#if cut}<p class="quiet">{t('timeline:list.cut', { date: formatDay(windowFor(range.from, range.to).from, true) })}</p>{/if}
    {#if all.length === 0 && failed < members.length}
      <p class="empty" data-testid="no-events">{t('timeline:list.empty')}</p>
    {:else if filtered.length === 0 && all.length > 0}
      <p class="empty" data-testid="no-match">
        {t('timeline:list.noMatch')}
        <Button variant="link" size="sm" onclick={() => (kinds = new Set())}>{t('timeline:filter.clear')}</Button>
      </p>
    {:else}
      <ol class="days" aria-label={t('timeline:list.label')}>
        {#each page.groups as g (g.day)}
          <li class="day">
            <h3>
              <span>{dayHeading(g.day, today)}</span>
              {#if g.entries.length > 1}<span class="n tabular">{g.entries.length}</span>{/if}
            </h3>
            <ul class="rows">
              {#each g.entries as e (entryKey(e))}
                {@const href = eventHref(e)}
                {@const live = whenLive(e)}
                <li class="row" data-kind={e.kind}>
                  <span class="icon" aria-hidden="true"><Icon name={kindIcons[e.kind]} size="md" /></span>
                  <div class="body">
                    <span class="text">{#if href}<a {href}>{eventText(e)}</a>{:else}{eventText(e)}{/if}</span>
                    <span class="meta">
                      <span>{t(kindLabelKeys[e.kind])}</span>
                      {#if several}<span class="sep" aria-hidden="true">·</span><PlatformBadge platform={e.platform} tinted /><span class="visually-hidden">{platformLabel(e.platform)}</span>{/if}
                      <span class="sep" aria-hidden="true">·</span>
                      <span>{e.origin === 'manual' ? t('timeline:list.byPerson') : t('timeline:list.byKiln')}</span>
                      {#if live}<span class="sep" aria-hidden="true">·</span><span>{live}</span>{/if}
                    </span>
                    {#if e.note}<span class="note">{e.note}</span>{/if}
                  </div>
                  {#if e.origin === 'manual' && canWrite}
                    <Button variant="ghost" size="sm" icon="trash" iconOnly label={t('timeline:list.remove', { name: eventText(e) })} loading={removing === entryKey(e)} onclick={() => void remove(e)} />
                  {/if}
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ol>
      {#if page.rest > 0}
        <div class="more">
          <Button variant="secondary" size="sm" onclick={() => (limit += PAGE_SIZE)}>{t('timeline:list.more', { count: Math.min(PAGE_SIZE, page.rest) })}</Button>
          <span class="quiet">{t('timeline:list.shown', { shown: page.shown, total: filtered.length })}</span>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<NoteDialog {api} {workspaceId} {members} {today} bind:open={noteOpen} onsaved={() => void load()} />

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .empty {
    padding: var(--space-5) 0;
    margin: 0;
    color: var(--muted);
  }

  .days,
  .rows {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .days {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .day h3 {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    padding-bottom: var(--space-2);
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--ink);
    border-bottom: 1px solid var(--line);
  }

  .day h3 .n {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--muted);
  }

  .row {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-2) 0;
    text-align: left;
  }

  .icon {
    display: inline-flex;
    flex: none;
    padding-top: 2px;
    color: var(--muted);
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .text {
    overflow-wrap: anywhere;
    color: var(--ink);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .note {
    overflow-wrap: anywhere;
    font-size: var(--text-sm);
    color: var(--muted);
    white-space: pre-wrap;
  }

  .more {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
</style>
