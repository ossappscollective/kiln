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
  import { type Role, slotMaxFiles } from '@kiln/core';
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
  import { t } from '../../lib/i18n/t.ts';
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
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    set: EditorSet | null;
    oncompare?: (() => void) | undefined;
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
  const reason = $derived(may ? '' : t(SYNC_ROLE_REASON));

  function itemsFor(r: StagedFileRow): MenuItem[] {
    const last = rows.length <= 1;
    return [
      { id: 'replace', label: t('assets:editor.menu.replace'), icon: 'upload', disabled: !may, reason: t(SYNC_ROLE_REASON) },
      { id: 'alpha', label: t('assets:editor.menu.alpha'), icon: 'image', disabled: !may || r.hasAlpha === false || r.format === 'jpeg', reason: !may ? t(SYNC_ROLE_REASON) : t('assets:editor.menu.noAlpha') },
      { id: 'resize', label: t('assets:editor.menu.resize'), icon: 'image', disabled: !may || r.format !== 'png', reason: !may ? t(SYNC_ROLE_REASON) : t('assets:editor.menu.pngOnly') },
      { id: 'compare', label: t('assets:gallery.compare'), icon: 'eye' },
      { id: 'remove', label: t('assets:editor.menu.remove'), icon: 'trash', danger: true, disabled: !may || last, reason: !may ? t(SYNC_ROLE_REASON) : t(EMPTY_SET_REASON) },
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
      message = t('assets:editor.removed', { name: r.name });
    } catch (e) {
      problem = stagingError(e);
    } finally {
      working = '';
    }
  }

  async function applyFix() {
    if (!set || !fixing || working !== '') return;
    if (fixing.kind === 'remove_alpha' && !isHexColour(background)) {
      problem = t('assets:upload.backgroundHint');
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
      message = t('assets:editor.fixed', { summary: done.summary });
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
      if (cs) toast.success(summarizeToRepo(done.result).headline, { action: { label: t('assets:compare.review'), href: reviewHref, onclick: () => requestChangeSetReview({ repositoryId: cs.repositoryId, changeSetId: cs.id }) } });
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
  title={set ? t('assets:editor.title', { title: set.title }) : t('assets:editor.titleEmpty')}
  description={t('assets:editor.description')}
>
  <div class="stack">
    <div class="row wrap state">
      {#if stagedSet}<Badge tone="accent" icon="layers">{stagedSet.pushed ? t('assets:editor.stagedPushed') : t('assets:editor.staged')}</Badge>{:else}<Badge tone="neutral">{t('assets:editor.showsRepo')}</Badge>{/if}
      <span class="muted small">{max > 0 ? t('assets:editor.countMax', { count: rows.length, max }) : t('assets:summary.files', { count: rows.length })}</span>
    </div>

    {#if message}<p class="ok small" role="status">{message}</p>{/if}
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}

    {#if rows.length === 0}
      <p class="muted">{t('assets:editor.noFiles')}</p>
    {:else}
      <ol class="files">
        {#each rows as r (r.position + ':' + r.oid)}
          {@const url = urlOf(r)}
          <li class="file">
            <span class="pos">{r.position}</span>
            <span class="box">{#if url}<img src={url} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />{:else}<span class="muted small">{t('assets:compare.noPreview')}</span>{/if}</span>
            <span class="info">
              <span class="name" title={r.path}>{r.name}</span>
              <span class="muted small">{r.hasAlpha ? t('assets:editor.sizeAlpha', { size: sizeLine(r.width, r.height, r.bytes) }) : sizeLine(r.width, r.height, r.bytes)}</span>
              <span>{#if r.upload}<Badge tone="info">{t('assets:editor.uploaded')}</Badge>{:else}<Badge tone="neutral">{t('assets:editor.fromRepo')}</Badge>{/if}</span>
            </span>
            <AssetFileMenu label={t('assets:editor.actionsFor', { name: r.name, number: r.position })} items={itemsFor(r)} onselect={(id) => act(r, id)} />
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
                <p class="small">{fixing.kind === 'remove_alpha' ? t('assets:editor.fixAlphaText') : t('assets:editor.fixResizeText')}</p>
                {#if fixing.kind === 'remove_alpha'}
                  <label class="bg">{t('assets:upload.background')} <input type="color" bind:value={background} disabled={working !== ''} aria-label={t('assets:editor.backgroundColour')} /></label>
                {/if}
                <div class="row">
                  <Button size="sm" variant="primary" loading={working === `fix:${r.position}`} disabled={working !== ''} onclick={applyFix}>{t('assets:editor.makeFix')}</Button>
                  <Button size="sm" variant="ghost" disabled={working !== ''} onclick={() => (fixing = null)}>{t('common:action.cancel')}</Button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}

    <section aria-label={t('assets:upload.addLabel')} class="add">
      <h3>{t('assets:upload.addLabel')}</h3>
      <AssetUploadPanel
        {api}
        {workspaceId}
        appId={app.id}
        {slot}
        mode="add"
        disabledReason={reason || (full ? t('assets:editor.full', { max }) : '')}
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
      title={!may ? t(SYNC_ROLE_REASON) : !stagedSet ? t('assets:editor.nothingStaged') : t('assets:editor.toRepoHint')}
      onclick={putInRepository}
    >{t('assets:editor.toRepo')}</Button>
    {#if oncompare}<Button icon="eye" disabled={working !== ''} onclick={oncompare}>{t('assets:gallery.compare')}</Button>{/if}
    <Button disabled={working !== ''} onclick={() => (open = false)}>{t('common:action.close')}</Button>
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
