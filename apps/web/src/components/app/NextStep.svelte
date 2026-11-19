<!--
  NextStep: the one card at the top of the Overview and of Releases. It says what to do next and offers ONE primary button for it,
  chosen from the state (lib/next-step.ts): the release that waits for you (rejected, approved, a build to attach, unfinished), the
  release that waits for the store, or, with nothing on its way, "Start release". The five steps of the release on its way sit in the
  card; the other releases on their way are one quiet line each; with `attention` (the Overview) the rest of "Needs attention" is
  listed under it, so nothing is said twice. It reads the release pipeline of our own database (like PipelineStrip) and writes nothing:
  "Start release" only opens its dialog (StartRelease), whose confirmation is the one action.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), scope (platform scope
  for links), attention? (items of "Needs attention"; default none), refreshKey (changes when the screen synced), onprepare? (open
  the release steps in place, on Releases; without it the card links to them; with it, "Prepare without CI" is offered beside
  "Start release"), showRunning = false (draw the run "Start release" started under the card; the Overview draws its own list),
  onstarted? (the run "Start release" started).
  Exports: observe(data) takes a RunningNow answer, so the screen's own feed is read once.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { AttentionItem } from '../../lib/app-attention.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { chooseNextStep } from '../../lib/next-step.ts';
  import { pipelineStore } from '../../lib/pipeline-store.svelte.ts';
  import { releaseTrains, trainInputOf } from '../../lib/release-trains.ts';
  import { releaseStepHref } from '../../lib/release-stepper.ts';
  import type { StartedRun } from '../../lib/start-release.ts';
  import type { ActiveRuns, AppSummary } from '../../lib/types.ts';
  import TrainSteps from '../release/TrainSteps.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import AttentionList from './AttentionList.svelte';
  import StartRelease from './StartRelease.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    scope,
    attention = [],
    refreshKey = 0,
    showRunning = false,
    onprepare,
    onstarted,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[];
    scope: PlatformScope | null;
    attention?: AttentionItem[];
    refreshKey?: number;
    showRunning?: boolean;
    onprepare?: () => void;
    onstarted?: (started: StartedRun | null) => void;
  } = $props();

  const uid = $props.id();
  let start = $state<{ observe: (data: ActiveRuns) => void }>();
  export function observe(data: ActiveRuns) {
    start?.observe(data);
  }

  const trains = $derived(
    releaseTrains(
      members
        .map((m) => pipelineStore.app(m.id))
        .filter((d): d is NonNullable<typeof d> => d !== null)
        .map(trainInputOf),
    ),
  );
  const canStart = $derived(can(role, 'ci.dispatch') && can(role, 'repositories.read') && members.some((m) => m.repositoryId !== null));
  const canPrepare = $derived(can(role, 'listing.read') && members.length > 0);
  const step = $derived(chooseNextStep({ trains, attention, scope, canStart, canPrepare }));
  const prepareHref = $derived(members[0] ? releaseStepHref(members[0].id, scope, 'build') : '');
  const startsHere = $derived(step.primary !== null && 'action' in step.primary && step.primary.action === 'start-release');
  const preparesHere = $derived(step.primary !== null && 'action' in step.primary && step.primary.action === 'prepare-release');
  const startButton = $derived<'primary' | 'secondary' | 'none'>(startsHere ? 'primary' : step.offerStart ? 'secondary' : 'none');

  let loadedKey = '';
  let lastRefresh = 0;
  $effect(() => {
    const key = `${workspaceId}/${members.map((m) => m.id).join(',')}`;
    const again = refreshKey;
    const list = members.map((m) => m.id);
    untrack(() => {
      // A finished sync reads again; opening the page or changing the scope reuses what was read a moment ago.
      const force = key === loadedKey && again !== lastRefresh;
      loadedKey = key;
      lastRefresh = again;
      if (can(role, 'apps.read')) for (const id of list) void pipelineStore.loadApp(api, workspaceId, id, force);
    });
  });
</script>

<section class="card next" data-tone={step.tone} data-testid="next-step" aria-labelledby="{uid}-title">
  <p class="eyebrow">Next step</p>
  <div class="main">
    <div class="text">
      <h2 id="{uid}-title">
        {step.title}
        {#if step.waiting}<Badge tone={step.waiting.who === 'you' ? 'warn' : 'neutral'}>{step.waiting.text}</Badge>{/if}
      </h2>
      {#if step.text !== ''}<p class="muted">{step.text}</p>{/if}
    </div>
    <div class="actions">
      {#if step.primary && 'href' in step.primary}
        <Button variant="primary" icon="arrow-right" href={step.primary.href}>{step.primary.label}</Button>
      {:else if preparesHere && step.primary}
        {#if onprepare}
          <Button variant="primary" icon="play" onclick={onprepare}>{step.primary.label}</Button>
        {:else}
          <Button variant="primary" icon="play" href={prepareHref}>{step.primary.label}</Button>
        {/if}
      {/if}
      <StartRelease
        bind:this={start}
        {api}
        {workspaceId}
        {role}
        {members}
        {all}
        scopeIsBoth={members.length > 1}
        {showRunning}
        button={startButton}
        showPrepare={startsHere}
        {onstarted}
      />
      {#if onprepare && step.kind === 'start'}
        <Button variant="ghost" onclick={onprepare} title="Choose a build the store already has, write the notes and send it, without running CI.">Prepare without CI</Button>
      {/if}
    </div>
  </div>

  {#if step.train}
    <div class="steps"><TrainSteps steps={step.train.steps} /></div>
  {/if}

  {#if step.otherTrains.length > 0}
    <ul class="others" aria-label="Other releases on their way">
      {#each step.otherTrains as o (o.title)}
        <li><strong>{o.title}</strong> <span class="muted">{o.text}</span> <a href={o.href}>{o.label}</a></li>
      {/each}
    </ul>
  {/if}

  {#if step.items.length > 0}
    <div class="more"><AttentionList bare items={step.items} {api} {workspaceId} {role} {members} /></div>
  {/if}
</section>

<style>
  .next {
    padding: var(--space-4);
    border-left: 3px solid var(--line-strong);
  }

  .next[data-tone='bad'] {
    border-left-color: var(--bad);
  }

  .next[data-tone='warn'] {
    border-left-color: var(--warn);
  }

  .next[data-tone='info'] {
    border-left-color: var(--info);
  }

  .eyebrow {
    margin: 0 0 var(--space-1);
  }

  .main {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-4);
    align-items: center;
    justify-content: space-between;
  }

  .text {
    flex: 1;
    min-width: min(100%, 18rem);
  }

  h2 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-lg);
  }

  .text p {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  /* The follow-up of a started run (and its problem line) goes on its own line under the buttons. */
  .actions :global(.start) {
    display: contents;
  }

  .actions :global(.start > :not(.head)) {
    flex: 1 0 100%;
  }

  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    margin-top: var(--space-3);
    font-size: var(--text-sm);
  }

  .others {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0;
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    list-style: none;
  }

  .more {
    margin-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
</style>
