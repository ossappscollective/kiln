<!--
  ChangeSetRefreshDialog: re-bases a change set that is out of date onto the repository as it is now.
  Props: api, workspaceId, changeSet, open (bindable), onrefreshed (called with the server's answer
  once the change set was refreshed), ondiscard (called when nothing is left to apply and the person
  chooses to discard).
  Three steps. 1. Confirm: what a refresh does. 2. If some file changed in the repository in the same
  place as the change set, the three texts are shown (the original, yours, theirs) and the person
  chooses per file: keep mine (overwrite theirs) or keep theirs (drop my change). Nothing was changed
  until then. 3. The result per file. A refresh that changes the text makes the change set a draft
  again: an approval does not carry over.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type RefreshFile,
    type RefreshResult,
    type Resolution,
    allChosen,
    conflictReasonText,
    conflictsFrom,
    fileStateInfo,
    pendingConflicts,
    refreshDoneMessage,
    resolutionInfo,
    toResolutions,
  } from '../../lib/change-set-refresh.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ChangeSetView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';

  let {
    api,
    workspaceId,
    changeSet,
    open = $bindable(false),
    onrefreshed,
    ondiscard,
  }: {
    api: Api;
    workspaceId: string;
    changeSet: ChangeSetView | null;
    open?: boolean | undefined;
    onrefreshed: (result: RefreshResult) => void;
    ondiscard: () => void;
  } = $props();

  const uid = $props.id();
  let phase = $state<'confirm' | 'conflicts' | 'done'>('confirm');
  let busy = $state(false);
  let error = $state('');
  let files = $state<RefreshFile[]>([]);
  let choices = $state<Record<string, Resolution | undefined>>({});
  let result = $state<RefreshResult | null>(null);

  // A fresh start each time the dialog opens.
  $effect(() => {
    if (open) {
      phase = 'confirm';
      busy = false;
      error = '';
      files = [];
      choices = {};
      result = null;
    }
  });

  const conflicts = $derived(pendingConflicts(files));
  const ready = $derived(allChosen(files, choices));
  const wasApproved = $derived(changeSet?.status === 'approved');

  async function run(resolutions?: Record<string, Resolution>) {
    if (!changeSet || busy) return;
    busy = true;
    error = '';
    try {
      const done = await api.refreshChangeSet(workspaceId, changeSet.id, resolutions ? { resolutions } : undefined);
      result = done;
      files = done.files;
      phase = 'done';
      toast.success(refreshDoneMessage(done));
      onrefreshed(done);
    } catch (e) {
      const found = e instanceof ApiError ? conflictsFrom(e.body) : undefined;
      if (found) {
        files = found.files;
        phase = 'conflicts';
        // Keep the choices already made for the files that are still in conflict.
        const kept: Record<string, Resolution | undefined> = {};
        for (const f of pendingConflicts(found.files)) kept[f.path] = choices[f.path];
        choices = kept;
      } else {
        error = e instanceof ApiError ? e.message : t('repositories:refresh.failed');
      }
    } finally {
      busy = false;
    }
  }

  function chooseAll(choice: Resolution) {
    const all: Record<string, Resolution | undefined> = {};
    for (const f of conflicts) all[f.path] = choice;
    choices = all;
  }

  const outcomeLabel: Record<RefreshFile['outcome'], string> = {
    unchanged: k('repositories:refresh.outcomeUnchanged'),
    merged: k('repositories:refresh.outcomeMerged'),
    dropped: k('repositories:refresh.outcomeDropped'),
    kept_mine: k('repositories:refresh.outcomeKeptMine'),
    kept_theirs: k('repositories:refresh.outcomeKeptTheirs'),
    conflict: k('repositories:refresh.outcomeConflict'),
  };
  const outcomeTone: Record<RefreshFile['outcome'], 'neutral' | 'ok' | 'info' | 'warn'> = {
    unchanged: 'neutral',
    merged: 'info',
    dropped: 'ok',
    kept_mine: 'info',
    kept_theirs: 'neutral',
    conflict: 'warn',
  };
</script>

