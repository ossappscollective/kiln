<!--
  AppSettings: facts about each record of the app, the few settings that can be changed (Google Play releases, what the AI assistant
  knows) and, for admins, removing one from the workspace. Nothing in a store is changed.
  Order: a lead (is the store connected), a "Jump to" row, one titled section per subject with one sentence each, each form with its
  own sticky save bar (SaveBar), and the Danger zone last, always open, with one visible line per record on what deleting does.
  Stores, credentials, release defaults and notifications settings of an app are not all editable yet; a section says so in one
  line ("Not available yet") instead of showing empty controls.
  Props: api, workspaceId, role, members (the records in scope), all? (every record of the app), now.
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { can, type Role, supports } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { appSettingsPartIds as ids, appSettingsSections, deleteLine } from '../../lib/app-settings.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { appErrorMessage, appLabel, describeError, platformLabel, portfolioHref, storeName } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AiContextSection from './settings/AiContextSection.svelte';
  import AnalyticsSection from './settings/AnalyticsSection.svelte';
  import DefaultsSection from './settings/DefaultsSection.svelte';
  import ExpoProjectSection from '../eas/ExpoProjectSection.svelte';
  import RevenueCatSection from '../revenuecat/RevenueCatSection.svelte';
  import NotificationsSection from './settings/NotificationsSection.svelte';
  import ReleaseSettingsSection from './settings/ReleaseSettingsSection.svelte';
  import RepositorySection from './settings/RepositorySection.svelte';
  import StoresSection from './settings/StoresSection.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import { settingsLead } from '../../lib/page-lead.ts';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import JumpTo from '../settings/JumpTo.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    now,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; all?: AppSummary[] | undefined; now: number } = $props();

  const canWrite = $derived(can(role, 'apps.write'));
  const lead = $derived(settingsLead(members));
  const aiConfig = $derived(aiStore.config(workspaceId));
  /** The AI part is drawn only when the assistant is on for this workspace (the same test as AiContextSection). */
  const aiOn = $derived(can(role, 'ai.use') && aiConfig !== null && aiConfig.state !== 'off_server' && aiConfig.state !== 'off_workspace');
  const sections = $derived(appSettingsSections({ android: members.some((m) => supports(m.platform, 'releaseTracks')), ai: aiOn, canDelete: canWrite }));

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
      toast.success(t('app:settings.deleted', { name: appLabel(app) }));
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
  <JumpTo {sections} label={t('app:settings.parts')} />
  <div id={ids.stores} class="part" tabindex="-1"><StoresSection {api} {workspaceId} {role} {members} {all} {now} /></div>
  <div id={ids.repository} class="part" tabindex="-1"><RepositorySection {api} {workspaceId} {role} {members} /></div>
  <div id={ids.defaults} class="part" tabindex="-1"><DefaultsSection {api} {workspaceId} {role} {members} /></div>
  <div id="app-settings-expo" class="part" tabindex="-1"><ExpoProjectSection {api} {workspaceId} {role} {members} {now} /></div>
  <div id="app-settings-revenuecat" class="part" tabindex="-1"><RevenueCatSection {api} {workspaceId} {role} {members} {now} /></div>
  {#if members.some((m) => supports(m.platform, 'releaseTracks'))}
    <div id={ids.playReleases} class="part" tabindex="-1"><ReleaseSettingsSection {api} {workspaceId} {role} {members} /></div>
    <div id={ids.playBucket} class="part" tabindex="-1"><AnalyticsSection {api} {workspaceId} {role} {members} /></div>
  {/if}
  <div id={ids.notifications} class="part" tabindex="-1"><NotificationsSection {api} {workspaceId} {role} /></div>
  <div id={ids.ai} class="part" tabindex="-1"><AiContextSection {api} {workspaceId} {role} {members} /></div>

  <section id={ids.danger} class="part danger" tabindex="-1" aria-labelledby="app-settings-danger-title">
    <h3 id="app-settings-danger-title">{t('app:settings.dangerZone')}</h3>
    <p class="intro">{t('app:settings.dangerIntro')}</p>
    {#if canWrite}
      <ul class="plain">
        {#each members as app (app.id)}
          <li class="drow">
            <div class="who">
              <span class="row">
                <PlatformBadge platform={app.platform} tinted />
                <span class="muted"><T key="app:settings.added" params={{ when: timeAgo(app.createdAt, now) }} tags={{ link: addedTime }} /></span>
                {#snippet addedTime(text: string)}<time datetime={new Date(app.createdAt).toISOString()} title={fullTime(app.createdAt)}>{text}</time>{/snippet}
              </span>
              <p class="warning">{deleteLine(storeName(app.platform))}</p>
            </div>
            <Button
              variant="danger"
              icon="trash"
              onclick={() => {
                target = app;
                problem = '';
                open = true;
              }}>{t('app:settings.deletePlatformApp', { platform: platformLabel(app.platform) })}</Button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p class="warning">{t('app:settings.adminOnly')}</p>
    {/if}
  </section>
</div>

{#if canWrite}
  <Modal bind:open size="sm" title={t('app:settings.deleteTitle')} dismissible={!deleting}>
    {#if target}
      <div class="stack">
        <p>
          <T key="app:settings.deleteBody" params={{ name: target.name, platform: platformLabel(target.platform), identifier: target.identifier }} />
        </p>
        <p class="muted">{t('app:settings.deleteNote', { store: storeName(target.platform) })}</p>
        {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      </div>
    {/if}
    {#snippet footer()}
      <Button disabled={deleting} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
      <Button variant="danger-solid" loading={deleting} onclick={remove}>{t('app:settings.deleteApp')}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .part {
    scroll-margin-top: var(--space-4);
  }

  .part:focus {
    outline: none;
  }

  .part:empty {
    display: none;
  }

  /* Set apart at the bottom: a red edge, the warning always on screen, nothing folded. */
  .danger {
    padding: var(--space-5);
    background: var(--surface);
    border: 1px solid var(--bad-line);
    border-left: 4px solid var(--danger-solid);
    border-radius: var(--radius-xl);
  }

  .danger h3 {
    margin: 0;
    font-size: var(--text-lg);
    color: var(--bad-ink);
  }

  .intro,
  .warning {
    margin: var(--space-1) 0 0;
    font-size: 0.9375rem;
    line-height: 1.4;
    color: var(--muted);
  }

  .plain {
    padding: 0;
    margin: var(--space-4) 0 0;
    list-style: none;
  }

  .drow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-6);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) 0;
    font-size: 0.9375rem;
  }

  .drow + .drow {
    border-top: 1px solid var(--line);
  }

  .who {
    flex: 1 1 20rem;
    min-width: 0;
  }

  .who .warning {
    margin-top: var(--space-2);
  }
</style>
