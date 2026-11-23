<!--
  ReportsSection: the Reports section of Insights, Timeline (`?view=timeline&section=reports`, docs/adr/0053-timeline-and-reports.md): the summary of one
  calendar week, month or year of an app (GET .../reports, docs/api/reports.md), each figure against the period before, the notable events of the
  period and the honest notes about the data (a period still running, missing days, sources a store does not give). It is a page to read and to take
  away: "Print" uses the print stylesheet (the app chrome carries `no-print`), "Copy as Markdown" and "Download CSV" are built here from what the
  API answered. There is no link to share and nothing is sent anywhere. The view model is lib/timeline/report.ts.
  Props: api, workspaceId, role, members (records in scope, one block each), now, refreshKey, trailing (snippet drawn at the end of the bar: the updated line).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { type Snippet, untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { formatDay } from '../../lib/analytics/analytics.ts';
  import { formatNumber, formatPercent } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type ReportApi,
    dataNotes,
    figureRow,
    periodNav,
    periodTitle,
    reportCsv,
    reportDayOf,
    reportFileName,
    reportIsEmpty,
    reportKindKeys,
    reportKindOf,
    reportKinds,
    reportMarkdown,
    reviewsRow,
    changeText,
    withReport,
  } from '../../lib/timeline/report.ts';
  import { eventHref, eventText, kindIcons, kindLabelKeys } from '../../lib/timeline/timeline.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import FilterChip from '../ui/FilterChip.svelte';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    members,
    refreshKey = 0,
    trailing,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number; refreshKey?: number | undefined; trailing?: Snippet | undefined } = $props();

  const kind = $derived(reportKindOf(address.hash));
  const on = $derived(reportDayOf(address.hash));
  const go = (next: { kind: typeof kind; on: string | null }) => replaceHash(withReport(location.hash, next));

  type Read = { app: AppSummary; view: ReportApi | null; message: string };
  let reads = $state<Read[] | null>(null);
  let generation = 0;
  async function load() {
    const mine = ++generation;
    const next = await Promise.all(
      members.map(async (app): Promise<Read> => {
        try {
          return { app, view: await api.appReport(workspaceId, app.id, kind, on ?? undefined), message: '' };
        } catch (e) {
          return { app, view: null, message: e instanceof ApiError ? e.message : '' };
        }
      }),
    );
    if (mine === generation) reads = next;
  }
  const readKey = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}/${kind}/${on ?? ''}/${refreshKey}`);
  $effect(() => {
    void readKey;
    untrack(() => void load());
  });

  const views = $derived((reads ?? []).flatMap((r) => (r.view ? [r.view] : [])));
  const failed = $derived((reads ?? []).filter((r) => !r.view));
  const first = $derived(views[0] ?? null);
  const nav = $derived(first ? periodNav(kind, first.comparison, first.through) : null);
  const title = $derived(first ? periodTitle(kind, first.comparison.period) : '');
  const several = $derived(members.length > 1);

  const markdown = $derived(reportMarkdown(views, platformLabel));
  function download() {
    const blob = new Blob([reportCsv(views)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reportFileName(views);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="reports stack loose" data-testid="reports">
  <div class="filters no-print">
    <div class="chips" role="group" aria-label={t('timeline:report.kindLabel')}>
      {#each reportKinds as r (r)}
        <FilterChip label={t(reportKindKeys[r])} pressed={kind === r} onclick={() => go({ kind: r, on: null })} />
      {/each}
    </div>
    <div class="period" role="group" aria-label={t('timeline:report.periodLabel')}>
      <Button variant="ghost" size="sm" icon="chevron-left" iconOnly label={t('timeline:report.prev')} disabled={!nav} onclick={() => nav && go({ kind, on: nav.prev })} />
      <span class="title" aria-live="polite">{title}</span>
      <Button variant="ghost" size="sm" icon="chevron-right" iconOnly label={t('timeline:report.next')} disabled={!nav || nav.next === null} onclick={() => nav?.next && go({ kind, on: nav.next })} />
    </div>
    <span class="spacer"></span>
    {@render trailing?.()}
  </div>

  {#if reads === null}
    <div class="stack" role="status" aria-label={t('timeline:report.loading')}>
      <Skeleton width="40%" height="22px" />
      <Skeleton width="100%" height="180px" />
    </div>
  {:else}
    {#each failed as f (f.app.id)}
      <Alert tone="error" title={t('timeline:report.failed', { platform: platformLabel(f.app.platform) })}>{f.message}</Alert>
    {/each}
    {#if views.length > 0}
      <div class="actions no-print">
        <CopyButton value={markdown} label={t('timeline:report.copyMarkdown')} copiedLabel={t('timeline:report.copied')} variant="secondary" />
        <Button variant="secondary" size="sm" icon="download" onclick={download}>{t('timeline:report.downloadCsv')}</Button>
        <Button variant="secondary" size="sm" onclick={() => window.print()}>{t('timeline:report.print')}</Button>
        <span class="quiet">{t('timeline:report.localOnly')}</span>
      </div>
      <article class="report stack loose" aria-label={t('timeline:report.title', { period: title })}>
        <header>
          <h3>{t('timeline:report.title', { period: title })}</h3>
        </header>
        {#each views as v (v.app.id)}
          {@const rows = v.figures.map(figureRow)}
          {@const rev = reviewsRow(v.reviews)}
          {@const notes = dataNotes(v)}
          <section class="block stack" aria-labelledby="rep-{v.app.id}" data-testid="report-{v.app.platform}">
            <h4 id="rep-{v.app.id}">
              <PlatformBadge platform={v.app.platform} tinted />
              <span>{v.app.name}</span>
              {#if several}<span class="visually-hidden">{platformLabel(v.app.platform)}</span>{/if}
            </h4>
            {#if v.comparison.currentDays > 0}
              <p class="quiet">{t('timeline:report.compare', { current: periodTitle(v.kind, v.comparison.current), previous: periodTitle(v.kind, v.comparison.previous) })}</p>
            {/if}
            {#if reportIsEmpty(v)}
              <p class="empty" data-testid="report-empty">{t('timeline:report.empty')}</p>
            {/if}
            {#if rows.length > 0}
              <div class="table-wrap">
                <table class="compact" data-testid="figures">
                  <caption class="visually-hidden">{t('timeline:report.figuresCaption', { period: title })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('timeline:report.col.figure')}</th>
                      <th scope="col" class="num">{t('timeline:report.col.value')}</th>
                      <th scope="col" class="num">{t('timeline:report.col.previous')}</th>
                      <th scope="col" class="num">{t('timeline:report.col.change')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each rows as r (r.id)}
                      <tr>
                        <th scope="row">{r.label}</th>
                        <td class="num">{r.value}</td>
                        <td class="num">{r.previous}</td>
                        <td class="num change">
                          {#if r.change}
                            {#if r.direction === 'up'}<Icon name="arrow-up" size="sm" />{:else if r.direction === 'down'}<Icon name="arrow-down" size="sm" />{/if}
                            <span>{r.change}</span>
                          {:else}
                            <span class="quiet">{r.note}</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            {#if rev}
              <div class="sub">
                <h5>{t('timeline:report.reviews.title')}</h5>
                <p>
                  {t('timeline:report.reviews.line', { count: rev.count, average: rev.average ?? t('timeline:report.noValue'), previous: rev.previousAverage ?? t('timeline:report.noValue') })}
                  {#if rev.delta}<span class="quiet">({rev.delta})</span>{/if}
                  {#if rev.lowUnanswered > 0}<span class="quiet"> {t('timeline:report.reviews.unanswered', { count: rev.lowUnanswered })}</span>{/if}
                </p>
              </div>
            {/if}
            {#if v.countries.length > 0}
              <div class="sub">
                <h5>{t('timeline:report.countries.title')}</h5>
                <ul class="plain">
                  {#each v.countries as c (c.code)}
                    <li>
                      <strong>{c.code}</strong>
                      <span class="num">{formatNumber(c.value)}</span>
                      {#if c.share !== null}<span class="quiet">{formatPercent(c.share, { maximumFractionDigits: 0 })}</span>{/if}
                      {#if c.change !== null}<span class="quiet">{changeText(c.change)}</span>{/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if v.sources.length > 0}
              <div class="sub">
                <h5>{t('timeline:report.sources.title')}</h5>
                <ul class="plain">
                  {#each v.sources as s (s.source)}
                    <li><strong>{s.source}</strong> <span class="num">{formatNumber(s.downloads)}</span></li>
                  {/each}
                </ul>
              </div>
            {/if}
            <div class="sub">
              <h5>{t('timeline:report.events.title')}</h5>
              {#if v.events.length === 0}
                <p class="quiet" data-testid="no-period-events">{t('timeline:report.events.none')}</p>
              {:else}
                <ul class="plain events">
                  {#each v.events.slice(0, 20) as e (e.id)}
                    {@const href = eventHref({ ...e, appId: v.app.id, platform: v.app.platform })}
                    <li>
                      <span class="when tabular">{formatDay(e.day, true)}</span>
                      <Icon name={kindIcons[e.kind]} size="sm" />
                      <span class="kind">{t(kindLabelKeys[e.kind])}</span>
                      <span>{#if href}<a {href}>{eventText(e)}</a>{:else}{eventText(e)}{/if}</span>
                    </li>
                  {/each}
                </ul>
                {#if v.events.length > 20}<p class="quiet">{t('timeline:report.events.more', { count: v.events.length - 20 })}</p>{/if}
              {/if}
            </div>
            {#if notes.length > 0}
              <div class="sub notes">
                <h5>{t('timeline:report.notes.title')}</h5>
                <ul>
                  {#each notes as n (n.id)}<li>{n.text}</li>{/each}
                </ul>
              </div>
            {/if}
          </section>
        {/each}
      </article>
    {/if}
  {/if}
</div>

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }

  .chips,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .period {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .period .title {
    min-width: 11ch;
    font-weight: var(--weight-semibold);
    text-align: center;
  }

  .report {
    padding: var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .report h3 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .block h4 {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-md);
  }

  .sub h5 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .sub p,
  .sub ul {
    margin: 0;
  }

  .plain {
    padding: 0;
    list-style: none;
  }

  .plain li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
  }

  .events .when,
  .events .kind {
    color: var(--muted);
  }

  .notes ul {
    padding-left: var(--space-5);
    color: var(--muted);
  }

  .change {
    white-space: nowrap;
  }

  .empty {
    margin: 0;
    color: var(--muted);
  }

  @media print {
    .report {
      padding: 0;
      border: 0;
    }

    .block {
      break-inside: avoid;
    }
  }
</style>
