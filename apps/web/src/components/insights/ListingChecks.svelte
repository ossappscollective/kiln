<!--
  ListingChecks: the checks of the live store page of one app record, in the text view of Store listing (docs/api/insights.md, listing-checks).
  A score for the page and for each language, the findings with a severity (problem, warning, tip), why each matters, and where the check
  can rewrite the text safely (the keyword field without its wasted space) the suggested text with a copy button. Nothing is sent to a
  store: to use a suggestion, paste it into the field editor and stage it. Weakest languages first; languages with no finding are one line.
  Mechanical problems have a "Fix" button (and "Fix all that can be fixed (N)" per language and for the app): it opens a review and STAGES the fix in the
  pending changes; nothing is published without the cart's review. After a fix is staged the finding says "Fix staged" and the counts say "after pending
  changes" (the server runs the checks on the staged texts). Props: api, workspaceId, role, app, refreshKey (changes when a sync finished), locked? (the version is
  live or in review: fixes are off). Drawn only for a role that may read the listing.
-->
<script lang="ts">
  import { can, type Fix, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { reportShown } from '../../lib/app-state/dev-assert.ts';
  import { listingStore } from '../../lib/app-state/listing-store.svelte.ts';
  import { fixAllOf, type ListingFixesView } from '../../lib/listing/fixes.ts';
  import FixAll from '../listing/FixAll.svelte';
  import FixButtons from '../listing/FixButtons.svelte';
  import ReviewInfoCheck from '../listing/ReviewInfoCheck.svelte';
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

  let { api, workspaceId, role, app, refreshKey, locked = false }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number; locked?: boolean | undefined } = $props();

  const mayRead = $derived(can(role, 'listing.read'));
  // The checks and the fixes are ONE answer of the listing store (the store read the Listing grid uses): the same locales, the same base locale.
  const read = $derived(listingStore.checks(workspaceId, app.id));
  const view = $derived<ListingChecksView | null>(read.checks);
  const fixes = $derived<ListingFixesView | null>(read.fixes);
  const loading = $derived(mayRead && read.checks === null && read.error === null);
  const problem = $derived(read.checks === null && read.error !== null ? t('insights:checks.loadError') : '');

  async function load() {
    await listingStore.loadChecks(api, workspaceId, app.id, { fresh: true });
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    if (mayRead) untrack(() => void listingStore.loadChecks(api, workspaceId, app.id));
  });

  // Dev monitor: the locales and the base language this card (and the fix bar) draw are the ones every other listing surface shows.
  $effect(() => {
    if (view !== null) {
      reportShown(`localeList:${app.id}`, view.locales.map((l) => l.locale).sort(), 'insightsChecks');
      reportShown(`defaultLocale:${app.id}`, view.baseLocale ?? null, 'insightsChecks');
    }
    if (fixes !== null) reportShown(`localeList:${app.id}`, fixes.locales.map((l) => l.locale).sort(), 'fixBar');
  });

  const fixesOf = (locale: string) => fixes?.locales.find((l) => l.locale === locale);
  const resolved = $derived(new Set(fixes?.afterPending?.resolved ?? []));
  const allFixes = $derived((fixes?.locales ?? []).reduce<Fix[]>((all, l) => all.concat(fixAllOf(l)), []));
  const locales = $derived(view ? localesByScore(view.locales) : []);
  const withIssues = $derived(locales.filter((l) => l.issues.length > 0));
  const clean = $derived(locales.filter((l) => l.issues.length === 0));
  const totals = $derived(view ? countBySeverity(view.locales) : { problem: 0, warning: 0, tip: 0 });
  const sectionSummary = $derived(view && view.score !== null ? t('insights:checks.summary', { score: view.score, count: view.issueCount }) : '');
  const listingHref = (locale: string) => `${appAddress(app.id, 'listing')}?locale=${encodeURIComponent(locale)}&panel=${encodeURIComponent(locale)}`;
</script>

{#if mayRead}
  <!-- The App Review Information is a check of its own, early: the submit refuses a blank contact or demo account. -->
  <ReviewInfoCheck {api} {workspaceId} {role} {app} />
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
          <FixAll {api} {workspaceId} {role} appId={app.id} fixes={allFixes} {locked} onchanged={load} />
        </div>
        {#if fixes?.afterPending}
          <p class="muted pending" data-testid="after-pending">
            {t('listing:fix.afterPending', { problems: fixes.afterPending.counts.problems, warnings: fixes.afterPending.counts.warnings, tips: fixes.afterPending.counts.tips, score: fixes.afterPending.score })}
          </p>
        {/if}

        {#each withIssues as loc, i (loc.locale)}
          <Disclosure variant="boxed" open={i === 0} stateKey="listing-checks-{app.id}-{loc.locale}">
            {#snippet summary()}
              <span class="loc">{loc.locale}</span>
              <Badge tone={SCORE_TONE[scoreBand(loc.score)]}><span class="num">{t('insights:checks.score', { score: loc.score })}</span></Badge>
              <span class="muted">{t('insights:checks.findings', { count: loc.issues.length })}</span>
            {/snippet}
            <div class="row"><FixAll {api} {workspaceId} {role} appId={app.id} fixes={fixAllOf(fixesOf(loc.locale))} {locked} onchanged={load} /></div>
            <ul class="issues">
              {#each sortIssues(loc.issues) as issue (issue.id)}
                {@const text = issueText(issue)}
                <li class="issue" data-severity={issue.severity}>
                  <div class="top">
                    <Badge tone={CHECK_TONE[issue.severity]} icon={CHECK_ICON[issue.severity]}>{checkSeverityLabel(issue.severity)}</Badge>
                    <strong>{text.title}</strong>
                  </div>
                  <p class="muted">{text.explain}</p>
                  <FixButtons {api} {workspaceId} {role} {app} locale={fixesOf(loc.locale)} {issue} resolved={resolved.has(issue.id)} {locked} onchanged={load} />
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

  .pending {
    margin: 0;
    font-size: var(--text-sm);
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
