<!--
  AddAppModal: a dialog that adds an app. Pick the platform, a stored credential of the kind that
  platform's store needs, and the identifier; the name and a repository are optional. Adding does
  not contact the store: the first sync does.
  Props: api, workspaceId, open (bindable), onadded (called with the saved app).
-->
<script lang="ts">
  import type { Platform } from '@mrm/core';
  import { credentialKindInfo, isCredentialKind } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
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
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    open = $bindable(false),
    onadded,
  }: {
    api: Api;
    workspaceId: string;
    open?: boolean;
    onadded: (app: AppSummary) => void;
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
  let problems = $state<DraftProblems>({});
  let formProblem = $state('');

  const matching = $derived(credentials ? credentialsFor(platform, credentials) : []);
  const kindName = $derived(credentialKindInfo[platform === 'ios' ? 'app_store_connect' : 'google_play'].label);
  const kindLabel = (kind: string) => (isCredentialKind(kind) ? credentialKindInfo[kind].label : kind);

  async function load() {
    loadError = '';
    credentials = null;
    repositories = [];
    try {
      credentials = (await api.credentials(workspaceId)).credentials;
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Could not load credentials.';
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
    platform = 'ios';
    credentialId = '';
    identifier = '';
    name = '';
    repositoryId = '';
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
  title="Add an app"
  description="An app is one store listing. It reads the store with a stored credential; nothing is ever written to the store."
  dismissible={!busy}
>
  {#if credentials === null && !loadError}
    <div class="stack" role="status" aria-label="Loading credentials">
      <Skeleton width="30%" height="14px" />
      <Skeleton height="36px" />
      <Skeleton width="30%" height="14px" />
      <Skeleton height="36px" />
    </div>
  {:else if loadError}
    <div class="stack">
      <Alert tone="error">{loadError}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else}
    <form id={formId} class="stack" onsubmit={submit} novalidate>
      <fieldset class="platform">
        <legend>Platform</legend>
        <div class="choices">
          <label class="check">
            <input type="radio" name="{formId}-platform" value="ios" checked={platform === 'ios'} onchange={() => choosePlatform('ios')} />
            iOS (App Store)
          </label>
          <label class="check">
            <input type="radio" name="{formId}-platform" value="android" checked={platform === 'android'} onchange={() => choosePlatform('android')} />
            Android (Google Play)
          </label>
        </div>
      </fieldset>

      {#if matching.length === 0}
        <Alert tone="info" title="No {kindName} credential yet">
          Add a {kindName} credential on the <a href="#/credentials" onclick={() => (open = false)}>Credentials</a> screen,
          then come back to add this app.
        </Alert>
      {:else}
        <div class="field">
          <label for="{formId}-credential" class="required">Credential</label>
          <select
            id="{formId}-credential"
            bind:value={credentialId}
            required
            aria-invalid={problems.credentialId ? 'true' : undefined}
            aria-describedby={problems.credentialId ? `${formId}-credential-error` : undefined}
          >
            <option value="" disabled>Choose a credential</option>
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
        label="Name"
        bind:value={name}
        autocomplete="off"
        maxlength={100}
        hint="Optional. Shown in the portfolio. Defaults to the identifier."
        error={problems.name}
      />

      {#if repositories.length > 0}
        <div class="field">
          <label for="{formId}-repository">Repository</label>
          <select
            id="{formId}-repository"
            bind:value={repositoryId}
            aria-invalid={problems.repositoryId ? 'true' : undefined}
            aria-describedby="{formId}-repository-hint{problems.repositoryId ? ` ${formId}-repository-error` : ''}"
          >
            <option value="">None</option>
            {#each repositories as repository (repository.id)}
              <option value={repository.id}>{repository.owner}/{repository.repo}</option>
            {/each}
          </select>
          <p class="hint" id="{formId}-repository-hint">Optional. The repository that holds this app’s fastlane or Expo project.</p>
          {#if problems.repositoryId}
            <p class="field-error" id="{formId}-repository-error">
              <Icon name="alert" size={14} class="field-error-icon" />
              <span>{problems.repositoryId}</span>
            </p>
          {/if}
        </div>
      {/if}

      {#if formProblem}
        <Alert tone="error" title="Could not add the app">{formProblem}</Alert>
      {/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
    {#if credentials}
      <Button type="submit" form={formId} variant="primary" loading={busy} disabled={matching.length === 0}>
        {busy ? 'Adding…' : 'Add app'}
      </Button>
    {/if}
  {/snippet}
</Modal>

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
