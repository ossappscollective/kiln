<!--
  RepositoryList: the connected repositories as a table.
  Props: repositories, canWrite (shows Disconnect), busyId (the repository being changed),
  onopen (called with a repository), ondisconnect (called after the person confirms).
-->
<script lang="ts">
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { githubUrl, repositoryName } from '../../lib/repositories.ts';
  import { storeById } from '../../lib/stores.ts';
  import type { RepositorySummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';
  import KindBadge from './KindBadge.svelte';

  let {
    repositories,
    canWrite,
    busyId,
    onopen,
    ondisconnect,
  }: {
    repositories: RepositorySummary[];
    canWrite: boolean;
    busyId: string;
    onopen: (repository: RepositorySummary) => void;
    ondisconnect: (repository: RepositorySummary) => void;
  } = $props();

  let confirming = $state<RepositorySummary | null>(null);
  let open = $state(false);

  function ask(repository: RepositorySummary) {
    confirming = repository;
    open = true;
  }

  function confirm() {
    const repository = confirming;
    open = false;
    if (repository) ondisconnect(repository);
  }
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">{t('repositories:list.caption')}</caption>
    <thead>
      <tr>
        <th scope="col">{t('repositories:list.repository')}</th>
        <th scope="col">{t('repositories:list.branch')}</th>
        <th scope="col">{t('repositories:list.projectType')}</th>
        <th scope="col">{t('repositories:list.lastScan')}</th>
        <th scope="col"><span class="visually-hidden">{t('repositories:list.actions')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each repositories as repository (repository.id)}
        <tr>
          <td>
            <div class="name">
              <Icon name={repository.localOnly ? 'folder' : storeById('github').icon} />
              <button
                type="button"
                id="repo-open-{repository.id}"
                class="link name-button"
                aria-label={t('repositories:list.openAria', { name: repositoryName(repository) })}
                onclick={() => onopen(repository)}
              >
                {repositoryName(repository)}
              </button>
              {#if repository.localOnly}
                <Badge tone="info">{t('repositories:list.localOnly')}</Badge>
              {:else if repository.local}
                <Badge>{t('repositories:list.localClone')}</Badge>
              {/if}
            </div>
            {#if repository.local}
              <p class="path muted"><code>{repository.local.path}</code></p>
            {/if}
          </td>
          <td><code>{repository.local ? repository.local.branch : repository.defaultBranch}</code></td>
          <td><KindBadge kind={repository.projectKind} /></td>
          <td class="muted">
            {#if repository.detectedAt}
              <time datetime={new Date(repository.detectedAt).toISOString()} title={formatDateTime(repository.detectedAt)}>{formatRelativeTime(repository.detectedAt)}</time>
            {:else}
              {t('repositories:list.never')}
            {/if}
          </td>
          <td class="actions">
            <div class="row end">
              {#if !repository.localOnly}
                <Button
                  size="sm"
                  href={githubUrl(repository.owner, repository.repo)}
                  target="_blank"
                  icon="external-link"
                  label={t('repositories:list.githubAria', { name: repositoryName(repository) })}>{t('repositories:list.github')}</Button
                >
              {/if}
              {#if canWrite}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busyId === repository.id}
                  label={t('repositories:list.disconnectAria', { name: repositoryName(repository) })}
                  onclick={() => ask(repository)}>{t('repositories:action.disconnect')}</Button
                >
              {/if}
            </div>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open size="sm" title={t('repositories:list.confirmTitle')} onclose={() => (confirming = null)}>
  {#if confirming}
    <p>
      {#if confirming.localOnly}
        <T key="repositories:list.confirmLocalOnly" params={{ name: repositoryName(confirming), path: confirming.local?.path }} />
      {:else if confirming.local}
        <T key="repositories:list.confirmGithubLocal" params={{ name: repositoryName(confirming) }} />
      {:else}
        <T key="repositories:list.confirmGithub" params={{ name: repositoryName(confirming) }} />
      {/if}
    </p>
    <p class="muted">{t('repositories:list.confirmBlocked')}</p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('repositories:action.cancel')}</Button>
    <Button variant="danger-solid" onclick={confirm}>{t('repositories:action.disconnect')}</Button>
  {/snippet}
</Modal>

<style>
  .name {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    color: var(--muted);
  }

  .name-button {
    font-weight: var(--weight-medium);
    text-align: left;
  }

  .path {
    margin: var(--space-1) 0 0;
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .row.end {
    justify-content: flex-end;
  }
</style>
