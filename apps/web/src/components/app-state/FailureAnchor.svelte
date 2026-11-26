<!--
  FailureAnchor: wraps the failure block of a publish (PublishFailure) wherever the pending panel draws it (the cart drawer, the Pending page
  of an app, the workspace Pending page). When a person asked to be shown the failure (the top bar's "Publish failed", the Next step card's
  "Show pending changes": `publishingFocus.askFailure`) it scrolls into view and takes focus, once. Draws nothing of its own.
  Props: appId (the record the failure is about), children.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { publishingFocus } from '../../lib/publishing-focus.svelte.ts';

  let { appId, children }: { appId: string; children: Snippet } = $props();

  let box = $state<HTMLDivElement>();
  $effect(() => {
    if (box === undefined || publishingFocus.failureRequested !== appId) return;
    const el = box;
    const id = appId;
    queueMicrotask(() => {
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      el.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
      publishingFocus.doneFailure(id);
    });
  });
</script>

<div class="failure-anchor" data-testid="failure-anchor" data-app-id={appId} tabindex="-1" bind:this={box}>
  {@render children()}
</div>

<style>
  .failure-anchor:focus {
    outline: none;
  }
</style>
