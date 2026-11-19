<!--
  InstallGuide: the plain steps to install one build on a device, inside a popover. It says what the tool cannot do (an IPA for the
  App Store, an AAB on a phone) instead of hiding it. Props: guide (from lib/builds.ts installGuide).
-->
<script lang="ts">
  import type { Guide } from '../../lib/builds.ts';

  let { guide }: { guide: Guide } = $props();
</script>

<div class="guide">
  <strong>{guide.title}</strong>
  <ol>
    {#each guide.steps as step (step)}<li>{step}</li>{/each}
  </ol>
  {#if guide.caution}<p class="muted text-sm">{guide.caution}</p>{/if}
</div>

<style>
  .guide {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  ol {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  p {
    margin: 0;
  }
</style>
