<!--
  ReleaseStepper: "Prepare release" for ONE app record: Build, Notes, Assets, Review, Confirm. Each step has a readiness dot
  (and a word, never colour alone). The steps only STAGE changes in our own database; nothing reaches a store when a step
  changes. Only the Confirm step does, through the gated flows that already exist: push the draft (typed app name and an
  acknowledgement), submit for review (typed phrase), release (typed phrase, and for Google Play the share you type), and the
  rollout controls. Their confirmations are the same components, unchanged. A step the role or the server's switches do not
  allow is not shown, and one sentence says why.
  The step is kept in the address (`&step=notes`), so a link, a reload and the "Release left unfinished" item land on it.
  Props: api, workspaceId, role, app, scope (the platform scope of the address), appBuilds (our CI builds, for the run of each
  build), releases (the store releases by app id, for the rollout controls), step (the step the address asks for), promote?
  (Google Play: "Promote to production" from the address: the source track, the target and the version codes to select), onstep,
  onclose, showPlatform.
-->
<script lang="ts">
  import { type Role, isApplePlatform } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../../lib/api.ts';
  import { fitToViewport } from '../../../lib/fit-viewport.ts';
  import { readCache } from '../../../lib/read-cache.ts';
  import type { PlatformScope } from '../../../lib/app-scope.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import { type EditableRelease, type ReleaseCandidates, type PlayCandidates, type BuildCandidate } from '../../../lib/release-candidates.ts';
  import { type Promote } from '../../../lib/play-promote.ts';
  import { type PromoteNotesState, noteRows, promoteNotesFill, unsavedLocales } from '../../../lib/release-notes.ts';
  import { type AppPipeline } from '../../../lib/release-pipeline.ts';
  import {
    type EditableState,
    type StepId,
    LEVEL_TONE,
    LEVEL_WORD,
    chosenOf,
    confirmHiddenReason,
    neighbour,
    resolveStep,
    stagedFacts,
    stagedField,
    stagedNotes,
    stepStatuses,
    storeNotes,
    visibleSteps,
  } from '../../../lib/release-stepper.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import { canSubmit } from '../../../lib/store-submit.ts';
  import { submitStore } from '../../../lib/store-submit-store.svelte.ts';
  import { canRelease } from '../../../lib/store-release.ts';
  import { releaseStore } from '../../../lib/store-release-store.svelte.ts';
  import type { AppBuild, AppSummary, ReleaseSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import StepAssets from './StepAssets.svelte';
  import StepBuild from './StepBuild.svelte';
  import StepConfirm from './StepConfirm.svelte';
  import StepNotes from './StepNotes.svelte';
  import StepReview from './StepReview.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    scope,
    appBuilds,
    releases,
    step,
    promote = null,
    onstep,
    onclose,
    showPlatform = false,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    scope: PlatformScope | null;
    appBuilds: AppBuild[];
    releases: Record<string, ReleaseSummary[]>;
    step: StepId | null;
    promote?: Promote | null;
    onstep: (next: StepId) => void;
    onclose: () => void;
    showPlatform?: boolean;
  } = $props();

  const uid = $props.id();
  const apple = $derived(isApplePlatform(app.platform));

  let editable = $state<EditableRelease | null>(null);
  let editableState = $state<EditableState>({ state: 'loading' });
  let candidates = $state<ReleaseCandidates | null>(null);
  let candidatesState = $state<EditableState>({ state: 'loading' });
  let sourceCandidates = $state<PlayCandidates | null>(null);
  let pipeline = $state<AppPipeline | null>(null);
  let listingLocales = $state<string[]>([]);
  let track = $state('production');
  let source = $state('beta');
  let drafts = $state<Record<string, string>>({});
  let extra = $state<string[]>([]);
  /** "Promote to production": what reading the notes of the source release did (null: not a promotion). */
  let promoteNotes = $state<PromoteNotesState | null>(null);
  let seq = 0;

  const view = $derived(stagedStore.view(app.id));

  const switches = $derived({
    draft: stagedStore.config(workspaceId)?.enabled ?? null,
    submit: canSubmit(role) ? (submitStore.config(workspaceId)?.enabled ?? null) : null,
    release: canRelease(role) ? (releaseStore.config(workspaceId)?.enabled ?? null) : null,
  });
  const visible = $derived(visibleSteps(role, switches));
  const current = $derived(resolveStep(step, visible));
  const hidden = $derived(confirmHiddenReason(role, switches));

  const buildList = $derived<BuildCandidate[]>(candidates !== null && candidates.store === 'appstoreconnect' ? candidates.builds : []);
  const locales = $derived(
    Array.from(
      new Set([
        ...Object.keys(storeNotes(editable)),
        ...Object.keys(stagedNotes(view, app.platform)),
        ...extra,
        ...listingLocales,
      ]),
    ).sort(),
  );
  const rows = $derived(noteRows({ platform: app.platform, locales, drafts, store: storeNotes(editable), staged: stagedNotes(view, app.platform) }));
  const chosen = $derived(chosenOf({ platform: app.platform, view, editable, builds: buildList }));
  const choices = $derived.by((): number | null => {
    if (candidates === null) return null;
    if (candidates.store === 'appstoreconnect') return candidates.builds.filter((b) => b.eligibility ? b.eligibility.eligible : b.selectable).length;
    return candidates.codes.filter((c) => (c.eligibility ? c.eligibility.eligible : true)).length;
  });
  const statuses = $derived(
    stepStatuses(
      {
        platform: app.platform,
        editable: editableState,
        chosen,
        choices,
        notes: { withText: rows.filter((r) => r.draft.trim() !== '').length, unsaved: unsavedLocales(rows).length, over: rows.filter((r) => r.over).length },
        staged: stagedFacts(view),
        pipeline: pipeline ? { state: pipeline.pipeline.state, waitingOn: pipeline.pipeline.waitingOn } : null,
      },
      visible,
    ),
  );
  const chosenBuildId = $derived.by((): string | null => {
    const staged = stagedField(view, 'build');
    if (staged !== null) return staged.value;
    return editable && editable.store === 'appstoreconnect' ? (editable.build?.id ?? null) : null;
  });
  const stagedTrack = $derived(stagedField(view, 'track'));
  const releaseTrack = $derived(stagedTrack !== null ? stagedTrack.value : track);
  const stagedCodes = $derived(stagedField(view, 'version_codes'));
  const stagedShare = $derived(stagedField(view, 'user_fraction'));
  const releaseVersion = $derived(editable && editable.store === 'appstoreconnect' ? editable.version.versionString : null);

  async function loadEditable(force = false) {
    const mine = seq;
    editableState = { state: 'loading' };
    try {
      const out = await readCache.read({
        workspaceId,
        group: 'store',
        key: `editable/${app.id}/${apple ? '' : track.trim()}`,
        force,
        load: () => api.releaseEditable(workspaceId, app.id, apple ? undefined : track.trim()),
      });
      if (mine !== seq) return;
      editable = out.editable;
      editableState = { state: 'ready' };
    } catch (e) {
      if (mine !== seq) return;
      editable = null;
      editableState = e instanceof ApiError && e.code === 'no_editable_version' ? { state: 'none' } : { state: 'error', message: stagingError(e) };
    }
  }

  /**
   * "Promote to production": the notes of the release in the source track (found by its version codes) go into the editors, per
   * language, unless the person wrote or staged text there already. Read only; nothing is staged.
   */
  let promoteStageProblem = $state('');

  /**
   * "Promote to production": the track and the version codes of the release being promoted are staged when the steps open (a
   * save in this tool only; nothing is sent to Google Play). Without them the publish has no draft release to start, and the
   * person had to find "Use these version codes" in the first step. What is staged already is not staged again.
   */
  async function stagePromotion(p: Promote) {
    promoteStageProblem = '';
    if (!canStage(role)) return;
    const wanted = [...p.codes].sort((a, b) => Number(a) - Number(b)).join(',');
    const view = stagedStore.view(app.id);
    const codes = stagedField(view, 'version_codes');
    const staged = stagedField(view, 'track');
    const have = codes === null ? '' : codes.value.split(',').filter((c) => c !== '').sort((a, b) => Number(a) - Number(b)).join(',');
    if (have === wanted && staged !== null && staged.value === p.to) return;
    try {
      let out = await api.stageReleaseField(workspaceId, app.id, { field: 'track', value: p.to });
      out = await api.stageReleaseField(workspaceId, app.id, { field: 'version_codes', value: wanted });
      stagedStore.set(out.staged);
    } catch (e) {
      promoteStageProblem = `The version codes could not be staged: ${stagingError(e)} Choose them in the first step.`;
      void stagedStore.load(api, workspaceId, app.id);
    }
  }

  async function loadPromoteNotes(p: Promote) {
    const mine = seq;
    promoteNotes = { status: 'loading' };
    try {
      const out = await api.releaseNotesHistory(workspaceId, app.id, { platform: app.platform, track: p.from, codes: p.codes, limit: 100 });
      if (mine !== seq) return;
      const fill = promoteNotesFill({
        history: out.history,
        drafts,
        staged: stagedNotes(stagedStore.view(app.id), app.platform),
        locales,
        platform: app.platform,
      });
      drafts = fill.drafts;
      const more = fill.addLocales.filter((l) => extra.indexOf(l) < 0);
      if (more.length > 0) extra = [...extra, ...more];
      promoteNotes = fill.state;
    } catch (e) {
      if (mine !== seq) return;
      promoteNotes = { status: 'error', message: stagingError(e) };
    }
  }

  async function loadCandidates(force = false) {
    const mine = seq;
    candidatesState = { state: 'loading' };
    try {
      const out = await readCache.read({
        workspaceId,
        group: 'store',
        key: `candidates/${app.id}/${apple ? '' : track.trim()}`,
        force,
        load: () => api.releaseCandidates(workspaceId, app.id, apple ? {} : { track: track.trim() }),
      });
      if (mine !== seq) return;
      candidates = out.candidates;
      candidatesState = { state: 'ready' };
    } catch (e) {
      if (mine !== seq) return;
      candidates = null;
      candidatesState = { state: 'error', message: stagingError(e) };
    }
  }

  async function loadSource(force = false) {
    const mine = seq;
    if (apple || source.trim() === '') {
      sourceCandidates = null;
      return;
    }
    try {
      const out = await readCache.read({
        workspaceId,
        group: 'store',
        key: `candidates/${app.id}/${source.trim()}`,
        force,
        load: () => api.releaseCandidates(workspaceId, app.id, { track: source.trim() }),
      });
      if (mine === seq && out.candidates.store === 'googleplay') sourceCandidates = out.candidates;
    } catch {
      if (mine === seq) sourceCandidates = null;
    }
  }

  async function loadPipeline() {
    const mine = seq;
    try {
      const out = await readCache.read({ workspaceId, group: 'pipeline', key: `pipeline/${app.id}`, load: () => api.releasePipeline(workspaceId, app.id) });
      if (mine === seq) pipeline = out;
    } catch {
      if (mine === seq) pipeline = null;
    }
  }

  async function loadLocales() {
    const mine = seq;
    try {
      const out = await readCache.read({ workspaceId, group: 'listing', key: `live/${app.id}`, load: () => api.appListingLive(workspaceId, app.id) });
      if (mine !== seq) return;
      const channel = out.channels.filter((c) => c.channel === 'editable')[0] ?? out.channels[0];
      listingLocales = channel ? Object.keys(channel.locales) : [];
    } catch {
      if (mine === seq) listingLocales = [];
    }
  }

  // The buttons "Read again" and "Try again" skip what was kept; the first read when a step opens does not.
  function readBuilds() {
    void loadEditable(true);
    void loadCandidates(true);
  }

  function readTracks() {
    void loadEditable(true);
    void loadCandidates(true);
    void loadSource(true);
  }

  let shownFor = '';
  $effect(() => {
    const key = `${workspaceId}/${app.id}`;
    if (key === shownFor) return;
    shownFor = key;
    untrack(() => {
      seq++;
      editable = null;
      candidates = null;
      sourceCandidates = null;
      pipeline = null;
      drafts = {};
      extra = [];
      promoteNotes = null;
      void stagedStore.load(api, workspaceId, app.id).then(() => {
        const t = stagedField(stagedStore.view(app.id), 'track');
        if (t !== null) track = t.value;
        // "Promote to production": the source track and the target come from the address and win over an earlier staged track.
        if (promote !== null && !apple) {
          source = promote.from;
          track = promote.to;
          void loadPromoteNotes(promote);
          void stagePromotion(promote);
        }
        void loadEditable();
        void loadCandidates();
        void loadSource();
      });
      void stagedStore.loadConfig(api, workspaceId);
      if (canSubmit(role)) void submitStore.loadConfig(api, workspaceId);
      if (canRelease(role)) void releaseStore.loadConfig(api, workspaceId);
      void loadPipeline();
      void loadLocales();
    });
  });

  const next = $derived(current === null ? null : neighbour(current, visible, 1));
  const back = $derived(current === null ? null : neighbour(current, visible, -1));
