<!--
  FixupDialog: adds ONE commit on top of the branch of a change set that was applied (or failed after
  its branch was made), so the branch is brought up to date with the repository, and with the live
  store listing for a store pull. It never rewrites history and never forces anything.
  Props: api, workspaceId, changeSet, role, open (bindable), onfixed (called with the server's answer
  once a commit or a step was done), onchanged (called after a failed attempt that may have changed the
  change set, so the page can look again).
  Steps. 1. Confirm: the promise, and in a local clone the push and pull request options. "Check" asks
  the server for a dry run: nothing is written. 2. If files conflict (with the repository, or with
  edits made on the branch) the texts are shown and the person chooses per file. 3. The preview, per
  file. 4. "Add the commit". Every refusal has its own words (the branch moved, is checked out, the
  pull request is closed, the remote has other commits, ...).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type FixupFile,
    type FixupResult,
    allFixupChosen,
    behindNote,
    canFixupFromStore,
    fixupBody,
    fixupChoiceInfo,
    fixupConflictsFrom,
    fixupDoneMessage,
    fixupPending,
    fixupPreviewMessage,
    fixupPromise,
    fixupStateLabel,
    isLocalCommit,
    outcomeLabel,
    outcomeTone,
    stageLabel,
  } from '../../lib/change-set-fixup.ts';
  import { type Resolution, conflictReasonText } from '../../lib/change-set-refresh.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ChangeSetView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';

  let {
    api,
    workspaceId,
    changeSet,
    role,
    open = $bindable(false),
    onfixed,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    changeSet: ChangeSetView | null;
    role: Role;
    open?: boolean | undefined;
    onfixed: (result: FixupResult) => void;
    onchanged: () => void;
  } = $props();

  const uid = $props.id();
  let phase = $state<'confirm' | 'conflicts' | 'preview' | 'done'>('confirm');
  let busy = $state(false);
  let error = $state('');
  let files = $state<FixupFile[]>([]);
  let repoChoices = $state<Record<string, Resolution | undefined>>({});
  let branchChoices = $state<Record<string, Resolution | undefined>>({});
  let preview = $state<FixupResult | null>(null);
  let result = $state<FixupResult | null>(null);
  let push = $state(false);
  let openPr = $state(false);
  let fromStore = $state(false);

  const local = $derived(changeSet ? isLocalCommit(changeSet) : false);
  const mayStore = $derived(changeSet ? canFixupFromStore(role, changeSet) : false);
  const branch = $derived(changeSet?.branch ?? '');
  const pending = $derived(fixupPending(files));
  const ready = $derived(allFixupChosen(files, repoChoices, branchChoices));
  const hasPr = $derived(changeSet?.prNumber !== null && changeSet?.prNumber !== undefined);

  // A fresh start each time the dialog opens. A branch that was pushed is pushed again by default.
  $effect(() => {
    if (open) {
      phase = 'confirm';
      busy = false;
      error = '';
      files = [];
      repoChoices = {};
      branchChoices = {};
      preview = null;
      result = null;
      const state = changeSet?.outcome?.push.status;
      push = state === 'pushed' || state === 'behind';
      openPr = false;
      fromStore = false;
    }
  });

  const options = $derived({ push, openPr, local, recompute: fromStore });

  async function run(dryRun: boolean) {
    if (!changeSet || busy) return;
    busy = true;
    error = '';
    try {
      const done = await api.fixupChangeSet(workspaceId, changeSet.id, fixupBody(options, repoChoices, branchChoices, dryRun));
      files = done.files;
      if (dryRun) {
        preview = done;
        phase = 'preview';
      } else {
        result = done;
        phase = 'done';
        toast.success(fixupDoneMessage(done));
        onfixed(done);
      }
    } catch (e) {
      const found = e instanceof ApiError ? fixupConflictsFrom(e.body) : undefined;
      if (found) {
        files = found.files;
        phase = 'conflicts';
        // Keep the choices already made for the files that are still in conflict.
        const keptRepo: Record<string, Resolution | undefined> = {};
        const keptBranch: Record<string, Resolution | undefined> = {};
        for (const f of fixupPending(found.files)) {
          if (f.stage === 'branch') keptBranch[f.path] = branchChoices[f.path];
          else keptRepo[f.path] = repoChoices[f.path];
        }
        repoChoices = keptRepo;
        branchChoices = keptBranch;
      } else {
        error = e instanceof ApiError ? e.message : 'The fix up did not work. Try again.';
        // A step that failed after the commit (the push) is recorded on the change set.
        if (!dryRun) onchanged();
      }
    } finally {
      busy = false;
    }
  }

  function chooseAll(stage: 'repository' | 'branch', choice: Resolution) {
    const all: Record<string, Resolution | undefined> = {};
    for (const f of pending) if ((f.stage ?? 'repository') === stage) all[f.path] = choice;
    if (stage === 'branch') branchChoices = all;
    else repoChoices = all;
  }

  const nothing = $derived(preview?.nothingToFix === true);
