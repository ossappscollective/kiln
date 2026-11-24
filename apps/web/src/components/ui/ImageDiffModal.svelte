<!--
  ImageDiffModal: the image viewer of a change (docs/adr/0067-diff-and-preview.md): an ImageDiff in a dialog (Modal: native <dialog>,
  focus trap, Escape closes, focus returns to the opener) with previous and next across the list of pairs (buttons, and the left and
  right arrow keys while the focus is not on a slider or a field).
  Props: open (bindable), index (bindable), pairs (ImagePair[]: { key, title, subtitle?, before, after }), beforeLabel, afterLabel.
  Read only.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { ImageMode, ImagePair } from '../../lib/diff/image-diff.ts';
  import Button from './Button.svelte';
  import ImageDiff from './ImageDiff.svelte';
  import Modal from './Modal.svelte';

  let {
    open = $bindable(false),
    index = $bindable(0),
    pairs,
    beforeLabel,
    afterLabel,
  }: {
    open?: boolean | undefined;
    index?: number | undefined;
    pairs: readonly ImagePair[];
    beforeLabel: string;
    afterLabel: string;
  } = $props();

  let mode = $state<ImageMode>('side');
  let zoom = $state<'fit' | 'actual'>('fit');
  const pair = $derived(pairs[Math.min(Math.max(index, 0), Math.max(pairs.length - 1, 0))]);
  const step = (by: number) => {
    if (pairs.length > 1) index = (index + by + pairs.length) % pairs.length;
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

{#if pair}
  <Modal bind:open title={pair.title} description={pair.subtitle} size="lg">
    {#key pair.key}
      <ImageDiff before={pair.before} after={pair.after} {beforeLabel} {afterLabel} bind:mode bind:zoom />
    {/key}
    {#snippet footer()}
      {#if pairs.length > 1}
        <span class="muted pos" aria-live="polite">{t('common:diff.position', { index: Math.min(index, pairs.length - 1) + 1, count: pairs.length })}</span>
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
