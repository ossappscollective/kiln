<!--
  AssetPullDialog: pull the store's current images into the repository, as a draft change set. Reads what the
  store holds (App Store Connect screenshots, Google Play graphics; a read, nothing is written there), lets the
  person pick sets, downloads the pictures on the server (only from the stores' own CDN hosts) and puts them
  into a change set that a person reviews and applies like any other. Nothing changes in the store, and nothing
  in the repository until the change set is applied. Nothing is deleted from the repository unless "Remove
  files the store does not have" is ticked.
  Props: open (bindable), api, workspaceId, role, app, initialSets (the keys of the sets to start with, or null
  for all of them), onpulled (called with the report, also when nothing changed).
-->
<script lang="ts">
  import { type Role, type StoreImagesView } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type PullReport, canChangeAssets, skipText, storeKeyOf, summarizePull, SYNC_ROLE_REASON } from '../../lib/assets/sync.ts';
  import { formatBytes, localeLabel } from '../../lib/assets/assets.ts';
  import { requestChangeSetReview, reviewHref } from '../../lib/repository-intent.ts';
  import { stagingError } from '../../lib/staged.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    role,
    app,
    initialSets = null,
    onpulled,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    initialSets?: string[] | null | undefined;
    onpulled?: ((report: PullReport) => void) | undefined;
  } = $props();

  const uid = $props.id();

  let phase = $state<'loading' | 'error' | 'ready' | 'pulling' | 'done'>('loading');
  let problem = $state('');
  let view = $state<StoreImagesView | null>(null);
  let picked = $state<string[]>([]);
  let prune = $state(false);
  let report = $state<PullReport | null>(null);
  let generation = 0;

  const mayPull = $derived(canChangeAssets(role));
  const keyOf = (s: StoreImagesView['sets'][number]) => storeKeyOf(s.platform, s.locale, s.kind, s.device);
  const sets = $derived(view ? view.sets.filter((s) => s.files.length > 0) : []);
  const fileCount = $derived(sets.reduce((n, s) => (picked.indexOf(keyOf(s)) !== -1 ? n + s.files.length : n), 0));
  const summary = $derived(report ? summarizePull(report) : null);

  // Every time the dialog opens: read the store (a cached read of the last minute is fine) and start clean.
  $effect(() => {
    if (!open) return;
    untrack(() => void load(false));
  });

  async function load(fresh: boolean) {
    const mine = ++generation;
    phase = 'loading';
    problem = '';
    report = null;
    try {
      const done = await api.appStoreImages(workspaceId, app.id, fresh);
      if (mine !== generation) return;
      view = done.store;
      const all = done.store.sets.filter((s) => s.files.length > 0).map(keyOf);
      picked = initialSets === null ? all : all.filter((k) => initialSets.indexOf(k) !== -1);
      phase = 'ready';
    } catch (e) {
      if (mine !== generation) return;
      problem = stagingError(e);
      phase = 'error';
    }
  }

  function toggle(key: string) {
    picked = picked.indexOf(key) === -1 ? [...picked, key] : picked.filter((k) => k !== key);
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (phase !== 'ready' || picked.length === 0 || !mayPull) return;
    phase = 'pulling';
    problem = '';
    try {
      const done = await api.pullStoreImages(workspaceId, app.id, { sets: picked, ...(prune ? { prune: true } : {}) });
      report = done.pull;
      phase = 'done';
      onpulled?.(done.pull);
    } catch (e) {
      problem = stagingError(e);
      phase = 'ready';
    }
  }

  function review() {
    const cs = report?.changeSet;
    if (cs) requestChangeSetReview({ repositoryId: cs.repositoryId, changeSetId: cs.id });
    open = false;
  }
</script>

<Modal
  bind:open
  size="lg"
  dismissible={phase !== 'pulling'}
  title="Pull images from the store"
  description="Downloads the images the store holds now into the repository, as a draft change set. Nothing changes in the store, and nothing in the repository until a person approves the change set and it is applied."
