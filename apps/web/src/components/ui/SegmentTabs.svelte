<!--
  SegmentTabs: a small segmented tab list (for example iOS | Android) whose panels are drawn by the
  parent, all at once, with the inactive ones hidden. Hiding keeps what each panel loaded and typed, so
  switching back is instant. Arrow keys, Home and End move between tabs.
  Props: tabs ({ id, label, count? }[]), value (bindable id), label (accessible name), idPrefix (so the
  parent can name its panels: tab `${idPrefix}-tab-${id}`, panel `${idPrefix}-panel-${id}`). The parent
  draws `<div role="tabpanel" id={...} aria-labelledby={...} hidden={value !== id}>` for each tab.
  Use `segmentIds(idPrefix, id)` from here for those ids.
-->
<script lang="ts" module>
  export const segmentIds = (idPrefix: string, id: string): { tab: string; panel: string } => ({
    tab: `${idPrefix}-tab-${id}`,
    panel: `${idPrefix}-panel-${id}`,
  });
</script>

<script lang="ts">
  type Tab = { id: string; label: string; count?: number };

  let {
    tabs,
    value = $bindable(),
    label,
    idPrefix,
  }: { tabs: Tab[]; value?: string | undefined; label: string; idPrefix: string } = $props();

  const active = $derived(tabs.find((t) => t.id === value)?.id ?? tabs[0]?.id ?? '');
  let buttons = $state<Record<string, HTMLButtonElement | undefined>>({});

  function onkeydown(event: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === active);
    let next = i;
    if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    value = target.id;
    buttons[target.id]?.focus();
  }
</script>

<div class="segments" role="tablist" aria-label={label}>
  {#each tabs as tab (tab.id)}
    <button
      bind:this={buttons[tab.id]}
      type="button"
      class="bare seg"
      role="tab"
      id={segmentIds(idPrefix, tab.id).tab}
      aria-selected={active === tab.id}
      aria-controls={segmentIds(idPrefix, tab.id).panel}
      tabindex={active === tab.id ? 0 : -1}
      onclick={() => (value = tab.id)}
      {onkeydown}
    >
      {tab.label}
      {#if tab.count !== undefined}<span class="count tabular">{tab.count}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .segments {
    display: inline-flex;
    flex-wrap: wrap;
    max-width: 100%;
    padding: 2px;
    background: var(--seg-track);
    border-radius: var(--radius-md);
  }

  .seg {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    min-height: calc(var(--control-sm) - 2px);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    border-radius: calc(var(--radius-md) - 2px);
  }

  .seg:hover {
    color: var(--ink);
  }

  /* surface-hover is nearly the colour of the track, so the hover is a tint of the ink (visible in both themes). The selector is as
     specific as the global `button.bare:hover:not(:disabled)`, which clears backgrounds and would otherwise win. */
  .segments button.seg.bare:not([aria-selected='true']):hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 10%, transparent);
  }

  /* The selected segment: a violet ring with a soft glow (--seg-selected-ring). */
  .seg[aria-selected='true'] {
    color: var(--ink);
    background: var(--seg-selected);
    box-shadow: var(--seg-selected-ring);
  }

  .seg:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }

  .count {
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
