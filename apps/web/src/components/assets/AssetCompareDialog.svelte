<!--
  AssetCompareDialog: the files of the repository next to the files the store holds, per set and per position:
  thumbnails side by side with their pixel size, byte size and checksum, and one word for each pair (identical,
  probably the same, differs, only in the repository, only in the store). The store's pictures come through the
  server (an allow list of the stores' CDN hosts); the page never loads an address of a store. Reading the store
  changes nothing in it. "Pull" makes a draft change set that puts the store's image into the repository.
  Props: open (bindable), api, workspaceId, role, app, focus (one set: locale, kind, device; or null for all sets),
  onpulled (called with the report of a pull made here), ondiff (called with each comparison read, so the
  sets can show how they differ).
-->
<script lang="ts">
  import { type AssetCompareRow, type AssetDiffSet, type AssetDiffView, type AssetKind, type Role, COMPARE_LABELS, compareText } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    type PullReport,
    SYNC_ROLE_REASON,
    canChangeAssets,
    compareTone,
    pullableKeys,
    shortChecksum,
    sizeLine,
    storeKeyOf,
    storeThumbUrl,
    summarizePull,
  } from '../../lib/assets-sync.ts';
  import { assetFileUrl, fileName, localeLabel } from '../../lib/assets.ts';
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
    ondiff,
  }: {
    open?: boolean;
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    focus?: { locale: string; kind: AssetKind; device: string | null } | null;
    onpulled?: (report: PullReport) => void;
    ondiff?: (diff: AssetDiffView) => void;
  } = $props();

  let phase = $state<'loading' | 'error' | 'ready'>('loading');
  let problem = $state('');
  let diff = $state<AssetDiffView | null>(null);
  let pulling = $state('');
  let pullProblem = $state('');
  let last = $state<PullReport | null>(null);
  let broken = $state<string[]>([]);
  let generation = 0;

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

  async function load(fresh: boolean) {
    const mine = ++generation;
    phase = 'loading';
    problem = '';
    pullProblem = '';
    last = null;
    broken = [];
    try {
      const done = await api.appAssetDiff(workspaceId, app.id, fresh);
      if (mine !== generation) return;
      diff = done.diff;
      ondiff?.(done.diff);
      phase = 'ready';
    } catch (e) {
      if (mine !== generation) return;
      problem = stagingError(e);
      phase = 'error';
    }
  }

  const idOf = (s: AssetDiffSet) => `${s.locale}/${s.kind}/${s.device ?? ''}`;
  const titleOf = (s: AssetDiffSet) => `${localeLabel(s.locale)} · ${s.deviceLabel || s.kind}`;
  const repoUrl = (row: AssetCompareRow) => (row.repo && diff ? assetFileUrl(workspaceId, app.id, row.repo.path, diff.commit) : null);
  const storeUrl = (row: AssetCompareRow) => (row.store && row.store.downloadable ? storeThumbUrl(workspaceId, app.id, row.store.ref, 320) : null);

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
  const pullKey = (s: AssetDiffSet, row: AssetCompareRow) => `${storeKeyOf(s.platform, s.locale, s.kind, s.device)}#${row.position}`;
</script>

<Modal
  bind:open
  size="lg"
  dismissible={pulling === ''}
  title="Repository and store"
  description="Each file of the repository next to the file the store holds at the same place. Reading the store changes nothing in it."
