<!--
  AssetUploadPanel: add a file to a set, or replace one, by dropping it or choosing it. The file is sent to the
  server, which looks at its bytes (PNG or JPEG only, at most 8 MB), checks it against the store's documented
  rules for this place and, when it passes, keeps it in the staged set. Nothing goes to a store from here: the
  staged set is pushed from the staged changes. A file that breaks a rule is not staged; the answer lists the
  problems and the fixes that make a corrected file (remove the alpha channel, resize to a required size, fix the
  extension), and what has to be done by hand. A fix makes a new file; the original is never changed.
  Props: api, workspaceId, appId, slot (locale, kind, device), mode ('add' | 'replace'), position (the file to
  replace, 1-based), disabledReason ('' when allowed), onstaged (called with the staged view after each file),
  ondone? (called when the file is staged, for a dialog that closes), base? ('store': a set that is not staged yet starts from the
  images the store holds, not from the repository: the Graphics tab edits the store's side).
-->
<script lang="ts">
  import type { FixAdvice, FixKind, StagedChangesView } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import {
    DEFAULT_BACKGROUND,
    type FileProblem,
    UPLOAD_ACCEPT,
    checkPickedFile,
    fixLabel,
    imageFilesOf,
    isHexColour,
    specErrorsOf,
  } from '../../lib/assets/sync.ts';
  import { formatBytes } from '../../lib/assets/assets.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { stagingError } from '../../lib/staged.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  type Refused = { id: number; file: File; problems: FileProblem[]; advice: FixAdvice; background: string; working: boolean };

  let {
    api,
    workspaceId,
    appId,
    slot,
    mode,
    position = undefined,
    disabledReason = '',
    onstaged,
    ondone,
    base = undefined,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    slot: { locale: string; kind: string; device: string | null };
    mode: 'add' | 'replace';
    position?: number | undefined;
    disabledReason?: string | undefined;
    onstaged: (view: StagedChangesView) => void;
    ondone?: (() => void) | undefined;
    base?: 'store' | undefined;
  } = $props();

  const uid = $props.id();
  let input = $state<HTMLInputElement>();
  let dragging = $state(false);
  let busy = $state(false);
  let notes = $state<string[]>([]);
  let staged = $state<{ name: string; fixed: boolean }[]>([]);
  let refused = $state<Refused[]>([]);
  let nextId = 1;

  const query = (file: File, fix?: FixKind, background?: string) => ({
    locale: slot.locale,
    kind: slot.kind,
    device: slot.device,
    mode,
    ...(mode === 'replace' && position !== undefined ? { position } : {}),
    name: file.name,
    ...(base !== undefined ? { base } : {}),
    ...(fix !== undefined ? { fix } : {}),
    ...(background !== undefined ? { background } : {}),
  });

  /** Sends one file. Returns true when it was staged. */
  async function send(file: File, fix?: FixKind, background?: string, again?: Refused): Promise<boolean> {
    try {
      const done = await api.uploadStagedAsset(workspaceId, appId, query(file, fix, background), file);
      onstaged(done.staged);
      staged = [...staged, { name: file.name, fixed: fix !== undefined }];
      if (again) refused = refused.filter((r) => r.id !== again.id);
      return true;
    } catch (e) {
      const spec = specErrorsOf(e);
      if (spec) {
        if (again) refused = refused.map((r) => (r.id === again.id ? { ...r, problems: spec.problems, advice: spec.advice, working: false } : r));
        else refused = [...refused, { id: nextId++, file, problems: spec.problems, advice: spec.advice, background: DEFAULT_BACKGROUND, working: false }];
      } else {
        notes = [...notes, t('assets:upload.fileError', { name: file.name, error: stagingError(e) })];
        if (again) refused = refused.map((r) => (r.id === again.id ? { ...r, working: false } : r));
      }
      return false;
    }
  }

  async function take(list: File[]) {
    if (busy || disabledReason !== '' || list.length === 0) return;
    const files = mode === 'replace' ? list.slice(0, 1) : list;
    busy = true;
    notes = [];
    staged = [];
    refused = [];
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File;
      const why = checkPickedFile(file);
      if (why !== '') {
        notes = [...notes, why];
        continue;
      }
      if (await send(file)) ok += 1;
      else if (refused.length > 0 && i < files.length - 1) {
        // Stop at the first file that was refused, so the order of the rest stays what was chosen.
        notes = [...notes, t('assets:upload.restNotSent')];
        break;
      }
    }
    busy = false;
    if (input) input.value = '';
    if (ok > 0 && refused.length === 0 && notes.length === 0) ondone?.();
  }

  async function applyFix(r: Refused, fix: FixKind) {
    if (busy || r.working) return;
    if (fix === 'remove_alpha' && !isHexColour(r.background)) {
      notes = [...notes, t('assets:upload.backgroundHint')];
      return;
    }
    busy = true;
    refused = refused.map((x) => (x.id === r.id ? { ...x, working: true } : x));
    const ok = await send(r.file, fix, fix === 'remove_alpha' ? r.background : undefined, r);
    busy = false;
    if (ok && refused.length === 0 && notes.length === 0) ondone?.();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void take(imageFilesOf(event.dataTransfer?.files));
  }

  const stagedText = $derived(formatList(staged.map((s) => (s.fixed ? t('assets:upload.fixedName', { name: s.name }) : s.name))));

  function onDragOver(event: DragEvent) {
    if (disabledReason !== '') return;
    event.preventDefault();
    dragging = true;
  }
