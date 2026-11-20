<!--
  ReleaseStatus: the normalized lifecycle status of a release as a Badge, with the staged rollout
  share beside it when the store reports one. A state the store reports but the model has no
  mapping for reads "Unmapped"; the raw state is shown next to it elsewhere.
  `sentForReviewAt` (Google Play, from this app's own record of the send): adds "In review" beside the status. Google Play reports no review state,
  so it is a statement about what was sent from here, said in the tooltip.
  Props: status (ReleaseState or null), rawState?, rolloutFraction? (0 to 1), sentForReviewAt?.
-->
<script lang="ts">
  import type { ReleaseState } from '@mrm/core';
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
    rawState?: string;
    rolloutFraction?: number | null;
    sentForReviewAt?: number | null | undefined;
  } = $props();

  const info = $derived(statusInfo(status, rawState));
  const rollout = $derived(formatRollout(rolloutFraction));
</script>

<span class="status" title={info.description}>
  <Badge tone={info.tone} icon={statusIcon(status)}>{info.label}</Badge>
  {#if rollout}<span class="rollout muted"><span class="visually-hidden">Rollout </span>{rollout}</span>{/if}
  {#if sentForReviewAt && status !== 'in_review'}
    <span title="Sent to Google Play from here {new Date(sentForReviewAt).toLocaleString()}. Google Play does not report the review state: the release may still be waiting for review. Check Play Console."><Badge tone="info" icon="clock">In review</Badge></span>
  {/if}
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
