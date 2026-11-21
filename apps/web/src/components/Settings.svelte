<!--
  Settings: workspace settings (docs/api/settings.md). Any member sees them; owners and admins change them.
  Four views behind a segmented control, kept in the address as `?view=` (lib/settings-views.ts; `#/settings` is General):
  General (Reviews: the low rating threshold and the unanswered reminder; Store refresh: the scheduled read of the stores; Releases: when a release counts as left unfinished;
  Translation: provider, credential, target language, mode, daily budget, a test), Analytics (the opt-in, the Apple vendor number and
  the Play bucket id), Security (confirm hard actions, recovery codes, authenticator app and email, mail) and AI (the AI assistant:
  provider, model, key, monthly limit, a test, its own save; and "Connect an AI assistant").
  General and Analytics are one form with one state and one "Save settings" bar; the state lives here, so it survives a switch of
  view, and the other views say that changes wait to be saved.
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
  import { isFormView, resolveSettingsView, settingsSectionsFor, settingsViewsFor, unsavedViewsNote, withSettingsView } from '../lib/settings-views.ts';
  import { confirmed } from '../lib/step-up-prompt.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import CredentialForm from './credentials/CredentialForm.svelte';
  import LanguageSettings from './settings/LanguageSettings.svelte';
  import AnalyticsSettings from './settings/AnalyticsSettings.svelte';
  import JumpTo from './settings/JumpTo.svelte';
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
  import SectionsToggle from './ui/SectionsToggle.svelte';
  import ViewSwitch from './app/ViewSwitch.svelte';
  import Skeleton from './ui/Skeleton.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'settings.read'));
  const editable = $derived(can(role, 'settings.write'));
  const canManageCredentials = $derived(can(role, 'credentials.write'));
  /** The AI assistant card has its own right and its own save; it does not depend on the other settings loading. */
  const canAi = $derived(can(role, 'ai.use'));

  const allowed = (action: Parameters<typeof can>[1]) => can(role, action);
  const views = $derived(settingsViewsFor(allowed));
  const view = $derived(resolveSettingsView(address.hash, allowed));
  /** Mail is the server's: owners and admins see it, so only they have it in the jump row. */
  const sections = $derived(settingsSectionsFor(view, editable));

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
      const onAnalytics = problems.every((k) => k === 'analyticsVendorNumber' || k === 'analyticsBucketId');
      const here = view === 'analytics' ? onAnalytics : problems.some((k) => k !== 'analyticsVendorNumber' && k !== 'analyticsBucketId');
      saveError = here ? '' : `A value on the ${view === 'analytics' ? 'General' : 'Analytics'} view is not valid. Fix it there, then save.`;
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
      toast.success('Settings saved.');
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
    toast.success(`Added “${label}”.`);
    await load();
  }
</script>

<section>
  <PageHeader title="Settings" description="Choices for the whole workspace: store refresh, reminders, translation, security and AI." />

  <div class="row bar">
    <ViewSwitch {views} value={view} hrefFor={(id) => withSettingsView(address.hash, id)} label="Settings views" />
    <SectionsToggle />
  </div>
  <JumpTo {sections} label="Parts of {view} settings" />

  {#if !canRead}
    <Alert tone="info">Your role does not include workspace settings. Members, admins and owners can see them.</Alert>
  {:else if isFormView(view)}
    {#if loadError}
      <Alert tone="error">{loadError}</Alert>
      <p><Button onclick={load}>Try again</Button></p>
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
      {#if view === 'general'}
        <div id="settings-store-refresh" class="part" tabindex="-1">
          <SyncSettings bind:form {editable} {errors} writable={data.writable} sync={data.sync} />
        </div>
        <div id="settings-reviews" class="part" tabindex="-1">
          <ReviewsSettings
            bind:form
            editable={editable && data.writable.indexOf('reviews.lowRatingThreshold') >= 0}
            error={errors.lowRatingThreshold}
            {errors}
            writable={editable ? data.writable : []}
          />
        </div>
        <div id="settings-releases" class="part" tabindex="-1">
          <ReleaseSettings bind:form {editable} {errors} writable={data.writable} />
        </div>
        <div id="settings-translation" class="part" tabindex="-1">
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
        </div>
      {:else}
        <AnalyticsSettings bind:form {editable} {errors} writable={editable ? data.writable : []} />
      {/if}
      {#if saveError}<Alert tone="error">{saveError}</Alert>{/if}
      {#if editable}
        <div class="savebar" class:pending={dirty}>
          <p class="state" role="status">{dirty ? 'You have unsaved changes.' : 'All changes are saved.'}</p>
          <div class="row">
            <Button disabled={!dirty || saving} onclick={revert}>Discard</Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>Save settings</Button>
          </div>
        </div>
      {/if}
    </form>
    {/if}
  {/if}

  {#if canRead && view === 'general'}
    <div class="ai"><LanguageSettings /></div>
  {/if}

  {#if !isFormView(view)}
    {#if dirty && unsavedViewsNote(view)}
      <div class="ai"><Alert tone="info">{unsavedViewsNote(view)} <a href={withSettingsView(address.hash, 'general')}>Go to General</a>.</Alert></div>
    {/if}
    {#if view === 'security' && canRead}
      <div class="ai stack loose">
        <div id="settings-confirm" class="part" tabindex="-1"><SecuritySettings {api} {workspaceId} {role} /></div>
        <div id="settings-second-factor" class="part" tabindex="-1"><TwoFactorSettings {api} {workspaceId} {role} /></div>
        {#if editable}<div id="settings-mail" class="part" tabindex="-1"><MailSettings {api} {workspaceId} {role} /></div>{/if}
      </div>
    {:else if view === 'ai'}
      {#if canAi}
        <div class="ai">
          <AiSettings {api} {workspaceId} {role} />
        </div>
      {/if}
      <div class="ai">
        <McpSettings {api} {workspaceId} {role} />
      </div>
    {/if}
  {/if}
</section>

<style>
  .bar {
    justify-content: space-between;
  }

  .ai {
    max-width: 48rem;
    margin-top: var(--space-5);
  }

  .part {
    scroll-margin-top: var(--space-4);
  }

  .part:focus {
    outline: none;
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

  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 48rem;
  }
</style>
