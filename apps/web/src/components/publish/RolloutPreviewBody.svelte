<!--
  RolloutPreviewBody: what a rollout change would do, as its confirmation shows it: the summary, what the store shows now and after,
  and the warnings of the server. Display only: it sends nothing and asks for nothing. Used by RolloutPreviewDialog and by the batch
  publish dialog, so a rollout change looks the same in both.
  Props: preview (the rollout preview of the server).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { type RolloutPreview, describeState } from '../../lib/store-rollout.ts';

  let { preview }: { preview: RolloutPreview } = $props();
</script>

<div class="stack">
  <p class="summary" data-testid="rollout-summary">{preview.summary}</p>

  <div class="compare" aria-label={t('publish:rollout.compareAria')}>
    <div>
      <p class="label">{t('publish:rollout.now')}</p>
      <p class="state">{describeState(preview.current)}</p>
    </div>
    <div>
      <p class="label">{t('publish:rollout.after')}</p>
      <p class="state">{describeState(preview.proposed)}</p>
    </div>
  </div>

  {#if preview.warnings.length > 0}
    <ul class="warnings">
      {#each preview.warnings as warning (warning)}<li>{warning}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .summary {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .compare > div {
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .state {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .warnings {
    margin: 0;
    padding-left: var(--space-5);
    font-size: var(--text-sm);
  }
</style>
