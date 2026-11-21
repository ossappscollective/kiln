<!--
  LocalCheckoutCard: the "Local clone" card of a repository's page. Where the files are read from
  (the folder on the server, or GitHub), which branch and commit, what is left out because it is
  not committed, and how to attach, change or detach the folder.
  Props: api, workspaceId, repository, role, config (from api.localConfig; null while it loads),
  onchanged (called with the fresh repository after an attach, change or detach).
  Changing anything needs repositories.write (admin, owner); everyone who can see the repository
  sees the state. A local-only repository is only its folder: it has no Detach.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { localOnlyNotice } from '../../lib/change-set-apply.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    localDisabledNotice,
    localReadSummary,
    localStatusInfo,
    shortSha,
  } from '../../lib/repositories.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { LocalCheck, LocalConfig, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';
  import LocalCheckoutConnect from './LocalCheckoutConnect.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
    config,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    role: Role;
    config: LocalConfig | null;
    onchanged: (repository: RepositorySummary) => void;
  } = $props();

  const uid = $props.id();
  const canWrite = $derived(can(role, 'repositories.write'));
  const enabled = $derived(config?.enabled === true);
  const local = $derived(repository.local);
  const info = $derived(local ? localStatusInfo(local.status) : null);

  /** The result of "Check now": the live state of the folder, with the uncommitted count. */
  let live = $state<LocalCheck | null>(null);
  let liveBusy = $state(false);
  let liveError = $state('');

  let attachOpen = $state(false);

  let branchOpen = $state(false);
  let branchLoading = $state(false);
  let branchSaving = $state(false);
  let branchError = $state('');
  let branches = $state<string[]>([]);
  let branchValue = $state('');

  let detachOpen = $state(false);
  let detaching = $state(false);
  let detachError = $state('');

  // A different repository, or a changed folder, makes an old check meaningless.
  $effect(() => {
    void repository.id;
    void local?.path;
    void local?.branch;
    live = null;
    liveError = '';
  });

  async function checkNow() {
    if (!local) return;
    liveBusy = true;
    liveError = '';
    try {
      live = (await api.checkLocalClone(workspaceId, { path: local.path, branch: local.branch })).check;
    } catch (e) {
      live = null;
      liveError = e instanceof ApiError ? e.message : t('repositories:lc.checkFailed');
    } finally {
      liveBusy = false;
    }
  }

  async function openBranch() {
    if (!local) return;
    branchOpen = true;
    branchError = '';
    branchLoading = true;
    branchValue = local.branch;
    branches = [];
    try {
      const { check } = await api.checkLocalClone(workspaceId, { path: local.path, branch: local.branch });
      branches = check.branches;
    } catch (e) {
      branchError = e instanceof ApiError ? e.message : t('repositories:lc.branchesFailed');
    } finally {
      branchLoading = false;
    }
  }

  async function saveBranch() {
    if (!local || branchValue === '' || branchValue === local.branch) {
      branchOpen = false;
      return;
    }
    branchSaving = true;
    branchError = '';
    try {
      const { repository: saved } = await api.attachLocalClone(workspaceId, repository.id, { branch: branchValue });
      branchOpen = false;
      toast.success(t('repositories:lc.branchChanged', { branch: saved.local?.branch ?? branchValue }));
      onchanged(saved);
    } catch (e) {
      branchError = e instanceof ApiError ? e.message : t('repositories:lc.branchFailed');
    } finally {
      branchSaving = false;
    }
  }

  async function detach() {
    detaching = true;
    detachError = '';
    try {
      const { repository: saved } = await api.detachLocalClone(workspaceId, repository.id);
      detachOpen = false;
      toast.success(t('repositories:lc.detached'));
      onchanged(saved);
    } catch (e) {
      detachError = e instanceof ApiError ? e.message : t('repositories:lc.detachFailed');
    } finally {
      detaching = false;
    }
  }

  function attached(done: { kind: 'attached' | 'local_only'; repository: RepositorySummary }) {
    attachOpen = false;
    toast.success(t('repositories:lc.readingFromClone', { name: repository.name }));
    onchanged(done.repository);
  }
</script>

<Card
  title={t('repositories:lc.title')}
  description={repository.localOnly ? t('repositories:lc.descLocalOnly') : t('repositories:lc.descGithub')}
