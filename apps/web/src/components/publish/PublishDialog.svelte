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
  import { useNow } from '../../lib/app-state/clock.svelte.ts';
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
    emptySelectionHint,
    includedTypes,
    isCombinedPlan,
    isDirectPlan,
    isRecommended,
    needsReview,
    planReady,
    previewBody,
    promiseText,
    pushAndSubmitSteps,
    publishBody,
    askedFractionOf,
    recommendedRequests,
    recommendedSentence,
    releaseInputDefaults,
    releaseIsDirect,
    releaseStepRequest,
    replaceReviewSteps,
    requestsFor,
    resultSummary,
    shouldAutoRecommend,
    stepRows,
    visibleRows,
    toggled,
    withReplaceReview,
    withWaiting,
    warningsOf,
  } from '../../lib/pending.ts';
  import { announcePublished } from '../../lib/app-page.ts';
  import { pendingStore, publishingStore } from '../../lib/app-state/pending-facade.ts';
  import { endedByServer } from '../../lib/publishing.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { firstFix, readinessView, submitChoice } from '../../lib/publish-readiness.ts';
  import { publishSummary, shownErrors } from '../../lib/publish-summary.ts';
  import { elapsedText, failureDetail, minutesOf, PUBLISH_SLOW_AFTER_MS, PUBLISH_WAIT_LIMIT_MS, PublishWaitError, withWaitLimit } from '../../lib/publish-run.ts';
  import { foldWarnings, planHeadline, publishDisabledReason, publishTitle, shownStatusWord, stepGist } from '../../lib/readability.ts';
  import { EVERYONE, releaseInputsFor } from '../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../lib/app-state/release-settings-store.svelte.ts';
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
  import PublishFailureDetail from './PublishFailure.svelte';
  import PublishSummaryBlock from './PublishSummary.svelte';
  import PushPreviewBody from './PushPreviewBody.svelte';
  import ReleasePreviewBody from './ReleasePreviewBody.svelte';
  import RolloutPreviewBody from './RolloutPreviewBody.svelte';
  import { provideReviewRepair } from '../../lib/review-repair-context.ts';
  import SubmitPreviewBody from './SubmitPreviewBody.svelte';
