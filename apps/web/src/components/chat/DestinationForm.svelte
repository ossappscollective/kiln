<!--
  DestinationForm: add or edit a chat destination (Slack or Microsoft Teams). The webhook address is a secret: it is typed once,
  sent, and never shown again (the server returns its last four characters). When editing, an empty address means "keep the saved one".
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    type ChatDestination,
    type DestinationForm,
    createInput,
    emptyDestinationForm,
    formFromDestination,
    hasProblems,
    helpSteps,
    hintText,
    hourLabel,
    hours,
    patchFor,
    providerChoices,
    urlPlaceholder,
    validateDestinationForm,
  } from '../../lib/chat/chat.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { availableLocales } from '../../lib/i18n/locales.ts';
  import { i18n } from '../../lib/i18n/i18n.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    destination,
    onsaved,
    oncancel,
  }: {
    api: Api;
    workspaceId: string;
    /** Set to edit; leave out to add. */
    destination?: ChatDestination | undefined;
    onsaved: (destination: ChatDestination, created: boolean) => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();
  const initial: DestinationForm = (() =>
    destination ? formFromDestination(destination) : emptyDestinationForm(i18n.locale, browserZone))();

  let form = $state<DestinationForm>({ ...initial });
  let busy = $state(false);
  let error = $state('');
  let showProblems = $state(false);

  const editing = $derived(destination !== undefined);
  const problems = $derived(validateDestinationForm(form, editing));

  onMount(() => document.getElementById(`${uid}-name`)?.focus());

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    showProblems = true;
    if (hasProblems(problems)) return;
    busy = true;
    error = '';
    try {
      if (destination) {
        const patch = patchFor(destination, form);
        if (Object.keys(patch).length === 0) return oncancel();
        onsaved((await api.updateChatDestination(workspaceId, destination.id, patch)).destination, false);
      } else {
        onsaved((await api.createChatDestination(workspaceId, createInput(form))).destination, true);
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
      <h3>{destination ? t('chat:form.titleEdit') : t('chat:form.titleNew')}</h3>
      <p>{t('chat:form.description')}</p>
    </div>
  </div>

  <div class="stack">
    {#if !destination}
      <fieldset class="choices">
        <legend>{t('chat:form.provider')}</legend>
        <div class="row">
          {#each providerChoices as choice (choice.id)}
            <label class="check">
              <input type="radio" name="{uid}-provider" value={choice.id} bind:group={form.provider} />
              <span>{t(choice.labelKey)}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    <!-- guard-ok R3: the length of a free-text destination name (a form field), not a store limit -->
    <TextField label={t('chat:form.name')} id="{uid}-name" bind:value={form.name} maxlength={80} autocomplete="off" hint={t('chat:form.nameHint')} error={showProblems ? problems.name : undefined} />

    <TextField
      label={t('chat:form.url')}
      id="{uid}-url"
      type="url"
      bind:value={form.url}
      placeholder={urlPlaceholder[form.provider]}
      autocomplete="off"
      spellcheck={false}
      hint={destination ? t('chat:form.urlSaved', { hint: hintText(destination) }) : t('chat:form.urlHint')}
      error={showProblems ? problems.url : undefined}
    />

    <details class="help" open={!destination}>
      <summary>{t('chat:help.title')}</summary>
      <ol>
        {#each helpSteps[form.provider] as step (step)}
          <li>{t(step)}</li>
        {/each}
      </ol>
      {#if form.provider === 'teams'}<p class="hint">{t('chat:help.teams.note')}</p>{/if}
    </details>

    <div class="field">
      <label for="{uid}-language">{t('chat:form.language')}</label>
      <select id="{uid}-language" bind:value={form.locale} aria-describedby="{uid}-language-hint">
        {#each availableLocales as locale (locale.code)}
          <option value={locale.code} lang={locale.htmlLang}>{locale.name}</option>
        {/each}
      </select>
      <p class="hint" id="{uid}-language-hint">{t('chat:form.languageHint')}</p>
    </div>

    <div class="field">
      <label for="{uid}-digest">{t('chat:form.digest')}</label>
      <select id="{uid}-digest" bind:value={form.digest}>
        <option value="off">{t('chat:form.digestOff')}</option>
        <option value="daily">{t('chat:form.digestDaily')}</option>
      </select>
    </div>
    {#if form.digest === 'daily'}
      <div class="row">
        <div class="field">
          <label for="{uid}-hour">{t('chat:form.digestHour')}</label>
          <select id="{uid}-hour" bind:value={form.digestHour}>
            {#each hours as h (h)}<option value={h}>{hourLabel(h)}</option>{/each}
          </select>
        </div>
        <TextField label={t('chat:form.timezone')} id="{uid}-zone" bind:value={form.timezone} autocomplete="off" hint={t('chat:form.timezoneHint')} error={showProblems ? problems.timezone : undefined} />
      </div>
    {/if}

    <label class="check">
      <input type="checkbox" bind:checked={form.enabled} />
      <span>{t('chat:form.enabled')}</span>
    </label>

    <label class="check">
      <input type="checkbox" bind:checked={form.allowAnyHost} aria-describedby="{uid}-host-hint" />
      <span>{t('chat:form.anyHost')}</span>
    </label>
    <p class="hint" id="{uid}-host-hint">{t('chat:form.anyHostHint')}</p>

    {#if !destination}<p class="hint">{t('chat:form.defaultsNote')}</p>{/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}

    <div class="row actions">
      <Button type="submit" variant="primary" loading={busy}>
        {#if destination}{busy ? t('chat:form.saving') : t('chat:form.save')}{:else}{busy ? t('chat:form.creating') : t('chat:form.create')}{/if}
      </Button>
      <Button onclick={oncancel} disabled={busy}>{t('common:action.cancel')}</Button>
    </div>
  </div>
</form>

<style>
  .choices {
    padding: 0;
    margin: 0;
    border: 0;
  }

  .choices legend {
    padding: 0;
    margin-bottom: 6px;
    font-weight: 600;
  }

  .help {
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .help summary {
    cursor: pointer;
    font-weight: 600;
  }

  .help ol {
    padding-left: 20px;
    margin: 8px 0 0;
  }

  .actions {
    margin-top: 4px;
  }
</style>
