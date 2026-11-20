<!--
  AlertLog: the delivery log, newest first: what was sent where, with the result in a sentence (never text from a mail server). A
  person sees their own deliveries; admins can switch to the whole workspace. Props: api, workspaceId, isAdmin.
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { type Delivery, channelLabels, describeOutcome, statusLabels, statusTone } from '../../lib/alerts.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
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
      error = e instanceof ApiError ? e.message : 'Could not load the delivery log.';
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

  const kindLabel = (k: Delivery['kind']) => (k === 'digest' ? 'Digest' : k === 'test' ? 'Test' : 'Alert');
</script>

<div class="stack">
  <div class="row between wrap">
    {#if isAdmin}
      <label class="check"><input type="checkbox" bind:checked={whole} /> Everyone in the workspace</label>
    {:else}
      <span class="muted">Your deliveries</span>
    {/if}
    <Button icon="refresh" {loading} onclick={load}>Refresh</Button>
  </div>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if rows === null && !error}
    <p class="muted" role="status">Loading the delivery log.</p>
  {:else if rows !== null && rows.length === 0}
    <EmptyState icon="bell" title="Nothing delivered yet" description="Every email, desktop notification and webhook is listed here with its result." />
  {:else if rows !== null}
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">Alert deliveries, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            <th scope="col">Channel</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as d (d.id)}
            <tr>
              <td><time datetime={new Date(d.createdAt).toISOString()} title={fullTime(d.createdAt)}>{timeAgo(d.createdAt)}</time></td>
              <td>{kindLabel(d.kind)}{d.title ? `: ${d.title}` : ''}</td>
              <td>{channelLabels[d.channel]}</td>
              <td>
                <Badge tone={statusTone(d.status)}>{statusLabels[d.status] ?? d.status}</Badge>
                {describeOutcome(d.outcome)}
                {#if d.attempts > 1}<span class="muted"> ({d.attempts} attempts)</span>{/if}
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