>
  <form id="asset-pull-{uid}" class="stack" onsubmit={submit}>
    {#if phase === 'loading'}
      <div role="status" aria-label="Reading the store"><Skeleton width="60%" height="14px" /><Skeleton width="100%" height="90px" /></div>
    {:else if phase === 'error'}
      <Alert tone="error" title="Could not read the store's images">{problem}</Alert>
    {:else if phase === 'done' && report && summary}
      <Alert tone={summary.tone} title={summary.headline}>
        {#if summary.details.length > 0}
          <ul class="plain">{#each summary.details as d (d)}<li>{d}</li>{/each}</ul>
        {/if}
      </Alert>
      {#if report.skipped.length > 0}
        <details>
          <summary>Left out ({report.skipped.length})</summary>
          <ul class="plain skipped">{#each report.skipped as s (s.key)}<li><code>{s.key}</code> {skipText(s)}</li>{/each}</ul>
        </details>
      {/if}
      <p class="muted small">Downloaded {formatBytes(report.bytes)}. The files are in the draft change set, not in the repository.</p>
    {:else if view}
      {#if view.version}
        <p class="muted small">Read from {view.store === 'app_store' ? 'App Store Connect' : 'Google Play'}{view.version.versionString ? `, version ${view.version.versionString}` : ''} ({view.version.state}).</p>
      {/if}
      {#if sets.length === 0}
        <Alert tone="info" title="The store holds no images">There is nothing to pull.</Alert>
      {:else}
        <fieldset class="sets">
          <legend>Sets to pull ({picked.length} of {sets.length}, {fileCount} {fileCount === 1 ? 'image' : 'images'})</legend>
          <div class="row wrap tools">
            <Button size="sm" variant="ghost" onclick={() => (picked = sets.map(keyOf))} disabled={phase === 'pulling'}>Select all</Button>
            <Button size="sm" variant="ghost" onclick={() => (picked = [])} disabled={phase === 'pulling'}>Select none</Button>
          </div>
          <ul class="plain list">
            {#each sets as s (keyOf(s))}
              <li>
                <label class="check">
                  <input type="checkbox" checked={picked.indexOf(keyOf(s)) !== -1} onchange={() => toggle(keyOf(s))} disabled={phase === 'pulling'} />
                  <span>{localeLabel(s.locale)} · {s.deviceLabel || s.kind} <span class="muted">· {s.files.length} {s.files.length === 1 ? 'image' : 'images'}</span></span>
                </label>
              </li>
            {/each}
          </ul>
        </fieldset>
        <label class="check">
          <input type="checkbox" bind:checked={prune} disabled={phase === 'pulling'} />
          <span>Remove files the store does not have <span class="muted">(off by default: files only the repository has are kept)</span></span>
        </label>
      {/if}
      {#if view.unplaced > 0}
        <p class="muted small">{view.unplaced} {view.unplaced === 1 ? 'image' : 'images'} of a size this app does not know cannot be placed, so {view.unplaced === 1 ? 'it is' : 'they are'} not offered.</p>
      {/if}
      {#each view.notes as n (n)}<p class="muted small">{n}</p>{/each}
      {#if problem}<Alert tone="error" title="Could not pull the images">{problem}</Alert>{/if}
      {#if !mayPull}<p class="muted small">{SYNC_ROLE_REASON}</p>{/if}
    {/if}
  </form>

  {#snippet footer()}
    {#if phase === 'done'}
      {#if report?.changeSet}
        <Button variant="primary" href={reviewHref} onclick={review}>Review the draft</Button>
      {/if}
      <Button onclick={() => (open = false)}>Close</Button>
    {:else}
      {#if phase === 'ready' || phase === 'error'}
        <Button icon="refresh" onclick={() => load(true)} title="Reads the store again. Counts toward the limit of store reads a minute.">Read the store again</Button>
      {/if}
      <Button disabled={phase === 'pulling'} onclick={() => (open = false)}>Cancel</Button>
      <Button
        type="submit"
        form="asset-pull-{uid}"
        variant="primary"
        icon="download"
        loading={phase === 'pulling'}
        disabled={phase !== 'ready' || picked.length === 0 || !mayPull}
        title={!mayPull ? SYNC_ROLE_REASON : picked.length === 0 ? 'Choose at least one set.' : undefined}
      >Pull {fileCount} {fileCount === 1 ? 'image' : 'images'}</Button>
    {/if}
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
  .sets {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }
  .list {
    list-style: none;
    padding: 0;
    max-height: 18rem;
    overflow: auto;
    display: grid;
    gap: var(--space-2);
  }
  .tools {
    gap: var(--space-2);
  }
  .skipped {
    overflow-wrap: anywhere;
    font-size: var(--text-sm);
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
</style>