>
  {#if local}
    <div class="stack">
      {#if config && !config.enabled}
        {@const notice = localDisabledNotice(config)}
        <Alert tone="warn" title={notice.title}>
          <p class="tight">{notice.body}</p>
          <p class="tight">
            {#if repository.localOnly}
              {t('repositories:lc.untilLocalOnly')}
            {:else}
              {t('repositories:lc.untilGithub')}
            {/if}
          </p>
        </Alert>
      {/if}

      <dl class="facts">
        <div>
          <dt>{t('repositories:lc.folder')}</dt>
          <dd><code>{local.path}</code></dd>
        </div>
        <div>
          <dt>{t('repositories:lc.branchRead')}</dt>
          <dd><code>{local.branch}</code></dd>
        </div>
        <div>
          <dt>{t('repositories:lc.state')}</dt>
          <dd>{#if info}<Badge tone={info.tone} dot>{info.label}</Badge>{/if}</dd>
        </div>
        <div>
          <dt>{t('repositories:lc.lastRead')}</dt>
          <dd>
            {#if local.lastReadAt}
              <code>{shortSha(local.headSha)}</code>
              <time datetime={new Date(local.lastReadAt).toISOString()} title={formatDateTime(local.lastReadAt)}>{formatRelativeTime(local.lastReadAt)}</time>
            {:else}
              <span class="muted">{t('repositories:lc.notRead')}</span>
            {/if}
          </dd>
        </div>
      </dl>

      {#if info && !info.ok && local.statusMessage}
        <Alert tone={info.tone === 'bad' ? 'error' : 'warn'}>{local.statusMessage}</Alert>
      {/if}

      <p class="summary">
        <Icon name="git-branch" />
        <span>
          {#if live}
            {localReadSummary({ branch: local.branch, sha: live.branchSha, checkedOutBranch: live.checkedOutBranch, dirtyCount: live.dirtyCount })}
          {:else}
            {localReadSummary({ branch: local.branch, sha: local.headSha })}
          {/if}
        </span>
      </p>

      {#if liveError}<Alert tone="error">{liveError}</Alert>{/if}

      {#if repository.localOnly}
        {@const notice = localOnlyNotice(config?.write ?? null)}
        <Alert tone="info" title={notice.title}>{notice.text}</Alert>
      {/if}

      {#if canWrite}
        <div class="row wrap">
          <Button icon="refresh" loading={liveBusy} disabled={!enabled} onclick={checkNow}>{liveBusy ? t('repositories:lc.checking') : t('repositories:lc.checkNow')}</Button>
          <Button icon="git-branch" disabled={!enabled} onclick={openBranch}>{t('repositories:lc.changeBranch')}</Button>
          {#if !repository.localOnly}
            <Button icon="edit" disabled={!enabled} onclick={() => (attachOpen = true)}>{t('repositories:lc.changeFolder')}</Button>
            <Button variant="danger" onclick={() => (detachOpen = true)}>{t('repositories:lc.detach')}</Button>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="stack">
      <p class="tight">{t('repositories:lc.noneAttached')}</p>
      {#if canWrite}
        {#if config && !config.enabled}
          {@const notice = localDisabledNotice(config)}
          <Alert tone="info" title={notice.title}>
            <p class="tight">{notice.body}</p>
          </Alert>
        {/if}
        <div>
          <Button icon="plus" disabled={!enabled} onclick={() => (attachOpen = true)}>{t('repositories:lc.attach')}</Button>
        </div>
      {/if}
    </div>
  {/if}
</Card>

<Modal
  bind:open={attachOpen}
  size="lg"
  title={local ? t('repositories:lc.modalChange') : t('repositories:lc.modalAttach')}
  description={t('repositories:lc.modalDescription')}
>
  {#if attachOpen}
    <LocalCheckoutConnect
      {api}
      {workspaceId}
      {config}
      repositories={[repository]}
      fixedRepository={repository}
      ondone={attached}
      oncancel={() => (attachOpen = false)}
    />
  {/if}
</Modal>

<Modal bind:open={branchOpen} size="sm" title={t('repositories:lc.branchTitle')} dismissible={!branchSaving}>
  <div class="stack">
    {#if branchError}<Alert tone="error">{branchError}</Alert>{/if}
    <div class="field">
      <label for="{uid}-branch">{t('repositories:lc.branchLabel')}</label>
      <select id="{uid}-branch" bind:value={branchValue} disabled={branchLoading || branchSaving}>
        {#if branchLoading}
          <option value={branchValue}>{t('repositories:lc.loading')}</option>
        {:else}
          {#each branches.includes(branchValue) ? branches : [branchValue, ...branches] as name (name)}
            <option value={name}>{name}</option>
          {/each}
        {/if}
      </select>
      <p class="hint">{t('repositories:lc.branchHint')}</p>
    </div>
  </div>
  {#snippet footer()}
    <Button disabled={branchSaving} onclick={() => (branchOpen = false)}>{t('repositories:action.cancel')}</Button>
    <Button variant="primary" loading={branchSaving} disabled={branchLoading || branchValue === local?.branch} onclick={saveBranch}>{t('repositories:lc.useBranch')}</Button>
  {/snippet}
</Modal>

<Modal bind:open={detachOpen} size="sm" title={t('repositories:lc.detachTitle')} dismissible={!detaching}>
  <div class="stack">
    <p class="tight">
      <T key="repositories:lc.detachBody" params={{ name: repository.name, path: local?.path }} />
    </p>
    {#if detachError}<Alert tone="error">{detachError}</Alert>{/if}
  </div>
  {#snippet footer()}
    <Button disabled={detaching} onclick={() => (detachOpen = false)}>{t('repositories:action.cancel')}</Button>
    <Button variant="danger-solid" loading={detaching} onclick={detach}>{t('repositories:lc.detach')}</Button>
  {/snippet}
</Modal>

<style>
  .tight {
    margin: 0;
  }

  .tight + .tight {
    margin-top: var(--space-1);
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-8);
    margin: 0;
  }

  .facts > div {
    min-width: 0;
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
</style>
