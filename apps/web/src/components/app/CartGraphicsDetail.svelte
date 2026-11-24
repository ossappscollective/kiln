<!--
  CartGraphicsDetail: what a staged set of graphics is in the pending cart: thumbnails of the files this server holds for it (the
  uploads), and "before -> after" in images (the images the last store read held for the set, when there was one, then the staged
  count). Props: files (after), before (number or null), thumbs (addresses of up to four uploaded files), line? (false: only the thumbnails,
  for a row whose own text already says the count).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';

  let { files, before = null, thumbs = [], line = true }: { files: number; before?: number | null | undefined; thumbs?: string[] | undefined; line?: boolean | undefined } = $props();
</script>

<div class="graphics">
  {#if thumbs.length > 0}
    <ul class="thumbs" aria-hidden="true">
      {#each thumbs as src (src)}<li><img {src} alt="" loading="lazy" width="28" height="48" /></li>{/each}
    </ul>
  {/if}
  {#if line}
    <p class="line">
      {#if before !== null}{t('app:cart.graphicsDiff', { before, after: files })}{:else}{t('app:cart.files', { count: files })}{/if}
    </p>
  {/if}
</div>

<style>
  .graphics {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .line {
    margin: 0;
  }
  .thumbs {
    display: flex;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .thumbs img {
    display: block;
    width: 28px;
    height: 48px;
    object-fit: contain;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
</style>