import { PLAY_TRACKS, supports, type Role } from '@kiln/core';

  let {
    open = $bindable(false),
    api,
    workspaceId,
    role = null,
    targets,
    steps = null,
    onchanged,
  }: {
    open?: boolean | undefined;
    api: Api;
    workspaceId: string;
    /** The role of the person, when the caller knows it (it only decides whether "Copy review information" is drawn; the server decides the rest). */
    role?: Role | null | undefined;
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
  // A run that pushed the draft and had its submit blocked is shown against what the store holds NOW (the model's blockers view), never as if its own list were current.
  $effect(() => {
    const run = result?.lastPublish ?? null;
    const record = app;
    if (run === null || record === undefined || role === null || role === undefined) return;
    untrack(() => appStateStore.ensureReadiness(api, workspaceId, role, [record]));
  });
  let problem = $state('');
  let notice = $state('');
  /** The plan on screen is not the one the server would build now: only "Review again" is possible. */
  let stale = $state(false);
  let typed = $state('');
  let ack = $state(false);
  let track = $state<string>(PLAY_TRACKS.production);
  let share = $state('');
  let shareError = $state('');
  /** The person typed in the Track or Share fields (or pressed the button): only then is the prompt for them shown as a problem. */
  let inputTouched = $state(false);
  /** Google Play: the plan releases the staged fields in one step (the server made it so, or the person added it so). */
  let direct = $state(false);
  /**
   * Google Play: the person chose to REPLACE the review in progress with everything together (the failure block's button, or the
   * recommended step after a `changes_in_review` refusal). It rides on the push that sends for review, in every plan asked for until
   * the person takes it off. Never implied: the plan asks for the same confirmation and step-up as any step that cannot be undone.
   */
  let replace = $state(untrack(() => (steps ?? []).some((s) => s.replaceReview === true)));
  let changed = false;
  let seq = 0;

  /** While publishing: when it started and "now", so the dialog shows it is alive and says when it is slow. */
  const clock = useNow({ everyMs: 1000, while: () => phase === 'publishing' });
  let startedAt = $state(0);
  const waited = $derived(phase === 'publishing' ? Math.max(0, clock.value - startedAt) : 0);
  $effect(() => {
    if (phase !== 'publishing') return;
    startedAt = untrack(() => clock.touch());
  });

  /** The failure the server held when this publish began (an old interrupted run is not news). */
  let failureBefore = '';
  /** The server ended this publish without an answer (restart, lost request): the shared state reads its claim, so the dialog need not wait 20 minutes. */
  const endedHere = $derived(
    phase === 'publishing' && app !== undefined && endedByServer(publishingStore.failureOf(workspaceId, app.id), failureBefore),
  );
  $effect(() => {
    if (!endedHere) return;
    // The request is not waited for any more: its late answer, if it ever comes, is not ours (`seq`).
    seq++;
    problem = t('app:pending.failed.interrupted');
    stale = true;
    changed = true;
    onchanged();
    phase = 'ready';
  });

  const busy = $derived(phase === 'previewing' || phase === 'publishing');

  // A blocker about the App Review Information offers "Copy review information from ..." in the readiness list and the submit preview;
  // afterwards the plan is made again (same ticked steps), so the blocker is gone or still told.
  provideReviewRepair(() => ({
    api,
    workspaceId,
    role,
    app: { id: app?.id ?? '', name: app?.name ?? '', platform: app?.platform ?? 'ios' },
    onrepaired: () => void review(plan !== null && wanted.length > 0 ? requestsFor(plan, wanted) : steps, ''),
  }));
  const visible = $derived(plan ? visibleRows(stepRows(plan)) : { shown: [], left: [] });
  const rows = $derived(visible.shown);
  const summary = $derived(result ? resultSummary(result, askedFractionOf(plan)) : null);
  // Google Play offers a staged rollout for updates only: no share is asked for the first release in production, or when the app setting says never.
  const inputs = $derived(releaseInputsFor({ view: app ? releaseSettingsStore.get(app.id) : null, track, stagedPercent: '' }));
  const offered = $derived(inputs.offer.offered);
  // The Track and Share fields while the release step is not added yet: the summary shows them live (never sent from here).
  const typedRelease = $derived(
    rows.some((r) => r.needsInput) ? { track, fraction: offered ? parsePercent(share) : EVERYONE } : null,
  );
  const whatSummary = $derived(
    plan ? publishSummary({ plan, wanted, identifier: app?.identifier ?? '', typed: typedRelease }) : null,
  );
  const stepOf = (type: PublishStepType): PlanStep | undefined => plan?.steps.filter((s) => s.type === type)[0];
  // A push and a submit asked together while the submit certainly cannot run: the person chooses (push the draft only, or fix first).
  const choice = $derived(plan ? submitChoice(plan) : null);
  const fixTarget = $derived(plan ? (() => { const view = readinessView(plan); return view ? firstFix(view) : null; })() : null);
  const ready = $derived(phase === 'ready' && !stale && canPublish(plan, wanted, typed, ack));
  const store = $derived(app ? storeName(app.platform) : t('publish:dialog.theStore'));
  const phraseId = `${uid}-phrase`;
  const title = $derived(plan ? publishTitle(plan, store) : t('publish:dialog.title'));
  const why = $derived(publishDisabledReason({ phase, stale, ready, wanted: wanted.length, plan, recommended: (plan?.recommended ?? null) !== null }));
  const emptyHint = $derived(phase === 'ready' ? emptySelectionHint(plan, wanted) : null);
  const recommendedNote = $derived(plan && isRecommended(plan, wanted) ? recommendedSentence(plan, { shareMissing: false }) : '');

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
    replace = false;
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
      const out = await api.previewPublish(workspaceId, app.id, previewBody(steps === null ? null : withReplaceReview(steps, replace)));
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
      // A plan that holds nothing never stays so: the known release is added, else the recommended step (the default plan only: a plan the caller scoped is theirs).
      if (first && !addKnownRelease(out.plan) && steps === null) useRecommendedAtStart(out.plan);
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
  function addKnownRelease(made: PublishPlan): boolean {
    const step = made.steps.filter((s) => s.type === 'release')[0];
    if (!supports(made.app.platform, 'releaseTracks') || !step || step.availability !== 'needs_input' || track.trim() === '') return false;
    const fraction = offered ? parsePercent(share) : EVERYONE;
    if (fraction === null) return false;
    void review(
      // A push and a release are ONE step on Google Play (`requestsFor` asks for it), and a step that only waits for the share is kept.
      requestsFor(made, toggled(withWaiting(made, includedTypes(made)), 'release', true), { release: releaseStepRequest({ track, fraction, direct: isDirectPlan(made) }) }),
      fraction === EVERYONE
        ? t('publish:dialog.notice.addedEveryone', { track: track.trim() })
        : t('publish:dialog.notice.addedShare', { track: track.trim(), share: percentText(fraction) }),
    );
    return true;
  }

  /** The share the person gave (or null when it is still missing): none is asked when Google Play offers no staged rollout. */
  const knownFraction = (): number | null => (offered ? parsePercent(share) : EVERYONE);

  /** The first plan holds nothing: ask for the plan with the recommended step (never an empty plan while a valid step exists). */
  function useRecommendedAtStart(made: PublishPlan) {
    if (!shouldAutoRecommend(made)) return;
    const asked = recommendedRequests(made, { fraction: knownFraction() });
    // After a refusal for changes in review the recommendation replaces that review: preselected, never run before the person confirms.
    replace = made.recommended?.replacesReview === true;
    if (asked !== null) void review(asked, t('publish:dialog.notice.replanRecommended'));
  }

  /** "Use the recommended step": the plan is made again with it. A release that still needs the share asks for it, and says so. */
  function useRecommended() {
    if (!plan || busy) return;
    const rec = plan.recommended ?? null;
    if (rec === null) return;
    replace = rec.replacesReview === true;
    const asked = recommendedRequests(plan, { fraction: knownFraction() });
    if (asked !== null) {
      void review(asked, t('publish:dialog.notice.replanRecommended'));
      return;
    }
    inputTouched = true;
    void review(rec.steps, recommendedSentence(plan, { shareMissing: true }));
  }

  function toggle(type: PublishStepType, on: boolean) {
    if (!plan || busy) return;
    if (type === 'push_and_submit' && !on && plan.oneCommit === true) {
      // Without the push the release stands alone: the direct release of the staged build (the texts stay staged, nothing is pushed).
      const own = plan.steps.filter((s) => s.type === 'release')[0]?.request ?? { type: 'release' as const };
      wanted = ['release'];
      void review(requestsFor(plan, ['release'], { release: { ...own, type: 'release', direct: true } }), t('publish:dialog.notice.replanSteps'));
      return;
    }
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
    // Direct whenever a build is staged and no draft push is in the plan: a plain release would find no draft to start.
    const asDirect = releaseIsDirect(plan, wanted, direct);
    void review(requestsFor(plan, toggled(withWaiting(plan, wanted), 'release', true), { release: releaseStepRequest({ track, fraction, direct: asDirect }) }), t('publish:dialog.notice.replanRelease'));
  }

  /** "Save as a draft only": the push alone. Nothing is submitted or released by it. */
  function saveAsDraftOnly() {
    if (!plan || busy) return;
    void review(draftOnlySteps(), t('publish:dialog.notice.replanDraft'));
  }

  /** "Fix the blockers first": closes the dialog and goes to the place of the first blocker (the store's console opens in a new tab). Nothing is sent. */
  function fixBlockersFirst() {
    if (!fixTarget || busy) return;
    if (fixTarget.external) {
      window.open(fixTarget.href, '_blank', 'noopener,noreferrer');
      return;
    }
    close();
    window.location.hash = fixTarget.href;
  }

  /**
   * "Push and submit for review in one step" (Google Play would not keep a draft, or the person prefers it): the combined step alone.
   * Only a new plan is asked for; the confirmation (the typed phrase, or the step-up) is still asked before anything is sent.
   */
  function pushAndSubmit() {
    if (!plan || busy) return;
    void review(pushAndSubmitSteps(), t('publish:dialog.notice.replanPushSubmit'));
  }

  /**
   * "Replace the review in progress with everything together" (after Google Play refused for changes in review): the plan is made with
   * the push that carries `replaceReview` and the release. Nothing is sent from here: the plan still asks for the typed phrase (or the
   * step-up), says what it replaces and that the app loses its place in the review queue.
   */
  function replaceReview() {
    if (busy) return;
    replace = true;
    const fraction = knownFraction();
    inputTouched = fraction !== null;
    void review(
      fraction === null
        ? replaceReviewSteps()
        : [{ type: 'push_and_submit', replaceReview: true }, releaseStepRequest({ track, fraction, direct: false })],
      t('publish:dialog.replaceTitle'),
    );
  }

  /** Takes "replace the review" off again: the plan is made without it. */
  function stopReplacing() {
    if (!plan || busy) return;
    replace = false;
    void review(requestsFor(plan, wanted), t('publish:dialog.notice.replanReplaceStop'));
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
    // Read now: the dialog can be closed (and gone) by the time the answer comes.
    const appId = sent.app.id;
    const notify = onchanged;
    const space = workspaceId;
    const client = api;
    phase = 'publishing';
    problem = '';
    // Every screen learns at once that this app is publishing (the pending panel, the buttons that would release or promote), before the
    // server's own claim is read; the answer below, or a close, reads it again.
    failureBefore = publishingStore.failureOf(space, appId)?.id ?? '';
    publishingStore.started(client, space, appId, includedTypes(sent));
    try {
      // The only call that writes. Sent once, with the plan's hash, its steps and the phrase; never sent again by this app.
      // The wait is limited per attempt (the confirmation prompt is outside it): a request that never answers ends in a message.
      const publishPayload = publishBody(sent, typed);
      const out = await confirmed(
        (grant) => withWaitLimit((signal) => api.publishPending(workspaceId, appId, publishPayload, grant, signal)),
        publishPayload.planHash,
      );
      if (mine !== seq) return;
      result = out.result;
      changed = true;
      phase = 'done';
      // The panel keeps the failure too (the server keeps the run; this shows it before the next read): it survives the dialog.
      publishingStore.answered(client, space, appId, out.result.lastPublish ?? null);
      notify();
      // Closed while it ran: nobody is looking at the result, so the app page is told as the close would have.
      if (!open) {
        changed = false;
        announcePublished(appId);
      }
    } catch (e) {
      // A dialog that was closed while publishing keeps its state, so this answer is still ours (close() does not bump `seq` then).
      if (mine !== seq) return;
      if (e instanceof PublishWaitError) {
        // What the server did is not known (it may still run, or be done): the screens read it again, and only "Review again" is left.
        // The claim, not this request, says whether it still runs: the shared state follows it.
        void publishingStore.refresh(client, space);
        problem = t('app:pending.run.noAnswer', { minutes: minutesOf(PUBLISH_WAIT_LIMIT_MS) });
        stale = true;
        changed = true;
        notify();
      } else {
        // Refused or failed: whatever the server holds is read again (another person's publish may be what refused this one).
        publishingStore.answered(client, space, appId, null);
        failWith(classifyPublishFailure(e, pendingStore.config(workspaceId)));
        const detail = failureDetail(e);
        if (detail) problem = `${problem} ${t('app:pending.run.detail', { detail })}`;
      }
      phase = 'ready';
    }
  }

  function close() {
    // While a publish runs the dialog can be closed: the request goes on and its answer is handled when it comes.
    if (phase !== 'publishing') seq++;
    else void publishingStore.refresh(api, workspaceId);
    open = false;
  }

  function closed() {
    if (phase !== 'publishing') seq++;
    else void publishingStore.refresh(api, workspaceId);
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
  {#if (step.type === 'push_draft' || step.type === 'push_and_submit') && push}
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
        {#if !result.completed && result.lastPublish && app}
          <!-- the run the server kept: each step, and under the failed one why (the store's own words, its code and HTTP status), with Copy details -->
          <PublishFailureDetail run={result.lastPublish} appName={app.name} platform={app.platform} blockers={appStateStore.blockersFor(workspaceId, app.id, result.lastPublish)} oncheck={() => void appStateStore.checkAgain(api, workspaceId, app.id)} onpushsubmit={plan?.combined?.offered === false ? undefined : pushAndSubmit} onreplace={replaceReview} />
          <p class="muted small">{stopNote()}</p>
        {:else}
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
        {/if}
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
      <PublishSummaryBlock summary={whatSummary} busy={phase === 'previewing'} {api} {workspaceId} {app} onnavigate={close} />
      {#if choice}
        <div class="choice" role="group" aria-label={t('publish:readiness.choice.title')} data-testid="plan-submit-choice">
          <p class="small warnline"><Icon name="alert-triangle" size={14} /> <span><strong>{t('publish:readiness.choice.title')}.</strong> {t('publish:readiness.choice.text', { count: choice.count })}</span></p>
          <div class="row">
            <Button size="sm" variant="primary" disabled={busy || stale} onclick={saveAsDraftOnly} data-testid="choice-draft-only">{t('publish:readiness.choice.draftOnly')}</Button>
            <Button size="sm" disabled={busy || stale || fixTarget === null} onclick={fixBlockersFirst} data-testid="choice-fix-first">{t('publish:readiness.choice.fixFirst')}</Button>
          </div>
        </div>
      {/if}
      {#if plan.included > 1 && head.sequence}<p class="muted headline" data-testid="plan-headline">{t('publish:dialog.sequence', { sequence: head.sequence })}</p>{:else if plan.included === 0}<p class="muted headline" data-testid="plan-headline">{t('publish:dialog.headlineTitle', { title: head.title })}</p>{/if}
      {#if notice}<p class="notice muted small" role="status"><Icon name="info" size={14} /> {notice}</p>{/if}
      {#if recommendedNote}<p class="notice small" role="status" data-testid="plan-recommended-note"><Icon name="info" size={14} /> {recommendedNote}</p>{/if}
      {#if plan.replacesReview}
        <div class="replace-note" role="status" data-testid="plan-replaces-review">
          <p class="small warnline"><Icon name="alert-triangle" size={14} /> <strong>{t('publish:dialog.replaceTitle')}.</strong> {t('publish:dialog.replaceText')}</p>
          <Button size="sm" disabled={busy || stale} onclick={stopReplacing}>{t('publish:dialog.replaceStop')}</Button>
        </div>
      {/if}
      {#if plan.combined?.defaulted && isCombinedPlan(plan)}<p class="notice small" role="status" data-testid="plan-combined-note"><Icon name="info" size={14} /> {t('publish:dialog.combinedDefaulted')}</p>{/if}

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
              {#if row.type === 'push_and_submit'}
                <!-- the server's reason is English: the sentences below say it in the person's language -->
                <p class="reason muted" data-testid="plan-combined-hint">{wanted.includes('push_and_submit') ? (plan.oneCommit === true ? t('publish:dialog.oneCommitOn') : t('publish:dialog.combinedOn')) : t('publish:dialog.combinedHint')}</p>
              {:else if row.type === 'release' && plan.oneCommit === true && step.included}
                <p class="reason muted" data-testid="plan-same-commit">{t('publish:dialog.sameCommit')}</p>
              {:else if row.reason}<p class="reason muted">{row.reason}</p>{/if}

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
      {#if visible.leftBy.unsupported.length > 0}
        <p class="muted small" data-testid="plan-left-out-unsupported">{t('publish:dialog.leftUnsupported', { items: formatList(visible.leftBy.unsupported, { type: 'unit' }) })}</p>
      {/if}
      {#if visible.leftBy.nothing.length > 0}
        <p class="muted small" data-testid="plan-left-out-nothing">{t('publish:dialog.leftNothing', { items: formatList(visible.leftBy.nothing, { type: 'unit' }) })}</p>
      {/if}
      {#if visible.leftBy.optional.length > 0}
        <p class="muted small" data-testid="plan-left-out-optional">{t('publish:dialog.leftOptional', { items: formatList(visible.leftBy.optional, { type: 'unit' }) })}</p>
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
        <Disclosure summary={t('publish:dialog.advancedDraft')}>
          <div class="stack" data-testid="plan-advanced-draft">
            <p class="small warnline"><Icon name="alert-triangle" size={14} /> {t('publish:dialog.advancedDraftWarning')}</p>
            <div class="row">
              <Button size="sm" disabled={busy || stale} onclick={saveAsDraftOnly}>{t('publish:dialog.draftOnly')}</Button>
              <span class="muted small">{t('publish:dialog.draftOnlyHint')}</span>
            </div>
          </div>
        </Disclosure>
      {:else if offersDirect}
        <div class="row">
          <Button size="sm" disabled={busy || stale} onclick={backToDirect}>{t('publish:dialog.directInstead')}</Button>
          <span class="muted small">{t('publish:dialog.directInsteadHint')}</span>
        </div>
      {/if}

      {#if emptyHint}
        <!-- Nothing ticked is a choice, not an error: say what is recommended and give one click to use it. -->
        <div class="empty-hint" role="status" data-testid="plan-empty-hint">
          <p class="small"><Icon name="info" size={14} /> <strong>{t('publish:dialog.emptyTitle')}.</strong> {emptyHint.kind === 'recommend' ? `${t('publish:dialog.emptyRecommend')} ${recommendedSentence(plan, { shareMissing: emptyHint.needsShare && !stale && offered && parsePercent(share) === null })}` : t('publish:dialog.emptyNothing')}</p>
          {#if emptyHint.kind === 'recommend'}
            <Button size="sm" variant="primary" disabled={busy || stale} onclick={useRecommended} data-testid="use-recommended">{t('publish:dialog.useRecommended')}</Button>
          {/if}
        </div>
      {:else if !plan.confirmable}
        {#if choice === null}<Alert tone="error" title={t('publish:dialog.cannotPublishTitle')}>{t('publish:dialog.stepCannotRun')}</Alert>{/if}
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
          <Alert tone="info" title={t('publish:dialog.publishingTitle')}>
            {t('app:pending.run.body', { steps: formatList(plan.steps.filter((s) => s.included).map((s) => STEP_NAME[s.type])) })}
            <span class="para" data-testid="publish-elapsed">{t('app:pending.run.elapsed', { time: elapsedText(waited) })}</span>
            {#if waited >= PUBLISH_SLOW_AFTER_MS}
              <span class="para" data-testid="publish-slow">{t('app:pending.run.slow', { minutes: minutesOf(PUBLISH_WAIT_LIMIT_MS) })}</span>
            {/if}
          </Alert>
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
      <Button onclick={close}>{phase === 'publishing' ? t('app:pending.run.closeButton') : t('common:action.cancel')}</Button>
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

  .replace-note {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--warn, var(--line-strong));
    border-radius: var(--radius-xl);
  }

  .choice {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--warn, var(--line-strong));
    border-radius: var(--radius-xl);
  }

  .empty-hint {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
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
