<!--
  StatusDot: the status of one listing cell as a small round mark. The mark has a glyph as well as a
  tone, and carries its meaning as an accessible name, so the colour is never the only signal.
  Props: status (CellStatus), label? (overrides the accessible name and the tooltip).
-->
<script lang="ts">
  import { type CellStatus, cellInfo } from '../../lib/listing/matrix.ts';
  import { useCompare } from '../../lib/listing/compare-context.ts';
  import Icon from '../ui/Icon.svelte';

  let { status, label }: { status: CellStatus; label?: string | undefined } = $props();

  // "In sync" reads "No problems" when the repository is not compared (the page's compare context, not a module flag).
  const compare = useCompare();
  const info = $derived(cellInfo(status, !compare().repo));
  const name = $derived(label ?? info.label);
</script>

<span class="sdot {status === 'na' ? 'na' : info.tone}" role="img" aria-label={name} title={name}>
  {#if status !== 'na'}<Icon name={info.icon} size={12} />{/if}
</span>

<style>
  .sdot {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    color: var(--muted);
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .sdot.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }

  .sdot.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad-line);
  }

  .sdot.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .sdot.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .sdot.na {
    background: transparent;
    border-style: dashed;
    border-color: var(--line);
    opacity: 0.6;
  }
</style>
