<!--
  AssetProposalHint: one quiet line on the Releases list, "3 store asset changes proposed", with a link into the Assets step of "Prepare release"
  where the proposal card lives (docs/api/release-asset-proposal.md, ADR 0064). Drawn only when the app has a repository, the proposal was not
  skipped for this release and something is proposed. It reads the cached count (GET .../release/asset-proposal/summary), after the page has
  drawn, never the full proposal; a failure or a slow read draws nothing.
  Props: api, workspaceId, app, showPlatform (name the platform when the page holds several), refreshKey (changes when a sync ended), onreview.
-->
<script lang="ts">
  import { platformLabel } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { storeImagesStore } from '../../lib/app-state/store-images-store.svelte.ts';
  import { proposalHint, proposalHintText } from '../../lib/asset-proposal-hint.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { onInvalidated } from '../../lib/facts/invalidate.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  let {
    api,
    workspaceId,
    app,
    showPlatform = false,
    refreshKey = 0,
    onreview,
  }: { api: Api; workspaceId: string; app: AppSummary; showPlatform?: boolean | undefined; refreshKey?: number | undefined; onreview: () => void } = $props();

  // The count is read and kept by the one web store of the store's images (lib/app-state/store-images-store.svelte.ts).
  const summary = $derived(storeImagesStore.proposalSummary(workspaceId, app.id));
  const hint = $derived(proposalHint(summary, app.repositoryId !== null));

  const read = (): void => void storeImagesStore.loadProposalSummary(api, workspaceId, app.id, app.repositoryId !== null);

  // After the page has drawn, again when a sync ended or something of this app was staged (the count changes with the cart).
  $effect(() => {
    void refreshKey;
    void workspaceId;
    void app.id;
    const timer = setTimeout(() => untrack(read), 0);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    const id = app.id;
    // What the summary depends on (the staged changes, the releases a sync read, the builds, the store) changed: read it again.
    return onInvalidated((i) => {
      if (i.appIds.length === 0 || i.appIds.includes(id)) read();
    });
  });
</script>

{#if hint}
  <p class="hint" data-testid="asset-proposal-hint">
    <Icon name="layers" size={16} />
    <span>{#if showPlatform}<strong>{platformLabel(app.platform)}</strong> {/if}{proposalHintText(hint.count)}</span>
    <Button size="sm" variant="ghost" label={t('release:assetHint.reviewLabel')} onclick={onreview}>{t('release:assetHint.review')}</Button>
  </p>
{/if}

<style>
  .hint {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }
</style>
