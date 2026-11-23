<!--
  InsightsCards: the Highlights view of Insights for one app record (docs/api/insights.md). What changed, what looks wrong and where to go:
  cards computed on read from stored analytics, reviews, keyword ranks and the live store page (no store is asked, no AI). Filter chips per
  category with counts, then the cards: a severity icon (the word is in the icon's name too), the headline, why it matters, the evidence as
  small figures, and one or two buttons that open the page that helps. "Dismiss" hides a card until its finding changes; a toast offers Undo.
  A rule that could not run says why (not enough days, the store sends no countries, no access), so an empty list is never a mystery.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished), openId + platform (the address of the open app, for the links).
-->
<script lang="ts">
  import { can, type InsightCard, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    actionHref,
    actionLabel,
    activeCategory,
    categoryChips,
    chipLabel,
    emptyKind,
    evidenceLine,
    explainOf,
    filterCards,
    headlineOf,
    type InsightsView,
    SEVERITY_ICON,
    SEVERITY_TONE,
    severityLabel,
    skipNotes,
    sortCards,
    withCardBack,
    withoutCard,
  } from '../../lib/insights/insights.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import FilterChip from '../ui/FilterChip.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    refreshKey,
    openId,
    platform = null,
  }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number; openId: string; platform?: PlatformScope | null | undefined } = $props();

  const mayDismiss = $derived(can(role, 'aso.write'));

  let view = $state<InsightsView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let selected = $state<'all' | InsightCard['category']>('all');
  let busy = $state('');
  let generation = 0;
  /** The cards as the server last sent them, to put a card back in its place on Undo without another read. */
  let original: InsightCard[] = [];

  async function load() {
    const mine = ++generation;
    loading = view === null;
    problem = '';
    try {
      const read = await api.appInsights(workspaceId, app.id);
      if (mine !== generation) return;
      view = { ...read, cards: sortCards(read.cards) };
      original = view.cards;
      navSignals.setInsightsCount(workspaceId, app.id, read.cards.length);
    } catch (e) {
      if (mine !== generation) return;
      problem = e instanceof ApiError ? e.message : t('insights:cards.loadError');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => void load());
  });

  const cards = $derived(view?.cards ?? []);
  const chips = $derived(categoryChips(cards));
  const category = $derived(activeCategory(selected, chips));
  const shown = $derived(filterCards(cards, category));
  const kind = $derived(view ? emptyKind(view) : 'none');
  const notes = $derived(view ? skipNotes(view.skipped) : []);
  const worst = $derived(cards[0]?.severity ?? null);

  function setCards(next: InsightCard[]) {
    if (!view) return;
    view = { ...view, cards: next };
    navSignals.setInsightsCount(workspaceId, app.id, next.length);
  }

  async function dismiss(card: InsightCard) {
    if (busy !== '' || !view) return;
    busy = card.id;
    try {
      await api.dismissInsight(workspaceId, app.id, card.id);
      setCards(withoutCard(cards, card.id));
      view = { ...view, hiddenCount: view.hiddenCount + 1 };
      toast.info(t('insights:cards.dismissed'), {
        timeout: 8000,
        action: { label: t('insights:cards.undo'), onclick: () => void undo(card) },
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('insights:cards.dismissFailed'));
    } finally {
      busy = '';
    }
  }

  async function undo(card: InsightCard) {
    try {
      await api.restoreInsights(workspaceId, app.id, card.id);
      if (view) {
        setCards(withCardBack(view.cards, card, original));
        view = { ...view, hiddenCount: Math.max(0, view.hiddenCount - 1) };
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('insights:cards.undoFailed'));
    }
  }

  async function restoreAll() {
    if (busy !== '') return;
    busy = '*';
    try {
      await api.restoreInsights(workspaceId, app.id);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('insights:cards.undoFailed'));
    } finally {
      busy = '';
    }
  }
</script>

