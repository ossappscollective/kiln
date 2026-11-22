<!--
  Timeline: the lifecycle of a release as a row of steps, from draft to live, with the release's
  place marked. The steps come from the state machine in @kiln/core, so Android shows
  "Propagating" and iOS does not. Done, current and upcoming are said in words for screen readers
  and shown by an icon and a border, not by color alone.
  Props: platform, status (ReleaseState or null), label (accessible name of the list).
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import type { Platform, ReleaseState } from '@kiln/core';
  import { timeline } from '../../lib/portfolio.ts';
  import Icon from '../ui/Icon.svelte';

  let { platform, status, label }: { platform: Platform; status: ReleaseState | null; label: string } = $props();

  const steps = $derived(timeline(platform, status));
  const positionText = { done: k('portfolio:timeline.done'), current: k('portfolio:timeline.current'), upcoming: k('portfolio:timeline.upcoming') } as const;
</script>

{#if steps.length > 0}
  <ol class="timeline" aria-label={label}>
    {#each steps as step (step.state)}
      <li class="step {step.position} {step.tone}" aria-current={step.position === 'current' ? 'step' : undefined}>
        {#if step.position === 'done'}<Icon name="check" size={14} />{/if}
        <span>{step.label}</span>
        <span class="visually-hidden">{t('portfolio:timeline.position', { position: t(positionText[step.position]) })}</span>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .timeline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .step {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
    border: 1px solid transparent;
    border-radius: var(--radius-full);
  }

  .step.done {
    color: var(--muted);
    background: var(--surface-sunken);
    border-color: var(--line);
  }

  .step.upcoming {
    color: var(--muted);
    border: 1px dashed var(--line-strong);
  }

  .step.current {
    font-weight: var(--weight-semibold);
    color: var(--accent);
    background: var(--accent-bg);
    border: 2px solid var(--accent);
  }

  .step.current.neutral,
  .step.current.accent {
    color: var(--accent);
  }

  .step.current.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok);
  }

  .step.current.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad);
  }

  .step.current.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn);
  }

  .step.current.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info);
  }
</style>
