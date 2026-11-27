<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { expiryLabel, lastUsed, orderTokens, scopeSummary, tokenRoleLabel, tokenStatus } from '../../lib/api-tokens.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { roleIcons, toneIcon } from '../../lib/status-icons.ts';
  import type { ApiToken } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

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

  const clock = useNow();
  const now = $derived(clock.value);
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
    <caption class="visually-hidden">{t('workspace:tokens.table.caption')}</caption>
    <thead>
      <tr>
        <th scope="col">{t('workspace:tokens.table.name')}</th>
        <th scope="col">{t('workspace:tokens.table.role')}</th>
        <th scope="col">{t('workspace:tokens.table.limits')}</th>
        <th scope="col">{t('workspace:tokens.table.status')}</th>
        <th scope="col">{t('workspace:tokens.table.lastUsed')}</th>
        <th scope="col">{t('workspace:tokens.table.expires')}</th>
        {#if canManage}<th scope="col"><span class="visually-hidden">{t('workspace:tokens.table.actions')}</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each ordered as token (token.id)}
        {@const status = tokenStatus(token, now)}
        <tr class:inactive={token.status !== 'active'}>
          <td>
            <strong>{token.name}</strong>
            <div class="muted mono text-xs">{token.prefix}…</div>
            <div class="muted text-xs" title={fullTime(token.createdAt)}>{t('workspace:tokens.table.by', { name: token.createdBy.name ?? t('workspace:tokens.table.formerMember') })}</div>
          </td>
          <td><Badge icon={roleIcons[token.role]}>{t(tokenRoleLabel[token.role])}</Badge></td>
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
                  label={t('workspace:tokens.table.revokeLabel', { name: token.name })}
                  onclick={() => ask(token)}>{t('workspace:tokens.table.revoke')}</Button
                >
              {/if}
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open size="sm" title={t('workspace:tokens.table.revokeTitle')} onclose={() => (confirming = null)}>
  {#if confirming}
    <p><T key="workspace:tokens.table.revokeBody" params={{ name: confirming.name, prefix: confirming.prefix }} /></p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('workspace:tokens.table.keep')}</Button>
    <Button variant="danger-solid" onclick={confirm}>{t('workspace:tokens.table.revoke')}</Button>
  {/snippet}
</Modal>

<style>
  td,
  th {
    font-size: 0.9375rem;
  }

  .inactive td {
    opacity: 0.7;
  }
</style>
