<!--
  ReviewsAi: the quiet AI row of the reviews of one app: "Summarise" (what customers write about, with counts), "What to fix next" (the
  problems in low-rated reviews, by app version, and a draft for "What is new") and "Tag reviews" (a topic, a mood and a severity per
  review, kept so a review is never paid for twice). Each makes a REPORT or tags: nothing in a store, nothing about a review changes.
  Drawn only when AI is on and the role may use it. The reports show right below, in the tray of this app; the tags show on the reviews.
  A run sends review text with names, emails, links and numbers taken out, and never the author, the device or the country (the
  "Show exactly what will be sent" in each popover lists it).
  The summary follows the page: the app (so the store), the language filter and the period. A summary of the same reviews is reused (nothing is
  sent); a line says how old it is and how many reviews came after it, and Regenerate makes a new one. It is written in the language of the screen.
  Props: api, workspaceId, role, app (the app record), language (the language filter of the page, '' for all), reviewIds (the reviews on screen, to read their tags), onclassified? (after tagging).
-->
<script lang="ts">
  import { currentLocale, t } from '../../lib/i18n/t.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { suggestAvailability } from '../../lib/ai/ai.ts';
  import { privacySettingHref, type ReviewPrivacyView, reviewAiGate, workspaceAiSettingHref } from '../../lib/ai/review-privacy.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import SuggestButton from '../ai/SuggestButton.svelte';

  let { api, workspaceId, role, app, reviewIds, language = '' }: { api: Api; workspaceId: string; role: Role; app: AppSummary; reviewIds: string[]; language?: string } = $props();

  const uid = $props.id();
  const REPORTS = ['review_summary', 'fix_next', 'review_classify'];

  /** What a summary reads at most (the server's limits: docs/api/review-summary.md). */
  const SUMMARY_LIMIT = 40;
  const SUMMARY_CHARS = 280;
  let days = $state(28);
  const config = $derived(aiStore.config(workspaceId));
  const visible = $derived(suggestAvailability({ role, config, kind: 'insight' }).visible);
  const on = $derived(config !== null && config.state !== 'off_server' && config.state !== 'off_workspace');

  $effect(() => {
    if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
  });

  // What reviews of this app may go to the provider (the app's setting under the workspace ceiling). The server enforces it on every run; this
  // only explains it. While it cannot be read the buttons stay: a refused run says why.
  let privacy = $state<ReviewPrivacyView | null>(null);
  $effect(() => {
    const appId = app.id;
    const ws = workspaceId;
    if (!on || !can(role, 'ai.use')) return;
    untrack(() => {
      void api.appAiReviewPrivacy(ws, appId).then((view) => (privacy = view)).catch(() => undefined);
    });
  });
  const gate = $derived(reviewAiGate(privacy));

  // Tags that were made earlier show on the reviews that are on screen (a read of our own database; no provider).
  $effect(() => {
    const ids = reviewIds;
    const appId = app.id;
    if (!on || ids.length === 0) return;
    untrack(() => void aiStore.loadTags(api, workspaceId, appId, ids));
  });

  const uiLanguage = (): 'en' | 'fr' | 'es' | 'de' => {
    const base = currentLocale().slice(0, 2);
    return base === 'fr' || base === 'es' || base === 'de' ? base : 'en';
  };

  async function summarise(refresh = false) {
    await aiStore.run(api, workspaceId, 'review_summary', {
      appId: app.id,
      days,
      limit: SUMMARY_LIMIT,
      outputLanguage: uiLanguage(),
      ...(language ? { locale: language } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
  }

  // The latest summary for this period and language, and how many reviews came after the newest one it read (a read of our own database).
  const latest = $derived(
    (aiStore.all(app.id) ?? []).find(
      (s) =>
        s.task === 'review_summary' &&
        s.status !== 'dismissed' &&
        s.scope.days === days &&
        (s.scope.locale ?? '') === language,
    ) ?? null,
  );
  let newer = $state<{ count: number; more: boolean } | null>(null);
  $effect(() => {
    const found = latest;
    newer = null;
    if (!found || found.proposal.kind !== 'insight' || found.proposal.insight !== 'review_summary') return;
    const after = found.proposal.latestReviewAt;
    if (after === null || after === undefined) return;
    const appId = app.id;
    untrack(() => {
      void api
        .appReviews(workspaceId, appId, `since=${after + 1}&limit=50${language ? `&language=${encodeURIComponent(language)}` : ''}`)
        .then((page) => {
          if (latest === found) newer = { count: page.reviews.length, more: page.nextCursor !== null };
        })
        .catch(() => undefined);
    });
  });
  $effect(() => {
    if (on) untrack(() => void aiStore.loadSuggestions(api, workspaceId, app.id));
  });

  async function fixNext() {
    await aiStore.run(api, workspaceId, 'fix_next', { appId: app.id, days });
  }

  async function tag() {
    const made = await aiStore.run(api, workspaceId, 'review_classify', { appId: app.id, days });
    // The tags are stored by the run: read them for the reviews on screen, and say what is left.
    await aiStore.loadTags(api, workspaceId, app.id, reviewIds, true);
    const p = made.proposal;
    if (p.kind === 'insight' && p.insight === 'review_classify' && p.remaining > 0) {
      toast.info(t('reviews:ai.moreToTag', { count: p.remaining }));
    }
  }
</script>

{#if visible}
  <section class="ai" aria-label={t('reviews:ai.region')}>
    {#if gate.state === 'off'}
      <div class="off" role="status" data-testid="ai-reviews-off">
        <p>
          <strong>{t('reviews:ai.offTitle')}</strong>
          {gate.text}
          <a href={gate.reason === 'workspace_off' ? workspaceAiSettingHref : privacySettingHref(app.id)}>{gate.reason === 'workspace_off' ? t('reviews:ai.openWorkspaceSetting') : t('reviews:ai.openSetting')}</a>
        </p>
        {#if (aiStore.all(app.id) ?? []).some((s) => REPORTS.includes(s.task))}<p class="muted small" data-testid="ai-reviews-kept">{t('reviews:ai.keptNote')}</p>{/if}
      </div>
    {:else}
    <div class="row wrap bar">
      <span class="muted small">{t('reviews:ai.badge')}</span>
      <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="review_summary" label={latest ? t('reviews:ai.regenerate') : t('reviews:ai.summarise')} hiddenLabel={t('reviews:ai.summariseHidden', { n: days })} onrun={() => summarise(latest !== null)} preview={{ appId: app.id, days, limit: SUMMARY_LIMIT, outputLanguage: uiLanguage(), ...(language ? { locale: language } : {}) }} />
      {#if gate.state !== 'ratings'}
        <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="fix_next" label={t('reviews:ai.fixNext')} onrun={fixNext} preview={{ appId: app.id, days }} />
        <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="review_classify" label={t('reviews:ai.tag')} onrun={tag} preview={{ appId: app.id, days }} />
      {/if}
      <label class="period">
        <span class="visually-hidden">{t('reviews:ai.periodLabel')}</span>
        <select id="{uid}-days" bind:value={days} aria-label={t('reviews:ai.period')}>
          <option value={7}>{t('reviews:ai.lastDays', { n: 7 })}</option>
          <option value={28}>{t('reviews:ai.lastDays', { n: 28 })}</option>
          <option value={90}>{t('reviews:ai.lastDays', { n: 90 })}</option>
        </select>
      </label>
    </div>
    {#if gate.state === 'ratings'}
      <p class="muted small" data-testid="ratings-only">{gate.text}</p>
    {:else}
      <p class="muted small" data-testid="summary-notice">{t('reviews:ai.summaryNotice', { reviews: SUMMARY_LIMIT, chars: SUMMARY_CHARS })}</p>
    {/if}
    {#if latest && newer && newer.count > 0}
      <p class="muted small stale" data-testid="summary-stale">{newer.more ? t('reviews:ai.staleMany', { count: newer.count }) : t('reviews:ai.stale', { count: newer.count })}</p>
    {/if}
    {/if}
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

  .off {
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
  }

  .off p {
    margin: 0;
  }

  .period select {
    width: auto;
  }
</style>
