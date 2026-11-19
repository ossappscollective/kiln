<!--
  ReviewsAi: the quiet AI row of the reviews of one app: "Summarise" (what customers write about, with counts), "What to fix next" (the
  problems in low-rated reviews, by app version, and a draft for "What is new") and "Tag reviews" (a topic, a mood and a severity per
  review, kept so a review is never paid for twice). Each makes a REPORT or tags: nothing in a store, nothing about a review changes.
  Drawn only when AI is on and the role may use it. The reports show right below, in the tray of this app; the tags show on the reviews.
  A run sends review text with names, emails, links and numbers taken out, and never the author, the device or the country (the
  "Show exactly what will be sent" in each popover lists it).
  Props: api, workspaceId, role, app (the app record), reviewIds (the reviews on screen, to read their tags), onclassified? (after tagging).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { suggestAvailability } from '../../lib/ai.ts';
  import { aiStore } from '../../lib/ai-store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import SuggestButton from '../ai/SuggestButton.svelte';

  let { api, workspaceId, role, app, reviewIds }: { api: Api; workspaceId: string; role: Role; app: AppSummary; reviewIds: string[] } = $props();

  const uid = $props.id();
  const REPORTS = ['review_summary', 'fix_next', 'review_classify'];

  let days = $state(30);
  const config = $derived(aiStore.config(workspaceId));
  const visible = $derived(suggestAvailability({ role, config, kind: 'insight' }).visible);
  const on = $derived(config !== null && config.state !== 'off_server' && config.state !== 'off_workspace');

  $effect(() => {
    if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
  });

  // Tags that were made earlier show on the reviews that are on screen (a read of our own database; no provider).
  $effect(() => {
    const ids = reviewIds;
    const appId = app.id;
    if (!on || ids.length === 0) return;
    untrack(() => void aiStore.loadTags(api, workspaceId, appId, ids));
  });

  async function summarise() {
    await aiStore.run(api, workspaceId, 'review_summary', { appId: app.id, days });
  }

  async function fixNext() {
    await aiStore.run(api, workspaceId, 'fix_next', { appId: app.id, days });
  }

  async function tag() {
    const made = await aiStore.run(api, workspaceId, 'review_classify', { appId: app.id, days });
    // The tags are stored by the run: read them for the reviews on screen, and say what is left.
    await aiStore.loadTags(api, workspaceId, app.id, reviewIds, true);
    const p = made.proposal;
    if (p.kind === 'insight' && p.insight === 'review_classify' && p.remaining > 0) {
      toast.info(`${p.remaining} more reviews can be tagged. Run it again to continue.`);
    }
  }
</script>

{#if visible}
  <section class="ai" aria-label="AI assistance for the reviews">
    <div class="row wrap bar">
      <span class="muted small">AI</span>
      <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="review_summary" label="Summarise" hiddenLabel="the reviews of the last {days} days" onrun={summarise} preview={{ appId: app.id, days }} />
      <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="fix_next" label="What to fix next" onrun={fixNext} preview={{ appId: app.id, days }} />
      <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="review_classify" label="Tag reviews" onrun={tag} preview={{ appId: app.id, days }} />
      <label class="period">
        <span class="visually-hidden">Reviews of the last</span>
        <select id="{uid}-days" bind:value={days} aria-label="Period the AI looks at">
          <option value={7}>last 7 days</option>
          <option value={30}>last 30 days</option>
          <option value={90}>last 90 days</option>
        </select>
      </label>
    </div>
    <AiSuggestions {api} {workspaceId} {role} {app} platform={app.platform} tasks={REPORTS} />
  </section>
{/if}

<style>
  .ai {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .bar {
    gap: var(--space-2);
    align-items: center;
  }

  .small {
    font-size: var(--text-xs);
  }

  .period select {
    width: auto;
  }
</style>
