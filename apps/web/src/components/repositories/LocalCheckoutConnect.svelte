<!--
  LocalCheckoutConnect: connect a local clone (a git folder on the server). Enter the path, Check it,
  read what was found, then either attach it to a connected GitHub repository or connect it as a
  local-only repository. Nothing is saved until the last button.
  Props: api, workspaceId, config (from api.localConfig; null while it loads), repositories (the
  connected ones, to attach to), fixedRepository? (attach to this repository only: its own page),
  ondone (called with what happened and the saved repository), oncancel? (adds a Cancel button).
  Only for roles that can write repositories: the server refuses everyone else.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    type ConnectChoice,
    checkLocalPathInput,
    choiceButtonLabel,
    choiceNote,
    connectChoices,
    defaultChoice,
    localDisabledNotice,
    localReadSummary,
    localRootsHint,
    shortSha,
  } from '../../lib/repositories.ts';
  import type { LocalCheck, LocalConfig, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import T from '../ui/T.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    config,
    repositories,
    fixedRepository,
    ondone,
    oncancel,
  }: {
    api: Api;
    workspaceId: string;
    config: LocalConfig | null;
    repositories: RepositorySummary[];
    fixedRepository?: RepositorySummary | undefined;
    ondone: (done: { kind: 'attached' | 'local_only'; repository: RepositorySummary }) => void;
    oncancel?: (() => void) | undefined;
  } = $props();

  const uid = $props.id();

  let path = $state('');
  let pathError = $state('');
  let checking = $state(false);
  let saving = $state(false);
  let problem = $state('');
  let check = $state<LocalCheck | null>(null);
  /** The text that was checked: the result is hidden as soon as the field says something else. */
  let checkedText = $state('');
  let branch = $state('');
  let choiceId = $state('');
  let confirmed = $state(false);

  const current = $derived(check !== null && path.trim() === checkedText ? check : null);
  const choices = $derived<ConnectChoice[]>(current ? connectChoices(current, repositories, fixedRepository) : []);
  const choice = $derived(choices.find((c) => c.id === choiceId) ?? defaultChoice(choices));
  const needsConfirm = $derived(choice?.kind === 'attach' && choice.needsConfirm);
  const noBranch = $derived(current !== null && branch === '');
  const canSave = $derived(
    current !== null && choice !== undefined && !noBranch && (!needsConfirm || confirmed) && !saving && !checking,
  );

  async function runCheck(wantedBranch?: string) {
    problem = '';
    pathError = '';
    const parsed = checkLocalPathInput(path);
    if (!parsed.ok) {
      pathError = parsed.message;
      return;
    }
    checking = true;
    try {
      const { check: found } = await api.checkLocalClone(workspaceId, {
        path: parsed.path,
        ...(wantedBranch ? { branch: wantedBranch } : {}),
      });
      check = found;
      checkedText = parsed.path;
      path = parsed.path;
      branch = found.branch ?? '';
      confirmed = false;
      const next = defaultChoice(connectChoices(found, repositories, fixedRepository));
      choiceId = next?.id ?? '';
    } catch (e) {
      check = null;
      problem = e instanceof ApiError ? e.message : t('repositories:lc.checkFailed');
    } finally {
      checking = false;
    }
  }

  function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    void runCheck(current && branch ? branch : undefined);
  }

  async function save() {
    if (!current || !choice || !canSave) return;
    saving = true;
    problem = '';
    try {
      if (choice.kind === 'attach') {
        const { repository } = await api.attachLocalClone(workspaceId, choice.repositoryId, {
          path: current.realPath,
          branch,
          ...(choice.needsConfirm ? { allowRemoteMismatch: true } : {}),
        });
        ondone({ kind: 'attached', repository });
      } else {
        const { repository } = await api.connectLocalRepository(workspaceId, { path: current.realPath, branch });
        ondone({ kind: 'local_only', repository });
      }
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('common:error.genericRetry');
    } finally {
      saving = false;
    }
  }
</script>

