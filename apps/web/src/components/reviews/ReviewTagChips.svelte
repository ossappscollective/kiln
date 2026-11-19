<!--
  ReviewTagChips: the tags the AI assistant gave a review (topics, sentiment, severity), as small labels under the review. They are ADVISORY:
  they come from a model that read the review once, they are kept so it is not paid for twice, and they change nothing about the review
  (status, assignee, reply). Nothing is drawn for a review without tags, and nothing at all while AI is off.
  Props: reviewId.
-->
<script lang="ts">
  import { sentimentTone, severityTone, topicLabel } from '../../lib/ai-insights.ts';
  import { aiStore } from '../../lib/ai-store.svelte.ts';
  import Badge from '../ui/Badge.svelte';

  let { reviewId, workspaceId }: { reviewId: string; workspaceId: string } = $props();

  const config = $derived(aiStore.config(workspaceId));
  const on = $derived(config !== null && config.state !== 'off_server' && config.state !== 'off_workspace');
  const tags = $derived(on ? aiStore.tagFor(reviewId) : null);
</script>

{#if tags}
  <p class="tags" aria-label="Tags the AI assistant gave this review">
    {#each tags.topics as t (t)}<Badge>{topicLabel(t)}</Badge>{/each}
    <Badge tone={sentimentTone(tags.sentiment)}>{tags.sentiment}</Badge>
    {#if tags.severity !== 'none'}<Badge tone={severityTone(tags.severity)}>{tags.severity} severity</Badge>{/if}
    {#if tags.needsReply}<Badge tone="warn">Needs a reply</Badge>{/if}
    <span class="muted small">AI tags</span>
  </p>
{/if}

<style>
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    align-items: center;
    margin: 0;
  }

  .small {
    font-size: var(--text-xs);
  }
</style>
