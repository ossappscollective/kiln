<!--
  AppSettings: facts about each record of the app and, for admins, removing one from the workspace.
  Nothing in a store is changed. Stores, credentials, release defaults and notifications settings
  of an app are not built yet; this page says so instead of showing empty controls.
  Props: api, workspaceId, role, members (the records in scope), all? (every record of the app), now.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { appErrorMessage, appLabel, describeError, platformLabel, portfolioHref, storeName } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AiContextSection from './settings/AiContextSection.svelte';
  import AnalyticsSection from './settings/AnalyticsSection.svelte';
  import DefaultsSection from './settings/DefaultsSection.svelte';
  import NotificationsSection from './settings/NotificationsSection.svelte';
  import ReleaseSettingsSection from './settings/ReleaseSettingsSection.svelte';
  import RepositorySection from './settings/RepositorySection.svelte';
  import SettingsCard from './settings/SettingsCard.svelte';
  import StoresSection from './settings/StoresSection.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import { settingsLead } from '../../lib/page-lead.ts';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    now,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; all?: AppSummary[]; now: number } = $props();

  const canWrite = $derived(can(role, 'apps.write'));
  const lead = $derived(settingsLead(members));

  let target = $state<AppSummary | null>(null);
  let open = $state(false);
  let deleting = $state(false);
  let problem = $state('');

  async function remove() {
    if (!target) return;
    const app = target;
    deleting = true;
    problem = '';
    try {
      await api.deleteApp(workspaceId, app.id);
      open = false;
      toast.success(`Deleted ${appLabel(app)}. Nothing in the store was changed.`);
      location.hash = portfolioHref;
    } catch (e) {
      problem = e instanceof ApiError ? appErrorMessage(e, 'delete') : describeError(e, 'delete');
    } finally {
      deleting = false;
    }
  }
</script>

<div class="stack loose">
  <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="settings-lead">
    {#snippet actions()}<SectionsToggle />{/snippet}
  </PageLead>
  <StoresSection {api} {workspaceId} {role} {members} {all} {now} />
  <RepositorySection {api} {workspaceId} {role} {members} />
  <DefaultsSection {api} {workspaceId} {role} {members} />
  <ReleaseSettingsSection {api} {workspaceId} {role} {members} />
  <AnalyticsSection {api} {workspaceId} {role} {members} />
  <NotificationsSection {api} {workspaceId} {role} />
  <AiContextSection {api} {workspaceId} {role} {members} />

  <SettingsCard
    title="Danger zone"
    icon="trash"
    defaultOpen={false}
    description="Removing an app deletes its stored releases, reviews and plans from this workspace. Nothing in the store is changed, and you can add the app again later."
  >
    {#if canWrite}
      <div class="stack">
        {#each members as app (app.id)}
          <div class="row between">
            <span class="row">
              <PlatformBadge platform={app.platform} tinted />
              <span class="muted">Added <time datetime={new Date(app.createdAt).toISOString()} title={fullTime(app.createdAt)}>{timeAgo(app.createdAt, now)}</time></span>
            </span>
            <Button
              variant="danger"
              icon="trash"
              onclick={() => {
                target = app;
                problem = '';
                open = true;
              }}>Delete {platformLabel(app.platform)} app</Button
            >
          </div>
        {/each}
      </div>
    {:else}
      <p class="muted note">Only an admin can remove an app.</p>
    {/if}
  </SettingsCard>
</div>

{#if canWrite}
  <Modal bind:open size="sm" title="Delete this app?" dismissible={!deleting}>
    {#if target}
      <div class="stack">
        <p>
          <strong>{target.name}</strong> ({platformLabel(target.platform)}, {target.identifier}) and its stored releases will be removed from this workspace.
        </p>
        <p class="muted">Nothing in {storeName(target.platform)} is changed. You can add the app again later.</p>
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      </div>
    {/if}
    {#snippet footer()}
      <Button disabled={deleting} onclick={() => (open = false)}>Cancel</Button>
      <Button variant="danger-solid" loading={deleting} onclick={remove}>Delete app</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
