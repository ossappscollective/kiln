<!--
  AssetSetEditor: the files of one set (a locale, a kind, a device) with what can be done to each: replace it with
  another file, remove it, fix a problem (remove the alpha channel, resize to a required size), or compare it
  with the store; and a drop zone to add files. Every change is STAGED: it goes to our own database and shows in
  the staged changes, and nothing is written to a store until the set is pushed from there as a draft. "Put into
  the repository" makes a draft change set from the staged set instead. A set shows the repository's files until
  the first change; that change stages the whole set (the files it still holds are kept as they are).
  A push cannot empty a set in a store, so the last file of a set cannot be removed.
  Props: open (bindable), api, workspaceId, role, app, set ({ locale, kind, device, title, files (the repository's
  files of the set), commit }), oncompare (open the comparison for this set).
-->
<script lang="ts">
  import { type Role, slotMaxFiles } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import {
    DEFAULT_BACKGROUND,
    EMPTY_SET_REASON,
    type EditorSet,
    type MenuItem,
    SYNC_ROLE_REASON,
    type StagedFileRow,
    canChangeAssets,
    isHexColour,
    setIdOf,
    sizeLine,
    stagedBlobUrl,
    stagedFileRows,
    stagedSetOf,
    summarizeToRepo,
    type ToRepoResult,
  } from '../../lib/assets/sync.ts';
  import { assetFileUrl, fileName } from '../../lib/assets/assets.ts';
  import { requestChangeSetReview, reviewHref } from '../../lib/repository-intent.ts';
  import { stagingError } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import AssetFileMenu from './AssetFileMenu.svelte';
  import AssetUploadPanel from './AssetUploadPanel.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    role,
    app,
    set,
    oncompare,
  }: {
    open?: boolean;
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    set: EditorSet | null;
    oncompare?: () => void;
  } = $props();

  let working = $state('');
  let problem = $state('');
  let message = $state('');
  let replacing = $state<number | null>(null);
  let fixing = $state<{ position: number; kind: 'remove_alpha' | 'resize' } | null>(null);
  let background = $state(DEFAULT_BACKGROUND);
  let toRepo = $state<ToRepoResult | null>(null);

  const may = $derived(canChangeAssets(role));
  const stagedSet = $derived(set ? stagedSetOf(stagedStore.view(app.id), set.locale, set.kind, set.device) : null);
  const rows = $derived<StagedFileRow[]>(
    stagedSet
      ? stagedFileRows(stagedSet)
      : set
        ? set.files
            .filter((a) => a.origin === 'store' && a.format !== 'video')
            .map((a, i) => ({
              position: i + 1,
              name: fileName(a.path),
              oid: a.oid ?? '',
              upload: false,
              path: a.path,
              commit: set.commit ?? '',
              width: a.width,
              height: a.height,
              bytes: a.bytes,
              format: a.format,
              hasAlpha: a.hasAlpha,
            }))
        : [],
  );
  const max = $derived(set ? slotMaxFiles(app.platform, { kind: set.kind, device: set.device }) : 0);
  const full = $derived(max > 0 && rows.length >= max);
  const slot = $derived(set ? { locale: set.locale, kind: set.kind as string, device: set.device } : { locale: '', kind: '', device: null });
  const urlOf = (r: StagedFileRow) => (r.upload ? stagedBlobUrl(workspaceId, app.id, r.oid) : r.commit !== '' ? assetFileUrl(workspaceId, app.id, r.path, r.commit) : null);
  const reason = $derived(may ? '' : SYNC_ROLE_REASON);

  function itemsFor(r: StagedFileRow): MenuItem[] {
    const last = rows.length <= 1;
    return [
      { id: 'replace', label: 'Replace with another file', icon: 'upload', disabled: !may, reason: SYNC_ROLE_REASON },
      { id: 'alpha', label: 'Fix: remove the alpha channel', icon: 'image', disabled: !may || r.hasAlpha === false || r.format === 'jpeg', reason: !may ? SYNC_ROLE_REASON : 'This file has no alpha channel.' },
      { id: 'resize', label: 'Fix: resize to a required size', icon: 'image', disabled: !may || r.format !== 'png', reason: !may ? SYNC_ROLE_REASON : 'Only a PNG can be resized here.' },
      { id: 'compare', label: 'Compare with the store', icon: 'eye' },
      { id: 'remove', label: 'Remove from the set', icon: 'trash', danger: true, disabled: !may || last, reason: !may ? SYNC_ROLE_REASON : EMPTY_SET_REASON },
    ];
  }

  async function act(r: StagedFileRow, id: string) {
    problem = '';
    message = '';
    if (id === 'replace') {
      replacing = replacing === r.position ? null : r.position;
      fixing = null;
    } else if (id === 'alpha' || id === 'resize') {
      fixing = { position: r.position, kind: id === 'alpha' ? 'remove_alpha' : 'resize' };
      replacing = null;
    } else if (id === 'compare') {
      oncompare?.();
    } else if (id === 'remove') {
      await remove(r);
    }
  }

  async function remove(r: StagedFileRow) {
    if (!set || working !== '') return;
    working = `remove:${r.position}`;
    try {
      const done = await api.removeStagedAssetFile(workspaceId, app.id, { locale: set.locale, kind: set.kind, device: set.device, position: r.position });
      stagedStore.set(done.staged);
      message = `Removed ${r.name} from the staged set. It is still in the store until the set is pushed.`;
    } catch (e) {
      problem = stagingError(e);
    } finally {
      working = '';
    }
  }

  async function applyFix() {
    if (!set || !fixing || working !== '') return;
    if (fixing.kind === 'remove_alpha' && !isHexColour(background)) {
      problem = 'Choose the background as a colour such as #ffffff.';
      return;
    }
    working = `fix:${fixing.position}`;
    problem = '';
    try {
      const done = await api.fixStagedAssetFile(workspaceId, app.id, {
        locale: set.locale,
        kind: set.kind,
        device: set.device,
        position: fixing.position,
        fix: fixing.kind,
        ...(fixing.kind === 'remove_alpha' ? { background } : {}),
      });
      stagedStore.set(done.staged);
      message = `${done.summary} The corrected file is staged; the original is unchanged.`;
      fixing = null;
    } catch (e) {
      problem = stagingError(e);
    } finally {
      working = '';
    }
  }

  async function putInRepository() {
    if (!set || !stagedSet || working !== '') return;
    working = 'repo';
    problem = '';
    toRepo = null;
    try {
      const done = await api.stagedAssetsToRepo(workspaceId, app.id, [setIdOf(set.locale, set.kind, set.device)]);
      toRepo = done.result;
      const cs = done.result.changeSet;
      if (cs) toast.success(summarizeToRepo(done.result).headline, { action: { label: 'Review the draft', href: reviewHref, onclick: () => requestChangeSetReview({ repositoryId: cs.repositoryId, changeSetId: cs.id }) } });
    } catch (e) {
      problem = stagingError(e);
    } finally {
      working = '';
    }
  }

  const toRepoSummary = $derived(toRepo ? summarizeToRepo(toRepo) : null);
