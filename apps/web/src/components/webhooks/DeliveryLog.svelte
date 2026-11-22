<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
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
      error = e instanceof ApiError ? e.message : t('workspace:webhooks.log.loadFailed');
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
      notice = t('workspace:webhooks.log.queued');
      await load();
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('workspace:webhooks.log.resendFailed');
    } finally {
      busyId = '';
    }
  }
</script>

<div class="card log" role="region" aria-label={t('workspace:webhooks.log.region', { url: endpoint.url })}>
  <div class="head row">
    <h3>{t('workspace:webhooks.log.title')}</h3>
    <span class="muted mono text-sm truncate">{endpoint.url}</span>
    <span class="spacer"></span>
    <Button size="sm" icon="refresh" onclick={() => void load()}>{t('workspace:webhooks.log.refresh')}</Button>
    <Button size="sm" onclick={onclose}>{t('workspace:webhooks.log.close')}</Button>
  </div>
  <p class="visually-hidden" role="status">{notice}</p>
  {#if notice}<Alert tone="ok">{notice}</Alert>{/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}

  {#if deliveries === null && !error}
    <p class="muted">{t('workspace:webhooks.log.loading')}</p>
  {:else if deliveries && deliveries.length === 0}
    <p class="muted">{t('workspace:webhooks.log.empty')}</p>
  {:else if deliveries}
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">{t('workspace:webhooks.log.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('workspace:webhooks.log.colEvent')}</th>
            <th scope="col">{t('workspace:webhooks.log.colStatus')}</th>
            <th scope="col">{t('workspace:webhooks.log.colResult')}</th>
            <th scope="col">{t('workspace:webhooks.log.colSent')}</th>
            {#if canManage}<th scope="col"><span class="visually-hidden">{t('workspace:webhooks.log.colActions')}</span></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each deliveries as delivery (delivery.id)}
            {@const view = deliveryView(delivery.status)}
            <tr>
              <td>
                <span class="mono text-sm">{delivery.eventType}</span>
                {#if delivery.redeliveryOf}<div class="muted text-xs">{t('workspace:webhooks.log.sentAgain')}</div>{/if}
              </td>
              <td><Badge tone={view.tone} icon={toneIcon(view.tone)}>{view.label}</Badge></td>
              <td class="muted">
                {deliveryDetail(delivery) || '—'}
                {#if delivery.responseBody}
                  <details class="more">
                    <summary>{t('workspace:webhooks.log.receiverSaid')}</summary>
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
                      label={t('workspace:webhooks.log.sendAgainLabel', { event: delivery.eventType })}
                      onclick={() => again(delivery)}>{t('workspace:webhooks.log.sendAgain')}</Button
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