{#if config && !config.enabled}
  {@const notice = localDisabledNotice(config)}
  <Alert tone="info" title={notice.title}>
    <p class="tight">{notice.body}</p>
    <p class="tight muted">{t('repositories:lcc.disabledNote')}</p>
  </Alert>
  {#if oncancel}
    <div class="actions"><Button onclick={oncancel}>{t('repositories:lcc.close')}</Button></div>
  {/if}
{:else}
  <div class="stack">
    <form class="stack" {onsubmit} novalidate>
      <TextField
        label={t('repositories:lcc.folderLabel')}
        bind:value={path}
        required
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        placeholder="/Volumes/dev/my-app"
        hint={config ? localRootsHint(config) : t('repositories:lcc.loadingRoots')}
        error={pathError}
        disabled={config === null}
      />
      <div class="row">
        <Button type="submit" icon="search" loading={checking} disabled={config === null || saving}>{checking ? t('repositories:lcc.checking') : t('repositories:lcc.checkFolder')}</Button>
        <span class="muted small">{t('repositories:lcc.readingOnly')}</span>
      </div>
    </form>

    {#if problem}
      <Alert tone="error" title={t('repositories:lcc.problemTitle')}>
        <p class="tight">{problem}</p>
      </Alert>
    {/if}

    {#if current}
      <div class="found stack" aria-live="polite">
        <dl class="facts">
          <div>
            <dt>{t('repositories:lc.folder')}</dt>
            <dd><code>{current.realPath}</code>{#if current.worktree}&nbsp;<span class="muted">{t('repositories:lcc.worktree')}</span>{/if}</dd>
          </div>
          <div>
            <dt>{t('repositories:lcc.origin')}</dt>
            <dd>
              {#if current.remote}
                {current.remote.host}/{current.remote.owner}/{current.remote.repo}
              {:else}
                <span class="muted">{t('repositories:lcc.noOrigin')}</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>{t('repositories:lcc.checkedOut')}</dt>
            <dd>{#if current.checkedOutBranch}<code>{current.checkedOutBranch}</code>{:else}<span class="muted">{t('repositories:lcc.detachedAt', { sha: shortSha(current.headSha) })}</span>{/if}</dd>
          </div>
        </dl>

        {#if current.branches.length > 0}
          <div class="field">
            <label for="{uid}-branch" class="required">{t('repositories:lcc.branchToRead')}</label>
            <select id="{uid}-branch" bind:value={branch} disabled={checking || saving} onchange={() => runCheck(branch)}>
              {#if branch === ''}<option value="" disabled>{t('repositories:lcc.chooseBranch')}</option>{/if}
              {#each current.branches as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
            <p class="hint" id="{uid}-branch-hint">{t('repositories:lcc.branchHint')}</p>
          </div>
        {/if}

        {#if branch !== ''}
          <p class="summary">
            <Icon name="git-branch" />
            <span>{localReadSummary({ branch, sha: current.branchSha, checkedOutBranch: current.checkedOutBranch, dirtyCount: current.dirtyCount })}</span>
          </p>
        {:else}
          <Alert tone="warn" title={t('repositories:lcc.detachedTitle')}>{t('repositories:lcc.detachedBody')}</Alert>
        {/if}

        {#each current.warnings as warning (warning)}
          <Alert tone="warn">{warning}</Alert>
        {/each}

        {#if current.existing && choices.length === 0}
          <Alert tone="info" title={t('repositories:lcc.existingTitle')}>
            {#if current.existing.localOnly}
              <T key="repositories:lcc.existingLocalOnly" params={{ name: current.existing.name }} />
            {:else}
              <T key="repositories:lcc.existing" params={{ name: current.existing.name }} />
            {/if}
          </Alert>
        {:else if choices.length > 0}
          <fieldset class="stack tight">
            <legend>{t('repositories:lcc.whatToDo')}</legend>
            {#each choices as option (option.id)}
              {@const note = choiceNote(option, current.remote)}
              <label class="check option" class:selected={choice?.id === option.id}>
                {#if choices.length > 1}
                  <input type="radio" name="{uid}-choice" value={option.id} bind:group={choiceId} disabled={saving} />
                {/if}
                <span class="option-text">
                  <span class="option-label">{#if option.kind === 'attach' && option.recommended}{t('repositories:lcc.optionRecommended', { label: option.label })}{:else}{option.label}{/if}</span>
                  {#if note}<span class="muted small">{note}</span>{/if}
                </span>
              </label>
            {/each}
          </fieldset>

          {#if needsConfirm}
            <label class="check">
              <input type="checkbox" bind:checked={confirmed} disabled={saving} />
              <span>{t('repositories:lcc.confirmMismatch')}</span>
            </label>
          {/if}

          {#if choice?.kind === 'local_only'}
            <Alert tone="info" title={t('repositories:lcc.localOnlyTitle')}>
              {t('repositories:lcc.localOnlyBody')}
            </Alert>
          {/if}
        {/if}
      </div>
    {/if}

    <div class="actions">
      {#if oncancel}<Button disabled={saving} onclick={oncancel}>{t('repositories:action.cancel')}</Button>{/if}
      {#if current && choices.length > 0}
        <Button variant="primary" loading={saving} disabled={!canSave} onclick={save}>{saving ? t('repositories:lcc.saving') : choiceButtonLabel(choice)}</Button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .tight {
    margin: 0;
  }

  .tight + .tight {
    margin-top: var(--space-1);
  }

  .small {
    font-size: var(--text-sm);
  }

  .found {
    padding: var(--space-4);
    background: var(--surface-2, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
  }

  .facts {
    display: grid;
    gap: var(--space-3);
    margin: 0;
  }

  dt {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  dd {
    margin: var(--space-1) 0 0;
    overflow-wrap: anywhere;
  }

  .summary {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin: 0;
  }

  .option {
    align-items: flex-start;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
  }

  .option.selected {
    border-color: var(--accent, currentColor);
  }

  .option-text {
    display: grid;
    gap: var(--space-1);
  }

  .option-label {
    font-weight: var(--weight-medium);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
