<!--
  FilterChip: one pill of a filter row ("All 12", "Needs attention 2"). The selected one is `pressed` (aria-pressed), drawn with the chip
  tokens (--chip-ink on --chip-bg, a contrast-tested pair) and the accent border. Do not reuse `--accent-ink` here: that is the text ON a solid accent.
  Every rule is written as `button.fchip...` so it is at least as specific as the global button states (`button:hover:not(:disabled)`,
  `button.bare:hover`), which otherwise reset the background and the border of a selected chip while the pointer is on it.
  Props: label, count? (number or text), pressed, onclick.
-->
<script lang="ts">
  let {
    label,
    count,
    pressed,
    onclick,
  }: {
    label: string;
    count?: number | string | undefined;
    pressed: boolean;
    onclick: () => void;
  } = $props();
</script>

<button type="button" class="fchip" aria-pressed={pressed} {onclick}>
  <span>{label}</span>{#if count !== undefined}<span class="n tabular">{count}</span>{/if}
</button>

<style>
  button.fchip {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
    box-shadow: none;
  }

  button.fchip:hover:not(:disabled) {
    color: var(--ink);
    background: var(--surface-hover);
    border-color: var(--line-hover);
  }

  button.fchip[aria-pressed='true'],
  button.fchip[aria-pressed='true']:hover:not(:disabled) {
    color: var(--chip-ink);
    background: var(--chip-bg);
    border-color: var(--accent);
  }

  button.fchip:focus-visible {
    outline: var(--ring);
    outline-offset: 2px;
    box-shadow: none;
  }

  .n {
    font-weight: var(--weight-semibold);
  }
</style>
