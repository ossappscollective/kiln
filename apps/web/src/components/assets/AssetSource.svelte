<!--
  AssetSource: where the files on the Assets tab were read from: the store the media is for, the
  repository, the commit that was read, how long ago, and whether the source was a local clone
  (fast) or GitHub (slower).
  One compact line; the explanation of the source and of the checks is behind a "Details" popover.
  Props: index (the asset index), now (ms), reloading, onreload.
  The source tells how much was read: a local clone is read in full, GitHub only up to a limit
  (the partial notice says so).
-->
<script lang="ts">
  import { formatDateTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { agoText } from '../../lib/aso/ago.ts';
  import { shortCommit, sourceHint, sourceText } from '../../lib/assets/assets.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import type { AssetIndex } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';
  import T from '../ui/T.svelte';

  let {
    index,
    now,
    reloading,
    onreload,
  }: { index: AssetIndex; now: number; reloading: boolean; onreload: () => void } = $props();

  const tone = $derived(index.source?.fast ? 'ok' : 'info');
</script>

<div class="source">
  <div class="line">
    <div class="info">
    <StoreBadge store={index.store} variant="full" />
    {#if index.source}
      <Badge {tone} icon={toneIcon(tone)}>{sourceText(index.source)}</Badge>
    {/if}
    {#if index.repository}<span class="muted"><T key="assets:source.repository" params={{ name: index.repository.name }} /></span>{/if}
    {#if index.commit}<span class="muted"><T key="assets:source.commit" params={{ commit: shortCommit(index.commit) }} /></span>{/if}
    {#if index.readAt !== null}
      <span class="muted">
        <time datetime={new Date(index.readAt).toISOString()} title={formatDateTime(index.readAt)}>{t(index.cached ? 'assets:source.readCached' : 'assets:source.read', { ago: agoText(index.readAt, now) })}</time>
      </span>
    {/if}
    <InfoTip label={t('assets:source.detailsLabel')} buttonText={t('assets:source.details')} width="28rem">
      {#if index.source}<p>{sourceHint(index.source)}</p>{/if}
      <p class="muted">{index.specs.basis}</p>
    </InfoTip>
    </div>
    <Button size="sm" icon="refresh" loading={reloading} onclick={onreload}>{reloading ? t('assets:source.reading') : t('assets:source.readAgain')}</Button>
  </div>
</div>

<style>
  .source {
    display: grid;
    gap: var(--space-2);
  }
  .line {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    font-size: 0.9375rem;
  }
  .info {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    min-width: 0;
  }
</style>