</script>

<Modal bind:open size="lg" title="Fix up this branch" dismissible={!busy}>
  <div class="stack">
    {#if phase !== 'done'}
      {#if phase === 'confirm'}
        <p>
          The branch <code>{branch}</code> already exists. A fix up reads the repository again, works out what the branch is missing, and adds
          the difference as a new commit on top of the branch.
        </p>
        <Alert tone="info" title="History is not rewritten">
          {fixupPromise(branch)} Commits and edits that other people made on the branch stay; a change in the same place as yours is shown to
          you and you choose.
        </Alert>
        {#if local}
          <p class="muted small">
            The commit is made in the local clone without touching its checked out branch or working folder. It is signed with the server's
            key when the server signs commits, like the first one. If the branch is checked out in the clone, the fix up is refused.
          </p>
        {:else}
          <p class="muted small">
            The commit is added through the GitHub API as a fast-forward and the pull request follows the branch. If the pull request is closed
            or merged, nothing is written.
          </p>
        {/if}
      {/if}

      {#if phase === 'conflicts'}
        <Alert tone="warn" title="{pending.length === 1 ? 'One file' : `${pending.length} files`} need a choice">
          Nothing has been written. For each file choose to keep your text or the other one. After that, check again.
        </Alert>
        {#each ['repository', 'branch'] as const as stage (stage)}
          {@const group = pending.filter((f) => (f.stage ?? 'repository') === stage)}
          {#if group.length > 1}
            <div class="row">
              <Button size="sm" onclick={() => chooseAll(stage, 'mine')}>Keep mine for all ({stage === 'branch' ? 'branch' : 'repository'})</Button>
              <Button size="sm" onclick={() => chooseAll(stage, 'theirs')}>{fixupChoiceInfo[stage].theirs.label} for all ({stage === 'branch' ? 'branch' : 'repository'})</Button>
            </div>
          {/if}
          {#each group as file (file.path)}
            <fieldset class="conflict stack tight">
              <legend><code>{file.path}</code></legend>
              <p class="muted small">
                {stageLabel[stage]}
                {#if file.reason && stage === 'repository'}{conflictReasonText[file.reason]}{/if}
              </p>
              <div class="texts">
                {#each [{ label: stage === 'branch' ? 'On the branch now' : 'In the repository now (theirs)', text: file.theirs }, { label: stage === 'branch' ? 'What the fix up would write (mine)' : 'Your change (mine)', text: file.ours }] as column (column.label)}
                  <div>
                    <p class="label small">{column.label}</p>
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                    <pre tabindex="0" aria-label="{column.label}, {file.path}">{#if column.text === null || column.text === undefined}<em>The file does not exist.</em>{:else}{column.text}{/if}</pre>
                  </div>
                {/each}
              </div>
              <div class="choices" role="radiogroup" aria-label="What to do with {file.path}">
                {#each ['mine', 'theirs'] as const as option (option)}
                  <label class="check">
                    {#if stage === 'branch'}
                      <input type="radio" name="{uid}-b-{file.path}" value={option} bind:group={branchChoices[file.path]} disabled={busy} />
                    {:else}
                      <input type="radio" name="{uid}-r-{file.path}" value={option} bind:group={repoChoices[file.path]} disabled={busy} />
                    {/if}
                    <span>
                      {fixupChoiceInfo[stage][option].label}
                      <span class="muted small">{fixupChoiceInfo[stage][option].description}</span>
                    </span>
                  </label>
                {/each}
              </div>
            </fieldset>
          {/each}
        {/each}
      {/if}

      {#if phase === 'preview' && preview}
        <Alert tone={nothing ? 'ok' : 'info'} title={nothing ? 'Nothing to fix up' : 'What the new commit would hold'}>
          {fixupPreviewMessage(preview)}
          {#if !nothing}{fixupPromise(branch)}{/if}
        </Alert>
        <ul class="plain results">
          {#each files as file (file.path)}
            <li>
              <code>{file.path}</code>
              <Badge tone={outcomeTone[file.outcome]}>{outcomeLabel[file.outcome]}</Badge>
              <span class="muted small">{fixupStateLabel(file.state)}{#if file.leavesSet}; it leaves the change set{/if}</span>
            </li>
          {/each}
        </ul>
        {#if preview.pullRequest.state === 'none' && !local}
          <p class="muted small">There is no pull request for this branch yet; it is opened with the commit.</p>
        {/if}
      {/if}

      {#if phase === 'confirm' || phase === 'preview'}
        {#if mayStore}
          <label class="check tops">
            <input type="checkbox" bind:checked={fromStore} disabled={busy} />
            <span class="option-text">
              <span>Take the text from the live store listing</span>
              <span class="muted small">Makes the pull again from the store snapshot and the repository as they are now, and adds what changed.</span>
            </span>
          </label>
        {/if}
        {#if local}
          <label class="check tops">
            <input type="checkbox" bind:checked={push} disabled={busy} />
            <span class="option-text">
              <span>Push the branch to GitHub</span>
              <span class="muted small">A normal push, never forced. If the branch on GitHub has other commits, the commit stays local and you are told.</span>
            </span>
          </label>
          {#if !hasPr}
            <label class="check tops">
              <input type="checkbox" bind:checked={openPr} disabled={busy} />
              <span class="option-text">
                <span>Open a pull request</span>
                <span class="muted small">There is none yet. It needs the push.</span>
              </span>
            </label>
          {/if}
        {/if}
      {/if}
    {:else if result}
      <Alert tone="ok" title={result.nothingToFix ? 'Nothing to fix up' : 'Fixed up'}>
        {fixupDoneMessage(result)}
        {#if result.commit?.signed}The commit is signed with the server's key.{/if}
      </Alert>
      {#if behindNote(result.changeSet)}<Alert tone="warn">{behindNote(result.changeSet)}</Alert>{/if}
      <ul class="plain results">
        {#each result.files.filter((f) => f.outcome !== 'unchanged') as file (file.path)}
          <li>
            <code>{file.path}</code>
            <Badge tone={outcomeTone[file.outcome]}>{outcomeLabel[file.outcome]}</Badge>
          </li>
        {/each}
      </ul>
    {/if}

    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </div>

  {#snippet footer()}
    {#if phase === 'done'}
      <Button variant="primary" onclick={() => (open = false)}>Done</Button>
    {:else}
      <Button disabled={busy} onclick={() => (open = false)}>{phase === 'preview' && nothing ? 'Close' : 'Cancel'}</Button>
      {#if phase === 'confirm'}
        <Button variant="primary" icon="git-branch" loading={busy} onclick={() => run(true)}>{busy ? 'Checking…' : 'Check what would change'}</Button>
      {:else if phase === 'conflicts'}
        <Button variant="primary" icon="refresh" loading={busy} disabled={!ready} onclick={() => run(true)}>
          {busy ? 'Checking…' : 'Check with my choices'}
        </Button>
      {:else if phase === 'preview' && !nothing}
        <Button variant="primary" icon="git-branch" loading={busy} onclick={() => run(false)}>{busy ? 'Adding the commit…' : 'Add the commit'}</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }

  .results {
    list-style: none;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }

  .results li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .conflict {
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    margin: 0;
    min-width: 0;
  }

  .conflict legend {
    padding: 0 var(--space-2);
    overflow-wrap: anywhere;
  }

  .texts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-3);
  }

  .label {
    margin: 0 0 var(--space-1);
    font-weight: var(--weight-medium);
  }

  pre {
    margin: 0;
    padding: var(--space-3);
    max-height: 14rem;
    overflow: auto;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-6);
  }

  .check.tops,
  .choices .check {
    align-items: flex-start;
  }

  .option-text {
    display: grid;
    gap: var(--space-1);
  }
</style>
