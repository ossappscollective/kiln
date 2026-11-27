<!--
  AssetCompareDialog: the files of the repository next to the files the store holds, per set and per position:
  thumbnails side by side with their pixel size, byte size and checksum, and one word for each pair (identical,
  probably the same, differs, only in the repository, only in the store). The store's pictures come through the
  server (an allow list of the stores' CDN hosts); the page never loads an address of a store. Reading the store
  changes nothing in it. "Pull" makes a draft change set that puts the store's image into the repository.
  Props: open (bindable), api, workspaceId, role, app, focus (one set: locale, kind, device; or null for all sets),
  onpulled (called with the report of a pull made here). The comparison is read and kept by the web store of the store's images, so the
  Assets tab's sets show how they differ from the same read.
-->
<script lang="ts">
  import { type CompareRow, type AssetDiffSet, type AssetKind, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    type PullReport,
    SYNC_ROLE_REASON,
    canChangeAssets,
    compareLabel,
    compareSummary,
    compareTone,
    pullableKeys,
    shortChecksum,
    sizeLine,
    pullKeyOf,
    storeThumbUrl,
    summarizePull,
  } from '../../lib/assets/sync.ts';
  import { assetFileUrl, fileName, localeLabel } from '../../lib/assets/assets.ts';
  import { deviceText } from '../../lib/assets/device-text.ts';
  import { storeImagesStore } from '../../lib/app-state/store-images-store.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { requestChangeSetReview, reviewHref } from '../../lib/repository-intent.ts';
  import { stagingError } from '../../lib/staged.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    role,
    app,
    focus = null,
    onpulled,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    focus?: { locale: string; kind: AssetKind; device: string | null } | null | undefined;
    onpulled?: ((report: PullReport) => void) | undefined;
  } = $props();

  // The comparison is read through the one web store of the store's images (lib/app-state/store-images-store.svelte.ts): it is the same
  // comparison the Assets tab shows its badges from, and `invalidate` forgets it with every other number kept of the store.
  const comparison = $derived(storeImagesStore.diff(workspaceId, app.id));
  const diff = $derived(comparison.diff);
  const problem = $derived(comparison.problem);
  const phase = $derived<'loading' | 'error' | 'ready'>(comparison.loading && diff === null ? 'loading' : problem !== '' && diff === null ? 'error' : diff !== null ? 'ready' : 'loading');
  let pulling = $state('');
  let pullProblem = $state('');
  let last = $state<PullReport | null>(null);
  let broken = $state<string[]>([]);

  const mayPull = $derived(canChangeAssets(role));
  const shown = $derived(
    diff
      ? diff.sets.filter((s) => focus === null || (s.locale === focus.locale && s.kind === focus.kind && s.device === focus.device))
      : [],
  );
  const lastSummary = $derived(last ? summarizePull(last) : null);

  $effect(() => {
    if (!open) return;
    untrack(() => void load(false));
  });

  // While the dialog is open the comparison follows the store (a "Read again", a push, a sync): it is read again when it was made old.
  $effect(() => {
    if (!open) return;
    return storeImagesStore.watchDiff(api, workspaceId, app.id, { timeoutMessage: t('assets:compare.timeout'), describeError: stagingError });
  });

  async function load(fresh: boolean) {
    pullProblem = '';
    last = null;
    broken = [];
    await storeImagesStore.loadDiff(api, workspaceId, app.id, { fresh, timeoutMessage: t('assets:compare.timeout'), describeError: stagingError });
  }

  const idOf = (s: AssetDiffSet) => `${s.locale}/${s.kind}/${s.device ?? ''}`;
  const titleOf = (s: AssetDiffSet) => t('assets:compare.setTitle', { locale: localeLabel(s.locale), device: deviceText(s.kind, s.device, s.deviceLabel) || s.kind });
  const repoUrl = (row: CompareRow) => (row.repo && diff ? assetFileUrl(workspaceId, app.id, row.repo.path, diff.commit) : null);
  const storeUrl = (row: CompareRow) => (row.store && row.store.downloadable ? storeThumbUrl(workspaceId, app.id, row.store.ref, 320) : null);

  async function pull(label: string, body: { files?: string[]; sets?: string[] }) {
    if (pulling !== '' || !mayPull) return;
    pulling = label;
    pullProblem = '';
    try {
      const done = await api.pullStoreImages(workspaceId, app.id, body);
      last = done.pull;
      onpulled?.(done.pull);
    } catch (e) {
      pullProblem = stagingError(e);
    } finally {
      pulling = '';
    }
  }

  function review() {
    const cs = last?.changeSet;
    if (cs) requestChangeSetReview({ repositoryId: cs.repositoryId, changeSetId: cs.id });
    open = false;
  }

  const imageFailed = (id: string) => {
    if (broken.indexOf(id) === -1) broken = [...broken, id];
  };
  const pullKey = (s: AssetDiffSet, row: CompareRow) => (s.primary ? pullKeyOf(s, row, s.platform) : null);
