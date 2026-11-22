<!--
  Timeline: the lifecycle of a release as ONE compact progress indicator: a single row of small dots from draft to live (done filled,
  current a ring in the accent colour or the tone of the state, upcoming muted) and, beside it, only the current step in words
  ("In review · step 4 of 8"). The whole list is in the tooltip and, for screen readers, an ordered list in which the current item has
  aria-current="step" and each item says whether it is done, current or not reached. The steps come from the state machine in
  @kiln/core, so Android shows "Propagating" and iOS does not. It never wraps to several rows (it fits 360 px).
  Props: platform, status (ReleaseState or null), label (accessible name of the list).
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import type { Platform, ReleaseState } from '@kiln/core';
  import { timeline } from '../../lib/portfolio.ts';
  import { timelineProgress } from '../../lib/timeline-progress.ts';

  let { platform, status, label }: { platform: Platform; status: ReleaseState | null; label: string } = $props();

  const steps = $derived(timeline(platform, status));
  const progress = $derived(timelineProgress(steps));
  const positionText = { done: k('portfolio:timeline.done'), current: k('portfolio:timeline.current'), upcoming: k('portfolio:timeline.upcoming') } as const;
</script>

{#if steps.length > 0}
  <div class="progress" title={progress.path} data-testid="timeline">
    <ol class="dots" aria-label={label}>
      {#each steps as step (step.state)}
        <li class="step {step.position} {step.tone}" aria-current={step.position === 'current' ? 'step' : undefined}>
          <span class="dot" aria-hidden="true"></span>
          <span class="visually-hidden">{step.label}{t('portfolio:timeline.position', { position: t(positionText[step.position]) })}</span>
        </li>
      {/each}
    </ol>
    {#if progress.current && progress.index !== null}
      <span class="now" aria-hidden="true">{t('portfolio:timeline.now', { label: progress.current.label, n: progress.index, total: progress.total })}</span>
    {/if}
  </div>
{/if}

<style>
  .progress {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-3);
    align-items: center;
    min-width: 0;
  }

  .dots {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: nowrap;
    gap: var(--space-1);
    align-items: center;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .step {
    display: inline-flex;
    align-items: center;
  }

  .dot {
    box-sizing: border-box;
    width: 0.625rem;
    height: 0.625rem;
    background: var(--line-strong);
    border: 2px solid transparent;
    border-radius: var(--radius-full);
  }

  .step.done .dot {
    background: var(--accent);
  }

  .step.upcoming .dot {
    background: transparent;
    border-color: var(--line-strong);
  }

  .step.current .dot {
    width: 0.875rem;
    height: 0.875rem;
    background: var(--accent-bg);
    border-color: var(--accent);
  }

  .step.current.ok .dot {
    background: var(--ok-bg);
    border-color: var(--ok);
  }

  .step.current.bad .dot {
    background: var(--bad-bg);
    border-color: var(--bad);
  }

  .step.current.warn .dot {
    background: var(--warn-bg);
    border-color: var(--warn);
  }

  .step.current.info .dot {
    background: var(--info-bg);
    border-color: var(--info);
  }

  .now {
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
