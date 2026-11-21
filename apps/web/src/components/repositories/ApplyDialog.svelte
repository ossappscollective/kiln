<!--
  ApplyDialog: how to apply an approved change set. Two ways: a pull request on GitHub (the
  default where there is a GitHub connection), or one commit on a new branch of the local clone,
  with an optional push of that branch and an optional pull request. What is not possible is shown
  disabled with the reason, never hidden. The rules are in lib/change-set-apply.ts.
  Props: open (bindable), changeSet (id, summary, filesChanged), context (localOnly, hasLocalClone,
  write), busy, onconfirm (called with the choice and the request body, undefined for a pull
  request).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    APPLY_LOCAL_EXPLANATION,
    type ApplyBody,
    type ApplyChoice,
    type ApplyContext,
    applyBlocker,
    applyBody,
    branchNameProblem,
    defaultBranchName,
    githubPrAvailability,
    initialChoice,
    localBranchAvailability,
    normalizeChoice,
    openPrAvailability,
    pushAvailability,
    signingNote,
  } from '../../lib/change-set-apply.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { filesChangedLabel } from '../../lib/repositories.ts';
  import type { ChangeSetView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    open = $bindable(false),
    changeSet,
    context,
    busy = false,
    onconfirm,
  }: {
    open?: boolean | undefined;
    changeSet: Pick<ChangeSetView, 'id' | 'summary' | 'filesChanged'> | null;
    context: ApplyContext;
    busy?: boolean | undefined;
    onconfirm: (body: ApplyBody | undefined) => void;
  } = $props();

  const uid = $props.id();
  const defaultBranch = $derived(changeSet ? defaultBranchName(changeSet.id, changeSet.summary) : '');
  let choice = $state<ApplyChoice>({ mode: 'github_pr', branch: '', push: false, openPr: false });

  // A fresh choice each time the dialog opens, for the change set it is opened for.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      choice = initialChoice(context, defaultBranch);
    });
  });

  const githubPr = $derived(githubPrAvailability(context));
  const localBranch = $derived(localBranchAvailability(context));
  const push = $derived(pushAvailability(context));
  const openPr = $derived(openPrAvailability(context, choice.push));
  const signing = $derived(signingNote(context.signing));
  const effective = $derived(normalizeChoice(choice, context));
  const blocker = $derived(applyBlocker(effective, context));
  const branchError = $derived(choice.mode === 'local_branch' ? (branchNameProblem(choice.branch) ?? undefined) : undefined);

  function confirm() {
    if (blocker !== null) return;
    onconfirm(applyBody(effective, defaultBranch));
  }

  const confirmLabel = $derived(
    effective.mode === 'github_pr'
      ? t('repositories:apply.confirmPr')
      : effective.push
        ? effective.openPr
          ? t('repositories:apply.confirmPushPr')
          : t('repositories:apply.confirmPush')
        : t('repositories:apply.confirmCommit'),
  );
</script>

<Modal bind:open size="md" title={t('repositories:apply.title')}>
  <div class="stack">
    <fieldset class="stack tight">
      <legend>{t('repositories:apply.how')}</legend>

      <label class="check option" class:selected={choice.mode === 'github_pr'} class:off={!githubPr.available}>
        <input type="radio" name="{uid}-mode" value="github_pr" bind:group={choice.mode} disabled={busy || !githubPr.available} aria-describedby="{uid}-pr-note" />
        <span class="option-text">
          <span class="option-label">{t('repositories:apply.optionPr')}</span>
          <span class="muted small" id="{uid}-pr-note">
            {#if githubPr.available}
              {changeSet ? t('repositories:apply.prDescFiles', { files: filesChangedLabel(changeSet.filesChanged) }) : t('repositories:apply.prDesc')}
            {:else}
              {githubPr.reason}
            {/if}
          </span>
        </span>
      </label>

      <label class="check option" class:selected={choice.mode === 'local_branch'} class:off={!localBranch.available}>
        <input type="radio" name="{uid}-mode" value="local_branch" bind:group={choice.mode} disabled={busy || !localBranch.available} aria-describedby="{uid}-local-note" />
        <span class="option-text">
          <span class="option-label">{t('repositories:apply.optionLocal')}</span>
          <span class="muted small" id="{uid}-local-note">
            {#if localBranch.available}
              {APPLY_LOCAL_EXPLANATION}
            {:else}
              {localBranch.reason}
            {/if}
          </span>
        </span>
      </label>
    </fieldset>

    {#if choice.mode === 'local_branch'}
      <TextField
        label={t('repositories:apply.branchName')}
        bind:value={choice.branch}
        placeholder={defaultBranch}
        hint={t('repositories:apply.branchHint', { name: defaultBranch })}
        error={branchError}
        spellcheck={false}
        autocomplete="off"
        disabled={busy || !localBranch.available}
      />

      {#if signing}
        <p class="muted small signing" class:signed={signing.signed} id="{uid}-signing-note">{signing.text}</p>
      {/if}

      <div class="stack tight">
        <label class="check tops" class:off={!push.available}>
          <input type="checkbox" bind:checked={choice.push} disabled={busy || !push.available} aria-describedby="{uid}-push-note" />
          <span class="option-text">
            <span>{t('repositories:apply.push')}</span>
            <span class="muted small" id="{uid}-push-note">
              {#if push.available}
                {t('repositories:apply.pushNote')}
              {:else}
                {push.reason}
              {/if}
            </span>
          </span>
        </label>
        <label class="check tops" class:off={!openPr.available}>
          <input type="checkbox" bind:checked={choice.openPr} disabled={busy || !openPr.available} aria-describedby="{uid}-pr-open-note" />
          <span class="option-text">
            <span>{t('repositories:apply.openPr')}</span>
            <span class="muted small" id="{uid}-pr-open-note">
              {#if openPr.available}
                {t('repositories:apply.openPrNote')}
              {:else}
                {openPr.reason}
              {/if}
            </span>
          </span>
        </label>
      </div>
    {/if}

    {#if blocker !== null && !branchError}
      <Alert tone="warn">{blocker}</Alert>
    {/if}
  </div>

  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('repositories:action.cancel')}</Button>
    <Button variant="primary" disabled={busy || blocker !== null} onclick={confirm}>{confirmLabel}</Button>
  {/snippet}
</Modal>

<style>
  .option {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .option.selected {
    border-color: var(--accent);
  }

  .tops {
    align-items: flex-start;
  }

  .off {
    opacity: 0.75;
  }

  .signing {
    margin: 0;
  }

  .signing.signed {
    color: var(--ok-ink);
  }

  .option-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .option-label {
    font-weight: var(--weight-medium);
  }
</style>
