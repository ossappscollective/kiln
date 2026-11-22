<!--
  Settings: workspace settings (docs/api/settings.md). Any member sees them; owners and admins change them.
  A rail on the left (grouped sections and a search, lib/settings-views.ts) and one section at a time on the right, kept in the address
  as `?section=` (`#/settings` is Store refresh; the old `?view=` addresses open the first section of that view).
  Workspace (Store refresh, Reviews, Releases, Translation, Analytics) is one form with one state and one "Save settings" bar that sits
  under the section; the state lives here, so it survives a change of section, and the other sections say that changes wait to be saved
  (the rail marks the form sections with a dot). Language is this browser's and applies at once. Security (confirm hard actions, recovery
  codes, authenticator app and email, mail) and AI (the AI assistant with its own save, "Connect an AI assistant") save on their own.
  Integrations lists Slack and Teams (#/chat) and Webhooks (#/webhooks), which have their own pages.
  Cards are drawn open and without a toggle here (provideFlatCards): a section is the only thing on screen.
  Secrets are never settings: keys live under Credentials (the AI key is written from its card into the same vault).
-->
<script lang="ts">
  import { type Role, can, translationProviderInfo } from '@kiln/core';
  import { address } from '../lib/address.svelte.ts';
  import { type Api } from '../lib/api.ts';
  import {
    type FormErrors,
    type SettingsForm,
    type SettingsResponse,
    type TranslationTestOutcome,
    formFromSettings,
    forgetTranslationConfig,
    isDirty,
    settingsChanges,
    settingsErrorMessage,
    validateForm,
  } from '../lib/settings.ts';
  import { filterSettingsGroups, isFormSection, resolveSettingsSection, settingsGroupsFor, withSettingsSection } from '../lib/settings-views.ts';
  import { provideFlatCards } from '../lib/section-host.svelte.ts';
  import { confirmed } from '../lib/step-up-prompt.svelte.ts';
  import { t } from '../lib/i18n/t.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import T from './ui/T.svelte';
  import CredentialForm from './credentials/CredentialForm.svelte';
  import LanguageSettings from './settings/LanguageSettings.svelte';
  import AnalyticsSettings from './settings/AnalyticsSettings.svelte';
  import ReleaseSettings from './settings/ReleaseSettings.svelte';
  import SyncSettings from './settings/SyncSettings.svelte';
  import AiSettings from './settings/AiSettings.svelte';
  import McpSettings from './settings/McpSettings.svelte';
  import SecuritySettings from './settings/SecuritySettings.svelte';
  import TwoFactorSettings from './settings/TwoFactorSettings.svelte';
  import MailSettings from './settings/MailSettings.svelte';
  import ReviewsSettings from './settings/ReviewsSettings.svelte';
  import TranslationSettings from './settings/TranslationSettings.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Icon from './ui/Icon.svelte';
  import Skeleton from './ui/Skeleton.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'settings.read'));
  const editable = $derived(can(role, 'settings.write'));
  const canManageCredentials = $derived(can(role, 'credentials.write'));
  /** The AI assistant card has its own right and its own save; it does not depend on the other settings loading. */
  const canAi = $derived(can(role, 'ai.use'));

  provideFlatCards();

  const allowed = (action: Parameters<typeof can>[1]) => can(role, action);
  const groups = $derived(settingsGroupsFor(allowed));
  const section = $derived(resolveSettingsSection(address.hash, allowed));
  const inForm = $derived(isFormSection(section));
  let query = $state('');
  const shownGroups = $derived(filterSettingsGroups(groups, query));
  /** Enter in the search opens the first section it found (a link opens its own page). */
  function openFirst(event: SubmitEvent) {
    event.preventDefault();
    const first = shownGroups[0]?.items[0];
    if (!first) return;
    window.location.hash = first.href ?? withSettingsSection(address.hash, first.id);
    query = '';
  }

  let data = $state<SettingsResponse | null>(null);
  let form = $state<SettingsForm | null>(null);
  let loadError = $state('');
  let saveError = $state('');
  let saving = $state(false);
  let testing = $state(false);
  let outcome = $state<TranslationTestOutcome | null>(null);
  let addingCredential = $state(false);
  /** Errors are shown once the person has tried to save, so a half typed value does not shout. */
  let showErrors = $state(false);

  const errors = $derived<FormErrors>(form && showErrors ? validateForm(form) : {});
  const dirty = $derived(!!data && !!form && isDirty(data.values, form, data.writable));

  async function load() {
    loadError = '';
    try {
      const next = await api.workspaceSettings(workspaceId);
      data = next;
      form = formFromSettings(next.values);
    } catch (e) {
      data = null;
      form = null;
      loadError = settingsErrorMessage(e, 'load');
    }
  }

  $effect(() => {
    void workspaceId;
    data = null;
    form = null;
    outcome = null;
    saveError = '';
    showErrors = false;
    addingCredential = false;
    if (canRead) void load();
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!data || !form || saving || !editable) return;
    showErrors = true;
    const problems = Object.keys(validateForm(form));
    if (problems.length > 0) {
      // A value on the other view of the form may be the one that is wrong: say so, as it is not on screen.
      const isAnalytics = (key: string) => key === 'analyticsVendorNumber' || key === 'analyticsBucketId';
      const here = section === 'analytics' ? problems.some(isAnalytics) : problems.some((key) => !isAnalytics(key));
      saveError = here ? '' : section === 'analytics' ? t('settings:page.otherSectionWorkspace') : t('settings:page.otherSectionAnalytics');
      return;
    }
    const changes = settingsChanges(data.values, form, data.writable);
    if (Object.keys(changes).length === 0) return;
    saving = true;
    saveError = '';
    try {
      await confirmed((grant) => api.updateWorkspaceSettings(workspaceId, changes, grant));
      forgetTranslationConfig(workspaceId);
      outcome = null;
      showErrors = false;
      await load();
      toast.success(t('settings:page.saved'));
    } catch (e) {
      saveError = settingsErrorMessage(e, 'save');
    } finally {
      saving = false;
    }
  }

  function revert() {
    if (!data) return;
    form = formFromSettings(data.values);
    showErrors = false;
    saveError = '';
  }

  async function test() {
    if (testing) return;
    testing = true;
    outcome = null;
    try {
      outcome = await api.testTranslation(workspaceId);
    } catch (e) {
      outcome = { ok: false, message: settingsErrorMessage(e, 'test') };
    } finally {
      testing = false;
    }
  }

  async function credentialSaved(label: string) {
    addingCredential = false;
    toast.success(t('settings:page.credentialAdded', { label }));
    await load();
  }
</script>

<section>
  <PageHeader title={t('settings:page.title')} description={t('settings:page.description')} />

  <div class="layout">
    <aside class="rail sidebar">
      <form class="search" role="search" onsubmit={openFirst}>
        <Icon name="search" size={16} />
        <input type="search" bind:value={query} placeholder={t('settings:nav.search')} aria-label={t('settings:nav.searchLabel')} autocomplete="off" />
      </form>
      <nav aria-label={t('settings:nav.label')}>
        {#each shownGroups as g (g.id)}
          <div class="group" role="group" aria-labelledby="settings-group-{g.id}">
            <h2 id="settings-group-{g.id}">{g.label}</h2>
            <ul>
              {#each g.items as item (item.id)}
                <li>
                  {#if item.kind === 'link'}
                    <a href={item.href}>
                      <span class="label">{item.label}</span>
                      <Icon name="arrow-right" size={14} />
                    </a>
                  {:else}
                    <a href={withSettingsSection(address.hash, item.id)} aria-current={section === item.id ? 'page' : undefined}>
                      <span class="label">{item.label}</span>
                      {#if dirty && item.kind === 'form'}<span class="dot" role="img" aria-label={t('settings:nav.unsaved')} title={t('settings:nav.unsaved')}></span>{/if}
                    </a>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="none">{t('settings:nav.noMatch', { query })}</p>
        {/each}
      </nav>
    </aside>

    <div class="pane">
      {#if !canRead}
        <Alert tone="info">{t('settings:page.noRole')}</Alert>
      {/if}

      {#if inForm}
        {#if loadError}
          <Alert tone="error">{loadError}</Alert>
          <p><Button onclick={load}>{t('common:action.tryAgain')}</Button></p>
        {:else if !data || !form}
          <Skeleton />
        {:else if addingCredential}
          <CredentialForm
            {api}
            {workspaceId}
            initialKind={translationProviderInfo[form.provider].credentialKind}
            onSaved={credentialSaved}
            onCancel={() => (addingCredential = false)}
          />
        {:else}
          <form class="settings" onsubmit={save} novalidate>
            {#if section === 'store-refresh'}
              <SyncSettings bind:form {editable} {errors} writable={data.writable} sync={data.sync} />
            {:else if section === 'reviews'}
              <ReviewsSettings
                bind:form
                editable={editable && data.writable.indexOf('reviews.lowRatingThreshold') >= 0}
                error={errors.lowRatingThreshold}
                {errors}
                writable={editable ? data.writable : []}
              />
            {:else if section === 'releases'}
              <ReleaseSettings bind:form {editable} {errors} writable={data.writable} />
            {:else if section === 'translation'}
              <TranslationSettings
                bind:form
                {errors}
                {editable}
                {data}
                {canManageCredentials}
                {dirty}
                {testing}
                {outcome}
                ontest={test}
                onaddcredential={() => (addingCredential = true)}
              />
            {:else}
              <AnalyticsSettings bind:form {editable} {errors} writable={editable ? data.writable : []} />
            {/if}
            {#if saveError}<Alert tone="error">{saveError}</Alert>{/if}
            {#if editable}
              <div class="savebar" class:pending={dirty}>
                <p class="state" role="status">{dirty ? t('settings:page.unsaved') : t('settings:page.allSaved')}</p>
                <div class="row">
                  <Button disabled={!dirty || saving} onclick={revert}>{t('settings:page.discard')}</Button>
                  <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>{t('settings:page.save')}</Button>
                </div>
              </div>
            {/if}
          </form>
        {/if}
      {:else}
        {#if dirty}
          <Alert tone="info"><T key="settings:nav.unsavedWithLink" tags={{ link: workspaceLink }} /></Alert>
        {/if}
        <div class="settings">
          {#if section === 'language'}
            <LanguageSettings />
          {:else if section === 'confirm'}
            <SecuritySettings {api} {workspaceId} {role} />
          {:else if section === 'second-factor'}
            <TwoFactorSettings {api} {workspaceId} {role} />
          {:else if section === 'mail'}
            <MailSettings {api} {workspaceId} {role} />
          {:else if section === 'ai'}
            <AiSettings {api} {workspaceId} {role} />
          {:else if section === 'mcp'}
            <McpSettings {api} {workspaceId} {role} />
          {/if}
        </div>
      {/if}
    </div>
  </div>
</section>

{#snippet workspaceLink(text: string)}<a href={withSettingsSection(address.hash, 'store-refresh')}>{text}</a>{/snippet}

<style>
  .layout {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
    margin-top: var(--space-5);
  }

  .rail {
    position: sticky;
    top: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .search {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-md, 2.25rem);
    padding: 0 var(--space-3);
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .search:focus-within {
    border-color: var(--accent);
  }

  .search input {
    flex: 1;
    min-width: 0;
    font: inherit;
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
  }

  .rail nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .group h2 {
    margin: 0 0 var(--space-1);
    padding: 0 var(--space-3);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .group ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .rail nav a {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
    min-height: 2.25rem;
    padding: 0 var(--space-3);
    font-size: 0.9375rem;
    font-weight: var(--weight-medium);
    color: var(--muted);
    text-decoration: none;
    border-radius: var(--radius-md);
  }

  .rail nav a:not([aria-current='page']):hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  /* The current item takes its shape from the shared sidebar rule in app.css; the radius is repeated because this block is scoped. */
  .rail nav a[aria-current='page'] {
    font-weight: var(--weight-semibold);
    color: var(--ink);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
  }

  .dot {
    flex-shrink: 0;
    width: 0.5rem;
    height: 0.5rem;
    background: var(--accent);
    border-radius: 50%;
  }

  .none {
    padding: 0 var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .pane {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    max-width: 48rem;
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* The save bar stays at the bottom of the visible part, so a long form never hides it. */
  .savebar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
  }

  .savebar.pending {
    border-color: var(--accent, var(--line));
  }

  .state {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }

  .pending .state {
    color: var(--ink);
  }

  @media (max-width: 48rem) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-4);
    }

    .rail {
      position: static;
    }
  }
</style>
