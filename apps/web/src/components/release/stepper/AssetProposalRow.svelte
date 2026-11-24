<!--
  AssetProposalRow: one proposed change of the card "Store assets changed in the repository" (AssetProposalCard.svelte, docs/adr/0063-release-asset-proposal.md):
  a checkbox, the name and language of the item, and what changed: for a text the store value beside the repository value, for a graphics set the
  files of the repository (CartGraphicsDetail). Presentation only: the card owns the selection and the staging. The `extra` snippet is the place
  for more detail under the item (a fuller comparison of the files, a diff view) without changing the card.
  A text has a Diff button and a graphics set can be opened (its thumbnails are a button) to compare the store with the repository (`ondiff`: the card
  owns the dialogs, so previous and next run across the list; docs/adr/0067-diff-and-preview.md).
  Props: item (ProposalItem), workspaceId, appId, selected, disabled, ontoggle, ondiff (optional), extra (optional snippet).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ProposalItem } from '@kiln/core';
  import { assetFileUrl } from '../../../lib/assets/assets.ts';
  import { itemTitle, localeName } from '../../../lib/asset-proposal.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import CartGraphicsDetail from '../../app/CartGraphicsDetail.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';

  let {
    item,
    workspaceId,
    appId,
    selected,
    disabled,
    ontoggle,
    ondiff,
    extra,
  }: {
    item: ProposalItem;
    workspaceId: string;
    appId: string;
    selected: boolean;
    disabled: boolean;
    ontoggle: () => void;
    ondiff?: ((item: ProposalItem) => void) | undefined;
    extra?: Snippet<[ProposalItem]>;
  } = $props();

  const clip = (text: string | null, max = 240): string => (text === null || text === '' ? t('release-stepper:ap.item.empty') : text.length > max ? `${text.slice(0, max)}…` : text);
</script>

<li class="row" class:bad={item.hasErrors}>
  <input
    type="checkbox"
    checked={selected}
    {disabled}
    aria-label={t('release-stepper:ap.item.selectAria', { item: itemTitle(item), locale: localeName(item.locale) })}
    onchange={ontoggle}
  />
  <div class="body">
    <p class="head">
      <strong>{itemTitle(item)}</strong>
      <span class="muted">{localeName(item.locale)}</span>
      {#if item.hasErrors}<Badge tone="bad" icon="x-circle">{t('release-stepper:ap.item.hasIssues')}</Badge>{/if}
      {#if item.kind === 'text' && ondiff}
        <Button size="sm" variant="ghost" icon="columns" iconOnly label={t('release-stepper:ap.diff.aria', { item: itemTitle(item), locale: localeName(item.locale) })} onclick={() => ondiff(item)} />
      {/if}
    </p>
    {#if item.kind === 'text'}
      <div class="diff">
        <p class="side"><span class="label">{t('release-stepper:ap.item.store')}</span><span class="val">{clip(item.before)}</span></p>
        <p class="side"><span class="label">{t('release-stepper:ap.item.repo')}</span><span class="val">{clip(item.after)}</span></p>
      </div>
    {:else if ondiff}
      <button type="button" class="open" aria-label={t('release-stepper:ap.diff.openImages', { item: itemTitle(item), locale: localeName(item.locale) })} onclick={() => ondiff(item)}>
        <CartGraphicsDetail
          files={item.after.count}
          before={item.before}
          thumbs={item.after.files.slice(0, 4).map((f) => assetFileUrl(workspaceId, appId, f.path, item.after.commit))}
        />
      </button>
    {:else}
      <CartGraphicsDetail
        files={item.after.count}
        before={item.before}
        thumbs={item.after.files.slice(0, 4).map((f) => assetFileUrl(workspaceId, appId, f.path, item.after.commit))}
      />
    {/if}
    {#if extra}{@render extra(item)}{/if}
  </div>
</li>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .row {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .row.bad {
    border-color: var(--bad-line);
  }
  .row input {
    margin-top: var(--space-1);
  }
  .body {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
    flex: 1;
  }
  .open {
    padding: var(--space-1);
    font: inherit;
    color: inherit;
    text-align: start;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .open:hover {
    background: var(--surface-hover);
    border-color: var(--line-hover);
  }
  .open:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .diff {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-2);
  }
  .side {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
    min-width: 0;
  }
  .label {
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .val {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
