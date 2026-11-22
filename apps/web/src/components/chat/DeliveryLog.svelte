<script lang="ts">
  import { onDestroy } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { type ChatDelivery, type ChatDestination, describeOutcome, inFlight, kindLabel, statusView } from '../../lib/chat/chat.ts';
  import { fullTime } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    destination,
    onclose,
  }: { api: Api; workspaceId: string; destination: ChatDestination; onclose: () => void } = $props();

  const REFRESH_MS = 3000;
  let deliveries = $state<ChatDelivery[] | null>(null);
  let error = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    try {
      deliveries = (await api.chatDeliveries(workspaceId, destination.id)).deliveries;
      error = '';
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('chat:log.loadFailed');
    }
  }

  $effect(() => {
    void destination.id;
    void load();
  });
  // Look again every few seconds while something is still on its way.
  $effect(() => {
    clearTimeout(timer);
    if (deliveries && inFlight(deliveries)) timer = setTimeout(() => void load(), REFRESH_MS);
    return () => clearTimeout(timer);
  });
  onDestroy(() => clearTimeout(timer));
</script>

<div class="card log" role="region" aria-label={t('chat:log.region', { name: destination.name })}>
  <div class="head row">
    <h3>{t('chat:log.title')}</h3>
    <span class="muted text-sm truncate">{destination.name}</span>
    <span class="spacer"></span>
    <Button size="sm" icon="refresh" onclick={() => void load()}>{t('chat:log.refresh')}</Button>
    <Button size="sm" onclick={onclose}>{t('chat:log.close')}</Button>
  </div>
  {#if error}<Alert tone="error">{error}</Alert>{/if}

  {#if deliveries === null && !error}
    <p class="muted">{t('chat:log.loading')}</p>
  {:else if deliveries && deliveries.length === 0}
    <p class="muted">{t('chat:log.empty')}</p>
  {:else if deliveries}
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">{t('chat:log.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chat:log.colWhen')}</th>
            <th scope="col">{t('chat:log.colKind')}</th>
            <th scope="col">{t('chat:log.colWhat')}</th>
            <th scope="col">{t('chat:log.colStatus')}</th>
            <th scope="col">{t('chat:log.colResult')}</th>
          </tr>
        </thead>
        <tbody>
          {#each deliveries as delivery (delivery.id)}
            {@const view = statusView(delivery.status)}
            <tr>
              <td class="muted" title={fullTime(delivery.createdAt)}>{fullTime(delivery.createdAt)}</td>
              <td>{kindLabel(delivery.kind)}</td>
              <td>{delivery.title ?? '—'}</td>
              <td><Badge tone={view.tone} icon={toneIcon(view.tone)}>{view.label}</Badge></td>
              <td class="muted">
                {describeOutcome(delivery.outcome)}
                {#if delivery.httpStatus !== null}<div class="text-xs">{t('chat:log.answer', { code: delivery.httpStatus })}{#if delivery.attempts > 1} · {t('chat:log.attempts', { count: delivery.attempts })}{/if}</div>{/if}
              </td>
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
</style>
