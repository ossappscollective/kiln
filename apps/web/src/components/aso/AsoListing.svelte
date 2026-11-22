<!--
  AsoListing: "Keywords in your listing". For every locale of the stored store listing of each app in scope, the terms the
  listing already sets, read from the copy the last sync stored (no store is contacted from here). App Store: the entries
  of the hidden keyword field split on commas (with its byte count) and the significant words of the name and subtitle.
  Google Play has no hidden keyword field, so its terms are EXTRACTED from the title and short description (and, when
  asked, the frequent words of the full description), and the view says so. Each term is a chip that says where it appears
  (keyword field, name, subtitle, short, description), whether the keyword field wastes room on it or repeats it (the same
  logic as the keyword budget, core `listingBudget`), and whether it is already tracked in the locale's storefront, with the rank today.
  A term that is not tracked has a "+" to track it; "Track N untracked" per locale or for all locales first shows what will be
  added (storefront, locale, tag "from listing"), with a checkbox for each term. Adding only stores keywords here; nothing is
  read from a store until "Check now", and nothing is written to a store. "Copy keyword field" copies the stored field.
  Not built: a switch that keeps the tracked list in step with the listing on its own (it would need a stored setting and a
  step in the sync). Props: api, workspaceId, members (the app records in scope), config, keywords (all tracked ones),
  canWrite, onchanged, now.
-->
<script lang="ts">
  import { type ListingRow, listingRows, type Role, supports, type TrackedRank } from '@kiln/core';
  import { untrack } from 'svelte';
  import { address } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { listingLead } from '../../lib/aso/lead.ts';
  import { type AsoConfig, type AsoKeyword, type AsoListingKeywordsResponse, addSummaryText, asoErrorMessage, chunk, sumAddSummary } from '../../lib/aso/aso.ts';
  import {
    PLAY_NO_KEYWORD_FIELD,
    type PlanGroup,
    type TrackPlan,
    buildPlan,
    freshnessText,
    keywordFieldText,
    planGroupId,
    planItemId,
    planKeywordItems,
    rankMark,
    roomText,
    sourceMark,
    sourcesText,
    storeName,
    termKeywordItem,
    termMark,
  } from '../../lib/aso/listing.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { territoryName } from '../../lib/reviews/reviews.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import ListingAi from './ListingAi.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import T from '../ui/T.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    config,
    keywords,
    canWrite,
    onchanged,
    now,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    config: AsoConfig | null;
    keywords: AsoKeyword[];
    canWrite: boolean;
    onchanged: () => Promise<void>;
    now: number;
  } = $props();

  const uid = $props.id();
  const multi = $derived(members.length > 1);
  const androidInScope = $derived(members.some((m) => supports(m.platform, 'searchTermsImport')));

  let data = $state<Record<string, AsoListingKeywordsResponse | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let generation = 0;
  let includeDescription = $state(false);
  /** The storefront a person picked for a locale, by `appId|locale`. */
  let picked = $state<Record<string, string | undefined>>({});

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);

  $effect(() => {
    void key;
    const list = members;
    untrack(() => {
      const mine = ++generation;
      void (async () => {
        const next: Record<string, AsoListingKeywordsResponse | undefined> = {};
        const bad: Record<string, string | undefined> = {};
        await Promise.all(
          list.map(async (m) => {
            try {
              next[m.id] = await api.asoListingKeywords(workspaceId, m.id);
            } catch (e) {
              bad[m.id] = asoErrorMessage(e, t('aso:used.loadFailed'));
            }
          }),
        );
        if (mine !== generation) return;
        data = next;
        errors = bad;
        loading = false;
      })();
    });
  });

  const sections = $derived(
    members.map((app) => {
      const d = data[app.id];
      const tracked: TrackedRank[] = keywords
        .filter((k) => k.appId === app.id)
        .map((k) => ({ id: k.id, term: k.term, country: k.country, locale: k.locale, state: k.state, rank: k.rank }));
      const overrides: Record<string, string | undefined> = {};
      for (const l of d?.locales ?? []) overrides[l.locale] = picked[`${app.id}|${l.locale}`];
      const rows: ListingRow[] = d ? listingRows({ platform: app.platform, locales: d.locales, tracked, options: { includeDescription }, countries: overrides }) : [];
      return { app, d, rows, trackedCount: tracked.length };
    }),
  );
  const everything = $derived(buildPlan(sections.map((s) => ({ appId: s.app.id, platform: s.app.platform, rows: s.rows }))));
  const lead = $derived(
    listingLead({ loaded: !loading, localeRows: sections.reduce((n, s) => n + s.rows.length, 0), untracked: everything.total }),
  );
  const depth = $derived(config?.limits.rankDepth ?? 50);

  // ----- Track what is not tracked
  let plan = $state<TrackPlan | null>(null);
  let skipped = $state<Record<string, true | undefined>>({});
  let busy = $state(false);
  let planError = $state('');
  let planNote = $state('');
  let chipBusy = $state<string | null>(null);

  function openPlan(scope?: { appId: string; locale: string }) {
    plan = buildPlan(sections.map((s) => ({ appId: s.app.id, platform: s.app.platform, rows: s.rows })), scope);
    skipped = {};
    planError = '';
    planNote = '';
  }

  const chosenIn = (g: PlanGroup) => (i: { key: string }): boolean => !skipped[planItemId(g, i.key)];
  const selectedCount = $derived(plan ? plan.groups.reduce((n, g) => n + g.items.filter(chosenIn(g)).length, 0) : 0);
  const selectedFor = (appId: string): number => (plan ? plan.groups.filter((g) => g.appId === appId).reduce((n, g) => n + g.items.filter(chosenIn(g)).length, 0) : 0);
  const planApps = $derived(plan ? members.filter((m) => plan?.groups.some((g) => g.appId === m.id)) : []);

  async function confirmPlan() {
    if (!plan || busy || selectedCount === 0) return;
    busy = true;
    planError = '';
    planNote = '';
    const sums = [];
    try {
      const per = config?.limits.maxKeywordsPerRequest ?? 50;
      for (const g of plan.groups) {
        const items = planKeywordItems(g, chosenIn(g));
        for (const part of chunk(items, per)) sums.push((await api.addAsoKeywords(workspaceId, g.appId, part)).summary);
      }
    } catch (e) {
      planError = asoErrorMessage(e, t('aso:used.addFailed'));
    } finally {
      busy = false;
    }
    if (sums.length > 0) {
      const sum = sumAddSummary(sums);
      const message = addSummaryText(sum, config?.limits.maxKeywordsPerApp);
      if (sum.created > 0) {
        toast.success(message);
        if (planError === '') plan = null;
      } else if (planError === '') {
        planNote = message;
      }
      await onchanged();
    }
  }

  async function addOne(app: AppSummary, row: ListingRow, term: { term: string; key: string }) {
    if (chipBusy !== null) return;
    chipBusy = `${planGroupId(app.id, row.locale, row.country)}|${term.key}`;
    try {
      const out = await api.addAsoKeywords(workspaceId, app.id, [termKeywordItem(row, term)]);
      const message = addSummaryText(out.summary, config?.limits.maxKeywordsPerApp);
      if (out.summary.created > 0) toast.success(t('aso:listing.tracking', { term: term.term, country: row.country.toUpperCase() }));
      else toast.error(message);
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:listing.addFailed')));
    } finally {
      chipBusy = null;
    }
  }

  const storefrontTitle = (country: string): string => territoryName(country);
