<!--
  StoreGraphics: what the STORE holds, per language and screen size: thumbnails in the store's order, how many each set has and the
  store-side checks, with no repository involved. Click an image to see it large (StoreImageViewer: copy, save, replace, remove).
  With the right to change graphics (and a version that is not locked) a set can be edited: add (file picker or drop), replace, remove
  and reorder (drag, or the move buttons). EVERY change is STAGED (our database, nothing is sent to a store): the set then shows the
  staged files, appears in the pending cart with thumbnails, and is written by the cart's publish through the draft push. A set that
  is not staged yet starts from the images the store holds (`base=store`), so a push keeps the ones that were not touched.
  Taking images out: each image has a checkbox (shown on hover or focus, and always once something is selected; Shift-click ticks a range),
  a set has "Select all in this set", and a sticky bar says "N selected" with Remove and Cancel (Escape clears, Delete removes). ONE request
  stages every removal and answers for each image (lib/assets/removal.ts): the image shows "Removing…" meanwhile (dimmed, a spinner), stays
  in its place, and on a refusal is restored with its reason. Asking first is inline, and only for every image of a set or more than 5. The
  last image of a set can be removed (the set is then staged empty); when the store needs at least one the bar says so. After a removal an
  Undo link discards the staged change it made. Counts and the staged tray come from the staged view the answer carries (the app state).
  The images come through the server's thumbnail route; the read is the cached one of the last minute, and the last read is kept in
  the browser by the web store of the store's images, so coming back shows it at once while it is read again.
  App Store: the header says WHICH VERSION the images belong to ("Draft 2.00.1", the version Kiln edits and shows by default, or "Live
  1.19.0") with a switch between them (lib/assets/store-version.ts), and one sentence says what a removal touches: it changes the draft
  only, the live version keeps its screenshots until the draft is released. The live view is read only.
  Props: api, workspaceId, role, app, now (ms), locked (the version in the store locks its listing and graphics). The view, its problems,
  the read clock and the version on screen come from the one web store (lib/app-state/store-images-store.svelte.ts).
-->
<script lang="ts">
  import { ASSET_KIND_LABELS, type Role, assetStoreOf, setNeedsAnImage } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { type GraphicRow, type GraphicSet, canAddMore, moveBy } from '../../lib/assets/graphic-sets.ts';
  import { SYNC_ROLE_REASON, canChangeAssets } from '../../lib/assets/sync.ts';
  import {
    NO_STATES,
    REASON_KEYS,
    type ItemStates,
    applyResults,
    canUndo,
    emptyingConsequence,
    failAll,
    fileIdOf,
    needsConfirm,
    startRemoving,
  } from '../../lib/assets/removal.ts';
  import { NO_SELECTION, type Selection, allSelected, click as clickSelection, clearSelection, isSelected, selectAll, selectedInOrder, selectionSize } from '../../lib/assets/selection.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { stagingError } from '../../lib/staged.ts';
  import { reportShown } from '../../lib/app-state/dev-assert.ts';
  import { storeImagesStore } from '../../lib/app-state/store-images-store.svelte.ts';
  import { offersChannelSwitch, storeVersionLabel } from '../../lib/assets/store-version.ts';
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
    locked = false,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    now: number;
    locked?: boolean | undefined;
  } = $props();

  // EVERYTHING about the store's images is read from the one web store (lib/app-state/store-images-store.svelte.ts): the view, the sets
  // drawn (a display in several groups is one set), the problems of the store AFTER the staged changes, the read clock, the version on
  // screen. This component keeps no copy of it and counts nothing itself.
  const facts = $derived(storeImagesStore.of(workspaceId, app));
  const view = $derived(facts.view);
  const problem = $derived(facts.problem);
  const reloading = $derived(facts.checking);
  const channel = $derived(facts.channel);
  /** What the store would hold after the staged changes are pushed (the store as it is when nothing is staged). */
  const found = $derived(facts.problemsAfter);
  const over = $derived(facts.overLimit);
  const errors = $derived(facts.errors);
  const locales = $derived(facts.graphicSets);
  // The dev monitor (lib/app-state/dev-assert.ts): what this surface shows, under the fact keys of the consistency harness.
  $effect(() => {
    for (const loc of locales)
      for (const set of loc.sets) {
        const key = `${set.locale}/${set.device ?? ''}`;
        if (set.staged) reportShown(`stagedSetFiles:${key}`, set.rows.length, 'graphicsTab');
        else {
          reportShown(`imageCount:${key}`, set.total, 'graphicsTab');
          for (const g of set.groups) reportShown(`imageGroupCount:${key}/${g.target}`, g.count, 'graphicsTab');
        }
      }
    reportShown('stagedAssetSets', facts.counts.staged, 'graphicsTab');
  });
  const reload = () => storeImagesStore.load(api, workspaceId, app, { fresh: true, role });
  const onchannel = (next: 'editable' | 'live') => storeImagesStore.pickChannel(api, workspaceId, app, next);
  const setName = (set: GraphicSet) => (set.deviceLabel ? `${ASSET_KIND_LABELS[set.kind]} · ${set.deviceLabel}` : ASSET_KIND_LABELS[set.kind]);

  const may = $derived(canChangeAssets(role));
  const versionLabel = $derived(storeVersionLabel(view, channel));
  const editReason = $derived(
    !may
      ? t(SYNC_ROLE_REASON)
      : versionLabel !== null && !versionLabel.editable
        ? t('assets:store.version.readOnly')
        : locked
          ? t('assets:store.lockedReason')
          : '',
  );
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

  const allSets = $derived.by(() => {
    const all: GraphicSet[] = [];
    for (const l of locales) for (const set of l.sets) all.push(set);
    return all;
  });
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
      storeImagesStore.applyStaged(done.staged);
      announce = doneText;
    } catch (e) {
      trouble = stagingError(e);
    } finally {
      working = '';
    }
  }

  // ---- Taking images out (selection, one batch request, per-image state, undo) ----
  let selections = $state<Record<string, Selection | undefined>>({});
  let itemStates = $state<ItemStates>(NO_STATES);
  let confirming = $state<{ setId: string; keys: string[] } | null>(null);
  let undoable = $state<{ setId: string; count: number; screenshots: boolean } | null>(null);
  let openLocales = $state<Record<string, boolean | undefined>>({});

  const store = $derived(assetStoreOf(app.platform));
  const stateKey = (set: GraphicSet, row: GraphicRow) => `${set.id}\u0000${row.key}`;
  const orderOf = (set: GraphicSet) => set.rows.map((r) => r.key);
  const selectionOf = (set: GraphicSet): Selection => selections[set.id] ?? NO_SELECTION;
  /** The ticked images that are still in the set, in the set's order. */
  const pickedOf = (set: GraphicSet): string[] => selectedInOrder(selectionOf(set), orderOf(set));
  const removingIn = (set: GraphicSet): number => set.rows.filter((r) => itemStates[stateKey(set, r)]?.status === 'removing').length;
  const consequence = (set: GraphicSet, count: number) => emptyingConsequence(store, { kind: set.kind, device: set.device }, set.rows.length, count);
  const noneLeftText = () => (store === 'app_store' ? t('assets:store.noneLeftApple') : t('assets:store.noneLeftPlay'));

  function pick(event: MouseEvent, set: GraphicSet, row: GraphicRow) {
    selections[set.id] = clickSelection(selectionOf(set), orderOf(set), row.key, event.shiftKey);
    confirming = null;
  }
  const pickAll = (set: GraphicSet) => {
    selections[set.id] = allSelected(selectionOf(set), orderOf(set)) ? clearSelection() : selectAll(orderOf(set));
    confirming = null;
  };
  const cancelPick = (set: GraphicSet) => {
    selections[set.id] = clearSelection();
    if (confirming?.setId === set.id) confirming = null;
  };

  /** Removes the images (by their keys in the set): inline confirmation first when it empties the set or is more than 5. */
  function askRemove(set: GraphicSet, keys: string[]) {
    if (!editable || working !== '' || keys.length === 0) return;
    if (needsConfirm(set.rows.length, keys.length)) confirming = { setId: set.id, keys };
    else void removeKeys(set, keys);
  }

  async function removeKeys(set: GraphicSet, keys: string[]) {
    const rows = keys.map((key) => set.rows.filter((r) => r.key === key)[0]).filter((r): r is GraphicRow => r !== undefined);
    if (rows.length === 0 || working !== '' || !editable) return;
    confirming = null;
    undoable = null;
    trouble = '';
    const marks = rows.map((r) => stateKey(set, r));
    const wasStaged = set.staged;
    itemStates = startRemoving(itemStates, marks);
    working = `remove:${set.id}`;
    try {
      const done = await api.removeStagedAssetFiles(workspaceId, app.id, { ...slotOf(set), files: rows.map(fileIdOf), base: 'store' });
      const applied = applyResults(itemStates, marks, done.results, (reason) => t(REASON_KEYS[reason]));
      itemStates = applied.states;
      storeImagesStore.applyStaged(done.staged);
      const gone = applied.gone.map((m) => rows[marks.indexOf(m)]?.key);
      selections[set.id] = { keys: selectionOf(set).keys.filter((key) => gone.indexOf(key) < 0), anchor: null };
      const screenshots = set.kind === 'screenshot';
      undoable = canUndo(wasStaged, done.summary) ? { setId: set.id, count: done.summary.removed, screenshots } : null;
      announce =
        done.summary.removed > 0
          ? screenshots
            ? t('assets:store.removedScreenshots', { count: done.summary.removed })
            : t('assets:store.removedImages', { count: done.summary.removed })
          : t('assets:store.refusedLine', { count: done.summary.notFound + done.summary.alreadyRemoved });
    } catch (e) {
      itemStates = failAll(itemStates, marks, stagingError(e));
    } finally {
      working = '';
    }
  }

  async function undo() {
    const last = undoable;
    if (!last || working !== '') return;
    working = `undo:${last.setId}`;
    try {
      const done = await api.unstageItem(workspaceId, app.id, last.setId);
      storeImagesStore.applyStaged(done.staged);
      undoable = null;
      announce = t('assets:store.undone');
    } catch (e) {
      trouble = stagingError(e);
    } finally {
      working = '';
    }
  }

  /** Escape clears the selection of the set; Delete removes the ticked images (never while typing in a field). */
  function onSetKey(event: KeyboardEvent, set: GraphicSet) {
    const target = event.target as HTMLElement | null;
    const typing = target !== null && (target.tagName === 'TEXTAREA' || target.isContentEditable || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox'));
    if (typing) return;
    if (event.key === 'Escape' && selectionSize(selectionOf(set)) > 0) {
      event.preventDefault();
      cancelPick(set);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && pickedOf(set).length > 0) {
      event.preventDefault();
      askRemove(set, pickedOf(set));
    }
  }

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
    viewerOpen = false;
    askRemove(set, [row.key]);
  }

  const fullReason = (set: GraphicSet) => (canAddMore(set) ? '' : t('assets:store.fullReason', { max: set.stagedMax }));
