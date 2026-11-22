<!--
  AsoFit: how well the stored live listing covers the tracked keywords, per locale: which of the searched fields have each keyword
  (name, subtitle, keyword field, description; on Android title, short and full description), the weak or missing high priority
  ones first, and the keyword budget of the locale (AsoBudget: used and limit of each field, with the waste, the repeats
  and the storefront hint in a popover). It reads the listing text the server stored (sync the app to refresh it), with
  any staged text on top; it never reads a store. Which fields each store
  searches is unverified; the tip says so. A suggestion, not advice. Editing happens in the Listing tab.
  Props: api, workspaceId, members, keywords, version.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { coachHref, countriesForLocale, keywordsForLocale, overlayStaged } from '../../lib/aso/budget.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import {
    type AsoFitResponse,
    type AsoKeyword,
    asoErrorMessage,
    asoViewHref,
    fieldCell,
    fitColumns,
    fitFieldLabels,
    fitStatusInfo,
    localesOf,
    priorityLabel,
  } from '../../lib/aso/aso.ts';
  import { headerParams, withHeaderParams } from '../../lib/app-header.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { fitLead } from '../../lib/aso/lead.ts';
  import { agoText } from '../../lib/aso/ago.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { summaryLine } from '../../lib/section-state.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatChip from '../ui/StatChip.svelte';
  import T from '../ui/T.svelte';
  import AsoBudget from './AsoBudget.svelte';

  let {
    api,
    workspaceId,
    members,
    keywords,
    version,
    now,
  }: { api: Api; workspaceId: string; members: AppSummary[]; keywords: AsoKeyword[]; version: number; now: number } = $props();

  const uid = $props.id();
  const allLocales = $derived(localesOf(keywords));

  /** The locale view of one app: the chosen locale, else the most used one, else the first the listing has. */
  const pickOf = (d: AsoFitResponse | undefined) => (d ? (d.locales.filter((l) => l.locale === (locale || allLocales[0]))[0] ?? d.locales[0]) : undefined);
  const lead = $derived(
    fitLead(
      members.flatMap((m) => {
        const f = pickOf(data[m.id])?.fit;
        return f ? [{ keywords: f.keywords.length, missing: f.counts.missing, partial: f.counts.partial + f.counts.description_only }] : [];
      }),
    ),
  );
  const leadMissing = $derived(lead.tone === 'warn');
  /** The locale of the page header (?locale=) when this view has keywords for it, else '' (the most used). */
  const locale = $derived.by(() => {
    const wanted = headerParams(address.hash).locale;
    return wanted !== null && allLocales.includes(wanted) ? wanted : '';
  });
  const setLocale = (value: string) => replaceHash(withHeaderParams(location.hash, { locale: value === '' ? null : value }));
  let data = $state<Record<string, AsoFitResponse | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let generation = 0;

  $effect(() => {
    void version;
    const list = members;
    const mine = ++generation;
    void (async () => {
      const next: Record<string, AsoFitResponse | undefined> = {};
      const bad: Record<string, string | undefined> = {};
      await Promise.all(
        list.map(async (m) => {
          void stagedStore.load(api, workspaceId, m.id);
          try {
            next[m.id] = await api.asoFit(workspaceId, m.id);
          } catch (e) {
            bad[m.id] = asoErrorMessage(e, t('aso:fit.loadFailed'));
          }
        }),
      );
      if (mine !== generation) return;
      data = next;
      errors = bad;
      loading = false;
    })();
  });
</script>

