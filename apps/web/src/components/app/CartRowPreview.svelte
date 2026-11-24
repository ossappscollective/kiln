<!--
  CartRowPreview: the expanded part of a cart row (docs/adr/0067-diff-and-preview.md), shared by the pending cart drawer and the
  workspace Pending page. Reads the detail of the item lazily (once per item version) and shows, by kind: a text diff (listing text:
  store text against the staged text; release field: the staged value, the store is not read), before and after images (a click opens the
  image viewer with swipe, fade and difference), the price table (CartPriceDetail), or the reply draft with the review it answers.
  Read only: nothing here changes or sends anything.
  Props: api, workspaceId, row (a CartRow), id (the DOM id the row's chevron points to with aria-controls).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { cartDetailStore } from '../../lib/cart-preview.svelte.ts';
  import { previewOf } from '../../lib/cart-preview.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { CartRow } from '../../lib/pending-cart.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import ImageDiffModal from '../ui/ImageDiffModal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextDiff from '../ui/TextDiff.svelte';
  import CartPriceDetail from './CartPriceDetail.svelte';

  let { api, workspaceId, row, id }: { api: Api; workspaceId: string; row: CartRow; id: string } = $props();

  const entry = $derived(cartDetailStore.entryOf(row));
  const preview = $derived(previewOf(row, entry?.status === 'ok' ? entry.detail : null));
  let viewer = $state(false);
  let at = $state(0);

  $effect(() => {
    if (row.kind !== 'price') void cartDetailStore.load(api, workspaceId, row);
  });

  const stars = (n: number) => t('app:cart.stars', { count: n });
</script>

<div class="preview" {id} data-testid="cart-preview">
  {#if preview.kind === 'price' && row.price}
    <CartPriceDetail price={row.price} open />
  {:else if entry?.status === 'failed'}
    <Alert tone="error">{t('app:cart.preview.failed')}</Alert>
    <div><Button size="sm" icon="refresh" onclick={() => void cartDetailStore.load(api, workspaceId, row, true)}>{t('common:action.tryAgain')}</Button></div>
  {:else if preview.kind === 'none'}
    <div role="status" aria-label={t('app:cart.preview.loading')}><Skeleton width="100%" height="72px" /></div>
  {:else if preview.kind === 'text'}
    {#if preview.beforeNote === 'none'}<p class="muted note">{t('app:cart.preview.noStoreText')}</p>{/if}
    {#if preview.beforeNote === 'unknown'}<p class="muted note">{t('app:cart.preview.storeNotRead')}</p>{/if}
    <TextDiff before={preview.before} after={preview.after} beforeLabel={t('common:diff.store')} afterLabel={t('common:diff.staged')} limit={preview.limit} unit={preview.unit} />
    {#if preview.truncated}<p class="muted note">{t('app:cart.preview.truncated')}</p>{/if}
  {:else if preview.kind === 'images'}
    {#if !preview.beforeKnown}<p class="muted note">{t('app:cart.preview.noStoreImages')}</p>{/if}
    {#if preview.pairs.length === 0}<p class="muted note">{t('app:cart.preview.noImages')}</p>{/if}
    <ul class="pairs">
      {#each preview.pairs as p, i (p.key)}
        <li>
          <button type="button" class="pair" aria-label={t('app:cart.preview.compare', { title: p.title })} onclick={() => ((at = i), (viewer = true))}>
            <span class="side">
              {#if p.before?.url}<img src={p.before.url} alt="" loading="lazy" />{:else}<span class="none" aria-hidden="true">+</span>{/if}
              <span class="cap">{p.before?.url ? t('common:diff.store') : t('common:diff.image.noBefore')}</span>
            </span>
            <span class="arrow" aria-hidden="true">→</span>
            <span class="side">
              {#if p.after?.url}<img src={p.after.url} alt="" loading="lazy" />{:else}<span class="none" aria-hidden="true">−</span>{/if}
              <span class="cap">{p.after?.url ? t('common:diff.staged') : t('common:diff.image.noAfter')}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    {#if preview.truncated}<p class="muted note">{t('app:cart.preview.moreImages')}</p>{/if}
    <ImageDiffModal bind:open={viewer} bind:index={at} pairs={preview.pairs} beforeLabel={t('common:diff.store')} afterLabel={t('common:diff.staged')} />
  {:else if preview.kind === 'reply'}
    <div class="reply">
      <h4>{t('app:cart.preview.review')}</h4>
      <blockquote dir="auto">
        <p><strong>{stars(preview.review.rating)}</strong>{#if preview.review.title} · {preview.review.title}{/if}</p>
        <p>{preview.review.body}</p>
        {#if preview.review.truncated}<p class="muted">{t('app:cart.preview.truncated')}</p>{/if}
      </blockquote>
      <h4>{t('app:cart.preview.draft')}</h4>
      <blockquote class="draft" dir="auto"><p>{preview.text}</p></blockquote>
      {#if preview.truncated}<p class="muted note">{t('app:cart.preview.truncated')}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    min-width: 0;
  }
  .note,
  p {
    margin: 0;
    font-size: var(--text-sm);
  }
  .pairs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pair {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    font: inherit;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .pair:hover {
    border-color: var(--line-hover);
    background: var(--surface-hover);
  }
  .pair:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }
  .side img,
  .none {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 96px;
    object-fit: contain;
    color: var(--muted);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .cap {
    font-size: var(--text-xs);
    color: var(--muted);
  }
  h4 {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  blockquote {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-inline-start: 3px solid var(--line-strong);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  blockquote.draft {
    background: var(--surface);
  }
</style>