>
  <div class="stack">
    {#if phase === 'loading'}
      <div role="status" aria-label="Comparing with the store"><Skeleton width="50%" height="14px" /><Skeleton width="100%" height="140px" /></div>
    {:else if phase === 'error'}
      <Alert tone="error" title="Could not compare with the store">{problem}</Alert>
    {:else if diff}
      {#if diff.version}
        <p class="muted small">Store version {diff.version.versionString ?? diff.version.id} ({diff.version.state}). Repository commit {diff.commit ? diff.commit.slice(0, 7) : 'unknown'}.</p>
      {/if}
      {#each diff.notes as n (n)}<p class="muted small">{n}</p>{/each}
      {#if shown.length === 0}
        <Alert tone="info" title="Nothing to compare">Neither the repository nor the store has images for this set.</Alert>
      {/if}
      {#if lastSummary}
        <Alert tone={lastSummary.tone} title={lastSummary.headline}>
          {#if lastSummary.details.length > 0}<ul class="plain">{#each lastSummary.details as d (d)}<li>{d}</li>{/each}</ul>{/if}
        </Alert>
      {/if}
      {#if pullProblem}<Alert tone="error" title="Could not pull">{pullProblem}</Alert>{/if}
      {#each shown as s (idOf(s))}
        {@const keys = pullableKeys(s, s.platform)}
        <section class="set" aria-label={titleOf(s)}>
          <header>
            <h3>{titleOf(s)}</h3>
            <span class="muted small">{compareText(s.totals) || 'No files'}</span>
            {#if keys.length > 0}
              <Button
                size="sm"
                icon="download"
                loading={pulling === `set:${idOf(s)}`}
                disabled={pulling !== '' || !mayPull}
                title={!mayPull ? SYNC_ROLE_REASON : 'Pulls the images of this set that differ or are only in the store.'}
                onclick={() => pull(`set:${idOf(s)}`, { files: keys })}
              >Pull {keys.length} {keys.length === 1 ? 'image' : 'images'}</Button>
            {/if}
          </header>
          <ul class="rows">
            {#each s.rows as row (row.position)}
              {@const rid = `${idOf(s)}#${row.position}`}
              <li class="row-pair">
                <span class="pos">{row.position}</span>
                <div class="side">
                  <p class="side-title">Repository</p>
                  {#if row.repo}
                    <div class="box">
                      {#if repoUrl(row) && broken.indexOf(`r:${rid}`) === -1}
                        <img src={repoUrl(row)} alt="Repository file {fileName(row.repo.path)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => imageFailed(`r:${rid}`)} />
                      {:else}<span class="muted">No preview</span>{/if}
                    </div>
                    <p class="meta"><span title={row.repo.path}>{fileName(row.repo.path)}</span><br />{sizeLine(row.repo.width, row.repo.height, row.repo.bytes)}<br /><span title={row.repo.sha256 ?? ''}>sha256 {shortChecksum(row.repo.sha256)}</span></p>
                  {:else}<p class="muted none">Nothing at this place</p>{/if}
                </div>
                <div class="status">
                  <Badge tone={compareTone(row.status)}>{COMPARE_LABELS[row.status]}</Badge>
                  {#if row.reason}<span class="muted small">{row.reason}</span>{/if}
                </div>
                <div class="side">
                  <p class="side-title">Store</p>
                  {#if row.store}
                    <div class="box">
                      {#if storeUrl(row) && broken.indexOf(`s:${rid}`) === -1}
                        <img src={storeUrl(row)} alt="Store image {row.position}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => imageFailed(`s:${rid}`)} />
                      {:else}<span class="muted">No preview</span>{/if}
                    </div>
                    <p class="meta">{row.store.name ?? `Image ${row.position}`}<br />{sizeLine(row.store.width, row.store.height, row.store.bytes)}<br /><span title={row.store.checksum ?? ''}>{row.store.checksumKind ?? 'checksum'} {shortChecksum(row.store.checksum)}</span></p>
                    {#if row.status !== 'identical'}
                      <Button
                        size="sm"
                        icon="download"
                        loading={pulling === rid}
                        disabled={pulling !== '' || !mayPull}
                        title={!mayPull ? SYNC_ROLE_REASON : 'Pulls this image into a draft change set.'}
                        onclick={() => pull(rid, { files: [pullKey(s, row)] })}
                      >Pull this image<span class="visually-hidden"> ({titleOf(s)}, number {row.position})</span></Button>
                    {/if}
                  {:else}<p class="muted none">Nothing at this place</p>{/if}
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
      <Button variant="primary" href={reviewHref} onclick={review}>Review the draft</Button>
    {/if}
    <Button icon="refresh" disabled={pulling !== '' || phase === 'loading'} onclick={() => load(true)} title="Reads the store again. Counts toward the limit of store reads a minute.">Read the store again</Button>
    <Button disabled={pulling !== ''} onclick={() => (open = false)}>Close</Button>
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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
