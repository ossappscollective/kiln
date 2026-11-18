<!--
  ImportFromCredential: the "Import from a credential" path of the Add app dialog. Pick a stored
  App Store Connect or Google Play credential, find the apps behind it, tick the ones to add and
  import them in one go. Nothing is synced unless the person asks ("Sync imported apps").
  App Store Connect lists every app its key can see. Google Play cannot list the apps of an
  account, so the person enters package names and each is verified read-only.
  Props: api, workspaceId, credentials (all of the workspace), repositories, canSync (the role may
  sync), onchanged (called after apps were added or synced, so the list can reload), onclose
  (closes the dialog), busy (bindable; true while a request runs, so the dialog is not dismissed).
-->
<script lang="ts">
  import { credentialKindInfo, isCredentialKind } from '@mrm/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { repositoryName } from '../../lib/repositories.ts';
  import {
    MAX_IMPORT_BATCH,
    type BatchResult,
    type CredentialKind,
    appLabel,
    batchSummary,
    buildImportItems,
    candidateKey,
    chunk,
    describeError,
    discoverFailureMessage,
    discoverSummaryText,
    discoverableCredentials,
    importItemMessage,
    importScopeNote,
    importSummaryText,
    importedApps,
    mergeImports,
    packageListProblem,
    parsePackageList,
    platformForKind,
    selectableCandidates,
    syncApps,
    withSelection,
  } from '../../lib/portfolio.ts';
  import { storeForCredentialKind } from '../../lib/stores.ts';
  import type {
    AppSummary,
    CredentialSummary,
    DiscoverResult,
    ImportResult,
    RepositorySummary,
  } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';
  import PlatformBadge from './PlatformBadge.svelte';

  let {
    api,
    workspaceId,
    credentials,
    repositories,
    canSync,
    onchanged,
    onclose,
    busy = $bindable(false),
  }: {
    api: Api;
    workspaceId: string;
    credentials: CredentialSummary[];
    repositories: RepositorySummary[];
    canSync: boolean;
    onchanged?: () => void;
    onclose: () => void;
    busy?: boolean;
  } = $props();

  const uid = $props.id();

  const usable = $derived(discoverableCredentials(credentials));

  let credentialId = $state('');
  let packagesText = $state('');
  let packagesProblem = $state('');
  let discovery = $state<DiscoverResult | null>(null);
  let discoverError = $state('');
  let discovering = $state(false);
  let selected = $state<ReadonlySet<string>>(new Set());
  let repositoryFor = $state<Record<string, string>>({});
  let importing = $state(false);
  let importError = $state('');
  let imported = $state<ImportResult | null>(null);
  let syncing = $state(false);
  let syncResults = $state<BatchResult[] | null>(null);
  let syncCurrent = $state('');
  let reviewHeading = $state<HTMLElement>();
  let doneHeading = $state<HTMLElement>();
  let syncStatus = $state<HTMLElement>();

  const credential = $derived(usable.find((c) => c.id === credentialId));
  const kind = $derived(credential && isCredentialKind(credential.kind) ? (credential.kind as CredentialKind) : undefined);
  const addable = $derived(discovery ? selectableCandidates(discovery.candidates) : []);
  const selectedCount = $derived(addable.filter((c) => selected.has(candidateKey(c))).length);
  const createdApps = $derived<AppSummary[]>(imported ? importedApps(imported) : []);
  const kindLabel = (k: string) => (isCredentialKind(k) ? credentialKindInfo[k].label : k);

  $effect(() => {
    busy = discovering || importing || syncing;
  });

  // Leaving the tab ends this screen; the dialog must not stay locked.
  $effect(() => () => {
    busy = false;
  });

  // The only credential on offer is chosen for the person.
  $effect(() => {
    if (!credentialId && usable.length === 1) credentialId = usable[0]?.id ?? '';
  });

  function resetResults() {
    discovery = null;
    discoverError = '';
    packagesProblem = '';
    importError = '';
    imported = null;
    syncResults = null;
    selected = new Set();
    repositoryFor = {};
  }

  function chooseCredential() {
    resetResults();
  }

  async function discover(event?: Event) {
    event?.preventDefault();
    if (!credential || !kind || discovering) return;
    discoverError = '';
    packagesProblem = '';
    let packages: string[] | undefined;
    if (kind === 'google_play') {
      const list = parsePackageList(packagesText);
      packagesProblem = packageListProblem(list);
      if (packagesProblem) return;
      packages = list.packages;
    }
    discovering = true;
    try {
      const result = await api.discoverApps(workspaceId, {
        credentialId: credential.id,
        ...(packages ? { packages } : {}),
      });
      discovery = result;
      selected = new Set(selectableCandidates(result.candidates).map(candidateKey));
      repositoryFor = {};
      importError = '';
      await tick();
      reviewHeading?.focus();
    } catch (e) {
      discoverError = describeError(e, 'discover');
    } finally {
      discovering = false;
    }
  }

  function toggle(key: string, on: boolean) {
    selected = withSelection(selected, key, on);
  }

  const selectAll = () => {
    selected = new Set(addable.map(candidateKey));
  };
  const selectNone = () => {
    selected = new Set();
  };

  function backToChoose() {
    discovery = null;
    importError = '';
    discoverError = '';
  }

  async function runImport() {
    if (!discovery || importing || selectedCount === 0) return;
    importing = true;
    importError = '';
    const items = buildImportItems(discovery.candidates, selected, repositoryFor);
    const parts: ImportResult[] = [];
    try {
      for (const piece of chunk(items, MAX_IMPORT_BATCH)) {
        parts.push(await api.importApps(workspaceId, { credentialId: discovery.credentialId, items: piece }));
      }
    } catch (e) {
      importError = describeError(e, 'import');
      if (e instanceof ApiError && e.status === 401) {
        importing = false;
        return;
      }
    }
    importing = false;
    // Whatever was created before a failure is real: show it, and let the list reload.
    if (parts.length > 0) {
      imported = mergeImports(parts);
      if (imported.summary.created > 0) onchanged?.();
      await tick();
      doneHeading?.focus();
    }
  }

  async function syncImported() {
    if (syncing || createdApps.length === 0) return;
    syncing = true;
    syncResults = createdApps.map((a) => ({ appId: a.id, name: appLabel(a), status: 'pending', message: '' }));
    await tick();
    syncStatus?.focus();
    const results = await syncApps(api, workspaceId, createdApps, (partial, current) => {
      syncResults = [...partial];
      syncCurrent = current;
    });
    syncResults = results;
    syncCurrent = '';
    syncing = false;
    onchanged?.();
    await tick();
    syncStatus?.focus();
  }

  function importMore() {
    resetResults();
  }

  const syncWords: Record<BatchResult['status'], string> = {
    pending: 'Waiting',
    running: 'Syncing',
    ok: 'Synced',
    failed: 'Failed',
    busy: 'Already syncing',
    skipped: 'Not run',
  };

  const syncProgress = $derived(
    syncResults ? (syncing ? `Syncing${syncCurrent ? `: ${syncCurrent}` : '…'}` : batchSummary(syncResults)) : '',
  );
