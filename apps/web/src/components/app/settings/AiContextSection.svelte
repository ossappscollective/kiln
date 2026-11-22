<!--
  AiContextSection: "AI assistant" in the settings of an app: what the assistant should know about THIS app, once, instead of in every
  request: what the app is, who it is for, the tone and voice of replies and texts, words that must never appear, names that must stay as
  written, and a few do and don't rules. Every AI task that suits it receives the filled-in parts (a short "what will be sent" is in the
  preview of each run). The assistant follows it as well as a model can: a word on the banned list in a suggestion is flagged and cannot be
  accepted. It is never a promise that a model obeys; the person still reads every suggestion.
  Drawn only when AI is on for the workspace and the role may use it. Reading needs `ai.use`; saving needs the right to edit the app (admin).
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { aiErrorMessage } from '../../../lib/ai/ai.ts';
  import {
    type AiContextErrors,
    type AiContextForm,
    contextLimits,
    contextToForm,
    isContextDirty,
    validateContextForm,
  } from '../../../lib/ai/insights.ts';
  import { aiStore } from '../../../lib/ai/store.svelte.ts';
  import type { Api } from '../../../lib/api.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import { toast } from '../../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';
  import SaveBar from './SaveBar.svelte';
  import SettingsCard from './SettingsCard.svelte';
  import type { AiAppContextView } from '../../../lib/ai/ai.ts';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const uid = $props.id();
  const config = $derived(aiStore.config(workspaceId));
  const on = $derived(can(role, 'ai.use') && config !== null && config.state !== 'off_server' && config.state !== 'off_workspace');

  let saved = $state<Record<string, AiAppContextView | undefined>>({});
  let forms = $state<Record<string, AiContextForm | undefined>>({});
  let errors = $state<Record<string, AiContextErrors | undefined>>({});
  let problems = $state<Record<string, string | undefined>>({});
  let saving = $state<Record<string, boolean | undefined>>({});
  let loadFailed = $state(false);

  $effect(() => {
    if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
  });

  $effect(() => {
    const ids = members.map((m) => m.id);
    const ws = workspaceId;
    if (!on) return;
    untrack(() => {
      loadFailed = false;
      for (const id of ids) {
        if (saved[id] !== undefined) continue;
        api
          .appAiContext(ws, id)
          .then((view) => {
            saved[id] = view;
            forms[id] = contextToForm(view.context);
          })
          .catch(() => {
            loadFailed = true;
          });
      }
    });
  });

  async function save(app: AppSummary, event: SubmitEvent) {
    event.preventDefault();
    const form = forms[app.id];
    if (!form || saving[app.id]) return;
    const checked = validateContextForm(form);
    if (!checked.ok) {
      errors[app.id] = checked.errors;
      return;
    }
    errors[app.id] = {};
    problems[app.id] = '';
    saving[app.id] = true;
    try {
      const view = await api.updateAppAiContext(workspaceId, app.id, checked.value);
      saved[app.id] = view;
      forms[app.id] = contextToForm(view.context);
      toast.success(t('app:ai.saved'));
    } catch (e) {
      problems[app.id] = aiErrorMessage(e, t('app:ai.saveFailed'));
    } finally {
      saving[app.id] = false;
    }
  }

  function revert(app: AppSummary) {
    const view = saved[app.id];
    if (view) forms[app.id] = contextToForm(view.context);
    errors[app.id] = {};
    problems[app.id] = '';
  }

  const field = (name: string, id: string): string => `${uid}-${id}-${name}`;
</script>

