<!--
  ListingDiagnostics: why a store has no listing text. Says what was checked (the folder that was
  chosen, or the places that are looked at when nothing is chosen), what is in the folder, and
  which folders look like metadata but were not used and why, so the person can fix the repository
  or choose a folder.
  Props: diagnostic (the store's StoreDiagnostic), label (App Store or Google Play), store,
  canChoose (may pick a folder: shows "Use this folder"), canSave (may save a target: shows
  "Save as a target"), onuse(path), onsave(path).
-->
<script lang="ts">
  import type { ListingStore } from '@kiln/core';
  import { t } from '../../lib/i18n/t.ts';
  import type { StoreDiagnostic } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import T from '../ui/T.svelte';

  let {
    diagnostic,
    label,
    store,
    canChoose = true,
    canSave = false,
    onuse,
    onsave,
  }: {
    diagnostic: StoreDiagnostic;
    label: string;
    store: ListingStore;
    canChoose?: boolean | undefined;
    canSave?: boolean | undefined;
    onuse: (path: string) => void;
    onsave: (path: string) => void;
  } = $props();

  // A folder whose files look like another store's is not offered for this one.
  const unused = $derived(diagnostic.unused.filter((u) => u.store === store || u.store === null));
</script>

<section class="diagnostic" aria-label={t('repositories:diag.aria', { label })}>
  <p class="message">{diagnostic.message}</p>

  {#if diagnostic.searched.length > 0}
    <div>
      <h4>{diagnostic.explicit ? t('repositories:diag.folderChecked') : t('repositories:diag.lookedFor')}</h4>
      <ul class="plain">
        {#each diagnostic.searched as place (place)}<li><code>{place}</code></li>{/each}
      </ul>
    </div>
  {/if}

  {#if diagnostic.entries.length > 0}
    <div>
      <h4><T key="repositories:diag.whatIsIn" params={{ root: diagnostic.root }} /></h4>
      <ul class="plain entries">
        {#each diagnostic.entries as entry (entry)}<li><code>{entry}</code></li>{/each}
      </ul>
    </div>
  {/if}

  {#if unused.length > 0}
    <div>
      <h4>{t('repositories:diag.unusedTitle')}</h4>
      <ul class="plain found">
        {#each unused as folder (folder.path)}
          <li>
            <code>{folder.path}</code>
            <span class="reason">{folder.reason}</span>
            {#if folder.store === store && (canChoose || canSave)}
              <span class="row actions">
                {#if canChoose}<Button size="sm" onclick={() => onuse(folder.path)}>{t('repositories:diag.useFolder', { label })}</Button>{/if}
                {#if canSave}<Button size="sm" variant="ghost" onclick={() => onsave(folder.path)}>{t('repositories:diag.saveTarget')}</Button>{/if}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .diagnostic {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border, currentColor);
    text-align: left;
  }

  h4 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm, 0.875rem);
  }

  .message {
    margin: 0;
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .entries {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
  }

  .found li {
    display: grid;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
  }

  .reason {
    color: var(--text-muted, inherit);
  }

  .actions {
    gap: var(--space-2);
  }
</style>
