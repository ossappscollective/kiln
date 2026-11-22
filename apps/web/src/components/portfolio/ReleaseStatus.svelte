<!--
  ReleaseStatus: the normalized lifecycle status of a release as a Badge, with the staged rollout
  share beside it when the store reports one. A state the store reports but the model has no
  mapping for reads "Unmapped"; the raw state is shown next to it elsewhere.
  `sentForReviewAt` (Google Play, from this app's own record of the send): adds "In review" beside the status. Google Play reports no review state,
  so it is a statement about what was sent from here, said in the tooltip.
  Props: status (ReleaseState or null), rawState?, rolloutFraction? (0 to 1), sentForReviewAt?.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { formatDateTime } from '../../lib/i18n/format.ts';
  import type { ReleaseState } from '@kiln/core';
  import { formatRollout, statusInfo } from '../../lib/portfolio.ts';
  import { statusIcon } from '../../lib/status-icons.ts';
  import Badge from '../ui/Badge.svelte';

  let {
    status,
    rawState,
    rolloutFraction = null,
    sentForReviewAt = null,
  }: {
    status: ReleaseState | null;
    rawState?: string | undefined;
    rolloutFraction?: number | null | undefined;
    sentForReviewAt?: number | null | undefined;
  } = $props();

  const playReviewNote = (at: number) => t('portfolio:release.playReviewNote', { when: formatDateTime(at) });
  const info = $derived(statusInfo(status, rawState));
  const rollout = $derived(formatRollout(rolloutFraction));
</script>

<span class="status" title={sentForReviewAt ? playReviewNote(sentForReviewAt) : info.description}>
  <Badge tone={info.tone} icon={statusIcon(status)}>{info.label}</Badge>
  {#if rollout}<span class="rollout muted"><span class="visually-hidden">{t('portfolio:release.rollout')} </span>{rollout}</span>{/if}
</span>

<style>
  .status {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    white-space: nowrap;
  }

  .rollout {
    font-size: var(--text-sm);
  }
</style>
