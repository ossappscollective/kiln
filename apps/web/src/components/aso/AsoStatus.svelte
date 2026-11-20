<!--
  AsoStatus: the configuration of ASO as one quiet pill: Google Play reading off, automatic checks off. It is
  not drawn when everything that matters is on. The details open under the pill.
  Props: config (from GET /aso/config, or null), androidInScope.
-->
<script lang="ts">
  import { type AsoConfig, configStates } from '../../lib/aso/aso.ts';
  import StatusPill from '../ui/StatusPill.svelte';

  let { config, androidInScope }: { config: AsoConfig | null; androidInScope: boolean } = $props();

  const states = $derived(configStates(config, androidInScope));
</script>

{#if states}
  <StatusPill tone="info" label={states.label} stateKey="aso.config">
    <ul class="items">
      {#each states.items as item (item)}<li>{item}</li>{/each}
    </ul>
  </StatusPill>
{/if}

<style>
  .items {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }
</style>
