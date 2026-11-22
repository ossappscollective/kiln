<!--
  InternalShareDialog: shares one Android CI build to a device through Google Play internal app sharing
  (docs/api/internal-sharing.md, docs/adr/0020-play-internal-sharing.md). It is a store write that publishes nothing to users but cannot be
  taken back from here, so it goes in steps: a preview (nothing is downloaded and Google is not contacted), the words `SHARE <package>`
  typed, a confirmation with a passkey, password or recovery code when the workspace asks for one, then the install link with a copy
  button and a QR code. The link is a secret: it is shown here, never put in an address, a log or a toast.
  Every failure is a fixed sentence for its code (lib/builds.ts). Props: api, workspaceId, appId, row (a CI row), onclose.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type BuildRow,
    type SharePreview,
    type ShareResult,
    entryChoices,
    humanSize,
    linkKeptText,
    linkSensitiveText,
    phraseMatches,
    previewFromBody,
    previewNotes,
    previewReady,
    shareCannotUndoText,
    shareFailure,
    shortHash,
    uploadFileText,
    versionCodeText,
  } from '../../lib/builds.ts';
  import { qrMatrix, qrPath } from '../../lib/qr.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Modal from '../ui/Modal.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import TextField from '../ui/TextField.svelte';

  let { api, workspaceId, appId, row, onclose }: { api: Api; workspaceId: string; appId: string; row: BuildRow; onclose: () => void } = $props();

  const artifactId = $derived(row.artifact?.id ?? '');

  let open = $state(true);
  let preview = $state<SharePreview | null>(null);
  let result = $state<ShareResult | null>(null);
  let loading = $state(true);
  let sharing = $state(false);
  let problem = $state('');
  let typed = $state('');
  let entries = $state<string[]>([]);
  let entry = $state('');

  const ready = $derived(preview ? previewReady(preview) : false);
  const matches = $derived(preview ? phraseMatches(typed, preview.confirmation?.phrase) : false);
  const code = $derived.by(() => {
    if (!result) return null;
    const matrix = qrMatrix(result.downloadUrl);
    return matrix ? qrPath(matrix) : null;
  });

  async function look(chosen?: string) {
    loading = true;
    problem = '';
    typed = '';
    try {
      const read = await api.internalSharePreview(workspaceId, appId, artifactId, chosen || undefined);
      preview = read.preview;
      entries = [];
    } catch (e) {
      preview = null;
      if (e instanceof ApiError && (e.code === 'entry_required' || e.code === 'entry_not_found')) entries = entryChoices(e.body);
      problem = e instanceof ApiError ? shareFailure(e) : t('builds:share.readFailed');
    } finally {
      loading = false;
    }
  }

  async function share() {
    if (!preview || !preview.confirmHash || !preview.confirmation || sharing || !matches) return;
    sharing = true;
    problem = '';
    const { confirmHash } = preview;
    const confirmation = typed.trim();
    const chosen = preview.upload.entry ?? undefined;
    try {
      const done = await confirmed((grant) => api.internalShareApply(workspaceId, appId, artifactId, { confirmHash, confirmation, ...(chosen ? { entry: chosen } : {}) }, grant), confirmHash);
      result = done.result;
    } catch (e) {
      if (e instanceof ApiError) {
        problem = shareFailure(e);
        // The artifact changed: the server sent the new preview. Show it, and ask for the words again.
        const next = e.code === 'state_changed' ? previewFromBody(e.body) : null;
        if (next) {
          preview = next;
          typed = '';
        }
        if (e.code === 'entry_required') entries = entryChoices(e.body);
      } else {
        problem = t('builds:shareError.generic');
      }
    } finally {
      sharing = false;
    }
  }

  onMount(() => void look());
</script>

