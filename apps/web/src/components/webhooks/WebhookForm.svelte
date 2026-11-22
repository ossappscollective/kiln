<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { CreatedWebhook, WebhookEndpoint } from '../../lib/types.ts';
  import {
    createWebhookInput,
    emptyWebhookForm,
    formFromEndpoint,
    patchFor,
    validateWebhookForm,
    webhookEventChoices,
  } from '../../lib/webhooks.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    endpoint,
    oncreated,
    onsaved,
    oncancel,
  }: {
    api: Api;
    workspaceId: string;
    /** Set to edit this webhook; leave out to make a new one. */
    endpoint?: WebhookEndpoint | undefined;
    oncreated?: ((created: CreatedWebhook) => void) | undefined;
    onsaved?: ((endpoint: WebhookEndpoint) => void) | undefined;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  const initial = (() => (endpoint ? formFromEndpoint(endpoint) : emptyWebhookForm()))();

  let url = $state(initial.url);
  let description = $state(initial.description);
  let all = $state(initial.all);
  let types = $state<string[]>(initial.types);
  let enabled = $state(initial.enabled);
  let busy = $state(false);
  let error = $state('');
  let showProblems = $state(false);

  const form = $derived({ url, description, all, types, enabled });
  const problems = $derived(validateWebhookForm(form));

  onMount(() => document.getElementById(`${uid}-url`)?.focus());

  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((v) => v !== value);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    showProblems = true;
    if (problems.url || problems.types) return;
    busy = true;
    error = '';
    try {
      if (endpoint) {
        const patch = patchFor(endpoint, form);
        if (Object.keys(patch).length === 0) return oncancel();
        onsaved?.((await api.updateWebhook(workspaceId, endpoint.id, patch)).webhook);
      } else {
        oncreated?.(await api.createWebhook(workspaceId, createWebhookInput(form)));
      }
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('common:error.genericRetry');
    } finally {
      busy = false;
    }
  }
</script>

<form class="card" onsubmit={submit} novalidate>
  <div class="card-header">
    <div>
      <h3>{endpoint ? t('workspace:webhooks.form.titleEdit') : t('workspace:webhooks.form.titleNew')}</h3>
      <p>{t('workspace:webhooks.form.description')}</p>
    </div>
  </div>

  <div class="stack">
    <TextField
      label={t('workspace:webhooks.form.address')}
      id="{uid}-url"
      type="url"
      bind:value={url}
      placeholder="https://example.com/hooks/kiln"
      autocomplete="off"
      error={showProblems ? problems.url : undefined}
    />
    <TextField label={t('workspace:webhooks.form.descriptionLabel')} bind:value={description} maxlength={200} autocomplete="off" hint={t('workspace:webhooks.form.descriptionHint')} />

    <fieldset class="events">
      <legend>{t('workspace:webhooks.form.eventsLegend')}</legend>
      <label class="check">
        <input type="checkbox" bind:checked={all} />
        <span>{t('workspace:webhooks.form.allEvents')}</span>
      </label>
      {#if !all}
        <div class="choices" role="group" aria-label={t('workspace:webhooks.form.eventsGroup')}>
          {#each webhookEventChoices as choice (choice.type)}
            <label class="check">
              <input
                type="checkbox"
                checked={types.includes(choice.type)}
                onchange={(e) => (types = toggle(types, choice.type, e.currentTarget.checked))}
              />
              <span>{t(choice.labelKey)} <span class="muted mono text-xs">{choice.type}</span></span>
            </label>
          {/each}
        </div>
        {#if showProblems && problems.types}<p class="field-error" role="alert">{problems.types}</p>{/if}
      {/if}
    </fieldset>

    <label class="check">
      <input type="checkbox" bind:checked={enabled} />
      <span>{t('workspace:webhooks.form.enabled')}</span>
    </label>

    {#if error}<Alert tone="error">{error}</Alert>{/if}

    <div class="row actions">
      <Button type="submit" variant="primary" loading={busy}>
        {#if endpoint}{busy ? t('workspace:webhooks.form.saving') : t('workspace:webhooks.form.save')}{:else}{busy ? t('workspace:webhooks.form.creating') : t('workspace:webhooks.form.create')}{/if}
      </Button>
      <Button onclick={oncancel} disabled={busy}>{t('common:action.cancel')}</Button>
    </div>
  </div>
</form>

<style>
  .events {
    padding: 0;
    margin: 0;
    border: 0;
  }

  .events legend {
    padding: 0;
    margin-bottom: 6px;
    font-weight: 600;
  }

  .choices {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    margin-top: 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .actions {
    margin-top: 4px;
  }
</style>
