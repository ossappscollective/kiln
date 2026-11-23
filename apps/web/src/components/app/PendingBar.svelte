<!--
  NOT MOUNTED any more (docs/adr/0054-pending-cart.md): the floating pending cart button replaced it. Kept only because files are not
  deleted here; remove it with `git rm`.
  PendingBar: one slim, quiet (not yellow) line under the header of an app page while the app has changes waiting to be published: "3
  changes waiting. Nothing is published until you review them." and one "Review and publish" button that opens the pending changes of
  the app (the existing review and publish flow; the button only opens it). Drawn only while something is pending, and not on the
  pending page itself (lib/app-page.ts `pendingBar`). On the Overview the changes are a link in the Next step card instead
  (`pendingPlacement`); only the blocking variant (an error that stops a change, warning colour) stays a bar there.
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
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-4);
    font-size: 0.9375rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  /* An error that stops a change is never quiet. */
  .pending-bar.blocking {
    background: var(--warn-bg, var(--surface-sunken));
    border-color: var(--warn-line, var(--line));
    border-left: 3px solid var(--warn);
  }

  p {
    flex: 1;
    min-width: 12rem;
    margin: 0;
  }

  .pending-bar :global(.icon) {
    color: var(--muted);
  }

  .pending-bar.blocking :global(.icon) {
    color: var(--warn);
  }
</style>
