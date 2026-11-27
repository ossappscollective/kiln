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
  import { type AssetDiffView, type Role, type StagedChangesView } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { appAddress, type PlatformScope } from '../../../lib/app-scope.ts';
  import { compareState, statusLabel } from '../../../lib/asset-compare.ts';
  import { settle } from '../../../lib/bounded-read.ts';
  import { stagingError } from '../../../lib/staged.ts';
  import { onStagedChanged } from '../../../lib/staged-sync.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import { readCache } from '../../../lib/read-cache.ts';
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

  let diff = $state<AssetDiffView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let seq = 0;

  async function read(force = false) {
    const mine = ++seq;
    loading = true;
    problem = '';
    try {
      const out = await readCache.read({
        workspaceId,
        group: 'repo',
        key: `assetdiff/${app.id}`,
        force,
        load: async () => {
          const got = await settle((signal) => api.appAssetDiff(workspaceId, app.id, force, signal), { timeoutMessage: t('release-stepper:sa.timeout') });
          if (!got.ok) throw got.error;
          return got.value;
        },
      });
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
      untrack(() => void read());
    }
  });

  // The store was read again (a sync, "Read again" of the Graphics tab, "Check again") or a push changed it: what this comparison kept of the
  // store is stale, so it is forgotten and read again (the server's own read is already fresh then): one source of the store's images.
  $effect(() => {
    const mine = app.id;
    const ws = workspaceId;
    return onStagedChanged((detail) => {
      if (detail.appId !== mine || (detail.reason !== 'store_read' && detail.reason !== 'publish')) return;
      readCache.forget(ws, `assetdiff/${mine}`);
      void read(false);
    });
  });

  const cmp = $derived(diff ? compareState(diff) : null);
  const line = $derived(assetsLine(diff ? diff.totals : null));
  const sets = $derived(view ? view.assets.length : 0);
  const files = $derived(view ? view.assets.reduce((n, s) => n + s.files.length, 0) : 0);
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

  {#if sets > 0}
    <p class="status">
      <Badge tone="info">{t('release-stepper:sa.staged', { count: sets })}</Badge>
      <span>{stagedSetsLine(sets, files)}</span>
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
