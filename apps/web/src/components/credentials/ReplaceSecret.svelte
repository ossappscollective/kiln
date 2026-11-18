<script lang="ts">
  import { type CredentialKind, buildSecret, checkSecret, credentialGuides } from '@mrm/core';
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import SecretFields from '../SecretFields.svelte';
  import Icon from '../ui/Icon.svelte';
  import GuidePanel from './GuidePanel.svelte';
  import Spinner from './Spinner.svelte';
  import TestResult from './TestResult.svelte';
  import { createTester } from './tester.svelte.ts';

  let {
    api,
    workspaceId,
    id,
    label,
    kind,
    onReplaced,
    onCancel,
  }: {
    api: Api;
    workspaceId: string;
    id: string;
    label: string;
    kind: CredentialKind;
    onReplaced: () => void;
    onCancel: () => void;
  } = $props();

  let values = $state<Record<string, string>>({});
  let error = $state('');
  let busy = $state(false);

  const tester = createTester();
  let root = $state<HTMLElement>();
  let guide = $state<ReturnType<typeof GuidePanel>>();

  const secret = $derived(buildSecret(kind, values));
  const problem = $derived(checkSecret(kind, secret));
  const current = $derived(tester.key === secret);
  const testing = $derived(tester.status === 'testing');
  const testedOk = $derived(current && tester.status === 'done' && tester.result?.ok === true);
  const canTroubleshoot = $derived(credentialGuides[kind].troubleshooting.length > 0);

  onMount(() => root?.querySelector<HTMLElement>('input, textarea')?.focus());

  function test() {
    if (problem || testing || busy) return;
    const testSecret = secret;
    void tester.run(testSecret, () => api.testSecret(workspaceId, { kind, secret: testSecret }));
  }

  async function replace(event: SubmitEvent) {
    event.preventDefault();
    if (problem) {
      error = problem;
      return;
    }
    busy = true;
    error = '';
    try {
      await api.replaceSecret(workspaceId, id, secret);
      onReplaced();
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not replace the secret.';
    } finally {
      busy = false;
    }
  }
</script>

<form class="replace" bind:this={root} onsubmit={replace}>
  <h3>Replace the secret of “{label}”</h3>
  <div class="guide"><GuidePanel {kind} collapsible bind:this={guide} /></div>
  <SecretFields {kind} bind:values disabled={busy} idPrefix="replace-{id}" />

  {#if error}<p class="alert error" role="alert">{error}</p>{/if}

  <div class="actions">
    <button
      type="button"
      class="test"
      disabled={Boolean(problem) || busy}
      aria-disabled={testing}
      onclick={test}
    >
      {#if testing}<Spinner /> Testing…{:else}Test connection{/if}
    </button>
    <button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Replace secret'}</button>
    <button type="button" disabled={busy} onclick={onCancel}>Cancel</button>
    <span class="tested" class:on={testedOk}><Icon name="check" size="sm" /> Tested OK</span>
  </div>

  <TestResult
    status={current ? tester.status : 'idle'}
    result={tester.result}
    error={tester.error}
    onTroubleshoot={canTroubleshoot ? () => guide?.showTroubleshooting() : undefined}
  />
</form>

<style>
  .replace {
    max-width: 640px;
    padding: 8px 0;
  }

  .replace h3 {
    margin-bottom: 12px;
    font-size: 14px;
  }

  .guide {
    margin-bottom: 14px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .test {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .test[aria-disabled='true'] {
    cursor: progress;
  }

  .tested {
    font-size: 12px;
    font-weight: 600;
    color: var(--ok-ink);
    visibility: hidden;
  }

  .tested.on {
    visibility: visible;
  }
</style>
