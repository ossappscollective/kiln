<!--
  ImportReportDialog: "Import a report file", for when the API key may not create report requests or a report was exported by
  hand. Drop or choose an Apple analytics report or a Sales and Trends summary, or for an Android app a Play Console statistics CSV (.tsv, .csv or the .gz as downloaded, at most
  10 MiB). Three steps, none skipped:
  1. Choose the file: it is sent to THIS server only (nothing goes to Apple or Google), and checked, storing nothing.
  2. Preview: the report, the dates, the rows read, left out and unreadable, the metrics with their totals, a few rows.
  3. Confirm: the same file is sent again with the hash of the preview; if it is not the previewed file nothing is stored.
  An imported number never replaces one the store API read, and the same file again stores nothing new.
  Props: open (bindable), api, workspaceId, appId, onimported (called after values were stored or the file was a repeat).
  The steps are lib/analytics-import.ts (importStep).
  Readable pass (docs/design/readability.md): one sentence on what to drop and that nothing leaves this server, the details behind "About this
  import", 15px text, 13px captions.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import {
    type ImportEvent,
    type ImportState,
    canConfirmImport,
    checkImportFile,
    idleImport,
    importErrorText,
    importStep,
    importedText,
    previewFacts,
    previewNotes,
    sampleTable,
  } from '../../lib/analytics/import.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import T from '../ui/T.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import '../readable-card.css';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    appId,
    onimported,
    android = false,
  }: { open?: boolean | undefined; api: Api; workspaceId: string; appId: string; onimported: () => void; android?: boolean | undefined } = $props();

  const uid = $props.id();
  let flow = $state<ImportState>(idleImport);
  let file = $state<File | null>(null);
  let fileProblem = $state('');
  let dragging = $state(false);
  let storedSomething = $state(false);

  const busy = $derived(flow.phase === 'checking' || flow.phase === 'importing');
  const facts = $derived(flow.phase === 'preview' || flow.phase === 'importing' ? previewFacts(flow.plan) : null);
  const sample = $derived(flow.phase === 'preview' || flow.phase === 'importing' ? sampleTable(flow.plan.sample) : null);
  const notes = $derived(flow.phase === 'preview' || flow.phase === 'importing' ? previewNotes(flow.plan.notes) : []);

  const send = (event: ImportEvent) => {
    flow = importStep(flow, event);
  };

  // Opening starts clean.
  $effect(() => {
    if (open) {
      flow = idleImport;
      file = null;
      fileProblem = '';
      storedSomething = false;
    }
  });

  async function choose(picked: File | undefined) {
    if (!picked || busy) return;
    fileProblem = checkImportFile(picked);
    if (fileProblem !== '') return;
    file = picked;
    send({ type: 'pick', fileName: picked.name });
    try {
      const result = await api.previewAnalyticsImport(workspaceId, appId, picked.name, picked);
      send({ type: 'previewed', preview: result });
    } catch (e) {
      send({ type: 'failed', during: 'preview', ...importErrorText(e) });
    }
  }

  async function confirm() {
    if (flow.phase !== 'preview' || !canConfirmImport(flow) || !file) return;
    const hash = flow.confirmHash;
    send({ type: 'confirm' });
    try {
      const result = await api.importAnalytics(workspaceId, appId, file.name, hash, file);
      storedSomething = true;
      send({ type: 'imported', result: result.imported });
      toast.success(result.imported.written > 0 ? t('analytics:importDialog.toastImported') : t('analytics:importDialog.toastRepeat'));
      onimported();
    } catch (e) {
      send({ type: 'failed', during: 'import', ...importErrorText(e) });
    }
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void choose(event.dataTransfer?.files?.[0]);
  }
</script>

<Modal
  bind:open
  size="lg"
  title={android ? t('analytics:importDialog.titleAndroid') : t('analytics:importDialog.titleApple')}
  description={android ? t('analytics:importDialog.descAndroid') : t('analytics:importDialog.descApple')}
  dismissible={!busy}
