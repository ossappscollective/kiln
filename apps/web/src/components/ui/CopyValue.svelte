<!--
  CopyValue: a value in the mono token style on ONE line (ellipsis, the full value in the tooltip) with its copy icon button inline
  at the end, and an optional muted note under it ("from the workspace default"). Below ~420px of its own width the value wraps
  (anywhere) instead of being cut, so nothing is unreadable on a narrow screen.
  Props: value (what is copied and shown), copyLabel (accessible name of the button, "Copy <label>"), shown? (text to display when
  it differs from the value), note?, copyable? (default true).
-->
<script lang="ts">
  import CopyButton from './CopyButton.svelte';

  let {
    value,
    copyLabel,
    shown,
    note,
    copyable = true,
  }: { value: string; copyLabel: string; shown?: string | undefined; note?: string | undefined; copyable?: boolean | undefined } = $props();
</script>

<div class="copyvalue">
  <div class="line">
    <code class="value" title={shown ?? value}>{shown ?? value}</code>
    {#if copyable}<span class="copy"><CopyButton {value} iconOnly label={copyLabel} /></span>{/if}
  </div>
  {#if note}<small class="note muted">{note}</small>{/if}
</div>

<style>
  .copyvalue {
    min-width: 0;
    max-width: 100%;
    container-type: inline-size;
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
  }

  .value {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copy {
    flex-shrink: 0;
  }

  .note {
    display: block;
    margin-top: var(--space-1);
    font-size: var(--text-sm);
  }

  @container (max-width: 419px) {
    .value {
      overflow: visible;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>
