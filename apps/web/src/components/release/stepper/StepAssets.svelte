<!--
  StepAssets: the third step of "Prepare release": are the screenshots up to date for this version? One sentence from the
  existing comparison of the repository against the store, the number of graphic sets staged, and a link to the Assets tab
  where screenshots are staged. This step is optional: nothing here changes anything.
  Props: api, workspaceId, app, view (the staged changes), scope (the platform scope for the link).
-->
<script lang="ts">
  import { type AssetDiffView, type StagedChangesView } from '@mrm/core';
  import type { Api } from '../../../lib/api.ts';
  import { appAddress, type PlatformScope } from '../../../lib/app-scope.ts';
  import { stagingError } from '../../../lib/staged.ts';
  import { assetsLine, stagedSetsLine } from '../../../lib/release-assets.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    app,
    view,
    scope,
  }: {
    api: Api;
    workspaceId: string;
    app: AppSummary;
    view: StagedChangesView | null;
    scope: PlatformScope | null;
  } = $props();

  let diff = $state<AssetDiffView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let seq = 0;

  async function read() {
    const mine = ++seq;
    loading = true;
    problem = '';
    try {
      const out = await api.appAssetDiff(workspaceId, app.id);
      if (mine === seq) diff = out.diff;
    } catch (e) {
      if (mine === seq) problem = stagingError(e);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${app.id}`;
    if (key !== shownFor) {
      shownFor = key;
      void read();
    }
  });

  const line = $derived(assetsLine(diff ? diff.totals : null));
  const sets = $derived(view ? view.assets.length : 0);
  const files = $derived(view ? view.assets.reduce((n, s) => n + s.files.length, 0) : 0);
</script>

<div class="stack">
  <p class="lead">
    Screenshots are optional for a release. Check them against the store, and stage new ones on the Assets tab if this version needs them.
  </p>

  {#if loading && diff === null}
    <div role="status" aria-label="Comparing the screenshots"><Skeleton width="60%" height="16px" /></div>
  {:else if problem}
    <Alert tone="error" title="Could not compare the screenshots">
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={read}>Try again</Button></div>
    </Alert>
  {:else}
    <p class="status">
      <Badge tone={line.tone === 'warn' ? 'warn' : line.tone === 'ok' ? 'ok' : 'neutral'} icon={line.tone === 'ok' ? 'check' : undefined}>{line.tone === 'warn' ? 'May need an update' : line.tone === 'ok' ? 'Up to date' : 'Not known'}</Badge>
      <span>{line.text}</span>
    </p>
    {#if diff && diff.version}
      <p class="muted small">Compared with {diff.version.versionString ? `version ${diff.version.versionString}` : 'the version in the store'}.</p>
    {/if}
  {/if}

  <p class="status">
    <Badge tone={sets > 0 ? 'info' : 'neutral'}>{sets} staged</Badge>
    <span>{stagedSetsLine(sets, files)}</span>
  </p>

  <div class="row">
    <Button href={appAddress(app.id, 'assets', scope)} icon="grid">Open the Assets tab</Button>
    <Button size="sm" icon="refresh" disabled={loading} onclick={read}>Compare again</Button>
  </div>
</div>

<style>
  .lead {
    margin: 0;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
