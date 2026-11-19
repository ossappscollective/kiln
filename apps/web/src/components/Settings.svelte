<!--
  Settings: workspace settings (docs/api/settings.md). Any member sees them; owners and admins change them.
  Sections: Reviews (the low rating threshold and the unanswered reminder), Releases (when a release counts as left
  unfinished), Translation (provider, credential, target
  language, mode, daily budget, a test) and the AI assistant (AiSettings: provider, model, key, monthly limit, a test; its own save).
  Secrets are never settings: keys live under Credentials (the AI key is written from its card into the same vault).
-->
<script lang="ts">
  import { type Role, can, translationProviderInfo } from '@mrm/core';
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
  import { toast } from '../lib/toast.svelte.ts';
  import CredentialForm from './credentials/CredentialForm.svelte';
  import ReleaseSettings from './settings/ReleaseSettings.svelte';
  import AiSettings from './settings/AiSettings.svelte';
  import ReviewsSettings from './settings/ReviewsSettings.svelte';
  import TranslationSettings from './settings/TranslationSettings.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Skeleton from './ui/Skeleton.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'settings.read'));
  const editable = $derived(can(role, 'settings.write'));
  const canManageCredentials = $derived(can(role, 'credentials.write'));
  /** The AI assistant card has its own right and its own save; it does not depend on the other settings loading. */
  const canAi = $derived(can(role, 'ai.use'));

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
    if (Object.keys(validateForm(form)).length > 0) return;
    const changes = settingsChanges(data.values, form, data.writable);
    if (Object.keys(changes).length === 0) return;
    saving = true;
    saveError = '';
    try {
      await api.updateWorkspaceSettings(workspaceId, changes);
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
  <PageHeader title="Settings" description="How this workspace reads and translates customer reviews, and when it reminds you about them and about unfinished releases." />

  {#if !canRead}
    <Alert tone="info">Your role does not include workspace settings. Members, admins and owners can see them.</Alert>
  {:else if loadError}
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
      <ReviewsSettings
        bind:form
        editable={editable && data.writable.indexOf('reviews.lowRatingThreshold') >= 0}
        error={errors.lowRatingThreshold}
        {errors}
        writable={editable ? data.writable : []}
      />
      <ReleaseSettings bind:form {editable} {errors} writable={data.writable} />
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
      {#if saveError}<Alert tone="error">{saveError}</Alert>{/if}
      {#if editable}
        <div class="row">
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>Save settings</Button>
          <Button disabled={!dirty || saving} onclick={revert}>Discard changes</Button>
        </div>
      {/if}
    </form>
  {/if}

  {#if canAi && !addingCredential}
    <div class="ai">
      <AiSettings {api} {workspaceId} {role} />
    </div>
  {/if}
</section>

<style>
  .ai {
    max-width: 48rem;
    margin-top: var(--space-5);
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 48rem;
  }
</style>
