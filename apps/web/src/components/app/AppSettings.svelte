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
  import { appSettingsGroups, appSettingsPartIds as ids, deleteLine, resolveAppSettingsSection } from '../../lib/app-settings.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { appErrorMessage, appLabel, describeError, platformLabel, portfolioHref, storeName } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AiContextSection from './settings/AiContextSection.svelte';
  import AiReviewPrivacySection from './settings/AiReviewPrivacySection.svelte';
  import AnalyticsSection from './settings/AnalyticsSection.svelte';
  import DefaultsSection from './settings/DefaultsSection.svelte';
  import AdsSettingsSection from '../ads/AdsSettingsSection.svelte';
  import ExpoProjectSection from '../eas/ExpoProjectSection.svelte';
  import RevenueCatSection from '../revenuecat/RevenueCatSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import ListingSettingsSection from './settings/ListingSettingsSection.svelte';
  import NotificationsSection from './settings/NotificationsSection.svelte';
  import ReleaseSettingsSection from './settings/ReleaseSettingsSection.svelte';
  import RepositorySection from './settings/RepositorySection.svelte';
  import StoresSection from './settings/StoresSection.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import { settingsLead } from '../../lib/page-lead.ts';
  import SectionRail from '../ui/SectionRail.svelte';
  import { address } from '../../lib/address.svelte.ts';
  import { railEntries, withRailSection } from '../../lib/section-rail.ts';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

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
  const groups = $derived(appSettingsGroups({ android: members.some((m) => supports(m.platform, 'releaseTracks')), ai: aiOn, canDelete: canWrite }));
  /** The open section: `?section=`, an old part id, or the first one the app has. */
  const current = $derived(resolveAppSettingsSection(address.hash, railEntries(groups).map((e) => e.id)));

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
  <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="settings-lead" />
  <SectionRail {groups} value={current} hrefFor={(id) => withRailSection(address.hash, id)} label={t('app:settings.navLabel')}>
    {#if current === ids.stores}
      <StoresSection {api} {workspaceId} {role} {members} {all} {now} />
    {:else if current === ids.repository}
      <RepositorySection {api} {workspaceId} {role} {members} />
    {:else if current === ids.appearance}
      <AppearanceSection {api} {workspaceId} {role} {members} />
    {:else if current === ids.listing}
      <ListingSettingsSection {api} {workspaceId} {role} {members} />
    {:else if current === ids.integrations}
      <div class="part"><ExpoProjectSection {api} {workspaceId} {role} {members} {now} /></div><div class="part"><AdsSettingsSection {api} {workspaceId} {role} {members} {now} /></div><div class="part"><RevenueCatSection {api} {workspaceId} {role} {members} {now} /></div>
      <p class="none muted">{t('app:settings.integrationsNone')}</p>
    {:else if current === ids.defaults}
      <DefaultsSection {api} {workspaceId} {role} {members} />
    {:else if current === ids.playReleases}
      <ReleaseSettingsSection {api} {workspaceId} {role} {members} />
    {:else if current === ids.playBucket}
      <AnalyticsSection {api} {workspaceId} {role} {members} />
    {:else if current === ids.notifications}
      <NotificationsSection {api} {workspaceId} {role} />
    {:else if current === ids.ai}
      <AiContextSection {api} {workspaceId} {role} {members} />
    {:else if current === ids.aiPrivacy}
      <AiReviewPrivacySection {api} {workspaceId} {role} {members} />
    {:else}
    <section class="danger" aria-labelledby="app-settings-danger-title">
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
    {/if}
  </SectionRail>
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
  /* Expo and RevenueCat draw nothing when they do not apply; the note shows when both are empty. */
  .part:empty {
    display: none;
  }

  .none {
    display: none;
    margin: 0;
  }

  .part:empty + .part:empty + .none {
    display: block;
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
