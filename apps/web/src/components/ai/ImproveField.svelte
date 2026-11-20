<!--
  ImproveField: "Improve" for one listing field of one locale (the locale drawer). It asks the assistant to rewrite that one field within the
  store's limit, from the text the server already holds. The answer shows under the field as a proposal with a meter against the limit and
  its flags: over the limit cannot be accepted, a trimmed keyword field says so. Accepting STAGES the text (the staged-changes tray and
  Pending changes show it); nothing reaches a store until the previewed, confirmed draft push, which this never starts.
  Drawn only for a field a draft push can write, on a version that is not locked, and only when AI is on and the role may use it.
  The proposal is shown with what the field says now beside it (before and after, changes underlined), and the person stages it
  ("Stage in keyword field") or dismisses it. It is a suggestion: nothing changes until it is staged.
  Props: api, workspaceId, role, app (the app: id and platform), field (the drift field: its locale, id and label), current? (the text
  the field has now, for the before and after), buttonLabel? ("Improve" by default), onaccepted? (called after the text was staged).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { canImproveField } from '../../lib/ai/ai.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import type { AppSummary, DriftField } from '../../lib/types.ts';
  import type { AiAcceptedRef } from '@mrm/core';
  import AiSuggestionCard from './AiSuggestionCard.svelte';
  import SuggestButton from './SuggestButton.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    field,
    current,
    buttonLabel = 'Improve',
    onaccepted,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'platform'>;
    field: Pick<DriftField, 'locale' | 'field' | 'label'>;
    current?: string | null | undefined;
    buttonLabel?: string | undefined;
    onaccepted?: ((result: AiAcceptedRef) => void | Promise<void>) | undefined;
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
    <SuggestButton {api} {workspaceId} {role} kind="listing_text" taskId="listing_improve" label={buttonLabel} hiddenLabel="{field.label} ({field.locale}) with AI" onrun={run} />
    {#if shown}
      <AiSuggestionCard
        {api}
        {workspaceId}
        {role}
        suggestion={shown}
        platform={app.platform}
        compact
        current={current === undefined || current === null ? undefined : { [field.field]: current }}
        {onaccepted}
      />
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
