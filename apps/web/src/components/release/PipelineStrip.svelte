<!--
  PipelineStrip: a slim five-step line (CI, Build, Prepare, Review, Release) for the release that is on its way, with the step
  that matters now highlighted and one phrase for who is expected to act: "Waiting for you", "Waiting on the store" or
  "Waiting on CI". It links to the step of the release stepper where the release is finished. Drawn only while a release is on
  its way: an idle, unknown or live app draws nothing (quiet by default). It reads the pipeline of our own database
  (docs/api/release-pipeline.md); a failed read draws nothing.
  Props: api, workspaceId, app, scope (the platform scope for the link), refreshKey (changes when the screen synced), showPlatform.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { pipelineStore } from '../../lib/pipeline-store.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { stripModel, stripVisible } from '../../lib/release-pipeline.ts';
  import { releaseStepHref } from '../../lib/release-stepper.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';

  let {
    api,
    workspaceId,
    app,
    scope,
    refreshKey = 0,
    showPlatform = false,
  }: {
    api: Api;
    workspaceId: string;
    app: Pick<AppSummary, 'id' | 'platform'>;
    scope: PlatformScope | null;
    refreshKey?: number;
    showPlatform?: boolean;
  } = $props();

  const data = $derived(pipelineStore.app(app.id));
  const show = $derived(data !== null && stripVisible(data.pipeline));
  const model = $derived(data !== null && show ? stripModel(data.pipeline) : null);

  let shownFor = '';
  $effect(() => {
    void refreshKey;
    const key = `${workspaceId}/${app.id}`;
    untrack(() => {
      shownFor = key;
      void pipelineStore.loadApp(api, workspaceId, app.id);
    });
  });
</script>

{#if model}
  <div class="strip" data-testid="pipeline-strip" role="group" aria-label="Release progress{showPlatform ? `, ${platformLabel(app.platform)}` : ''}">
    <ol class="steps">
      {#each model.steps as s (s.id)}
        <li class="s {s.status}" class:current={s.current} aria-current={s.current ? 'step' : undefined} title={s.detail ?? undefined}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{s.label}</span>
          <span class="visually-hidden">: {s.word}</span>
        </li>
      {/each}
    </ol>
    {#if model.waiting}
      <Badge tone={model.waiting.who === 'you' ? 'warn' : 'neutral'}>{model.waiting.text}</Badge>
    {/if}
    <span class="summary muted">{model.summary}</span>
    <a class="go" href={releaseStepHref(app.id, scope, model.step)}>Open the release steps</a>
  </div>
{/if}

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .s {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    color: var(--muted);
  }

  .s.current {
    font-weight: var(--weight-semibold);
    color: var(--text);
  }

  .dot {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    background: transparent;
    border: 2px solid var(--line-strong, var(--muted));
    border-radius: 50%;
  }

  .s.done .dot {
    background: var(--ok);
    border-color: var(--ok);
  }

  .s.current .dot,
  .s.waiting .dot {
    border-color: var(--accent);
  }

  .s.current .dot {
    background: var(--accent);
  }

  .s.failed .dot,
  .s.stalled .dot {
    background: var(--bad);
    border-color: var(--bad);
  }

  .s.stalled .dot {
    background: var(--warn);
    border-color: var(--warn);
  }

  .summary {
    flex: 1;
    min-width: 12rem;
  }

  .go {
    font-weight: var(--weight-medium);
  }
</style>
