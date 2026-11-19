<!--
  PendingBar: one quiet strip under the header of every app page while the app has changes waiting to be published: "3 changes
  waiting. Nothing is published until you review them." and one "Review and publish" button that opens the pending changes of the app
  (the existing review and publish flow; the button only opens it). Drawn only while something is pending, and not on the pending page
  itself (lib/app-page.ts `pendingBar`).
  Props: bar (from pendingBar, or null), href (the pending changes page of the app).
-->
<script lang="ts">
  import type { PendingBar } from '../../lib/app-page.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  let { bar, href }: { bar: PendingBar | null; href: string } = $props();
</script>

{#if bar}
  <div class="pending-bar" class:blocking={bar.blocking} role="status" data-testid="pending-bar">
    <Icon name={bar.blocking ? 'alert-triangle' : 'upload'} size={16} />
    <p>{bar.text}</p>
    <Button size="sm" {href}>{bar.action}</Button>
  </div>
{/if}

<style>
  .pending-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-4);
    font-size: var(--text-sm);
    color: var(--ink);
    background: var(--warn-bg, var(--surface-sunken));
    border: 1px solid var(--line);
    border-left: 3px solid var(--warn);
    border-radius: var(--radius-md);
  }

  p {
    flex: 1;
    min-width: 12rem;
    margin: 0;
  }

  .pending-bar :global(.icon) {
    color: var(--warn);
  }
</style>
