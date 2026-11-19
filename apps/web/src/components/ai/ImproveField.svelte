<!--
  ImproveField: "Improve" for one listing field of one locale (the locale drawer). It asks the assistant to rewrite that one field within the
  store's limit, from the text the server already holds. The answer shows under the field as a proposal with a meter against the limit and
  its flags: over the limit cannot be accepted, a trimmed keyword field says so. Accepting STAGES the text (the staged-changes tray and
  Pending changes show it); nothing reaches a store until the previewed, confirmed draft push, which this never starts.
  Drawn only for a field a draft push can write, on a version that is not locked, and only when AI is on and the role may use it.
  Props: api, workspaceId, role, app (the app record), field (the drift field: its locale and id), label (the field's name).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { canImproveField } from '../../lib/ai.ts';
  import { aiStore } from '../../lib/ai-store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import type { AppSummary, DriftField } from '../../lib/types.ts';
  import AiSuggestionCard from './AiSuggestionCard.svelte';
  import SuggestButton from './SuggestButton.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    field,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    field: Pick<DriftField, 'locale' | 'field' | 'label'>;
  } = $props();

  let suggestionId = $state<string | null>(null);
  const eligible = $derived(canImproveField(app.platform, field.field));
  const made = $derived(suggestionId === null ? null : aiStore.byId(app.id, suggestionId));
  const shown = $derived(made !== null && (made.status === 'proposed' || aiStore.settled(made.id) !== null) ? made : null);

  // Another field or locale starts clean.
  let key = '';
  $effect(() => {
    const next = `${app.id}/${field.locale}/${field.field}`;
    if (next !== key) {
      key = next;
      suggestionId = null;
    }
  });

  async function run() {
    const s = await aiStore.run(api, workspaceId, 'listing_improve', { appId: app.id, locale: field.locale, fields: [field.field] });
    suggestionId = s.id;
  }
</script>

{#if eligible}
  <div class="improve">
    <SuggestButton {api} {workspaceId} {role} kind="listing_text" taskId="listing_improve" label="Improve" hiddenLabel="{field.label} ({field.locale}) with AI" onrun={run} />
    {#if shown}
      <AiSuggestionCard {api} {workspaceId} {role} suggestion={shown} platform={app.platform} compact />
    {/if}
  </div>
{/if}

<style>
  .improve {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
    margin-top: var(--space-2);
  }

  .improve :global(.card-ai),
  .improve > :global(article) {
    align-self: stretch;
  }
</style>
