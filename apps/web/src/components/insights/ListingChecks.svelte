<!--
  ListingChecks: the checks of the live store page of one app record, in the text view of Store listing (docs/api/insights.md, listing-checks).
  A score for the page and for each language, the findings with a severity (problem, warning, tip), why each matters, and where the check
  can rewrite the text safely (the keyword field without its wasted space) the suggested text with a copy button. Nothing is sent to a
  store: to use a suggestion, paste it into the field editor and stage it. Weakest languages first; languages with no finding are one line.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished). Drawn only for a role that may read the listing.
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import {
    CHECK_ICON,
    CHECK_TONE,
    checkSeverityLabel,
    countBySeverity,
    fieldName,
    issueText,
    type ListingChecksView,
    localesByScore,
    SCORE_TONE,
    scoreBand,
    sortIssues,
  } from '../../lib/insights/insights.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Section from '../ui/Section.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const mayRead = $derived(can(role, 'listing.read'));
  let view = $state<ListingChecksView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await api.appListingChecks(workspaceId, app.id);
      if (mine !== generation) return;
      view = read;
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : t('insights:checks.loadError');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    if (mayRead) untrack(() => void load());
  });

  const locales = $derived(view ? localesByScore(view.locales) : []);
  const withIssues = $derived(locales.filter((l) => l.issues.length > 0));
  const clean = $derived(locales.filter((l) => l.issues.length === 0));
  const totals = $derived(view ? countBySeverity(view.locales) : { problem: 0, warning: 0, tip: 0 });
  const sectionSummary = $derived(view && view.score !== null ? t('insights:checks.summary', { score: view.score, count: view.issueCount }) : '');
  const listingHref = (locale: string) => `${appAddress(app.id, 'listing')}?locale=${encodeURIComponent(locale)}`;
</script>

{#if mayRead}
  <Section title={t('insights:checks.title')} key="listing-checks-{app.id}" summary={sectionSummary} defaultOpen={false}>
    <div class="stack loose" data-testid="listing-checks">
      {#if loading}
        <Skeleton height="5rem" />
      {:else if problem}
        <Alert tone="error" title={t('insights:checks.loadErrorTitle')}>{problem}</Alert>
      {:else if view?.unavailable === 'no_listing'}
        <EmptyState icon="file-text" title={t('insights:checks.noListingTitle')} description={t('insights:checks.noListing')} />
      {:else if view && view.score !== null}
        <div class="score-row">
          <Badge tone={SCORE_TONE[scoreBand(view.score)]}><span class="num">{t('insights:checks.score', { score: view.score })}</span></Badge>
          <span class="muted">
            {#if view.issueCount === 0}{t('insights:checks.allGood')}{:else}{t('insights:checks.counts', { problems: totals.problem, warnings: totals.warning, tips: totals.tip })}{/if}
          </span>
        </div>

        {#each withIssues as loc, i (loc.locale)}
          <Disclosure variant="boxed" open={i === 0} stateKey="listing-checks-{app.id}-{loc.locale}">
            {#snippet summary()}
              <span class="loc">{loc.locale}</span>
              <Badge tone={SCORE_TONE[scoreBand(loc.score)]}><span class="num">{t('insights:checks.score', { score: loc.score })}</span></Badge>
              <span class="muted">{t('insights:checks.findings', { count: loc.issues.length })}</span>
            {/snippet}
            <ul class="issues">
              {#each sortIssues(loc.issues) as issue (issue.id)}
                {@const text = issueText(issue)}
                <li class="issue" data-severity={issue.severity}>
                  <div class="top">
                    <Badge tone={CHECK_TONE[issue.severity]} icon={CHECK_ICON[issue.severity]}>{checkSeverityLabel(issue.severity)}</Badge>
                    <strong>{text.title}</strong>
                  </div>
                  <p class="muted">{text.explain}</p>
                  {#if issue.fix}
                    <div class="fix">
                      <p class="fix-label">{t('insights:checks.suggested', { field: fieldName(issue.fix.field) })}</p>
                      <pre class="fix-text" lang={loc.locale}>{issue.fix.value}</pre>
                      <div class="row">
                        <CopyButton value={issue.fix.value} label={t('insights:checks.copy')} copiedLabel={t('insights:checks.copied')} variant="secondary" />
                        <span class="muted hint">{t('insights:checks.pasteHint')}</span>
                      </div>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
            <div class="row"><Button href={listingHref(loc.locale)} variant="ghost" size="sm">{t('insights:checks.openLocale', { locale: loc.locale })}</Button></div>
          </Disclosure>
        {/each}

        {#if clean.length > 0}
          <p class="muted clean">{t('insights:checks.clean', { count: clean.length, locales: formatList(clean.map((l) => l.locale)) })}</p>
        {/if}
      {/if}
    </div>
  </Section>
{/if}

<style>
  .score-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .loc {
    font-weight: var(--weight-semibold);
  }

  .issues {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: 0;
    margin: 0 0 var(--space-3);
    list-style: none;
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .issue p {
    margin: var(--space-1) 0 0;
  }

  .fix {
    margin-top: var(--space-2);
  }

  .fix-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .fix-text {
    padding: var(--space-3);
    margin: var(--space-1) 0 var(--space-2);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .hint {
    font-size: var(--text-sm);
  }

  .clean {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
