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
  import { type ListingRow, listingRows, type Role, supports, type TrackedRank } from '@mrm/core';
  import { untrack } from 'svelte';
  import { address } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { listingLead } from '../../lib/aso-lead.ts';
  import { type AsoConfig, type AsoKeyword, type AsoListingKeywordsResponse, addSummaryText, asoErrorMessage, chunk, sumAddSummary } from '../../lib/aso.ts';
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
  } from '../../lib/aso-listing.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { territoryName } from '../../lib/reviews.ts';
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
              bad[m.id] = asoErrorMessage(e, 'Could not load the listing keywords.');
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
      planError = asoErrorMessage(e, 'Could not add the keywords.');
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
      if (out.summary.created > 0) toast.success(`Tracking “${term.term}” in ${row.country.toUpperCase()}.`);
      else toast.error(message);
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not add the keyword.'));
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
        <InfoTip label="About this view" buttonText="About this view" align="start" width="30rem">
          <div class="tip stack tight">
            <p>
              Read from the listing text the last sync stored on this server. Nothing here contacts a store, and nothing is written to one. A term is tracked when a tracked keyword
              has the same words (accents and English plurals ignored) in the same locale and storefront; the number is its rank today.
            </p>
            <p>
              The storefront is the one rank tracking already uses for the locale (the one with most tracked keywords), else the usual one for its language. Which fields each
              store searches is unverified.
            </p>
            <p>
              <strong>wasted</strong>: the keyword field repeats a word the name or subtitle already holds. <strong>repeated</strong>: the field has the same words, or a plural, twice.
              <strong>twice</strong>: the word is in more than one searched field.
            </p>
          </div>
        </InfoTip>
        {#if androidInScope}
          <label class="check"><input type="checkbox" bind:checked={includeDescription} /> Include frequent words of the Google Play description</label>
        {/if}
      </span>
    {/snippet}
    {#snippet actions()}
      {#if canWrite && everything.total > 0}
        <div class="acts" role="toolbar" aria-label="Listing keyword actions">
          <Button variant="primary" icon="plus" onclick={() => openPlan()}>Track all untracked ({everything.total})</Button>
        </div>
      {/if}
    {/snippet}
  </PageLead>

  {#if plan}
    <section class="card plan stack" aria-label="Keywords that will be added">
      <h3>Add {selectedCount} {selectedCount === 1 ? 'keyword' : 'keywords'} from the listing</h3>
      <p class="muted">
        Each is added in the storefront and locale shown, with the tag “from listing”. Nothing is read from a store until you press Check now, and nothing is changed in a store.
      </p>
      {#if plan.groups.length === 0}
        <p>Everything the listing sets is already tracked.</p>
      {/if}
      {#each plan.groups as g (g.id)}
        <fieldset class="group">
          <legend>{multi ? `${platformLabel(g.platform)} · ` : ''}{g.locale} · {g.country.toUpperCase()} storefront</legend>
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
        {#if room}<p class="muted hint">{multi ? `${platformLabel(app.platform)}: ` : ''}{room}</p>{/if}
      {/each}
      {#if planError}<Alert tone="error">{planError}</Alert>{/if}
      {#if planNote}<Alert tone="info">{planNote}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={busy} disabled={selectedCount === 0} onclick={confirmPlan}>Add {selectedCount} {selectedCount === 1 ? 'keyword' : 'keywords'}</Button>
        <Button variant="ghost" onclick={() => (plan = null)}>Cancel</Button>
      </div>
    </section>
  {/if}

  {#if loading}
    <div role="status" aria-label="Loading the listing keywords" class="stack">
      <Skeleton width="100%" height="36px" />
      <Skeleton width="100%" height="120px" />
    </div>
  {:else}
    {#each sections as s (s.app.id)}
      {@const d = s.d}
      <section class="stack" aria-label="{platformLabel(s.app.platform)} keywords in the listing">
        <div class="row head">
          {#if multi}<h3 class="eyebrow">{platformLabel(s.app.platform)}</h3>{/if}
          <span class="muted fresh">{freshnessText(s.app.platform, d?.readAt ?? null, now)}</span>
          <Button size="sm" variant="link" icon="refresh" href={appAddress(s.app.id, 'listing', address.platform)}>Re-sync in the listing</Button>
          {#if d?.error}<span class="muted">The last read failed ({d.error}); this is the earlier copy.</span>{/if}
        </div>
        {#if !supports(s.app.platform, 'keywordField')}<p class="muted note">{PLAY_NO_KEYWORD_FIELD}</p>{/if}

        {#if errors[s.app.id]}
          <Alert tone="error">{errors[s.app.id]}</Alert>
        {:else if d && d.locales.length === 0}
          <p class="none">
            No listing text is stored for this app yet. Read it from the store in the Listing tab
            (<a href={appAddress(s.app.id, 'listing', address.platform)}>Refresh from store</a>), then come back.
          </p>
        {:else if d}
          <div class="table-wrap">
            <table class="compact">
              <thead>
                <tr>
                  <th scope="col">Locale</th>
                  <th scope="col">Terms</th>
                  <th scope="col"><span class="visually-hidden">Keyword field and actions</span></th>
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
                            aria-label="Storefront for {row.locale}"
                            value={row.country}
                            onchange={(e) => (picked[`${s.app.id}|${row.locale}`] = e.currentTarget.value)}
                          >
                            {#each row.storefronts as c (c)}<option value={c}>{c.toUpperCase()}</option>{/each}
                          </select>
                        {:else}
                          <span title={storefrontTitle(row.country)}>{row.country.toUpperCase()}</span>
                        {/if}
                        storefront
                      </span>
                    </th>
                    <td>
                      {#if !row.terms.hasText}
                        <span class="muted">No text to read terms from in this locale.</span>
                      {:else}
                        {#if row.terms.extracted}<p class="muted flag">extracted, Play has no keyword field</p>{/if}
                        <ul class="chips plain" aria-label="Terms in {row.locale}">
                          {#each row.rows as t (t.key)}
                            {@const mark = termMark(t)}
                            {@const rank = rankMark(t, depth)}
                            <li class="chip" class:tracked={t.tracked} class:waste={mark?.tone === 'warn'}>
                              <span class="term">{t.term}</span>
                              <span class="src" title="In the {sourcesText(s.app.platform, t.sources)}{t.occurrences > 0 ? `, ${t.occurrences} times` : ''}">
                                {#each t.sources as src (src)}<span>{sourceMark(src)}</span>{/each}
                              </span>
                              <span class="visually-hidden">In the {sourcesText(s.app.platform, t.sources)}.</span>
                              {#if mark}<span class="mark {mark.tone}" title={mark.title}>{mark.text}</span>{/if}
                              {#if rank}
                                <span class="rank" title={rank.title}>
                                  <Icon name="check" size={12} /><span class="visually-hidden">Tracked, rank </span>{rank.text}
                                </span>
                              {:else if canWrite && row.trackable}
                                <button
                                  type="button"
                                  class="bare add"
                                  aria-label="Track {t.term} in {row.locale}, {row.country.toUpperCase()} storefront"
                                  title="Track {t.term}"
                                  disabled={chipBusy !== null}
                                  onclick={() => addOne(s.app, row, t)}
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
                        <span class="muted kf" class:over={kf.over} title={keywordFieldText(kf)}>{kf.bytes}/{kf.limit} bytes</span>
                        {#if kf.value !== ''}<CopyButton value={kf.value} label="Copy keyword field" />{/if}
                      {/if}
                      {#if canWrite && row.untracked.length > 0 && row.trackable}
                        <Button size="sm" onclick={() => openPlan({ appId: s.app.id, locale: row.locale })}>Track {row.untracked.length} untracked</Button>
                      {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="muted legend">
            {!supports(s.app.platform, 'keywordField')
              ? 'name: title, short: short description, desc: full description.'
              : 'kw: keyword field, name: name, sub: subtitle.'}
            A dashed chip is not tracked yet; a solid one is tracked and shows its rank today.
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
    outline: 2px solid var(--accent);
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
