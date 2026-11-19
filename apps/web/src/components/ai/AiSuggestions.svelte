<!--
  AiSuggestions: the suggestions tray of one app, as one quiet line ("AI suggestions (2)") that opens to the open proposals. Nothing is
  drawn while AI is off for the workspace, while the role may not use it, or while the app has no open suggestion: a screen without
  AI looks as it did. A run that just finished opens the tray by itself. Each suggestion is a proposal a person accepts or dismisses
  (AiSuggestionCard); accepting uses an existing mechanism and says where the result is.
  Props: api, workspaceId, role, app (the app record), platform? (the scope of the open app, for links), showPlatform? (name the
  platform in the line when the page shows several), kind? (only the suggestions of this kind: the Keywords views list the keyword ideas
  they asked for), tasks? (only the suggestions of these tasks, which is also how a screen shows the reports it asked for), onaccepted? (the screen reads its own list again after an accept or an undo).
-->
<script lang="ts">
  import { type AiAcceptedRef, type AiProposalKind, type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { openLine } from '../../lib/ai.ts';
  import { aiStore } from '../../lib/ai-store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Disclosure from '../ui/Disclosure.svelte';
  import AiSuggestionCard from './AiSuggestionCard.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    platform = null,
    showPlatform = false,
    kind = null,
    tasks = null,
    onaccepted,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    platform?: PlatformScope | null;
    showPlatform?: boolean;
    kind?: AiProposalKind | null;
    tasks?: string[] | null;
    onaccepted?: (result: AiAcceptedRef) => void | Promise<void>;
  } = $props();

  const canUse = $derived(can(role, 'ai.use'));
  const config = $derived(aiStore.config(workspaceId));
  const on = $derived(config !== null && config.state !== 'off_server' && config.state !== 'off_workspace');
  // Reports (insights) show only where they were asked for: a tray that names no kind and no task leaves them out.
  const list = $derived(
    aiStore
      .shown(app.id)
      .filter((s) => (kind === null || s.kind === kind) && (tasks === null || tasks.indexOf(s.task) !== -1) && (kind !== null || tasks !== null || s.kind !== 'insight')),
  );
  const count = $derived(list.filter((s) => s.status === 'proposed').length);

  let open = $state(false);

  $effect(() => {
    if (canUse) void aiStore.loadConfig(api, workspaceId);
  });

  // Read the open suggestions once AI is known to be on (a switched-off feature is not asked).
  $effect(() => {
    const id = app.id;
    if (!canUse || !on) return;
    untrack(() => void aiStore.loadSuggestions(api, workspaceId, id));
  });

  // A run that just finished opens the tray.
  let seen = 0;
  $effect(() => {
    const n = aiStore.freshCount(app.id);
    untrack(() => {
      if (n > seen) open = true;
      seen = n;
    });
  });
</script>

{#if canUse && on && list.length > 0}
  <section class="tray" aria-label="AI suggestions{showPlatform ? `, ${platformLabel(app.platform)}` : ''}">
    <Disclosure bind:open stateKey="ai.tray.{app.id}" summary="{openLine(count > 0 ? count : list.length)}{showPlatform ? ` · ${platformLabel(app.platform)}` : ''}">
      <div class="stack">
        <p class="muted small">
          Proposals only. Nothing changes until you accept one, and nothing is sent to a store: staged texts still go through Pending changes.
        </p>
        {#each list as s (s.id)}
          <AiSuggestionCard {api} {workspaceId} {role} suggestion={s} {platform} appPlatform={app.platform} {onaccepted} />
        {/each}
      </div>
    </Disclosure>
  </section>
{/if}

<style>
  .small {
    margin: 0;
    font-size: var(--text-xs);
  }
</style>
