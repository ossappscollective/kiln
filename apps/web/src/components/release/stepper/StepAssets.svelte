<!--
  StepAssets: the third step of "Prepare release": are the screenshots up to date for this version? One sentence from the
  existing comparison of the repository against the store (compact table: per language and device, the screenshots in the repository,
  in the store, one status, a link to the Graphics tab), the number of graphic sets staged, and a link to the Assets tab
  where screenshots are staged. The comparison is explicit (the step is the click), so it does NOT need the app setting `compareMedia`.
  The read is bounded (30 s, lib/bounded-read.ts; the server stops at 25 s): it ends as a table, an explicit empty state, or an error with
  "Try again"; "Compare again" is the same retry and is only disabled while a request is really in flight. This step is optional: nothing here changes anything, except what the person stages from the first card,
  "Store assets changed in the repository" (AssetProposalCard, docs/adr/0063-release-asset-proposal.md).
  Props: api, workspaceId, role, app, view (the staged changes), scope (the platform scope for the link), release ({ version, track, build }).
-->
<script lang="ts">
  import { type Role, type StagedChangesView, stagedCountsOf } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { appAddress, type PlatformScope } from '../../../lib/app-scope.ts';
  import { compareState, statusLabel } from '../../../lib/asset-compare.ts';
  import { reportShown } from '../../../lib/app-state/dev-assert.ts';
  import { storeImagesStore } from '../../../lib/app-state/store-images-store.svelte.ts';
  import { stagingError } from '../../../lib/staged.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import { assetsLine, stagedSetsLine } from '../../../lib/release-assets.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import AssetProposalCard from './AssetProposalCard.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    view,
    scope,
    release,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    view: StagedChangesView | null;
    scope: PlatformScope | null;
    release: { version: string | null; track: string | null; build: string | null };
  } = $props();

  // The comparison is read, kept and made old by the one web store of the store's images (lib/app-state/store-images-store.svelte.ts): the
  // same comparison the Assets tab's badges and the comparison dialog show. A "Read again", a push, a sync or a new version makes it old.
  const comparison = $derived(storeImagesStore.diff(workspaceId, app.id));
  const diff = $derived(comparison.diff);
  const loading = $derived(comparison.loading || (diff === null && comparison.problem === ''));
  const problem = $derived(comparison.problem);
  const readOptions = () => ({ timeoutMessage: t('release-stepper:sa.timeout'), describeError: stagingError });
  const read = (fresh = false) => storeImagesStore.loadDiff(api, workspaceId, app.id, { ...readOptions(), fresh });

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${app.id}`;
    if (key !== shownFor) {
      shownFor = key;
      untrack(() => void read());
    }
  });
  $effect(() => storeImagesStore.watchDiff(api, workspaceId, app.id, readOptions()));

  const cmp = $derived(diff ? compareState(diff) : null);
  const line = $derived(assetsLine(diff ? diff.totals : null));
  // What a push would send (graphic sets staged and not pushed yet: the family the cart and the badge count).
  const staged = $derived(stagedCountsOf(view));

  // Dev monitor: what this step draws (the sets staged and not pushed; the store's images of each set it compares).
  $effect(() => {
    if (staged.unpushedSets > 0) reportShown('stagedAssetSets', staged.unpushedSets, 'releaseStepStaged');
  });
  $effect(() => {
    if (diff === null || diff.repoStatus === 'no_repository') return;
    const perDisplay: Record<string, number> = {};
    for (const set of diff.sets) perDisplay[`${set.locale}/${set.device ?? ''}`] = (perDisplay[`${set.locale}/${set.device ?? ''}`] ?? 0) + 1;
    for (const set of diff.sets) {
      const key = `${set.locale}/${set.device ?? ''}`;
      let held = 0;
      for (const row of set.rows) if (row.store !== null) held += 1;
      if (held === 0) continue;
      if ((perDisplay[key] ?? 0) > 1) reportShown(`imageGroupCount:${key}/${set.target ?? ''}`, held, 'releaseStepAssets');
      else reportShown(`imageCount:${key}`, held, 'releaseStepAssets');
    }
  });
</script>

<div class="stack">
  <AssetProposalCard {api} {workspaceId} {role} {app} {release} />

  {#if loading && diff === null}
    <div role="status" aria-label={t('release-stepper:sa.comparing')}><Skeleton width="60%" height="16px" /></div>
  {:else if problem}
    <Alert tone="error" title={t('release-stepper:sa.failed')}>
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => read(true)}>{t('common:action.tryAgain')}</Button></div>
    </Alert>
  {:else if cmp && cmp.kind === 'no_repository'}
    <Alert tone="info" title={t('release-stepper:sa.noRepo.title')}>{t('release-stepper:sa.noRepo.body')}</Alert>
  {:else if cmp && cmp.kind === 'nothing'}
    <Alert tone="info" title={t('release-stepper:sa.nothing.title')}>{t('release-stepper:sa.nothing.body')}</Alert>
  {:else}
    <p class="status">
      <Badge tone={line.tone === 'warn' ? 'warn' : line.tone === 'ok' ? 'ok' : 'neutral'} icon={line.tone === 'ok' ? 'check' : undefined}>{line.tone === 'warn' ? t('release-stepper:sa.mayNeedUpdate') : line.tone === 'ok' ? t('release-stepper:sa.upToDate') : t('release-stepper:sa.notKnown')}</Badge>
      <span>{line.text}</span>
    </p>
    {#if diff && diff.version && line.tone === 'warn'}
      <p class="muted small">{diff.version.versionString ? t('release-stepper:sa.comparedVersion', { version: diff.version.versionString }) : t('release-stepper:sa.comparedStore')}</p>
    {/if}
  {/if}

  {#if cmp && cmp.kind === 'table' && !problem}
    <table class="compare" data-testid="asset-compare">
      <caption class="visually-hidden">{t('release-stepper:sa.table.caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('release-stepper:sa.table.set')}</th>
          <th scope="col" class="num">{t('release-stepper:sa.table.repo')}</th>
          <th scope="col" class="num">{t('release-stepper:sa.table.store')}</th>
          <th scope="col">{t('release-stepper:sa.table.status')}</th>
          <th scope="col"><span class="visually-hidden">{t('release-stepper:sa.table.open')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each cmp.rows as row (row.key)}
          <tr>
            <th scope="row">{row.language}<span class="muted small"> · {row.what}</span></th>
            <td class="num">{row.repoCount}</td>
            <td class="num">{row.storeCount}</td>
            <td>
              <Badge tone={row.status === 'same' ? 'ok' : row.status === 'probably' ? 'neutral' : 'warn'}>{statusLabel(row.status)}</Badge>
              {#if row.detail}<span class="muted small"> {row.detail}</span>{/if}
            </td>
            <td><a href={appAddress(app.id, 'assets', scope)}>{t('release-stepper:sa.table.open')}</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if cmp.hidden > 0}<p class="muted small">{t('release-stepper:sa.table.more', { n: cmp.hidden })}</p>{/if}
  {/if}
  {#if diff && cmp && cmp.kind !== 'no_repository' && !problem}
    <p class="muted small">{t('release-stepper:sa.explain')}</p>
  {/if}

  {#if staged.unpushedSets > 0}
    <p class="status">
      <Badge tone="info">{t('release-stepper:sa.staged', { count: staged.unpushedSets })}</Badge>
      <span>{stagedSetsLine(staged.unpushedSets, staged.unpushedFiles)}</span>
    </p>
  {/if}

  <div class="row">
    <Button href={appAddress(app.id, 'assets', scope)} icon="grid">{t('release-stepper:sa.openAssets')}</Button>
    <Button size="sm" icon="refresh" disabled={loading} onclick={() => read(true)}>{t('release-stepper:sa.compareAgain')}</Button>
  </div>
</div>

<style>
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

  .compare {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .compare th,
  .compare td {
    padding: var(--space-1) var(--space-2);
    text-align: left;
    border-bottom: 1px solid var(--border);
    font-weight: normal;
  }

  .compare thead th {
    color: var(--text-muted);
  }

  .compare .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
