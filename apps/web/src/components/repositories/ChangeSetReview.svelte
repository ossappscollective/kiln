<!--
  ChangeSetReview: one change set: its status, the diff of every changed file, and the actions
  the person's role allows (approve, apply, discard).
  Props: api, workspaceId, id (the change set), role, myId, names (user id to display name),
  onback (back to the list), onchanged (called after any state change, so the list can refresh),
  localOnly? (the repository is a local folder with no GitHub: Apply is not offered, and an
  approved change set says so).
  Nothing is written to the repository except by Apply, which opens a branch and a pull request.
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { isWebUrl } from '../../lib/credentials.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    actorLabel,
    approverLabel,
    changeSetActions,
    LOCAL_ONLY_APPLY_NOTICE,
    changeSetStatusInfo,
    diffLines,
    diffStats,
    fileChangeLabel,
    fileChangeTone,
    filesChangedLabel,
    prLabel,
  } from '../../lib/repositories.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ChangeSetView } from '../../lib/types.ts';
  import ExternalLink from '../credentials/ExternalLink.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import DiffView from './DiffView.svelte';
  import StatusBadge from './StatusBadge.svelte';

  let {
    api,
    workspaceId,
    id,
    role,
    myId,
    names,
    onback,
    onchanged,
    localOnly = false,
  }: {
    api: Api;
    workspaceId: string;
    id: string;
    role: Role;
    myId: string;
    names: Record<string, string>;
    onback: () => void;
    onchanged: () => void;
    localOnly?: boolean;
  } = $props();

  let changeSet = $state<ChangeSetView | null>(null);
  let loadError = $state('');
  let busy = $state<'' | 'approve' | 'apply' | 'discard'>('');
  let actionError = $state('');
  let applyOpen = $state(false);
  let discardOpen = $state(false);
  let titleEl = $state<HTMLElement>();

  async function load(silent = false) {
    if (!silent) {
      loadError = '';
      changeSet = null;
    }
    try {
      const fresh = (await api.changeSet(workspaceId, id)).changeSet;
      if (silent && changeSet && changeSet.status === 'applying' && fresh.status !== 'applying') {
        toast.info(
          fresh.status === 'applied' ? 'The pull request is open.' : 'The change set finished. Check its status.',
        );
        onchanged();
      }
      changeSet = fresh;
      // A new view: start reading at its title.
      if (!silent) {
        await tick();
        titleEl?.focus();
      }
    } catch (e) {
      if (!silent) loadError = e instanceof ApiError ? e.message : 'Could not load the change set.';
    }
  }

  $effect(() => {
    void id;
    void workspaceId;
    actionError = '';
    void load();
  });

  // Another apply may be running (a second tab, a colleague). Look again until it ends.
  $effect(() => {
    if (changeSet?.status !== 'applying') return;
    const timer = setInterval(() => void load(true), 4000);
    return () => clearInterval(timer);
  });

  const actions = $derived(
    changeSet
      ? changeSetActions({ role, status: changeSet.status, createdBy: changeSet.createdBy, myId, localOnly })
      : { approve: false, apply: false, discard: false },
  );
  const anyAction = $derived(actions.approve || actions.apply || actions.discard);
  const files = $derived(
    (changeSet?.files ?? []).map((file) => ({ file, stats: diffStats(diffLines(file.before, file.after)) })),
  );

  async function run(kind: 'approve' | 'apply' | 'discard') {
    if (!changeSet || busy) return;
    busy = kind;
    actionError = '';
    try {
      if (kind === 'approve') {
        changeSet = (await api.approveChangeSet(workspaceId, id)).changeSet;
        toast.success('Approved. It can now be applied as a pull request.');
      } else if (kind === 'apply') {
        const result = await api.applyChangeSet(workspaceId, id);
        changeSet = result.changeSet;
        toast.success(result.alreadyApplied ? 'This change set was already applied.' : 'Pull request opened.');
      } else {
        changeSet = (await api.discardChangeSet(workspaceId, id)).changeSet;
        toast.success('Change set discarded. The repository was not changed.');
      }
      onchanged();
    } catch (e) {
      actionError = e instanceof ApiError ? e.message : 'That did not work. Try again.';
      // A failed apply changes the status on the server, so look again.
      await load(true);
      onchanged();
    } finally {
      busy = '';
    }
  }

  function confirmApply() {
    applyOpen = false;
    void run('apply');
  }

  function confirmDiscard() {
    discardOpen = false;
    void run('discard');
  }
