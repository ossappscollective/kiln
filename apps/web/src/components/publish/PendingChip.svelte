<!--
  PendingChip: "3 pending" beside an app (the overview, the app switcher, the app header, the sidebar). Warning tone, with an icon and
  the words "with an error" for screen readers, when an error blocks something; a plain accent tone otherwise. When the last publish of the
  app failed it says "Publish failed" instead, in the warning tone (the count stays in what a screen reader hears): a chip never says
  "3 pending" as if nothing had gone wrong. Draws nothing when the summary is not known (an older server, a failed read), when nothing
  is pending and nothing failed, or when only the store has to act (in review), so it is quiet by default. With `href` it is a link to
  the pending changes of the app.
  Props: line ({ count, blocking, waiting, failed? } from the app-state store's `lineOf`, or null), href? (the pending section of the app).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { type PendingLine, chipFor } from '../../lib/pending.ts';
  import Icon from '../ui/Icon.svelte';

  let { line, href }: { line: (PendingLine & { failed?: boolean }) | null | undefined; href?: string | undefined } = $props();

  const counted = $derived(chipFor(line));
  const failed = $derived(line?.failed === true);
  const chip = $derived(
    failed
      ? { text: t('state:topBar.failed'), tone: 'warn' as const, label: t('state:topBar.failed') + (counted ? `, ${counted.label}` : '') }
      : counted,
  );
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