{#if on}
  <SettingsCard
    title={t('app:settings.part.ai')}
    icon="sparkles"
    key="ai-context"
    defaultOpen={false}
    description={t('app:ai.description')}
  >
    {#if loadFailed && members.every((m) => saved[m.id] === undefined)}
      <Alert tone="error">{t('app:ai.loadFailed')}</Alert>
    {/if}
    {#each members as app (app.id)}
      {@const view = saved[app.id]}
      {@const form = forms[app.id]}
      {@const err = errors[app.id] ?? {}}
      {#if members.length > 1}<h4 class="plat">{platformLabel(app.platform)}</h4>{/if}
      {#if !view || !form}
        <Skeleton height="120px" />
      {:else}
        {@const editable = view.canEdit}
        <form class="stack loose" onsubmit={(e) => void save(app, e)} novalidate>
          {#if !editable}<p class="hint">{t('app:ai.adminOnly')}</p>{/if}

          <fieldset class="group">
            <legend>{t('app:ai.aboutLegend')}</legend>
            <p class="sub">{t('app:ai.aboutSub')}</p>
            <div class="field">
              <label for={field('about', app.id)}>{t('app:ai.whatItIs')}</label>
              <textarea id={field('about', app.id)} rows="3" bind:value={form.about} readonly={!editable} maxlength={contextLimits.aboutChars + 200} aria-invalid={err.about ? 'true' : undefined}></textarea>
              <p class="hint">{t('app:ai.aboutHint', { max: contextLimits.aboutChars, now: form.about.length })}</p>
              {#if err.about}<p class="field-error" role="alert">{err.about}</p>{/if}
            </div>
            <div class="field">
              <label for={field('audience', app.id)}>{t('app:ai.audience')}</label>
              <input id={field('audience', app.id)} bind:value={form.audience} readonly={!editable} autocomplete="off" aria-invalid={err.audience ? 'true' : undefined} />
              {#if err.audience}<p class="field-error" role="alert">{err.audience}</p>{/if}
            </div>
          </fieldset>

          <fieldset class="group">
            <legend>{t('app:ai.soundLegend')}</legend>
            <p class="sub">{t('app:ai.soundSub')}</p>
            <div class="field">
              <label for={field('tone', app.id)}>{t('app:ai.tone')}</label>
              <input id={field('tone', app.id)} bind:value={form.tone} readonly={!editable} placeholder={t('app:ai.tonePlaceholder')} autocomplete="off" aria-invalid={err.tone ? 'true' : undefined} />
              {#if err.tone}<p class="field-error" role="alert">{err.tone}</p>{/if}
            </div>
            <div class="field">
              <label for={field('voice', app.id)}>{t('app:ai.voice')}</label>
              <textarea id={field('voice', app.id)} rows="3" bind:value={form.brandVoice} readonly={!editable} maxlength={contextLimits.brandVoiceChars + 200} aria-invalid={err.brandVoice ? 'true' : undefined}></textarea>
              <p class="hint">{t('app:ai.voiceHint', { max: contextLimits.brandVoiceChars, now: form.brandVoice.length })}</p>
              {#if err.brandVoice}<p class="field-error" role="alert">{err.brandVoice}</p>{/if}
            </div>
          </fieldset>

          <fieldset class="group">
            <legend>{t('app:ai.rulesLegend')}</legend>
            <p class="sub">{t('app:ai.rulesSub')}</p>
            <div class="grid">
              <div class="field">
                <label for={field('banned', app.id)}>{t('app:ai.banned')}</label>
                <textarea id={field('banned', app.id)} rows="3" bind:value={form.bannedWords} readonly={!editable} aria-invalid={err.bannedWords ? 'true' : undefined}></textarea>
                <p class="hint">{t('app:ai.bannedHint')}</p>
                {#if err.bannedWords}<p class="field-error" role="alert">{err.bannedWords}</p>{/if}
              </div>
              <div class="field">
                <label for={field('brand', app.id)}>{t('app:ai.brand')}</label>
                <textarea id={field('brand', app.id)} rows="3" bind:value={form.brandTerms} readonly={!editable} aria-invalid={err.brandTerms ? 'true' : undefined}></textarea>
                <p class="hint">{t('app:ai.brandHint')}</p>
                {#if err.brandTerms}<p class="field-error" role="alert">{err.brandTerms}</p>{/if}
              </div>
              <div class="field">
                <label for={field('do', app.id)}>{t('app:ai.always')}</label>
                <textarea id={field('do', app.id)} rows="3" bind:value={form.doList} readonly={!editable} aria-invalid={err.doList ? 'true' : undefined}></textarea>
                <p class="hint">{t('app:ai.rulesHint', { max: contextLimits.ruleItems })}</p>
                {#if err.doList}<p class="field-error" role="alert">{err.doList}</p>{/if}
              </div>
              <div class="field">
                <label for={field('dont', app.id)}>{t('app:ai.never')}</label>
                <textarea id={field('dont', app.id)} rows="3" bind:value={form.dontList} readonly={!editable} aria-invalid={err.dontList ? 'true' : undefined}></textarea>
                <p class="hint">{t('app:ai.rulesHint', { max: contextLimits.ruleItems })}</p>
                {#if err.dontList}<p class="field-error" role="alert">{err.dontList}</p>{/if}
              </div>
            </div>
          </fieldset>

          <p class="hint warning">{t('app:ai.warning')}</p>
          {#if problems[app.id]}<Alert tone="error">{problems[app.id]}</Alert>{/if}
          {#if editable}
            <SaveBar type="submit" dirty={isContextDirty(view.context, form)} saving={saving[app.id] === true} ondiscard={() => revert(app)} />
          {/if}
        </form>
      {/if}
    {/each}
  </SettingsCard>
{/if}

<style>
  .plat {
    margin: 0;
    font-size: 0.9375rem;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .group legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .sub,
  .hint {
    margin: 0;
    font-size: 0.9375rem;
    line-height: 1.4;
    color: var(--muted);
  }

  .hint.warning {
    color: var(--ink);
  }

  .group .field,
  .grid .field {
    margin-bottom: 0;
  }

  .field label {
    font-size: 0.9375rem;
    font-weight: var(--weight-semibold);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-4);
  }
</style>
