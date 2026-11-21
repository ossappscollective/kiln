<!--
  SearchTermsImportDialog: "Import search terms", a file exported from Google Play Console (.csv, or a .zip with the .csv inside, at most
  10 MiB). It follows the report import of Analytics (ImportReportDialog) step for step, none skipped:
  1. Choose the file: it is sent to THIS server only (nothing goes to Google), and checked, storing nothing. A file with no date column
     asks for the days it covers (from and to), then is checked again.
  2. Preview: the period, the rows read and left out, the terms, the countries and the ten biggest terms.
  3. Confirm: the same file is sent again with the hash of the preview; if it is not the previewed file nothing is stored.
  The same file twice stores nothing new; a corrected file replaces the numbers of the rows it holds.
  Props: open (bindable), api, workspaceId, appId, today (the UTC day, for checking the period), onimported (called after rows were stored
  or the file was a repeat). The steps are lib/search-terms.ts (flowStep). Terms are drawn here and nowhere else: never logged or kept.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import {
    type ImportPeriod,
    type SearchTermsFlow,
    type SearchTermsFlowEvent,
    canConfirmTerms,
    checkImportPeriod,
    checkSearchTermsFile,
    exportSteps,
    failure,
    flowStep,
    idleFlow,
    importPeriodText,
    importedLine,
    needsPeriod,
    previewFacts,
  } from '../../lib/aso/search-terms.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    appId,
    today,
    onimported,
  }: { open?: boolean | undefined; api: Api; workspaceId: string; appId: string; today: string; onimported: () => void } = $props();

  const uid = $props.id();
  let flow = $state<SearchTermsFlow>(idleFlow);
  let file = $state<File | null>(null);
  let fileProblem = $state('');
  let dragging = $state(false);
  let storedSomething = $state(false);
  let from = $state('');
  let to = $state('');
  /** The period sent with the file: only for a file with no dates, once it was asked for. */
  let period = $state<ImportPeriod | null>(null);

  const busy = $derived(flow.phase === 'checking' || flow.phase === 'importing');
  const facts = $derived(flow.phase === 'preview' || flow.phase === 'importing' ? previewFacts(flow.plan) : null);
  const askPeriod = $derived(needsPeriod(flow));
  const periodProblem = $derived(from === '' && to === '' ? '' : checkImportPeriod(from, to, today));
  const periodReady = $derived(from !== '' && to !== '' && periodProblem === '');

  const send = (event: SearchTermsFlowEvent) => {
    flow = flowStep(flow, event);
  };

  // Opening starts clean.
  $effect(() => {
    if (open) {
      flow = idleFlow;
      file = null;
      fileProblem = '';
      storedSomething = false;
      from = '';
      to = '';
      period = null;
    }
  });

  async function preview(picked: File, withPeriod: ImportPeriod | null) {
    period = withPeriod;
    send({ type: 'pick', fileName: picked.name });
    try {
      send({ type: 'previewed', preview: await api.previewSearchTermsImport(workspaceId, appId, picked.name, picked, importPeriodText(withPeriod)) });
    } catch (e) {
      send({ type: 'failed', during: 'preview', ...failure(e) });
    }
  }

  async function choose(picked: File | undefined) {
    if (!picked || busy) return;
    fileProblem = checkSearchTermsFile(picked);
    if (fileProblem !== '') return;
    file = picked;
    from = '';
    to = '';
    await preview(picked, null);
  }

  async function withDays() {
    if (!file || !periodReady || busy) return;
    // The error state is left by a reset (it is not busy), then the same file is checked again with the days.
    send({ type: 'reset' });
    await preview(file, { from, to });
  }

  async function confirm() {
    if (flow.phase !== 'preview' || !canConfirmTerms(flow) || !file) return;
    const hash = flow.confirmHash;
    send({ type: 'confirm' });
    try {
      const result = await api.importSearchTerms(workspaceId, appId, file.name, hash, file, importPeriodText(period));
      storedSomething = true;
      send({ type: 'imported', result: result.imported });
      toast.success(result.imported.written > 0 ? 'Search terms imported.' : 'The file was already imported.');
      onimported();
    } catch (e) {
      send({ type: 'failed', during: 'import', ...failure(e) });
    }
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void choose(event.dataTransfer?.files?.[0]);
  }
</script>

