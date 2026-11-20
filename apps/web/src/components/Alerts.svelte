<!--
  Alerts: the alert inbox, a person's own choices, the workspace rules (admins) and the delivery log (docs/alerts.md). The catalog,
  the person's settings and the apps are read here once and handed to the tabs. Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { CatalogEntry, SettingsPage } from '../lib/alerts.ts';
  import AlertInbox from './alerts/AlertInbox.svelte';
  import AlertLog from './alerts/AlertLog.svelte';
  import AlertRules from './alerts/AlertRules.svelte';
  import AlertSettings from './alerts/AlertSettings.svelte';
  import Alert from './ui/Alert.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Tabs from './ui/Tabs.svelte';
  import { alertStore } from '../lib/alert-store.svelte.ts';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canWrite = $derived(can(role, 'alerts.write'));
  const isAdmin = $derived(can(role, 'alerts.manage'));

  let catalog = $state<CatalogEntry[] | null>(null);
  let page = $state<SettingsPage | null>(null);
  let apps = $state<{ id: string; name: string }[]>([]);
  let error = $state('');
  let tab = $state('inbox');

  const tabs = $derived(
    ([{ id: 'inbox', label: 'Inbox', ...(alertStore.unread > 0 ? { count: alertStore.unread } : {}) }] as { id: string; label: string; count?: number }[])
      .concat(canWrite ? [{ id: 'mine', label: 'My alerts' }] : [])
      .concat(isAdmin ? [{ id: 'rules', label: 'Workspace rules' }] : [])
      .concat([{ id: 'log', label: 'Delivery log' }]),
  );

  async function load() {
    error = '';
    try {
      const [c, s] = await Promise.all([api.alertCatalog(workspaceId), api.alertSettings(workspaceId)]);
      catalog = c.catalog;
      page = s;
    } catch (e) {
      catalog = null;
      page = null;
      error = e instanceof ApiError ? e.message : 'Could not load the alert settings.';
    }
  }

  async function loadSettings() {
    try {
      page = await api.alertSettings(workspaceId);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not reload the alert settings.';
    }
  }

  $effect(() => {
    void workspaceId;
    catalog = null;
    page = null;
    apps = [];
    tab = 'inbox';
    void load();
    // The apps only name things in the lists; without them the lists say "An app".
    api
      .apps(workspaceId)
      .then((r) => (apps = r.apps.map((a) => ({ id: a.id, name: a.name }))))
      .catch(() => (apps = []));
  });
</script>

<section>
  <PageHeader title="Alerts" description="What needs you first, then how you hear about it: email, desktop notifications and webhooks." />
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <Tabs {tabs} bind:value={tab} label="Alerts">
    {#snippet panel(id)}
      {#if id === 'inbox'}
        <AlertInbox {api} {workspaceId} {apps} onchange={loadSettings} />
      {:else if id === 'mine'}
        {#if catalog && page}
          <AlertSettings {api} {workspaceId} {catalog} {page} {apps} onreload={loadSettings} />
        {:else if !error}
          <p class="muted" role="status">Loading your alert settings.</p>
        {/if}
      {:else if id === 'rules'}
        {#if catalog}
          <AlertRules {api} {workspaceId} {catalog} onsaved={load} />
        {:else if !error}
          <p class="muted" role="status">Loading the workspace rules.</p>
        {/if}
      {:else}
        <AlertLog {api} {workspaceId} {isAdmin} />
      {/if}
    {/snippet}
  </Tabs>
</section>
