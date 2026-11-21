<script lang="ts">
  import { credentialKindInfo, isCredentialKind } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { announceTest, summarizeTest, testErrorMessage, testStatus } from '../../lib/credentials.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { storeForCredentialKind } from '../../lib/stores.ts';
  import type { CredentialSummary, LastTest } from '../../lib/types.ts';
  import Icon from '../ui/Icon.svelte';
  import ReplaceSecret from './ReplaceSecret.svelte';
  import Spinner from './Spinner.svelte';

  let {
    api,
    workspaceId,
    items,
    canWrite,
    onChanged,
    onTested,
    onError,
  }: {
    api: Api;
    workspaceId: string;
    items: CredentialSummary[];
    canWrite: boolean;
    /** The list changed on the server (replaced or deleted); `notice` says what happened. */
    onChanged: (notice: string) => void;
    /** A saved credential was tested; the server has recorded it. */
    onTested: (id: string, lastTest: LastTest) => void;
    onError: (message: string) => void;
  } = $props();

  // Row actions: at most one of replacing or deleting is open at a time.
  let replacing = $state<string | null>(null);
  let confirmingDelete = $state<string | null>(null);
  let deleting = $state(false);

  type RowTest = { busy: boolean; error: string; details: string[] };
  let rowTests = $state<Record<string, RowTest>>({});
  /** What a screen reader hears when a test starts or ends. */
  let announcement = $state('');

  const kindLabel = (k: string) => (isCredentialKind(k) ? credentialKindInfo[k].label : k);
  const columns = $derived(canWrite ? 6 : 5);

  async function testRow(item: CredentialSummary) {
    if (rowTests[item.id]?.busy) return;
    rowTests[item.id] = { busy: true, error: '', details: [] };
    announcement = `Testing ${item.label}…`;
    try {
      const result = await api.testCredential(workspaceId, item.id);
      const summary = summarizeTest(result);
      rowTests[item.id] = { busy: false, error: '', details: summary.details };
      onTested(item.id, { at: Date.now(), ok: summary.ok, message: summary.message });
      announcement = announceTest(item.label, result);
    } catch (e) {
      const message = testErrorMessage(e);
      rowTests[item.id] = { busy: false, error: message, details: [] };
      announcement = `${item.label}: could not run the test. ${message}`;
    }
  }

  async function remove(item: CredentialSummary) {
    deleting = true;
    try {
      await confirmed((grant) => api.deleteCredential(workspaceId, item.id, grant));
      confirmingDelete = null;
      onChanged(`Deleted “${item.label}”.`);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not delete the credential.');
    } finally {
      deleting = false;
    }
  }

  async function closeReplace(id: string) {
    replacing = null;
    await tick();
    document.getElementById(`replace-btn-${id}`)?.focus();
  }

  async function cancelDelete(id: string) {
    confirmingDelete = null;
    await tick();
    document.getElementById(`delete-btn-${id}`)?.focus();
  }

  async function askDelete(id: string) {
    confirmingDelete = id;
    replacing = null;
    await tick();
    document.getElementById(`delete-keep-${id}`)?.focus();
  }
</script>

