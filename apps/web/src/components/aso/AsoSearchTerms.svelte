<!--
  AsoSearchTerms: the "Search terms" view of a Google Play app, from a file exported in Play Console (nothing is read from Google).
  Top terms of the imported period by installs or visitors, with the conversion, which terms are tracked keywords (one click tracks
  one), which are in the stored listing text, and the terms that brought installs but are not fully in the listing, with a plain
  "add to the description?" hint (a suggestion, no AI). A quiet line says when the file was imported and what it covers. Without a file
  the view says how to export one and offers the import. These are the terms people searched and then opened the listing from, not how
  often a term is searched; the notes say so.
  Props: api, workspaceId, role, members (apps in scope; only Google Play apps are drawn), keywords, version, now, canWrite, onchanged.
  The words and numbers are lib/search-terms.ts. Terms are shown here and kept nowhere else.
-->
<script lang="ts">
  import { can, dateToDay, type Role, supports } from '@mrm/core';
  import type { SearchTermSort } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import { type AsoKeyword, asoErrorMessage, asoViewHref } from '../../lib/aso/aso.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { searchTermsLead } from '../../lib/aso/lead.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { countOf, summaryLine } from '../../lib/section-state.ts';
  import {
    type SearchTermsResponse,
    dayOfMs,
    exportCaveat,
    exportSteps,
    freshnessLine,
    periodLine,
    termRows,
    totalsLine,
    trackTarget,
  } from '../../lib/aso/search-terms.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import SearchTermsImportDialog from './SearchTermsImportDialog.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    keywords,
    version,
    now,
    canWrite,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    keywords: AsoKeyword[];
    version: number;
    now: number;
    canWrite: boolean;
    onchanged: () => void | Promise<void>;
  } = $props();

  const uid = $props.id();
  const apps = $derived(members.filter((m) => supports(m.platform, 'searchTermsImport')));
  const canImport = $derived(can(role, 'analytics.manage'));
  const today = $derived(dateToDay(now));

  let sort = $state<SearchTermSort>('installs');
  let country = $state('');
  let data = $state<Record<string, SearchTermsResponse | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let generation = 0;
  let importing = $state<string | null>(null);
  let importOpen = $state(false);
  let tracking = $state<Record<string, boolean | undefined>>({});
  /** The terms tracked in this visit, so the button turns into "Tracked" before the lists are read again. */
  let justTracked = $state<Record<string, boolean | undefined>>({});
  let reload = $state(0);
  const lead = $derived(
    searchTermsLead(
      apps.flatMap((m) => {
        const d = data[m.id];
        return d ? [{ stored: d.stored !== null, terms: d.terms.length, period: d.terms.length > 0 ? periodLine(d) : null }] : [];
      }),
    ),
  );
  /** With one app the lead holds the one Import button (once a file is stored; before that the empty state has the primary one). */
  const single = $derived(apps.length === 1);

  $effect(() => {
    void version;
    void reload;
    const list = apps;
    const by = sort;
    const where = country;
    const mine = ++generation;
    void (async () => {
      const next: Record<string, SearchTermsResponse | undefined> = {};
      const bad: Record<string, string | undefined> = {};
      await Promise.all(
        list.map(async (m) => {
          try {
            next[m.id] = await api.asoSearchTerms(workspaceId, m.id, { sort: by, ...(where !== '' ? { country: where } : {}) });
          } catch (e) {
            bad[m.id] = asoErrorMessage(e, 'Could not load the search terms.');
          }
        }),
      );
      if (mine !== generation) return;
      data = next;
      errors = bad;
      loading = false;
    })();
  });

  const countries = $derived.by(() => {
    const seen: Record<string, true | undefined> = {};
    const out: string[] = [];
    for (const m of apps) for (const c of data[m.id]?.stored?.countries ?? []) if (!seen[c]) ((seen[c] = true), out.push(c));
    return out.sort();
  });

  const openImport = (appId: string) => {
    importing = appId;
    importOpen = true;
  };

  async function track(app: AppSummary, view: SearchTermsResponse, term: string, key: string) {
    const target = trackTarget(view, keywords.filter((k) => k.appId === app.id)) ?? { country: 'us', locale: view.locale };
    tracking = { ...tracking, [key]: true };
    try {
      const result = await api.addAsoKeywords(workspaceId, app.id, [{ term, country: target.country, locale: target.locale }]);
      const status = result.results[0]?.status;
      if (status === 'created' || status === 'exists') {
        justTracked = { ...justTracked, [`${app.id}/${key}`]: true };
        toast.success(status === 'created' ? `Tracking ${term} in ${target.country.toUpperCase()}.` : 'Already tracked.');
        await onchanged();
      } else if (status === 'limit') toast.error('The limit of tracked keywords is reached.');
      else toast.error('That term cannot be tracked.');
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not track the term.'));
    } finally {
      tracking = { ...tracking, [key]: false };
    }
  }
</script>

