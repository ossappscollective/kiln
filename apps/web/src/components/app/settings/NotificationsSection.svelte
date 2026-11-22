<!--
  NotificationsSection: what tells people about this app, from what exists: the low-rating threshold of the
  workspace and the webhooks that hear about the events of an app. Both are workspace wide; there is no
  per-app routing yet, and this section says so. Reads only.
  Props: api, workspaceId, role.
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { links, lowRatingText, notAvailable, webhookSummary } from '../../../lib/app-settings.ts';
  import type { WebhookEndpoint } from '../../../lib/types.ts';
  import Button from '../../ui/Button.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canSettings = $derived(can(role, 'settings.read'));
  const canHooks = $derived(can(role, 'webhooks.read'));

  let threshold = $state<number | null>(null);
  let hooks = $state<WebhookEndpoint[] | null>(null);

  $effect(() => {
    const id = workspaceId;
    untrack(() => {
      threshold = null;
      hooks = null;
    });
    let current = true;
    if (canSettings) {
      api
        .workspaceSettings(id)
        .then((s) => {
          const value = s.values['reviews.lowRatingThreshold'];
          if (current && typeof value === 'number') threshold = value;
        })
        .catch(() => {});
    }
    if (canHooks) {
      api
        .webhooks(id)
        .then((r) => {
          if (current) hooks = r.webhooks;
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  });

  const summary = $derived(hooks ? webhookSummary(hooks) : null);
</script>

<SettingsCard
  title={t('app:settings.part.notifications')}
  key="Notifications"
  icon="bell"
  description={t('app:notifications.description')}
  unavailable={notAvailable.appNotifications}
>
  <div class="stack tight">
    <p class="label">{t('app:notifications.lowRating')}</p>
    {#if !canSettings}
      <p class="muted note">{t('app:notifications.needMember')}</p>
    {:else if threshold === null}
      <p class="muted note">{t('app:defaults.reading')}</p>
    {:else}
      <p class="note">{lowRatingText(threshold)}</p>
    {/if}
    {#if canSettings}<div><Button size="sm" variant="ghost" href={links.workspaceSettings}>{t('app:notifications.workspaceSettings')}</Button></div>{/if}
  </div>
  <div class="stack tight">
    <p class="label">{t('app:notifications.webhooks')}</p>
    {#if !canHooks}
      <p class="muted note">{t('app:notifications.adminsOnly')}</p>
    {:else if summary === null}
      <p class="muted note">{t('app:defaults.reading')}</p>
    {:else}
      <p class="note">{summary.text}</p>
    {/if}
    {#if canHooks}<div><Button size="sm" variant="ghost" href={links.webhooks}>{t('app:notifications.manageWebhooks')}</Button></div>{/if}
  </div>
</SettingsCard>

<style>
  .label {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }
</style>
