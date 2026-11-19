<!--
  ListingAi: the quiet AI row under the keywords in the store listing of an app: for ONE language it can audit the listing text ("Audit this
  language": lengths and keyword coverage counted here, findings in words), suggest variants of the fields a draft push can stage, and
  translate the text of another language into this one. Each makes a PROPOSAL or a REPORT that shows in the tray of this app: nothing is
  staged until a person accepts it there, and nothing is sent to a store until Pending changes pushes it, with its own confirmation.
  Drawn only when AI is on and the role may use it. It reads the stored listing text; it never contacts a store.
  Props: api, workspaceId, role, app (the app record), locales (the languages of the stored listing).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { suggestAvailability } from '../../lib/ai.ts';
  import { aiStore } from '../../lib/ai-store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import SuggestButton from '../ai/SuggestButton.svelte';

  let { api, workspaceId, role, app, locales }: { api: Api; workspaceId: string; role: Role; app: AppSummary; locales: string[] } = $props();

  const uid = $props.id();
  const TASKS = ['listing_audit', 'listing_variants', 'listing_translate'];

  let chosen = $state('');
  let source = $state('');
  let goal = $state('');

  const locale = $derived(chosen !== '' && locales.indexOf(chosen) !== -1 ? chosen : (locales[0] ?? ''));
  const others = $derived(locales.filter((l) => l !== locale));
  const from = $derived(source !== '' && others.indexOf(source) !== -1 ? source : (others[0] ?? ''));
  const text = $derived(goal.trim());
  const config = $derived(aiStore.config(workspaceId));
  // The stage needed by the variants and the translation: the same right as accepting listing text.
  const canStage = $derived(can(role, 'changesets.write'));
  const visible = $derived(locales.length > 0 && suggestAvailability({ role, config, kind: 'insight' }).visible);

  async function audit() {
    await aiStore.run(api, workspaceId, 'listing_audit', { appId: app.id, locale, ...(text ? { goal: text } : {}) });
  }

  async function variants() {
    await aiStore.run(api, workspaceId, 'listing_variants', { appId: app.id, locale, ...(text ? { goal: text } : {}) });
  }

  async function translate() {
    await aiStore.run(api, workspaceId, 'listing_translate', { appId: app.id, locale, sourceLocale: from });
  }
</script>

{#if visible}
  <section class="ai" aria-label="AI assistance for the store listing">
    <div class="row wrap bar">
      <span class="muted small">AI</span>
      <label class="pick">
        <span class="small">Language</span>
        <select id="{uid}-locale" value={locale} onchange={(e) => (chosen = e.currentTarget.value)} aria-label="Language the AI works on">
          {#each locales as l (l)}<option value={l}>{l}</option>{/each}
        </select>
      </label>
      <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="listing_audit" label="Audit this language" onrun={audit} preview={{ appId: app.id, locale }} />
      {#if canStage}
        <SuggestButton {api} {workspaceId} {role} kind="listing_variants" taskId="listing_variants" label="Suggest variants" onrun={variants} preview={{ appId: app.id, locale }} />
        {#if others.length > 0}
          <SuggestButton
            {api}
            {workspaceId}
            {role}
            kind="listing_text"
            taskId="listing_translate"
            label="Translate into {locale}"
            hiddenLabel="from {from}"
            onrun={translate}
            preview={{ appId: app.id, locale, sourceLocale: from }}
            disabledReason={from === '' ? 'There is no other language with stored text.' : null}
          />
          <label class="pick">
            <span class="small">from</span>
            <select id="{uid}-from" value={from} onchange={(e) => (source = e.currentTarget.value)} aria-label="Language to translate from">
              {#each others as l (l)}<option value={l}>{l}</option>{/each}
            </select>
          </label>
        {/if}
      {/if}
    </div>
    <label class="goal">
      <span class="small muted">What should the text achieve? (optional, for the audit and the variants)</span>
      <input id="{uid}-goal" bind:value={goal} maxlength="300" autocomplete="off" placeholder="for example: mention the new offline mode" />
    </label>
    <AiSuggestions {api} {workspaceId} {role} {app} platform={app.platform} tasks={TASKS} />
  </section>
{/if}

<style>
  .ai {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .bar {
    gap: var(--space-2);
    align-items: center;
  }

  .small {
    font-size: var(--text-xs);
  }

  .pick {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .pick select {
    width: auto;
  }

  .goal {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
</style>
