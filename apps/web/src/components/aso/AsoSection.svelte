<!--
  AsoSection: the Keywords and Search terms views of Insights of an open app (`#/portfolio/<id>/insights?view=keywords`; the old
  `?view=aso` and `#/portfolio/<id>/aso` redirect). The address keeps the keyword view (`?view=keywords|rank|listing|competitors|ideas|fit|gaps|markets`)
  and `?view=terms` is the separate Search terms view (Google Play apps only, from a Play Console file).
  Keywords: a small switch of two views, Keywords (the tracker: rank history per locale, add and remove keywords, "Check now") and Rank
  and downloads (the rank history laid on downloads; a correlation view), and a "More" menu with the rest: In your listing,
  Competitors, Ideas, Fit, Gaps and Markets. The ranked next steps are on the Overview of Insights; the keyword ideas that "Suggest keywords"
  asked for are listed here (Keywords and Ideas), where accepting them reads the tracked keywords again at once.
  It reads the tracked keywords of every app record in scope once and hands them to the views; the config of the server (is Google
  Play reading on, are checks scheduled) shows as one quiet pill. Nothing here writes to a store: the reads are our own database,
  "Check now" and following a competitor read the public store.
  Props: api, workspaceId, role, members (the app records in scope), releases (by app id), now.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { address } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AsoConfig, type AsoKeyword, asoErrorMessage, asoViewFromHash, asoViewHref, availableAsoView, keywordMainViews, keywordMoreViews, localesOf } from '../../lib/aso.ts';
  import { withInsightsAsoView } from '../../lib/app-nav.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import ViewSwitch from '../app/ViewSwitch.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AsoCompetitors from './AsoCompetitors.svelte';
  import AsoFit from './AsoFit.svelte';
  import AsoGaps from './AsoGaps.svelte';
  import AsoIdeas from './AsoIdeas.svelte';
  import AsoKeywords from './AsoKeywords.svelte';
  import AsoListing from './AsoListing.svelte';
  import AsoMarkets from './AsoMarkets.svelte';
  import AsoSearchTerms from './AsoSearchTerms.svelte';
  import AsoStatus from './AsoStatus.svelte';
  import RankVsDownloads from './RankVsDownloads.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    releases,
    now,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
    now: number;
  } = $props();

  const canWrite = $derived(can(role, 'aso.write'));

  const androidInScope = $derived(members.some((m) => m.platform === 'android'));
  const view = $derived(availableAsoView(asoViewFromHash(address.hash), androidInScope));
  /** The address of a keyword view: Keywords is written too, so it never falls back to the Overview of Insights. */
  const hrefFor = (next: string) => withInsightsAsoView(address.hash, next);
  let moreOpen = $state(false);
  const moreCurrent = $derived(keywordMoreViews.find((v) => v.id === view) ?? null);

  let config = $state<AsoConfig | null>(null);
  let keywords = $state<AsoKeyword[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  /** Bumped when keywords or competitors changed, so every view reads again. */
  let version = $state(0);
  let generation = 0;

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);

  async function load() {
    const mine = ++generation;
    loadError = '';
    try {
      const lists = await Promise.all(members.map((m) => api.asoKeywords(workspaceId, m.id)));
      if (mine !== generation) return;
      keywords = lists.reduce<AsoKeyword[]>((all, l) => all.concat(l.keywords), []);
    } catch (e) {
      if (mine !== generation) return;
      loadError = asoErrorMessage(e, 'Could not load the keywords.');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  /** What changed (a keyword added, removed, a refresh): read the keywords again and tell the views. */
  async function changed() {
    await load();
    version += 1;
  }

  // The locales of the tracked keywords are what the page header offers.
  $effect(() => {
    for (const m of members) navSignals.setLocales(workspaceId, m.id, localesOf(keywords.filter((k) => k.appId === m.id)));
  });

  // The config is workspace wide; a token limited to some apps may not read it, which only hides the pill.
  $effect(() => {
    const space = workspaceId;
    untrack(() => {
      config = null;
      api
        .asoConfig(space)
        .then((c) => {
          if (space === workspaceId) config = c;
        })
        .catch(() => undefined);
    });
  });

  let shownFor = '';
  $effect(() => {
    const next = key;
    untrack(() => {
      if (next !== shownFor) {
        shownFor = next;
        keywords = [];
        loading = true;
      }
      void load();
    });
  });

  const shared = $derived({ api, workspaceId, role, members, config, keywords, version, now, onchanged: changed });
</script>

<section class="aso stack" aria-label={view === 'terms' ? 'Search terms' : 'Keywords'}>
  <div class="row bar">
    {#if view !== 'terms'}
      <ViewSwitch views={keywordMainViews} value={view} {hrefFor} label="Keyword views" />
      <InfoTip
        label="More keyword views"
        buttonText={moreCurrent ? `More: ${moreCurrent.label}` : 'More'}
        icon="more"
        align="start"
        width="min(22rem, 92vw)"
        bind:open={moreOpen}
      >
        <ul class="menu">
          {#each keywordMoreViews as v (v.id)}
            <li>
              <a href={hrefFor(v.id)} aria-current={view === v.id ? 'page' : undefined} onclick={() => (moreOpen = false)}>
                <strong>{v.label}</strong>
                <span class="muted">{v.hint}</span>
              </a>
            </li>
          {/each}
        </ul>
      </InfoTip>
    {/if}
    <span class="spacer"></span>
    <AsoStatus {config} {androidInScope} />
  </div>

  {#if loadError}
    <Alert tone="error" title="Could not load keywords">{loadError}</Alert>
    <div><Button icon="refresh" onclick={load}>Try again</Button></div>
  {:else if loading && keywords.length === 0}
    <div role="status" aria-label="Loading keywords" class="stack">
      <Skeleton width="100%" height="36px" />
      <Skeleton width="100%" height="140px" />
    </div>
  {:else}
    {#if view === 'keywords' || view === 'ideas'}
      {#each members as m (m.id)}
        <AiSuggestions {api} {workspaceId} {role} app={m} platform={address.platform} showPlatform={members.length > 1} kind="keywords" onaccepted={changed} />
      {/each}
    {/if}
    <div>
      {#if view === 'keywords'}
        <AsoKeywords {...shared} {canWrite} />
      {:else if view === 'listing'}
        <AsoListing {...shared} {canWrite} />
      {:else if view === 'competitors'}
        <AsoCompetitors {...shared} {canWrite} {releases} />
      {:else if view === 'ideas'}
        <AsoIdeas {...shared} {canWrite} />
      {:else if view === 'fit'}
        <AsoFit {...shared} />
      {:else if view === 'gaps'}
        <AsoGaps {...shared} {canWrite} />
      {:else if view === 'terms'}
        <AsoSearchTerms {...shared} {canWrite} />
      {:else if view === 'rank'}
        <div class="stack">
          {#each members as m (m.id)}
            <RankVsDownloads
              {api}
              {workspaceId}
              app={m}
              {now}
              {version}
              heading={members.length > 1}
              analyticsHref={appAddress(m.id, 'insights', address.platform)}
              keywordsHref={asoViewHref(m.id, 'keywords', address.platform)}
            />
          {/each}
        </div>
      {:else}
        <AsoMarkets {...shared} />
      {/if}
    </div>
  {/if}
</section>

<style>
  .bar {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .menu {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .menu a {
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    color: inherit;
    text-decoration: none;
    border-radius: var(--radius-md);
  }

  .menu a:hover,
  .menu a[aria-current='page'] {
    background: var(--surface-hover);
  }

  .menu .muted {
    font-size: var(--text-sm);
  }
</style>
