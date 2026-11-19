<!--
  SectionsToggle: one quiet button, "Collapse all" or "Expand all", for the collapsible sections (Section) of the page it sits on.
  Drawn only from three sections on the page. Put it in the toolbar of the page.
-->
<script lang="ts">
  import { sectionHost } from '../../lib/section-host.svelte.ts';
  import { showsToggleAll, toggleAllLabel } from '../../lib/section-state.ts';
  import Button from './Button.svelte';

  const host = sectionHost();
</script>

{#if host && showsToggleAll(host.count)}
  <Button variant="ghost" size="sm" icon={host.anyOpen ? 'chevron-up' : 'chevron-down'} onclick={() => host.setAll(!host.anyOpen)}>{toggleAllLabel(host.anyOpen)}</Button>
{/if}
