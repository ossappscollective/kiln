<!--
  CompetitorReviews: the public App Store reviews of the competitors an app follows (Insights, ASO, competitors), beside this app's own
  reviews. Read from Apple's customer-reviews feed on demand (a button per competitor, at most once per 15 minutes) and kept 90 days; the
  author of a review is never stored. Google Play has no official way to read the reviews of another app and Kiln does not scrape it, so a
  Play competitor is listed as not available. Review text is shown as plain text. Nothing here is sent to an AI model.
  Props: api, workspaceId, role, app (the app record).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { asoErrorMessage } from '../../lib/aso/aso.ts';
  import type { Api } from '../../lib/api.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { formatNumber } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, CompetitorReviewStats, CompetitorReviewsView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';

  let { api, workspaceId, role, app }: { api: Api; workspaceId: string; role: Role; app: AppSummary } = $props();

  let days = $state(28);
  let view = $state<CompetitorReviewsView | null>(null);
  let problem = $state('');
  let busy = $state('');
  let generation = 0;

  const mayRead = $derived(can(role, 'aso.write'));
  const avg = (n: number | null): string => (n === null ? t('reviews:competitors.none') : formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const trendText = (x: { earlier: number | null; recent: number | null }): string =>
    x.earlier === null || x.recent === null ? t('reviews:competitors.none') : `${avg(x.earlier)} → ${avg(x.recent)}`;

  async function load() {
    const mine = (generation += 1);
    try {
      const out = await api.asoCompetitorReviews(workspaceId, app.id, days);
      if (mine === generation) {
        view = out;
        problem = '';
      }
    } catch (e) {
      if (mine === generation) problem = asoErrorMessage(e);
    }
  }

  $effect(() => {
    void days;
    untrack(() => void load());
  });

  async function read(c: CompetitorReviewStats) {
    busy = c.competitorId;
    try {
      const out = await api.refreshAsoCompetitorReviews(workspaceId, app.id, c.competitorId);
      toast.info(out.state === 'recent' ? t('reviews:competitors.recent') : t('reviews:competitors.readDone', { count: out.stored }));
      await load();
    } catch (e) {
      toast.error(asoErrorMessage(e));
    } finally {
      busy = '';
    }
  }
</script>

<div class="stack" data-testid="competitor-reviews">
  <p class="muted small">{t('reviews:competitors.lead', { days: view?.retentionDays ?? 90 })}</p>
  <p class="muted small" data-testid="play-note">{t('reviews:competitors.playNote')}</p>
  <label class="period">
    <span class="visually-hidden">{t('reviews:competitors.periodLabel')}</span>
    <select bind:value={days} aria-label={t('reviews:competitors.periodLabel')}>
      <option value={28}>{t('reviews:ai.lastDays', { n: 28 })}</option>
      <option value={90}>{t('reviews:ai.lastDays', { n: 90 })}</option>
    </select>
  </label>
  {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  {#if view && view.competitors.length === 0}
    <p class="muted">{t('reviews:competitors.noneFollowed')}</p>
  {:else if view}
    <div class="card flush">
      <div class="table-wrap">
        <table class="compact fit">
          <caption class="visually-hidden">{t('reviews:competitors.caption')}</caption>
          <colgroup><col style="width: 30%" /><col style="width: 14%" /><col style="width: 14%" /><col style="width: 24%" /><col style="width: 18%" /></colgroup>
          <thead>
            <tr>
              <th scope="col">{t('reviews:competitors.app')}</th>
              <th scope="col" class="num">{t('reviews:competitors.count')}</th>
              <th scope="col" class="num">{t('reviews:competitors.average')}</th>
              <th scope="col" class="num">{t('reviews:competitors.trend')}</th>
              <th scope="col" class="num"><span class="visually-hidden">{t('reviews:competitors.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#if view.own}
              <tr data-testid="own-row">
                <th scope="row">{t('reviews:competitors.thisApp')}</th>
                <td class="num" data-label={t('reviews:competitors.count')}>{formatNumber(view.own.count)}</td>
                <td class="num" data-label={t('reviews:competitors.average')}>{avg(view.own.average)}</td>
                <td class="num" data-label={t('reviews:competitors.trend')}>{trendText(view.own.trend)}</td>
                <td></td>
              </tr>
            {/if}
            {#each view.competitors as c (c.competitorId)}
              <tr>
                <th scope="row">{c.name}<span class="hint">{c.country.toUpperCase()}{#if c.checkedAt !== null} · {t('reviews:competitors.readAt', { time: timeAgo(c.checkedAt, Date.now()) })}{/if}</span></th>
                {#if c.state === 'ok'}
                  <td class="num" data-label={t('reviews:competitors.count')}>{formatNumber(c.count)}</td>
                  <td class="num" data-label={t('reviews:competitors.average')}>{avg(c.average)}</td>
                  <td class="num" data-label={t('reviews:competitors.trend')}>{trendText(c.trend)}</td>
                  <td class="num">
                    {#if mayRead}
                      <Button size="sm" variant="ghost" loading={busy === c.competitorId} disabled={busy !== ''} onclick={() => void read(c)}>{t('reviews:competitors.read')}</Button>
                    {/if}
                  </td>
                {:else}
                  <td class="muted" colspan="4">{t('reviews:competitors.unavailable')}</td>
                {/if}
              </tr>
              {#if c.state === 'ok' && c.latest.length > 0}
                <tr class="latest">
                  <td colspan="5">
                    <ul class="plain">
                      {#each c.latest as r (r.id)}
                        <li><strong>{r.rating}★</strong> {#if r.title}{r.title}: {/if}{r.text}{#if r.version} <span class="muted">({r.version})</span>{/if}</li>
                      {/each}
                    </ul>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<style>
  .small {
    font-size: var(--text-xs);
  }

  .period select {
    width: auto;
  }

  .hint {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--muted);
  }

  .latest td {
    padding-top: 0;
  }

  .plain {
    padding: 0;
    margin: 0;
    font-size: var(--text-sm);
    list-style: none;
    overflow-wrap: anywhere;
  }

  .plain li + li {
    margin-top: var(--space-1);
  }
</style>
