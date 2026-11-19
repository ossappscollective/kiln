<!--
  PipelineStrip: the release that is on its way, one strip per release train (lib/release-trains.ts): the version of an app, its
  iOS and macOS records together, with a build that no version has yet shown as a line inside the version's strip ("Build 169 is
  ready: attach it to 3.1.1") or as "New build 169" when no version exists. The five steps (CI, Build, Prepare, Review, Release)
  each explain themselves on hover and in one "About these steps" tip; the step that matters now is marked. Under them, one or two
  plain sentences say what is waiting for whom, and one button leads to the step of the release stepper that deals with it.
  Drawn only while a release is on its way: idle, unknown and live records draw nothing (quiet by default). It reads the
  pipeline of our own database (docs/api/release-pipeline.md); a failed read draws nothing.
  Props: api, workspaceId, apps (the records in scope), scope (the platform scope for the link), refreshKey (changes when the screen synced).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { pipelineStore } from '../../lib/pipeline-store.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { releaseTrains, trainInputOf } from '../../lib/release-trains.ts';
  import { releaseStepHref } from '../../lib/release-stepper.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import TrainSteps from './TrainSteps.svelte';

  let {
    api,
    workspaceId,
    apps,
    scope,
    refreshKey = 0,
  }: {
    api: Api;
    workspaceId: string;
    apps: Pick<AppSummary, 'id' | 'platform'>[];
    scope: PlatformScope | null;
    refreshKey?: number;
  } = $props();

  const trains = $derived(
    releaseTrains(
      apps
        .map((a) => pipelineStore.app(a.id))
        .filter((d): d is NonNullable<typeof d> => d !== null)
        .map(trainInputOf),
    ),
  );

  let loadedKey = '';
  $effect(() => {
    const key = `${workspaceId}/${apps.map((a) => a.id).join(',')}`;
    const again = refreshKey;
    const list = apps.map((a) => a.id);
    untrack(() => {
      // A finished sync reads again; opening the page or changing the scope reuses what was read a moment ago.
      const force = key === loadedKey && again !== lastRefresh;
      loadedKey = key;
      lastRefresh = again;
      for (const id of list) void pipelineStore.loadApp(api, workspaceId, id, force);
    });
  });
  let lastRefresh = 0;
</script>

{#each trains as t (t.key)}
  <div class="strip" data-testid="pipeline-strip" role="group" aria-label="Release progress, {t.title}">
    <div class="top">
      <strong class="title">{t.title}</strong>
      {#if t.platforms.length > 1}<span class="muted">{t.platforms.map((p) => platformLabel(p)).join(' and ')}</span>{/if}
      {#if t.waiting}<Badge tone={t.waiting.who === 'you' ? 'warn' : 'neutral'}>{t.waiting.text}</Badge>{/if}
      <TrainSteps steps={t.steps} />
    </div>
    <div class="bottom">
      <div class="lines">
        {#each t.lines as line (line)}<p class="summary">{line}</p>{/each}
      </div>
      <Button size="sm" href={releaseStepHref(t.button.appId, scope, t.button.step, t.version)}>{t.button.label}</Button>
    </div>
  </div>
{/each}

<style>
  .strip {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .top,
  .bottom {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .bottom {
    justify-content: space-between;
  }

  .lines {
    flex: 1;
    min-width: 12rem;
  }

  .summary {
    margin: 0;
    color: var(--muted);
  }

  .title {
    font-weight: var(--weight-semibold);
  }
</style>
