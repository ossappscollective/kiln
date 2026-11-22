<!--
  AddAppModal: a dialog that adds apps, in two ways on one dialog.
  "Import from a credential" (the default) finds the apps behind a stored App Store Connect or
  Google Play credential and adds the ticked ones (see ImportFromCredential.svelte).
  "Add manually" is the form for edge cases: pick the platform, a stored credential of the kind
  that platform's store needs, and the identifier; the name and a repository are optional.
  Adding does not contact the store: the first sync does.
  The platform is iOS, macOS or Android: an App Store Connect app can have an iOS and a macOS record
  (one app entry in the list), so adding the macOS version of an iOS app is one more record.
  Props: api, workspaceId, open (bindable), onadded (called with the app saved by the manual form),
  canSync (the role may sync; the import path then offers "Sync imported apps"), onchanged
  (called after an import or its sync changed the apps, so the list can reload), prefill? (opens on
  the manual form with these values: platform, identifier, name, credentialId, repositoryId).
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { PLATFORMS, type Platform, credentialKindInfo, isCredentialKind, platformMeta } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { repositoryName } from '../../lib/repositories.ts';
  import {
    type DraftProblems,
    addProblem,
    credentialsFor,
    describeError,
    identifierHint,
    identifierLabel,
    validateDraft,
  } from '../../lib/portfolio.ts';
  import type { AppSummary, CredentialSummary, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import TextField from '../ui/TextField.svelte';
  import ImportFromCredential from './ImportFromCredential.svelte';

  let {
    api,
    workspaceId,
    open = $bindable(false),
    onadded,
    canSync = false,
    onchanged,
    prefill,
  }: {
    api: Api;
    workspaceId: string;
    open?: boolean | undefined;
    onadded: (app: AppSummary) => void;
    canSync?: boolean | undefined;
    onchanged?: (() => void) | undefined;
    prefill?: Partial<{ platform: Platform; identifier: string; name: string; credentialId: string; repositoryId: string }> | undefined;
  } = $props();

  const formId = $props.id();

  let credentials = $state<CredentialSummary[] | null>(null);
  let repositories = $state<RepositorySummary[]>([]);
  let loadError = $state('');
  let platform = $state<Platform>('ios');
  let credentialId = $state('');
  let identifier = $state('');
  let name = $state('');
  let repositoryId = $state('');
  let busy = $state(false);
  /** True while the import path has a request running. */
  let importBusy = $state(false);
  let tab = $state('import');
  let problems = $state<DraftProblems>({});
  let formProblem = $state('');

  const matching = $derived(credentials ? credentialsFor(platform, credentials) : []);
  const kindName = $derived(credentialKindInfo[platformMeta(platform).credentialKind].label);
  const kindLabel = (kind: string) => (isCredentialKind(kind) ? credentialKindInfo[kind].label : kind);

  async function load() {
    loadError = '';
    credentials = null;
    repositories = [];
    try {
      credentials = (await api.credentials(workspaceId)).credentials;
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : t('portfolio:add.loadFailed');
      return;
    }
    // The repository is optional, so a failure here only hides the choice.
    try {
      repositories = (await api.repositories(workspaceId)).repositories;
    } catch {
      repositories = [];
    }
  }

  $effect(() => {
    if (!open) return;
    tab = prefill ? 'manual' : 'import';
    platform = prefill?.platform ?? 'ios';
    credentialId = prefill?.credentialId ?? '';
    identifier = prefill?.identifier ?? '';
    name = prefill?.name ?? '';
    repositoryId = prefill?.repositoryId ?? '';
    problems = {};
    formProblem = '';
    void load();
  });

  // Changing the platform changes which credentials fit. Keep the choice only if it still does,
  // and pick the only one on offer.
  function choosePlatform(next: Platform) {
    platform = next;
    problems = {};
    const fits = credentials ? credentialsFor(next, credentials) : [];
    credentialId = fits.length === 1 ? (fits[0]?.id ?? '') : fits.some((c) => c.id === credentialId) ? credentialId : '';
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    problems = {};
    formProblem = '';
    const checked = validateDraft({ platform, identifier, credentialId, name, repositoryId });
    if (!checked.ok) {
      problems = checked.problems;
      return;
    }
    busy = true;
    try {
      const { app } = await api.createApp(workspaceId, checked.input);
      open = false;
      onadded(app);
    } catch (e) {
      if (e instanceof ApiError) {
        const problem = addProblem(e);
        if (problem.field === 'form') formProblem = problem.message;
        else problems = { [problem.field]: problem.message };
      } else {
        formProblem = describeError(e, 'add');
      }
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  bind:open
  title={t('portfolio:add.title')}
  description={t('portfolio:add.description')}
  size="lg"
  dismissible={!busy && !importBusy}
>
  {#if credentials === null && !loadError}
    <div class="stack" role="status" aria-label={t('portfolio:add.loading')}>
      <Skeleton width="30%" height="14px" />
      <Skeleton height="36px" />
      <Skeleton width="30%" height="14px" />
      <Skeleton height="36px" />
    </div>
  {:else if loadError}
    <div class="stack">
      <Alert tone="error">{loadError}</Alert>
      <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if credentials}
    <Tabs
      label={t('portfolio:add.how')}
      bind:value={tab}
      tabs={[
        { id: 'import', label: t('portfolio:add.tabImport') },
        { id: 'manual', label: t('portfolio:add.tabManual') },
      ]}
    >
      {#snippet panel(id)}
        {#if id === 'import' && credentials}
          <ImportFromCredential
            {api}
            {workspaceId}
            {credentials}
            {repositories}
            {canSync}
            {onchanged}
            onclose={() => (open = false)}
            bind:busy={importBusy}
          />
        {:else}
          {@render manual()}
        {/if}
      {/snippet}
    </Tabs>
  {/if}


  {#snippet footer()}
    {#if credentials && tab === 'manual'}
      <Button disabled={busy} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
      <Button type="submit" form={formId} variant="primary" loading={busy} disabled={matching.length === 0}>
        {busy ? t('portfolio:add.adding') : t('portfolio:page.addApp')}
      </Button>
    {:else}
      <Button disabled={importBusy} onclick={() => (open = false)}>{t('common:action.close')}</Button>
    {/if}
  {/snippet}
</Modal>

{#snippet credentialsLink(text: string)}<a href="#/credentials" onclick={() => (open = false)}>{text}</a>{/snippet}
{#snippet manual()}
  <form id={formId} class="stack" onsubmit={submit} novalidate>
    <fieldset class="platform">
      <legend>{t('app:scope.label')}</legend>
      <div class="choices">
        {#each PLATFORMS as p (p)}
          <label class="check">
            <input type="radio" name="{formId}-platform" value={p} checked={platform === p} onchange={() => choosePlatform(p)} />
            <Icon name={platformMeta(p).glyph} /> {platformMeta(p).label} ({platformMeta(p).storeName})
          </label>
        {/each}
      </div>
    </fieldset>

    {#if matching.length === 0}
      <Alert tone="info" title={t('portfolio:add.noCredentialTitle', { kind: kindName })}>
        <T key="portfolio:add.noCredential" params={{ kind: kindName }} tags={{ link: credentialsLink }} />
      </Alert>
    {:else}
      <div class="field">
        <label for="{formId}-credential" class="required">{t('app:stores.credential')}</label>
        <select
          id="{formId}-credential"
          bind:value={credentialId}
          required
          aria-invalid={problems.credentialId ? 'true' : undefined}
          aria-describedby={problems.credentialId ? `${formId}-credential-error` : undefined}
        >
          <option value="" disabled>{t('portfolio:add.chooseCredential')}</option>
          {#each matching as credential (credential.id)}
            <option value={credential.id}>{credential.label} ({kindLabel(credential.kind)})</option>
          {/each}
        </select>
        {#if problems.credentialId}
          <p class="field-error" id="{formId}-credential-error">
            <Icon name="alert" size={14} class="field-error-icon" />
            <span>{problems.credentialId}</span>
          </p>
        {/if}
      </div>
    {/if}

    <TextField
      label={identifierLabel(platform)}
      bind:value={identifier}
      required
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      placeholder="com.acme.app"
      hint={identifierHint(platform)}
      error={problems.identifier}
    />

    <TextField
      label={t('portfolio:add.name')}
      bind:value={name}
      autocomplete="off"
      maxlength={100}
      hint={t('portfolio:add.nameHint')}
      error={problems.name}
    />

    {#if repositories.length > 0}
      <div class="field">
        <label for="{formId}-repository">{t('app:chips.repository')}</label>
        <select
          id="{formId}-repository"
          bind:value={repositoryId}
          aria-invalid={problems.repositoryId ? 'true' : undefined}
          aria-describedby="{formId}-repository-hint{problems.repositoryId ? ` ${formId}-repository-error` : ''}"
        >
          <option value="">{t('portfolio:overviewTable.none')}</option>
          {#each repositories as repository (repository.id)}
            <option value={repository.id}>{repositoryName(repository)}</option>
          {/each}
        </select>
        <p class="hint" id="{formId}-repository-hint">{t('portfolio:add.repositoryHint')}</p>
        {#if problems.repositoryId}
          <p class="field-error" id="{formId}-repository-error">
            <Icon name="alert" size={14} class="field-error-icon" />
            <span>{problems.repositoryId}</span>
          </p>
        {/if}
      </div>
    {/if}

    {#if formProblem}
      <Alert tone="error" title={t('portfolio:add.failed')}>{formProblem}</Alert>
    {/if}
  </form>
{/snippet}

<style>
  .platform {
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .platform legend {
    padding: 0;
    margin-bottom: var(--space-2);
    font-weight: var(--weight-medium);
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
  }
</style>