</script>

<Modal
  bind:open
  size="lg"
  dismissible={pulling === ''}
  title={t('assets:compare.title')}
  description={t('assets:compare.description')}
>
  <div class="stack">
    {#if phase === 'loading'}
      <div role="status" aria-label={t('assets:compare.loading')}><Skeleton width="50%" height="14px" /><Skeleton width="100%" height="140px" /></div>
    {:else if phase === 'error'}
      <Alert tone="error" title={t('assets:compare.failed')}>{problem}</Alert>
    {:else if diff}
      {#if diff.version}
        <p class="muted small">{t('assets:compare.versionLine', { version: diff.version.versionString ?? diff.version.id, state: diff.version.state, commit: diff.commit ? diff.commit.slice(0, 7) : t('assets:compare.unknownCommit') })}</p>
      {/if}
      {#each diff.notes as n (n)}<p class="muted small">{n}</p>{/each}
      {#if shown.length === 0}
        <Alert tone="info" title={t('assets:compare.nothing')}>{t('assets:compare.nothingText')}</Alert>
      {/if}
      {#if lastSummary}
        <Alert tone={lastSummary.tone} title={lastSummary.headline}>
          {#if lastSummary.details.length > 0}<ul class="plain">{#each lastSummary.details as d (d)}<li>{d}</li>{/each}</ul>{/if}
        </Alert>
      {/if}
      {#if pullProblem}<Alert tone="error" title={t('assets:compare.pullFailed')}>{pullProblem}</Alert>{/if}
      {#each shown as s (idOf(s))}
        {@const keys = pullableKeys(s, s.platform)}
        <section class="set" aria-label={titleOf(s)}>
          <header>
            <h3>{titleOf(s)}</h3>
            <span class="muted small">{compareSummary(s.totals) || t('assets:compare.noFiles')}</span>
            {#if keys.length > 0}
              <Button
                size="sm"
                icon="download"
                loading={pulling === `set:${idOf(s)}`}
                disabled={pulling !== '' || !mayPull}
                title={!mayPull ? t(SYNC_ROLE_REASON) : t('assets:compare.pullSetHint')}
                onclick={() => pull(`set:${idOf(s)}`, { files: keys })}
              >{t('assets:compare.pullSet', { count: keys.length })}</Button>
            {/if}
          </header>
          <ul class="rows">
            {#each s.rows as row (row.position)}
              {@const rid = `${idOf(s)}#${row.position}`}
              <li class="row-pair">
                <span class="pos">{row.position}</span>
                <div class="side">
                  <p class="side-title">{t('assets:compare.repository')}</p>
                  {#if row.repo}
                    <div class="box">
                      {#if repoUrl(row) && broken.indexOf(`r:${rid}`) === -1}
                        <img src={repoUrl(row)} alt={t('assets:compare.repoAlt', { name: fileName(row.repo.path) })} loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => imageFailed(`r:${rid}`)} />
                      {:else}<span class="muted">{t('assets:compare.noPreview')}</span>{/if}
                    </div>
                    <p class="meta"><span title={row.repo.path}>{fileName(row.repo.path)}</span><br />{sizeLine(row.repo.width, row.repo.height, row.repo.bytes)}<br /><span title={row.repo.sha256 ?? ''}>{t('assets:compare.checksum', { kind: 'sha256', sum: shortChecksum(row.repo.sha256) })}</span></p>
                  {:else}<p class="muted none">{t('assets:compare.nothingHere')}</p>{/if}
                </div>
                <div class="status">
                  <Badge tone={compareTone(row.status)}>{compareLabel(row.status)}</Badge>
                  {#if row.reason}<span class="muted small">{row.reason}</span>{/if}
                </div>
                <div class="side">
                  <p class="side-title">{t('assets:compare.store')}</p>
                  {#if row.store}
                    <div class="box">
                      {#if storeUrl(row) && broken.indexOf(`s:${rid}`) === -1}
                        <img src={storeUrl(row)} alt={t('assets:compare.storeAlt', { number: row.position })} loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => imageFailed(`s:${rid}`)} />
                      {:else}<span class="muted">{t('assets:compare.noPreview')}</span>{/if}
                    </div>
                    <p class="meta">{row.store.name ?? t('assets:compare.imageN', { number: row.position })}<br />{sizeLine(row.store.width, row.store.height, row.store.bytes)}<br /><span title={row.store.checksum ?? ''}>{t('assets:compare.checksum', { kind: row.store.checksumKind ?? t('assets:compare.checksumWord'), sum: shortChecksum(row.store.checksum) })}</span></p>
                    {#if row.status !== 'identical' && pullKey(s, row) !== null}
                      <Button
                        size="sm"
                        icon="download"
                        loading={pulling === rid}
                        disabled={pulling !== '' || !mayPull}
                        title={!mayPull ? t(SYNC_ROLE_REASON) : t('assets:compare.pullOneHint')}
                        onclick={() => pull(rid, { files: [pullKey(s, row) ?? ''] })}
                      >{t('assets:compare.pullOne')}<span class="visually-hidden"> {t('assets:compare.pullOneFor', { title: titleOf(s), number: row.position })}</span></Button>
                    {/if}
                  {:else}<p class="muted none">{t('assets:compare.nothingHere')}</p>{/if}
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    {#if last?.changeSet}
      <Button variant="primary" href={reviewHref} onclick={review}>{t('assets:compare.review')}</Button>
    {/if}
    <Button icon="refresh" disabled={pulling !== '' || phase === 'loading'} onclick={() => load(true)} title={t('assets:compare.readAgainHint')}>{t('assets:compare.readAgain')}</Button>
    <Button disabled={pulling !== ''} onclick={() => (open = false)}>{t('common:action.close')}</Button>
  {/snippet}
</Modal>

<style>
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }
  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }
  .set {
    display: grid;
    gap: var(--space-2);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  h3 {
    margin: 0;
    font-size: var(--text-md);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-3);
  }
  .row-pair {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(7rem, auto) minmax(0, 1fr);
    gap: var(--space-3);
    align-items: start;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }
  .pos {
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }
  .side-title {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .box {
    display: grid;
    place-items: center;
    height: 150px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .box img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .meta {
    margin: var(--space-1) 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .none {
    margin: 0;
    font-size: var(--text-sm);
  }
  .status {
    display: grid;
    gap: var(--space-1);
    justify-items: start;
    padding-top: var(--space-5);
  }
  @media (max-width: 760px) {
    .row-pair {
      grid-template-columns: minmax(0, 1fr);
    }
    .status {
      padding-top: 0;
    }
  }
</style>
