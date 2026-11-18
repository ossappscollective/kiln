<!--
  AttentionStrip: the plans that need a look: a deadline that has passed, a rollout step whose
  planned time has passed while it is still open, a deadline that is close. It is built from our own
  plan data by pure helpers (`attentionItems`); it reads nothing from a store and changes nothing.
  Reminders are also sent as events (webhooks, the event stream), never as email or push.
  Props: items (from attentionItems or attentionOf), compact (for a plan's own page: just the
  reasons, no link back to it).
-->
<script lang="ts">
  import { type Attention, type AttentionKind, attentionSummary } from '../../lib/dashboard.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import PlatformBadge from '../portfolio/PlatformBadge.svelte';
  import Badge from '../ui/Badge.svelte';

  let { items, compact = false }: { items: Attention[]; compact?: boolean } = $props();

  const uid = $props.id();
  const KIND: Record<AttentionKind, { label: string; tone: 'bad' | 'warn' }> = {
    overdue: { label: 'Overdue', tone: 'bad' },
    rollout_due: { label: 'Rollout step due', tone: 'warn' },
    due_soon: { label: 'Due soon', tone: 'warn' },
  };
</script>

{#if items.length > 0}
  <section class="strip" class:compact aria-labelledby="{uid}-title">
    <div class="head">
      <h2 id="{uid}-title">{compact ? 'Needs attention' : 'Due soon and overdue'}</h2>
      {#if !compact}<p class="muted small">{attentionSummary(items)}</p>{/if}
    </div>
    <ul class="list">
      {#each items as item (item.key)}
        <li class="row-item">
          <span class="who">
            {#if !compact}
              <a href={item.href}>{item.appName} {item.version}</a>
              <PlatformBadge platform={item.platform} />
            {/if}
            <Badge tone={KIND[item.kind].tone} icon={toneIcon(KIND[item.kind].tone)}>{KIND[item.kind].label}</Badge>
          </span>
          <span class="why">{item.reasons.join(' ')}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .strip {
    padding: var(--space-3) var(--space-4);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    border-left: 4px solid var(--warn);
    border-radius: var(--radius-md);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: baseline;
  }

  h2 {
    margin: 0;
    font-size: var(--text-base);
    color: var(--warn-ink);
  }

  .head p {
    margin: 0;
  }

  .small {
    font-size: var(--text-sm);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: var(--space-2) 0 0;
    list-style: none;
  }

  .row-item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .who {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .why {
    font-size: var(--text-sm);
  }
</style>
