<!--
  RatingsHealth: the Ratings and health tab of Insights (`?view=ratings`, docs/adr/0052-ratings-health.md). The hierarchy is the one of every page
  (docs/ux-ia.md 0e): the header holds scope and Sync (this page syncs reviews and analytics); here, the range bar and the updated line, then
  [the section rail | the content]. Sections (`?section=`): Ratings, Reviews signal, Stability, Release impact, Countries. A section with nothing to
  say for the data at hand is not listed; the rail is drawn only with two or more.
  With both platforms the Ratings section opens with ONE comparison table (a row per measure, a column per platform); a platform with no data is a
  single line saying why and how to fix it. Nothing is added across platforms, and no store history is invented: the stores keep none for Apple,
  so the trend starts the day Kiln first read it, and a small count is shown as a count with a "low sample" hint, never as a share.
  Reads stored data only (GET ratings, GET health); a sync refreshes it. Props: api, workspaceId, role, members (records in scope), now, refreshKey
  (changes when a sync ended), openId and platform (the address of the open app, for links).
-->
<script lang="ts">
  import { dateToDay, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { type RangeChoice, formatDay, parseRange, resolveRange, withRange } from '../../lib/analytics/analytics.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { formatNumber, formatPercent } from '../../lib/i18n/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { countryText } from '../../lib/insights/insights.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type HealthPart,
    type HealthView,
    type PlatformSnapshot,
    type RatingsView,
    availableParts,
    comparisonRows,
    countryRows,
    fetchDays,
    formatRate,
    LOW_SAMPLE,
    panelOf,
    partCount,
    ratingChips,
    ratingsOverview,
    releaseRows,
    reviewChips,
    reviewSignal,
    stability,
    stabilityChips,
    withHealthSection,
  } from '../../lib/ratings/ratings.ts';
  import type { ChartPanel } from '../../lib/analytics/view.ts';
  import { railWorthDrawing } from '../../lib/analytics/sections.ts';
  import { type RailGroup, resolveRailSection } from '../../lib/section-rail.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import UpdatedLine from '../app/UpdatedLine.svelte';
  import RangeControl from '../analytics/RangeControl.svelte';
  import StatRow from '../analytics/StatRow.svelte';
  import VizScope from '../analytics/VizScope.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import SectionRail from '../ui/SectionRail.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import HealthChart from './HealthChart.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    now,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number; refreshKey?: number | undefined } = $props();

  const choice = $derived(parseRange(address.hash));
  const range = $derived(resolveRange(choice, now));
  const setRange = (next: RangeChoice) => replaceHash(withRange(location.hash, next));
  const today = $derived(dateToDay(now));

  type Read = { ratings: RatingsView | null; health: HealthView | null; ratingsFailed: boolean; healthFailed: boolean; loaded: boolean; message: string };
  let reads = $state<Record<string, Read | undefined>>({});
  let generation = 0;

  async function load() {
    const mine = ++generation;
    const days = fetchDays(range.days, range.from, today);
    const next: Record<string, Read> = {};
    await Promise.all(
      members.map(async (app) => {
        const read: Read = { ratings: null, health: null, ratingsFailed: false, healthFailed: false, loaded: true, message: '' };
        await Promise.all([
          api.appRatings(workspaceId, app.id, days).then(
            (v) => void (read.ratings = v),
            (e) => {
              read.ratingsFailed = true;
              read.message = e instanceof ApiError ? e.message : '';
            },
          ),
          api.appHealth(workspaceId, app.id, days).then(
            (v) => void (read.health = v),
            () => void (read.healthFailed = true),
          ),
        ]);
        next[app.id] = read;
      }),
    );
    if (mine === generation) reads = next;
  }
  const readKey = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}/${range.from}/${range.to}/${refreshKey}`);
  $effect(() => {
    void readKey;
    untrack(() => void load());
  });

  const loading = $derived(members.some((m) => !reads[m.id]));
  const snaps = $derived(
    members.map((app): PlatformSnapshot => {
      const read = reads[app.id];
      return {
        platform: app.platform,
        appId: app.id,
        ratings: ratingsOverview(read?.ratings ?? null, range.days, range.to),
        reviews: reviewSignal(read?.ratings ?? null, range.days, range.to),
        stability: stability(read?.health ?? null, range.days, range.to),
        releases: releaseRows(read?.health ?? null, read?.ratings ?? null),
        countries: countryRows(read?.ratings ?? null),
      };
    }),
  );
  const several = $derived(snaps.length > 1);
  const readOf = (appId: string) => reads[appId];

  const parts = $derived(availableParts(snaps));
  const groups = $derived<RailGroup[]>([
    {
      id: 'health',
      label: t('ratings:rail.group'),
      entries: parts.map((id) => ({ id, label: t(RAIL[id]), count: partCount(id, snaps) })),
    },
  ]);
  const railShown = $derived(railWorthDrawing(groups));
  const part = $derived(resolveRailSection(address.hash, parts) as HealthPart);

  const RAIL: Record<HealthPart, string> = {
    ratings: k('ratings:rail.ratings'),
    reviews: k('ratings:rail.reviews'),
    stability: k('ratings:rail.stability'),
    releases: k('ratings:rail.releases'),
    countries: k('ratings:rail.countries'),
  };
  const rows = $derived(comparisonRows(snaps, range.days));
  const reviewsLink = (appId: string, platform: string) => `${appAddress(appId, 'reviews', platform as never)}${'?rating=1%2C2'}`;
  const sourcesLink = (appId: string, platform: string) => `${appAddress(appId, 'insights', platform as never)}${'?section=sources'}`;
  const barWidth = (n: number, max: number) => (max > 0 ? Math.round((n / max) * 100) : 0);
</script>

<VizScope>
  <div class="health stack loose" data-testid="ratings-health">
    <div class="filters">
      <RangeControl {choice} {range} {now} onchange={setRange} />
      <span class="spacer"></span>
      <UpdatedLine {api} {workspaceId} {role} apps={members} kinds={['reviews', 'analytics']} {refreshKey} />
    </div>

    {#if railShown}
      <SectionRail {groups} value={part} hrefFor={(id) => withHealthSection(address.hash, id)} label={t('ratings:rail.label')}>
        {@render content()}
      </SectionRail>
    {:else}
      {@render content()}
    {/if}
  </div>
</VizScope>

{#snippet platformHead(s: PlatformSnapshot)}
  {#if several}<h3 class="platform"><PlatformBadge platform={s.platform} tinted /> <span class="visually-hidden">{platformLabel(s.platform as never)}</span></h3>{/if}
{/snippet}

{#snippet emptyLine(s: PlatformSnapshot, key: string, params: Record<string, string | number> = {})}
  <p class="empty-line" data-testid="no-data-{s.platform}">
    <PlatformBadge platform={s.platform} tinted />
    <span>{t(key, { platform: platformLabel(s.platform as never), ...params })}</span>
  </p>
{/snippet}

{#snippet content()}
  {#if loading}
    <Skeleton width="100%" height="160px" />
  {:else if part === 'reviews'}
    {@render reviewsPart()}
  {:else if part === 'stability'}
    {@render stabilityPart()}
  {:else if part === 'releases'}
    {@render releasesPart()}
  {:else if part === 'countries'}
    {@render countriesPart()}
  {:else}
    {@render ratingsPart()}
  {/if}
{/snippet}

{#snippet ratingsPart()}
  <div class="stack loose" data-testid="part-ratings">
    {#if several && snaps.some((s) => s.ratings.state !== 'none')}
      <div class="card flush">
        <div class="table-wrap">
          <table class="compact" data-testid="compare">
            <caption class="visually-hidden">{t('ratings:compare.caption', { count: range.days })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ratings:compare.measure')}</th>
                {#each snaps as s (s.appId)}<th scope="col"><PlatformBadge platform={s.platform} tinted /></th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each rows as row (row.id)}
                <tr>
                  <th scope="row">{row.label}</th>
                  {#each row.cells as c (c.platform)}
                    <td>{c.text}{#if c.hint}<span class="hint">{c.hint}</span>{/if}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
    {#each snaps as s (s.appId)}
      {@const r = s.ratings}
      {@const read = readOf(s.appId)}
      {#if r.state === 'none'}
        {#if read?.ratingsFailed}
          {@render emptyLine(s, k('ratings:empty.error'))}
        {:else}
          {@render emptyLine(s, s.platform === 'ios' ? k('ratings:empty.ios') : k('ratings:empty.android'))}
        {/if}
      {:else}
        <div class="stack" data-testid="ratings-{s.platform}">
          {@render platformHead(s)}
          <StatRow chips={ratingChips(s, range.days)} days={range.days} />
          {#if r.state === 'series' && panelOf(`rating-${s.appId}`, 'rating', t('ratings:chart.average'), r.points)}
            <HealthChart panel={panelOf(`rating-${s.appId}`, 'rating', t('ratings:chart.average'), r.points) as ChartPanel} title={t('ratings:chart.average')} today={range.to} />
          {:else}
            <p class="quiet" data-testid="one-reading">{t('ratings:since.oneReading')}</p>
          {/if}
          <ul class="notes quiet">
            {#if r.since}<li>{t(s.platform === 'ios' ? k('ratings:since.ios') : k('ratings:since.android'), { date: formatDay(r.since, true) })}</li>{/if}
            {#if !r.countKnown}<li>{t('ratings:note.noCount')}</li>{/if}
            {#if r.countDropped}<li>{t('ratings:note.countDropped')}</li>{/if}
            {#if r.reset}<li>{t('ratings:note.reset')}</li>{/if}
            {#if r.spansGap}<li>{t('ratings:note.gap')}</li>{/if}
            {#if r.state === 'series' && !r.newKnown}<li>{t('ratings:note.newUnknown')}</li>{/if}
          </ul>
          {#if r.newStars && r.newStars.some((n) => n > 0)}
            {@const total = r.newStars.reduce((a, b) => a + b, 0)}
            {@const max = Math.max(...r.newStars)}
            <section class="card" aria-labelledby="stars-{s.appId}">
              <h4 id="stars-{s.appId}">{t('ratings:stars.title', { count: total })}</h4>
              <ul class="bars">
                {#each [5, 4, 3, 2, 1] as star (star)}
                  {@const n = r.newStars[star - 1] ?? 0}
                  <li>
                    <span class="name">{t('ratings:stars.label', { count: star })}</span>
                    <span class="track" aria-hidden="true"><span class="fill" style:width="{barWidth(n, max)}%"></span></span>
                    <span class="value num">{formatNumber(n)}{#if total >= LOW_SAMPLE} · {formatPercent(n / total, { maximumFractionDigits: 0 })}{/if}</span>
                  </li>
                {/each}
              </ul>
              {#if total < LOW_SAMPLE}<p class="quiet">{t('ratings:count.lowSample')}</p>{/if}
            </section>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet reviewsPart()}
  <div class="stack loose" data-testid="part-reviews">
    <p class="quiet">{t('ratings:reviews.lead', { max: 2 })}</p>
    <div class="cols cols-{snaps.length}">
      {#each snaps as s (s.appId)}
        {@const v = s.reviews}
        <div class="stack">
          {@render platformHead(s)}
          {#if v.count === 0 && v.previous === null}
            {@render emptyLine(s, k('ratings:reviews.empty'))}
          {:else}
            <StatRow chips={reviewChips(s, range.days)} days={range.days} />
            {@const panel = panelOf(`low-${s.appId}`, 'count', t('ratings:chart.lowReviews'), v.points)}
            {#if panel && v.points.length > 1}<HealthChart {panel} title={t('ratings:chart.lowReviews')} today={range.to} />{/if}
            <p class="quiet">
              <Button href={reviewsLink(s.appId, s.platform)} variant="link" size="sm">{t('ratings:reviews.open')}</Button>
            </p>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet stabilityPart()}
  <div class="stack loose" data-testid="part-stability">
    <div class="cols cols-{snaps.length}">
      {#each snaps as s (s.appId)}
        {@const st = s.stability}
        {@const f = st.finding}
        <div class="stack" data-testid="stability-{s.platform}">
          {@render platformHead(s)}
          {#if st.state === 'setup'}
            <p class="empty-line">
              <span>{t('ratings:stability.setup', { platform: platformLabel(s.platform as never) })}</span>
              <a href={sourcesLink(s.appId, s.platform)}>{t('ratings:stability.openSources')}</a>
            </p>
          {:else if st.state === 'error'}
            <p class="empty-line">
              <span>{t('ratings:stability.error', { platform: platformLabel(s.platform as never) })}</span>
              <a href={sourcesLink(s.appId, s.platform)}>{t('ratings:stability.openSources')}</a>
            </p>
          {:else if st.state === 'none'}
            {@render emptyLine(s, s.platform === 'ios' ? k('ratings:stability.noneIos') : k('ratings:stability.noneAndroid'))}
          {:else}
            {#if f}
              <Alert tone={f.kind === 'worse' ? 'warn' : 'ok'} title={t(f.kind === 'worse' ? k('ratings:finding.worse') : k('ratings:finding.better'), { measure: t(f.measure === 'crash' ? k('ratings:tile.crash') : k('ratings:tile.freeze')), version: f.version })}>
                {t('ratings:finding.detail', { previous: f.previous, before: formatRate(f.before), after: formatRate(f.after), from: formatDay(f.from) })}
                {#if f.mentions > 0}{t('ratings:finding.mentions', { count: f.mentions })}{/if}
              </Alert>
            {/if}
            <StatRow chips={stabilityChips(s, range.days)} days={range.days} />
            {@const crash = panelOf(`crash-${s.appId}`, 'ratio', t('ratings:tile.crash'), st.crash.points)}
            {#if crash}<HealthChart panel={crash} title={t('ratings:tile.crash')} today={range.to} />{/if}
            {#if st.freeze}
              {@const freeze = panelOf(`freeze-${s.appId}`, 'ratio', t('ratings:tile.freeze'), st.freeze.points)}
              {#if freeze}<HealthChart panel={freeze} title={t('ratings:tile.freeze')} today={range.to} />{/if}
            {/if}
            <ul class="notes quiet">
              <li>{t(s.platform === 'ios' ? k('ratings:stability.noteIos') : k('ratings:stability.noteAndroid'))}</li>
              {#if st.crash.coverage < 1}<li>{t('ratings:stability.coverage', { days: st.crash.daysWithData, count: range.days })}</li>{/if}
            </ul>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet releasesPart()}
  <div class="stack loose" data-testid="part-releases">
    <p class="quiet">{t('ratings:releases.lead')}</p>
    <p class="quiet" data-testid="releases-legend">{t('ratings:releases.legend')}</p>
    {#each snaps as s (s.appId)}
      {#if s.releases.length > 0}
        <div class="stack">
          {@render platformHead(s)}
          <div class="card flush">
            <div class="table-wrap">
              <table class="compact fit">
                <caption class="visually-hidden">{t('ratings:releases.caption', { platform: platformLabel(s.platform as never) })}</caption>
                <colgroup><col style="width: 22%" /><col style="width: 16%" /><col style="width: 25%" /><col style="width: 21%" /><col style="width: 16%" /></colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t('ratings:releases.version')}</th>
                    <th scope="col">{t('ratings:releases.day')}</th>
                    <th scope="col" class="num">{t('ratings:releases.crash')}</th>
                    <th scope="col" class="num">{t('ratings:releases.rating')}</th>
                    <th scope="col" class="num">{t('ratings:releases.reviews')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each s.releases as r (r.version)}
                    <tr>
                      <th scope="row"><span class="ver">{r.name ?? r.version}</span>{#if r.name}<span class="hint">{r.version}</span>{/if}</th>
                      <td data-label={t('ratings:releases.day')}>{formatDay(r.day, true)}</td>
                      <td class="num" data-label={t('ratings:releases.crash')}>
                        {#if r.crashChange}
                          {formatRate(r.crashChange.before)} → {formatRate(r.crashChange.after)}
                          <span class="hint {r.crashChange.kind === 'worse' ? 'bad' : 'ok'}">{t(r.crashChange.kind === 'worse' ? k('ratings:releases.worse') : k('ratings:releases.better'))}</span>
                        {:else}<span class="muted">{t('ratings:compare.none')}</span>{/if}
                      </td>
                      <td class="num" data-label={t('ratings:releases.rating')}>
                        {#if r.ratingState === 'ok' && r.ratingBefore !== null && r.ratingAfter !== null}
                          {r.ratingBefore.toFixed(2)} → {r.ratingAfter.toFixed(2)}
                        {:else}
                          <span class="muted" title={t(r.ratingState === 'too_early' ? k('ratings:releases.tooEarlyTitle') : k('ratings:releases.noHistoryTitle'))}>{t(r.ratingState === 'too_early' ? k('ratings:releases.tooEarly') : k('ratings:releases.noHistory'))}</span>
                        {/if}
                      </td>
                      <td class="num" data-label={t('ratings:releases.reviews')}>{formatNumber(r.reviews)}{#if r.crashReviews > 0}<span class="hint">{t('ratings:releases.crashReviews', { count: r.crashReviews })}</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet countriesPart()}
  <div class="stack loose" data-testid="part-countries">
    {#each snaps as s (s.appId)}
      {@const list = countryRows(readOf(s.appId)?.ratings ?? null)}
      {#if list.length > 0}
        <div class="stack">
          {@render platformHead(s)}
          <div class="card flush">
            <div class="table-wrap">
              <table class="compact fit">
                <caption class="visually-hidden">{t('ratings:countries.caption', { platform: platformLabel(s.platform as never) })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('ratings:countries.country')}</th>
                    <th scope="col" class="num">{t('ratings:tile.average')}</th>
                    <th scope="col" class="num">{t('ratings:tile.count')}</th>
                    <th scope="col" class="num">{t('ratings:tile.new')}</th>
                    <th scope="col">{t('ratings:countries.read')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each list as c (c.territory)}
                    <tr>
                      <th scope="row">{countryText(c.territory)}</th>
                      <td class="num" data-label={t('ratings:tile.average')}>{c.average.toFixed(2)}</td>
                      <td class="num" data-label={t('ratings:tile.count')}>{c.count === null ? t('ratings:compare.none') : formatNumber(c.count)}{#if c.lowSample}<span class="hint">{t('ratings:count.lowSample')}</span>{/if}</td>
                      <td class="num" data-label={t('ratings:tile.new')}>{formatNumber(c.newCount)}</td>
                      <td data-label={t('ratings:countries.read')}>{formatDay(c.day)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
          <p class="quiet">{t('ratings:countries.note')}</p>
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
  }

  .spacer {
    flex: 1 1 0;
  }

  h3.platform {
    margin: 0;
    font-size: var(--text-md);
  }

  h4 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .empty-line,
  .quiet {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }

  .empty-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .notes {
    padding-left: var(--space-4);
    margin: 0;
  }

  .notes:empty {
    display: none;
  }

  .notes li + li {
    margin-top: var(--space-1);
  }

  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }

  @media (min-width: 1100px) {
    .cols-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .hint {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--muted);
  }

  .ver {
    overflow-wrap: anywhere;
  }

  .hint.bad {
    color: var(--bad-ink);
  }

  .hint.ok {
    color: var(--ok-ink);
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .bars li {
    display: grid;
    grid-template-columns: 5rem minmax(0, 1fr) 7rem;
    gap: var(--space-3);
    align-items: center;
    font-size: var(--text-sm);
  }

  .track {
    display: block;
    height: 8px;
  }

  .fill {
    display: block;
    height: 8px;
    background: var(--viz-1);
    border-radius: 0 4px 4px 0;
  }

  .value {
    text-align: right;
  }

  @media (forced-colors: active) {
    .fill {
      background: CanvasText;
    }
  }
</style>
