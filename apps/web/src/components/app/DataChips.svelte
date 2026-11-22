<!--
  DataChips: where the data of this app lives (docs/ux-ia.md section 3): Repository and Store live
  inline, on the one row of the app header. A chip that is only a stand-in until a connector reads it
  (Store draft) is not drawn on the row; it sits in a small popover so nothing is lost.
  Props: chips (from dataChips).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { DataChip } from '../../lib/app-chips.ts';
  import Badge from '../ui/Badge.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let { chips }: { chips: DataChip[] } = $props();

  const shown = $derived(chips.filter((c) => !c.placeholder));
  const stand = $derived(chips.filter((c) => c.placeholder));
</script>

<ul class="chips" aria-label={t('app:chips.where')}>
  {#each shown as c (c.id)}
    <li title={c.title}>
      <span class="label">{c.label}</span>
      <Badge tone={c.tone} dot>{c.value}</Badge>
    </li>
  {/each}
  {#if stand.length > 0}
    <li>
      <InfoTip label={t('app:chips.whereMore')} align="start" width="18rem">
        {#each stand as c (c.id)}
          <p><strong>{c.label}:</strong> {c.value}. {c.title}</p>
        {/each}
      </InfoTip>
    </li>
  {/if}
</ul>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: center;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .label {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }
</style>
