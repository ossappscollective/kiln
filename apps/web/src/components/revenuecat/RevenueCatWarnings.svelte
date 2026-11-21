<!--
  RevenueCatWarnings: the things to check in the RevenueCat set-up of the app, worst first, in a collapsed list under the Products table:
  a store product that RevenueCat does not have, a RevenueCat product that the store does not have, an entitlement without an active
  product, a product in no offering (docs/adr/0039-revenuecat.md). Computed from the two stored copies; each line says the fix. This tool
  changes nothing in either place.
  Props: warnings (the list of the joined view).
-->
<script lang="ts">
  import { type RevenueCatWarning, sortedWarnings, warningsSummary } from '../../lib/revenuecat/revenuecat.ts';
  import Badge from '../ui/Badge.svelte';
  import Disclosure from '../ui/Disclosure.svelte';

  let { warnings, appId }: { warnings: RevenueCatWarning[]; appId: string } = $props();

  const summary = $derived(warningsSummary(warnings));
  const sorted = $derived(sortedWarnings(warnings));
</script>

{#if summary}
  <Disclosure summary={summary.text} stateKey="revenuecat-warnings-{appId}" variant="boxed">
    <ul class="plain list" aria-label="Things to check in RevenueCat">
      {#each sorted as w, i (i)}
        <li class="text-sm">
          <Badge tone={w.severity === 'info' ? 'info' : w.severity}>{w.severity === 'bad' ? 'Problem' : w.severity === 'warn' ? 'Check' : 'Note'}</Badge>
          {w.message}
        </li>
      {/each}
    </ul>
  </Disclosure>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
  }
</style>
