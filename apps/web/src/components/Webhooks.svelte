<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { WebhookEndpoint } from '../lib/types.ts';
  import { hostOf, verifySnippet } from '../lib/webhooks.ts';
  import OneTimeSecret from './automation/OneTimeSecret.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import DeliveryLog from './webhooks/DeliveryLog.svelte';
  import WebhookForm from './webhooks/WebhookForm.svelte';
  import WebhookTable from './webhooks/WebhookTable.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'webhooks.read'));
  const canManage = $derived(can(role, 'webhooks.manage'));

  let webhooks = $state<WebhookEndpoint[] | null>(null);
  let error = $state('');
  let notice = $state('');
  let noticeEl = $state<HTMLElement>();
  let adding = $state(false);
  let editing = $state<WebhookEndpoint | null>(null);
  let viewing = $state<WebhookEndpoint | null>(null);
  /** The signing secret, kept only in this component's memory until it is dismissed. */
  let secret = $state<{ value: string; address: string } | null>(null);
  let busyId = $state('');

  async function load() {
    error = '';
    try {
      webhooks = (await api.webhooks(workspaceId)).webhooks;
      // Keep the open log pointing at fresh data about its webhook.
      if (viewing) viewing = webhooks.find((w) => w.id === viewing?.id) ?? null;
    } catch (e) {
      webhooks = null;
      error = e instanceof ApiError ? e.message : 'Could not load webhooks.';
    }
  }

  $effect(() => {
    void workspaceId;
    webhooks = null;
    adding = false;
    editing = null;
    viewing = null;
    secret = null;
    notice = '';
    if (canRead) void load();
  });

  async function announce(message: string) {
    notice = message;
    await tick();
    noticeEl?.focus();
  }

  async function oncreated(result: { webhook: WebhookEndpoint; secret: string }) {
    adding = false;
    secret = { value: result.secret, address: hostOf(result.webhook.url) };
    notice = '';
    await load();
  }

  async function onsaved(endpoint: WebhookEndpoint) {
    editing = null;
    await load();
    await announce(`Saved changes to ${hostOf(endpoint.url)}.`);
  }

  async function run(endpoint: WebhookEndpoint, fallback: string, work: () => Promise<void>) {
    busyId = endpoint.id;
    error = '';
    try {
      await work();
    } catch (e) {
      error = e instanceof ApiError ? e.message : fallback;
    } finally {
      busyId = '';
    }
  }

  const test = (endpoint: WebhookEndpoint) =>
    run(endpoint, 'Could not send the test event.', async () => {
      await api.testWebhook(workspaceId, endpoint.id);
      viewing = endpoint;
      await announce(`Sent a test event to ${hostOf(endpoint.url)}. The result appears in the deliveries.`);
    });

  const rotate = (endpoint: WebhookEndpoint) =>
    run(endpoint, 'Could not make a new secret.', async () => {
      const result = await api.rotateWebhookSecret(workspaceId, endpoint.id);
      secret = { value: result.secret, address: hostOf(endpoint.url) };
      notice = '';
    });

  const remove = (endpoint: WebhookEndpoint) =>
    run(endpoint, 'Could not delete the webhook.', async () => {
      await api.deleteWebhook(workspaceId, endpoint.id);
      if (viewing?.id === endpoint.id) viewing = null;
      if (editing?.id === endpoint.id) editing = null;
      await load();
      await announce(`Deleted the webhook for ${hostOf(endpoint.url)}.`);
    });
</script>

<section>
  <PageHeader
    title="Webhooks"
    description="Send a signed message to your own server when something happens here, such as a change set being applied or a release changing status."
  >
    {#snippet actions()}
      {#if canManage && !adding && !editing}
        <Button
          variant="primary"
          icon="plus"
          id="new-webhook"
          onclick={() => {
            adding = true;
            secret = null;
            notice = '';
          }}>New webhook</Button
        >
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">Your role does not include webhooks. Owners and admins manage them.</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>
    {#if error}<div class="block"><Alert tone="error">{error}</Alert></div>{/if}

    {#if secret}
      <div class="block">
        <OneTimeSecret
          title="Signing secret for {secret.address}"
          label="Webhook signing secret"
          value={secret.value}
          warning="Your receiver uses this secret to check that a message really came from this server. Store it in your secret manager. If it leaks, make a new one."
          ondismiss={() => (secret = null)}
        >
          <details>
            <summary>How to verify a delivery</summary>
            <p class="hint">
              Each request has <span class="mono">X-MRM-Timestamp</span> and <span class="mono">X-MRM-Signature</span>
              headers. The signature is <span class="mono">v1=</span> and the hex HMAC-SHA256 of the timestamp, a dot and
              the raw body, keyed with the secret.
            </p>
            <pre class="mono text-xs">{verifySnippet}</pre>
          </details>
        </OneTimeSecret>
      </div>
    {/if}

    {#if adding}
      <div class="block">
        <WebhookForm
          {api}
          {workspaceId}
          {oncreated}
          oncancel={async () => {
            adding = false;
            await tick();
            document.getElementById('new-webhook')?.focus();
          }}
        />
      </div>
    {/if}

    {#if editing}
      <div class="block">
        <WebhookForm {api} {workspaceId} endpoint={editing} {onsaved} oncancel={() => (editing = null)} />
      </div>
    {/if}

    {#if webhooks === null && !error}
      <p class="muted">Loading…</p>
    {:else if webhooks && webhooks.length === 0 && !adding && !secret}
      <EmptyState
        icon="globe"
        title="No webhooks yet"
        description="Add one to hear about releases, change sets and failed credential tests as they happen."
      />
    {:else if webhooks && webhooks.length > 0}
      <WebhookTable
        {webhooks}
        {canManage}
        {busyId}
        onopen={(endpoint) => (viewing = endpoint)}
        ontest={test}
        onedit={(endpoint) => {
          editing = endpoint;
          adding = false;
        }}
        onrotate={rotate}
        ondelete={remove}
      />
    {/if}

    {#if viewing}
      <div class="block log">
        <DeliveryLog {api} {workspaceId} endpoint={viewing} {canManage} onclose={() => (viewing = null)} />
      </div>
    {/if}

    <p class="hint footer">
      Messages go to https addresses on the public internet only. A message that fails is tried again a few
      times, then marked failed; you can send it again from its deliveries.
    </p>
  {/if}
</section>

<style>
  .block {
    margin-bottom: 20px;
  }

  .log {
    margin-top: 20px;
  }

  .footer {
    margin-top: 16px;
  }

  pre {
    padding: 10px 12px;
    margin: 8px 0 0;
    overflow-x: auto;
    background: var(--surface-sunken);
    border-radius: 6px;
  }

  .notice {
    display: none;
    padding: 10px 12px;
    margin: 0 0 16px;
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-radius: 6px;
  }

  .notice.shown {
    display: block;
  }
</style>
