<!--
  StoreGraphics: what the STORE holds, per language and screen size: thumbnails in the store's order, how many each set has and the
  store-side checks, with no repository involved. Click an image to see it large (StoreImageViewer: copy, save, replace, remove).
  With the right to change graphics (and a version that is not locked) a set can be edited: add (file picker or drop), replace, remove
  and reorder (drag, or the move buttons). EVERY change is STAGED (our database, nothing is sent to a store): the set then shows the
  staged files, appears in the pending cart with thumbnails, and is written by the cart's publish through the draft push. A set that
  is not staged yet starts from the images the store holds (`base=store`), so a push keeps the ones that were not touched.
  The images come through the server's thumbnail route; the read is the cached one of the last minute, and the last read is kept in
  the browser (lib/assets/store-cache.ts), so coming back shows it at once while it is read again.
  Props: api, workspaceId, role, app, now (ms), view (the answer, or null while reading), problem (why it could not be read, or ''),
  reloading, onreload, locked (the version in the store locks its listing and graphics).
-->
<script lang="ts">
  import { ASSET_KIND_LABELS, type Role, checkStoreImages } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { assetFileUrl } from '../../lib/assets/assets.ts';
  import { type GraphicRow, type GraphicSet, buildGraphicSets, canAddMore, moveBy } from '../../lib/assets/graphic-sets.ts';
  import { EMPTY_SET_REASON, SYNC_ROLE_REASON, canChangeAssets, stagedBlobUrl, storeFileUrl, storeThumbUrl } from '../../lib/assets/sync.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { stagingError } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import AssetUploadPanel from './AssetUploadPanel.svelte';
  import StoreGraphicsNotes from './StoreGraphicsNotes.svelte';
  import StoreImageViewer from './StoreImageViewer.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    now,
    view,
    problem = '',
    reloading = false,
    onreload,
    locked = false,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    now: number;
    view: StoreImagesView | null;
    problem?: string | undefined;
    reloading?: boolean | undefined;
    onreload: () => void;
    locked?: boolean | undefined;
  } = $props();

  type StoreImagesView = import('@kiln/core').StoreImagesView;

  const found = $derived(view ? checkStoreImages(view) : []);
  const errors = $derived(found.filter((p) => p.severity !== 'info' && p.rule !== 'inspect.unread'));
  const locales = $derived(
    buildGraphicSets({
      platform: app.platform,
      view,
      staged: stagedStore.view(app.id),
      urls: {
        thumb: (ref) => storeThumbUrl(workspaceId, app.id, ref, 160),
        file: (ref) => storeFileUrl(workspaceId, app.id, ref),
        blob: (oid) => stagedBlobUrl(workspaceId, app.id, oid),
        repo: (path, commit) => assetFileUrl(workspaceId, app.id, path, commit),
      },
    }),
  );
  const imageCount = (sets: GraphicSet[]) => sets.reduce((n, s) => n + s.rows.length, 0);
  const setName = (set: GraphicSet) => `${ASSET_KIND_LABELS[set.kind]} · ${set.deviceLabel}`;

  const may = $derived(canChangeAssets(role));
  const editReason = $derived(!may ? t(SYNC_ROLE_REASON) : locked ? t('assets:store.lockedReason') : '');
  const editable = $derived(editReason === '');

  let working = $state('');
  let trouble = $state('');
  let announce = $state('');
  let viewing = $state<{ setId: string } | null>(null);
  let viewerOpen = $state(false);
  let viewerIndex = $state(0);
  let uploading = $state<{ setId: string; mode: 'add' | 'replace'; position: number | undefined } | null>(null);
  let uploadOpen = $state(false);
  let dragFrom = $state<{ setId: string; position: number } | null>(null);

  const allSets = $derived(locales.reduce((all: GraphicSet[], l) => all.concat(l.sets), []));
  const viewedSet = $derived(viewing ? (allSets.filter((s) => s.id === viewing?.setId)[0] ?? null) : null);
  const uploadSet = $derived(uploading ? (allSets.filter((s) => s.id === uploading?.setId)[0] ?? null) : null);

  const slotOf = (set: GraphicSet) => ({ locale: set.locale, kind: set.kind as string, device: set.device });

  function openViewer(set: GraphicSet, row: GraphicRow) {
    viewing = { setId: set.id };
    viewerIndex = set.rows.indexOf(row);
    viewerOpen = true;
  }

  function openUpload(set: GraphicSet, mode: 'add' | 'replace', position?: number) {
    viewerOpen = false;
    uploading = { setId: set.id, mode, position };
    uploadOpen = true;
  }

  async function run(label: string, doneText: string, job: () => Promise<{ staged: import('@kiln/core').StagedChangesView }>) {
    if (working !== '' || !editable) return;
    working = label;
    trouble = '';
    try {
      const done = await job();
      stagedStore.set(done.staged);
      announce = doneText;
    } catch (e) {
      trouble = stagingError(e);
    } finally {
      working = '';
    }
  }

  const remove = (set: GraphicSet, row: GraphicRow) =>
    run(`remove:${set.id}:${row.position}`, t('assets:store.announceRemoved', { set: setName(set), position: row.position }), () =>
      api.removeStagedAssetFile(workspaceId, app.id, { ...slotOf(set), position: row.position, base: 'store' }),
    );

  const move = (set: GraphicSet, from: number, to: number) =>
    run(`move:${set.id}`, t('assets:store.announceMoved', { set: setName(set), from, to }), () =>
      api.moveStagedAssetFile(workspaceId, app.id, { ...slotOf(set), from, to, base: 'store' }),
    );

  const nudge = (set: GraphicSet, row: GraphicRow, delta: number) => {
    const m = moveBy(row.position, delta, set.rows.length);
    if (m) void move(set, m.from, m.to);
  };

  function onDrop(event: DragEvent, set: GraphicSet, row: GraphicRow) {
    event.preventDefault();
    const from = dragFrom;
    dragFrom = null;
    if (from && from.setId === set.id && from.position !== row.position) void move(set, from.position, row.position);
  }

  async function removeFromViewer(row: GraphicRow) {
    const set = viewedSet;
    if (!set) return;
    if (set.rows.length <= 1) return;
    viewerOpen = false;
    await remove(set, row);
  }

  const lastReason = (set: GraphicSet) => (set.rows.length <= 1 ? t(EMPTY_SET_REASON) : '');
  const fullReason = (set: GraphicSet) => (canAddMore(set) ? '' : t('assets:store.fullReason', { max: set.max }));
