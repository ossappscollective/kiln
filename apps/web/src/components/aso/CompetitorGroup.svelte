<!--
  CompetitorGroup: the followed competitors of one app record: cards, suggestions from the discovery and the side
  by side with our app. Suggestions are apps in the stored top results of several of your keywords; following one
  asks first, because it reads the store.
  Props: api, workspaceId, app, multi (show the store name), canWrite, canReviews (may read our rating), now,
  releases (of this app, for our version), version (bump to read again), onchanged.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import {
    type AsoCompetitor,
    type AsoCompetitorHistory,
    type AsoSuggestion,
    type OurFacts,
    asoErrorMessage,
    compareRows,
  } from '../../lib/aso.ts';
  import { liveRelease, platformLabel, runLimited } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import CompetitorCard from './CompetitorCard.svelte';

  let {
    api,
    workspaceId,
    app,
    multi,
    canWrite,
    canReviews,
    now,
    releases,
    version,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    app: AppSummary;
    multi: boolean;
    canWrite: boolean;
    canReviews: boolean;
    now: number;
    releases: ReleaseSummary[];
    version: number;
    onchanged: () => void;
  } = $props();

  let competitors = $state<AsoCompetitor[]>([]);
  let limit = $state(10);
  let histories = $state<Record<string, AsoCompetitorHistory | undefined>>({});
  let suggestions = $state<AsoSuggestion[]>([]);
  let loading = $state(true);
  let error = $state('');
  let compare = $state<string[]>([]);
  let busyId = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let generation = 0;

  async function load() {
    const mine = ++generation;
    error = '';
    try {
      const [list, sug] = await Promise.all([
        api.asoCompetitors(workspaceId, app.id),
        api.asoSuggestions(workspaceId, app.id).catch(() => ({ suggestions: [] as AsoSuggestion[] })),
      ]);
      if (mine !== generation) return;
      competitors = list.competitors;
      limit = list.limits.maxCompetitorsPerApp;
      suggestions = sug.suggestions;
      compare = compare.filter((id) => list.competitors.some((c) => c.id === id));
      loading = false;
      await runLimited(list.competitors, 4, async (c) => {
        try {
          const h = await api.asoCompetitorHistory(workspaceId, app.id, c.id, 30);
          if (mine === generation) histories[c.id] = h;
        } catch {
          // The card shows what the list holds.
        }
      });
    } catch (e) {
      if (mine !== generation) return;
      error = asoErrorMessage(e, 'Could not load the competitors.');
      loading = false;
    }
  }

  $effect(() => {
    void version;
    void app.id;
    void load();
  });

  function toggle(id: string) {
    compare = compare.indexOf(id) >= 0 ? compare.filter((x) => x !== id) : compare.concat(id).slice(-4);
  }

  async function remove(c: AsoCompetitor) {
    busyId = c.id;
    try {
      await api.deleteAsoCompetitor(workspaceId, app.id, c.id);
      toast.success(`Stopped following “${c.name}”.`);
      onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not remove the competitor.'));
    } finally {
      busyId = null;
    }
  }

  async function follow(s: AsoSuggestion) {
    busyId = `${s.externalId}:${s.country}`;
    try {
      const out = await api.addAsoCompetitor(workspaceId, app.id, { externalId: s.externalId, country: s.country });
      toast.success(`Following “${out.competitor.name}”.`);
      confirming = null;
      onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not follow that app.'));
    } finally {
      busyId = null;
    }
  }

  // ----- Compare: our version from the releases we hold; our rating from the reviews summary, only when it is asked for.
  let ourRating = $state<{ rating: number | null; count: number | null }>({ rating: null, count: null });
  const picked = $derived(compare.map((id) => competitors.find((c) => c.id === id)).filter((c): c is AsoCompetitor => c !== undefined));
  const ours = $derived<OurFacts>({
    version: liveRelease(releases, app.platform)?.version ?? null,
    rating: ourRating.rating,
    ratingCount: ourRating.count,
  });
  const rows = $derived(compareRows(ours, picked));
  let ratingFor = '';

  $effect(() => {
    if (picked.length === 0 || !canReviews || ratingFor === app.id) return;
    ratingFor = app.id;
    api
      .appReviewsSummary(workspaceId, app.id)
      .then((s) => {
        const wide = s.storeWide[0];
        ourRating = { rating: wide?.average ?? null, count: wide?.ratingCount ?? null };
      })
      .catch(() => undefined);
  });
</script>

<section class="group stack" aria-label="{platformLabel(app.platform)} competitors">
  {#if multi}<h3 class="eyebrow">{platformLabel(app.platform)}</h3>{/if}

  {#if error}
    <Alert tone="error">{error}</Alert>
    <div><Button icon="refresh" onclick={load}>Try again</Button></div>
  {:else if loading}
    <Skeleton width="100%" height="120px" />
  {:else}
    {#if competitors.length === 0}
      <p class="none">No competitors followed yet.{#if canWrite} Add one above{suggestions.length > 0 ? ' or from the suggestions' : ''}.{/if}</p>
    {:else}
      <div class="cards">
        {#each competitors as c (c.id)}
          <CompetitorCard
            competitor={c}
            history={histories[c.id] ?? null}
            {now}
            {canWrite}
            comparing={compare.indexOf(c.id) >= 0}
            ontoggle={() => toggle(c.id)}
            onremove={() => remove(c)}
            busy={busyId === c.id}
          />
        {/each}
      </div>
      <p class="muted count">{competitors.length} of {limit} followed</p>
    {/if}

    {#if picked.length > 0}
      <div class="table-wrap">
        <table class="compact">
          <caption class="visually-hidden">Your app next to the competitors you picked</caption>
          <thead>
            <tr>
              <th scope="col"><span class="visually-hidden">Fact</span></th>
              <th scope="col">{app.name} <span class="muted">(yours)</span></th>
              {#each picked as c (c.id)}<th scope="col"><span class="truncate name" title={c.name}>{c.name}</span></th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.label)}
              <tr>
                <th scope="row">{r.label}</th>
                <td>{r.ours}</td>
                {#each r.theirs as v, i (i)}<td>{v}</td>{/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if canWrite && suggestions.length > 0}
      <Disclosure summary="Suggested from your keywords ({suggestions.length})" stateKey="aso.suggestions.{app.id}">
        <ul class="suggest">
          {#each suggestions as s (`${s.externalId}:${s.country}`)}
            {@const id = `${s.externalId}:${s.country}`}
            <li>
              <span class="who">
                <strong>{s.name ?? s.externalId}</strong>
                <span class="muted">{s.country.toUpperCase()} · in the results of {s.keywordCount} keywords, best rank {s.bestRank}</span>
              </span>
              {#if confirming === id}
                <span class="confirm">
                  Follow it? This reads the store once.
                  <Button size="sm" variant="primary" loading={busyId === id} onclick={() => follow(s)}>Follow</Button>
                  <Button size="sm" variant="ghost" onclick={() => (confirming = null)}>Cancel</Button>
                </span>
              {:else}
                <Button size="sm" onclick={() => (confirming = id)}>Follow…</Button>
              {/if}
            </li>
          {/each}
        </ul>
      </Disclosure>
    {/if}
  {/if}
</section>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: var(--space-3);
  }

  .none {
    margin: var(--space-2) 0;
  }

  .count {
    margin: 0;
    font-size: var(--text-xs);
  }

  .name {
    display: inline-block;
    max-width: 14rem;
    vertical-align: bottom;
  }

  .suggest {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .suggest li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }

  .suggest li:first-child {
    border-top: 0;
  }

  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .confirm {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
  }
</style>
