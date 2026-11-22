<!--
  AiSettings: the "AI assistant" card of the Settings screen (docs/api/ai.md, docs/adr/0016-ai-foundation.md). Members can read where it stands;
  admins and owners change it. It saves on its own (its own call, its own right), not with the other settings.
  - Where it stands, in words, from the server's own state: off on the server (names KILN_AI_ENABLED), off for the workspace, not set up (what
    is missing), ready.
  - Provider (Anthropic, OpenAI, or an OpenAI compatible server, for example a local one), model, address (for the compatible one), the API key,
    and the monthly usage limit with a meter. The key is write-only: it goes to the credential vault, and what is saved is never shown back.
  - The model is a combobox: any typed name is allowed, and "Load models" asks the provider for its list (POST /ai/models, with the typed key for
    that one call, never stored). It also loads once by itself when the form is ready (debounced, one call at a time, never on every keystroke).
    A list that could not be read says so quietly and offers well known names. The chosen name is kept even when it is not listed.
  - A local address is explained before it fails: this server only talks to public addresses unless its operator sets KILN_AI_ALLOW_PRIVATE_URLS=true.
  - "Test connection" sends one fixed small request (no workspace data) through the saved settings.
  - Who receives the text is stated plainly, and for each task a "What is sent" popover lists what is sent and what never is.
  Nothing an AI task does changes a store: it makes suggestions a person accepts (see the AI suggestions of ASO, the locale drawer and replies).
  Readable pass (docs/design/readability.md): 15px labels and hints, ONE sentence per hint; the server switch, the address rules, the prices and
  what is sent sit behind disclosures. The visible one-liners stay for what costs money or leaves the server (who receives the text, the
  estimate is not the bill). The key and the connection are one word each (lib/readable-forms.ts); Test is a quiet action; the form ends in
  the same SaveBar as the app Settings. Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, buildSecret, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import {
    type AiConfig,
    type AiForm,
    type AiModelsResponse,
    type AiTasksResponse,
    type AiTestOutcome,
    aiChanges,
    aiErrorMessage,
    aiSaveMessage,
    aiStateInfo,
    aiTestSample,
    aiTestText,
    addressAdvice,
    canAutoLoadModels,
    countText,
    formFromConfig,
    isAiDirty,
    keyTyped,
    modelNotListed,
    modelOptions,
    modelsBody,
    modelsCountText,
    modelsNote,
    modelsSignature,
    needsV1Hint,
    oldestCredentialOfKind,
    isLocalAddress,
    providerSentence,
    usageFraction,
    usageText,
    validateAiForm,
  } from '../../lib/ai/ai.ts';
  import { centsText, costLine } from '../../lib/ai/insights.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextField from '../ui/TextField.svelte';
  import SaveBar from '../app/settings/SaveBar.svelte';
  import { credentialWord, testWord } from '../../lib/readable-forms.ts';
  import '../readable-card.css';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const uid = $props.id();

  let data = $state<AiConfig | null>(null);
  let form = $state<AiForm | null>(null);
  let tasks = $state<AiTasksResponse | null>(null);
  let loadError = $state('');
  let saveError = $state('');
  let saving = $state(false);
  let testing = $state(false);
  let outcome = $state<AiTestOutcome | null>(null);
  let testProblem = $state('');
  /** Errors show once the person has tried to save, so a half typed value does not shout. */
  let showErrors = $state(false);

  const editable = $derived(data !== null && data.canManage && can(role, 'ai.manage'));
  const errors = $derived(data && form && showErrors ? validateAiForm(form, data) : {});
  const dirty = $derived(data !== null && form !== null && isAiDirty(data, form));
  const info = $derived(data ? aiStateInfo(data) : null);
  const choice = $derived(data && form ? (data.providers.find((p) => p.id === form?.provider) ?? null) : null);
  /** A server on this machine or network: no bill, so no limit to set. */
  const localModel = $derived(form?.provider === 'openai_compatible' && isLocalAddress(form.baseUrl));
  // The limit fields are hidden for such a server, so what is saved must not be a limit the person never saw.
  $effect(() => {
    if (form && localModel) {
      if (form.budget !== '0') form.budget = '0';
      if (form.costCap !== '') form.costCap = '';
    }
  });
  const saved = $derived(data ? (data.providers.find((p) => p.id === data?.settings.provider) ?? null) : null);
  const fraction = $derived(data ? usageFraction(data.usage) : null);
  const readyTasks = $derived((tasks?.tasks ?? []).filter((task) => task.status === 'ready'));
  /** The models the provider listed, and for which provider and address (a list of another one is not shown). */
  let models = $state<AiModelsResponse | null>(null);
  let modelsFor = $state('');
  let loadingModels = $state(false);
  let modelsProblem = $state('');
  /** What the last automatic load was for, so the same form is never loaded twice by itself. */
  let lastAutoSignature = $state('');
  const scope = (f: AiForm) => `${f.provider}|${f.baseUrl.trim()}`;
  const shownModels = $derived(models !== null && form !== null && modelsFor === scope(form) ? models : null);
  const options = $derived(shownModels && form ? modelOptions(shownModels.models, form.model) : []);
  const modelNote = $derived(modelsNote(shownModels, choice));
  const notListed = $derived(form ? modelNotListed(shownModels, form.model) : false);
  const advice = $derived(data && form && choice?.needsUrl ? addressAdvice(form.baseUrl, data.server.allowPrivateUrls) : null);
  const result = $derived(testProblem !== '' ? { ok: false, text: testProblem } : outcome === null ? null : aiTestText(outcome, data?.providers ?? []));
  const keyWord = $derived(
    credentialWord({ configured: choice?.credentialPresent ?? false, required: choice?.credentialRequired ?? false, optionalLabel: t('settings:ai.keyNotNeeded') }),
  );
  const testState = $derived(testWord({ testing, ok: result === null ? null : result.ok }));
  const sample = $derived(testProblem === '' && outcome !== null ? aiTestSample(outcome) : '');

  async function load() {
    loadError = '';
    try {
      const next = await api.aiConfig(workspaceId);
      data = next;
      form = formFromConfig(next);
      aiStore.setConfig(workspaceId, next);
    } catch (e) {
      data = null;
      form = null;
      loadError = aiErrorMessage(e, t('settings:ai.loadFailed'));
    }
    tasks = await aiStore.loadTasks(api, workspaceId, true);
  }

  $effect(() => {
    void workspaceId;
    data = null;
    form = null;
    tasks = null;
    outcome = null;
    testProblem = '';
    saveError = '';
    showErrors = false;
    models = null;
    modelsFor = '';
    modelsProblem = '';
    lastAutoSignature = '';
    untrack(() => void load());
  });

  /** Asks the provider for its models with the values in the form. One call at a time; an answer for a form that has changed since is dropped. */
  async function loadModels(manual: boolean) {
    if (!data || !form || !editable || loadingModels) return;
    if (choice?.needsUrl && form.baseUrl.trim() === '') {
      if (manual) modelsProblem = t('settings:ai.addressFirst');
      return;
    }
    const asked = modelsSignature(form);
    const askedScope = scope(form);
    lastAutoSignature = asked;
    loadingModels = true;
    modelsProblem = '';
    try {
      const answer = await api.aiModels(workspaceId, modelsBody(form, data));
      models = answer;
      modelsFor = askedScope;
    } catch (e) {
      models = null;
      modelsProblem = aiErrorMessage(e, t('settings:ai.modelsLoadFailed'));
    } finally {
      loadingModels = false;
    }
  }

  // Once when the card opens and the form is ready, and again when the provider, the address or the key settle: after a pause, never per keystroke.
  $effect(() => {
    if (!data || !form || !editable) return;
    const signature = modelsSignature(form);
    const ready = canAutoLoadModels(form, data);
    if (!ready || loadingModels || signature === lastAutoSignature) return;
    const timer = setTimeout(() => untrack(() => void loadModels(false)), 900);
    return () => clearTimeout(timer);
  });

  /** The key goes to the vault: it replaces the oldest key of the provider's kind (the one the server uses), or adds the first one. */
  async function saveKey(config: AiConfig, f: AiForm) {
    const provider = config.providers.find((p) => p.id === f.provider);
    if (!provider) return;
    const secret = buildSecret(provider.credentialKind, { apiKey: f.apiKey });
    if (provider.credentialPresent) {
      const list = (await api.credentials(workspaceId)).credentials;
      const oldest = oldestCredentialOfKind(list, provider.credentialKind);
      if (oldest) {
        await api.replaceSecret(workspaceId, oldest.id, secret);
        return;
      }
    }
    await api.addCredential(workspaceId, { kind: provider.credentialKind, label: 'AI assistant key', secret });
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!data || !form || saving || !editable) return;
    showErrors = true;
    if (Object.keys(validateAiForm(form, data)).length > 0) return;
    saving = true;
    saveError = '';
    try {
      if (keyTyped(form)) await saveKey(data, form);
      const changes = aiChanges(data, form);
      const next = Object.keys(changes).length > 0 ? await api.updateAiConfig(workspaceId, changes) : await api.aiConfig(workspaceId);
      data = next;
      form = formFromConfig(next);
      aiStore.setConfig(workspaceId, next);
      outcome = null;
      testProblem = '';
      showErrors = false;
      toast.success(t('settings:ai.saved'));
      tasks = await aiStore.loadTasks(api, workspaceId, true);
    } catch (e) {
      saveError = aiSaveMessage(e);
    } finally {
      saving = false;
    }
  }

  function revert() {
    if (!data) return;
    form = formFromConfig(data);
    showErrors = false;
    saveError = '';
  }

  async function test() {
    if (testing || !data || data.state !== 'ready') return;
    testing = true;
    outcome = null;
    testProblem = '';
    try {
      outcome = await api.testAi(workspaceId);
    } catch (e) {
      testProblem = aiErrorMessage(e, t('settings:ai.testFailed'));
    } finally {
      testing = false;
      void aiStore.loadConfig(api, workspaceId, true);
    }
  }
