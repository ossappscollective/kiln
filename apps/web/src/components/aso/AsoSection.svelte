<!--
  AsoSection: the ASO section of an open app (#/portfolio/<id>/aso?view=...). Six views as segmented tabs,
  kept in the address (`?view=keywords|competitors|ideas|fit|gaps|markets`): Keywords, Competitors, Ideas,
  Fit, Gaps and Markets. It reads the tracked keywords of every app record in scope once and hands them to
  the views; the config of the server (is Google Play reading on, are checks scheduled) shows as one quiet
  pill. Above the tabs, the ranked next steps of each app in scope (AsoCoach), and under them the AI suggestions of each app
  (AiSuggestions: drawn only when AI is on and something is open; nothing in them acts until a person accepts it). Nothing here writes to a store: the
  reads are our own database, "Check now" and following a competitor read the public store.
  Props: api, workspaceId, role, members (the app records in scope), releases (by app id), now.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AsoConfig, type AsoKeyword, type AsoView, asoErrorMessage, asoViewFromHash, asoViews, localesOf, withAsoView } from '../../lib/aso.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import AsoCoach from './AsoCoach.svelte';
  import AsoCompetitors from './AsoCompetitors.svelte';
  import AsoFit from './AsoFit.svelte';
  import AsoGaps from './AsoGaps.svelte';
  import AsoIdeas from './AsoIdeas.svelte';
  import AsoKeywords from './AsoKeywords.svelte';
  import AsoMarkets from './AsoMarkets.svelte';
  import AsoStatus from './AsoStatus.svelte';

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

  const uid = $props.id();
  const canWrite = $derived(can(role, 'aso.write'));
  const canRead = $derived(can(role, 'aso.read'));

  const view = $derived(asoViewFromHash(address.hash));
  const setView = (next: string) => replaceHash(withAsoView(location.hash, next as AsoView));

  let config = $state<AsoConfig | null>(null);
  let keywords = $state<AsoKeyword[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  /** Bumped when keywords or competitors changed, so every view reads again. */
  let version = $state(0);
  let generation = 0;

  const androidInScope = $derived(members.some((m) => m.platform === 'android'));
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
  const ids = $derived(segmentIds(uid, view));
</script>

<section class="aso stack" aria-label="ASO">
  {#if canRead}
    {#each members as m (m.id)}
      <AsoCoach {api} {workspaceId} app={m} {version} showPlatform={members.length > 1} visible={members.length > 1 ? 2 : 4} />
    {/each}
  {/if}

  <div class="row bar">
    <SegmentTabs tabs={asoViews} label="ASO views" idPrefix={uid} bind:value={() => view, setView} />
    <span class="spacer"></span>
    <AsoStatus {config} {androidInScope} />
  </div>

  {#each members as m (m.id)}
    <AiSuggestions {api} {workspaceId} {role} app={m} platform={address.platform} showPlatform={members.length > 1} onaccepted={changed} />
  {/each}

  {#if loadError}
    <Alert tone="error" title="Could not load ASO">{loadError}</Alert>
    <div><Button icon="refresh" onclick={load}>Try again</Button></div>
  {:else if loading && keywords.length === 0}
    <div role="status" aria-label="Loading keywords" class="stack">
      <Skeleton width="100%" height="36px" />
      <Skeleton width="100%" height="140px" />
    </div>
  {:else}
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
      {#if view === 'keywords'}
        <AsoKeywords {...shared} {canWrite} />
      {:else if view === 'competitors'}
        <AsoCompetitors {...shared} {canWrite} {releases} />
      {:else if view === 'ideas'}
        <AsoIdeas {...shared} {canWrite} />
      {:else if view === 'fit'}
        <AsoFit {...shared} />
      {:else if view === 'gaps'}
        <AsoGaps {...shared} {canWrite} />
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
</style>
