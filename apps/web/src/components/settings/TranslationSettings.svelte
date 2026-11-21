<!--
  TranslationSettings: the translation section of the Settings screen.
  Props: form (bindable), errors, editable (the caller may change settings), data (the last answer of
  the server: usage, the credential in use), canManageCredentials, dirty (unsaved changes: the test
  uses the SAVED settings), testing, outcome (the last test), ontest, onaddcredential.
  Review text is sent to the provider chosen here: each choice says who receives it. Keys are never
  shown here; they live under Credentials.
  Readable pass (docs/design/readability.md): the card is title, one sentence, then fields as label, control and one hint. A credential and
  a test are ONE word (lib/readable-forms.ts) with a quiet action beside it; the long note about the address sits behind a disclosure.
-->
<script lang="ts">
  import { type TranslationMode, translationModes } from '@kiln/core';
  import {
    type FormErrors,
    type SettingsForm,
    type SettingsResponse,
    type TranslationTestOutcome,
    languageChoices,
    modeLabels,
    providerChoices,
    testOutcomeText,
    usageFraction,
    usageText,
  } from '../../lib/settings.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import TextField from '../ui/TextField.svelte';
  import '../readable-card.css';
  import { credentialWord, testWord } from '../../lib/readable-forms.ts';

  let {
    form = $bindable(),
    errors,
    editable,
    data,
    canManageCredentials,
    dirty,
    testing,
    outcome,
    ontest,
    onaddcredential,
  }: {
    form: SettingsForm;
    errors: FormErrors;
    editable: boolean;
    data: SettingsResponse;
    canManageCredentials: boolean;
    dirty: boolean;
    testing: boolean;
    outcome: TranslationTestOutcome | null;
    ontest: () => void;
    onaddcredential: () => void;
  } = $props();

  const uid = $props.id();
  const choice = $derived(providerChoices.find((p) => p.id === form.provider) ?? providerChoices[0]);
  const fraction = $derived(usageFraction(data.translation.usage));
  /** The credential shown is the one of the SAVED provider; a changed provider needs saving first. */
  const savedProvider = $derived(data.translation.provider);
  const providerChanged = $derived(savedProvider !== form.provider);
  const modes: TranslationMode[] = [...translationModes];
  const credWord = $derived(
    credentialWord({
      configured: data.translation.credentialConfigured,
      required: data.translation.credentialRequired,
      changed: providerChanged,
      optionalLabel: 'Optional',
    }),
  );
  const testState = $derived(testWord({ testing, ok: outcome === null ? null : outcome.ok }));
</script>

