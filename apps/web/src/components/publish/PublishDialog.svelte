<!--
  PublishDialog: "Review and publish all" for ONE app record at a time (the platforms in scope are tabs). It asks the server for the plan
  (`POST .../publish/preview`: reads the store through each step's own preview, writes nothing), shows the steps in the order they run
  with each one's availability, summary and diff (the same renderers as the single confirmations), warnings, and a ticked box per step
  (a step that cannot run is disabled with the reason). When the plan has a confirmation the ONE phrase is typed here, exactly as the
  server gave it; a push alone needs an acknowledgement instead. Publishing (`POST .../publish`) is sent once with the plan's hash, the
  steps and the phrase, and is never retried. The answer lists every step as done, not run or failed in fixed words (a store's own text
  is never shown); a plan that changed, a step that drifted or a state that changed offer "Review again", which only previews.
  Ticking or unticking a step previews again (a new plan, a new hash, a new phrase): nothing carries over from the old one.
  Props: open (bindable), api, workspaceId, targets (the app records that have something to publish), onchanged (called after a
  publish answered and when the dialog closes after one, so the screens read what they show again).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type PlanStep,
    type PublishFailure,
    type PublishPlan,
    type PublishResult,
    type PublishStepType,
    STEP_NAME,
    STOP_NOTE,
    asPushPreview,
    asReleasePreview,
    asRolloutPreview,
    asSubmitPreview,
    canPublish,
    classifyPublishFailure,
    draftOnlySteps,
    errorsOf,
    includedTypes,
    isDirectPlan,
    needsReview,
    planReady,
    previewBody,
    promiseText,
    publishBody,
    askedFractionOf,
    releaseInputDefaults,
    releaseStepRequest,
    requestsFor,
    resultSummary,
    stepRows,
    visibleRows,
    toggled,
    warningsOf,
  } from '../../lib/pending.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { EVERYONE, releaseInputsFor } from '../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../lib/release-settings-store.svelte.ts';
  import { storeName } from '../../lib/staged.ts';
  import { parsePercent } from '../../lib/store-release.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Modal from '../ui/Modal.svelte';
  import SegmentTabs from '../ui/SegmentTabs.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import PushPreviewBody from './PushPreviewBody.svelte';
  import ReleasePreviewBody from './ReleasePreviewBody.svelte';
  import RolloutPreviewBody from './RolloutPreviewBody.svelte';
  import SubmitPreviewBody from './SubmitPreviewBody.svelte';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    targets,
    onchanged,
  }: {
    open?: boolean;
    api: Api;
    workspaceId: string;
    targets: AppSummary[];
    onchanged: () => void;
  } = $props();

  const uid = $props.id();

  let currentId = $state(untrack(() => targets[0]?.id ?? ''));
  let tab = $state(untrack(() => targets[0]?.id ?? ''));
  const app = $derived(targets.find((t) => t.id === currentId) ?? targets[0]);

  type Phase = 'previewing' | 'ready' | 'publishing' | 'done' | 'error';
  let phase = $state<Phase>('previewing');
  let plan = $state<PublishPlan | null>(null);
  let wanted = $state<PublishStepType[]>([]);
  let result = $state<PublishResult | null>(null);
  let problem = $state('');
  let notice = $state('');
  /** The plan on screen is not the one the server would build now: only "Review again" is possible. */
  let stale = $state(false);
  let typed = $state('');
  let ack = $state(false);
  let track = $state('production');
  let share = $state('');
  let shareError = $state('');
  /** Google Play: the plan releases the staged fields in one step (the server made it so, or the person added it so). */
  let direct = $state(false);
  let changed = false;
  let seq = 0;

  const busy = $derived(phase === 'previewing' || phase === 'publishing');
  const visible = $derived(plan ? visibleRows(stepRows(plan)) : { shown: [], left: [] });
  const rows = $derived(visible.shown);
  const summary = $derived(result ? resultSummary(result, askedFractionOf(plan)) : null);
  // Google Play offers a staged rollout for updates only: no share is asked for the first release in production, or when the app setting says never.
  const inputs = $derived(releaseInputsFor({ view: app ? releaseSettingsStore.get(app.id) : null, track, stagedPercent: '' }));
  const offered = $derived(inputs.offer.offered);
  const stepOf = (type: PublishStepType): PlanStep | undefined => plan?.steps.filter((s) => s.type === type)[0];
  const ready = $derived(phase === 'ready' && !stale && canPublish(plan, wanted, typed, ack));
  const store = $derived(app ? storeName(app.platform) : 'the store');
  const phraseId = `${uid}-phrase`;

  /** Scrolls to the confirmation under the plan and puts the cursor in it (the Publish button stays off until it is done). */
  function focusConfirm() {
    const el = document.getElementById(phraseId);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return;
    }
    const box = document.querySelector<HTMLElement>('[data-testid="plan-confirm-ack"]');
    box?.scrollIntoView({ block: 'center' });
    box?.focus();
  }

  function reset() {
    seq++;
    plan = null;
    wanted = [];
    result = null;
    problem = '';
    notice = '';
    stale = false;
    typed = '';
    ack = false;
    shareError = '';
  }

  function failWith(failure: PublishFailure) {
    if (failure.kind === 'disabled') pendingStore.markDisabled(workspaceId);
    problem = failure.message;
    stale = stale || needsReview(failure);
  }

  /** Asks for the plan. `steps` null: the server includes every step that is available and has work. Writes nothing. */
  async function review(steps: PublishPlan['publishSteps'] | null, why = '') {
    if (!app || phase === 'publishing') return;
    const mine = ++seq;
    phase = 'previewing';
    problem = '';
    notice = why;
    stale = false;
    try {
      const out = await api.previewPublish(workspaceId, app.id, previewBody(steps));
      if (mine !== seq) return;
      // A first plan (the dialog opened or the platform changed) starts the inputs from what is staged; later plans keep what was typed.
      if (plan === null) {
        const start = releaseInputDefaults(out.plan);
        track = start.track;
        // The default share of the app is read (our database) so the share starts from the staged one, else that default.
        if (out.plan.app.platform === 'android') await releaseSettingsStore.load(api, workspaceId, out.plan.app.id);
        if (mine !== seq) return;
        share = releaseInputsFor({ view: releaseSettingsStore.get(out.plan.app.id), track, stagedPercent: start.sharePercent }).share;
      }
      plan = out.plan;
      direct = isDirectPlan(out.plan);
      wanted = includedTypes(out.plan);
      result = null;
      typed = '';
      ack = false;
      phase = 'ready';
    } catch (e) {
      if (mine !== seq) return;
      failWith(classifyPublishFailure(e, pendingStore.config(workspaceId)));
      phase = plan ? 'ready' : 'error';
    }
  }

  function toggle(type: PublishStepType, on: boolean) {
    if (!plan || busy) return;
    const next = toggled(wanted, type, on);
    wanted = next;
    if (next.length === 0) return;
    void review(requestsFor(plan, next), 'The plan was made again for the steps you chose.');
  }

  function addRelease() {
    if (!plan || busy) return;
    const fraction = offered ? parsePercent(share) : EVERYONE;
    if (track.trim() === '') {
      shareError = 'Name the track.';
      return;
    }
    if (fraction === null) {
      shareError = 'Type the share as a percent above 0 and up to 100, for example 10 or 2.5.';
      return;
    }
    shareError = '';
    void review(requestsFor(plan, toggled(wanted, 'release', true), { release: releaseStepRequest({ track, fraction, direct }) }), 'The plan was made again with the release.');
  }

  /** "Save as a draft only": the push alone. Nothing is submitted or released by it. */
  function saveAsDraftOnly() {
    if (!plan || busy) return;
    void review(draftOnlySteps(), 'The plan was made again as a draft only: nothing is sent to review or released.');
  }

  /** Back to the default plan (the direct release when only release fields are staged). */
  function backToDirect() {
    if (busy) return;
    void review(null);
  }

  const pushStep = $derived(plan ? stepOf('push_draft') : undefined);
  const canDraftOnly = $derived(direct && pushStep !== undefined && pushStep.requires.enabled && pushStep.requires.allowed);
  const offersDirect = $derived(plan !== null && !direct && (plan.direct ?? null) !== null && plan.included === 1 && wanted.length === 1 && wanted[0] === 'push_draft');

  async function publish() {
    if (!plan || !ready) return;
    const sent = plan;
    const mine = ++seq;
    phase = 'publishing';
    problem = '';
    try {
      // The only call that writes. Sent once, with the plan's hash, its steps and the phrase; never sent again by this app.
      const publishPayload = publishBody(sent, typed);
      const out = await confirmed((grant) => api.publishPending(workspaceId, sent.app.id, publishPayload, grant), publishPayload.planHash);
      if (mine !== seq) return;
      result = out.result;
      changed = true;
      phase = 'done';
      onchanged();
    } catch (e) {
      if (mine !== seq) return;
      failWith(classifyPublishFailure(e, pendingStore.config(workspaceId)));
      phase = 'ready';
    }
  }

  function close() {
    seq++;
    open = false;
  }

  function closed() {
    seq++;
    if (changed) onchanged();
    changed = false;
  }

  // The plan is made when the dialog opens, and again when the person switches to another platform.
  let started = false;
  $effect(() => {
    if (!open || started) return;
    started = true;
    untrack(() => void review(null));
  });

  $effect(() => {
    const next = tab;
    untrack(() => {
      if (next === currentId) return;
      if (busy) {
        tab = currentId;
        return;
      }
      currentId = next;
      reset();
      void review(null);
    });
  });
