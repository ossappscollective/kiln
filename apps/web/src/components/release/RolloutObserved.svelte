<!--
  RolloutObserved: the staged rollout (Google Play) or phased release (Apple) of one release, as
  the store last reported it. It is read only on purpose: it has no control, and it says where the
  number came from. Apple's phased release is not read yet, so an iOS release has no share to show.
  Props: release (a ReleaseSummary), appName? (for the accessible name).
-->
<script lang="ts">
  import { formatRollout } from '../../lib/portfolio.ts';
  import { rolloutView } from '../../lib/release.ts';
  import { t } from '../../lib/i18n/t.ts';
  import T from '../ui/T.svelte';
  import type { ReleaseSummary } from '../../lib/types.ts';
import { byFamily } from '@kiln/core';

  let { release }: { release: ReleaseSummary } = $props();

  const uid = $props.id();
  const view = $derived(rolloutView(release));
  const percent = $derived(view.fraction === null ? null : formatRollout(view.fraction));
  const source = $derived(byFamily(release.platform, { apple: 'App Store Connect', google: 'Google Play' }));
</script>

<div class="rollout">
  <p class="head">
    <span class="title" id="{uid}-title">{view.title}</span>
    {#if view.fraction !== null}
      <span class="value"><T key="release-store:ro.value" params={{ percent: percent ?? '' }} tags={{ em: mutedText }} /></span>
    {:else}
      <span class="text muted">{view.text}</span>
    {/if}
  </p>
  {#if view.fraction !== null}
    <div
      class="bar"
      role="meter"
      aria-labelledby="{uid}-title"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(view.fraction * 1000) / 10}
      aria-valuetext={t('release-store:ro.valueText', { percent: percent ?? '' })}
    >
      <div class="fill" style:width="{view.fraction * 100}%"></div>
    </div>
  {/if}
  <p class="source muted">{t('release-store:ro.observed', { source })}</p>
</div>

{#snippet mutedText(text: string)}<span class="muted">{text}</span>{/snippet}

<style>
  .rollout {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: baseline;
    margin: 0;
  }

  .title {
    font-weight: var(--weight-semibold);
  }

  .source {
    margin: 0;
    font-size: 0.8125rem;
  }

  .bar {
    height: var(--space-2);
    overflow: hidden;
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .fill {
    height: 100%;
    background: var(--accent);
  }

  .value,
  .text {
    margin: 0;
    font-size: 0.9375rem;
  }
</style>
