<!--
  PendingChip: "3 pending" beside an app (the overview, the app switcher, the app header, the sidebar). Warning tone, with an icon and
  the words "with an error" for screen readers, when an error blocks something; a plain accent tone otherwise. Draws nothing when the
  summary is not known (an older server, a failed read), when nothing is pending, or when only the store has to act (in review), so it
  is quiet by default. With `href` it is a link to the pending changes of the app.
  Props: line ({ count, blocking, waiting } from lineFor, or null), href? (the pending section of the app).
-->
<script lang="ts">
  import { type PendingLine, chipFor } from '../../lib/pending.ts';
  import Icon from '../ui/Icon.svelte';

  let { line, href }: { line: PendingLine | null | undefined; href?: string | undefined } = $props();

  const chip = $derived(chipFor(line));
  /** What a screen reader hears beyond the visible words, for example ", 1 with an error". */
  const extra = $derived(chip ? chip.label.slice(chip.text.length) : '');
</script>

{#if chip}
  {#if href}
    <a class="badge {chip.tone} pending-chip" {href} data-testid="pending-chip">
      {#if chip.tone === 'warn'}<Icon name="alert-triangle" size={12} />{/if}{chip.text}{#if extra}<span class="visually-hidden">{extra}</span>{/if}
    </a>
  {:else}
    <span class="badge {chip.tone} pending-chip" data-testid="pending-chip">
      {#if chip.tone === 'warn'}<Icon name="alert-triangle" size={12} />{/if}{chip.text}{#if extra}<span class="visually-hidden">{extra}</span>{/if}
    </span>
  {/if}
{/if}

<style>
  .pending-chip {
    white-space: nowrap;
    text-decoration: none;
  }

  a.pending-chip:hover {
    text-decoration: underline;
  }
</style>
