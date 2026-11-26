<!--
  NextStep: the one card at the top of the Overview and of Releases ("Your next step"; docs/design/mockups/app-overview.dc.html). It says what is
  true about the app and offers ONE primary button, and it says nothing it works out itself: every word and every button comes from the state
  model (docs/state-model.md, `appStateStore.of`), the same answer the top bar, the pending panels and the release buttons read.
  By priority: a publish that runs (progress and "Show pending changes"), a publish that failed (headline "The last publish failed", the
  reason, "Show pending changes" and "Publish again"; Promote and the release buttons stay off with the reason), changes waiting ("N changes
  waiting", "Review and publish"), then the release flow (the release that waits for you, for the store, for CI, or "Start release").
  "Nothing is waiting for you" is only ever said by the model when nothing is pending, nothing failed and nothing runs.
  The five steps of the release on its way sit in the card; the other releases on their way are one quiet line each; the rest of "Needs
  attention" goes to the screen (`onitems`, drawn as "Also worth a look") or is listed under the card. It reads the release pipelines
  through the state store and writes nothing: "Start release" only opens its dialog (StartRelease), whose confirmation is the one action.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dispatch dialog and the state), scope (platform
  scope for links), releases? (store releases by app id, for Promote), attention? (items of "Needs attention"; default none), refreshKey
  (changes when the screen synced), onprepare? (open the release steps in place, on Releases; without it the card links to them), showRunning
  = false (draw the run "Start release" started under the card; the Overview draws its own list), onstarted? (the run "Start release" started),
  onitems? (hands the rest of "Needs attention" to the screen).
  Exports: observe(data) takes a RunningNow answer, so the screen's own feed is read once.
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { can, platformLabel, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { AttentionItem } from '../../lib/app-attention.ts';
  import { appAddress, type PlatformScope } from '../../lib/app-scope.ts';
  import { requestPublishAgain } from '../../lib/app-state/actions.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { scopeFor } from '../../lib/app-state/derive.ts';
  import { openPendingPanel } from '../../lib/app-state/panel.svelte.ts';
  import type { ActionOffer } from '../../lib/app-state/types.ts';
  import { releaseStepHref } from '../../lib/release-stepper.ts';
  import type { StartedRun } from '../../lib/start-release.ts';
  import type { ActiveRuns, AppSummary, ReleaseSummary } from '../../lib/types.ts';
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
    onitems?: ((items: AttentionItem[]) => void) | undefined;
  } = $props();

  const uid = $props.id();
  let start = $state<{ observe: (data: ActiveRuns) => void }>();
  export function observe(data: ActiveRuns) {
    start?.observe(data);
  }

  // The card follows the platform switch: the state is derived for the records the page shows (one platform, or every record with Both).
  // The pipelines of every record are still read so a switch to the other platform has them at once.
  const records = $derived(all ?? members);
  const stateScope = $derived(scopeFor(records, members));
  const appState = $derived(appStateStore.of({ workspaceId, role, records, scope: stateScope, releases, attention }));
  const primary = $derived(appState.primaryAction);
  const startOffer = $derived([primary, ...appState.secondaryActions].find((a) => a.action === 'start_release') ?? null);
  const startButton = $derived<'primary' | 'secondary' | 'none'>(startOffer === null ? 'none' : startOffer === primary ? 'primary' : 'secondary');
  const prepareHref = $derived(members[0] ? releaseStepHref(members[0].id, scope, 'build') : '');
  const kind = $derived(appState.phase === 'publishing' ? 'publishing' : appState.phase === 'publish_failed' ? 'failed' : 'pending');
  const elsewhereNames = $derived(formatList(appState.elsewhere.platforms.map((p) => platformLabel(p))));
  const elsewhereHref = $derived(appAddress(records[0]?.id ?? '', 'pending', appState.elsewhere.platforms[0] ?? null));

  /** An offer that opens a panel or a dialog rather than a page. */
  function press(offer: ActionOffer) {
    if (offer.action === 'show_pending') openPendingPanel(kind, offer.appId ?? '', stateScope);
    else if (offer.action === 'publish_again' && offer.appId !== null) requestPublishAgain(offer.appId);
    else if (offer.action === 'prepare_release') onprepare?.();
  }
  const opensPanel = (offer: ActionOffer) =>
    offer.action === 'show_pending' || offer.action === 'publish_again' || (offer.action === 'prepare_release' && offer.href === null && onprepare !== undefined);

  $effect(() => {
    const rest = appState.rest;
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
      if (can(role, 'apps.read')) appStateStore.loadPipelines(api, workspaceId, list, force);
    });
  });
</script>

