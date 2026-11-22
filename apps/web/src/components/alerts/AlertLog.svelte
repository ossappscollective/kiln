<!--
  AlertLog: the delivery log, newest first: what was sent where, with the result in a sentence (never text from a mail server). A
  person sees their own deliveries; admins can switch to the whole workspace. Props: api, workspaceId, isAdmin.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { type Delivery, channelLabel, describeOutcome, statusLabel, statusTone } from '../../lib/alerts/alerts.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';

  let { api, workspaceId, isAdmin }: { api: Api; workspaceId: string; isAdmin: boolean } = $props();

  let whole = $state(false);
  let rows = $state<Delivery[] | null>(null);
  let error = $state('');
  let loading = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      rows = (await api.alertDeliveries(workspaceId, { workspace: isAdmin && whole, limit: 50 })).deliveries;
    } catch (e) {
      rows = null;
      error = e instanceof ApiError ? e.message : t('workspace:alerts.log.loadFailed');
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void workspaceId;
    void whole;
    rows = null;
    void load();
  });

  const kindLabel = (kind: Delivery['kind']) =>
    kind === 'digest' ? t('workspace:alerts.log.kindDigest') : kind === 'test' ? t('workspace:alerts.log.kindTest') : t('workspace:alerts.log.kindAlert');
</script>

<div class="stack">
  <div class="row between wrap">
    {#if isAdmin}
      <label class="check"><input type="checkbox" bind:checked={whole} /> {t('workspace:alerts.log.everyone')}</label>
    {:else}
      <span class="muted">{t('workspace:alerts.log.mine')}</span>
    {/if}
    <Button icon="refresh" {loading} onclick={load}>{t('workspace:alerts.log.refresh')}</Button>
  </div>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if rows === null && !error}
    <p class="muted" role="status">{t('workspace:alerts.log.loading')}</p>
  {:else if rows !== null && rows.length === 0}
    <EmptyState icon="bell" title={t('workspace:alerts.log.emptyTitle')} description={t('workspace:alerts.log.emptyText')} />
  {:else if rows !== null}
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">{t('workspace:alerts.log.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('workspace:alerts.log.colWhen')}</th>
            <th scope="col">{t('workspace:alerts.log.colWhat')}</th>
            <th scope="col">{t('workspace:alerts.log.colChannel')}</th>
            <th scope="col">{t('workspace:alerts.log.colResult')}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as d (d.id)}
            <tr>
              <td><time datetime={new Date(d.createdAt).toISOString()} title={fullTime(d.createdAt)}>{timeAgo(d.createdAt)}</time></td>
              <td>{d.title ? t('workspace:alerts.log.what', { kind: kindLabel(d.kind), title: d.title }) : kindLabel(d.kind)}</td>
              <td>{channelLabel(d.channel)}</td>
              <td>
                <Badge tone={statusTone(d.status)}>{statusLabel(d.status)}</Badge>
                {describeOutcome(d.outcome)}
                {#if d.attempts > 1}<span class="muted"> {t('workspace:alerts.log.attempts', { count: d.attempts })}</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  td,
  th {
    font-size: 0.9375rem;
  }
</style>
