<!--
  AssetProposalRow: one proposed change of the card "Store assets changed in the repository" (AssetProposalCard.svelte, docs/adr/0063-release-asset-proposal.md):
  a checkbox, the name and language of the item, and what changed: for a text the store value beside the repository value, for a graphics set the
  files of the repository (CartGraphicsDetail). Presentation only: the card owns the selection and the staging. The `extra` snippet is the place
  for more detail under the item (a fuller comparison of the files, a diff view) without changing the card.
  Props: item (ProposalItem), workspaceId, appId, selected, disabled, ontoggle, extra (optional snippet).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ProposalItem } from '@kiln/core';
  import { assetFileUrl } from '../../../lib/assets/assets.ts';
  import { itemTitle, localeName } from '../../../lib/asset-proposal.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import CartGraphicsDetail from '../../app/CartGraphicsDetail.svelte';
  import Badge from '../../ui/Badge.svelte';

  let {
    item,
    workspaceId,
    appId,
    selected,
    disabled,
    ontoggle,
    extra,
  }: {
    item: ProposalItem;
    workspaceId: string;
    appId: string;
    selected: boolean;
    disabled: boolean;
    ontoggle: () => void;
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
    </p>
    {#if item.kind === 'text'}
      <div class="diff">
        <p class="side"><span class="label">{t('release-stepper:ap.item.store')}</span><span class="val">{clip(item.before)}</span></p>
        <p class="side"><span class="label">{t('release-stepper:ap.item.repo')}</span><span class="val">{clip(item.after)}</span></p>
      </div>
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