<div class="card table">
  <p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Type</th>
        <th>Status</th>
        <th>Added</th>
        <th>Secret replaced</th>
        {#if canWrite}<th><span class="visually-hidden">Actions</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each items as item (item.id)}
        {@const status = testStatus(item.lastTest)}
        {@const run = rowTests[item.id]}
        <tr>
          <td>
            <strong>{item.label}</strong>
            {#if item.lastTest && !item.lastTest.ok && item.lastTest.message}
              <p class="failure">{item.lastTest.message}</p>
            {/if}
          </td>
          <td class="kind"><Icon name={storeForCredentialKind(item.kind).icon} /> {kindLabel(item.kind)}</td>
          <td class="status">
            {#if run?.busy}
              <span class="muted"><Spinner /> Testing…</span>
            {:else}
              <span class="badge {status.tone}" class:none={status.tone === 'none'} title={status.title}><Icon name={status.state === 'working' ? 'check-circle' : status.state === 'failed' ? 'x-circle' : 'help'} size={12} />{status.label}</span>
              {#if status.when}
                <span class="when muted" title={item.lastTest ? fullTime(item.lastTest.at) : ''}>{status.when}</span>
              {/if}
              {#if item.lastTest?.ok && item.lastTest.message}
                <p class="note muted">{item.lastTest.message}</p>
              {/if}
              {#if run && run.details.length > 0}
                <details class="more">
                  <summary>What was checked</summary>
                  <ul>
                    {#each run.details as line (line)}<li>{line}</li>{/each}
                  </ul>
                </details>
              {/if}
              {#if run?.error}<p class="failure">{run.error}</p>{/if}
            {/if}
          </td>
          <td title={fullTime(item.createdAt)}>{timeAgo(item.createdAt)}</td>
          <td title={item.rotatedAt ? fullTime(item.rotatedAt) : ''}>
            {item.rotatedAt ? timeAgo(item.rotatedAt) : 'Never'}
          </td>
          {#if canWrite}
            <td class="actions">
              {#if confirmingDelete === item.id}
                <span>Delete “{item.label}”?</span>
                <button class="danger" disabled={deleting} onclick={() => remove(item)}>Delete</button>
                <button id="delete-keep-{item.id}" disabled={deleting} onclick={() => cancelDelete(item.id)}>Keep</button>
              {:else}
                <button
                  class="link test"
                  aria-label="Test connection for {item.label}"
                  aria-disabled={run?.busy === true}
                  onclick={() => testRow(item)}
                >
                  {#if run?.busy}<Spinner /> Testing…{:else}Test{/if}
                </button>
                <button
                  id="replace-btn-{item.id}"
                  class="link"
                  aria-expanded={replacing === item.id}
                  onclick={() => {
                    replacing = item.id;
                    confirmingDelete = null;
                  }}>Replace secret</button
                >
                <button id="delete-btn-{item.id}" class="link danger" onclick={() => askDelete(item.id)}>Delete</button>
              {/if}
            </td>
          {/if}
        </tr>
        {#if canWrite && replacing === item.id && isCredentialKind(item.kind)}
          <tr>
            <td colspan={columns}>
              <ReplaceSecret
                {api}
                {workspaceId}
                id={item.id}
                label={item.label}
                kind={item.kind}
                onReplaced={() => {
                  replacing = null;
                  onChanged(`Replaced the secret of “${item.label}”.`);
                }}
                onCancel={() => closeReplace(item.id)}
              />
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table {
    padding: 0;
    overflow-x: auto;
  }

  td,
  th {
    font-size: 0.9375rem;
  }

  .status {
    min-width: 150px;
  }

  .badge.none {
    color: var(--muted);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .when {
    margin-left: 6px;
    font-size: 0.8125rem;
  }

  .status .badge,
  .status .when {
    vertical-align: middle;
  }

  p.failure,
  p.note {
    margin: 4px 0 0;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  p.failure {
    color: var(--bad-ink);
    opacity: 0.9;
  }

  .more {
    margin-top: 4px;
    font-size: 12px;
  }

  .more summary {
    cursor: pointer;
    color: var(--muted);
  }

  .more ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }

  /* One line per cell, so the table scrolls sideways before it wraps a type, a date or an action; notes below still wrap. */
  .table td:not(:first-child) {
    white-space: nowrap;
  }

  .table td p.failure,
  .table td p.note,
  .table td .more {
    max-width: 28rem;
    white-space: normal;
  }

  .actions :global(.link) {
    vertical-align: baseline;
  }

  button.test {
    min-width: 5.5em;
    text-align: right;
  }

  button.test[aria-disabled='true'] {
    cursor: progress;
  }
</style>
