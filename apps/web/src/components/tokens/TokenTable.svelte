<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { expiryLabel, lastUsed, orderTokens, scopeSummary, tokenRoleLabel, tokenStatus } from '../../lib/api-tokens.ts';
  import { roleIcons, toneIcon } from '../../lib/status-icons.ts';
  import type { ApiToken } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';

  let {
    tokens,
    canManage,
    busyId,
    onrevoke,
  }: {
    tokens: ApiToken[];
    canManage: boolean;
    busyId: string;
    onrevoke: (token: ApiToken) => void;
  } = $props();

  const now = $derived(Date.now());
  const ordered = $derived(orderTokens(tokens));
  /** The token whose revocation waits for confirmation in the dialog. */
  let confirming = $state<ApiToken | null>(null);
  let open = $state(false);

  function ask(token: ApiToken) {
    confirming = token;
    open = true;
  }

  function confirm() {
    const token = confirming;
    open = false;
    if (token) onrevoke(token);
  }
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">API tokens of this workspace</caption>
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">Role</th>
        <th scope="col">Limits</th>
        <th scope="col">Status</th>
        <th scope="col">Last used</th>
        <th scope="col">Expires</th>
        {#if canManage}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each ordered as token (token.id)}
        {@const status = tokenStatus(token, now)}
        <tr class:inactive={token.status !== 'active'}>
          <td>
            <strong>{token.name}</strong>
            <div class="muted mono text-xs">{token.prefix}…</div>
            <div class="muted text-xs" title={fullTime(token.createdAt)}>by {token.createdBy.name ?? 'a former member'}</div>
          </td>
          <td><Badge icon={roleIcons[token.role]}>{tokenRoleLabel[token.role]}</Badge></td>
          <td class="muted">{scopeSummary(token)}</td>
          <td><Badge tone={status.tone} icon={toneIcon(status.tone)}><span title={status.title}>{status.label}</span></Badge></td>
          <td class="muted" title={token.lastUsedAt ? fullTime(token.lastUsedAt) : ''}>{lastUsed(token, now)}</td>
          <td class="muted" title={token.expiresAt ? fullTime(token.expiresAt) : ''}>{expiryLabel(token, now)}</td>
          {#if canManage}
            <td class="actions">
              {#if token.status === 'active'}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busyId === token.id}
                  label="Revoke token {token.name}"
                  onclick={() => ask(token)}>Revoke</Button
                >
              {/if}
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open size="sm" title="Revoke this token?" onclose={() => (confirming = null)}>
  {#if confirming}
    <p>
      Anything that uses <strong>{confirming.name}</strong> (<span class="mono">{confirming.prefix}…</span>) stops
      working at once. This cannot be undone; make a new token if you need one again.
    </p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Keep it</Button>
    <Button variant="danger-solid" onclick={confirm}>Revoke</Button>
  {/snippet}
</Modal>

<style>
  .inactive td {
    opacity: 0.7;
  }
</style>