<Modal bind:open size="lg" title="Import search terms" description="From a file you exported in Google Play Console." dismissible={!busy}>
  <div class="stack">
    {#if flow.phase === 'done'}
      <Alert tone="ok" title="Done">{importedLine(flow.result)}</Alert>
    {:else}
      <p class="muted small">
        Choose the file Play Console exported for the breakdown "Search term". It is sent to this server only, never to Google. The same file twice stores
        nothing new, and a corrected file replaces the numbers of the rows it holds.
      </p>
      <Disclosure summary="How to export the file" stateKey="aso.terms.howto">
        <ol class="steps">{#each exportSteps as step (step)}<li>{step}</li>{/each}</ol>
      </Disclosure>

      {#if flow.phase === 'idle' || flow.phase === 'error' || flow.phase === 'checking'}
        <label class="drop" class:over={dragging} ondragover={(e) => { e.preventDefault(); dragging = true; }} ondragleave={() => (dragging = false)} {ondrop} for="{uid}-file">
          <Icon name="upload" size={20} />
          <span><strong>Choose a file</strong> or drop it here</span>
          <span class="muted small">.csv or .zip, at most 10 MiB</span>
          <input id="{uid}-file" class="visually-hidden" type="file" accept=".csv,.zip,.gz,.txt,text/csv,application/zip,application/gzip" disabled={busy} onchange={(e) => { void choose(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
        </label>
        {#if fileProblem}<p class="field-error" role="alert">{fileProblem}</p>{/if}
        {#if flow.phase === 'checking'}<p role="status" class="muted">Checking {flow.fileName}. Nothing is stored yet.</p>{/if}
        {#if flow.phase === 'error'}
          <Alert tone={askPeriod ? 'info' : 'error'} title={askPeriod ? 'Which days does this file cover?' : flow.during === 'preview' ? 'This file cannot be imported' : 'The file was not imported'}>{flow.message}</Alert>
        {/if}
        {#if askPeriod}
          <div class="period">
            <label for="{uid}-from">First day</label>
            <input id="{uid}-from" type="date" bind:value={from} max={today} aria-invalid={periodProblem !== ''} />
            <label for="{uid}-to">Last day</label>
            <input id="{uid}-to" type="date" bind:value={to} max={today} aria-invalid={periodProblem !== ''} />
            <Button variant="primary" disabled={!periodReady || busy} onclick={withDays}>Check the file with these days</Button>
          </div>
          {#if periodProblem}<p class="field-error" role="alert">{periodProblem}</p>{/if}
        {/if}
      {/if}

      {#if facts && (flow.phase === 'preview' || flow.phase === 'importing')}
        <section aria-label="Preview of {flow.fileName}">
          <dl class="facts">
            <div><dt>File</dt><dd class="mono">{flow.fileName}</dd></div>
            <div><dt>Period</dt><dd>{facts.period}</dd></div>
            <div><dt>Terms</dt><dd>{facts.terms}</dd></div>
            <div><dt>Countries</dt><dd>{facts.countries}</dd></div>
            <div class="wide"><dt>Rows</dt><dd>{facts.rows.join('; ')}.</dd></div>
            {#if facts.totals}<div class="wide"><dt>Numbers</dt><dd>{facts.totals}</dd></div>{/if}
          </dl>
          {#if facts.top.length > 0}
            <div class="table-wrap">
              <table class="compact">
                <caption class="visually-hidden">The biggest terms in the file</caption>
                <thead><tr><th scope="col">Term</th><th scope="col" class="num">Visitors</th><th scope="col" class="num">Installs</th><th scope="col" class="num">Conversion</th></tr></thead>
                <tbody>
                  {#each facts.top as t (t.term)}
                    <tr><th scope="row">{t.term}</th><td class="num">{t.visitors}</td><td class="num">{t.installs}</td><td class="num">{t.conversion}</td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          {#each facts.warnings as w (w)}<Alert tone="warn">{w}</Alert>{/each}
          {#if flow.plan.notes.length > 0}
            <Disclosure summary="Notes about this file" stateKey="aso.terms.notes">
              <ul class="notes">{#each flow.plan.notes as n (n)}<li>{n}</li>{/each}</ul>
            </Disclosure>
          {/if}
          <p class="will"><strong>{facts.willStore}</strong> Nothing is stored until you confirm.</p>
        </section>
      {/if}
    {/if}
  </div>
  {#snippet footer()}
    {#if flow.phase === 'done'}
      <Button variant="primary" onclick={() => (open = false)}>Close</Button>
    {:else}
      <Button disabled={busy} onclick={() => (open = false)}>{storedSomething ? 'Close' : 'Cancel'}</Button>
      {#if flow.phase === 'preview' || flow.phase === 'importing'}
        <Button disabled={busy} onclick={() => send({ type: 'reset' })}>Choose another file</Button>
        <Button variant="primary" icon="check" loading={flow.phase === 'importing'} disabled={!canConfirmTerms(flow) || busy} onclick={confirm}>Import these rows</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .steps {
    padding-left: var(--space-5);
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

  .period {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
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
    font-size: var(--text-sm);
  }

  .will {
    margin: var(--space-3) 0 0;
  }
</style>
