<!--
  AiInsightView: the body of an AI REPORT (docs/ai-features.md): a review summary, review tags, "what to fix next", a listing audit or an
  ASO health report. A report is read, not applied: the only thing a person can do with it is mark it as reviewed (the card does that).
  Numbers that can be counted (reviews per theme, shares of stars, versions, lengths, coverage, ranks) were counted by the server from stored
  data; the model only wrote the words around them, and a reference to a review it did not see was dropped. Evidence links open the review in
  the list. Everything a model wrote is shown as plain text, never as markup.
  Props: proposal (the insight), appId (for the evidence links), platform? (the platform of the app, so a link opens the right tab).
-->
<script lang="ts">
  import type { AiFlag, AiInsightProposal, Platform } from '@kiln/core';
  import { flagInfos } from '../../lib/ai/ai.ts';
  import {
    auditFieldText,
    basedOnText,
    healthAreaLabel,
    healthBasis,
    impactLabel,
    impactTone,
    levelLabel,
    periodText,
    rankText,
    reportNotes,
    reviewsText,
    sentimentShares,
    severityTone,
    tagLine,
    themeKindLabel,
    themeKindTone,
    topicLabel,
  } from '../../lib/ai/insights.ts';
  import { formatList, formatNumber, formatPercent } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { appReviewHref } from '../../lib/reviews/split.ts';
  import Badge from '../ui/Badge.svelte';

  let { proposal, appId, platform = null }: { proposal: AiInsightProposal; appId: string; platform?: Platform | null | undefined } = $props();

  const notes = $derived(reportNotes(proposal));
  const shares = $derived(proposal.insight === 'review_summary' ? sentimentShares(proposal.sentiment) : null);
  const evidence = (ids: readonly string[]): string[] => ids.slice(0, 5);
  const pct = (n: number): string => formatPercent(n / 100, { maximumFractionDigits: 0 });
  const stars = (n: number): string => formatNumber(n, { maximumFractionDigits: 1 });
  const trendWord = (diff: number): string => (diff >= 0.1 ? t('ai:insight.trendUp') : diff <= -0.1 ? t('ai:insight.trendDown') : t('ai:insight.trendFlat'));
  /** The line above a tag report: what was tagged, what was cached, what is left (a whole sentence per case). */
  function classifyLine(p: { classified: number; cached: number; remaining: number }): string {
    const values = { classified: p.classified, cached: p.cached, remaining: p.remaining };
    if (p.cached > 0 && p.remaining > 0) return t('ai:insight.classify.moreCached', values);
    if (p.cached > 0) return t('ai:insight.classify.doneCached', values);
    if (p.remaining > 0) return t('ai:insight.classify.more', values);
    return t('ai:insight.classify.done', values);
  }
</script>