</script>

{#snippet details(step: PlanStep)}
  {@const push = asPushPreview(step.preview)}
  {@const submit = asSubmitPreview(step.preview)}
  {@const release = asReleasePreview(step.preview)}
  {@const rollout = asRolloutPreview(step.preview)}
  {#if step.type === 'push_draft' && push}
    <PushPreviewBody preview={push} />
  {:else if step.type === 'submit' && submit}
    <SubmitPreviewBody preview={submit} />
  {:else if step.type === 'release' && release}
    <ReleasePreviewBody preview={release} />
  {:else if step.type === 'rollout' && rollout}
    <RolloutPreviewBody preview={rollout} />
  {/if}
{/snippet}

{#snippet pending()}
  <div class="stack" role="status" aria-label="Making the plan">
    <Skeleton width="70%" height="16px" />
    <Skeleton width="90%" height="48px" />
    <Skeleton width="60%" height="16px" />
  </div>
{/snippet}

<Modal
  bind:open
  size="lg"
  title="Review and publish all: confirm"
  description={app ? `${app.name} · ${platformLabel(app.platform)}` : ''}
  dismissible={phase !== 'publishing'}
  onclose={closed}
>
  <div class="stack">
    {#if targets.length > 1}
      <div class="row tabs">
        <SegmentTabs tabs={targets.map((t) => ({ id: t.id, label: platformLabel(t.platform) }))} bind:value={tab} label="Platform" idPrefix="{uid}-plat" />
      </div>
    {/if}

    {#if phase === 'done' && summary && result}
      <section class="stack" aria-label="Result" data-testid="publish-result">
        <Alert tone={summary.tone} title={summary.title}>
          {summary.text}
          {#if !result.completed}<span class="para">{STOP_NOTE}</span>{/if}
        </Alert>
        <ol class="results">
          {#each summary.rows as r (r.type)}
            <li class="result">
              <p class="step-head">
                <strong>{r.label}</strong>
                <Badge tone={r.tone} icon={r.status === 'applied' ? 'check-circle' : r.status === 'failed' ? 'x-circle' : 'clock'}>{r.word}</Badge>
              </p>
              <p class="small">{r.text}</p>
            </li>
          {/each}
        </ol>
        {#if summary.review}
          <p class="muted small">Review again to see where things stand. That only reads the store; it changes nothing.</p>
        {/if}
      </section>
    {:else if phase === 'previewing' && !plan}
      {@render pending()}
    {:else if phase === 'error' && !plan}
      <Alert tone="error" title="No plan was made">{problem}</Alert>
    {:else if plan}
      {#if notice}<Alert tone="info">{notice}</Alert>{/if}

      <Alert tone="warn" title="This writes to {store}. The steps below run in order.">
        Each step keeps its own switch, role right and checks. The publish stops at the first step that does not finish, and nothing is retried
        by itself. It is recorded in the audit log.
      </Alert>

      {#if plan.irreversible}
        <Alert tone="error" title="Some of these steps cannot be undone from here">
          {plan.irreversibleSteps.map((t) => STEP_NAME[t]).join(', ')}. A review is cancelled, or a released version pulled, only in the store's own console.
        </Alert>
      {/if}

      {#if plan.warnings.length > 0}
        <Alert tone="warn" title="Read before you confirm">
          <ul class="plain">
            {#each plan.warnings as w (w)}<li>{w}</li>{/each}
          </ul>
        </Alert>
      {/if}

      <ol class="steps" aria-label="Steps, in the order they run" aria-busy={phase === 'previewing'}>
        {#each rows as row (row.type)}
          {@const step = stepOf(row.type)}
          {#if step}
            <li class="step" class:off={!wanted.includes(row.type)} data-testid="plan-step-{row.type}">
              <div class="step-head">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={wanted.includes(row.type)}
                    disabled={!row.toggleable || busy || stale || row.needsInput}
                    onchange={(e) => toggle(row.type, e.currentTarget.checked)}
                  />
                  <span><strong>{row.order}. {row.label}</strong></span>
                </label>
                <Badge tone={row.tone}>{row.word}</Badge>
                {#if row.irreversible}<Badge tone="warn" icon="alert-triangle">Cannot be undone</Badge>{/if}
                {#if row.deferred}<Badge tone="info" icon="clock">Checked again after the earlier steps</Badge>{/if}
              </div>
              {#if row.reason}<p class="reason muted">{row.reason}</p>{/if}

              {#if row.needsInput}
                {#if direct}
                  <p class="small" data-testid="direct-explainer">
                    This makes the release from what you staged (version codes, notes) and sends it to Google Play in one step. No draft is saved first.
                    Google reviews it before users get it, and it cannot be undone from here.{offered ? ' You name the share of users.' : ' It goes to everyone.'}
                  </p>
                {/if}
                <div class="inputs">
                  <div class="field">
                    <label for="{uid}-track">Track</label>
                    <input id="{uid}-track" type="text" autocomplete="off" spellcheck="false" bind:value={track} disabled={busy || stale} />
                  </div>
                  {#if offered}
                    <div class="field">
                      <label for="{uid}-share">Share of users (%)</label>
                      <input id="{uid}-share" type="text" inputmode="decimal" autocomplete="off" placeholder="10" bind:value={share} disabled={busy || stale} aria-invalid={shareError !== '' ? 'true' : undefined} />
                    </div>
                  {:else}
                    <p class="small muted" data-testid="no-staged-rollout">{inputs.offer.message}</p>
                  {/if}
                  <Button size="sm" disabled={busy || stale} onclick={addRelease}>Add the release step</Button>
                  {#if shareError}<p class="field-error">{shareError}</p>{/if}
                </div>
              {/if}

              {#each errorsOf(step) as p (p.code + p.message + (p.item ?? ''))}<p class="problem bad">{p.message}</p>{/each}
              {#each warningsOf(step) as p (p.code + p.message + (p.item ?? ''))}<p class="problem warn">{p.message}</p>{/each}

              {#if step.included && step.deferred}
                <p class="small">{promiseText(step)}</p>
              {/if}
              {#if step.included && step.irreversible && step.stepPhrase}
                <p class="small muted">Its own confirmation would be “{step.stepPhrase}”. The phrase you type below confirms it as part of this plan.</p>
              {/if}

              {#if step.included && !step.deferred}
                <div class="detail">{@render details(step)}</div>
              {:else if !step.included && step.preview}
                <Disclosure summary="Details of what the store says">
                  <div class="detail">{@render details(step)}</div>
                </Disclosure>
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
      {#if visible.left.length > 0}
        <p class="muted small" data-testid="plan-left-out">Not needed for this plan, so not shown: {visible.left.join('; ')}.</p>
      {/if}

      {#if canDraftOnly}
        <div class="row">
          <Button size="sm" disabled={busy || stale} onclick={saveAsDraftOnly}>Save as a draft only</Button>
          <span class="muted small">Writes the staged release to the Google Play draft. Nothing is sent to review or released.</span>
        </div>
      {:else if offersDirect}
        <div class="row">
          <Button size="sm" disabled={busy || stale} onclick={backToDirect}>Release to production directly instead</Button>
          <span class="muted small">One step: Google reviews it before users get it. No draft first.</span>
        </div>
      {/if}

      {#if !plan.confirmable}
        <Alert tone="error" title="This plan cannot be published as it is">
          {wanted.length === 0 ? 'Tick at least one step.' : 'A step you chose cannot run. Untick it, or fix what blocks it, then review again.'}
        </Alert>
      {:else if plan.confirmationRequired && plan.confirmation}
        <div class="field">
          <label for={phraseId}>Type <strong class="phrase">{plan.confirmation.phrase}</strong> to confirm</label>
          <p class="muted small">{plan.confirmation.instruction}</p>
          <input id={phraseId} type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} disabled={busy || stale} />
        </div>
      {:else}
        <label class="check">
          <input type="checkbox" bind:checked={ack} disabled={busy || stale} data-testid="plan-confirm-ack" />
          <span>I have read the plan above. I want it written to {store} now. Nothing is submitted or released by it.</span>
        </label>
      {/if}

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {#if phase === 'publishing'}
        <div role="status" class="running">
          <Alert tone="info" title="Publishing">
            The steps are running in order. This can take a few minutes. Keep this window open. Nothing is retried by itself.
          </Alert>
        </div>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    {#if phase === 'done'}
      {#if summary?.review}<Button icon="refresh" onclick={() => review(null)}>Review again</Button>{/if}
      <Button variant="primary" onclick={close}>Close</Button>
    {:else}
      {#if plan && phase === 'ready' && !stale && !ready && plan.confirmable}
        <button type="button" class="why-disabled" onclick={focusConfirm} data-testid="why-publish-disabled">
          {plan.confirmationRequired && plan.confirmation ? `Type "${plan.confirmation.phrase}" to publish` : 'Tick the box under the plan to publish'}
        </button>
      {/if}
      <Button disabled={phase === 'publishing'} onclick={close}>Cancel</Button>
      {#if stale || (phase === 'error' && !plan)}
        <Button icon="refresh" disabled={busy} onclick={() => review(null)}>Review again</Button>
      {/if}
      {#if plan}
        <Button variant="danger-solid" icon="upload" loading={phase === 'publishing'} disabled={!ready || busy} onclick={publish}>
          Publish {plan.included} {plan.included === 1 ? 'step' : 'steps'}
        </Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .why-disabled {
    margin-inline-end: auto;
    padding: 0;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--accent);
    text-align: start;
    text-decoration: underline;
    cursor: pointer;
    background: none;
    border: 0;
  }

  .tabs {
    justify-content: flex-start;
  }

  .steps,
  .results {
    display: grid;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .step,
  .result {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .step.off {
    background: var(--surface);
  }

  .step-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .reason,
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .para {
    display: block;
    margin-top: var(--space-1);
  }

  .plain {
    margin: 0;
    padding-left: var(--space-5);
  }

  .problem {
    margin: 0;
    font-size: var(--text-sm);
  }

  .problem.bad {
    color: var(--bad-ink);
  }

  .problem.warn {
    color: var(--warn-ink);
  }

  .inputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    align-items: end;
  }

  .detail {
    min-width: 0;
  }

  .phrase {
    overflow-wrap: anywhere;
  }
</style>