</script>

<section class="stepper" aria-label="Prepare release, {platformLabel(app.platform)}" data-testid="release-stepper" use:fitToViewport={{ margin: 16, min: 420 }}>
  <header class="head">
    <h3>Prepare release{showPlatform ? `: ${platformLabel(app.platform)}` : ''}</h3>
    {#if releaseVersion}<span class="muted">version {releaseVersion}</span>{/if}
    <span class="spacer"></span>
    <Button size="sm" variant="ghost" icon="x" onclick={onclose}>Close</Button>
  </header>
  <p class="muted note">Each step stages changes in this tool. Nothing is sent to the store until the last step, and you confirm it there.</p>

  <ol class="steps" aria-label="Steps">
    {#each statuses as s, i (s.id)}
      {@const tone = LEVEL_TONE[s.level]}
      <li>
        <button type="button" class="step" class:current={current === s.id} aria-current={current === s.id ? 'step' : undefined} onclick={() => onstep(s.id)}>
          <span class="dot {tone}" aria-hidden="true"></span>
          <span class="label" title={s.label}><span class="num">{i + 1}</span> {s.label}</span>
          <span class="word">{LEVEL_WORD[s.level]}</span>
          <span class="text" title={s.text}>{s.text}</span>
        </button>
      </li>
    {/each}
  </ol>
  {#if hidden}<p class="muted note">{hidden}</p>{/if}

  {#if promoteStageProblem}<Alert tone="error" ondismiss={() => (promoteStageProblem = '')}>{promoteStageProblem}</Alert>{/if}

  <div class="body" id="{uid}-body">
    {#if current === 'build'}
      <StepBuild
        {api}
        {workspaceId}
        {role}
        {app}
        {view}
        {editable}
        {editableState}
        {candidates}
        {candidatesState}
        {sourceCandidates}
        {appBuilds}
        bind:track
        bind:source
        {promote}
        onread={readBuilds}
        onreadtracks={readTracks}
      />
    {:else if current === 'notes'}
      <StepNotes {api} {workspaceId} {role} {app} {view} {editable} {candidates} {chosenBuildId} track={releaseTrack} {locales} {promote} {promoteNotes} bind:drafts bind:extra />
    {:else if current === 'assets'}
      <StepAssets {api} {workspaceId} {app} {view} {scope} />
    {:else if current === 'review'}
      <StepReview {api} {workspaceId} {role} {app} confirmVisible={visible.indexOf('confirm') >= 0} />
    {:else if current === 'confirm'}
      <StepConfirm
        {api}
        {workspaceId}
        {role}
        {app}
        {releases}
        {apple}
        version={releaseVersion}
        track={releaseTrack}
        codes={stagedCodes === null ? [] : stagedCodes.value.split(',').filter((c) => c !== '')}
        stagedShare={stagedShare ? stagedShare.value : ''}
        onreleased={() => void loadPipeline()}
      />
    {:else}
      <Alert tone="info">No step is available for your role.</Alert>
    {/if}
  </div>

  <footer class="foot">
    {#if back}<Button onclick={() => onstep(back)}>Back</Button>{/if}
    <span class="spacer"></span>
    {#if next}<Button variant="primary" onclick={() => onstep(next)}>Next</Button>{:else}<Button onclick={onclose}>Close</Button>{/if}
  </footer>
</section>

<style>
  /* The step tiles, the step's own buttons (.step-actions) and Back/Next stay in view; only the step's content scrolls. */
  .stepper {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 4rem); /* until fitToViewport has measured */
    overflow: hidden;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .head,
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  h3 {
    margin: 0;
  }

  h3 {
    font-size: var(--text-lg);
  }

  .spacer {
    flex: 1;
  }

  .note,
  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .steps {
    display: grid;
    /* Five equal columns that may shrink (minmax 0), so nothing leaks out of a card; on a narrow page 2 or 1 per row. */
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .step {
    display: grid;
    grid-template-rows: auto auto minmax(2.5em, auto);
    gap: var(--space-1);
    align-content: start;
    width: 100%;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    white-space: normal;
    padding: var(--space-2) var(--space-3);
    text-align: left;
    cursor: pointer;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .step.current {
    background: var(--surface);
    border-color: var(--accent);
  }

  .label {
    min-width: 0;
    overflow: hidden;
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .num {
    color: var(--muted);
  }

  .word {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  /* The card says it in a few words (two lines at most, the full text on hover); the details are in the panel below. */
  .text {
    display: -webkit-box;
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-sm);
    color: var(--muted);
    overflow-wrap: anywhere;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  @media (max-width: 1099px) {
    .steps {
      grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    }
  }

  .dot {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    background: var(--muted);
    border-radius: 50%;
  }

  .dot.ok {
    background: var(--ok);
  }

  .dot.info {
    background: var(--info);
  }

  .dot.warn {
    background: var(--warn);
  }

  .dot.bad {
    background: var(--bad);
  }

  .stepper > * {
    flex: none;
  }

  .body {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 12rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

</style>
