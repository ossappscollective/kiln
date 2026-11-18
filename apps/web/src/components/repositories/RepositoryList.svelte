<!--
  RepositoryList: the connected repositories as a table.
  Props: repositories, canWrite (shows Disconnect), busyId (the repository being changed),
  onopen (called with a repository), ondisconnect (called after the person confirms).
-->
<script lang="ts">
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { githubUrl, repositoryName } from '../../lib/repositories.ts';
  import { storeById } from '../../lib/stores.ts';
  import type { RepositorySummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
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
    <caption class="visually-hidden">Connected repositories</caption>
    <thead>
      <tr>
        <th scope="col">Repository</th>
        <th scope="col">Branch</th>
        <th scope="col">Project type</th>
        <th scope="col">Last scan</th>
        <th scope="col"><span class="visually-hidden">Actions</span></th>
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
                aria-label="Open {repositoryName(repository)}"
                onclick={() => onopen(repository)}
              >
                {repositoryName(repository)}
              </button>
              {#if repository.localOnly}
                <Badge tone="info">Local only</Badge>
              {:else if repository.local}
                <Badge>Local clone</Badge>
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
              <time datetime={new Date(repository.detectedAt).toISOString()} title={fullTime(repository.detectedAt)}>{timeAgo(repository.detectedAt)}</time>
            {:else}
              Never
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
                  label="{repositoryName(repository)} on GitHub (opens in a new tab)">GitHub</Button
                >
              {/if}
              {#if canWrite}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busyId === repository.id}
                  label="Disconnect {repositoryName(repository)}"
                  onclick={() => ask(repository)}>Disconnect</Button
                >
              {/if}
            </div>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open size="sm" title="Disconnect this repository?" onclose={() => (confirming = null)}>
  {#if confirming}
    <p>
      <strong>{repositoryName(confirming)}</strong> will be removed from this workspace, together with its finished change
      sets.
      {#if confirming.localOnly}
        The folder <code>{confirming.local?.path}</code> is not changed or deleted.
      {:else}
        The repository on GitHub{confirming.local ? ' and the local folder are' : ' is'} not changed.
      {/if}
    </p>
    <p class="muted">A repository with a draft, approved or applying change set cannot be disconnected.</p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger-solid" onclick={confirm}>Disconnect</Button>
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