<Modal bind:open title={t('builds:share.title')} description={row.title} size="md" dismissible={!sharing} {onclose}>
  <div class="stack">
    {#if result}
      <Alert tone="warn" title={t('builds:share.linkSensitiveTitle')}>{linkSensitiveText()}</Alert>
      {#if code}
        <div class="qr">
          <svg viewBox="0 0 {code.size} {code.size}" role="img" aria-label={t('builds:share.qrLabel')} shape-rendering="crispEdges">
            <rect width={code.size} height={code.size} fill="#fff" />
            <path d={code.d} fill="#000" />
          </svg>
        </div>
      {:else}
        <Alert tone="info">{t('builds:share.tooLong')}</Alert>
      {/if}
      <div class="row"><code class="url">{result.downloadUrl}</code><CopyButton value={result.downloadUrl} label={t('builds:phone.copyLink')} size="sm" /></div>
      <p class="muted text-sm">{linkKeptText(preview?.linkRetentionHours ?? 24)}</p>
      <p class="muted text-sm">{result.note}</p>
      {#if result.checksumMatches === false}
        <Alert tone="warn" title={t('builds:share.checksumTitle')}>{t('builds:share.checksumBody')}</Alert>
      {/if}
      <dl class="facts text-sm">
        <dt>{t('builds:share.file')}</dt><dd>{result.share.fileName ?? t('builds:share.unknown')} ({humanSize(result.share.sizeBytes)})</dd>
        <dt>SHA-256</dt><dd><code>{result.share.sha256}</code></dd>
      </dl>
    {:else if loading && !preview}
      <div class="center" role="status" aria-label={t('builds:share.reading')}><Spinner /></div>
    {:else if !preview}
      <Alert tone="error" title={t('builds:share.prepareFailed')}>{problem}</Alert>
      {#if entries.length > 0}
        <label class="stack">
          <span class="text-sm">{t('builds:share.entryLabel')}</span>
          <select bind:value={entry}>
            <option value="" disabled>{t('builds:share.entryChoose')}</option>
            {#each entries as name (name)}<option value={name}>{name}</option>{/each}
          </select>
        </label>
        <div class="row"><Button loading={loading} disabled={loading || entry === ''} onclick={() => void look(entry)}>{t('builds:share.previewFile')}</Button></div>
      {/if}
    {:else}
      <dl class="facts text-sm">
        <dt>{t('builds:share.package')}</dt><dd><code>{preview.upload.packageName}</code></dd>
        <dt>{t('builds:share.file')}</dt><dd>{uploadFileText(preview.upload)}</dd>
        <dt>{t('builds:share.artifact')}</dt><dd>{preview.artifact.name} ({humanSize(preview.artifact.sizeBytes)})</dd>
        <dt>{t('builds:share.versionCode')}</dt><dd>{versionCodeText(preview.upload.versionCode)}</dd>
        <dt>SHA-256</dt><dd>{shortHash(preview.upload.sha256)}</dd>
      </dl>
      <ul class="effects text-sm">
        {#each preview.effects as line (line)}<li>{line}</li>{/each}
      </ul>
      <p class="text-sm"><strong>{shareCannotUndoText()}</strong></p>
      {#each previewNotes(preview) as note (note.text)}
        <Alert tone={note.tone}>{note.text}</Alert>
      {/each}
      {#if ready && preview.confirmation}
        <TextField
          label={t('builds:share.typeToConfirm', { phrase: preview.confirmation.phrase })}
          hint={preview.confirmation.instruction}
          bind:value={typed}
          autocomplete="off"
          spellcheck={false}
          disabled={sharing}
        />
      {/if}
    {/if}
    {#if problem && (preview || result)}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    {#if result}
      <Button variant="primary" onclick={() => (open = false)}>{t('common:action.close')}</Button>
    {:else}
      <Button disabled={sharing} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
      {#if preview && ready}
        <Button variant="primary" icon="upload" loading={sharing} disabled={sharing || !matches} onclick={() => void share()}>{t('builds:share.title')}</Button>
      {:else if preview}
        <Button icon="refresh" loading={loading} disabled={loading} onclick={() => void look(preview?.upload.entry ?? undefined)}>{t('builds:share.previewAgain')}</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }

  .facts dt {
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .effects {
    margin: 0;
    padding-left: var(--space-5);
  }

  .qr {
    display: flex;
    justify-content: center;
  }

  .qr svg {
    width: min(14rem, 100%);
    height: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .center {
    display: flex;
    justify-content: center;
    padding: var(--space-6);
  }

  .url {
    overflow-wrap: anywhere;
    font-size: var(--text-xs);
  }
</style>
