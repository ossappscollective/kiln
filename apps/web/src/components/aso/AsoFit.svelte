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
  import { coachHref, countriesForLocale, keywordsForLocale, overlayStaged } from '../../lib/aso-budget.ts';
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
  } from '../../lib/aso.ts';
  import { headerParams, withHeaderParams } from '../../lib/app-header.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatChip from '../ui/StatChip.svelte';
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
  const multi = $derived(members.length > 1);
  const allLocales = $derived(localesOf(keywords));
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
            bad[m.id] = asoErrorMessage(e, 'Could not load the fit.');
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

<div class="fit stack">
  {#if allLocales.length > 1}
    <div class="row">
      <label for="{uid}-locale" class="muted">Locale</label>
      <select id="{uid}-locale" value={locale} onchange={(e) => setLocale(e.currentTarget.value)}>
        <option value="">Most used ({allLocales[0]})</option>
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
      <section class="stack" aria-label="{platformLabel(app.platform)} fit">
        <div class="row head">
          {#if multi}<h3 class="eyebrow">{platformLabel(app.platform)}</h3>{/if}
          {#if pick}<span class="muted">{pick.locale}{pick.listingLocale && pick.listingLocale !== pick.locale ? ` (listing text in ${pick.listingLocale})` : ''}</span>{/if}
          {#if d}
            <InfoTip label="What counts" align="start">
              <p class="tip">
                Compares the listing text stored on this server{d.readAt ? ` (read ${timeAgo(d.readAt, now)})` : ''} with your tracked keywords. Which fields each store searches is unverified:
                {d.indexedFields.join(', ')} are assumed.
              </p>
              {#if fit}<ul class="plain">{#each fit.assumptions as a (a)}<li>{a}</li>{/each}</ul>{/if}
            </InfoTip>
          {/if}
          <span class="spacer"></span>
          <Button size="sm" variant="link" icon="file-text" href={appAddress(app.id, 'listing', address.platform)}>Open the listing</Button>
        </div>

        {#if errors[app.id]}
          <Alert tone="error">{errors[app.id]}</Alert>
        {:else if d && d.locales.length === 0}
          <p class="none">No keywords tracked yet. <a href={asoViewHref(app.id, 'keywords', address.platform)}>Add keywords</a> to see how the listing covers them.</p>
        {:else if pick && !fit}
          <p class="none">No listing text is stored for {pick.locale}. Sync the app to read it, then come back.</p>
        {:else if fit && pick}
          <div class="row chips">
            <StatChip label="strong" value={fit.counts.strong} tone="ok" />
            <StatChip label="covered" value={fit.counts.covered} tone="ok" />
            <StatChip label="partial" value={fit.counts.partial + fit.counts.description_only} tone="warn" />
            <StatChip label="missing" value={fit.counts.missing} tone="bad" />
          </div>

          {#if fit.gaps.length > 0}
            <p class="weak">
              <span class="muted">Weak or missing:</span>
              {#each fit.gaps.slice(0, 8) as g (g.id)}
                <Badge tone={fitStatusInfo[g.status].tone}>{g.term}{g.priority >= 3 ? ' (high)' : ''}</Badge>
              {/each}
              {#if fit.gaps.length > 8}<span class="muted">and {fit.gaps.length - 8} more</span>{/if}
            </p>
          {/if}

          <div class="table-wrap">
            <table class="compact">
              <thead>
                <tr>
                  <th scope="col">Keyword</th>
                  <th scope="col">Fit</th>
                  {#each fitColumns[app.platform] as f (f)}<th scope="col" class="mid">{fitFieldLabels[f]}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each fit.keywords as k (k.id)}
                  {@const status = fitStatusInfo[k.status]}
                  <tr>
                    <th scope="row" class="term">{k.term} {#if k.priority !== 2}<span class="muted prio">{priorityLabel(k.priority)}</span>{/if}</th>
                    <td><span title={status.hint}><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check-circle' : status.tone === 'bad' ? 'x-circle' : 'alert-triangle'}>{status.label}</Badge></span></td>
                    {#each fitColumns[app.platform] as f (f)}
                      {@const cell = fieldCell(k, f)}
                      <td class="mid" title={cell.title}>
                        {#if cell.mark === 'phrase'}
                          <span class="in"><Icon name="check" size={14} /><span class="visually-hidden">Phrase in this field</span>{cell.text}</span>
                        {:else if cell.mark === 'words'}
                          <span class="muted">{cell.text} words</span>
                        {:else}
                          <span class="muted"><span aria-hidden="true">–</span><span class="visually-hidden">Not in this field</span></span>
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
                addHref={coachHref({ to: 'keywords_add', label: 'Add keywords' }, app.id, address.platform)}
              />
            </div>
          {/if}
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
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
    font-size: var(--text-sm);
  }

  .term {
    font-weight: var(--weight-medium);
    text-align: left;
  }

  .prio {
    font-size: var(--text-xs);
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