<div class="stack loose" data-testid="insights-cards">
  {#if loading}
    <Skeleton height="7rem" />
    <Skeleton height="7rem" />
  {:else if problem}
    <Alert tone="error" title={t('insights:cards.loadErrorTitle')}>{problem}</Alert>
  {:else if view}
    <PageLead
      headline={cards.length > 0 ? t('insights:lead.headline', { count: cards.length }) : t('insights:lead.none')}
      hint={t('insights:lead.hint')}
      tone={worst === 'problem' ? 'bad' : worst === 'warning' ? 'warn' : worst === 'good' ? 'ok' : worst === 'info' ? 'info' : 'neutral'}
    />

    {#if chips.length > 1}
      <div class="chips" role="group" aria-label={t('insights:filter.label')}>
        {#each chips as chip (chip.id)}
          <FilterChip label={chipLabel(chip.id)} count={chip.count} pressed={category === chip.id} onclick={() => (selected = chip.id)} />
        {/each}
      </div>
    {/if}

    {#if shown.length > 0}
      <ul class="cards">
        {#each shown as card (card.id)}
          {@const tone = SEVERITY_TONE[card.severity]}
          <li class="card insight {tone}" data-severity={card.severity}>
            <div class="head">
              <span class="sev {tone}"><Icon name={SEVERITY_ICON[card.severity]} size={20} /><span class="visually-hidden">{severityLabel(card.severity)}</span></span>
              <div class="text">
                <h4>{headlineOf(card)}</h4>
                <p class="why">{explainOf(card)}</p>
              </div>
            </div>
            {#if card.evidence.length > 0}
              <dl class="evidence">
                {#each card.evidence as e (e.key)}
                  {@const line = evidenceLine(e)}
                  <div><dt>{line.label}</dt><dd class="num">{line.value}</dd></div>
                {/each}
              </dl>
            {/if}
            <div class="row actions">
              {#each card.actions.slice(0, 2) as action, i (action.code)}
                <Button href={actionHref(openId, action, platform)} variant={i === 0 ? 'secondary' : 'ghost'} size="sm">{actionLabel(action.code)}</Button>
              {/each}
              {#if mayDismiss}
                <span class="grow"></span>
                <Button variant="ghost" size="sm" icon="eye-off" loading={busy === card.id} disabled={busy !== ''} onclick={() => void dismiss(card)}>{t('insights:cards.dismiss')}</Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else if kind === 'none'}
      <p class="muted">{t('insights:filter.empty')}</p>
    {:else if kind === 'hidden'}
      <EmptyState icon="check-circle" title={t('insights:empty.hiddenTitle')} description={t('insights:empty.hidden', { count: view.hiddenCount })} />
    {:else if kind === 'quiet'}
      <EmptyState icon="check-circle" title={t('insights:empty.quietTitle')} description={t('insights:empty.quiet')} />
    {:else}
      <EmptyState icon="info" title={t('insights:empty.nodataTitle')} description={t('insights:empty.nodata')} />
    {/if}

    {#if view.hiddenCount > 0 && mayDismiss}
      <p class="hidden-line muted">
        {t('insights:cards.hiddenLine', { count: view.hiddenCount })}
        <Button variant="link" size="sm" loading={busy === '*'} onclick={() => void restoreAll()}>{t('insights:cards.showHidden')}</Button>
      </p>
    {/if}

    {#if notes.length > 0}
      <section class="notes" aria-label={t('insights:notes.title')}>
        <h4>{t('insights:notes.title')}</h4>
        <ul>
          {#each notes as note (note.rule)}
            <li>{note.text}</li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }





  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .insight {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-inline-start: 3px solid var(--line-strong);
  }

  .insight.bad {
    border-inline-start-color: var(--bad);
  }

  .insight.warn {
    border-inline-start-color: var(--warn);
  }

  .insight.ok {
    border-inline-start-color: var(--ok);
  }

  .insight.info {
    border-inline-start-color: var(--info);
  }

  .head {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .sev {
    display: inline-flex;
    flex: none;
    margin-top: 2px;
  }

  .sev.bad {
    color: var(--bad-ink);
  }

  .sev.warn {
    color: var(--warn-ink);
  }

  .sev.ok {
    color: var(--ok-ink);
  }

  .sev.info {
    color: var(--info-ink);
  }

  h4 {
    margin: 0;
    font-size: var(--text-md, 1rem);
    font-weight: var(--weight-semibold);
  }

  .why {
    margin: var(--space-1) 0 0;
    color: var(--muted);
  }

  .evidence {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    margin: 0;
    font-size: var(--text-sm);
  }

  .evidence dt {
    color: var(--muted);
  }

  .evidence dd {
    margin: 0;
    font-weight: var(--weight-semibold);
  }

  .actions {
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .grow {
    flex: 1;
  }

  .notes {
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  .notes h4 {
    font-size: var(--text-sm);
  }

  .notes ul {
    padding-inline-start: var(--space-5);
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .hidden-line {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
