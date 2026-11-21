<!--
  ConnectForm: a dialog that connects a repository, in one of two ways. GitHub: pick a stored GitHub
  credential and enter owner/name; the server reads the repository with that credential before
  saving it. Local clone: a git folder on the server, attached to a connected repository or
  connected as a local-only one (needs KILN_LOCAL_REPO_ROOTS on the server).
  Props: api, workspaceId, open (bindable), onconnected (called with the saved GitHub repository),
  onlocal (called when a folder was attached or connected, with what happened).
-->
<script lang="ts">
  import { credentialKindInfo, isCredentialKind } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { type ConnectProblem, connectProblem, parseRepositoryInput } from '../../lib/repositories.ts';
  import type { CredentialSummary, LocalConfig, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import TextField from '../ui/TextField.svelte';
  import LocalCheckoutConnect from './LocalCheckoutConnect.svelte';

  let {
    api,
    workspaceId,
    open = $bindable(false),
    onconnected,
    onlocal,
  }: {
    api: Api;
    workspaceId: string;
    open?: boolean | undefined;
    onconnected: (repository: RepositorySummary) => void;
    onlocal: (done: { kind: 'attached' | 'local_only'; repository: RepositorySummary }) => void;
  } = $props();

  const formId = $props.id();
  /** The credential kinds that can read a repository. */
  const githubKinds = ['github_app', 'github_token'];

  /** `github`: owner/name with a credential. `local`: a folder on the server. */
  let mode = $state<'github' | 'local'>('github');
  let localConfig = $state<LocalConfig | null>(null);
  let localRepositories = $state<RepositorySummary[]>([]);
  let localError = $state('');

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
      loadError = e instanceof ApiError ? e.message : t('repositories:connect.credentialsFailed');
    }
  }

  async function loadLocal() {
    localError = '';
    localConfig = null;
    try {
      const [config, list] = await Promise.all([api.localConfig(workspaceId), api.repositories(workspaceId)]);
      localConfig = config.local;
      localRepositories = list.repositories;
    } catch (e) {
      localError = e instanceof ApiError ? e.message : t('repositories:connect.localFailed');
    }
  }

  $effect(() => {
    if (!open) return;
    mode = 'github';
    credentialId = '';
    target = '';
    problem = null;
    credentialError = '';
    targetError = '';
    void loadCredentials();
    void loadLocal();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    problem = null;
    credentialError = '';
    targetError = '';
    if (!credentialId) credentialError = t('repositories:connect.chooseCredentialError');
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
          : { field: 'form', message: t('common:error.genericRetry') };
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  bind:open
  title={t('repositories:connect.title')}
  description={t('repositories:connect.description')}
  size={mode === 'local' ? 'lg' : 'md'}
  dismissible={!busy}
>
  <div class="mode" role="radiogroup" aria-label={t('repositories:connect.how')}>
    <label class="check mode-option" class:selected={mode === 'github'}>
      <input type="radio" name="{formId}-mode" value="github" bind:group={mode} disabled={busy} />
      <span><Icon name="repo" /> {t('repositories:connect.modeGithub')}</span>
    </label>
    <label class="check mode-option" class:selected={mode === 'local'}>
      <input type="radio" name="{formId}-mode" value="local" bind:group={mode} disabled={busy} />
      <span><Icon name="folder" /> {t('repositories:connect.modeLocal')}</span>
    </label>
  </div>

  {#if mode === 'local'}
    {#if localError}
      <div class="stack">
        <Alert tone="error">{localError}</Alert>
        <div><Button icon="refresh" onclick={loadLocal}>{t('common:action.tryAgain')}</Button></div>
      </div>
    {:else}
      <LocalCheckoutConnect
        {api}
        {workspaceId}
        config={localConfig}
        repositories={localRepositories}
        ondone={(done) => {
          open = false;
          onlocal(done);
        }}
      />
    {/if}
  {:else}
    {#if credentials === null && !loadError}
      <div class="stack" role="status" aria-label={t('repositories:connect.loadingCredentialsAria')}>
        <Skeleton width="30%" height="14px" />
        <Skeleton height="36px" />
        <Skeleton width="30%" height="14px" />
        <Skeleton height="36px" />
      </div>
    {:else if loadError}
      <div class="stack">
        <Alert tone="error">{loadError}</Alert>
        <div><Button icon="refresh" onclick={loadCredentials}>{t('common:action.tryAgain')}</Button></div>
      </div>
    {:else if credentials && credentials.length === 0}
      <Alert tone="info" title={t('repositories:connect.noCredentialTitle')}>
        <T key="repositories:connect.noCredentialBody" tags={{ link: credentialsLink }} />
      </Alert>
    {:else if credentials}
      <form id={formId} class="stack" onsubmit={submit} novalidate>
        <div class="field">
          <label for="{formId}-credential" class="required">{t('repositories:connect.credentialLabel')}</label>
          <select
            id="{formId}-credential"
            bind:value={credentialId}
            required
            aria-invalid={credentialError || problem?.field === 'credential' ? 'true' : undefined}
            aria-describedby={credentialError ? `${formId}-credential-error` : undefined}
          >
            <option value="" disabled>{t('repositories:connect.chooseCredential')}</option>
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
          label={t('repositories:connect.repositoryLabel')}
          bind:value={target}
          required
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder="acme/mobile-app"
          hint={t('repositories:connect.repositoryHint')}
          error={targetError}
        />

        {#if problem}
          <Alert tone="error" title={t('repositories:connect.problemTitle')}>
            <p class="problem">{problem.message}</p>
            {#if problem.hint}<p class="problem hint-text">{problem.hint}</p>{/if}
          </Alert>
        {/if}
      </form>
    {/if}
  {/if}

  {#snippet footer()}
    <Button disabled={busy} onclick={() => (open = false)}>{t('repositories:action.cancel')}</Button>
    {#if mode === 'github' && credentials && credentials.length > 0}
      <Button type="submit" form={formId} variant="primary" loading={busy}>{busy ? t('repositories:connect.connecting') : t('repositories:connect.submit')}</Button>
    {/if}
  {/snippet}
</Modal>

{#snippet credentialsLink(text: string)}
  <a href="#/credentials" onclick={() => (open = false)}>{text}</a>
{/snippet}

<style>
  .mode {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .mode-option {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
  }

  .mode-option.selected {
    border-color: var(--accent, currentColor);
  }

  .problem {
    margin: var(--space-1) 0 0;
  }

  .hint-text {
    color: inherit;
  }
</style>
