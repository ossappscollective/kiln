<!--
  CompetitorGroup: the followed competitors of one app record: cards, suggestions from the discovery and the side
  by side with our app. Suggestions are apps in the stored top results of several of your keywords; following one
  asks first, because it reads the store.
  Props: api, workspaceId, app, multi (show the store name), canWrite, canReviews (may read our rating), now,
  releases (of this app, for our version), version (bump to read again), onchanged.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { bumpCompetitors } from '../../lib/aso/competitor-sync.svelte.ts';
  import {
    type AsoCompetitor,
    type AsoCompetitorHistory,
    type AsoSuggestion,
    type OurFacts,
    asoErrorMessage,
    compareRows,
  } from '../../lib/aso/aso.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { liveRelease, platformLabel, runLimited } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import CompetitorCard from './CompetitorCard.svelte';
  import CompetitorReviewSchedule from './CompetitorReviewSchedule.svelte';

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
    onsummary,
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
    /** Tells the view above what this group holds, so one lead can say it for every app in scope. */
    onsummary?: ((appId: string, facts: { competitors: AsoCompetitor[]; suggestions: number }) => void) | undefined;
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
      error = asoErrorMessage(e, t('aso:group.loadFailed'));
      loading = false;
    }
  }

  $effect(() => {
    void version;
    void app.id;
    void load();
  });

  $effect(() => {
    if (loading || error) return;
    const facts = { competitors: competitors.slice(), suggestions: canWrite ? suggestions.length : 0 };
    untrack(() => onsummary?.(app.id, facts));
  });

  function toggle(id: string) {
    compare = compare.indexOf(id) >= 0 ? compare.filter((x) => x !== id) : compare.concat(id).slice(-4);
  }

  async function remove(c: AsoCompetitor) {
    busyId = c.id;
    try {
      await api.deleteAsoCompetitor(workspaceId, app.id, c.id);
      toast.success(t('aso:group.stopped', { name: c.name }));
      bumpCompetitors();
      onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:group.removeFailed')));
    } finally {
      busyId = null;
    }
  }

  async function follow(s: AsoSuggestion) {
    busyId = `${s.externalId}:${s.country}`;
    try {
      const out = await api.addAsoCompetitor(workspaceId, app.id, { externalId: s.externalId, country: s.country });
      toast.success(t('aso:group.following', { name: out.competitor.name }));
      confirming = null;
      bumpCompetitors();
      onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:group.followFailed')));
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

<section class="group stack roomy" aria-label={t('aso:group.label', { platform: platformLabel(app.platform) })}>
  {#if multi}<h3 class="eyebrow">{platformLabel(app.platform)}</h3>{/if}

  {#if error}
    <Alert tone="error">{error}</Alert>
    <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
  {:else if loading}
    <Skeleton width="100%" height="120px" />
  {:else}
    {#if competitors.length === 0}
      <p class="none">{!canWrite ? t('aso:group.none') : suggestions.length > 0 ? t('aso:group.noneAddOrSuggest') : t('aso:group.noneAdd')}</p>
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
            {api}
            {workspaceId}
            onchecked={() => void load()}
          />
        {/each}
      </div>
      <p class="muted count">{t('aso:group.followed', { count: competitors.length, limit })}</p>
      <CompetitorReviewSchedule {api} {workspaceId} {app} {canWrite} {now} {version} />
    {/if}

    {#if picked.length > 0}
      <div class="table-wrap">
        <table class="compact">
          <caption class="visually-hidden">{t('aso:group.caption')}</caption>
          <thead>
            <tr>
              <th scope="col"><span class="visually-hidden">{t('aso:group.fact')}</span></th>
              <th scope="col">{app.name} <span class="muted">{t('aso:group.yours')}</span></th>
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
      <Section title={t('aso:group.suggested')} key="suggestions.{app.platform}" count={suggestions.length} defaultOpen={false}>
        <ul class="suggest">
          {#each suggestions as s (`${s.externalId}:${s.country}`)}
            {@const id = `${s.externalId}:${s.country}`}
            <li>
              <span class="who">
                <strong>{s.name ?? s.externalId}</strong>
                <span class="muted">{t('aso:group.suggestLine', { country: s.country.toUpperCase(), count: s.keywordCount, rank: s.bestRank })}</span>
              </span>
              {#if confirming === id}
                <span class="confirm">
                  {t('aso:group.followQuestion')}
                  <Button size="sm" variant="primary" loading={busyId === id} onclick={() => follow(s)}>{t('aso:group.follow')}</Button>
                  <Button size="sm" variant="ghost" onclick={() => (confirming = null)}>{t('common:action.cancel')}</Button>
                </span>
              {:else}
                <Button size="sm" onclick={() => (confirming = id)}>{t('aso:group.followMore')}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      </Section>
    {/if}
  {/if}
</section>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: var(--space-4);
  }

  .none {
    margin: var(--space-2) 0;
  }

  .count {
    margin: 0;
    font-size: var(--text-sm);
  }

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
    padding: var(--space-3) 0;
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
    font-size: 0.9375rem;
  }
</style>