<Card title="Translation" collapseKey="translation" description="Translate customer reviews with a service you choose.">
  {#if !editable}
    <Alert tone="info">Only owners and admins can change these settings. You can see what is set.</Alert>
  {/if}

  <div class="stack readable-card">
    <div class="field">
      <label class="check">
        <input type="checkbox" bind:checked={form.enabled} disabled={!editable} />
        Turn on review translation
      </label>
      <p class="hint">While this is off, no review text leaves this server.</p>
    </div>

    <fieldset class="field" disabled={!editable}>
      <legend>Provider</legend>
      {#each providerChoices as p (p.id)}
        <label class="option">
          <input type="radio" name="{uid}-provider" value={p.id} bind:group={form.provider} />
          <span>
            <strong>{p.label}</strong>
            {#if p.isDefault}<Badge tone="accent">Default</Badge>{/if}
            <span class="hint block">{p.privacy}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    <div class="field">
      <p class="label-like">Credential</p>
      <p class="connection">
        <Badge tone={credWord.tone} icon={credWord.tone === 'ok' ? 'check' : undefined}>{credWord.label}</Badge>
        {#if providerChanged}
          <span>Save to see the credential of {choice?.label}.</span>
        {:else if data.translation.credentialConfigured}
          <span>{#if data.translation.credential}{data.translation.credential.label}{:else}A credential of this kind is in use.{/if}</span>
        {:else if data.translation.credentialRequired}
          <span>{choice?.label} needs an API key.</span>
        {:else}
          <span>Add a key only if your LibreTranslate server asks for one.</span>
        {/if}
        {#if canManageCredentials}
          <Button size="sm" variant="ghost" icon="plus" onclick={onaddcredential}>Add a credential</Button>
          <a class="link sm" href="#/credentials">Manage credentials</a>
        {/if}
      </p>
      {#if data.translation.credentialConfigured && !providerChanged}
        <p class="hint">Keys are kept in the vault and are never shown here.</p>
      {:else if !canManageCredentials && !data.translation.credentialConfigured && data.translation.credentialRequired}
        <p class="hint">An admin can add it under Credentials.</p>
      {/if}
    </div>

    {#if choice?.needsUrl}
      <TextField
        label="LibreTranslate address"
        bind:value={form.libreUrl}
        placeholder="https://translate.example.com"
        hint="Starts with https://, with no user name, password or key in it."
        error={errors.libreUrl}
        disabled={!editable}
        autocomplete="off"
        spellcheck="false"
      />
      <Disclosure summary="About a server on a private network">
        <p class="hint">A server on a private network needs MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true on this server.</p>
      </Disclosure>
    {/if}

    <div class="field">
      <label for="{uid}-target">Translate into</label>
      <input id="{uid}-target" list="{uid}-languages" bind:value={form.targetLanguage} disabled={!editable} autocomplete="off" spellcheck="false" aria-invalid={errors.targetLanguage ? 'true' : undefined} aria-describedby="{uid}-target-hint" />
      <datalist id="{uid}-languages">
        {#each languageChoices as l (l.tag)}<option value={l.tag}>{l.label}</option>{/each}
      </datalist>
      <p class="hint" id="{uid}-target-hint">A language code such as en, de or pt-BR. Reviews already in it are not sent.</p>
      {#if errors.targetLanguage}<p class="field-error" role="alert">{errors.targetLanguage}</p>{/if}
    </div>

    <fieldset class="field" disabled={!editable}>
      <legend>When to translate</legend>
      {#each modes as m (m)}
        <label class="option">
          <input type="radio" name="{uid}-mode" value={m} bind:group={form.mode} />
          <span>
            <strong>{modeLabels[m].label}</strong>
            <span class="hint block">{modeLabels[m].help}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    <div class="field">
      <label for="{uid}-budget">Daily limit (characters)</label>
      <input id="{uid}-budget" inputmode="numeric" bind:value={form.dailyCharBudget} disabled={!editable} autocomplete="off" aria-invalid={errors.dailyCharBudget ? 'true' : undefined} aria-describedby="{uid}-budget-hint" />
      <p class="hint" id="{uid}-budget-hint">The most this workspace sends per day (UTC). 0 means no limit here.</p>
      {#if errors.dailyCharBudget}<p class="field-error" role="alert">{errors.dailyCharBudget}</p>{/if}
      <p class="usage">
        {#if fraction !== null}<progress value={fraction} max="1" aria-label="Translation budget used today"></progress>{/if}
        <span class="hint">{usageText(data.translation.usage)}</span>
      </p>
    </div>

    {#if editable}
      <div class="field">
        <p class="connection">
          <Badge tone={testState.tone}>{testState.label}</Badge>
          <Button size="sm" variant="ghost" icon="refresh" loading={testing} disabled={dirty || testing} onclick={ontest}>Test the provider</Button>
        </p>
        <p class="hint">{dirty ? 'Save first: the test uses the saved settings.' : 'Translates one fixed word, not review text, and uses no budget.'}</p>
        {#if outcome}
          <Alert tone={outcome.ok ? 'ok' : 'error'}>{testOutcomeText(outcome)}</Alert>
        {/if}
      </div>
    {/if}
  </div>
</Card>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }

  legend,
  .label-like {
    font-weight: 600;
    margin: 0 0 var(--space-1);
    padding: 0;
  }

  .option,
  .check {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin: var(--space-2) 0;
    font-weight: 400;
    cursor: pointer;
  }

  .check {
    margin: 0;
    align-items: center;
    font-weight: 500;
  }

  .option input {
    margin-top: 0.3rem;
  }

  .block {
    display: block;
  }

  .usage {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    margin: var(--space-2) 0 0;
  }

  progress {
    width: 12rem;
    max-width: 100%;
  }
</style>
