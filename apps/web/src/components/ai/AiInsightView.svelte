<!--
  AiInsightView: the body of an AI REPORT (docs/ai-features.md): a review summary, review tags, "what to fix next", a listing audit or an
  ASO health report. A report is read, not applied: the only thing a person can do with it is mark it as reviewed (the card does that).
  Numbers that can be counted (reviews per theme, shares of stars, versions, lengths, coverage, ranks) were counted by the server from stored
  data; the model only wrote the words around them, and a reference to a review it did not see was dropped. Evidence links open the review in
  the list. Everything a model wrote is shown as plain text, never as markup.
  Props: proposal (the insight), appId (for the evidence links), platform? (the platform of the app, so a link opens the right tab).
-->
<script lang="ts">
  import type { AiFlag, AiInsightProposal, Platform } from '@mrm/core';
  import { flagInfos } from '../../lib/ai/ai.ts';
  import {
    auditFieldText,
    basedOnText,
    healthAreaLabel,
    healthBasis,
    impactTone,
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
  import { appReviewHref } from '../../lib/reviews/split.ts';
  import Badge from '../ui/Badge.svelte';

  let { proposal, appId, platform = null }: { proposal: AiInsightProposal; appId: string; platform?: Platform | null | undefined } = $props();

  const notes = $derived(reportNotes(proposal));
  const shares = $derived(proposal.insight === 'review_summary' ? sentimentShares(proposal.sentiment) : null);
  const evidence = (ids: readonly string[]): string[] => ids.slice(0, 5);
</script>

{#snippet flagBadges(flags: readonly AiFlag[])}
  {#each flagInfos(flags) as f (f.flag)}<Badge tone={f.tone}>{f.text}</Badge>{/each}
{/snippet}

{#snippet evidenceLinks(ids: readonly string[])}
  {#if ids.length > 0}
    <p class="evidence muted">
      Evidence:
      {#each evidence(ids) as id, n (id)}
        <a href={appReviewHref(appId, id, platform)}>review {n + 1}</a>{n < evidence(ids).length - 1 ? ', ' : ''}
      {/each}
      {#if ids.length > 5}<span>and {ids.length - 5} more</span>{/if}
    </p>
  {/if}
{/snippet}

<div class="insight">
  {#if proposal.insight === 'review_summary'}
    <p class="basis muted">{basedOnText(proposal.analysed, proposal.reviewCount)} {periodText(proposal.period)}. The shares come from the star ratings.</p>
    {#if proposal.overview}<p class="overview">{proposal.overview}</p>{/if}
    {#if shares}
      <p class="shares">
        <Badge tone="ok">{shares.positive}% 4 to 5 stars</Badge>
        <Badge>{shares.neutral}% 3 stars</Badge>
        <Badge tone="bad">{shares.negative}% 1 to 2 stars</Badge>
      </p>
    {/if}
    {#if proposal.themes.length === 0}
      <p class="muted">No theme came out of these reviews.</p>
    {:else}
      <ul class="list">
        {#each proposal.themes as t, n (n)}
          <li class="entry">
            <p class="line">
              <strong>{t.label}</strong>
              <Badge tone={themeKindTone(t.kind)}>{themeKindLabel(t.kind)}</Badge>
              <span class="muted">{reviewsText(t.count)}{t.averageRating !== null ? ` · ${t.averageRating} stars on average` : ''}</span>
            </p>
            {#if t.summary}<p class="text">{t.summary}</p>{/if}
            {@render evidenceLinks(t.reviewIds)}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if proposal.insight === 'review_classify'}
    <p class="basis muted">
      {proposal.classified} tagged now{proposal.cached > 0 ? `, ${proposal.cached} already had tags (nothing was sent for those)` : ''}{proposal.remaining > 0
        ? `, ${proposal.remaining} still to tag. Run it again to continue.`
        : '.'}
      The tags are advisory: they change nothing about the reviews.
    </p>
    {#if proposal.items.length > 0}
      <ul class="list">
        {#each proposal.items.slice(0, 12) as t (t.reviewId)}
          <li class="entry compactline">
            <a href={appReviewHref(appId, t.reviewId, platform)}>Open review</a>
            <span>{tagLine(t)}</span>
            {#if t.needsReply}<Badge tone="warn">Needs a reply</Badge>{/if}
          </li>
        {/each}
      </ul>
      {#if proposal.items.length > 12}<p class="muted">The tags of all {proposal.items.length} reviews show in the list.</p>{/if}
    {/if}
  {:else if proposal.insight === 'fix_next'}
    <p class="basis muted">{basedOnText(proposal.analysed, proposal.reviewCount)} Only reviews of 3 stars or fewer are looked at. {periodText(proposal.period)}.</p>
    {#if proposal.items.length === 0}
      <p class="muted">Nothing stood out.</p>
    {:else}
      <ol class="list">
        {#each proposal.items as item, n (n)}
          <li class="entry">
            <p class="line">
              <strong>{item.title}</strong>
              {#if item.severity !== 'none'}<Badge tone={severityTone(item.severity)}>{item.severity}</Badge>{/if}
              {#if item.area}<Badge>{topicLabel(item.area)}</Badge>{/if}
              <span class="muted">{reviewsText(item.count)}</span>
            </p>
            {#if item.why}<p class="text">{item.why}</p>{/if}
            {#if item.versions.length > 0}
              <p class="muted small">Written for version {item.versions.map((v) => `${v.version} (${v.count})`).join(', ')}.</p>
            {/if}
            {@render evidenceLinks(item.reviewIds)}
          </li>
        {/each}
      </ol>
    {/if}
    {#if proposal.versionStats.length > 0}
      <details class="more">
        <summary>Complaints by version</summary>
        <ul class="plain">
          {#each proposal.versionStats as v (v.version)}
            <li>{v.version}: {reviewsText(v.complaints)} of {reviewsText(v.reviews)}, {v.averageRating} stars on average</li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if proposal.releaseNotes}
      <div class="notes">
        <p class="line">
          <strong>Draft for "What is new"</strong>
          <span class="muted small">{proposal.releaseNotesLength} of {proposal.releaseNotesLimit} characters</span>
          {@render flagBadges(proposal.releaseNotesFlags)}
        </p>
        <p class="text">{proposal.releaseNotes}</p>
        <p class="muted small">A draft to copy and edit. It is not staged and nothing is sent to a store.</p>
      </div>
    {/if}
  {:else if proposal.insight === 'listing_audit'}
    <p class="basis muted">{proposal.locale} · {proposal.store === 'app_store' ? 'App Store' : 'Google Play'}. Lengths and ranks are counted here; the findings are the assistant's opinion.</p>
    <ul class="plain facts">
      {#each proposal.fields as f (f.field)}<li><strong>{f.label}</strong>: {auditFieldText(f)}</li>{/each}
    </ul>
    {#if proposal.coverage.length > 0}
      <details class="more">
        <summary>Where your tracked keywords appear</summary>
        <ul class="plain">
          {#each proposal.coverage as c, n (n)}
            <li>{c.term}: {rankText(c.rank)}{c.inFields.length > 0 ? `, in ${c.inFields.join(', ')}` : ', not in any field'}</li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if proposal.findings.length === 0}
      <p class="muted">No finding.</p>
    {:else}
      <ol class="list">
        {#each proposal.findings as f, n (n)}
          <li class="entry">
            <p class="line">
              <strong>{f.problem}</strong>
              <Badge tone={impactTone(f.impact)}>{f.impact} impact</Badge>
              {#if f.field}<Badge>{f.field}</Badge>{/if}
              {@render flagBadges(f.flags)}
            </p>
            <p class="text">{f.recommendation}</p>
            {#if f.reasoning}<p class="muted small">{f.reasoning}</p>{/if}
            {#if f.keywords.length > 0}<p class="muted small">Keywords: {f.keywords.join(', ')}</p>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  {:else if proposal.insight === 'aso_health'}
    <p class="basis muted">{healthBasis(proposal.basedOn)}</p>
    {#if proposal.summary}<p class="overview">{proposal.summary}</p>{/if}
    {#if proposal.actions.length === 0}
      <p class="muted">No action to suggest.</p>
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
