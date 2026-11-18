<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import type { WebhookEndpoint } from '../../lib/types.ts';
  import { eventsSummary, hostOf, lastDeliveryLabel } from '../../lib/webhooks.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';

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
    <caption class="visually-hidden">Webhooks of this workspace</caption>
    <thead>
      <tr>
        <th scope="col">Address</th>
        <th scope="col">Events</th>
        <th scope="col">Status</th>
        <th scope="col">Last delivery</th>
        <th scope="col"><span class="visually-hidden">Actions</span></th>
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
          <td><Badge tone={endpoint.enabled ? 'ok' : 'neutral'} dot>{endpoint.enabled ? 'Enabled' : 'Disabled'}</Badge></td>
          <td class="muted" title={endpoint.lastDelivery ? fullTime(endpoint.lastDelivery.at) : ''}>
            {lastDeliveryLabel(endpoint, now)}
          </td>
          <td class="actions">
            <Button size="sm" disabled={busyId === endpoint.id} label="Deliveries of {hostOf(endpoint.url)}" onclick={() => onopen(endpoint)}>Deliveries</Button>
            {#if canManage}
              <Button size="sm" disabled={busyId === endpoint.id} label="Send a test event to {hostOf(endpoint.url)}" onclick={() => ontest(endpoint)}>Send test</Button>
              <Button size="sm" disabled={busyId === endpoint.id} label="Edit {hostOf(endpoint.url)}" onclick={() => onedit(endpoint)}>Edit</Button>
              <Button size="sm" disabled={busyId === endpoint.id} label="New secret for {hostOf(endpoint.url)}" onclick={() => ask('rotate', endpoint)}>New secret</Button>
              <Button size="sm" variant="danger" disabled={busyId === endpoint.id} label="Delete {hostOf(endpoint.url)}" onclick={() => ask('delete', endpoint)}>Delete</Button>
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
  title={asking?.kind === 'delete' ? 'Delete this webhook?' : 'Make a new signing secret?'}
  onclose={() => (asking = null)}
>
  {#if asking?.kind === 'delete'}
    <p>
      <strong>{hostOf(asking.endpoint.url)}</strong> stops receiving events, and its delivery log is deleted.
    </p>
  {:else if asking}
    <p>
      The current secret of <strong>{hostOf(asking.endpoint.url)}</strong> stops working at once, so deliveries
      fail verification until the receiver has the new one. You see the new secret once.
    </p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger-solid" onclick={confirm}>{asking?.kind === 'delete' ? 'Delete' : 'Make new secret'}</Button>
  {/snippet}
</Modal>

<style>
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