<Modal bind:open size="lg" title={t('repositories:refresh.title')} dismissible={!busy}>
  <div class="stack">
    {#if phase === 'confirm'}
      <p>{t('repositories:refresh.intro')}</p>
      <ul class="plain small">
        <li>{t('repositories:refresh.point1')}</li>
        <li>{t('repositories:refresh.point2')}</li>
        <li>{t('repositories:refresh.point3')}</li>
        <li>{t('repositories:refresh.point4')}</li>
      </ul>
      {#if wasApproved}
        <Alert tone="info">{t('repositories:refresh.approved')}</Alert>
      {/if}
    {:else if phase === 'conflicts'}
      <Alert tone="warn" title={t('repositories:refresh.conflictTitle', { count: conflicts.length })}>
        <T key="repositories:refresh.conflictBody" />
      </Alert>
      {#if conflicts.length > 1}
        <div class="row">
          <Button size="sm" onclick={() => chooseAll('mine')}>{t('repositories:refresh.keepMineAll')}</Button>
          <Button size="sm" onclick={() => chooseAll('theirs')}>{t('repositories:refresh.keepTheirsAll')}</Button>
        </div>
      {/if}
      {#each conflicts as file (file.path)}
        <fieldset class="conflict stack tight">
          <legend><code>{file.path}</code></legend>
          {#if file.reason}<p class="muted small">{conflictReasonText[file.reason]}</p>{/if}
          <div class="texts">
            {#each [{ id: 'theirs', label: t('repositories:refresh.theirsColumn'), text: file.theirs }, { id: 'mine', label: t('repositories:refresh.mineColumn'), text: file.ours }] as column (column.id)}
              <div>
                <p class="label small">{column.label}</p>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <pre tabindex="0" aria-label={t('repositories:refresh.columnAria', { label: column.label, path: file.path })}>{#if column.text === null || column.text === undefined}<em>{t('repositories:refresh.fileMissing')}</em>{:else}{column.text}{/if}</pre>
              </div>
            {/each}
          </div>
          <details>
            <summary class="small">{t('repositories:refresh.baseSummary')}</summary>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <pre tabindex="0" aria-label={t('repositories:refresh.baseAria', { path: file.path })}>{#if file.base === null || file.base === undefined}<em>{t('repositories:refresh.baseMissing')}</em>{:else}{file.base}{/if}</pre>
          </details>
          <div class="choices" role="radiogroup" aria-label={t('repositories:refresh.chooseAria', { path: file.path })}>
            {#each ['mine', 'theirs'] as const as option (option)}
              <label class="check">
                <input type="radio" name="{uid}-{file.path}" value={option} bind:group={choices[file.path]} disabled={busy} />
                <span>
                  {resolutionInfo[option].label}
                  <span class="muted small">{resolutionInfo[option].description}</span>
                </span>
              </label>
            {/each}
          </div>
        </fieldset>
      {/each}
      {#if files.length > conflicts.length}
        <details>
          <summary class="small">{t('repositories:refresh.others', { count: files.length - conflicts.length })}</summary>
          <ul class="plain small">
            {#each files.filter((f) => f.outcome !== 'conflict') as file (file.path)}
              <li><code>{file.path}</code> <Badge tone={fileStateInfo[file.state].tone}>{fileStateInfo[file.state].label}</Badge></li>
            {/each}
          </ul>
        </details>
      {/if}
    {:else if result}
      <Alert tone={result.nothingLeft ? 'warn' : 'ok'} title={result.nothingLeft ? t('repositories:refresh.nothingLeft') : t('repositories:refresh.refreshed')}>
        {refreshDoneMessage(result)}
      </Alert>
      <ul class="plain results">
        {#each result.files as file (file.path)}
          <li>
            <code>{file.path}</code>
            <Badge tone={outcomeTone[file.outcome]}>{t(outcomeLabel[file.outcome])}</Badge>
          </li>
        {/each}
      </ul>
    {/if}

    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </div>

  {#snippet footer()}
    {#if phase === 'done'}
      {#if result?.nothingLeft}
        <Button onclick={() => (open = false)}>{t('repositories:refresh.keep')}</Button>
        <Button variant="danger-solid" onclick={() => { open = false; ondiscard(); }}>{t('repositories:refresh.discard')}</Button>
      {:else}
        <Button variant="primary" onclick={() => (open = false)}>{t('repositories:refresh.done')}</Button>
      {/if}
    {:else}
      <Button disabled={busy} onclick={() => (open = false)}>{t('repositories:action.cancel')}</Button>
      {#if phase === 'confirm'}
        <Button variant="primary" icon="refresh" loading={busy} onclick={() => run()}>{busy ? t('repositories:refresh.refreshing') : t('repositories:refresh.refresh')}</Button>
      {:else}
        <Button variant="primary" icon="refresh" loading={busy} disabled={!ready} onclick={() => run(toResolutions(choices))}>
          {busy ? t('repositories:refresh.refreshing') : t('repositories:refresh.applyChoices')}
        </Button>
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

  .choices .check {
    align-items: flex-start;
  }
</style>
