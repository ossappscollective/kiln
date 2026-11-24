<!--
  DiffModal: a TextDiff in a dialog (Modal: native <dialog>, focus trap, Escape closes, focus returns to the opener), with previous and
  next across the list of changed items (also the left and right arrow keys while the focus is not in a field).
  Props: open (bindable), index (bindable), items (the changed texts: { key, title, subtitle?, before, after, limit?, unit? }),
  beforeLabel, afterLabel ("Store" / "Repository" / "Staged").
  Read only: nothing here changes a text or a store.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { DiffItem } from '../../lib/diff/text-diff.ts';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';
  import TextDiff from './TextDiff.svelte';

  let {
    open = $bindable(false),
    index = $bindable(0),
    items,
    beforeLabel,
    afterLabel,
  }: {
    open?: boolean | undefined;
    index?: number | undefined;
    items: readonly DiffItem[];
    beforeLabel: string;
    afterLabel: string;
  } = $props();

  const item = $derived(items[Math.min(Math.max(index, 0), Math.max(items.length - 1, 0))]);
  const step = (by: number) => {
    if (items.length > 1) index = (index + by + items.length) % items.length;
  };
  function keys(event: KeyboardEvent) {
    if (!open || event.altKey || event.ctrlKey || event.metaKey) return;
    const el = event.target;
    if (el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
    if (event.key === 'ArrowLeft') {
      step(-1);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      step(1);
      event.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={keys} />

{#if item}
  <Modal bind:open title={item.title} description={item.subtitle} size="lg">
    {#key item.key}
      <TextDiff before={item.before} after={item.after} {beforeLabel} {afterLabel} limit={item.limit} unit={item.unit} />
    {/key}
    {#snippet footer()}
      {#if items.length > 1}
        <span class="muted pos" aria-live="polite">{t('common:diff.position', { index: Math.min(index, items.length - 1) + 1, count: items.length })}</span>
        <Button icon="chevron-left" onclick={() => step(-1)}>{t('common:diff.prev')}</Button>
        <Button icon="chevron-right" onclick={() => step(1)}>{t('common:diff.next')}</Button>
      {/if}
      <Button variant="primary" onclick={() => (open = false)}>{t('common:action.close')}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .pos {
    margin-right: auto;
    font-size: var(--text-sm);
  }
</style>
