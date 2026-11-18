<!--
  ConnectForm: a dialog that connects a GitHub repository. Pick a stored GitHub credential and
  enter owner/name; the server reads the repository with that credential before saving it.
  Props: api, workspaceId, open (bindable), onconnected (called with the saved repository).
-->
<script lang="ts">
  import { credentialKindInfo, isCredentialKind } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { type ConnectProblem, connectProblem, parseRepositoryInput } from '../../lib/repositories.ts';
  import type { CredentialSummary, RepositorySummary } from '../../lib/types.ts';
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
    onconnected,
  }: {
    api: Api;
    workspaceId: string;
    open?: boolean;
    onconnected: (repository: RepositorySummary) => void;
  } = $props();

  const formId = $props.id();
  /** The credential kinds that can read a repository. */
  const githubKinds = ['github_app', 'github_token'];

  let credentials = $state<CredentialSummary[] | null>(null);
  let loadError = $state('');
  let credentialId = $state('');
  let target = $state('');
  let busy = $state(false);
  let problem = $state<ConnectProblem | null>(null);
  let credentialError = $state('');
  let targetError = $state('');

  const kindLabel = (kind: string) => (isCredentialKind(kind) ? credentialKindInfo[kind].label : kind);

  async function loadCredentials() {
    loadError = '';
    credentials = null;
    try {
      const all = (await api.credentials(workspaceId)).credentials;
      credentials = all.filter((c) => githubKinds.includes(c.kind));
      if (credentials.length === 1) credentialId = credentials[0]?.id ?? '';
    } catch (e) {
      loadError = e instanceof ApiError ? e.message : 'Could not load credentials.';
    }
  }

  $effect(() => {
    if (!open) return;
    credentialId = '';
    target = '';
    problem = null;
    credentialError = '';
    targetError = '';
    void loadCredentials();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    problem = null;
    credentialError = '';
    targetError = '';
    if (!credentialId) credentialError = 'Choose the credential to connect with.';
    const parsed = parseRepositoryInput(target);
    if (!parsed.ok) targetError = parsed.message;
    if (credentialError || !parsed.ok) return;
    busy = true;
    try {
      const { repository } = await api.connectRepository(workspaceId, {
        credentialId,
        owner: parsed.owner,
        repo: parsed.repo,
      });
      open = false;
      onconnected(repository);
    } catch (e) {
      problem =
        e instanceof ApiError
          ? connectProblem(e, parsed)
          : { field: 'form', message: 'Something went wrong. Try again.' };
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  bind:open
  title="Connect a repository"
  description="The tool reads the repository with a stored GitHub credential. Nothing is changed until you approve a change set."
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
      <div><Button icon="refresh" onclick={loadCredentials}>Try again</Button></div>
    </div>
  {:else if credentials && credentials.length === 0}
    <Alert tone="info" title="No GitHub credential yet">
      Add a GitHub App or a GitHub token on the <a href="#/credentials" onclick={() => (open = false)}>Credentials</a> screen,
      then come back to connect a repository.
    </Alert>
  {:else if credentials}
    <form id={formId} class="stack" onsubmit={submit} novalidate>
      <div class="field">
        <label for="{formId}-credential" class="required">GitHub credential</label>
        <select
          id="{formId}-credential"
          bind:value={credentialId}
          required
          aria-invalid={credentialError || problem?.field === 'credential' ? 'true' : undefined}
          aria-describedby={credentialError ? `${formId}-credential-error` : undefined}
        >
          <option value="" disabled>Choose a credential</option>
          {#each credentials as credential (credential.id)}
            <option value={credential.id}>{credential.label} ({kindLabel(credential.kind)})</option>
          {/each}
        </select>
        {#if credentialError}
          <p class="field-error" id="{formId}-credential-error">
            <Icon name="alert" size={14} class="field-error-icon" />
            <span>{credentialError}</span>
          </p>
        {/if}
      </div>

      <TextField
        label="Repository"
        bind:value={target}
        required
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        placeholder="acme/mobile-app"
        hint="Owner and name, such as acme/mobile-app. You can also paste the GitHub address."
        error={targetError}
      />

      {#if problem}
        <Alert tone="error" title="Could not connect the repository">
          <p class="problem">{problem.message}</p>
          {#if problem.hint}<p class="problem hint-text">{problem.hint}</p>{/if}
        </Alert>
      {/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
    {#if credentials && credentials.length > 0}
      <Button type="submit" form={formId} variant="primary" loading={busy}>{busy ? 'Connecting…' : 'Connect repository'}</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .problem {
    margin: var(--space-1) 0 0;
  }

  .hint-text {
    color: inherit;
  }
</style>
