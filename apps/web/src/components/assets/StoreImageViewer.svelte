<!--
  StoreImageViewer: one image of the store graphics, large, in a dialog (Modal: native <dialog>, so the focus is trapped, Escape
  closes it and the focus returns to the thumbnail). Left and right arrow keys step through the set; the caption says the language,
  screen size, place in the set, pixel size and file size. Actions: copy the image to the clipboard (a PNG as it is, another format
  drawn to a PNG first; without image clipboard support the file is saved instead), save it under its original name, and, when
  editing is on, replace or remove it (staged, nothing is sent to a store). Copy and Save fetch the ORIGINAL size, never a thumbnail.
  Props: open (bindable), index (bindable), rows, set ({ locale, deviceLabel, kindLabel }), editable, editReason (why editing is
  off, '' when on), busy, onreplace(row), onremove(row).
-->
<script lang="ts">
  import { formatBytes } from '../../lib/assets/assets.ts';
  import type { GraphicRow } from '../../lib/assets/graphic-sets.ts';
  import { clipboardPlan, downloadName, pixelText, stepIndex } from '../../lib/assets/viewer.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';

  let {
    open = $bindable(false),
    index = $bindable(0),
    rows,
    set,
    editable = false,
    editReason = '',
    busy = false,
    onreplace,
    onremove,
  }: {
    open?: boolean | undefined;
    index?: number | undefined;
    rows: GraphicRow[];
    set: { locale: string; deviceLabel: string; kindLabel: string } | null;
    editable?: boolean | undefined;
    editReason?: string | undefined;
    busy?: boolean | undefined;
    onreplace?: ((row: GraphicRow) => void) | undefined;
    onremove?: ((row: GraphicRow) => void) | undefined;
  } = $props();

  const at = $derived(stepIndex(index, 0, rows.length));
  const row = $derived<GraphicRow | null>(rows[at] ?? null);
  const setName = $derived(set ? `${set.kindLabel} · ${set.deviceLabel}` : '');
  let failed = $state('');
  let working = $state('');
  const src = $derived(row ? (row.full ?? row.thumb) : null);
  const shown = $derived(src !== null && failed !== src);

  const go = (delta: number) => {
    index = stepIndex(at, delta, rows.length);
  };

  function onkeydown(event: KeyboardEvent) {
    if (!open || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  }

  async function original(): Promise<Blob | null> {
    if (!row || row.full === null) return null;
    const res = await fetch(row.full, { credentials: 'same-origin' });
    return res.ok ? await res.blob() : null;
  }

  function saveBlob(blob: Blob) {
    if (!row || !set) return '';
    const name = downloadName({ name: row.name, locale: set.locale, setName, position: row.position, mime: blob.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  async function save() {
    if (working !== '') return;
    working = 'save';
    try {
      const blob = await original();
      if (!blob) toast.error(t('assets:viewer.fetchFailed'));
      else toast.success(t('assets:viewer.saved', { name: saveBlob(blob) }));
    } catch {
      toast.error(t('assets:viewer.fetchFailed'));
    } finally {
      working = '';
    }
  }

  async function toPng(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
  }

  async function copy() {
    if (working !== '') return;
    working = 'copy';
    try {
      const blob = await original();
      if (!blob) {
        toast.error(t('assets:viewer.fetchFailed'));
        return;
      }
      const supports = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.write === 'function';
      const plan = clipboardPlan(supports, blob.type);
      if (plan === 'save') {
        saveBlob(blob);
        toast.warning(t('assets:viewer.copyFallback'));
        return;
      }
      try {
        const png = plan === 'png' ? blob : await toPng(blob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        toast.success(t('assets:viewer.copied'));
      } catch {
        saveBlob(blob);
        toast.warning(t('assets:viewer.copyFallback'));
      }
    } catch {
      toast.error(t('assets:viewer.fetchFailed'));
    } finally {
      working = '';
    }
  }
</script>

<svelte:window {onkeydown} />

<Modal bind:open size="lg" title={setName || t('assets:viewer.title')} description={set ? set.locale : undefined}>
  {#if row && set}
    <div class="viewer">
      <div class="stage" role="group" aria-label={t('assets:viewer.keys')}>
        {#if shown && src}
          {#key src}
            <img
              {src}
              alt={t('assets:viewer.alt', { set: setName, locale: set.locale, position: row.position, total: rows.length })}
              decoding="async"
              onerror={() => {
                failed = src;
              }}
            />
          {/key}
        {:else}
          <p class="placeholder muted"><Icon name="image" size="xl" /><span>{t('assets:viewer.loadFailed')}</span></p>
        {/if}
      </div>
      <dl class="facts">
        <div><dt>{t('assets:viewer.locale')}</dt><dd>{set.locale}</dd></div>
        <div><dt>{t('assets:viewer.device')}</dt><dd>{set.deviceLabel}</dd></div>
        <div><dt>{t('assets:viewer.index')}</dt><dd>{t('assets:viewer.indexValue', { position: row.position, total: rows.length })}{#if row.staged} <Badge tone="accent" icon="layers">{t('assets:viewer.staged')}</Badge>{/if}</dd></div>
        <div><dt>{t('assets:viewer.pixels')}</dt><dd>{pixelText(row.width, row.height) || t('assets:viewer.unknown')}</dd></div>
        <div><dt>{t('assets:viewer.bytes')}</dt><dd>{row.bytes !== null ? formatBytes(row.bytes) : t('assets:viewer.unknown')}</dd></div>
        {#if row.name}<div><dt>{t('assets:viewer.file')}</dt><dd class="name">{row.name}</dd></div>{/if}
      </dl>
      <div class="actions" role="group" aria-label={t('assets:viewer.actions')}>
        <Button icon="copy" loading={working === 'copy'} disabled={row.full === null} onclick={copy}>{t('assets:viewer.copy')}</Button>
        <Button icon="download" loading={working === 'save'} disabled={row.full === null} onclick={save}>{t('assets:viewer.save')}</Button>
        <Button icon="upload" disabled={!editable || busy} title={editable ? undefined : editReason} onclick={() => row && onreplace?.(row)}>{t('assets:viewer.replace')}</Button>
        <Button variant="danger" icon="trash" disabled={!editable || busy} title={editable ? undefined : editReason} onclick={() => row && onremove?.(row)}>{t('assets:viewer.remove')}</Button>
      </div>
      {#if !editable && editReason}<p class="muted small">{t('assets:viewer.editOff', { reason: editReason })}</p>{/if}
    </div>
  {/if}
  {#snippet footer()}
    <span class="position muted" aria-live="polite">{rows.length > 0 ? t('assets:viewer.indexValue', { position: at + 1, total: rows.length }) : ''}</span>
    <Button icon="chevron-left" disabled={at <= 0} onclick={() => go(-1)}>{t('assets:viewer.previous')}</Button>
    <Button disabled={at >= rows.length - 1} onclick={() => go(1)}>{t('assets:viewer.next')} <Icon name="chevron-right" size="sm" /></Button>
    <Button variant="primary" onclick={() => (open = false)}>{t('common:action.close')}</Button>
  {/snippet}
</Modal>

<style>
  .viewer {
    display: grid;
    gap: var(--space-3);
  }
  .stage {
    display: grid;
    place-items: center;
    min-height: 12rem;
    max-height: 60vh;
    padding: var(--space-2);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .stage img {
    max-width: 100%;
    max-height: 56vh;
    object-fit: contain;
  }
  .placeholder {
    display: grid;
    justify-items: center;
    gap: var(--space-2);
  }
  .muted {
    color: var(--muted);
  }
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  .facts dt {
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    font-size: var(--text-sm);
  }
  .name {
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .position {
    margin-right: auto;
  }
</style>
