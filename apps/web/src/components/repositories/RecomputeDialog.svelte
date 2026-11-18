<!--
  RecomputeDialog: makes a store pull again from the live store listing, as it is now, and the
  repository as it is now. The change set keeps its id and creator; its files are replaced, it is a
  draft again and an approval is cleared. Nothing is written to the repository.
  Props: api, workspaceId, changeSet, role, open (bindable), onrecomputed (called with the server's
  answer), ondiscard (nothing is left to pull and the person chose to discard).
  Steps. 1. Confirm, with "Refresh from the store first" (a read-only read of the store, the same one
  a sync makes; only for people who may sync). 2. The result: per field what changed since the pull
  was made, and what was left out and why.
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type RecomputeResult,
    canRefreshFromStore,
    diffSummary,
    droppedReason,
    fieldChangeInfo,
    fieldName,
    recomputeBody,
    recomputeDoneMessage,
  } from '../../lib/change-set-fixup.ts';
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
    onrecomputed,
    ondiscard,
  }: {
    api: Api;
    workspaceId: string;
    changeSet: ChangeSetView | null;
    role: Role;
    open?: boolean;
    onrecomputed: (result: RecomputeResult) => void;
    ondiscard: () => void;
  } = $props();

  let busy = $state(false);
  let error = $state('');
  let refresh = $state(false);
  let result = $state<RecomputeResult | null>(null);

  const mayRefresh = $derived(canRefreshFromStore(role));
  const wasApproved = $derived(changeSet?.status === 'approved');

  $effect(() => {
    if (open) {
      busy = false;
      error = '';
      refresh = false;
      result = null;
    }
  });

  async function run() {
    if (!changeSet || busy) return;
    busy = true;
    error = '';
    try {
      const done = await api.recomputeChangeSet(workspaceId, changeSet.id, recomputeBody(refresh && mayRefresh));
      result = done;
      toast.success(recomputeDoneMessage(done));
      onrecomputed(done);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'The recompute did not work. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open size="lg" title="Recompute from the live store" dismissible={!busy}>
  <div class="stack">
    {#if !result}
      <p>
        This change set was made by pulling the store listing. Recomputing makes the pull again from the store listing as it is now, against
        the repository as it is now, and replaces the files of this change set.
      </p>
      <ul class="plain small">
        <li>The change set keeps its id and its author. Nothing is written to the repository.</li>
        <li>Fields the store changed since are updated, and fields the repository has caught up on leave the change set.</li>
        <li>It becomes a draft again and has to be approved again.</li>
      </ul>
      {#if wasApproved}
        <Alert tone="info">This change set is approved. If the text changes, the approval is cleared.</Alert>
      {/if}
      {#if mayRefresh}
        <label class="check tops">
          <input type="checkbox" bind:checked={refresh} disabled={busy} />
          <span class="option-text">
            <span>Refresh from the store first</span>
            <span class="muted small">Reads the listing from the store now (read only, the same read a sync makes) instead of using the last one.</span>
          </span>
        </label>
      {:else}
        <p class="muted small">The last listing read from the store is used. Someone who may sync the app can read it again first.</p>
      {/if}
    {:else}
      <Alert tone={result.nothingLeft ? 'warn' : 'ok'} title={result.nothingLeft ? 'Nothing left to pull' : 'Recomputed'}>
        {recomputeDoneMessage(result)}
      </Alert>
      {#if result.store?.error}
        <Alert tone="warn">The store could not be read ({result.store.error}), so the last listing read was used.</Alert>
      {/if}
      <p class="muted small">{diffSummary(result.diffFromPrevious)}</p>
      <ul class="plain results">
        {#each result.diffFromPrevious as item (item.repoLocale + item.field)}
          <li>
            <code>{fieldName(item)}</code>
            <Badge tone={fieldChangeInfo[item.change].tone}>{fieldChangeInfo[item.change].label}</Badge>
            {#if item.change === 'dropped'}<span class="muted small">{droppedReason(item.reason)}</span>{/if}
          </li>
        {/each}
      </ul>
      {#each result.problems as problem (problem.locale + problem.field + problem.message)}
        <Alert tone="warn">{problem.message}</Alert>
      {/each}
    {/if}

    {#if error}<Alert tone="error">{error}</Alert>{/if}
  </div>

  {#snippet footer()}
    {#if result}
      {#if result.nothingLeft}
        <Button onclick={() => (open = false)}>Keep it</Button>
        <Button variant="danger-solid" onclick={() => { open = false; ondiscard(); }}>Discard change set</Button>
      {:else}
        <Button variant="primary" onclick={() => (open = false)}>Done</Button>
      {/if}
    {:else}
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" icon="refresh" loading={busy} onclick={run}>{busy ? 'Recomputing…' : 'Recompute'}</Button>
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

  .check.tops {
    align-items: flex-start;
  }

  .option-text {
    display: grid;
    gap: var(--space-1);
  }
</style>