</script>

<div class="stack">
  {#if usable.length === 0}
    <Alert tone="info" title="No store credential yet">
      Add an App Store Connect or Google Play credential on the <a href="#/credentials" onclick={onclose}>Credentials</a>
      screen, then come back to find your apps. You can also add one by hand with the other tab.
    </Alert>
  {:else if imported}
    <div class="stack tight" aria-labelledby="{uid}-done-title" role="group">
      <h3 id="{uid}-done-title" class="section-title" tabindex="-1" bind:this={doneHeading}>Import finished</h3>
      <Alert tone={imported.summary.failed > 0 || importError ? 'warn' : 'ok'}>
        {importSummaryText(imported.summary, imported.results)}
        {#if createdApps.length > 0 && !syncResults}
          Nothing has been read from the store yet.
        {/if}
      </Alert>
      {#if kind && imported.summary.created > 0}
        <p class="muted scope">{importScopeNote(platformForKind(kind))}</p>
      {/if}
      {#if importError}
        <Alert tone="error" title="Part of the import did not run">{importError}</Alert>
      {/if}
      <ul class="results">
        {#each imported.results as result, index (index)}
          <li class="result {result.status}">
            <span class="mark">
              <Icon name={result.status === 'created' ? 'check-circle' : result.status === 'skipped' ? 'minus' : 'alert'} size={16} />
            </span>
            <div>
              <p class="line">
                <strong>{result.app?.name ?? result.identifier}</strong>
                <PlatformBadge platform={result.platform} />
                <span class="mono muted">{result.identifier}</span>
                <span class="state">{result.status === 'created' ? 'Added' : result.status === 'skipped' ? 'Skipped' : 'Not added'}</span>
              </p>
              {#if result.status !== 'created'}
                <p class="message">{importItemMessage(result)}</p>
              {/if}
            </div>
          </li>
        {/each}
      </ul>

      {#if syncResults}
        <div class="stack tight">
          <p class="sync-status" role="status" tabindex="-1" bind:this={syncStatus}>{syncProgress}</p>
          <ul class="results">
            {#each syncResults as result (result.appId)}
              <li class="result {result.status === 'ok' ? 'created' : result.status === 'failed' ? 'failed' : 'skipped'}">
                <span class="mark" class:spin={result.status === 'running'}>
                  <Icon
                    name={result.status === 'ok' ? 'check-circle' : result.status === 'running' ? 'refresh' : result.status === 'pending' ? 'clock' : 'alert'}
                    size={16}
                  />
                </span>
                <div>
                  <p class="line"><strong>{result.name}</strong> <span class="state">{syncWords[result.status]}</span></p>
                  {#if result.message}<p class="message">{result.message}</p>{/if}
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class="actions">
        {#if canSync && createdApps.length > 0 && !syncResults}
          <Button variant="primary" icon="refresh" onclick={syncImported}>
            Sync imported apps ({createdApps.length})
          </Button>
        {/if}
        <Button disabled={syncing} onclick={importMore}>Import more</Button>
        <Button variant={canSync && createdApps.length > 0 && !syncResults ? 'secondary' : 'primary'} disabled={syncing} onclick={onclose}>Done</Button>
      </div>
    </div>
  {:else}
    <div class="field">
      <label for="{uid}-credential" class="required">Credential</label>
      <select
        id="{uid}-credential"
        bind:value={credentialId}
        disabled={discovering || importing}
        onchange={chooseCredential}
        aria-describedby="{uid}-credential-hint"
      >
        <option value="" disabled>Choose a credential</option>
        {#each usable as c (c.id)}
          <option value={c.id}>{c.label} ({kindLabel(c.kind)})</option>
        {/each}
      </select>
      {#if kind}<div class="row"><StoreBadge store={storeForCredentialKind(kind).store} variant="full" size="sm" /></div>{/if}
      <p class="hint" id="{uid}-credential-hint">
        The credential reads the store. Nothing is ever written to it, and the secret is never shown.
      </p>
    </div>

    {#if discoverError}
      <Alert tone="error" title="Could not find apps">{discoverError}</Alert>
    {/if}

    {#if !discovery}
      {#if kind === 'app_store_connect'}
        <p class="muted">Lists every app this App Store Connect key can see.</p>
        <div class="actions">
          <Button variant="primary" icon="search" loading={discovering} onclick={() => discover()}>
            {discovering ? 'Finding apps…' : 'Find apps'}
          </Button>
        </div>
      {:else if kind === 'google_play'}
        <form class="stack tight" onsubmit={discover} novalidate>
          <div class="field">
            <label for="{uid}-packages" class="required">Package names</label>
            <textarea
              id="{uid}-packages"
              bind:value={packagesText}
              rows="5"
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              placeholder={'com.acme.app\ncom.acme.beta'}
              disabled={discovering}
              aria-invalid={packagesProblem ? 'true' : undefined}
              aria-describedby="{uid}-packages-hint{packagesProblem ? ` ${uid}-packages-error` : ''}"
            ></textarea>
            <p class="hint" id="{uid}-packages-hint">
              One per line, up to 50. Google Play cannot list the apps of an account, so enter the ones you want. Each is
              checked read-only with this service account.
            </p>
            {#if packagesProblem}
              <p class="field-error" id="{uid}-packages-error">
                <Icon name="alert" size={14} class="field-error-icon" />
                <span>{packagesProblem}</span>
              </p>
            {/if}
          </div>
          <div class="actions">
            <Button type="submit" variant="primary" icon="search" loading={discovering}>
              {discovering ? 'Checking…' : 'Check packages'}
            </Button>
          </div>
        </form>
      {/if}
    {:else}
      <div class="stack tight">
        <h3 class="section-title" tabindex="-1" bind:this={reviewHeading}>
          {discovery.kind === 'google_play' ? 'Verified apps' : 'Apps found'}
        </h3>
        <p class="muted" role="status">{discoverSummaryText(discovery)}</p>
        {#if kind}<p class="muted scope">{importScopeNote(platformForKind(kind))}</p>{/if}

        {#if discovery.candidates.length > 0}
          <div class="row wrap between">
            <p class="count" aria-live="polite">{selectedCount} of {addable.length} selected</p>
            {#if addable.length > 0}
              <div class="row">
                <Button size="sm" variant="ghost" disabled={selectedCount === addable.length || importing} onclick={selectAll}>Select all</Button>
                <Button size="sm" variant="ghost" disabled={selectedCount === 0 || importing} onclick={selectNone}>Select none</Button>
              </div>
            {/if}
          </div>
          <fieldset class="list-set" disabled={importing}>
            <legend class="visually-hidden">Apps to add</legend>
            <ul class="candidates">
              {#each discovery.candidates as c (candidateKey(c))}
                {@const key = candidateKey(c)}
                <li class="candidate" class:added={c.alreadyAdded}>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={c.alreadyAdded ? false : selected.has(key)}
                      disabled={c.alreadyAdded}
                      onchange={(event) => toggle(key, event.currentTarget.checked)}
                    />
                    <AppIcon name={c.name} platform={c.platform} seed={c.identifier} size="sm" />
                    <span class="who">
                      <span class="name">{c.name}</span>
                      <span class="mono muted">{c.identifier}</span>
                    </span>
                  </label>
                  <span class="badges">
                    <PlatformBadge platform={c.platform} />
                    {#if c.alreadyAdded}<Badge tone="ok">Already added</Badge>{/if}
                  </span>
                  {#if !c.alreadyAdded && selected.has(key) && repositories.length > 0}
                    <div class="repo">
                      <label for="{uid}-repo-{key}" class="visually-hidden">Repository for {c.name}</label>
                      <select id="{uid}-repo-{key}" bind:value={repositoryFor[key]}>
                        <option value="">No repository</option>
                        {#each repositories as repository (repository.id)}
                          <option value={repository.id}>{repositoryName(repository)}</option>
                        {/each}
                      </select>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </fieldset>
        {/if}

        {#if discovery.failures.length > 0}
          <div class="failures">
            <h4 class="section-title small">Could not be verified</h4>
            <ul class="results">
              {#each discovery.failures as failure (failure.identifier)}
                <li class="result failed">
                  <span class="mark"><Icon name="alert" size={16} /></span>
                  <div>
                    <p class="line"><span class="mono">{failure.identifier}</span></p>
                    <p class="message">{discoverFailureMessage(failure)}</p>
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if importError}
          <Alert tone="error" title="Could not add the apps">{importError}</Alert>
        {/if}

        <div class="actions">
          <Button disabled={importing} onclick={backToChoose}>
            {discovery.kind === 'google_play' ? 'Edit the list' : 'Back'}
          </Button>
          <Button variant="primary" icon="plus" loading={importing} disabled={selectedCount === 0} onclick={runImport}>
            {importing ? 'Adding…' : `Import selected (${selectedCount})`}
          </Button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .section-title {
    margin: 0;
    font-size: var(--text-md);
  }

  .section-title.small {
    font-size: var(--text-sm);
  }

  .section-title:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .count {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .list-set {
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .candidates {
    max-height: min(46dvh, 360px);
    padding: 0;
    margin: 0;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .candidate {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
  }

  .candidate + .candidate {
    border-top: 1px solid var(--line);
  }

  .candidate.added {
    background: var(--surface-sunken);
  }

  .candidate .check {
    flex: 1;
    min-width: 0;
  }

  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }

  .who .mono {
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .badges {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .repo {
    width: 100%;
    padding-left: var(--space-6);
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .result {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }

  .mark {
    display: inline-flex;
    margin-top: 2px;
    color: var(--muted);
  }

  .result.created .mark {
    color: var(--ok-ink);
  }

  .result.failed .mark {
    color: var(--bad-ink);
  }

  .result.skipped .mark {
    color: var(--warn-ink);
  }

  .line,
  .message {
    margin: 0;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: baseline;
  }

  .state {
    color: var(--muted);
  }

  .message {
    font-size: var(--text-sm);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .result.failed .message {
    color: var(--bad-ink);
  }

  .scope {
    margin: 0;
    font-size: var(--text-sm);
  }

  .sync-status {
    margin: 0;
    color: var(--muted);
  }

  .sync-status:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .failures {
    padding-top: var(--space-2);
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
