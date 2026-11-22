<!--
  PullResultSummary: what a pull of the store listing into the repository did, kept on the listing
  tab after the dialog closed: the draft (with a link to review it), what changes, and which fields
  were left out and why. Props: result (PullResult), labelOf (a field id to its label), onreview
  (called before the link to the change set is followed), ondismiss.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { groupSkipped, skipSubject, summarizePull, targetText } from '../../lib/listing/pull.ts';
  import { reviewHref } from '../../lib/repository-intent.ts';
  import type { PullResult } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import T from '../ui/T.svelte';

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

<Alert tone={summary.tone} title={t('listing:pullResult.title')} {ondismiss}>
  <p class="line">{summary.headline}</p>
  {#each summary.details as detail (detail)}
    <p class="line">{detail}</p>
  {/each}
  <p class="line muted">{targetText(result.target)}</p>
  {#if result.changeSet}
    <p class="line">
      <T key="listing:pullResult.reviewLink" params={{ repository: result.target.repository }} tags={{ link: reviewLink }} />
    </p>
    <details>
      <summary>{t('listing:pullResult.changes', { count: result.changes.length })}</summary>
      <ul>
        {#each result.changes as change (change.locale + change.field)}
          <li>
            {t('listing:pullResult.changeLine', { locale: change.locale, label: change.label })}
            {#if change.newLocale}<Badge tone="info">{t('listing:pullResult.newLocale')}</Badge>{/if}
            {#if change.repoLocale !== change.locale}<span class="muted">{t('listing:pullResult.writtenTo', { locale: change.repoLocale })}</span>{/if}
          </li>
        {/each}
      </ul>
    </details>
  {/if}
  {#if groups.length > 0}
    <details>
      <summary>{t('listing:pullResult.leftOut', { count: result.skipped.length })}</summary>
      {#each groups as group (group.reason)}
        <h4>{group.label}</h4>
        <ul>
          {#each group.items as item (item.locale + (item.field ?? ''))}
            <li><T key="listing:pullResult.skipLine" params={{ subject: skipSubject(item, labelOf), message: item.message }} /></li>
          {/each}
        </ul>
      {/each}
    </details>
  {/if}
</Alert>
{#snippet reviewLink(text: string)}<a href={reviewHref} onclick={() => onreview(result)}>{text}</a>{/snippet}

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
