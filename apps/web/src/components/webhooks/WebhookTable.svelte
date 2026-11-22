<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import type { WebhookEndpoint } from '../../lib/types.ts';
  import { eventsSummary, hostOf, lastDeliveryLabel } from '../../lib/webhooks.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';

  type Ask = { kind: 'delete' | 'rotate'; endpoint: WebhookEndpoint };

  let {
    webhooks,
    canManage,
    busyId,
    onopen,
    ontest,
    onedit,
    onrotate,
    ondelete,
  }: {
    webhooks: WebhookEndpoint[];
    canManage: boolean;
    busyId: string;
    onopen: (endpoint: WebhookEndpoint) => void;
    ontest: (endpoint: WebhookEndpoint) => void;
    onedit: (endpoint: WebhookEndpoint) => void;
    onrotate: (endpoint: WebhookEndpoint) => void;
    ondelete: (endpoint: WebhookEndpoint) => void;
  } = $props();

  const now = $derived(Date.now());
  let asking = $state<Ask | null>(null);
  let open = $state(false);

  function ask(kind: Ask['kind'], endpoint: WebhookEndpoint) {
    asking = { kind, endpoint };
    open = true;
  }

  function confirm() {
    const current = asking;
    open = false;
    if (!current) return;
    if (current.kind === 'delete') ondelete(current.endpoint);
    else onrotate(current.endpoint);
  }
</script>

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">{t('workspace:webhooks.table.caption')}</caption>
    <thead>
      <tr>
        <th scope="col">{t('workspace:webhooks.table.address')}</th>
        <th scope="col">{t('workspace:webhooks.table.events')}</th>
        <th scope="col">{t('workspace:webhooks.table.status')}</th>
        <th scope="col">{t('workspace:webhooks.table.lastDelivery')}</th>
        <th scope="col"><span class="visually-hidden">{t('workspace:webhooks.table.actions')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each webhooks as endpoint (endpoint.id)}
        <tr class:inactive={!endpoint.enabled}>
          <td>
            <strong title={endpoint.url}>{hostOf(endpoint.url)}</strong>
            {#if endpoint.description}<div class="muted text-sm">{endpoint.description}</div>{/if}
            <div class="muted text-xs truncate" title={endpoint.url}>{endpoint.url}</div>
          </td>
          <td class="muted" title={endpoint.eventTypes.join(', ')}>{eventsSummary(endpoint)}</td>
          <td><Badge tone={endpoint.enabled ? 'ok' : 'neutral'} icon={toneIcon(endpoint.enabled ? 'ok' : 'neutral')}>{endpoint.enabled ? t('workspace:webhooks.table.enabled') : t('workspace:webhooks.table.disabled')}</Badge></td>
          <td class="muted" title={endpoint.lastDelivery ? fullTime(endpoint.lastDelivery.at) : ''}>
            {lastDeliveryLabel(endpoint, now)}
          </td>
          <td class="actions">
            <Button size="sm" disabled={busyId === endpoint.id} label={t('workspace:webhooks.table.deliveriesLabel', { host: hostOf(endpoint.url) })} onclick={() => onopen(endpoint)}>{t('workspace:webhooks.table.deliveries')}</Button>
            {#if canManage}
              <Button size="sm" disabled={busyId === endpoint.id} label={t('workspace:webhooks.table.testLabel', { host: hostOf(endpoint.url) })} onclick={() => ontest(endpoint)}>{t('workspace:webhooks.table.test')}</Button>
              <Button size="sm" disabled={busyId === endpoint.id} label={t('workspace:webhooks.table.editLabel', { host: hostOf(endpoint.url) })} onclick={() => onedit(endpoint)}>{t('workspace:webhooks.table.edit')}</Button>
              <Button size="sm" disabled={busyId === endpoint.id} label={t('workspace:webhooks.table.secretLabel', { host: hostOf(endpoint.url) })} onclick={() => ask('rotate', endpoint)}>{t('workspace:webhooks.table.secret')}</Button>
              <Button size="sm" variant="danger" disabled={busyId === endpoint.id} label={t('workspace:webhooks.table.deleteLabel', { host: hostOf(endpoint.url) })} onclick={() => ask('delete', endpoint)}>{t('workspace:webhooks.table.delete')}</Button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal
  bind:open
  size="sm"
  title={asking?.kind === 'delete' ? t('workspace:webhooks.table.deleteTitle') : t('workspace:webhooks.table.rotateTitle')}
  onclose={() => (asking = null)}
>
  {#if asking?.kind === 'delete'}
    <p><T key="workspace:webhooks.table.deleteBody" params={{ host: hostOf(asking.endpoint.url) }} /></p>
  {:else if asking}
    <p><T key="workspace:webhooks.table.rotateBody" params={{ host: hostOf(asking.endpoint.url) }} /></p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button variant="danger-solid" onclick={confirm}>{asking?.kind === 'delete' ? t('workspace:webhooks.table.delete') : t('workspace:webhooks.table.makeSecret')}</Button>
  {/snippet}
</Modal>

<style>
  td,
  th {
    font-size: 0.9375rem;
  }

  .inactive td {
    opacity: 0.75;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  td strong {
    overflow-wrap: anywhere;
  }
</style>
