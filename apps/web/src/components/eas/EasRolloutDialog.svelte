<!--
  EasRolloutDialog: raise the rollout percentage of one EAS update that is mid-rollout (docs/api/eas-update.md). Two steps: type the new
  share and ask the server for a preview (Expo is read, nothing is changed); then read the change, tick the box (and type the share for
  100%, which ends the rollout and cannot be lowered from here) and confirm. The confirm sends the preview's hash once; when Expo
  changed meanwhile the server refuses, and the dialog goes back to the first step. An unknown outcome is never retried.
  Props: open (bindable), api, workspaceId, appId, appName, target ({ group, current, channel, branch }), ondone (called with a sentence
  when the change was made), onclose.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { type EasRolloutPreview, parseShare, rolloutFailure } from '../../lib/eas/eas-update.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    appId,
    appName,
    target,
    ondone,
    onclose,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    appId: string;
    appName: string;
    target: { group: string; current: number; channel: string; branch: string };
    ondone: (message: string) => void;
    onclose: () => void;
  } = $props();

  let share = $state('');
  let fieldProblem = $state('');
  let preview = $state<EasRolloutPreview | null>(null);
  let busy = $state(false);
  let problem = $state('');
  let notice = $state('');
  let ack = $state(false);
  let typed = $state('');
  /** The write may or may not have happened: nothing more is offered. */
  let unknown = $state(false);

  const ready = $derived(preview !== null && ack && (!preview.irreversible || typed.trim() === `${preview.to}%`));

  async function ask() {
    const checked = parseShare(share, target.current);
    if (!checked.ok) {
      fieldProblem = checked.message;
      return;
    }
    fieldProblem = '';
    problem = '';
    busy = true;
    try {
      const done = await api.easUpdateRolloutPreview(workspaceId, appId, { group: target.group, percentage: checked.percentage });
      preview = done.preview;
      ack = false;
      typed = '';
    } catch (e) {
      problem = rolloutFailure(e).message;
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    if (!preview || !ready || busy) return;
    const sent = preview;
    busy = true;
    problem = '';
    try {
      // The only call that writes to Expo; it is sent once, with the hash of the preview.
      const body = { group: sent.group, percentage: sent.to, confirmHash: sent.confirmHash };
      const done = await confirmed((grant) => api.easUpdateRolloutApply(workspaceId, appId, body, grant), sent.confirmHash);
      open = false;
      const raised = { from: done.result.from, to: done.result.to };
      ondone(done.result.confirmedByReread ? t('eas:rollout.doneReread', raised) : t('eas:rollout.done', raised));
    } catch (e) {
      const failure = rolloutFailure(e);
      if (failure.kind === 'unknown') unknown = true;
      if (failure.kind === 'changed') {
        // Back to the first step: the old preview is no longer valid.
        preview = null;
        notice = failure.message;
      } else {
        problem = failure.message;
      }
    } finally {
      busy = false;
    }
  }

  function cancel() {
    open = false;
  }
</script>

<Modal bind:open size="md" title={t('eas:rollout.title')} description={t('eas:rollout.description', { app: appName, channel: target.channel, branch: target.branch })} dismissible={!busy} onclose={onclose}>
  <div class="stack">
    {#if notice}<Alert tone="warn" title={t('eas:rollout.changedTitle')}>{notice}</Alert>{/if}
    {#if preview === null}
      <p><T key="eas:rollout.intro" params={{ group: target.group.slice(0, 8), current: target.current }} tags={{ link: group }} /></p>
      <TextField label={t('eas:rollout.shareLabel')} bind:value={share} error={fieldProblem} inputmode="numeric" autocomplete="off" hint={t('eas:rollout.shareHint', { current: target.current })} />
    {:else}
      <p class="headline">{preview.summary}</p>
      <p><T key="eas:rollout.warning" /></p>
      {#if preview.warnings.length > 0}
        <ul class="warnings">
          {#each preview.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      {/if}
      {#if preview.irreversible}
        <p role="alert"><strong>{t('eas:rollout.irreversible')}</strong></p>
        <TextField label={t('eas:rollout.typeToConfirm', { percent: preview.to })} bind:value={typed} autocomplete="off" spellcheck={false} disabled={busy} />
      {/if}
      <label class="check">
        <input type="checkbox" bind:checked={ack} disabled={busy || unknown} />
        <span>{t('eas:rollout.ack')}</span>
      </label>
    {/if}
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button disabled={busy} onclick={cancel}>{unknown ? t('eas:rollout.close') : t('eas:rollout.cancel')}</Button>
    {#if preview === null}
      <Button variant="primary" loading={busy} disabled={busy} onclick={ask}>{t('eas:rollout.preview')}</Button>
    {:else if !unknown}
      <Button variant="danger-solid" loading={busy} disabled={!ready || busy} onclick={confirm}>{t('eas:rollout.raiseTo', { percent: preview.to })}</Button>
    {/if}
  {/snippet}
</Modal>

{#snippet group(text: string)}<span class="mono">{text}</span>{/snippet}

<style>
  .headline {
    margin: 0;
    font-weight: var(--weight-semibold);
  }

  .warnings {
    margin: 0;
    padding-left: var(--space-5, 1.25rem);
  }

  .check {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }
</style>