{#snippet offerButton(offer: ActionOffer, variant: 'primary' | 'secondary', size: 'md' | 'lg')}
  {#if offer.action === 'start_release'}
    <!-- drawn by StartRelease below (it owns the dialog) -->
  {:else if opensPanel(offer)}
    <Button {variant} {size} icon={offer.action === 'publish_again' ? 'upload' : 'arrow-right'} disabled={!offer.enabled} title={offer.disabledReason ?? undefined} onclick={() => press(offer)} data-action={offer.action}>{offer.label}</Button>
  {:else if offer.href === null}
    <Button {variant} {size} icon="play" disabled={!offer.enabled} title={offer.disabledReason ?? undefined} href={offer.enabled ? prepareHref : undefined} data-action={offer.action}>{offer.label}</Button>
  {:else if !offer.enabled}
    <Button {variant} {size} icon="arrow-right" disabled title={offer.disabledReason ?? undefined} data-action={offer.action}>{offer.label}</Button>
  {:else}
    <Button {variant} {size} icon={offer.external ? 'external-link' : 'arrow-right'} href={offer.href} target={offer.external ? '_blank' : undefined} data-action={offer.action}>{offer.label}</Button>
  {/if}
{/snippet}

<section class="card next" data-tone={appState.tone} data-phase={appState.phase} data-testid="next-step" aria-labelledby="{uid}-title">
  <p class="eyebrow">{t('app:nextStep.eyebrow')}</p>
  <div class="main">
    <div class="text">
      <h2 id="{uid}-title" data-testid="next-step-headline">
        {#if appState.flow?.step.train}{#each appState.flow.step.train.platforms as p (p)}<PlatformBadge platform={p} showLabel={false} />{/each}{/if}
        {appState.headline}
        {#if appState.flow?.step.waiting}<Badge tone={appState.flow.step.waiting.who === 'you' ? 'warn' : 'neutral'}>{appState.flow.step.waiting.text}</Badge>{/if}
      </h2>
      {#if appState.reason !== ''}<p class="muted" data-testid="next-step-reason">{appState.reason}</p>{/if}
      {#if appState.flow && appState.flow.rows.length > 0}<p class="muted">{t('app:nextStep.eachStore')}</p>{/if}
    </div>
    <div class="actions">
      {#if primary.action !== 'none'}
        {@render offerButton(primary, 'primary', 'lg')}
        {#if !primary.enabled && primary.disabledReason}<span class="why muted" data-testid="next-step-why">{primary.disabledReason}</span>{/if}
      {/if}
      {#each appState.secondaryActions as offer (offer.action)}
        {@render offerButton(offer, 'secondary', 'md')}
        {#if !offer.enabled && offer.disabledReason}<span class="why muted">{offer.disabledReason}</span>{/if}
      {/each}
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
        showPrepare={startOffer !== null}
        blockedReason={startOffer !== null && !startOffer.enabled ? startOffer.disabledReason : null}
        {onstarted}
      />
      {#if onprepare && primary.action === 'start_release'}
        <Button variant="ghost" disabled={!appState.verdicts.prepare_release.enabled} onclick={onprepare} title={appState.verdicts.prepare_release.reason ?? t('app:nextStep.withoutCiHint')}>{t('app:nextStep.withoutCi')}</Button>
      {/if}
    </div>
  </div>

  {#if appState.elsewhere.pendingCount > 0 || appState.elsewhere.failed || appState.elsewhere.publishing}
    <!-- what is going on in the platforms this page does not show: said once, with a link, never as the card's own state -->
    <p class="elsewhere muted" data-testid="next-step-elsewhere">
      {#if appState.elsewhere.publishing}{t('state:elsewhere.publishing', { platforms: elsewhereNames })}{:else if appState.elsewhere.failed}{t('state:elsewhere.failed', { platforms: elsewhereNames })}{:else}{t('state:elsewhere.pending', { count: appState.elsewhere.pendingCount, platforms: elsewhereNames })}{/if}
      <a href={elsewhereHref}>{t('publish:publishing.showPending')}</a>
    </p>
  {/if}

  {#if appState.flow && appState.flow.rows.length > 0}
    <ul class="rows" aria-label={t('app:nextStep.onTheirWay')} data-testid="next-step-rows">
      {#each appState.flow.rows as r (r.key)}
        <li class="row" data-tone={r.tone} data-testid="next-step-row">
          <span class="who">{#each r.platforms as p (p)}<PlatformBadge platform={p} />{/each}</span>
          <span class="what">
            <span>{r.text}</span>
            {#if r.waiting}<Badge tone={r.waiting.who === 'you' ? 'warn' : 'neutral'}>{r.waiting.text}</Badge>{/if}
          </span>
          {@render offerButton(r.offer, r.urgent ? 'primary' : 'secondary', 'md')}
        </li>
      {/each}
    </ul>
  {/if}

  {#if appState.flow?.step.train}
    <div class="steps"><TrainSteps steps={appState.flow.step.train.steps} /></div>
  {/if}

  {#if appState.promotion}
    {@const promotion = appState.promotion}
    <p class="promote" data-testid="next-step-promote">
      <span><T key="app:nextStep.promotion" params={{ count: promotion.option.codes.length, version: promotion.option.version, track: promotion.option.fromLabel, codes: formatList(promotion.option.codes) }} /></span>
      {#if promotion.offer.enabled}
        <Button size="sm" icon="arrow-right" href={promotion.offer.href ?? undefined} data-action="promote">{promotion.offer.label}</Button>
      {:else}
        <!-- off while a publish runs or has failed: the reason is said next to the button, not only in a tooltip -->
        <Button size="sm" icon="arrow-right" disabled title={promotion.offer.disabledReason ?? undefined} data-action="promote">{promotion.offer.label}</Button>
        <span class="why muted" data-testid="next-step-promote-why">{promotion.offer.disabledReason}</span>
      {/if}
    </p>
  {/if}

  {#if appState.flow && appState.flow.others.length > 0}
    <ul class="others" aria-label={t('app:nextStep.otherOnTheirWay')}>
      {#each appState.flow.others as o (o.title)}
        <li>
          <strong>{o.title}</strong> <span class="muted">{o.text}</span>
          {#if o.offer.enabled && o.offer.href}
            <a href={o.offer.href} target={o.offer.external ? '_blank' : undefined} rel={o.offer.external ? 'noopener noreferrer' : undefined}>{o.offer.label}</a>
          {:else}
            <span class="muted" title={o.offer.disabledReason ?? undefined}>{o.offer.label}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if appState.rest.length > 0 && !onitems}
    <div class="more"><AttentionList bare items={appState.rest} {api} {workspaceId} {role} {members} /></div>
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

  .why {
    font-size: var(--text-sm);
  }

  .elsewhere {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
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

  /* One big primary button, the quieter ones under it, in one column. */
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
