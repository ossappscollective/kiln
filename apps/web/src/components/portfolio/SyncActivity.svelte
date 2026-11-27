<!--
  SyncActivity: what the stores are being read for right now, app by app and feed by feed, so a person sees data
  land instead of a spinner. Shows nothing when nothing is syncing. It polls a light endpoint (memory of the server
  process plus one count), faster while something runs.
  Props: api, workspaceId, names (app id to display name), hint (true while this screen started a sync itself: poll fast).
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Icon from '../ui/Icon.svelte';
  import { readSyncActivity } from '../../lib/app-state/workspace-reads.ts';

  let {
    api,
    workspaceId,
    names,
    hint = false,
  }: { api: Pick<Api, 'syncActivity'>; workspaceId: string; names: Record<string, string>; hint?: boolean } = $props();

  type Activity = { apps: { id: string; feeds: { feed: string; since: number }[] }[]; queued: number };
  let activity = $state<Activity>({ apps: [], queued: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  const feedLabel = (feed: string) =>
    feed === 'releases'
      ? t('portfolio:activity.feed.releases')
      : feed === 'reviews'
        ? t('portfolio:activity.feed.reviews')
        : feed === 'analytics'
          ? t('portfolio:activity.feed.analytics')
          : t('portfolio:activity.feed.other');

  const busy = $derived(activity.apps.length > 0 || activity.queued > 0);

  async function poll() {
    try {
      const next = await readSyncActivity(api, workspaceId);
      if (alive) activity = next;
    } catch {
      // A missed poll is not worth a message: the sync result itself reports errors.
    }
    if (alive) timer = setTimeout(poll, busy || hint ? 2_500 : 15_000);
  }

  onMount(poll);
  onDestroy(() => {
    alive = false;
    if (timer) clearTimeout(timer);
  });
</script>

{#if busy}
  <section class="activity" role="status" aria-live="polite" aria-label={t('portfolio:activity.title')}>
    <span class="head"><Icon name="refresh" size={14} /> {t('portfolio:activity.title')}</span>
    <ul>
      {#each activity.apps as app (app.id)}
        <li>
          <span class="app">{names[app.id] ?? t('portfolio:activity.unknownApp')}</span>
          <span class="feeds">{app.feeds.map((f) => feedLabel(f.feed)).join(', ')}</span>
        </li>
      {/each}
    </ul>
    {#if activity.queued > 0}
      <span class="queued">{t('portfolio:activity.queued', { count: activity.queued })}</span>
    {/if}
  </section>
{/if}

<style>
  .activity {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .head {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    color: var(--ink);
    font-weight: 600;
  }

  ul {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .app {
    color: var(--ink);
  }
</style>
