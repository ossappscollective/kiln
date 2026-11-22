<!--
  TrainSteps: the five steps of a release on its way (CI, Build, Prepare, Review, Release) as one row of dots and words, each with its
  help on hover and one "About these steps" tip. The step that matters now is marked. Drawn by the Next step card.
  Props: steps (the merged steps of a release train, lib/release-trains.ts).
-->
<script lang="ts">
  import type { StripStep } from '../../lib/release-pipeline.ts';
  import { STEP_HELP } from '../../lib/release-trains.ts';
  import { t } from '../../lib/i18n/t.ts';
  import InfoTip from '../ui/InfoTip.svelte';

  let { steps }: { steps: StripStep[] } = $props();
</script>

<ol class="steps">
  {#each steps as s (s.id)}
    <li class="s {s.status}" class:current={s.current} aria-current={s.current ? 'step' : undefined} title={s.detail ? `${t(STEP_HELP[s.id])} ${s.detail}` : t(STEP_HELP[s.id])}>
      <span class="dot" aria-hidden="true"></span>
      <span class="name">{s.label}</span>
      <span class="visually-hidden">: {s.word}</span>
    </li>
  {/each}
</ol>
<InfoTip label={t('release:strip.about')} width="24rem">
  <ul class="help">
    {#each steps as s (s.id)}<li>{t(STEP_HELP[s.id])}</li>{/each}
  </ul>
</InfoTip>

<style>
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .s {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    color: var(--muted);
  }

  .s.current {
    font-weight: var(--weight-semibold);
    color: var(--text);
  }

  .dot {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    background: transparent;
    border: 2px solid var(--line-strong, var(--muted));
    border-radius: 50%;
  }

  .s.done .dot {
    background: var(--ok);
    border-color: var(--ok);
  }

  .s.current .dot,
  .s.waiting .dot {
    border-color: var(--accent);
  }

  .s.current .dot {
    background: var(--accent);
  }

  .s.failed .dot,
  .s.stalled .dot {
    background: var(--bad);
    border-color: var(--bad);
  }

  .s.stalled .dot {
    background: var(--warn);
    border-color: var(--warn);
  }

  .help {
    padding-left: var(--space-4);
    margin: 0;
  }
</style>