</script>

<section class="store" aria-label={t('assets:store.title')}>
  <header class="head">
    <h3>{t('assets:store.title')}</h3>
    {#if view}
      <span class="muted" role="status">
        {#if reloading}<Spinner size={14} label="" /> {t('assets:store.refreshing')}{:else if facts.readAt !== null}{t('assets:store.updatedAt', { when: timeAgo(facts.readAt, now) })}{/if}
      </span>
    {/if}
    {#if versionLabel}
      <Badge tone={versionLabel.kind === 'draft' ? 'accent' : 'neutral'}>
        {versionLabel.kind === 'draft' ? t('assets:store.version.draft', { version: versionLabel.version }) : t('assets:store.version.live', { version: versionLabel.version })}
      </Badge>
    {/if}
    {#if view && offersChannelSwitch(view)}
      <div class="channels" role="group" aria-label={t('assets:store.channel.label')}>
        <Button size="sm" variant={channel === 'editable' ? 'primary' : 'secondary'} aria-pressed={channel === 'editable'} onclick={() => onchannel('editable')}>{t('assets:store.channel.editable')}</Button>
        <Button size="sm" variant={channel === 'live' ? 'primary' : 'secondary'} aria-pressed={channel === 'live'} onclick={() => onchannel('live')}>{t('assets:store.channel.live')}</Button>
      </div>
    {/if}
    <Button size="sm" icon="refresh" loading={reloading} onclick={reload}>{t('assets:store.reread')}</Button>
  </header>
  {#if versionLabel}
    <p class="muted version-note">
      {#if versionLabel.kind === 'draft'}{t('assets:store.version.draftNote', { version: versionLabel.version })}
      {:else if versionLabel.kind === 'live'}{t('assets:store.version.liveNote', { version: versionLabel.version })}
      {:else}{t('assets:store.version.liveOnlyNote', { version: versionLabel.version })}{/if}
    </p>
  {/if}
  <p class="visually-hidden" role="status">{announce}</p>

  {#if problem && !view}
    <Alert tone="warn" title={t('assets:store.readFailed')}>{problem}</Alert>
  {:else if view && facts.counts.locales === 0}
    <div class="card"><EmptyState icon="images" title={t('assets:store.emptyTitle')} description={t('assets:store.emptyText')} /></div>
  {:else if view}
    {#if problem}<Alert tone="warn" title={t('assets:store.rereadFailed')}>{problem}</Alert>{/if}
    {#if errors.length > 0}
      <Alert tone="error" title={t('assets:store.problems', { count: errors.length })}>
        <StoreGraphicsNotes problems={found} />
        {#each over as o (`${o.setId}|${o.group ?? ''}`)}
          {@const gset = allSets.filter((x) => x.id === o.setId)[0]}
          <p class="over" data-testid="store-over-limit">
            <span>{o.cause === 'display' ? t('assets:store.overDisplay', { where: o.locale, found: o.count, max: o.max, places: o.extra.map((e) => e.position).join(', ') }) : t('assets:store.over', { where: o.group ? `${o.locale} · ${o.group}` : o.locale, found: o.count, max: o.max, places: o.extra.map((e) => e.position).join(', ') })}</span>
            {#if gset}<Button size="sm" icon="trash" disabled={!editable || working !== ''} title={editReason || undefined} onclick={() => askRemove(gset, o.extra.map((e) => e.key))}>{t('assets:store.removeExtra', { count: o.extra.length })}</Button>{/if}
          </p>
        {/each}
      </Alert>
    {:else if found.length > 0}
      <div class="quiet"><StoreGraphicsNotes problems={found} /></div>
    {/if}
    {#if facts.unplaced > 0}<p class="muted">{t('assets:store.unplaced', { count: facts.unplaced })}</p>{/if}
    {#if !editable && may}<p class="muted lock"><Icon name="lock" size="sm" /> {editReason}</p>{/if}
    {#if trouble}<Alert tone="error" title={t('assets:store.editFailed')}>{trouble}</Alert>{/if}
    {#each locales as loc (loc.locale)}
      <details class="card locale" open={openLocales[loc.locale] ?? facts.counts.locales === 1} ontoggle={(e) => (openLocales[loc.locale] = e.currentTarget.open)}>
        <summary>
          <strong>{loc.locale}</strong>
          <span class="muted">{t('assets:store.images', { count: loc.imageCount })}</span>
          {#if loc.hasStaged}<Badge tone="accent" icon="layers">{t('assets:store.staged')}</Badge>{/if}
        </summary>
        {#each loc.sets as set (set.id)}
          {@const picked = pickedOf(set)}
          {@const busyCount = removingIn(set)}
          {@const selecting = picked.length > 0 || busyCount > 0}
          <div class="set-head">
            <h4>{setName(set)} <span class="muted">({set.grouped && !set.staged ? set.groups.map((g) => g.count).join(' + ') : set.rows.length})</span></h4>
            {#if set.staged}
              <Badge tone="accent" icon="layers">{t('assets:store.staged')}</Badge>
              <span class="muted small">{t('assets:store.storeHolds', { count: set.storeCount })}</span>
            {/if}
            <span class="spacer"></span>
            {#if editable && set.rows.length > 0}
              <Button size="sm" variant="ghost" icon="check" disabled={working !== ''} onclick={() => pickAll(set)}>{allSelected(selectionOf(set), orderOf(set)) ? t('assets:store.selectNone') : t('assets:store.selectAll')}</Button>
            {/if}
            <Button size="sm" icon="upload" disabled={!editable || working !== '' || !canAddMore(set)} title={editReason || fullReason(set) || undefined} onclick={() => openUpload(set, 'add')}>{t('assets:store.add')}</Button>
          </div>
          {#if set.grouped}
            <p class="muted small groups" data-testid="store-groups">{t('assets:store.groupsNote', { groups: set.groups.map((g) => `${g.target} (${g.count})`).join(', '), max: set.max })}</p>
          {/if}
          {#if set.cleared}
            <p class="muted small cleared" role="status">
              {t('assets:store.clearedNote')}
              {#if setNeedsAnImage(store, { kind: set.kind, device: set.device })}<strong class="warn"> {noneLeftText()}</strong>{/if}
            </p>
          {/if}
          {#if undoable && undoable.setId === set.id}
            <p class="undo" role="status">
              {undoable.screenshots ? t('assets:store.removedScreenshots', { count: undoable.count }) : t('assets:store.removedImages', { count: undoable.count })}
              · <Button variant="link" size="sm" disabled={working !== ''} onclick={undo}>{t('assets:store.undo')}</Button>
            </p>
          {/if}
          {#if selecting}
            <div class="bar" role="toolbar" aria-label={t('assets:store.selectionBar', { set: setName(set) })}>
              {#if busyCount > 0}
                <span class="bar-count" role="status"><Spinner size={14} label="" /> {t('assets:store.removingCount', { count: busyCount })}</span>
              {:else}
                <span class="bar-count" role="status">{t('assets:store.selectedCount', { count: picked.length })}</span>
              {/if}
              <Button size="sm" variant="danger" icon="trash" disabled={working !== '' || picked.length === 0} onclick={() => askRemove(set, picked)}>{t('assets:store.removeSelected')}</Button>
              <Button size="sm" variant="ghost" disabled={busyCount > 0} onclick={() => cancelPick(set)}>{t('assets:store.cancelSelection')}</Button>
              <span class="muted small hint">{t('assets:store.selectionHint')}</span>
              {#if busyCount === 0 && consequence(set, picked.length) === 'required'}
                <p class="warn bar-warn" role="status">{noneLeftText()}</p>
              {/if}
            </div>
          {/if}
          {#if confirming && confirming.setId === set.id}
            <div class="confirm" role="alert">
              <span>{confirming.keys.length >= set.rows.length ? t('assets:store.confirmAll', { count: confirming.keys.length, set: setName(set) }) : t('assets:store.confirmMany', { count: confirming.keys.length })}</span>
              {#if consequence(set, confirming.keys.length) === 'required'}<strong class="warn">{noneLeftText()}</strong>{/if}
              <Button size="sm" variant="danger" disabled={working !== ''} onclick={() => confirming && removeKeys(set, confirming.keys)}>{t('assets:store.confirmYes')}</Button>
              <Button size="sm" variant="ghost" onclick={() => (confirming = null)}>{t('assets:store.confirmNo')}</Button>
            </div>
          {/if}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <ul class="thumbs" class:selecting aria-label={setName(set)} onkeydown={(e) => onSetKey(e, set)}>
            {#each set.rows as row (row.key)}
              {@const mark = itemStates[stateKey(set, row)]}
              <li
                draggable={editable && working === '' && set.rows.length > 1 && !selecting}
                class:dragging={dragFrom?.setId === set.id && dragFrom.position === row.position}
                class:removing={mark?.status === 'removing'}
                class:picked={isSelected(selectionOf(set), row.key)}
                aria-busy={mark?.status === 'removing'}
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
                {#if editable}
                  <input
                    type="checkbox"
                    class="pick"
                    checked={isSelected(selectionOf(set), row.key)}
                    disabled={mark?.status === 'removing' || working !== ''}
                    aria-label={t('assets:store.select', { position: row.position })}
                    onclick={(e) => pick(e, set, row)}
                  />
                {/if}
                {#if mark?.status === 'removing'}
                  <span class="busy" role="status"><Spinner size={20} label="" /><span>{t('assets:store.removingItem')}</span></span>
                {/if}
                <span class="dim muted">{row.position}{#if row.width !== null && row.height !== null} · {row.width}×{row.height}{/if}</span>
                {#if mark?.status === 'error'}<span class="item-error" role="alert">{mark.message}</span>{/if}
                {#if editable}
                  <span class="tools" role="group" aria-label={t('assets:store.tools', { position: row.position })}>
                    <span class="grip muted" aria-hidden="true" title={t('assets:store.dragHint')}><Icon name="menu" size="sm" /></span>
                    <Button size="sm" variant="ghost" iconOnly icon="arrow-left" label={t('assets:store.moveEarlier', { position: row.position })} disabled={working !== '' || row.position <= 1} onclick={() => nudge(set, row, -1)} />
                    <Button size="sm" variant="ghost" iconOnly icon="arrow-right" label={t('assets:store.moveLater', { position: row.position })} disabled={working !== '' || row.position >= set.rows.length} onclick={() => nudge(set, row, 1)} />
                    <Button size="sm" variant="ghost" iconOnly icon="upload" label={t('assets:store.replace', { position: row.position })} disabled={working !== ''} onclick={() => openUpload(set, 'replace', row.position)} />
                    <Button size="sm" variant="ghost" iconOnly icon="trash" label={t('assets:store.removeImage', { position: row.position })} disabled={working !== ''} onclick={() => askRemove(set, [row.key])} />
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
          storeImagesStore.applyStaged(v);
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

  .channels {
    display: inline-flex;
    gap: var(--space-1);
  }

  .version-note {
    margin: 0;
  }

  .muted {
    color: var(--muted);
  }

  .small {
    font-size: var(--text-sm);
  }

  .over {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: var(--space-2) 0 0;
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
  .bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    margin: 0 0 var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .bar-count {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-weight: 600;
  }

  .bar-warn {
    flex-basis: 100%;
    margin: 0;
  }

  .hint {
    margin-left: auto;
  }

  .warn {
    color: var(--warn-ink);
  }

  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    margin: 0 0 var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .undo,
  .cleared {
    margin: 0 0 var(--space-2);
  }

  .thumbs li {
    position: relative;
  }

  .thumbs li.removing > .open,
  .thumbs li.removing > .dim {
    opacity: 0.45;
  }

  .thumbs li.picked img,
  .thumbs li.picked .none {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .pick {
    position: absolute;
    top: var(--space-1);
    left: var(--space-1);
    width: 18px;
    height: 18px;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .thumbs li:hover .pick,
  .thumbs li:focus-within .pick,
  .thumbs.selecting .pick,
  .pick:checked {
    opacity: 1;
  }

  @media (hover: none) {
    .pick {
      opacity: 1;
    }
  }

  .busy {
    position: absolute;
    top: 0;
    left: 0;
    width: 80px;
    height: 140px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    background: color-mix(in srgb, var(--surface) 55%, transparent);
    border-radius: var(--radius-sm);
    pointer-events: none;
  }

  .item-error {
    max-width: 120px;
    font-size: var(--text-xs);
    color: var(--danger-text);
    text-align: center;
  }
</style>
