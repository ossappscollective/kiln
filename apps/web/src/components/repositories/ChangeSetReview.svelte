<!--
  ChangeSetReview: one change set: its status, the diff of every changed file, and the actions
  the person's role allows (approve, apply, discard).
  Props: api, workspaceId, id (the change set), role, myId, names (user id to display name),
  onback (back to the list), onchanged (called after any state change, so the list can refresh),
  Fixing up: an applied change set (or a failed one that made its branch) has "Fix up this branch",
  which adds one commit on top of the branch; the fix ups so far are listed.
  localOnly? (the repository is a local folder with no GitHub: Apply can only commit to a branch of
  the folder), hasLocalClone? (a folder is attached), write? (the server's setting for writing to
  local clones, null while it loads), signing? (whether the server signs those commits, null while it
  loads).
  Nothing is written to the repository except by Apply: a branch and a pull request on GitHub, or a
  commit on a new branch of the local clone (which does not touch its checked out branch). The
  result of a local commit is shown step by step, and a failed push or pull request can be retried.
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { isWebUrl } from '../../lib/credentials.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    type ApplyBody,
    type RetryOption,
    type WriteConfig,
    applyDoneMessage,
    localBranchAvailability,
    retryOptions,
  } from '../../lib/change-set-apply.ts';
  import {
    actorLabel,
    approverLabel,
    changeSetActions,
    changeSetStatusInfo,
    diffLines,
    diffStats,
    fileChangeLabel,
    fileChangeTone,
    filesChangedLabel,
    prLabel,
  } from '../../lib/repositories.ts';
  import { type FixupResult, type RecomputeResult, canFixup, fixupCount, fixupPromise } from '../../lib/change-set-fixup.ts';
  import { type RefreshResult, canRefresh } from '../../lib/change-set-refresh.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ChangeSetView, LocalSigningConfig } from '../../lib/types.ts';
  import ExternalLink from '../credentials/ExternalLink.svelte';
  import ApplyDialog from './ApplyDialog.svelte';
  import ChangeSetStale from './ChangeSetStale.svelte';
  import FixupDialog from './FixupDialog.svelte';
  import LocalOutcomeCard from './LocalOutcomeCard.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import DiffView from './DiffView.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { usePoll } from '../../lib/app-state/clock.svelte.ts';

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
    hasLocalClone = false,
    write = null,
    signing = null,
  }: {
    api: Api;
    workspaceId: string;
    id: string;
    role: Role;
    myId: string;
    names: Record<string, string>;
    onback: () => void;
    onchanged: () => void;
    localOnly?: boolean | undefined;
    hasLocalClone?: boolean | undefined;
    write?: WriteConfig | undefined;
    signing?: LocalSigningConfig | null | undefined;
  } = $props();

  let changeSet = $state<ChangeSetView | null>(null);
  let loadError = $state('');
  let busy = $state<'' | 'approve' | 'apply' | 'discard'>('');
  /** The retry that is running (push, push_pr or pr), or ''. */
  let retrying = $state<'' | RetryOption['id']>('');
  let actionError = $state('');
  /** The error code of the last apply on this page, so a stale change set is told apart from other failures. */
  let applyCode = $state<string | null>(null);
  let applyOpen = $state(false);
  let fixupOpen = $state(false);
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
          fresh.status === 'applied'
            ? t('repositories:review.prOpenedToast')
            : t('repositories:review.finishedToast'),
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
      if (!silent) loadError = e instanceof ApiError ? e.message : t('repositories:review.loadFailed');
    }
  }

  $effect(() => {
    void id;
    void workspaceId;
    actionError = '';
    void load();
  });

  // Another apply may be running (a second tab, a colleague). Look again until it ends.
  usePoll(() => void load(true), 4000, { while: () => changeSet?.status === 'applying' });

  const applyContext = $derived({ localOnly, hasLocalClone: hasLocalClone || localOnly, write, signing });
  const actions = $derived(
    changeSet
      ? changeSetActions({ role, status: changeSet.status, createdBy: changeSet.createdBy, myId })
      : { approve: false, apply: false, discard: false },
  );
  const retries = $derived(changeSet ? retryOptions(changeSet, applyContext, role) : []);
  const mayFixup = $derived(changeSet ? canFixup(role, changeSet) : false);
  const fixups = $derived(changeSet?.fixups ?? []);
  const localApplyReason = $derived(localBranchAvailability(applyContext).reason);
  const anyAction = $derived(actions.approve || actions.apply || actions.discard);
  const files = $derived(
    (changeSet?.files ?? []).map((file) => ({ file, stats: diffStats(diffLines(file.before, file.after)) })),
  );

  async function run(kind: 'approve' | 'apply' | 'discard', body?: ApplyBody) {
    if (!changeSet || busy || retrying) return;
    busy = kind;
    actionError = '';
    if (kind === 'apply') applyCode = null;
    try {
      if (kind === 'approve') {
        changeSet = (await api.approveChangeSet(workspaceId, id)).changeSet;
        toast.success(t('repositories:review.approvedToast'));
      } else if (kind === 'apply') {
        const result = await api.applyChangeSet(workspaceId, id, body);
        changeSet = result.changeSet;
        const message = applyDoneMessage(result.changeSet, result.alreadyApplied);
        const outcome = result.changeSet.outcome;
        if (outcome && (outcome.push.status === 'failed' || outcome.pr.status === 'failed')) toast.error(message);
        else toast.success(message);
      } else {
        changeSet = (await api.discardChangeSet(workspaceId, id)).changeSet;
        toast.success(t('repositories:review.discardedToast'));
      }
      onchanged();
    } catch (e) {
      actionError = e instanceof ApiError ? e.message : t('repositories:review.actionFailed');
      if (kind === 'apply' && e instanceof ApiError) applyCode = e.code ?? null;
      // A failed apply changes the status on the server, so look again.
      await load(true);
      onchanged();
    } finally {
      busy = '';
    }
  }

  function confirmApply(body: ApplyBody | undefined) {
    applyOpen = false;
    void run('apply', body);
  }

  /** Pushes the branch of a local commit, or opens its pull request: only the step that is left runs. */
  async function retry(option: RetryOption) {
    if (!changeSet || busy || retrying) return;
    retrying = option.id;
    actionError = '';
    try {
      const result = await api.pushChangeSet(workspaceId, id, { openPr: option.openPr });
      changeSet = result.changeSet;
      toast.success(
        result.alreadyDone
          ? t('repositories:review.nothingLeftToast')
          : option.openPr
            ? t('repositories:review.pushedPrToast')
            : t('repositories:review.pushedToast'),
      );
      onchanged();
    } catch (e) {
      actionError = e instanceof ApiError ? e.message : t('repositories:review.actionFailed');
      // The step that failed is recorded on the change set, so look again.
      await load(true);
      onchanged();
    } finally {
      retrying = '';
    }
  }

  /** A refresh answered: show the new change set (a draft again when its text changed). */
  function refreshed(result: RefreshResult) {
    changeSet = result.changeSet;
    applyCode = null;
    actionError = '';
    onchanged();
  }

  /** A fix up added a commit (or finished a step): show the change set as it is now. */
  function fixedUp(result: FixupResult) {
    changeSet = result.changeSet;
    applyCode = null;
    actionError = '';
    onchanged();
  }

  /** A recompute answered: show the new change set (a draft again when its text changed). */
  function recomputed(result: RecomputeResult) {
    changeSet = result.changeSet;
    applyCode = null;
    actionError = '';
    onchanged();
  }

  function confirmDiscard() {
    discardOpen = false;
    void run('discard');
  }