</script>

<Modal
  bind:open
  size="lg"
  dismissible={working === ''}
  title={set ? `Files of ${set.title}` : 'Files'}
  description="Changes here are staged in this app, not sent to a store. Push the staged set from the staged changes, or put it into the repository as a draft change set."
>
  <div class="stack">
    <div class="row wrap state">
      {#if stagedSet}<Badge tone="accent" icon="layers">Staged set{stagedSet.pushed ? ', in the store draft' : ''}</Badge>{:else}<Badge tone="neutral">Shows the repository's files</Badge>{/if}
      <span class="muted small">{rows.length} {rows.length === 1 ? 'file' : 'files'}{max > 0 ? `, the store takes at most ${max}` : ''}</span>
    </div>

    {#if message}<p class="ok small" role="status">{message}</p>{/if}
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}

    {#if rows.length === 0}
      <p class="muted">This set has no files yet. Add some below.</p>
    {:else}
      <ol class="files">
        {#each rows as r (r.position + ':' + r.oid)}
          {@const url = urlOf(r)}
          <li class="file">
            <span class="pos">{r.position}</span>
            <span class="box">{#if url}<img src={url} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />{:else}<span class="muted small">No preview</span>{/if}</span>
            <span class="info">
              <span class="name" title={r.path}>{r.name}</span>
              <span class="muted small">{sizeLine(r.width, r.height, r.bytes)}{r.hasAlpha ? ', has alpha' : ''}</span>
              <span>{#if r.upload}<Badge tone="info">Uploaded</Badge>{:else}<Badge tone="neutral">From the repository</Badge>{/if}</span>
            </span>
            <AssetFileMenu label="Actions for {r.name}, number {r.position}" items={itemsFor(r)} onselect={(id) => act(r, id)} />
            {#if replacing === r.position}
              <div class="inline">
                <AssetUploadPanel
                  {api}
                  {workspaceId}
                  appId={app.id}
                  {slot}
                  mode="replace"
                  position={r.position}
                  disabledReason={reason}
                  onstaged={(v) => stagedStore.set(v)}
                  ondone={() => (replacing = null)}
                />
              </div>
            {/if}
            {#if fixing && fixing.position === r.position}
              <div class="inline fixbar">
                <p class="small">{fixing.kind === 'remove_alpha' ? 'Flattens the transparent parts onto a background colour. The original file is not changed.' : 'Resizes the picture to the nearest size this store requires. The original file is not changed.'}</p>
                {#if fixing.kind === 'remove_alpha'}
                  <label class="bg">Background <input type="color" bind:value={background} disabled={working !== ''} aria-label="Background colour" /></label>
                {/if}
                <div class="row">
                  <Button size="sm" variant="primary" loading={working === `fix:${r.position}`} disabled={working !== ''} onclick={applyFix}>Make the corrected file</Button>
                  <Button size="sm" variant="ghost" disabled={working !== ''} onclick={() => (fixing = null)}>Cancel</Button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}

    <section aria-label="Add files" class="add">
      <h3>Add files</h3>
      <AssetUploadPanel
        {api}
        {workspaceId}
        appId={app.id}
        {slot}
        mode="add"
        disabledReason={reason || (full ? `This set already has the most the store takes (${max}).` : '')}
        onstaged={(v) => stagedStore.set(v)}
      />
    </section>

    {#if toRepoSummary}
      <Alert tone={toRepoSummary.tone} title={toRepoSummary.headline}>
        {#if toRepoSummary.details.length > 0}<ul class="plain">{#each toRepoSummary.details as d (d)}<li>{d}</li>{/each}</ul>{/if}
      </Alert>
    {/if}
  </div>

  {#snippet footer()}
    <Button
      icon="repo"
      loading={working === 'repo'}
      disabled={!stagedSet || working !== '' || !may}
      title={!may ? SYNC_ROLE_REASON : !stagedSet ? 'Nothing is staged for this set yet: the repository already has these files.' : 'Makes a draft change set that writes the staged files into the repository.'}
      onclick={putInRepository}
    >Put into the repository</Button>
    {#if oncompare}<Button icon="eye" disabled={working !== ''} onclick={oncompare}>Compare with the store</Button>{/if}
    <Button disabled={working !== ''} onclick={() => (open = false)}>Close</Button>
  {/snippet}
</Modal>

<style>
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }
  .ok {
    font-size: 0.9375rem;
    color: var(--ok-ink);
  }
  .fixbar .small {
    font-size: 0.9375rem;
  }
  h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }
  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-3);
  }
  .file {
    display: grid;
    grid-template-columns: auto 72px minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    font-size: 0.9375rem;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }
  .pos {
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }
  .box {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
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
  .info {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .inline {
    grid-column: 1 / -1;
  }
  .fixbar {
    display: grid;
    gap: var(--space-2);
  }
  .bg {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
  .state {
    gap: var(--space-3);
  }
</style>
