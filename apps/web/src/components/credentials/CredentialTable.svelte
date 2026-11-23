<script lang="ts">
  import { credentialKindInfo, isCredentialKind } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { announceTest, summarizeTest, testErrorMessage, testStatus } from '../../lib/credentials.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { storeForCredentialKind } from '../../lib/stores.ts';
  import type { CredentialSummary, LastTest } from '../../lib/types.ts';
  import Icon from '../ui/Icon.svelte';
  import CredentialIdentifiers from './CredentialIdentifiers.svelte';
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
  /** Credentials whose identifiers are shown (a row under the credential). */
  let showIds = $state<Record<string, boolean>>({});

  type RowTest = { busy: boolean; error: string; details: string[] };
  let rowTests = $state<Record<string, RowTest>>({});
  /** What a screen reader hears when a test starts or ends. */
  let announcement = $state('');

  const kindLabel = (k: string) => (isCredentialKind(k) ? credentialKindInfo[k].label : k);
  const columns = $derived(canWrite ? 5 : 4);

  async function testRow(item: CredentialSummary) {
    if (rowTests[item.id]?.busy) return;
    rowTests[item.id] = { busy: true, error: '', details: [] };
    announcement = t('credentials:announce.testing', { label: item.label });
    try {
      const result = await api.testCredential(workspaceId, item.id);
      const summary = summarizeTest(result);
      rowTests[item.id] = { busy: false, error: '', details: summary.details };
      onTested(item.id, { at: Date.now(), ok: summary.ok, message: summary.message });
      announcement = announceTest(item.label, result);
    } catch (e) {
      const message = testErrorMessage(e);
      rowTests[item.id] = { busy: false, error: message, details: [] };
      announcement = t('credentials:announce.couldNotRun', { label: item.label, message });
    }
  }

  async function remove(item: CredentialSummary) {
    deleting = true;
    try {
      await confirmed((grant) => api.deleteCredential(workspaceId, item.id, grant));
      confirmingDelete = null;
      onChanged(t('credentials:page.deleted', { label: item.label }));
    } catch (e) {
      onError(e instanceof ApiError ? e.message : t('credentials:table.deleteFailed'));
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
    <colgroup>
      <col class="c-name" />
      <col class="c-type" />
      <col class="c-status" />
      <col class="c-added" />
      {#if canWrite}<col class="c-actions" />{/if}
    </colgroup>
    <thead>
      <tr>
        <th>{t('credentials:table.name')}</th>
        <th>{t('credentials:table.type')}</th>
        <th>{t('credentials:table.status')}</th>
        <th>{t('credentials:table.added')}</th>
        {#if canWrite}<th><span class="visually-hidden">{t('credentials:table.actions')}</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each items as item (item.id)}
        {@const status = testStatus(item.lastTest)}
        {@const run = rowTests[item.id]}
        <tr>
          <td class="name">
            <strong>{item.label}</strong>
            <button
              id="ids-btn-{item.id}"
              class="link ids-toggle"
              aria-expanded={showIds[item.id] === true}
              aria-controls="ids-{item.id}"
              aria-label={showIds[item.id] ? t('credentials:identifier.hideAria', { label: item.label }) : t('credentials:identifier.showAria', { label: item.label })}
              onclick={() => (showIds[item.id] = !showIds[item.id])}>{showIds[item.id] ? t('credentials:identifier.hide') : t('credentials:identifier.show')}</button
            >
            {#if item.lastTest && !item.lastTest.ok && item.lastTest.message}
              <p class="failure">{item.lastTest.message}</p>
            {/if}
          </td>
          <td class="kind" data-label={t('credentials:table.type')}><Icon name={storeForCredentialKind(item.kind).icon} /> {kindLabel(item.kind)}</td>
          <td class="status" data-label={t('credentials:table.status')}>
            {#if run?.busy}
              <span class="muted"><Spinner /> {t('credentials:test.testing')}</span>
            {:else}
              <span class="badge {status.tone}" class:none={status.tone === 'none'} title={status.title}><Icon name={status.state === 'working' ? 'check-circle' : status.state === 'failed' ? 'x-circle' : 'help'} size={12} />{status.label}</span>
              {#if status.when}
                <span class="when muted" title={item.lastTest ? formatDateTime(item.lastTest.at) : ''}>{status.when}</span>
              {/if}
              {#if item.lastTest?.ok && item.lastTest.message}
                <p class="note muted">{item.lastTest.message}</p>
              {/if}
              {#if run && run.details.length > 0}
                <details class="more">
                  <summary>{t('credentials:table.whatWasChecked')}</summary>
                  <ul>
                    {#each run.details as line (line)}<li>{line}</li>{/each}
                  </ul>
                </details>
              {/if}
              {#if run?.error}<p class="failure">{run.error}</p>{/if}
            {/if}
          </td>
          <td class="added" data-label={t('credentials:table.added')} title={formatDateTime(item.createdAt)}>
            {formatRelativeTime(item.createdAt)}
            {#if item.rotatedAt}
              <span class="when muted block" title={formatDateTime(item.rotatedAt)}>{t('credentials:table.rotatedAgo', { when: formatRelativeTime(item.rotatedAt) })}</span>
            {/if}
          </td>
          {#if canWrite}
            <td class="actions">
              <div class="group">
              {#if confirmingDelete === item.id}
                <span>{t('credentials:table.confirmDelete', { label: item.label })}</span>
                <button class="danger" disabled={deleting} onclick={() => remove(item)}>{t('credentials:table.delete')}</button>
                <button id="delete-keep-{item.id}" disabled={deleting} onclick={() => cancelDelete(item.id)}>{t('credentials:table.keep')}</button>
              {:else}
                <button
                  class="link test"
                  aria-label={t('credentials:table.testAria', { label: item.label })}
                  aria-disabled={run?.busy === true}
                  onclick={() => testRow(item)}
                >
                  {#if run?.busy}<Spinner /> {t('credentials:test.testing')}{:else}{t('credentials:table.test')}{/if}
                </button>
                <button
                  id="replace-btn-{item.id}"
                  class="link"
                  aria-expanded={replacing === item.id}
                  onclick={() => {
                    replacing = item.id;
                    confirmingDelete = null;
                  }}>{t('credentials:table.replace')}</button
                >
                <button id="delete-btn-{item.id}" class="link danger" onclick={() => askDelete(item.id)}>{t('credentials:table.delete')}</button>
              {/if}
              </div>
            </td>
          {/if}
        </tr>
        {#if showIds[item.id]}
          <tr class="ids-row">
            <td colspan={columns} id="ids-{item.id}">
              <CredentialIdentifiers identifiers={item.identifiers ?? []} />
            </td>
          </tr>
        {/if}
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
                  onChanged(t('credentials:page.replaced', { label: item.label }));
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
  /* Fixed layout: every column keeps its share, long text wraps inside its cell, so nothing ever pushes past the card. */
  .table {
    padding: 0;
    overflow: hidden;
  }

  table {
    width: 100%;
    table-layout: fixed;
  }

  .c-name {
    width: 22%;
  }

  .c-type {
    width: 15%;
  }

  .c-status {
    width: 27%;
  }

  .c-added {
    width: 13%;
  }

  .c-actions {
    width: 23%;
  }

  td,
  th {
    min-width: 0;
    overflow-wrap: anywhere;
    vertical-align: top;
  }

  td,
  th {
    font-size: 0.9375rem;
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

  .when.block {
    display: block;
    margin-left: 0;
  }

  .group {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    justify-content: flex-end;
    align-items: baseline;
  }

  .group button {
    white-space: nowrap;
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

  .table td p.failure,
  .table td p.note,
  .table td .more {
    max-width: 100%;
  }

  .actions :global(.link) {
    vertical-align: baseline;
  }


  .ids-toggle {
    display: block;
    margin-top: 2px;
    font-size: 0.8125rem;
  }

  .ids-row td {
    padding-top: 0;
  }

  button.test[aria-disabled='true'] {
    cursor: progress;
  }

  /* Below 640px each row is a small stack: the cells one under the other, each with its column name. */
  @media (max-width: 639px) {
    table,
    tbody,
    tr,
    td {
      display: block;
    }

    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }

    colgroup {
      display: none;
    }

    tr {
      padding: var(--space-2) 0;
      border-bottom: 1px solid var(--line);
    }

    td {
      border: 0;
      padding-block: var(--space-1);
    }

    td[data-label]::before {
      display: block;
      font-size: 0.8125rem;
      color: var(--muted);
      content: attr(data-label);
    }

    .group {
      justify-content: flex-start;
    }
  }
</style>