>
  <div class="stack readable-card">
    {#if flow.phase === 'done'}
      <Alert tone="ok" title={t('common:action.done')}>{importedText(flow.result)}</Alert>
    {:else}
      <p class="muted">
        {#if android}
          {t('analytics:importDialog.dropAndroid')}
        {:else}
          {t('analytics:importDialog.dropApple')}
        {/if}
      </p>
      <Disclosure summary={t('analytics:importDialog.about')}>
        <p class="muted">
          {#if android}
            {t('analytics:importDialog.aboutAndroid')}
          {:else}
            {t('analytics:importDialog.aboutApple')}
          {/if}
        </p>
      </Disclosure>

      {#if flow.phase === 'idle' || flow.phase === 'error' || flow.phase === 'checking'}
        <label class="drop" class:over={dragging} ondragover={(e) => { e.preventDefault(); dragging = true; }} ondragleave={() => (dragging = false)} {ondrop} for="{uid}-file">
          <Icon name="upload" size={20} />
          <span><T key="analytics:importDialog.choose" /></span>
          <span class="muted small">{t('analytics:importDialog.fileTypes')}</span>
          <input id="{uid}-file" class="visually-hidden" type="file" accept=".tsv,.csv,.gz,.txt,text/csv,text/tab-separated-values,application/gzip" disabled={busy} onchange={(e) => { void choose(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
        </label>
        {#if fileProblem}<p class="field-error" role="alert">{fileProblem}</p>{/if}
        {#if flow.phase === 'checking'}<p role="status" class="muted">{t('analytics:importDialog.checking', { name: flow.fileName })}</p>{/if}
        {#if flow.phase === 'error'}
          <Alert tone="error" title={flow.during === 'preview' ? t('analytics:importDialog.errorPreview') : t('analytics:importDialog.errorImport')}>{flow.message}</Alert>
        {/if}
      {/if}

      {#if facts && (flow.phase === 'preview' || flow.phase === 'importing')}
        <section aria-label={t('analytics:importDialog.previewAria', { name: flow.fileName })}>
          <h3 class="h">{facts.report}</h3>
          <dl class="facts">
            <div><dt>{t('analytics:importDialog.file')}</dt><dd class="mono">{flow.fileName}</dd></div>
            <div><dt>{t('analytics:importDialog.dates')}</dt><dd>{t('analytics:importDialog.datesValue', { range: facts.range, days: facts.days })}</dd></div>
            <div class="wide"><dt>{t('analytics:importDialog.rows')}</dt><dd>{t('analytics:importDialog.rowsValue', { rows: facts.rows.join('; ') })}</dd></div>
          </dl>
          <div class="table-wrap">
            <table class="compact">
              <caption class="visually-hidden">{t('analytics:importDialog.metricsCaption')}</caption>
              <thead><tr><th scope="col">{t('analytics:importDialog.colMetric')}</th><th scope="col" class="num">{t('analytics:importDialog.colDays')}</th><th scope="col" class="num">{t('analytics:importDialog.colTotal')}</th></tr></thead>
              <tbody>
                {#each facts.metrics as m (m.label)}
                  <tr><th scope="row">{m.label}</th><td class="num">{m.days}</td><td class="num">{m.total}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if sample && sample.rows.length > 0}
            <Disclosure summary={t('analytics:importDialog.sampleSummary')} stateKey="analytics.import.sample">
              <div class="table-wrap">
                <table class="compact">
                  <thead><tr>{#each sample.columns as c, ci (ci)}<th scope="col" class:num={ci === 3}>{c}</th>{/each}</tr></thead>
                  <tbody>
                    {#each sample.rows as row, i (i)}
                      <tr>{#each row as cell, j (j)}<td class:num={j === 3}>{cell}</td>{/each}</tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </Disclosure>
          {/if}
          {#if notes.length > 0}
            <Disclosure summary={t('analytics:importDialog.notesSummary')} stateKey="analytics.import.notes">
              <ul class="notes">{#each notes as n (n)}<li>{n}</li>{/each}</ul>
            </Disclosure>
          {/if}
          <p class="will"><T key="analytics:importDialog.willStore" params={{ willStore: facts.willStore }} /></p>
        </section>
      {/if}
    {/if}
  </div>
  {#snippet footer()}
    {#if flow.phase === 'done'}
      <Button variant="primary" onclick={() => (open = false)}>{t('common:action.close')}</Button>
    {:else}
      <Button disabled={busy} onclick={() => (open = false)}>{storedSomething ? t('common:action.close') : t('common:action.cancel')}</Button>
      {#if flow.phase === 'preview' || flow.phase === 'importing'}
        <Button disabled={busy} onclick={() => send({ type: 'reset' })}>{t('analytics:importDialog.chooseAnother')}</Button>
        <Button variant="primary" icon="check" loading={flow.phase === 'importing'} disabled={!canConfirmImport(flow) || busy} onclick={confirm}>{t('analytics:importDialog.confirm')}</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .drop {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: center;
    padding: var(--space-6) var(--space-4);
    text-align: center;
    cursor: pointer;
    background: var(--surface-sunken);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-lg);
  }

  .drop:hover,
  .drop.over {
    background: var(--accent-bg);
    border-color: var(--accent);
  }

  .drop:focus-within {
    outline: var(--ring);
    outline-offset: 2px;
  }

  .h {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0 0 var(--space-3);
  }

  .facts .wide {
    grid-column: 1 / -1;
  }

  .facts dt {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .table-wrap {
    max-height: 14rem;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .notes {
    padding-left: var(--space-5);
    margin: 0;
    font-size: 0.9375rem;
  }

  .will {
    margin: var(--space-3) 0 0;
  }
</style>
