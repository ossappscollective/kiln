<!--
  NextStep: the one card at the top of the Overview and of Releases ("Your next step"; docs/design/mockups/app-overview.dc.html). It says what to do next and offers ONE primary button for it,
  chosen from the state (lib/next-step.ts): the release that waits for you (rejected, approved, a build to attach, unfinished), the
  release that waits for the store, or, with nothing on its way, "Start release". The five steps of the release on its way sit in the
  card; the other releases on their way are one quiet line each; with `attention` (the Overview) the rest of "Needs attention" is
  listed under it, so nothing is said twice. It reads the release pipeline of our own database and writes nothing:
  "Start release" only opens its dialog (StartRelease), whose confirmation is the one action.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog), scope (platform scope
  for links), releases? (store releases by app id: with them a Google Play release in a non-production track offers "Promote to
  production"), attention? (items of "Needs attention"; default none), refreshKey (changes when the screen synced), onprepare? (open
  the release steps in place, on Releases; without it the card links to them; with it, "Prepare without CI" is offered beside
  "Start release"), showRunning = false (draw the run "Start release" started under the card; the Overview draws its own list),
  onstarted? (the run "Start release" started).
  `pending` (the Overview) is the changes waiting as one quiet link under the button ("2 changes waiting. Review and publish"); `onitems`
  hands the rest of "Needs attention" to the screen, which draws it as its own "Also worth a look" card (without it the list sits in this card).
  Exports: observe(data) takes a RunningNow answer, so the screen's own feed is read once.
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { can, type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { AttentionItem } from '../../lib/app-attention.ts';
  import type { PlatformScope } from '../../lib/app-scope.ts';
  import { chooseNextStep, nextStepTrains } from '../../lib/next-step.ts';
  import { pipelineStore } from '../../lib/pipeline-store.svelte.ts';
  import { publishingStore } from '../../lib/publishing-store.svelte.ts';
  import { promoteHref, promoteOptions } from '../../lib/play-promote.ts';
  import { reviewUrl } from '../../lib/store-links.ts';
  import { releaseStepHref } from '../../lib/release-stepper.ts';
  import type { StartedRun } from '../../lib/start-release.ts';
  import type { ActiveRuns, AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import PublishingNote from '../publish/PublishingNote.svelte';
  import TrainSteps from '../release/TrainSteps.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
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
    releases,
    refreshKey = 0,
    showRunning = false,
    onprepare,
    onstarted,
    pending = null,
    onitems,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[] | undefined;
    scope: PlatformScope | null;
    attention?: AttentionItem[] | undefined;
    releases?: Record<string, ReleaseSummary[]> | undefined;
    refreshKey?: number | undefined;
    showRunning?: boolean | undefined;
    onprepare?: (() => void) | undefined;
    onstarted?: ((started: StartedRun | null) => void) | undefined;
    pending?: { text: string; href: string } | null | undefined;
    onitems?: ((items: AttentionItem[]) => void) | undefined;
  } = $props();

  const uid = $props.id();
  let start = $state<{ observe: (data: ActiveRuns) => void }>();
  export function observe(data: ActiveRuns) {
    start?.observe(data);
  }

  // The card is about the whole app: the releases of every record (iOS, macOS, Android), whatever platform the page is scoped to.
  const records = $derived(all ?? members);
  const trains = $derived(
    nextStepTrains(records.map((m) => pipelineStore.app(m.id)).filter((d): d is NonNullable<typeof d> => d !== null)),
  );
  const reviewUrlOf = (appId: string) => {
    const record = records.find((m) => m.id === appId);
    return record ? reviewUrl(record) : null;
  };
  const canStart = $derived(can(role, 'ci.dispatch') && can(role, 'repositories.read') && members.some((m) => m.repositoryId !== null));
  const canPrepare = $derived(can(role, 'listing.read') && members.length > 0);
  const step = $derived(chooseNextStep({ trains, attention, scope, canStart, canPrepare, reviewUrlOf }));
  // A Google Play release that sits in internal, closed or open testing can be promoted: one quiet line with its own button.
  const promotion = $derived.by(() => {
    if (!canPrepare || !releases) return null;
    for (const m of members) {
      if (!supports(m.platform, 'releaseTracks')) continue;
      const option = promoteOptions(releases[m.id] ?? [])[0];
      if (option) return option;
    }
    return null;
  });
  const prepareHref = $derived(members[0] ? releaseStepHref(members[0].id, scope, 'build') : '');
  const startsHere = $derived(step.primary !== null && 'action' in step.primary && step.primary.action === 'start-release');
  const preparesHere = $derived(step.primary !== null && 'action' in step.primary && step.primary.action === 'prepare-release');
  // "Start release" is offered as the primary action only, when nothing is in flight; beside a release in flight it is not on the card.
  const startButton = $derived<'primary' | 'none'>(startsHere ? 'primary' : 'none');

  $effect(() => {
    const rest = step.items;
    if (onitems) untrack(() => onitems(rest));
  });

  let loadedKey = '';
  let lastRefresh = 0;
  $effect(() => {
    const key = `${workspaceId}/${records.map((m) => m.id).join(',')}`;
    const again = refreshKey;
    const list = records.map((m) => m.id);
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
  <p class="eyebrow">{t('app:nextStep.eyebrow')}</p>
  <div class="main">
    <div class="text">
      <h2 id="{uid}-title">
        {#if step.train}{#each step.train.platforms as p (p)}<PlatformBadge platform={p} showLabel={false} />{/each}{/if}
        {step.title}
        {#if step.waiting}<Badge tone={step.waiting.who === 'you' ? 'warn' : 'neutral'}>{step.waiting.text}</Badge>{/if}
      </h2>
      {#if step.text !== ''}<p class="muted">{step.text}</p>{/if}
      {#if step.rows.length > 0}<p class="muted">{t('app:nextStep.eachStore')}</p>{/if}
    </div>
    <div class="actions">
      {#if step.primary && 'href' in step.primary}
        <Button variant="primary" size="lg" icon={step.primary.external ? 'external-link' : 'arrow-right'} href={step.primary.href} target={step.primary.external ? '_blank' : undefined}>{step.primary.label}</Button>
      {:else if preparesHere && step.primary}
        {#if onprepare}
          <Button variant="primary" size="lg" icon="play" onclick={onprepare}>{step.primary.label}</Button>
        {:else}
          <Button variant="primary" size="lg" icon="play" href={prepareHref}>{step.primary.label}</Button>
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
        <Button variant="ghost" onclick={onprepare} title={t('app:nextStep.withoutCiHint')}>{t('app:nextStep.withoutCi')}</Button>
      {/if}
      {#if pending}
        <a class="pending-link" href={pending.href} data-testid="next-step-pending">{pending.text}</a>
      {/if}
    </div>
  </div>

  {#if step.rows.length > 0}
    <ul class="rows" aria-label={t('app:nextStep.onTheirWay')} data-testid="next-step-rows">
      {#each step.rows as r (r.key)}
        <li class="row" data-tone={r.tone} data-testid="next-step-row">
          <span class="who">{#each r.platforms as p (p)}<PlatformBadge platform={p} />{/each}</span>
          <span class="what">
            <span>{r.text}</span>
            {#if r.waiting}<Badge tone={r.waiting.who === 'you' ? 'warn' : 'neutral'}>{r.waiting.text}</Badge>{/if}
          </span>
          <Button variant={r.urgent ? 'primary' : 'secondary'} icon={r.external ? 'external-link' : 'arrow-right'} href={r.href} target={r.external ? '_blank' : undefined}>{r.label}</Button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if step.train}
    <div class="steps"><TrainSteps steps={step.train.steps} /></div>
  {/if}

  {#if promotion}
    <p class="promote" data-testid="next-step-promote">
      <span><T key="app:nextStep.promotion" params={{ count: promotion.codes.length, version: promotion.version, track: promotion.fromLabel, codes: formatList(promotion.codes) }} /></span>
      {#if publishingStore.isPublishing(workspaceId, promotion.appId)}
        <!-- a publish of this app is running: promoting now would race it -->
        <Button size="sm" icon="arrow-right" disabled title={publishingStore.reason(workspaceId, promotion.appId)}>{promotion.label}</Button>
      {:else}
        <Button size="sm" icon="arrow-right" href={promoteHref(promotion)}>{promotion.label}</Button>
      {/if}
    </p>
    <PublishingNote {workspaceId} appId={promotion.appId} platform={scope} />
  {/if}

  {#if step.otherTrains.length > 0}
    <ul class="others" aria-label={t('app:nextStep.otherOnTheirWay')}>
      {#each step.otherTrains as o (o.title)}
        <li><strong>{o.title}</strong> <span class="muted">{o.text}</span> <a href={o.href} target={o.external ? '_blank' : undefined} rel={o.external ? 'noopener noreferrer' : undefined}>{o.label}</a></li>
      {/each}
    </ul>
  {/if}

  {#if step.items.length > 0 && !onitems}
    <div class="more"><AttentionList bare items={step.items} {api} {workspaceId} {role} {members} /></div>
  {/if}
</section>

<style>
  .next {
    padding: var(--space-6) var(--space-8);
    border-left: 4px solid var(--line-strong);
    border-radius: var(--radius-xl);
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

  .promote {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    margin: var(--space-4) 0 0;
    font-size: var(--text-base);
  }

  .eyebrow {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .main {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-8);
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
    gap: var(--space-2) var(--space-3);
    align-items: center;
    margin: 0;
    font-size: var(--text-3xl);
    line-height: 1.15;
  }

  .text p {
    max-width: 60ch;
    margin: var(--space-2) 0 0;
    font-size: 1.0625rem;
    line-height: 1.4;
  }

  /* One big primary button, the quieter ones and the pending link under it, in one column. */
  .actions {
    display: flex;
    flex: 0 0 15.5rem;
    flex-direction: column;
    gap: var(--space-2);
    align-items: stretch;
    min-width: min(100%, 15.5rem);
  }

  .actions :global(.btn.lg),
  .actions :global(button.lg),
  .actions :global(a.lg) {
    justify-content: center;
  }

  .pending-link {
    font-size: var(--text-base);
    text-align: center;
  }

  /* The follow-up of a started run (and its problem line) goes on its own line under the buttons. */
  .actions :global(.start) {
    display: contents;
  }

  .actions :global(.start > .head) {
    flex-direction: column;
    align-items: stretch;
  }

  .actions :global(.start > :not(.head)) {
    flex: 1 0 100%;
  }

  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    margin-top: var(--space-4);
    font-size: var(--text-base);
  }

  .others {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0;
    margin: var(--space-4) 0 0;
    font-size: var(--text-base);
    list-style: none;
  }

  .rows {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: var(--space-4) 0 0;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) auto;
    gap: var(--space-3) var(--space-4);
    align-items: center;
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-base);
  }

  .what {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  @media (max-width: 640px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .more {
    margin-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  @media (max-width: 640px) {
    .next {
      padding: var(--space-4);
    }

    h2 {
      font-size: var(--text-2xl);
    }

    .actions {
      flex-basis: 100%;
    }
  }
</style>