</script>

{#snippet when(at: number)}
  <time datetime={new Date(at).toISOString()} title={fullTime(at)}>{timeAgo(at)}</time>
{/snippet}

<div class="stack loose">
  <div>
    <Button variant="ghost" icon="chevron-left" onclick={onback}>All change sets</Button>
  </div>

  {#if loadError}
    <div class="stack">
      <Alert tone="error">{loadError}</Alert>
      <div class="row">
        <Button icon="refresh" onclick={() => load()}>Try again</Button>
      </div>
    </div>
  {:else if changeSet === null}
    <div class="card" role="status" aria-label="Loading the change set">
      <div class="stack">
        <Skeleton width="50%" height="20px" />
        <Skeleton width="30%" height="14px" />
        <Skeleton height="120px" />
      </div>
    </div>
  {:else}
    {@const info = changeSetStatusInfo(changeSet.status)}
    <section class="card" aria-labelledby="cs-title">
      <div class="card-header">
        <div>
          <h3 id="cs-title" tabindex="-1" bind:this={titleEl}>{changeSet.summary}</h3>
          <p>{info.description}</p>
        </div>
        <StatusBadge status={changeSet.status} />
      </div>

      <dl class="facts">
        <div>
          <dt>Created</dt>
          <dd>{actorLabel(changeSet.createdBy, myId, names)}, {@render when(changeSet.createdAt)}</dd>
        </div>
        {#if changeSet.approvedBy && changeSet.approvedAt}
          <div>
            <dt>Approved</dt>
            <dd>{approverLabel(changeSet.approvedBy, myId, names)}, {@render when(changeSet.approvedAt)}</dd>
          </div>
        {/if}
        {#if changeSet.appliedAt}
          <div>
            <dt>Applied</dt>
            <dd>{@render when(changeSet.appliedAt)}</dd>
          </div>
        {/if}
        <div>
          <dt>Files</dt>
          <dd>{filesChangedLabel(changeSet.filesChanged)}</dd>
        </div>
        {#if changeSet.branch}
          <div>
            <dt>Branch</dt>
            <dd><code>{changeSet.branch}</code></dd>
          </div>
        {/if}
        {#if changeSet.commitSha}
          <div>
            <dt>Commit</dt>
            <dd><code>{changeSet.commitSha.slice(0, 7)}</code></dd>
          </div>
        {/if}
      </dl>

      {#if changeSet.status === 'applying'}
        <div class="gap">
          <Alert tone="info" title="Applying">
            Creating the branch and the pull request. This page checks again every few seconds.
          </Alert>
        </div>
      {/if}

      {#if changeSet.status === 'applied'}
        <div class="gap">
          <Alert tone="ok" title="The pull request is open">
            {#if changeSet.prUrl && isWebUrl(changeSet.prUrl)}
              <ExternalLink href={changeSet.prUrl} label={prLabel(changeSet)} />. Review and merge it in GitHub; nothing was pushed to the default branch.
            {:else if changeSet.commitSha}
              The change was committed as <code>{changeSet.commitSha.slice(0, 7)}</code>.
            {:else}
              Review and merge it in GitHub.
            {/if}
          </Alert>
        </div>
      {/if}

      {#if changeSet.status === 'failed'}
        <div class="gap">
          <Alert tone="error" title="The change was not applied">
            {changeSet.error ?? 'GitHub refused the change.'}
            {#if changeSet.branch}
              A branch named <code>{changeSet.branch}</code> was created before the failure; delete it in GitHub if you do not need it.
            {/if}
            Discard this change set and create a new one from the current listing.
          </Alert>
        </div>
      {/if}

      {#if actionError && changeSet.status !== 'failed'}
        <div class="gap"><Alert tone="error">{actionError}</Alert></div>
      {/if}

      {#if localOnly && changeSet.status === 'approved'}
        <div class="gap"><Alert tone="info" title="This change set cannot be applied yet">{LOCAL_ONLY_APPLY_NOTICE}</Alert></div>
      {/if}

      {#if anyAction}
        <div class="row actions gap">
          {#if actions.discard}
            <Button variant="danger" disabled={busy !== ''} loading={busy === 'discard'} onclick={() => (discardOpen = true)}>Discard</Button>
          {/if}
          <span class="spacer"></span>
          {#if actions.approve}
            <Button variant="primary" icon="check" loading={busy === 'approve'} disabled={busy !== ''} onclick={() => run('approve')}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
          {/if}
          {#if actions.apply}
            <Button variant="primary" icon="git-pull-request" loading={busy === 'apply'} disabled={busy !== ''} onclick={() => (applyOpen = true)}>
              {busy === 'apply' ? 'Applying…' : 'Apply as pull request'}
            </Button>
          {/if}
        </div>
      {:else if changeSet.status === 'draft' || changeSet.status === 'approved'}
        <p class="hint gap">Only an admin or owner can {changeSet.status === 'draft' ? 'approve' : 'apply'} a change set.</p>
      {/if}
    </section>

    <section class="stack" aria-labelledby="cs-files">
      <h3 id="cs-files">Changed files ({changeSet.files.length})</h3>
      {#if changeSet.files.length === 0}
        <p class="muted">This change set has no files.</p>
      {/if}
      {#each files as { file, stats } (file.path)}
        <details class="file card flush" open={files.length <= 5}>
          <summary>
            <span class="path"><code>{file.path}</code></span>
            <Badge tone={fileChangeTone[file.change]}>{fileChangeLabel[file.change]}</Badge>
            <span class="stats tabular">
              <span class="added"><span aria-hidden="true">+</span><span class="visually-hidden">Added lines: </span>{stats.added}</span>
              <span class="removed"><span aria-hidden="true">-</span><span class="visually-hidden">Removed lines: </span>{stats.removed}</span>
            </span>
          </summary>
          <DiffView before={file.before} after={file.after} path={file.path} />
        </details>
      {/each}
    </section>
  {/if}
</div>

<Modal bind:open={applyOpen} size="sm" title="Apply this change set?">
  <p>
    This creates a new branch in the repository, commits {changeSet ? filesChangedLabel(changeSet.filesChanged) : 'the files'}
    and opens a pull request. Nothing is pushed to the default branch, and nothing reaches the stores until you merge and release.
  </p>
  {#snippet footer()}
    <Button onclick={() => (applyOpen = false)}>Cancel</Button>
    <Button variant="primary" onclick={confirmApply}>Apply and open pull request</Button>
  {/snippet}
</Modal>

<Modal bind:open={discardOpen} size="sm" title="Discard this change set?">
  <p>
    <strong>{changeSet?.summary}</strong> will be closed without changing the repository. This cannot be undone; you can make a new
    change set from the listing.
  </p>
  {#snippet footer()}
    <Button onclick={() => (discardOpen = false)}>Keep it</Button>
    <Button variant="danger-solid" onclick={confirmDiscard}>Discard change set</Button>
  {/snippet}
</Modal>

<style>
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-8);
    margin: 0;
  }

  dt {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  dd {
    margin: var(--space-1) 0 0;
  }

  .gap {
    margin-top: var(--space-4);
  }

  h3:focus {
    outline: none;
  }

  .actions {
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }

  .file summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    cursor: pointer;
    background: var(--surface-sunken);
  }

  .file summary:hover {
    background: var(--surface-hover);
  }

  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .stats {
    display: flex;
    gap: var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .added {
    color: var(--ok-ink);
  }

  .removed {
    color: var(--bad-ink);
  }
</style>