</script>

<div class="panel stack">
  <div
    class="drop"
    class:dragging
    class:disabled={disabledReason !== ''}
    role="group"
    aria-label={mode === 'replace' ? t('assets:upload.replaceLabel') : t('assets:upload.addLabel')}
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <Icon name="upload" size={20} />
    <p class="lead">{mode === 'replace' ? t('assets:upload.dropReplace') : t('assets:upload.dropAdd')}</p>
    <p class="muted small">{t('assets:upload.or')}</p>
    <input
      bind:this={input}
      id="asset-file-{uid}"
      class="visually-hidden"
      type="file"
      accept={UPLOAD_ACCEPT}
      multiple={mode === 'add'}
      disabled={busy || disabledReason !== ''}
      onchange={(e) => void take(imageFilesOf(e.currentTarget.files))}
    />
    <Button size="sm" icon="image" loading={busy} disabled={busy || disabledReason !== ''} title={disabledReason || undefined} onclick={() => input?.click()}>
      {mode === 'replace' ? t('assets:upload.chooseOne') : t('assets:upload.chooseMany')}
    </Button>
    <p class="muted small">{disabledReason !== '' ? disabledReason : t('assets:upload.hint')}</p>
  </div>

  {#if staged.length > 0}
    <p class="ok small" role="status">{t('assets:upload.staged', { files: stagedText })}</p>
  {/if}
  {#each notes as n (n)}<Alert tone="error">{n}</Alert>{/each}

  {#each refused as r (r.id)}
    <div class="refused">
      <p class="name"><strong>{r.file.name}</strong> <span class="muted">{t('assets:upload.notStaged', { size: formatBytes(r.file.size) })}</span></p>
      <ul class="plain">
        {#each r.problems as p (p.rule + p.message)}<li>{p.message}</li>{/each}
      </ul>
      {#if r.advice.options.length > 0}
        <div class="fixes">
          {#each r.advice.options as o (o.kind)}
            <div class="fix">
              {#if o.kind === 'remove_alpha'}
                <label class="bg">{t('assets:upload.background')} <input type="color" bind:value={r.background} disabled={busy} aria-label={t('assets:upload.backgroundColour')} /></label>
              {/if}
              <Button size="sm" variant="primary" icon="check" loading={r.working} disabled={busy} onclick={() => applyFix(r, o.kind)} title={o.detail}>{fixLabel(o.kind)}</Button>
              <span class="muted small">{o.detail}</span>
            </div>
          {/each}
        </div>
      {/if}
      {#each r.advice.manual as m (m)}<p class="manual small">{m}</p>{/each}
      <div class="row"><Button size="sm" variant="ghost" disabled={busy} onclick={() => (refused = refused.filter((x) => x.id !== r.id))}>{t('assets:upload.skip')}</Button></div>
    </div>
  {/each}
</div>

<style>
  .panel {
    gap: var(--space-4);
  }
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }
  .drop {
    display: grid;
    justify-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    text-align: center;
    border: 2px dashed var(--line-strong, var(--line));
    border-radius: var(--radius-lg);
    background: var(--surface-sunken);
  }
  .drop.dragging {
    border-color: var(--accent);
    background: var(--accent-soft, var(--surface-sunken));
  }
  .drop.disabled {
    opacity: 0.7;
  }
  .lead {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .ok,
  .manual {
    font-size: 0.9375rem;
  }
  .ok {
    color: var(--ok-ink);
  }
  .refused {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-left: 3px solid var(--bad-ink);
    border-radius: var(--radius-lg);
  }
  .name {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .plain {
    margin: 0;
    padding-left: var(--space-5);
    font-size: 0.9375rem;
  }
  .fixes {
    display: grid;
    gap: var(--space-2);
  }
  .fix {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .bg {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
  .manual {
    color: var(--warn-ink);
  }
</style>
