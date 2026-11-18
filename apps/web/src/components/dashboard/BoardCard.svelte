<!--
  BoardCard: one app (one platform) and its newest version on the board: where it is in the
  lifecycle, a blocked flag with its reason, the deadline, what to do next and when it was synced.
  Everything on it is read from the stores or from our own plan; it has no control that changes a store.
  Props: card (from buildBoard), now (epoch ms, so relative times update).
-->
<script lang="ts">
  import type { BoardCard } from '../../lib/dashboard.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { appHref, trackLabel } from '../../lib/portfolio.ts';
  import { dueText, rolloutBadge } from '../../lib/release.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import PlatformBadge from '../portfolio/PlatformBadge.svelte';
  import ReleaseStatus from '../portfolio/ReleaseStatus.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';

  let { card, now }: { card: BoardCard; now: number } = $props();

  const uid = $props.id();
  const due = $derived(card.due ? dueText(card.due) : null);
  const rollout = $derived(rolloutBadge(card.rollout));
  const showTrack = $derived(card.track !== null && card.track !== 'production');
</script>

<article class="card-box" class:blocked={card.blocked !== null} aria-labelledby="{uid}-name">
  <div class="top">
    <div class="ident">
      <AppIcon name={card.appName} url={card.iconUrl} platform={card.platform} seed={card.appId} size="md" />
      <h3 id="{uid}-name" class="name"><a href={card.href}>{card.appName}</a></h3>
    </div>
    <PlatformBadge platform={card.platform} />
  </div>

  <div class="version">
    <strong>{card.version}</strong>
    {#if card.build}<span class="muted small">build {card.build}</span>{/if}
    {#if showTrack}<span class="muted small">{trackLabel(card.track)}</span>{/if}
    {#if card.planned}
      <Badge icon={toneIcon('neutral')}>Planned</Badge>
    {:else}
      <ReleaseStatus status={card.status} rawState={card.rawState ?? undefined} rolloutFraction={card.rolloutFraction} />
    {/if}
  </div>

  {#if card.blocked}
    <p class="flag">
      <Icon name="alert-triangle" size={16} />
      <span><strong>Blocked.</strong> {card.blocked.reason}</span>
    </p>
  {/if}

  {#if due || rollout}
    <p class="due">
      {#if due}<Badge tone={due.tone === 'neutral' ? 'neutral' : due.tone} icon={toneIcon(due.tone)}>{due.text}</Badge>{/if}
      {#if rollout}<Badge tone={rollout.tone} icon={toneIcon(rollout.tone)}>{rollout.label}</Badge>{/if}
    </p>
  {/if}

  <p class="next">
    <span class="eyebrow">Next</span>
    <span>{card.next.text}</span>
  </p>

  <p class="meta muted small">
    {#if card.syncError}
      <span class="sync-error"><Icon name="alert" size={14} /> Last sync failed.</span>
    {/if}
    {#if card.lastSyncedAt !== null}
      <time datetime={new Date(card.lastSyncedAt).toISOString()} title={fullTime(card.lastSyncedAt)}>Synced {timeAgo(card.lastSyncedAt, now)}</time>
    {:else}
      Never synced
    {/if}
    <span aria-hidden="true">·</span>
    <a href={appHref(card.appId)}>App details<span class="visually-hidden"> for {card.appName}</span></a>
  </p>
</article>

<style>
  .card-box {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-xs);
  }

  /* Blocked is said in words and by a thicker edge, not by color alone. */
  .card-box.blocked {
    border-color: var(--bad-line);
    border-left: 4px solid var(--bad);
  }

  .top {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    justify-content: space-between;
  }

  .ident {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .name {
    min-width: 0;
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    overflow-wrap: anywhere;
  }

  .version {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .small {
    font-size: var(--text-sm);
  }

  .flag {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    padding: var(--space-2) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--bad-ink);
    background: var(--bad-bg);
    border: 1px solid var(--bad-line);
    border-radius: var(--radius-md);
  }

  .flag :global(.icon) {
    flex: none;
    margin-top: 1px;
  }

  .due {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    margin: 0;
  }

  .next {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    font-size: var(--text-sm);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
  }

  .sync-error {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    color: var(--bad-ink);
  }
</style>