<div class="terms stack roomy">
  {#if apps.length === 0}
    <p class="none">Search terms come from Google Play Console, so they are only for Google Play apps.</p>
  {:else}
    {#if !loading && apps.some((m) => data[m.id])}
      <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="search-terms-lead">
        {#snippet actions()}
          {#if single && canImport && apps[0] && data[apps[0].id]?.stored}
            <Button icon="upload" onclick={() => openImport(apps[0]?.id ?? '')}>Import a file</Button>
          {/if}
        {/snippet}
      </PageLead>
    {/if}
    {#if countries.length > 0 || apps.some((m) => data[m.id]?.terms.length)}
      <div class="row">
        <label for="{uid}-sort" class="muted">Sort by</label>
        <select id="{uid}-sort" bind:value={sort}>
          <option value="installs">Installs</option>
          <option value="visitors">Listing visitors</option>
        </select>
        {#if countries.length > 0}
          <label for="{uid}-country" class="muted">Country</label>
          <select id="{uid}-country" bind:value={country}>
            <option value="">All</option>
            {#each countries as c (c)}<option value={c}>{c.toUpperCase()}</option>{/each}
          </select>
        {/if}
      </div>
    {/if}

    {#if loading}
      <Skeleton width="100%" height="140px" />
    {:else}
      {#each apps as app (app.id)}
        {@const d = data[app.id]}
        {@const rows = d ? termRows(d.terms) : []}
        {@const fresh = d ? freshnessLine(d, dayOfMs) : null}
        <Section title={platformLabel(app.platform)} key="platform.{app.platform}" variant="plain" summary={d ? (d.stored ? summaryLine([countOf(d.terms.length, 'term'), d.terms.length > 0 && periodLine(d)]) : 'No file imported yet') : ''}>
          <div class="stack">
            <div class="row head">
              {#if d && d.terms.length > 0}<span class="muted">{periodLine(d)}</span>{/if}
              {#if d && d.stored && d.notes.length > 0}
                <InfoTip label="How to read the search terms" buttonText="How to read this" align="start" width="26rem">
                  <ul class="plain">{#each d.notes as n (n.code)}<li>{n.message}</li>{/each}</ul>
                </InfoTip>
              {/if}
              <span class="spacer"></span>
              {#if canImport && d && d.stored && !single}
                <Button size="sm" icon="upload" onclick={() => openImport(app.id)}>Import a file</Button>
              {/if}
            </div>

            {#if errors[app.id]}
              <Alert tone="error">{errors[app.id]}</Alert>
            {:else if d && !d.stored}
              <EmptyState icon="search" title="No search terms yet" description={exportCaveat}>
                {#snippet actions()}
                  {#if canImport}
                    <Button variant="primary" icon="upload" onclick={() => openImport(app.id)}>Import a file</Button>
                  {:else}
                    <span class="muted">An owner or an admin can import the file.</span>
                  {/if}
                {/snippet}
              </EmptyState>
              <ol class="steps">{#each exportSteps as step (step)}<li>{step}</li>{/each}</ol>
            {:else if d}
              {#if fresh}<p class="fresh muted">{fresh}</p>{/if}
              {#if d.terms.length === 0}
                <p class="none">No terms in this period{d.country ? ` for ${d.country.toUpperCase()}` : ''}. Choose another country, or import a file that covers it.</p>
              {:else}
                {@const sum = totalsLine(d)}
                {#if sum}<p class="muted sum">{sum}</p>{/if}
                <div class="table-wrap">
                  <table class="compact">
                    <thead>
                      <tr>
                        <th scope="col">Term</th>
                        <th scope="col" class="num">Installs</th>
                        <th scope="col" class="num">Visitors</th>
                        <th scope="col" class="num">Conversion</th>
                        <th scope="col">In your listing</th>
                        <th scope="col">Tracked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each rows as r (r.key)}
                        <tr>
                          <th scope="row" class="term">
                            {r.term}
                            {#if r.hint}<span class="hint muted">{r.hint}</span>{/if}
                          </th>
                          <td class="num">{r.installs}</td>
                          <td class="num">{r.visitors}</td>
                          <td class="num">{r.conversion}</td>
                          <td><span title={r.listing.title}><Badge tone={r.listing.tone}>{r.listing.text}</Badge></span></td>
                          <td>
                            {#if r.tracked || justTracked[`${app.id}/${r.key}`]}
                              <Badge tone="ok" icon="check">Tracked{r.trackedIn ? ` in ${r.trackedIn}` : ''}</Badge>
                            {:else if canWrite}
                              <Button size="sm" variant="link" icon="plus" loading={tracking[r.key] === true} onclick={() => track(app, d, r.term, r.key)}>Track</Button>
                            {:else}
                              <span class="muted">No</span>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                {#if d.listingReadAt}
                  <p class="muted foot">
                    Listing text read {timeAgo(d.listingReadAt, now)}{d.listingLocale ? ` (${d.listingLocale})` : ''}.
                    <a href={asoViewHref(app.id, 'fit', address.platform)}>See how the listing covers your keywords</a>
                  </p>
                {/if}
              {/if}
            {/if}
          </div>
        </Section>
      {/each}
    {/if}
  {/if}
</div>

{#if importing}
  <SearchTermsImportDialog bind:open={importOpen} {api} {workspaceId} appId={importing} {today} onimported={() => ((reload += 1), void onchanged())} />
{/if}

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

  .terms select {
    width: auto;
  }

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .fresh,
  .sum,
  .foot {
    margin: 0;
    font-size: 0.9375rem;
  }

  .term {
    max-width: 28rem;
  }

  .hint {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
  }

  .steps {
    max-width: 44rem;
    padding-left: var(--space-5);
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }

  .plain {
    padding-left: var(--space-4);
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