</script>

<div class="listing stack roomy">
  <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="listing-lead">
    {#snippet aside()}
      <span class="row wrap about">
        <InfoTip label={t('aso:listing.aboutLabel')} buttonText={t('aso:listing.aboutLabel')} align="start" width="30rem">
          <div class="tip stack tight">
            <p>{t('aso:listing.about1')}</p>
            <p>{t('aso:listing.about2')}</p>
            <p><T key="aso:listing.about3" /></p>
          </div>
        </InfoTip>
        {#if androidInScope}
          <label class="check"><input type="checkbox" bind:checked={includeDescription} /> {t('aso:listing.includeDescription')}</label>
        {/if}
      </span>
    {/snippet}
    {#snippet actions()}
      {#if canWrite && everything.total > 0}
        <div class="acts" role="toolbar" aria-label={t('aso:listing.actions')}>
          <Button variant="primary" icon="plus" onclick={() => openPlan()}>{t('aso:listing.trackAll', { count: everything.total })}</Button>
        </div>
      {/if}
    {/snippet}
  </PageLead>

  {#if plan}
    <section class="card plan stack" aria-label={t('aso:listing.planLabel')}>
      <h3>{t('aso:listing.planHeading', { count: selectedCount })}</h3>
      <p class="muted">
        {t('aso:listing.planText')}
      </p>
      {#if plan.groups.length === 0}
        <p>{t('aso:listing.allTracked')}</p>
      {/if}
      {#each plan.groups as g (g.id)}
        <fieldset class="group">
          <legend>{multi ? t('aso:listing.groupLegendPlatform', { platform: platformLabel(g.platform), locale: g.locale, country: g.country.toUpperCase() }) : t('aso:listing.groupLegend', { locale: g.locale, country: g.country.toUpperCase() })}</legend>
          <ul class="plain picks">
            {#each g.items as item (item.key)}
              <li>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={!skipped[planItemId(g, item.key)]}
                    onchange={(e) => (skipped[planItemId(g, item.key)] = e.currentTarget.checked ? undefined : true)}
                  />
                  {item.term}
                  <span class="muted">({sourcesText(g.platform, item.sources)})</span>
                </label>
              </li>
            {/each}
          </ul>
        </fieldset>
      {/each}
      {#each planApps as app (app.id)}
        {@const room = roomText(config?.limits.maxKeywordsPerApp, sections.find((s) => s.app.id === app.id)?.trackedCount ?? 0, selectedFor(app.id))}
        {#if room}<p class="muted hint">{multi ? t('aso:listing.roomPlatform', { platform: platformLabel(app.platform), room }) : room}</p>{/if}
      {/each}
      {#if planError}<Alert tone="error">{planError}</Alert>{/if}
      {#if planNote}<Alert tone="info">{planNote}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={busy} disabled={selectedCount === 0} onclick={confirmPlan}>{t('aso:add.submit', { count: selectedCount })}</Button>
        <Button variant="ghost" onclick={() => (plan = null)}>{t('common:action.cancel')}</Button>
      </div>
    </section>
  {/if}

  {#if loading}
    <div role="status" aria-label={t('aso:listing.loading')} class="stack">
      <Skeleton width="100%" height="36px" />
      <Skeleton width="100%" height="120px" />
    </div>
  {:else}
    {#each sections as s (s.app.id)}
      {@const d = s.d}
      {#snippet refreshLink(text: string)}<a href={appAddress(s.app.id, 'listing', address.platform)}>{text}</a>{/snippet}
      <section class="stack" aria-label={t('aso:listing.sectionLabel', { platform: platformLabel(s.app.platform) })}>
        <div class="row head">
          {#if multi}<h3 class="eyebrow">{platformLabel(s.app.platform)}</h3>{/if}
          <span class="muted fresh">{freshnessText(s.app.platform, d?.readAt ?? null, now)}</span>
          <Button size="sm" variant="link" icon="refresh" href={appAddress(s.app.id, 'listing', address.platform)}>{t('aso:listing.resync')}</Button>
          {#if d?.error}<span class="muted">{t('aso:used.readFailed', { error: d.error })}</span>{/if}
        </div>
        {#if !supports(s.app.platform, 'keywordField')}<p class="muted note">{t(PLAY_NO_KEYWORD_FIELD)}</p>{/if}

        {#if errors[s.app.id]}
          <Alert tone="error">{errors[s.app.id]}</Alert>
        {:else if d && d.locales.length === 0}
          <p class="none"><T key="aso:listing.noText" tags={{ link: refreshLink }} /></p>
        {:else if d}
          <div class="table-wrap">
            <table class="compact">
              <thead>
                <tr>
                  <th scope="col">{t('aso:label.locale')}</th>
                  <th scope="col">{t('aso:listing.terms')}</th>
                  <th scope="col"><span class="visually-hidden">{t('aso:listing.fieldActions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {#each s.rows as row (row.locale)}
                  {@const kf = row.terms.keywordField}
                  <tr>
                    <th scope="row" class="loc">
                      <span class="locale">{row.locale}</span>
                      <span class="muted store">
                        {#if row.storefronts.length > 1}
                          <select
                            class="pick"
                            aria-label={t('aso:used.storefrontFor', { locale: row.locale })}
                            value={row.country}
                            onchange={(e) => (picked[`${s.app.id}|${row.locale}`] = e.currentTarget.value)}
                          >
                            {#each row.storefronts as c (c)}<option value={c}>{c.toUpperCase()}</option>{/each}
                          </select>
                        {:else}
                          <span title={storefrontTitle(row.country)}>{row.country.toUpperCase()}</span>
                        {/if}
                        {t('aso:listing.storefront')}
                      </span>
                    </th>
                    <td>
                      {#if !row.terms.hasText}
                        <span class="muted">{t('aso:listing.noTerms')}</span>
                      {:else}
                        {#if row.terms.extracted}<p class="muted flag">{t('aso:listing.extracted')}</p>{/if}
                        <ul class="chips plain" aria-label={t('aso:listing.termsIn', { locale: row.locale })}>
                          {#each row.rows as item (item.key)}
                            {@const mark = termMark(item)}
                            {@const rank = rankMark(item, depth)}
                            <li class="chip" class:tracked={item.tracked} class:waste={mark?.tone === 'warn'}>
                              <span class="term">{item.term}</span>
                              <span class="src" title={item.occurrences > 0 ? t('aso:listing.inSourcesTimes', { sources: sourcesText(s.app.platform, item.sources), count: item.occurrences }) : t('aso:listing.inSources', { sources: sourcesText(s.app.platform, item.sources) })}>
                                {#each item.sources as src (src)}<span>{sourceMark(src)}</span>{/each}
                              </span>
                              <span class="visually-hidden">{t('aso:listing.inSourcesSr', { sources: sourcesText(s.app.platform, item.sources) })}</span>
                              {#if mark}<span class="mark {mark.tone}" title={mark.title}>{mark.text}</span>{/if}
                              {#if rank}
                                <span class="rank" title={rank.title}>
                                  <Icon name="check" size={12} /><span class="visually-hidden">{t('aso:listing.trackedRank')} </span>{rank.text}
                                </span>
                              {:else if canWrite && row.trackable}
                                <button
                                  type="button"
                                  class="bare add"
                                  aria-label={t('aso:used.trackFor', { term: item.term, locale: row.locale, country: row.country.toUpperCase() })}
                                  title={t('aso:listing.trackTerm', { term: item.term })}
                                  disabled={chipBusy !== null}
                                  onclick={() => addOne(s.app, row, item)}
                                >
                                  <Icon name="plus" size={12} />
                                </button>
                              {/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </td>
                    <td>
                      <div class="side">
                      {#if kf}
                        <span class="muted kf" class:over={kf.over} title={keywordFieldText(kf)}>{t('aso:used.sizeBytes', { used: kf.bytes, limit: kf.limit })}</span>
                        {#if kf.value !== ''}<CopyButton value={kf.value} label={t('aso:listing.copyField')} />{/if}
                      {/if}
                      {#if canWrite && row.untracked.length > 0 && row.trackable}
                        <Button size="sm" onclick={() => openPlan({ appId: s.app.id, locale: row.locale })}>{t('aso:used.trackUntracked', { count: row.untracked.length })}</Button>
                      {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="muted legend">
            {supports(s.app.platform, 'keywordField') ? t('aso:listing.legendApple') : t('aso:listing.legendPlay')}
            {t('aso:listing.legendChips')}
          </p>
          <ListingAi {api} {workspaceId} {role} app={s.app} locales={s.rows.map((r) => r.locale)} />
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  .roomy {
    font-size: 0.9375rem;
  }

  .roomy :global(table.compact th),
  .roomy :global(table.compact td) {
    padding-block: var(--space-3);
    font-size: 0.9375rem;
  }

  .roomy :global(table.compact thead th) {
    font-size: var(--text-sm);
  }

  .about {
    gap: var(--space-2) var(--space-4);
    align-items: center;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .fresh,
  .note {
    margin: 0;
    font-size: 0.9375rem;
  }

  .legend {
    margin: 0;
    font-size: var(--text-sm);
  }

  .none {
    margin: var(--space-2) 0;
  }

  .tip p {
    margin: 0;
  }

  .plan h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .plan p {
    margin: 0;
  }

  .group {
    padding: 0;
    margin: 0;
    border: 0;
  }

  .group legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
  }

  .loc {
    min-width: 8rem;
    text-align: left;
    vertical-align: top;
  }

  .locale {
    display: block;
    font-weight: var(--weight-medium);
  }

  .store {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
  }

  .pick {
    height: var(--control-sm);
  }

  .flag {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }

  .chip {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding: var(--space-1) var(--space-3);
    font-size: 0.9375rem;
    background: var(--surface);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-full);
  }

  .chip.tracked {
    background: var(--surface-sunken);
    border-style: solid;
    border-color: var(--line);
  }

  .chip.waste {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .src {
    display: inline-flex;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .mark {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .mark.warn {
    color: var(--warn-ink);
  }

  .mark.info {
    color: var(--info-ink);
  }

  .rank {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ok-ink);
    font-variant-numeric: tabular-nums;
  }

  .add {
    display: inline-flex;
    padding: 2px;
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-full);
  }

  .add:hover:not(:disabled) {
    color: var(--accent);
  }

  .add:focus-visible {
    outline: var(--ring);
  }

  .side {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-end;
    white-space: nowrap;
  }

  .kf {
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .kf.over {
    color: var(--bad-ink);
  }
</style>