</script>

<section class="store" aria-label={t('assets:store.title')}>
  <header class="head">
    <h3>{t('assets:store.title')}</h3>
    {#if view}
      <span class="muted" role="status">
        {#if reloading}<Spinner size={14} label="" /> {t('assets:store.refreshing')}{:else}{t('assets:store.updatedAt', { when: timeAgo(view.readAt, now) })}{/if}
      </span>
    {/if}
    <Button size="sm" icon="refresh" loading={reloading} onclick={onreload}>{t('assets:store.reread')}</Button>
  </header>
  <p class="visually-hidden" role="status">{announce}</p>

  {#if problem && !view}
    <Alert tone="warn" title={t('assets:store.readFailed')}>{problem}</Alert>
  {:else if view && locales.length === 0}
    <div class="card"><EmptyState icon="images" title={t('assets:store.emptyTitle')} description={t('assets:store.emptyText')} /></div>
  {:else if view}
    {#if problem}<Alert tone="warn" title={t('assets:store.rereadFailed')}>{problem}</Alert>{/if}
    {#if errors.length > 0}
      <Alert tone="error" title={t('assets:store.problems', { count: errors.length })}>
        <StoreGraphicsNotes problems={found} />
      </Alert>
    {:else if found.length > 0}
      <div class="quiet"><StoreGraphicsNotes problems={found} /></div>
    {/if}
    {#if view.unplaced > 0}<p class="muted">{t('assets:store.unplaced', { count: view.unplaced })}</p>{/if}
    {#if !editable && may}<p class="muted lock"><Icon name="lock" size="sm" /> {editReason}</p>{/if}
    {#if trouble}<Alert tone="error" title={t('assets:store.editFailed')}>{trouble}</Alert>{/if}
    {#each locales as loc (loc.locale)}
      <details class="card locale" open={locales.length === 1}>
        <summary>
          <strong>{loc.locale}</strong>
          <span class="muted">{t('assets:store.images', { count: imageCount(loc.sets) })}</span>
          {#if loc.sets.some((s) => s.staged)}<Badge tone="accent" icon="layers">{t('assets:store.staged')}</Badge>{/if}
        </summary>
        {#each loc.sets as set (set.id)}
          <div class="set-head">
            <h4>{setName(set)} <span class="muted">({set.rows.length})</span></h4>
            {#if set.staged}
              <Badge tone="accent" icon="layers">{t('assets:store.staged')}</Badge>
              <span class="muted small">{t('assets:store.storeHolds', { count: set.storeCount })}</span>
            {/if}
            <span class="spacer"></span>
            <Button size="sm" icon="upload" disabled={!editable || working !== '' || !canAddMore(set)} title={editReason || fullReason(set) || undefined} onclick={() => openUpload(set, 'add')}>{t('assets:store.add')}</Button>
          </div>
          <ul class="thumbs" aria-label={setName(set)}>
            {#each set.rows as row (row.key)}
              <li
                draggable={editable && working === '' && set.rows.length > 1}
                class:dragging={dragFrom?.setId === set.id && dragFrom.position === row.position}
                ondragstart={(e) => {
                  dragFrom = { setId: set.id, position: row.position };
                  e.dataTransfer?.setData('text/plain', String(row.position));
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                }}
                ondragend={() => (dragFrom = null)}
                ondragover={(e) => {
                  if (dragFrom && dragFrom.setId === set.id) e.preventDefault();
                }}
                ondrop={(e) => onDrop(e, set, row)}
              >
                <button type="button" class="open" onclick={() => openViewer(set, row)} aria-label={t('assets:store.open', { set: setName(set), position: row.position })}>
                  {#if row.thumb}
                    <img src={row.thumb} alt={t('assets:store.imageAlt', { set: setName(set), position: row.position })} loading="lazy" width="80" height="140" draggable="false" />
                  {:else}
                    <span class="none muted">{t('assets:store.noPreview')}</span>
                  {/if}
                </button>
                <span class="dim muted">{row.position}{#if row.width !== null && row.height !== null} · {row.width}×{row.height}{/if}</span>
                {#if editable}
                  <span class="tools" role="group" aria-label={t('assets:store.tools', { position: row.position })}>
                    <span class="grip muted" aria-hidden="true" title={t('assets:store.dragHint')}><Icon name="menu" size="sm" /></span>
                    <Button size="sm" variant="ghost" iconOnly icon="arrow-left" label={t('assets:store.moveEarlier', { position: row.position })} disabled={working !== '' || row.position <= 1} onclick={() => nudge(set, row, -1)} />
                    <Button size="sm" variant="ghost" iconOnly icon="arrow-right" label={t('assets:store.moveLater', { position: row.position })} disabled={working !== '' || row.position >= set.rows.length} onclick={() => nudge(set, row, 1)} />
                    <Button size="sm" variant="ghost" iconOnly icon="upload" label={t('assets:store.replace', { position: row.position })} disabled={working !== ''} onclick={() => openUpload(set, 'replace', row.position)} />
                    <Button size="sm" variant="ghost" iconOnly icon="trash" label={t('assets:store.removeImage', { position: row.position })} title={lastReason(set) || undefined} disabled={working !== '' || set.rows.length <= 1} onclick={() => remove(set, row)} />
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/each}
      </details>
    {/each}
  {:else}
    <p class="muted" role="status">{t('assets:store.reading')}</p>
  {/if}
</section>

<StoreImageViewer
  bind:open={viewerOpen}
  bind:index={viewerIndex}
  rows={viewedSet?.rows ?? []}
  set={viewedSet ? { locale: viewedSet.locale, deviceLabel: viewedSet.deviceLabel, kindLabel: ASSET_KIND_LABELS[viewedSet.kind] } : null}
  {editable}
  {editReason}
  busy={working !== ''}
  onreplace={(row) => viewedSet && openUpload(viewedSet, 'replace', row.position)}
  onremove={removeFromViewer}
/>

<Modal bind:open={uploadOpen} size="md" title={uploading?.mode === 'replace' ? t('assets:store.replaceTitle', { position: uploading.position ?? 0 }) : t('assets:store.addTitle')} description={uploadSet ? `${uploadSet.locale} · ${setName(uploadSet)}` : undefined} onclose={() => (uploading = null)}>
  {#if uploadSet && uploading}
    <div class="stack">
      <p class="muted small">{t('assets:store.uploadHint')}</p>
      <AssetUploadPanel
        {api}
        {workspaceId}
        appId={app.id}
        slot={slotOf(uploadSet)}
        mode={uploading.mode}
        position={uploading.position}
        base="store"
        disabledReason={editReason}
        onstaged={(v) => {
          stagedStore.set(v);
          announce = t('assets:store.announceStaged', { set: setName(uploadSet) });
        }}
        ondone={() => (uploadOpen = false)}
      />
    </div>
  {/if}
</Modal>

<style>
  .store {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  .head h3 {
    margin: 0;
    margin-right: auto;
  }

  .muted {
    color: var(--muted);
  }

  .small {
    font-size: var(--text-sm);
  }

  .quiet {
    padding: var(--space-2) var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .lock {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
  }

  .locale summary {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    cursor: pointer;
  }

  .set-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    margin: var(--space-3) 0 var(--space-2);
  }

  .set-head h4 {
    margin: 0;
  }

  .spacer {
    flex: 1;
  }

  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .thumbs li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .thumbs li.dragging {
    opacity: 0.5;
  }

  .thumbs li[draggable='true'] {
    cursor: grab;
  }

  .thumbs button.open {
    padding: 0;
    min-height: 0;
    width: auto;
    background: none;
    border: 0;
    box-shadow: none;
    cursor: zoom-in;
  }

  .thumbs img,
  .none {
    display: grid;
    place-items: center;
    width: 80px;
    height: 140px;
    padding: var(--space-1);
    text-align: center;
    object-fit: contain;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  .thumbs button.open:focus-visible img,
  .thumbs button.open:focus-visible .none {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .dim {
    font-size: var(--text-xs);
  }

  .tools {
    display: flex;
    align-items: center;
    max-width: 120px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .grip {
    display: inline-flex;
    cursor: grab;
  }
</style>
