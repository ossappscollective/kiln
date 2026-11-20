<!--
  PullResultSummary: what a pull of the store listing into the repository did, kept on the listing
  tab after the dialog closed: the draft (with a link to review it), what changes, and which fields
  were left out and why. Props: result (PullResult), labelOf (a field id to its label), onreview
  (called before the link to the change set is followed), ondismiss.
-->
<script lang="ts">
  import { groupSkipped, skipSubject, summarizePull, targetText } from '../../lib/listing/pull.ts';
  import { reviewHref } from '../../lib/repository-intent.ts';
  import type { PullResult } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';

  let {
    result,
    labelOf,
    onreview,
    ondismiss,
  }: {
    result: PullResult;
    labelOf: (field: string) => string;
    onreview: (result: PullResult) => void;
    ondismiss: () => void;
  } = $props();

  const summary = $derived(summarizePull(result));
  const groups = $derived(groupSkipped(result.skipped));
</script>

<Alert tone={summary.tone} title="Pull into the repository" {ondismiss}>
  <p class="line">{summary.headline}</p>
  {#each summary.details as detail (detail)}
    <p class="line">{detail}</p>
  {/each}
  <p class="line muted">{targetText(result.target)}</p>
  {#if result.changeSet}
    <p class="line">
      <a href={reviewHref} onclick={() => onreview(result)}>Review the draft in the Change sets tab of {result.target.repository}</a>
    </p>
    <details>
      <summary>What changes ({result.changes.length})</summary>
      <ul>
        {#each result.changes as change (change.locale + change.field)}
          <li>
            {change.locale} · {change.label}
            {#if change.newLocale}<Badge tone="info">new locale</Badge>{/if}
            {#if change.repoLocale !== change.locale}<span class="muted">(written to {change.repoLocale})</span>{/if}
          </li>
        {/each}
      </ul>
    </details>
  {/if}
  {#if groups.length > 0}
    <details>
      <summary>Left out ({result.skipped.length})</summary>
      {#each groups as group (group.reason)}
        <h4>{group.label}</h4>
        <ul>
          {#each group.items as item (item.locale + (item.field ?? ''))}
            <li><strong>{skipSubject(item, labelOf)}.</strong> {item.message}</li>
          {/each}
        </ul>
      {/each}
    </details>
  {/if}
</Alert>

<style>
  .line {
    margin: var(--space-1) 0 0;
  }

  details {
    margin-top: var(--space-2);
  }

  summary {
    cursor: pointer;
    font-weight: var(--weight-medium);
  }

  h4 {
    margin: var(--space-2) 0 var(--space-1);
    font-size: var(--text-sm);
  }

  ul {
    padding-left: var(--space-5);
    margin: 0;
  }
</style>