</script>

<Card title={t('settings:ai.title')} collapseKey="ai" description={t('settings:ai.description')}>
  {#if loadError}
    <Alert tone="error">{loadError}</Alert>
    <p><Button onclick={() => void load()}>{t('common:action.tryAgain')}</Button></p>
  {:else if !data || !form || !info}
    <Skeleton />
  {:else}
    <form class="stack readable-card" onsubmit={save} novalidate>
      <div class="field">
        <p class="status">
          <Badge tone={info.tone === 'ok' ? 'ok' : info.tone === 'warn' ? 'warn' : 'info'} icon={info.tone === 'ok' ? 'check' : info.tone === 'warn' ? 'alert-triangle' : 'info'}>{info.label}</Badge>
          <span>{info.message}</span>
        </p>
        <Disclosure summary={t('settings:ai.needsSummary')}>
          <p class="hint">{t('settings:ai.needsText')}</p>
        </Disclosure>
      </div>

      {#if !editable}
        <div class="field">
          <p class="who">{providerSentence(saved)}</p>
          <p class="hint">{t('settings:ai.adminsOnly')}</p>
        </div>
      {:else}
        <div class="field">
          <label class="check">
            <input type="checkbox" bind:checked={form.enabled} />
            {t('settings:ai.enableLabel')}
          </label>
          <p class="hint">{t('settings:ai.enableHint')}</p>
        </div>

        <fieldset class="field">
          <legend>{t('settings:ai.providerLegend')}</legend>
          {#each data.providers as p (p.id)}
            <label class="option">
              <input type="radio" name="{uid}-provider" value={p.id} bind:group={form.provider} />
              <span>
                <strong>{p.label}</strong>
                <span class="hint block">{p.privacy}</span>
              </span>
            </label>
          {/each}
        </fieldset>

        <div class="field">
          <label for="{uid}-model">{t('settings:ai.modelLabel')}</label>
          <div class="row wrap">
            <input
              id="{uid}-model"
              class="grow"
              list="{uid}-models"
              bind:value={form.model}
              placeholder={t('settings:ai.modelPlaceholder')}
              autocomplete="off"
              spellcheck="false"
              aria-invalid={errors.model ? 'true' : undefined}
              aria-describedby="{uid}-model-hint"
            />
            <datalist id="{uid}-models">
              {#each options as m (m.id)}<option value={m.id}>{m.label ?? ''}</option>{/each}
            </datalist>
            <Button icon="refresh" loading={loadingModels} disabled={loadingModels} onclick={() => void loadModels(true)}>{t('settings:ai.loadModels')}</Button>
          </div>
          <p class="hint" id="{uid}-model-hint">
            {t('settings:ai.modelHint')}
          </p>
          {#if errors.model}<p class="field-error" role="alert">{errors.model}</p>{/if}
          {#if modelsProblem}
            <p class="hint" role="status">{modelsProblem}</p>
          {:else if loadingModels}
            <p class="hint" role="status">{t('settings:ai.modelsLoading')}</p>
          {:else if modelNote}
            <p class="hint" role="status">{modelNote}</p>
          {:else if shownModels && shownModels.models.length > 0}
            <p class="hint" role="status">{notListed ? t('settings:ai.modelsCountNotListed', { count: shownModels.models.length }) : modelsCountText(shownModels.models.length)}</p>
          {/if}
        </div>

        {#if choice?.needsUrl}
          <TextField
            label={t('settings:ai.addressLabel')}
            bind:value={form.baseUrl}
            placeholder="https://models.example.com/v1"
            hint={t('settings:ai.addressHint')}
            error={errors.baseUrl}
            autocomplete="off"
            spellcheck="false"
          />
          <Disclosure summary={t('settings:ai.addressAboutSummary')}>
            <p class="hint">{t('settings:ai.addressAboutText')}</p>
          </Disclosure>
          {#if advice}
            <Alert tone={advice.tone}>{advice.text}</Alert>
          {:else if needsV1Hint(form.baseUrl)}
            <p class="hint">{t('settings:ai.addressV1')}</p>
          {/if}
        {/if}

        <div class="field">
          <TextField
            label={t('settings:ai.keyLabel')}
            type="password"
            bind:value={form.apiKey}
            placeholder={choice?.credentialPresent ? t('settings:ai.keySaved') : choice && !choice.credentialRequired ? t('settings:ai.keyOptional') : ''}
            hint={t('settings:ai.keyHint')}
            error={errors.apiKey}
            autocomplete="new-password"
            spellcheck="false"
          />
          <p class="connection">
            <Badge tone={keyWord.tone} icon={keyWord.tone === 'ok' ? 'check' : undefined}>{keyWord.label}</Badge>
            <a class="link sm" href="#/credentials">{t('settings:ai.manageCredentials')}</a>
          </p>
        </div>

        {#if localModel}
          <p class="hint">
            {t('settings:ai.localModel')}
          </p>
        {:else}
        <div class="field">
          <label for="{uid}-budget">{t('settings:ai.budgetLabel')}</label>
          <input id="{uid}-budget" inputmode="numeric" bind:value={form.budget} autocomplete="off" aria-invalid={errors.budget ? 'true' : undefined} aria-describedby="{uid}-budget-hint" />
          <p class="hint" id="{uid}-budget-hint">
            {t('settings:ai.budgetHint')}
          </p>
          <p class="warn-line">{t('settings:ai.budgetWarn')}</p>
          {#if errors.budget}<p class="field-error" role="alert">{errors.budget}</p>{/if}
        </div>

        <div class="field">
          <label for="{uid}-soft">{t('settings:ai.softLabel')}</label>
          <input id="{uid}-soft" inputmode="numeric" bind:value={form.softWarn} autocomplete="off" aria-invalid={errors.softWarn ? 'true' : undefined} aria-describedby="{uid}-soft-hint" />
          <p class="hint" id="{uid}-soft-hint">
            {t('settings:ai.softHint')}
          </p>
          {#if errors.softWarn}<p class="field-error" role="alert">{errors.softWarn}</p>{/if}
        </div>

        <fieldset class="field">
          <legend>{t('settings:ai.costLegend')}</legend>
          <p class="hint">{t('settings:ai.costHint')}</p>
          <p class="warn-line">{t('settings:ai.costWarn')}</p>
          <div class="row wrap">
            <div class="field">
              <label for="{uid}-price-in">{t('settings:ai.priceInLabel')}</label>
              <input id="{uid}-price-in" inputmode="decimal" bind:value={form.priceIn} autocomplete="off" aria-invalid={errors.priceIn ? 'true' : undefined} />
              {#if errors.priceIn}<p class="field-error" role="alert">{errors.priceIn}</p>{/if}
            </div>
            <div class="field">
              <label for="{uid}-price-out">{t('settings:ai.priceOutLabel')}</label>
              <input id="{uid}-price-out" inputmode="decimal" bind:value={form.priceOut} autocomplete="off" aria-invalid={errors.priceOut ? 'true' : undefined} />
              {#if errors.priceOut}<p class="field-error" role="alert">{errors.priceOut}</p>{/if}
            </div>
            <div class="field">
              <label for="{uid}-cap">{t('settings:ai.capLabel')}</label>
              <input id="{uid}-cap" inputmode="decimal" bind:value={form.costCap} autocomplete="off" aria-invalid={errors.costCap ? 'true' : undefined} />
              {#if errors.costCap}<p class="field-error" role="alert">{errors.costCap}</p>{/if}
            </div>
          </div>
          <Disclosure summary={t('settings:ai.pricesAboutSummary')}>
            <p class="hint">{t('settings:ai.pricesAboutText')}</p>
          </Disclosure>
        </fieldset>
        {/if}
      {/if}

      <div class="field">
        <p class="usage">
          {#if fraction !== null}<progress value={fraction} max="1" aria-label={t('settings:ai.usageMeter')}></progress>{/if}
          <span class="hint">{usageText(data.usage)}</span>
        </p>
        {#if costLine(data.usage)}<p class="hint">{costLine(data.usage)}</p>{/if}
        {#if data.usage.warning}
          <Alert tone={data.usage.warning.level === 'limit' ? 'error' : 'warn'}>{data.usage.warning.message}</Alert>
        {/if}
        {#if (data.usage.byTask ?? []).length > 0}
          <details class="bytask">
            <summary class="hint">{t('settings:ai.byTaskSummary')}</summary>
            <ul class="plain">
              {#each data.usage.byTask ?? [] as u (u.task)}
                <li>
                  {#if data.usage.pricesSet}
                    {t('settings:ai.byTaskCost', { task: tasks?.tasks.find((task) => task.id === u.task)?.label ?? u.task, count: u.runs, tokens: countText(u.inputTokens + u.outputTokens), cost: centsText(u.costCents) })}
                  {:else}
                    {t('settings:ai.byTask', { task: tasks?.tasks.find((task) => task.id === u.task)?.label ?? u.task, count: u.runs, tokens: countText(u.inputTokens + u.outputTokens) })}
                  {/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>

      <div class="field">
        <p class="who">{providerSentence(saved)}</p>
        {#if saved || readyTasks.length > 0}
          <Disclosure summary={t('settings:ai.sentSummary')}>
            {#if saved}<p class="hint">{saved.privacy}</p>{/if}
          {#if readyTasks.length > 0}
          <ul class="tasks">
            {#each readyTasks as task (task.id)}
              <li>
                <span>{task.label}</span>
                <InfoTip label={t('settings:ai.taskSends', { task: task.label })} buttonText={t('settings:ai.whatIsSent')} width="30rem" align="start">
                  <div class="tip stack tight">
                    <p>{task.description}</p>
                    <h4>{t('settings:ai.sent')}</h4>
                    <ul class="plain">{#each task.disclosure.sends as line (line)}<li>{line}</li>{/each}</ul>
                    <h4>{t('settings:ai.neverSent')}</h4>
                    <ul class="plain">{#each task.disclosure.neverSends as line (line)}<li>{line}</li>{/each}</ul>
                  </div>
                </InfoTip>
              </li>
            {/each}
          </ul>
          {/if}
          </Disclosure>
        {/if}
      </div>

      {#if saveError}<Alert tone="error">{saveError}</Alert>{/if}

      {#if editable}
        <div class="field">
          <p class="connection">
            <Badge tone={testState.tone}>{testState.label}</Badge>
            <Button size="sm" variant="ghost" icon="refresh" loading={testing} disabled={dirty || testing || data.state !== 'ready'} onclick={() => void test()}>{t('settings:ai.testButton')}</Button>
          </p>
          <p class="hint">
            {#if dirty}{t('settings:ai.testSaveFirst')}{:else if data.state !== 'ready'}{t('settings:ai.testNeedsReady')}{:else}{t('settings:ai.testNote')}{/if}
          </p>
          {#if result}
            <Alert tone={result.ok ? 'ok' : 'error'}>{result.text}</Alert>
          {/if}
          {#if sample}
            <div class="sample">
              <p class="hint">{t('settings:ai.sample')}</p>
              <pre>{sample}</pre>
            </div>
          {/if}
        </div>
        <SaveBar type="submit" {dirty} {saving} saveLabel={t('settings:ai.saveLabel')} ondiscard={revert} />
      {/if}
    </form>
  {/if}
</Card>

<style>
  fieldset {
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  legend {
    padding: 0;
    margin: 0 0 var(--space-1);
    font-weight: 600;
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
    align-items: center;
    margin: 0;
    font-weight: 500;
  }

  .option input {
    margin-top: 0.3rem;
  }

  .block {
    display: block;
  }

  .grow {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .who {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .usage {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    margin: 0;
  }

  progress {
    width: 12rem;
    max-width: 100%;
  }

  .tasks {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0;
    margin: var(--space-2) 0 0;
    list-style: none;
  }

  .tasks li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .tip h4 {
    margin: 0;
    font-size: var(--text-sm);
  }

  .tip p {
    margin: 0;
  }

  .sample pre {
    max-height: 9rem;
    padding: var(--space-2);
    margin: 0;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-sunken);
    border-radius: var(--radius-sm);
  }

  .plain {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-left: var(--space-4);
    margin: 0;
  }
</style>
