<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import type { WebhookDelivery, WebhookEndpoint } from '../../lib/types.ts';
  import { canRedeliver, deliveryDetail, deliveryView } from '../../lib/webhooks.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    endpoint,
    canManage,
    onclose,
  }: {
    api: Api;
    workspaceId: string;
    endpoint: WebhookEndpoint;
    canManage: boolean;
    onclose: () => void;
  } = $props();

  const REFRESH_MS = 3000;

  let deliveries = $state<WebhookDelivery[] | null>(null);
  let error = $state('');
  let notice = $state('');
  let busyId = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unfinished = $derived(deliveries?.some((d) => d.status === 'pending' || d.status === 'retrying') ?? false);

  async function load() {
    try {
      deliveries = (await api.webhookDeliveries(workspaceId, endpoint.id)).deliveries;
      error = '';
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not load the deliveries.';
    }
  }

  // Look again every few seconds while something is still on its way.
  $effect(() => {
    void endpoint.id;
    void load();
  });
  $effect(() => {
    clearTimeout(timer);
    if (unfinished) timer = setTimeout(() => void load(), REFRESH_MS);
    return () => clearTimeout(timer);
  });
  onDestroy(() => clearTimeout(timer));

  async function again(delivery: WebhookDelivery) {
    busyId = delivery.id;
    error = '';
    notice = '';
    try {
      await api.redeliverWebhook(workspaceId, endpoint.id, delivery.id);
      notice = 'Queued to send again.';
      await load();
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not send it again.';
    } finally {
      busyId = '';
    }
  }
</script>

<div class="card log" role="region" aria-label="Deliveries to {endpoint.url}">
  <div class="head row">
    <h3>Deliveries</h3>
    <span class="muted mono text-sm truncate">{endpoint.url}</span>
    <span class="spacer"></span>
    <Button size="sm" icon="refresh" onclick={() => void load()}>Refresh</Button>
    <Button size="sm" onclick={onclose}>Close</Button>
  </div>
  <p class="visually-hidden" role="status">{notice}</p>
  {#if notice}<Alert tone="ok">{notice}</Alert>{/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}

  {#if deliveries === null && !error}
    <p class="muted">Loading…</p>
  {:else if deliveries && deliveries.length === 0}
    <p class="muted">Nothing was sent yet. Send a test event, or wait for the next real one.</p>
  {:else if deliveries}
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">Recent deliveries, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Status</th>
            <th scope="col">Result</th>
            <th scope="col">Sent</th>
            {#if canManage}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each deliveries as delivery (delivery.id)}
            {@const view = deliveryView(delivery.status)}
            <tr>
              <td>
                <span class="mono text-sm">{delivery.eventType}</span>
                {#if delivery.redeliveryOf}<div class="muted text-xs">Sent again</div>{/if}
              </td>
              <td><Badge tone={view.tone} icon={toneIcon(view.tone)}>{view.label}</Badge></td>
              <td class="muted">
                {deliveryDetail(delivery) || '—'}
                {#if delivery.responseBody}
                  <details class="more">
                    <summary>What the receiver said</summary>
                    <pre class="mono text-xs">{delivery.responseBody}</pre>
                  </details>
                {/if}
              </td>
              <td class="muted" title={fullTime(delivery.createdAt)}>{fullTime(delivery.createdAt)}</td>
              {#if canManage}
                <td class="actions">
                  {#if canRedeliver(delivery)}
                    <Button
                      size="sm"
                      disabled={busyId === delivery.id}
                      label="Send {delivery.eventType} again"
                      onclick={() => again(delivery)}>Send again</Button
                    >
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .log {
    display: grid;
    gap: 12px;
  }

  .head {
    gap: 12px;
  }

  .head h3 {
    margin: 0;
  }

  pre {
    max-width: 420px;
    padding: 8px 10px;
    margin: 6px 0 0;
    overflow: auto;
    white-space: pre-wrap;
    background: var(--surface-sunken);
    border-radius: var(--radius-sm);
  }
</style>