{#snippet flagBadges(flags: readonly AiFlag[])}
  {#each flagInfos(flags) as f (f.flag)}<Badge tone={f.tone}>{f.text}</Badge>{/each}
{/snippet}

{#snippet evidenceLinks(ids: readonly string[])}
  {#if ids.length > 0}
    <p class="evidence muted">
      {t('ai:insight.evidence')}
      {#each evidence(ids) as id, n (id)}
        <a href={appReviewHref(appId, id, platform)}>{t('ai:insight.evidenceReview', { n: n + 1 })}</a>{n < evidence(ids).length - 1 ? ', ' : ''}
      {/each}
      {#if ids.length > 5}<span>{t('ai:insight.evidenceMore', { count: ids.length - 5 })}</span>{/if}
    </p>
  {/if}
{/snippet}

<div class="insight">
  {#if proposal.insight === 'review_summary'}
    <p class="basis muted">{t('ai:insight.summaryBasis', { basedOn: basedOnText(proposal.analysed, proposal.reviewCount), period: periodText(proposal.period) })}</p>
    {#if proposal.overview}<p class="overview">{proposal.overview}</p>{/if}
    {#if proposal.changes}<p class="changes"><strong>{t('ai:insight.changesSince')}</strong> {proposal.changes}</p>{/if}
    {#if proposal.trend && proposal.trend.earlier !== null && proposal.trend.recent !== null}
      <p class="muted trend" data-testid="trend">{t('ai:insight.trend', { earlier: stars(proposal.trend.earlier), recent: stars(proposal.trend.recent), direction: trendWord(proposal.trend.recent - proposal.trend.earlier) })}</p>
    {/if}
    {#if shares}
      <p class="shares">
        <Badge tone="ok">{t('ai:insight.shares.high', { percent: pct(shares.positive) })}</Badge>
        <Badge>{t('ai:insight.shares.mid', { percent: pct(shares.neutral) })}</Badge>
        <Badge tone="bad">{t('ai:insight.shares.low', { percent: pct(shares.negative) })}</Badge>
      </p>
    {/if}
    {#if proposal.themes.length === 0}
      <p class="muted">{t('ai:insight.noThemes')}</p>
    {:else}
      <ul class="list">
        {#each proposal.themes as theme, n (n)}
          <li class="entry">
            <p class="line">
              <strong>{theme.label}</strong>
              <Badge tone={themeKindTone(theme.kind)}>{themeKindLabel(theme.kind)}</Badge>
              {#if theme.share !== undefined}<span class="muted" title={t('ai:insight.shareTitle')}>{t('ai:insight.themeShare', { percent: pct(theme.share * 100) })}</span>{/if}
              <span class="muted">{theme.averageRating !== null ? t('ai:insight.themeWithRating', { reviews: reviewsText(theme.count), rating: stars(theme.averageRating) }) : reviewsText(theme.count)}</span>
            </p>
            {#if theme.summary}<p class="text">{theme.summary}</p>{/if}
            {@render evidenceLinks(theme.reviewIds)}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if proposal.insight === 'review_classify'}
    <p class="basis muted">
      {classifyLine(proposal)}
      {t('ai:insight.classify.advisory')}
    </p>
    {#if proposal.items.length > 0}
      <ul class="list">
        {#each proposal.items.slice(0, 12) as tagged (tagged.reviewId)}
          <li class="entry compactline">
            <a href={appReviewHref(appId, tagged.reviewId, platform)}>{t('ai:insight.openReview')}</a>
            <span>{tagLine(tagged)}</span>
            {#if tagged.needsReply}<Badge tone="warn">{t('ai:insight.needsReply')}</Badge>{/if}
          </li>
        {/each}
      </ul>
      {#if proposal.items.length > 12}<p class="muted">{t('ai:insight.allTagsInList', { count: proposal.items.length })}</p>{/if}
    {/if}
  {:else if proposal.insight === 'fix_next'}
    <p class="basis muted">{t('ai:insight.fixNextBasis', { basedOn: basedOnText(proposal.analysed, proposal.reviewCount), period: periodText(proposal.period) })}</p>
    {#if proposal.items.length === 0}
      <p class="muted">{t('ai:insight.nothingStoodOut')}</p>
    {:else}
      <ol class="list">
        {#each proposal.items as item, n (n)}
          <li class="entry">
            <p class="line">
              <strong>{item.title}</strong>
              {#if item.severity !== 'none'}<Badge tone={severityTone(item.severity)}>{levelLabel(item.severity)}</Badge>{/if}
              {#if item.area}<Badge>{topicLabel(item.area)}</Badge>{/if}
              <span class="muted">{reviewsText(item.count)}</span>
            </p>
            {#if item.why}<p class="text">{item.why}</p>{/if}
            {#if item.versions.length > 0}
              <p class="muted small">{t('ai:insight.writtenFor', { versions: formatList(item.versions.map((v) => `${v.version} (${v.count})`), { type: 'unit' }) })}</p>
            {/if}
            {@render evidenceLinks(item.reviewIds)}
          </li>
        {/each}
      </ol>
    {/if}
    {#if proposal.versionStats.length > 0}
      <details class="more">
        <summary>{t('ai:insight.complaintsByVersion')}</summary>
        <ul class="plain">
          {#each proposal.versionStats as v (v.version)}
            <li>{t('ai:insight.versionStat', { version: v.version, complaints: reviewsText(v.complaints), reviews: reviewsText(v.reviews), rating: stars(v.averageRating) })}</li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if proposal.releaseNotes}
      <div class="notes">
        <p class="line">
          <strong>{t('ai:insight.releaseNotesTitle')}</strong>
          <span class="muted small">{t('ai:insight.releaseNotesLength', { length: formatNumber(proposal.releaseNotesLength), count: proposal.releaseNotesLimit })}</span>
          {@render flagBadges(proposal.releaseNotesFlags)}
        </p>
        <p class="text">{proposal.releaseNotes}</p>
        <p class="muted small">{t('ai:insight.releaseNotesNote')}</p>
      </div>
    {/if}
  {:else if proposal.insight === 'listing_audit'}
    <p class="basis muted">{t('ai:insight.auditBasis', { locale: proposal.locale, store: proposal.store === 'app_store' ? 'App Store' : 'Google Play' })}</p>
    <ul class="plain facts">
      {#each proposal.fields as f (f.field)}<li><strong>{f.label}</strong>: {auditFieldText(f)}</li>{/each}
    </ul>
    {#if proposal.coverage.length > 0}
      <details class="more">
        <summary>{t('ai:insight.coverageTitle')}</summary>
        <ul class="plain">
          {#each proposal.coverage as c, n (n)}
            <li>{c.inFields.length > 0 ? t('ai:insight.coverageIn', { term: c.term, rank: rankText(c.rank), fields: formatList(c.inFields, { type: 'unit' }) }) : t('ai:insight.coverageNone', { term: c.term, rank: rankText(c.rank) })}</li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if proposal.findings.length === 0}
      <p class="muted">{t('ai:insight.noFinding')}</p>
    {:else}
      <ol class="list">
        {#each proposal.findings as f, n (n)}
          <li class="entry">
            <p class="line">
              <strong>{f.problem}</strong>
              <Badge tone={impactTone(f.impact)}>{impactLabel(f.impact)}</Badge>
              {#if f.field}<Badge>{f.field}</Badge>{/if}
              {@render flagBadges(f.flags)}
            </p>
            <p class="text">{f.recommendation}</p>
            {#if f.reasoning}<p class="muted small">{f.reasoning}</p>{/if}
            {#if f.keywords.length > 0}<p class="muted small">{t('ai:insight.findingKeywords', { keywords: formatList(f.keywords, { type: 'unit' }) })}</p>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  {:else if proposal.insight === 'aso_health'}
    <p class="basis muted">{healthBasis(proposal.basedOn)}</p>
    {#if proposal.summary}<p class="overview">{proposal.summary}</p>{/if}
    {#if proposal.actions.length === 0}
      <p class="muted">{t('ai:insight.noAction')}</p>
    {:else}
      <ol class="list">
        {#each proposal.actions as a (a.position)}
          <li class="entry">
            <p class="line">
              <strong>{a.title}</strong>
              <Badge>{healthAreaLabel(a.area)}</Badge>
              {@render flagBadges(a.flags)}
            </p>
            {#if a.detail}<p class="text">{a.detail}</p>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}

  {#each notes as note (note)}<p class="muted small">{note}</p>{/each}
</div>

<style>
  .insight {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  p {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .small {
    font-size: var(--text-xs);
  }

  .overview {
    font-weight: var(--weight-medium);
    white-space: pre-wrap;
  }

  .shares {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style-position: inside;
  }

  ul.list {
    list-style: none;
  }

  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .compactline {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  /* What a model wrote: plain, wrapped, line breaks kept. Data, never markup. */
  .text {
    white-space: pre-wrap;
  }

  .notes .text {
    padding: var(--space-2) var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .plain {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-left: var(--space-4);
    margin: 0;
  }

  .facts {
    list-style: none;
    padding-left: 0;
  }

  .more summary {
    cursor: pointer;
    color: var(--muted);
  }

  .evidence {
    font-size: var(--text-sm);
  }
</style>
