<!--
  ReleaseStatus: the normalized lifecycle status of a release as a Badge, with the staged rollout
  share beside it when the store reports one. A state the store reports but the model has no
  mapping for reads "Unmapped"; the raw state is shown next to it elsewhere.
  `sentForReviewAt` (Google Play, from this app's own record of the send): adds "In review" beside the status. Google Play reports no review state,
  so it is a statement about what was sent from here, said in the tooltip.
  `unconfirmed` (Google Play production, lib/play-live.ts): the store says live but cannot say whether the release is approved and waiting
  for the person to publish it, so the badge reads "Live, not confirmed" (neutral) and the tooltip says why.
  Props: status (ReleaseState or null), rawState?, rolloutFraction? (0 to 1), sentForReviewAt?, unconfirmed? (false).
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
    unconfirmed = false,
  }: {
    status: ReleaseState | null;
    rawState?: string | undefined;
    rolloutFraction?: number | null | undefined;
    sentForReviewAt?: number | null | undefined;
    unconfirmed?: boolean | undefined;
  } = $props();

  const playReviewNote = (at: number) => t('portfolio:release.playReviewNote', { when: formatDateTime(at) });
  const info = $derived(statusInfo(status, rawState));
  const rollout = $derived(formatRollout(rolloutFraction));
  const notConfirmed = $derived(unconfirmed && !sentForReviewAt && (status === 'live' || status === 'rolling_out'));
  const label = $derived(notConfirmed ? t('portfolio:status.unconfirmed.label', { status: info.label }) : info.label);
</script>

<span class="status" title={sentForReviewAt ? playReviewNote(sentForReviewAt) : notConfirmed ? t('portfolio:status.unconfirmed.description') : info.description}>
  <Badge tone={notConfirmed ? 'neutral' : info.tone} icon={statusIcon(status)}>{label}</Badge>
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
