<script lang="ts">
  import {
    type CredentialKind,
    buildSecret,
    checkSecret,
    credentialGuides,
    credentialKindInfo,
    credentialKinds,
  } from '@mrm/core';
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import SecretFields from '../SecretFields.svelte';
  import GuidePanel from './GuidePanel.svelte';
  import Spinner from './Spinner.svelte';
  import TestResult from './TestResult.svelte';
  import { createTester } from './tester.svelte.ts';

  let {
    api,
    workspaceId,
    onSaved,
    onCancel,
  }: {
    api: Api;
    workspaceId: string;
    /** Called with the name that was saved, after the credential is stored. */
    onSaved: (label: string) => void;
    onCancel: () => void;
  } = $props();

  let kind = $state<CredentialKind>('app_store_connect');
  let label = $state('');
  let values = $state<Record<string, string>>({});
  let formError = $state('');
  let saving = $state(false);

  const tester = createTester();
  let kindSelect = $state<HTMLSelectElement>();
  let guide = $state<ReturnType<typeof GuidePanel>>();

  const secret = $derived(buildSecret(kind, values));
  const problem = $derived(checkSecret(kind, secret));
  /** What a test result belongs to. A result is hidden as soon as the input no longer matches. */
  const fingerprint = $derived(`${kind}\n${secret}`);
  const current = $derived(tester.key === fingerprint);
  const testing = $derived(tester.status === 'testing');
  const testedOk = $derived(current && tester.status === 'done' && tester.result?.ok === true);
  const canTroubleshoot = $derived(credentialGuides[kind].troubleshooting.length > 0);

  onMount(() => kindSelect?.focus());

  function test() {
    if (problem || testing || saving) return;
    const testKind = kind;
    const testSecret = secret;
    void tester.run(fingerprint, () => api.testSecret(workspaceId, { kind: testKind, secret: testSecret }));
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (problem) {
      formError = problem;
      return;
    }
    saving = true;
    formError = '';
    try {
      await api.addCredential(workspaceId, { kind, label, secret });
      onSaved(label);
    } catch (e) {
      formError = e instanceof ApiError ? e.message : 'Could not save the credential.';
    } finally {
      saving = false;
    }
  }
</script>

<div class="wrap">
  <div class="layout">
    <form class="card form" onsubmit={save}>
      <h3>Add a credential</h3>
      <div class="field">
        <label for="kind">Type</label>
        <select
          id="kind"
          bind:this={kindSelect}
          bind:value={kind}
          onchange={() => {
            values = {};
            formError = '';
          }}
        >
          {#each credentialKinds as k (k)}
            <option value={k}>{credentialKindInfo[k].label}</option>
          {/each}
        </select>
        <p class="hint">{credentialKindInfo[kind].description}</p>
      </div>
      <div class="field">
        <label for="label">Name</label>
        <input id="label" bind:value={label} placeholder="For example: Acme production" maxlength="100" required />
      </div>
      <SecretFields {kind} bind:values disabled={saving} idPrefix="add" />

      {#if formError}<p class="alert error" role="alert">{formError}</p>{/if}

      <div class="actions">
        <button
          type="button"
          class="test"
          disabled={Boolean(problem) || saving}
          aria-disabled={testing}
          aria-describedby="add-test-hint"
          onclick={test}
        >
          {#if testing}<Spinner /> Testing…{:else}Test connection{/if}
        </button>
        <button class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save credential'}</button>
        <button type="button" disabled={saving} onclick={onCancel}>Cancel</button>
        <span class="tested" class:on={testedOk}>✓ Tested OK</span>
      </div>
      <p class="hint" id="add-test-hint">
        {#if problem}
          Fill in every field to test the connection. Nothing is sent until you press the button.
        {:else}
          Tests the secret with the provider without saving it. Saving does not require a test.
        {/if}
      </p>

      <TestResult
        status={current ? tester.status : 'idle'}
        result={tester.result}
        error={tester.error}
        onTroubleshoot={canTroubleshoot ? () => guide?.showTroubleshooting() : undefined}
      />
    </form>

    <div class="aside">
      {#key kind}
        <GuidePanel {kind} bind:this={guide} />
      {/key}
    </div>
  </div>
</div>

<style>
  .wrap {
    margin-bottom: 20px;
    container-type: inline-size;
  }

  .layout {
    display: grid;
    gap: 16px;
    align-items: start;
  }

  .form {
    max-width: 640px;
  }

  .form h3 {
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

  /* Takes up its space even when hidden, so the row does not shift. */
  .tested {
    font-size: 12px;
    font-weight: 600;
    color: var(--ok-ink);
    visibility: hidden;
  }

  .tested.on {
    visibility: visible;
  }

  .hint {
    margin-top: 8px;
  }

  @container (min-width: 880px) {
    .layout {
      grid-template-columns: minmax(0, 1fr) minmax(320px, 400px);
    }

    .form {
      max-width: none;
    }

    .aside {
      position: sticky;
      top: 16px;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
    }
  }
</style>