</script>

{#snippet when(at: number)}
  <time datetime={new Date(at).toISOString()} title={formatDateTime(at)}>{formatRelativeTime(at)}</time>
{/snippet}

{#snippet createdTime(text: string)}
  {#if changeSet}<time datetime={new Date(changeSet.createdAt).toISOString()} title={formatDateTime(changeSet.createdAt)}>{text}</time>{:else}{text}{/if}
{/snippet}

{#snippet approvedTime(text: string)}
  {#if changeSet?.approvedAt}<time datetime={new Date(changeSet.approvedAt).toISOString()} title={formatDateTime(changeSet.approvedAt)}>{text}</time>{:else}{text}{/if}
{/snippet}

{#snippet prLink(text: string)}
  {#if changeSet?.prUrl}<ExternalLink href={changeSet.prUrl} label={text} />{:else}{text}{/if}
{/snippet}

<div class="stack loose">
  <div>
    <Button variant="ghost" icon="chevron-left" onclick={onback}>{t('repositories:review.back')}</Button>
  </div>

  {#if loadError}
    <div class="stack">
      <Alert tone="error">{loadError}</Alert>
      <div class="row">
        <Button icon="refresh" onclick={() => load()}>{t('common:action.tryAgain')}</Button>
      </div>
    </div>
  {:else if changeSet === null}
    <div class="card" role="status" aria-label={t('repositories:review.loadingAria')}>
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
          <dt>{t('repositories:review.created')}</dt>
          <dd><T key="repositories:review.createdBy" params={{ actor: actorLabel(changeSet.createdBy, myId, names), ago: formatRelativeTime(changeSet.createdAt) }} tags={{ link: createdTime }} /></dd>
        </div>
        {#if changeSet.approvedBy && changeSet.approvedAt}
          <div>
            <dt>{t('repositories:review.approved')}</dt>
            <dd><T key="repositories:review.createdBy" params={{ actor: approverLabel(changeSet.approvedBy, myId, names), ago: formatRelativeTime(changeSet.approvedAt) }} tags={{ link: approvedTime }} /></dd>
          </div>
        {/if}
        {#if changeSet.appliedAt}
          <div>
            <dt>{t('repositories:review.applied')}</dt>
            <dd>{@render when(changeSet.appliedAt)}</dd>
          </div>
        {/if}
        <div>
          <dt>{t('repositories:review.files')}</dt>
          <dd>{filesChangedLabel(changeSet.filesChanged)}</dd>
        </div>
        {#if changeSet.branch}
          <div>
            <dt>{t('repositories:review.branch')}</dt>
            <dd><code>{changeSet.branch}</code></dd>
          </div>
        {/if}
        {#if changeSet.commitSha}
          <div>
            <dt>{t('repositories:review.commit')}</dt>
            <dd><code>{changeSet.commitSha.slice(0, 7)}</code></dd>
          </div>
        {/if}
      </dl>

      {#if changeSet.status === 'applying'}
        <div class="gap">
          <Alert tone="info" title={t('repositories:review.applyingTitle')}>
            {t('repositories:review.applyingBody')}
          </Alert>
        </div>
      {/if}

      {#if changeSet.status === 'applied' && changeSet.outcome}
        <div class="gap">
          <LocalOutcomeCard
            {changeSet}
            options={retries}
            busy={retrying}
            onretry={retry}
            onfixup={mayFixup ? () => (fixupOpen = true) : undefined}
          />
        </div>
      {:else if changeSet.status === 'applied'}
        <div class="gap">
          <Alert tone="ok" title={t('repositories:review.prOpenTitle')}>
            {#if changeSet.prUrl && isWebUrl(changeSet.prUrl)}
              <T key="repositories:review.prOpenLink" params={{ label: prLabel(changeSet) }} tags={{ link: prLink }} />
            {:else if changeSet.commitSha}
              <T key="repositories:review.committedAs" params={{ sha: changeSet.commitSha.slice(0, 7) }} />
            {:else}
              {t('repositories:review.reviewMerge')}
            {/if}
            {#if fixupCount(changeSet) > 0}
              {t('repositories:review.fixupsAdded', { count: fixupCount(changeSet) })}
            {/if}
          </Alert>
          {#if mayFixup}
            <div class="row gap">
              <Button icon="git-branch" onclick={() => (fixupOpen = true)}>{t('repositories:review.fixUp')}</Button>
              <span class="muted small">{fixupPromise(changeSet.branch ?? '')}</span>
            </div>
          {/if}
        </div>
      {/if}

      {#if fixups.length > 0}
        <div class="gap">
          <p class="small"><T key="repositories:review.fixupsTitle" /></p>
          <ul class="fixups small">
            {#each fixups as fix (fix.commit)}
              <li>
                {#snippet fixTime(text: string)}
                  <time datetime={new Date(fix.at).toISOString()} title={formatDateTime(fix.at)}>{text}</time>
                {/snippet}
                <code>{fix.commit.slice(0, 7)}</code>
                {#if fix.pushed}
                  <T key="repositories:review.fixupPushed" params={{ count: fix.files, ago: formatRelativeTime(fix.at) }} tags={{ link: fixTime }} />
                {:else}
                  <T key="repositories:review.fixupLocal" params={{ count: fix.files, ago: formatRelativeTime(fix.at) }} tags={{ link: fixTime }} />
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if changeSet.status === 'failed'}
        <div class="gap">
          <Alert tone="error" title={t('repositories:review.failedTitle')}>
            {changeSet.error ?? t('repositories:review.githubRefused')}
            {#if changeSet.branch}
              <T key="repositories:review.failedBranch" params={{ branch: changeSet.branch }} />
            {/if}
            {#if mayFixup}
              {t('repositories:review.failedFixup')}
            {:else if canRefresh(role, changeSet)}
              {t('repositories:review.failedRefresh')}
            {:else}
              {t('repositories:review.failedDiscard')}
            {/if}
          </Alert>
          {#if mayFixup}
            <div class="row gap">
              <Button variant="primary" icon="git-branch" onclick={() => (fixupOpen = true)}>{t('repositories:review.fixUp')}</Button>
            </div>
          {/if}
        </div>
      {/if}

      <div class="gap">
        <ChangeSetStale
          {api}
          {workspaceId}
          {changeSet}
          {role}
          {applyCode}
          onrefreshed={refreshed}
          onrecomputed={recomputed}
          ondiscard={() => void run('discard')}
        />
      </div>

      {#if actionError && changeSet.status !== 'failed'}
        <div class="gap"><Alert tone="error">{actionError}</Alert></div>
      {/if}

      {#if localOnly && changeSet.status === 'approved' && localApplyReason}
        <div class="gap"><Alert tone="info" title={t('repositories:review.localBlockedTitle')}>{localApplyReason}</Alert></div>
      {/if}

      {#if anyAction}
        <div class="row actions gap">
          {#if actions.discard}
            <Button variant="danger" disabled={busy !== ''} loading={busy === 'discard'} onclick={() => (discardOpen = true)}>{t('repositories:review.discard')}</Button>
          {/if}
          <span class="spacer"></span>
          {#if actions.approve}
            <Button variant="primary" icon="check" loading={busy === 'approve'} disabled={busy !== ''} onclick={() => run('approve')}>
              {busy === 'approve' ? t('repositories:review.approving') : t('repositories:review.approve')}
            </Button>
          {/if}
          {#if actions.apply}
            <Button variant="primary" icon={localOnly ? 'git-branch' : 'git-pull-request'} loading={busy === 'apply'} disabled={busy !== ''} onclick={() => (applyOpen = true)}>
              {busy === 'apply' ? t('repositories:review.applying') : t('repositories:review.apply')}
            </Button>
          {/if}
        </div>
      {:else if changeSet.status === 'draft' || changeSet.status === 'approved'}
        <p class="hint gap">{changeSet.status === 'draft' ? t('repositories:review.onlyAdminApprove') : t('repositories:review.onlyAdminApply')}</p>
      {/if}
    </section>

    <section class="stack" aria-labelledby="cs-files">
      <h3 id="cs-files">{t('repositories:review.changedFiles', { count: changeSet.files.length })}</h3>
      {#if changeSet.files.length === 0}
        <p class="muted">{t('repositories:review.noFiles')}</p>
      {/if}
      {#each files as { file, stats } (file.path)}
        <details class="file card flush" open={files.length <= 5}>
          <summary>
            <span class="path"><code>{file.path}</code></span>
            <Badge tone={fileChangeTone[file.change]}>{fileChangeLabel(file.change)}</Badge>
            <span class="stats tabular">
              <span class="added"><span aria-hidden="true">+</span><span class="visually-hidden">{t('repositories:review.addedLines')} </span>{stats.added}</span>
              <span class="removed"><span aria-hidden="true">-</span><span class="visually-hidden">{t('repositories:review.removedLines')} </span>{stats.removed}</span>
            </span>
          </summary>
          <DiffView before={file.before} after={file.after} path={file.path} />
        </details>
      {/each}
    </section>
  {/if}
</div>

<ApplyDialog bind:open={applyOpen} {changeSet} context={applyContext} busy={busy === 'apply'} onconfirm={confirmApply} />
<FixupDialog {api} {workspaceId} {changeSet} {role} bind:open={fixupOpen} onfixed={fixedUp} onchanged={() => void load(true)} />

<Modal bind:open={discardOpen} size="sm" title={t('repositories:review.discardTitle')}>
  <p><T key="repositories:review.discardBody" params={{ summary: changeSet?.summary }} /></p>
  {#snippet footer()}
    <Button onclick={() => (discardOpen = false)}>{t('repositories:review.keep')}</Button>
    <Button variant="danger-solid" onclick={confirmDiscard}>{t('repositories:review.discardConfirm')}</Button>
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

  .fixups {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-5);
    display: grid;
    gap: var(--space-1);
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
