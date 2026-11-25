<!--
  PublishDialog: "Review and publish all" for ONE app record at a time (the platforms in scope are tabs). It asks the server for the plan
  (`POST .../publish/preview`: reads the store through each step's own preview, writes nothing), shows the steps in the order they run
  with each one's availability, summary and diff (the same renderers as the single confirmations), warnings, and a ticked box per step
  (a step that cannot run is disabled with the reason). When the plan has a confirmation the ONE phrase is typed here, exactly as the
  server gave it; a push alone needs an acknowledgement instead. Publishing (`POST .../publish`) is sent once with the plan's hash, the
  steps and the phrase, and is never retried. The answer lists every step as done, not run or failed in fixed words (a store's own text
  is never shown); a plan that changed, a step that drifted or a state that changed offer "Review again", which only previews.
  Ticking or unticking a step previews again (a new plan, a new hash, a new phrase): nothing carries over from the old one.
  The title says what happens ("Release 2.9.0 to the App Store"). Each step is a card with its tick, its numbers and "Details of this step". The
  confirmation is ONE box: a single tick that says what cannot be undone (no typed phrase), or, when the plan requires one, the phrase field
  inside the same box. The footer says in one line why Publish is off (lib/readability.ts: publishTitle, publishDisabledReason).
  Props: open (bindable), api, workspaceId, targets (the app records that have something to publish), onchanged (called after a
  publish answered and when the dialog closes after one, so the screens read what they show again).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import {
    type PlanStep,
    type PublishFailure,
    type PublishPlan,
    type PublishResult,
    type PublishStepType,
    STEP_NAME,
    stopNote,
    asPushPreview,
    asReleasePreview,
    asRolloutPreview,
    asSubmitPreview,
    canPublish,
    classifyPublishFailure,
    draftOnlySteps,
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
  import { announcePublished } from '../../lib/app-page.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { publishSummary, shownErrors } from '../../lib/publish-summary.ts';
  import { foldWarnings, planHeadline, publishDisabledReason, publishTitle, shownStatusWord, stepGist } from '../../lib/readability.ts';
  import { EVERYONE, releaseInputsFor } from '../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../lib/release-settings-store.svelte.ts';
  import { storeName } from '../../lib/staged.ts';
  import { parsePercent, percentText } from '../../lib/store-release.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import SegmentTabs from '../ui/SegmentTabs.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import PublishSummaryBlock from './PublishSummary.svelte';
  import PushPreviewBody from './PushPreviewBody.svelte';
  import ReleasePreviewBody from './ReleasePreviewBody.svelte';
  import RolloutPreviewBody from './RolloutPreviewBody.svelte';
  import SubmitPreviewBody from './SubmitPreviewBody.svelte';
import { supports } from '@kiln/core';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    targets,
    steps = null,
    onchanged,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    targets: AppSummary[];
    /** The steps to plan for: null is the default plan (every step that is available and has work); a list keeps the plan to those (the cart drawer's partial selection). */
    steps?: PublishPlan['publishSteps'] | null | undefined;
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
  /** The person typed in the Track or Share fields (or pressed the button): only then is the prompt for them shown as a problem. */
  let inputTouched = $state(false);
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
  // The Track and Share fields while the release step is not added yet: the summary shows them live (never sent from here).
  const liveRelease = $derived(
    rows.some((r) => r.needsInput) ? { track, fraction: offered ? parsePercent(share) : EVERYONE } : null,
  );
  const whatSummary = $derived(
    plan ? publishSummary({ plan, wanted, identifier: app?.identifier ?? '', typed: liveRelease }) : null,
  );
  const stepOf = (type: PublishStepType): PlanStep | undefined => plan?.steps.filter((s) => s.type === type)[0];
  const ready = $derived(phase === 'ready' && !stale && canPublish(plan, wanted, typed, ack));
  const store = $derived(app ? storeName(app.platform) : t('publish:dialog.theStore'));
  const phraseId = `${uid}-phrase`;
  const title = $derived(plan ? publishTitle(plan, store) : t('publish:dialog.title'));
  const why = $derived(publishDisabledReason({ phase, stale, ready, wanted: wanted.length, plan }));

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
    inputTouched = false;
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
    const first = plan === null;
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
        if (supports(out.plan.app.platform, 'releaseTracks')) await releaseSettingsStore.load(api, workspaceId, out.plan.app.id);
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
      if (first) addKnownRelease(out.plan);
    } catch (e) {
      if (mine !== seq) return;
      failWith(classifyPublishFailure(e, pendingStore.config(workspaceId)));
      phase = plan ? 'ready' : 'error';
    }
  }

  /**
   * The first plan of a Google Play release that only waits for its track and share: when both are already known (the staged ones,
   * the default share of the app settings, or no staged rollout is possible so it is everyone) the release step is added for the person.
   * Nothing is written by this; the plan is confirmed as before. Untick the step to type another share.
   */
  function addKnownRelease(made: PublishPlan) {
    const step = made.steps.filter((s) => s.type === 'release')[0];
    if (!supports(made.app.platform, 'releaseTracks') || !step || step.availability !== 'needs_input' || track.trim() === '') return;
    const fraction = offered ? parsePercent(share) : EVERYONE;
    if (fraction === null) return;
    void review(
      requestsFor(made, toggled(includedTypes(made), 'release', true), { release: releaseStepRequest({ track, fraction, direct: isDirectPlan(made) }) }),
      fraction === EVERYONE
        ? t('publish:dialog.notice.addedEveryone', { track: track.trim() })
        : t('publish:dialog.notice.addedShare', { track: track.trim(), share: percentText(fraction) }),
    );
  }

  function toggle(type: PublishStepType, on: boolean) {
    if (!plan || busy) return;
    const next = toggled(wanted, type, on);
    wanted = next;
    if (next.length === 0) {
      // The release was the only step: unticking it asks for the track and the share again (nothing is added for the person this time).
      if (type === 'release') void review(null, t('publish:dialog.notice.chooseTrack'));
      return;
    }
    void review(requestsFor(plan, next), t('publish:dialog.notice.replanSteps'));
  }

  function addRelease() {
    if (!plan || busy) return;
    inputTouched = true;
    const fraction = offered ? parsePercent(share) : EVERYONE;
    if (track.trim() === '') {
      shareError = t('publish:dialog.error.nameTrack');
      return;
    }
    if (fraction === null) {
      shareError = t('publish:dialog.error.badShare');
      return;
    }
    shareError = '';
    void review(requestsFor(plan, toggled(wanted, 'release', true), { release: releaseStepRequest({ track, fraction, direct }) }), t('publish:dialog.notice.replanRelease'));
  }

  /** "Save as a draft only": the push alone. Nothing is submitted or released by it. */
  function saveAsDraftOnly() {
    if (!plan || busy) return;
    void review(draftOnlySteps(), t('publish:dialog.notice.replanDraft'));
  }

  /** Back to the default plan (the direct release when only release fields are staged). */
  function backToDirect() {
    if (busy) return;
    void review(steps);
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
    const published = changed;
    changed = false;
    if (published) {
      onchanged();
      // The app page reads the store again and shows the releases, so the person lands where the result is.
      if (app) announcePublished(app.id);
    }
  }

  // The plan is made when the dialog opens, and again when the person switches to another platform.
  let started = false;
  $effect(() => {
    if (!open || started) return;
    started = true;
    untrack(() => void review(steps));
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
      void review(steps);
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

{#snippet phraseTag(text: string)}<strong class="phrase">{text}</strong>{/snippet}
{#snippet pending()}
  <div class="stack" role="status" aria-label={t('publish:dialog.makingPlanAria')}>
    <Skeleton width="70%" height="16px" />
    <Skeleton width="90%" height="48px" />
    <Skeleton width="60%" height="16px" />
  </div>
{/snippet}

<Modal
  bind:open
  size="lg"
  {title}
  description={app ? `${app.name} · ${platformLabel(app.platform)}` : ''}
  dismissible={phase !== 'publishing'}
  onclose={closed}
>
  <div class="stack">
    {#if targets.length > 1}
      <div class="row tabs">
        <SegmentTabs tabs={targets.map((target) => ({ id: target.id, label: platformLabel(target.platform) }))} bind:value={tab} label={t('publish:dialog.platform')} idPrefix="{uid}-plat" />
      </div>
    {/if}

    {#if phase === 'done' && summary && result}
      <section class="stack" aria-label={t('publish:dialog.resultAria')} data-testid="publish-result">
        <Alert tone={summary.tone} title={summary.title}>
          {summary.text}
          {#if !result.completed}<span class="para">{stopNote()}</span>{/if}
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
          <p class="muted small">{t('publish:dialog.reviewAgainHint')}</p>
        {/if}
      </section>
    {:else if phase === 'previewing' && !plan}
      <PublishSummaryBlock summary={null} />
      {@render pending()}
    {:else if phase === 'error' && !plan}
      <Alert tone="error" title={t('publish:dialog.noPlan')}>{problem}</Alert>
    {:else if plan}
      {@const head = planHeadline(plan, store)}
      <PublishSummaryBlock summary={whatSummary} busy={phase === 'previewing'} />
      {#if plan.included > 1 && head.sequence}<p class="muted headline" data-testid="plan-headline">{t('publish:dialog.sequence', { sequence: head.sequence })}</p>{:else if plan.included === 0}<p class="muted headline" data-testid="plan-headline">{t('publish:dialog.headlineTitle', { title: head.title })}</p>{/if}
      {#if notice}<p class="notice muted small" role="status"><Icon name="info" size={14} /> {notice}</p>{/if}

      <ol class="steps" aria-label={t('publish:dialog.stepsAria')} aria-busy={phase === 'previewing'}>
        {#each rows as row (row.type)}
          {@const step = stepOf(row.type)}
          {#if step}
            {@const stepWarnings = foldWarnings(warningsOf(step).map((p) => p.message))}
            <li class="step" class:off={!wanted.includes(row.type)} data-testid="plan-step-{row.type}">
              <div class="step-head">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={wanted.includes(row.type)}
                    disabled={!row.toggleable || busy || stale || row.needsInput}
                    onchange={(e) => toggle(row.type, e.currentTarget.checked)}
                  />
                  <span class="step-title">{t('publish:dialog.stepTitle', { order: row.order, label: row.label })}</span>
                </label>
                {#if shownStatusWord(row)}<Badge tone={row.tone}>{shownStatusWord(row)}</Badge>{/if}
                {#if row.irreversible}<Badge tone="warn" icon="alert-triangle">{t('publish:dialog.cannotUndoBadge')}</Badge>{/if}
                {#if row.deferred}<Badge tone="info" icon="clock">{t('publish:dialog.checkedLater')}</Badge>{/if}
              </div>
              {#if step.included && !step.deferred && stepGist(step)}<p class="gist" data-testid="plan-step-gist-{row.type}">{stepGist(step)}</p>{/if}
              {#if row.reason}<p class="reason muted">{row.reason}</p>{/if}

              {#if row.needsInput}
                {#if direct}
                  <p class="small" data-testid="direct-explainer">
                    {offered ? t('publish:dialog.directExplainerShare') : t('publish:dialog.directExplainerAll')}
                  </p>
                {/if}
                <div class="inputs">
                  <div class="field">
                    <label for="{uid}-track">{t('publish:dialog.track')}</label>
                    <input id="{uid}-track" type="text" autocomplete="off" spellcheck="false" bind:value={track} oninput={() => (inputTouched = true)} disabled={busy || stale} />
                  </div>
                  {#if offered}
                    <div class="field">
                      <label for="{uid}-share">{t('publish:dialog.share')}</label>
                      <input id="{uid}-share" type="text" inputmode="decimal" autocomplete="off" placeholder="10" bind:value={share} oninput={() => (inputTouched = true)} disabled={busy || stale} aria-invalid={shareError !== '' ? 'true' : undefined} />
                    </div>
                  {:else}
                    <p class="small muted" data-testid="no-staged-rollout">{inputs.offer.message}</p>
                  {/if}
                  <Button size="sm" disabled={busy || stale} onclick={addRelease}>{t('publish:dialog.addRelease')}</Button>
                  {#if shareError}<p class="field-error">{shareError}</p>{/if}
                </div>
              {/if}

              {#each shownErrors(step, inputTouched) as p (p.code + p.message + (p.item ?? ''))}<p class="problem bad">{p.message}</p>{/each}
              {#each stepWarnings.inline as w (w)}<p class="problem warn">{w}</p>{/each}
              {#if stepWarnings.folded.length > 0}
                <Disclosure summary={stepWarnings.label}>
                  <ul class="plain problem warn">
                    {#each stepWarnings.folded as w (w)}<li>{w}</li>{/each}
                  </ul>
                </Disclosure>
              {/if}

              {#if step.included && step.deferred}
                <p class="small">{promiseText(step)}</p>
              {/if}

              {#if step.included && !step.deferred}
                <Disclosure summary={t('publish:dialog.details')} open={stepGist(step) === ''}>
                  <div class="detail">
                    {@render details(step)}
                    {#if step.irreversible && step.stepPhrase && plan?.confirmationRequired}
                      <p class="small muted">{t('publish:dialog.ownConfirmation', { phrase: step.stepPhrase })}</p>
                    {/if}
                  </div>
                </Disclosure>
              {:else if !step.included && step.preview}
                <Disclosure summary={t('publish:dialog.storeDetails')}>
                  <div class="detail">{@render details(step)}</div>
                </Disclosure>
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
      {#if visible.left.length > 0}
        <p class="muted small" data-testid="plan-left-out">{t('publish:dialog.leftOut', { items: formatList(visible.left, { type: 'unit' }) })}</p>
      {/if}

      {@const planWarnings = foldWarnings(plan.warnings)}
      {#each planWarnings.inline as w (w)}
        <p class="warnline"><Icon name="alert-triangle" size={14} /> {w}</p>
      {/each}
      {#if planWarnings.folded.length > 0}
        <Disclosure summary={planWarnings.label}>
          <ul class="plain tint-warn">
            {#each planWarnings.folded as w (w)}<li>{w}</li>{/each}
          </ul>
        </Disclosure>
      {/if}

      {#if canDraftOnly}
        <div class="row">
          <Button size="sm" disabled={busy || stale} onclick={saveAsDraftOnly}>{t('publish:dialog.draftOnly')}</Button>
          <span class="muted small">{t('publish:dialog.draftOnlyHint')}</span>
        </div>
      {:else if offersDirect}
        <div class="row">
          <Button size="sm" disabled={busy || stale} onclick={backToDirect}>{t('publish:dialog.directInstead')}</Button>
          <span class="muted small">{t('publish:dialog.directInsteadHint')}</span>
        </div>
      {/if}

      {#if !plan.confirmable}
        <Alert tone="error" title={t('publish:dialog.cannotPublishTitle')}>
          {wanted.length === 0 ? t('publish:dialog.tickOne') : t('publish:dialog.stepCannotRun')}
        </Alert>
      {:else if plan.confirmationRequired && plan.confirmation}
        <div class="confirm" class:irrev={plan.irreversible}>
          {#if plan.irreversible}
            <p class="irrev-line" data-testid="plan-irreversible">
              <Icon name="alert-triangle" size={16} /> <span><T key="publish:dialog.irreversibleLine" params={{ steps: formatList(plan.irreversibleSteps.map((step) => STEP_NAME[step])) }} /></span>
            </p>
          {/if}
          <div class="field">
            <label for={phraseId}><T key="publish:dialog.typePhrase" params={{ phrase: plan.confirmation.phrase }} tags={{ link: phraseTag }} /></label>
            <p class="muted small">{plan.confirmation.instruction}</p>
            <input id={phraseId} type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} disabled={busy || stale} />
          </div>
        </div>
      {:else}
        <label class="confirm ack" class:irrev={plan.irreversible} data-testid={plan.irreversible ? 'plan-irreversible' : undefined}>
          <input type="checkbox" bind:checked={ack} disabled={busy || stale} data-testid="plan-confirm-ack" />
          <span>
            {#if plan.irreversible}<T key="publish:dialog.ackIrreversible" params={{ steps: formatList(plan.irreversibleSteps.map((step) => STEP_NAME[step])) }} />{:else}<T key="publish:dialog.ackPlain" />{/if}
          </span>
        </label>
        <p class="muted small">{t('publish:dialog.passwordHint')}</p>
      {/if}

      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {#if phase === 'publishing'}
        <div role="status" class="running">
          <Alert tone="info" title={t('publish:dialog.publishingTitle')}>{t('publish:dialog.publishingBody')}</Alert>
        </div>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    {#if phase === 'done'}
      {#if summary?.review}<Button icon="refresh" onclick={() => review(steps)}>{t('publish:dialog.reviewAgain')}</Button>{/if}
      <Button variant="primary" onclick={close}>{t('common:action.close')}</Button>
    {:else}
      {#if why}
        {#if plan && phase === 'ready' && !stale && plan.confirmable}
          <button type="button" class="why-disabled" onclick={focusConfirm} data-testid="why-publish-disabled">{why}</button>
        {:else}
          <span class="why-text" data-testid="why-publish-disabled">{why}</span>
        {/if}
      {/if}
      <Button disabled={phase === 'publishing'} onclick={close}>{t('common:action.cancel')}</Button>
      {#if stale || (phase === 'error' && !plan)}
        <Button icon="refresh" disabled={busy} onclick={() => review(steps)}>{t('publish:dialog.reviewAgain')}</Button>
      {/if}
      {#if plan}
        <Button variant="primary" icon="upload" loading={phase === 'publishing'} disabled={!ready || busy} onclick={publish}>
          {t('publish:dialog.publishSteps', { count: plan.included })}
        </Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .why-disabled,
  .why-text {
    margin-inline-end: auto;
    font-size: var(--text-sm);
    color: var(--muted);
    text-align: start;
  }

  .why-disabled {
    padding: 0;
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    background: none;
    border: 0;
  }

  .why-disabled:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  .step-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .step input[type='checkbox'],
  .ack input[type='checkbox'] {
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
  }

  /* ONE box for the irreversible acknowledgement (or the typed phrase when the plan requires one). */
  .confirm {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .confirm.irrev {
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .ack {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-md);
    line-height: 1.4;
    cursor: pointer;
  }

  .irrev-line {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    margin: 0;
    color: var(--warn-ink);
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
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .step.off {
    background: var(--surface-sunken);
  }

  .step-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .headline {
    margin: 0;
  }

  .notice,
  .warnline {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    margin: 0;
  }

  .warnline,
  .tint-warn {
    color: var(--warn-ink);
  }

  .gist {
    margin: 0;
    font-size: var(--text-md);
    color: var(--muted);
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