<div class="fit stack roomy">
  {#if !loading && members.some((m) => pickOf(data[m.id])?.fit)}
    <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="fit-lead">
      {#snippet actions()}
        {#if leadMissing && members[0]}
          <Button variant="primary" icon="file-text" href={appAddress(members[0].id, 'listing', address.platform)}>{t('aso:fit.editListing')}</Button>
        {/if}
      {/snippet}
    </PageLead>
  {/if}
  {#if allLocales.length > 1}
    <div class="row">
      <label for="{uid}-locale" class="muted">{t('aso:label.locale')}</label>
      <select id="{uid}-locale" value={locale} onchange={(e) => setLocale(e.currentTarget.value)}>
        <option value="">{t('aso:label.mostUsed', { locale: allLocales[0] })}</option>
        {#each allLocales as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </div>
  {/if}

  {#if loading}
    <Skeleton width="100%" height="140px" />
  {:else}
    {#each members as app (app.id)}
      {@const d = data[app.id]}
      {@const pick = d ? (d.locales.filter((l) => l.locale === (locale || allLocales[0]))[0] ?? d.locales[0]) : undefined}
      {@const fit = pick?.fit ?? null}
      {#snippet kwLink(text: string)}<a href={asoViewHref(app.id, 'keywords', address.platform)}>{text}</a>{/snippet}
      <Section title={platformLabel(app.platform)} key="platform.{app.platform}" variant="plain" summary={fit && pick ? summaryLine([pick.locale, t('aso:lead.keywordsCount', { count: fit.keywords.length }), fit.counts.missing > 0 && t('aso:fit.summaryMissing', { count: fit.counts.missing }), fit.counts.partial + fit.counts.description_only > 0 && t('aso:fit.summaryPartial', { count: fit.counts.partial + fit.counts.description_only })]) : (pick?.locale ?? '')}>
        <div class="stack">
          <div class="row head">
            {#if pick}<span class="muted">{pick.listingLocale && pick.listingLocale !== pick.locale ? t('aso:fit.listingIn', { locale: pick.locale, listing: pick.listingLocale }) : pick.locale}</span>{/if}
            {#if d}
              <InfoTip label={t('aso:fit.whatCountsLabel')} align="start">
                <p class="tip">
                  {d.readAt ? t('aso:fit.whatCountsRead', { ago: agoText(d.readAt, now), fields: formatList(d.indexedFields.map((f) => (fitFieldLabels[f] !== undefined ? t(fitFieldLabels[f]) : f))) }) : t('aso:fit.whatCounts', { fields: formatList(d.indexedFields.map((f) => (fitFieldLabels[f] !== undefined ? t(fitFieldLabels[f]) : f))) })}
                </p>
                {#if fit}<ul class="plain">{#each fit.assumptions as a (a)}<li>{a}</li>{/each}</ul>{/if}
              </InfoTip>
            {/if}
            <span class="spacer"></span>
            <Button size="sm" variant="link" icon="file-text" href={appAddress(app.id, 'listing', address.platform)}>{t('aso:fit.openListing')}</Button>
          </div>

          {#if errors[app.id]}
            <Alert tone="error">{errors[app.id]}</Alert>
          {:else if d && d.locales.length === 0}
            <p class="none"><T key="aso:fit.noKeywords" tags={{ link: kwLink }} /></p>
          {:else if pick && !fit}
            <p class="none">{t('aso:fit.noText', { locale: pick.locale })}</p>
          {:else if fit && pick}
            <div class="row chips">
              <StatChip label={t('aso:fit.chip.strong')} value={fit.counts.strong} tone="ok" />
              <StatChip label={t('aso:fit.chip.covered')} value={fit.counts.covered} tone="ok" />
              <StatChip label={t('aso:fit.chip.partial')} value={fit.counts.partial + fit.counts.description_only} tone="warn" />
              <StatChip label={t('aso:fit.chip.missing')} value={fit.counts.missing} tone="bad" />
            </div>

            {#if fit.gaps.length > 0}
              <p class="weak">
                <span class="muted">{t('aso:fit.weak')}</span>
                {#each fit.gaps.slice(0, 8) as g (g.id)}
                  <Badge tone={fitStatusInfo[g.status].tone}>{g.priority >= 3 ? t('aso:fit.termHigh', { term: g.term }) : g.term}</Badge>
                {/each}
                {#if fit.gaps.length > 8}<span class="muted">{t('aso:coach.more', { count: fit.gaps.length - 8 })}</span>{/if}
              </p>
            {/if}

            <div class="table-wrap">
              <table class="compact">
                <thead>
                  <tr>
                    <th scope="col">{t('aso:markets.keyword')}</th>
                    <th scope="col">{t('aso:fit.fit')}</th>
                    {#each fitColumns[app.platform] as f (f)}<th scope="col" class="mid">{fitFieldLabels[f] ? t(fitFieldLabels[f]) : f}</th>{/each}
                  </tr>
                </thead>
                <tbody>
                  {#each fit.keywords as k (k.id)}
                    {@const status = fitStatusInfo[k.status]}
                    <tr>
                      <th scope="row" class="term">{k.term} {#if k.priority !== 2}<span class="muted prio">{priorityLabel(k.priority)}</span>{/if}</th>
                      <td><span title={t(status.hintKey)}><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check-circle' : status.tone === 'bad' ? 'x-circle' : 'alert-triangle'}>{t(status.labelKey)}</Badge></span></td>
                      {#each fitColumns[app.platform] as f (f)}
                        {@const cell = fieldCell(k, f)}
                        <td class="mid" title={cell.title}>
                          {#if cell.mark === 'phrase'}
                            <span class="in"><Icon name="check" size={14} /><span class="visually-hidden">{t('aso:fit.phraseHere')}</span>{cell.text}</span>
                          {:else if cell.mark === 'words'}
                            <span class="muted">{t('aso:fit.wordsText', { text: cell.text })}</span>
                          {:else}
                            <span class="muted"><span aria-hidden="true">–</span><span class="visually-hidden">{t('aso:fit.notHere')}</span></span>
                          {/if}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            {#if pick.fields}
              {@const text = overlayStaged(app.platform, pick.listingLocale ?? pick.locale, pick.fields, stagedStore.view(app.id))}
              {@const mine = keywords.filter((k) => k.appId === app.id)}
              <div class="card budgetcard">
                <AsoBudget
                  platform={app.platform}
                  locale={pick.locale}
                  fields={text.fields}
                  staged={text.staged}
                  keywords={keywordsForLocale(mine, pick.locale)}
                  countries={countriesForLocale(mine, pick.locale)}
                  listingLocales={d?.listingLocales ?? []}
                  addHref={coachHref({ to: 'keywords_add', label: t('aso:fit.addKeywords') }, app.id, address.platform)}
                />
              </div>
            {/if}
          {/if}
        </div>
      </Section>
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

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .chips {
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .none {
    margin: var(--space-2) 0;
  }

  .weak {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: 0.9375rem;
  }

  .term {
    font-weight: var(--weight-medium);
    text-align: left;
  }

  .prio {
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
  }

  .mid {
    text-align: center;
  }

  .in {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    color: var(--ok-ink);
  }

  .tip {
    margin: 0 0 var(--space-2);
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .budgetcard {
    padding: var(--space-3) var(--space-4);
  }
</style>
