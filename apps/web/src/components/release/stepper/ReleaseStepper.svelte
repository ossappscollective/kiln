<!--
  ReleaseStepper: "Prepare release" for ONE app record: Build, Notes, Assets, Review, Confirm. The steps are a rail on the left (number or
  check, name, one line of status; the current one highlighted, and a word for assistive technology, never colour alone), the step on the
  right (one heading, one sentence, the choices), and a footer that always sits at the bottom: Back, "Step N of M" and the ONE primary
  button, named after the next step ("Next: Notes"); on the last step it is "Review and publish" (lib/stepper-layout.ts). The steps only STAGE changes in our own database; nothing reaches a store when a step
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
  import { type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../../lib/api.ts';
  import { fitToViewport } from '../../../lib/fit-viewport.ts';
  import { invalidate } from '../../../lib/facts/invalidate.ts';
  import { readCache } from '../../../lib/read-cache.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import type { PlatformScope } from '../../../lib/app-scope.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import { type EditableRelease, type ReleaseCandidates, type PlayCandidates, type BuildCandidate, type ChosenBuildLine, chosenBuildLine, chosenCodeLines } from '../../../lib/release-candidates.ts';
  import { type Promote } from '../../../lib/play-promote.ts';
  import type { StepPrefill } from '../../../lib/release-stepper.ts';
  import { type PromoteNotesState, noteRows, promoteNotesFill, unsavedLocales } from '../../../lib/release-notes.ts';
  import type { PendingItem } from '../../../lib/pending.ts';
  import { type AppPipeline } from '../../../lib/release-pipeline.ts';
  import {
    type EditableState,
    type StepId,
    LEVEL_WORD,
    chosenOf,
    confirmHiddenReason,
    resolveStep,
    stagedFacts,
    stagedField,
    stagedNotes,
    stepStatuses,
    storeNotes,
    visibleSteps } from '../../../lib/release-stepper.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { pendingStore } from '../../../lib/pending-store.svelte.ts';
  import { confirmSteps, footerFor, railMark, stepIntro } from '../../../lib/stepper-layout.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import { canSubmit } from '../../../lib/store-submit.ts';
  import { submitStore } from '../../../lib/store-submit-store.svelte.ts';
  import { canRelease } from '../../../lib/store-release.ts';
  import { releaseStore } from '../../../lib/store-release-store.svelte.ts';
  import type { AppBuild, AppSummary, ReleaseSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
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
    prefill = null,
    onstep,
    onclose,
    showPlatform = false }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    scope: PlatformScope | null;
    appBuilds: AppBuild[];
    releases: Record<string, ReleaseSummary[]>;
    step: StepId | null;
    promote?: Promote | null;
    /** App Store: the version and the build "Create release" starts from (the address), or null. */
    prefill?: StepPrefill | null;
    onstep: (next: StepId) => void;
    onclose: () => void;
    showPlatform?: boolean;
  } = $props();

  const uid = $props.id();
  const apple = $derived(!supports(app.platform, 'releaseTracks'));

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
    release: canRelease(role) ? (releaseStore.config(workspaceId)?.enabled ?? null) : null });
  const visible = $derived(visibleSteps(role, switches));
  const current = $derived(resolveStep(step, visible));
  const hidden = $derived(confirmHiddenReason(role, switches));

  const playCodes = $derived(candidates !== null && candidates.store === 'googleplay' ? candidates.codes : []);
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
  const chosen = $derived(chosenOf({ platform: app.platform, view, editable, builds: buildList, codes: playCodes }));
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
        pipeline: pipeline ? { state: pipeline.pipeline.state, waitingOn: pipeline.pipeline.waitingOn } : null },
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
  /** Google Play: the name of the release being made (staged, else the store draft's); only a version it says is set against the version of a chosen build. */
  const releasingName = $derived(stagedField(view, 'release_name')?.value ?? (editable && editable.store === 'googleplay' ? (editable.draft?.name ?? null) : null));
  /** The chosen build(s) with their version and date, for the Confirm step (and the warning when the version is not the one being released). */
  const chosenLines = $derived.by((): ChosenBuildLine[] => {
    if (apple) {
      const line = chosenBuildLine(buildList.filter((b) => b.id === chosenBuildId)[0], releaseVersion);
      return line === null ? [] : [line];
    }
    const wanted = stagedCodes !== null ? stagedCodes.value.split(',').filter((c) => c !== '') : editable && editable.store === 'googleplay' && editable.draft ? editable.draft.versionCodes.map(String) : [];
    return chosenCodeLines(wanted, playCodes, releasingName);
  });
  /** The build number chosen for this release (App Store): its commit is the source of the release for the asset proposal. */
  const releaseBuildNumber = $derived.by((): string | null => {
    if (supports(app.platform, 'releaseTracks')) return null;
    const staged = stagedField(view, 'build');
    if (staged !== null) return buildList.filter((b) => b.id === staged.value)[0]?.buildNumber ?? null;
    return editable && editable.store === 'appstoreconnect' ? (editable.build?.buildNumber ?? null) : null;
  });

  async function loadEditable(force = false) {
    const mine = seq;
    editableState = { state: 'loading' };
    try {
      const out = await readCache.read({
        workspaceId,
        group: 'store',
        key: `editable/${app.id}/${apple ? '' : track.trim()}`,
        force,
        load: () => api.releaseEditable(workspaceId, app.id, apple ? undefined : track.trim()) });
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
      promoteStageProblem = stagingError(e);
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
        platform: app.platform });
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
        load: () => api.releaseCandidates(workspaceId, app.id, apple ? {} : { track: track.trim() }) });
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
        load: () => api.releaseCandidates(workspaceId, app.id, { track: source.trim() }) });
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
      void pendingStore.loadView(api, workspaceId, app.id);
    });
  });

  const pendingView = $derived(pendingStore.view(app.id));
  /** What the Confirm step will write, in order (null until what is pending was read). */
  const confirmList = $derived(
    pendingView === null ? null : confirmSteps(pendingView.platforms.reduce<PendingItem[]>((all, p) => all.concat(p.items), []), app.platform),
  );
  const intro = $derived(
    current === null
      ? null
      : stepIntro(current, {
          platform: app.platform,
          version: releaseVersion,
          chosen,
          notes: { withText: rows.filter((r) => r.draft.trim() !== '').length },
          staged: stagedFacts(view),
          confirm: confirmList,
          inReview: pipeline?.pipeline.state === 'in_review' }),
  );
  const footer = $derived(current === null ? null : footerFor(current, visible));
  let confirmStep = $state<ReturnType<typeof StepConfirm> | undefined>();
  const publishState = $derived(footer !== null && footer.primary.kind === 'publish' && confirmStep ? confirmStep.publishState() : { enabled: true, reason: '' });
</script>

<section class="stepper" aria-label={t('release-stepper:rs.aria', { platform: platformLabel(app.platform) })} data-testid="release-stepper" use:fitToViewport={{ margin: 16, min: 420, fill: true }}>
  <header class="head">
    <h3>{t('release-stepper:rs.title')}</h3>
    {#if showPlatform}<PlatformBadge platform={app.platform} />{/if}
    {#if releaseVersion}<span class="muted">{t('release-stepper:sb.version', { version: releaseVersion })}</span>{/if}
    <span class="spacer"></span>
    <Button size="sm" variant="ghost" icon="x" onclick={onclose}>{t('common:action.close')}</Button>
  </header>

  <div class="shell">
    <nav class="rail" aria-label={t('release-stepper:rs.steps')}>
      <ol class="steps">
        {#each statuses as s, i (s.id)}
          {@const mark = railMark(s.level, current === s.id)}
          <li>
            <button type="button" class="step" class:current={current === s.id} aria-current={current === s.id ? 'step' : undefined} onclick={() => onstep(s.id)}>
              <span class="mark {mark}" aria-hidden="true">{#if mark === 'done'}<Icon name="check" size={14} />{:else if mark === 'optional'}{:else}{i + 1}{/if}</span>
              <span class="what">
                <span class="label">{s.label}<span class="visually-hidden">{t('release-stepper:rs.stepOf', { index: i + 1, total: statuses.length, level: t(LEVEL_WORD[s.level]) })}</span></span>
                <span class="text" title={s.text}>{s.text}</span>
              </span>
            </button>
          </li>
        {/each}
      </ol>
      <p class="muted foot-note">{t('release-stepper:rs.nothingSent')}</p>
      {#if hidden}<p class="muted foot-note">{hidden}</p>{/if}
    </nav>

    <div class="main">
      {#if promoteStageProblem}<div class="problem"><Alert tone="error" ondismiss={() => (promoteStageProblem = '')}>{t('release-stepper:rs.promoteStageFailed', { detail: promoteStageProblem })}</Alert></div>{/if}

      <div class="body" id="{uid}-body">
        {#if intro}
          <div class="intro">
            <h4 id="{uid}-title">{intro.title}</h4>
            <p>{intro.sentence}</p>
          </div>
        {/if}
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
            {prefill}
            onread={readBuilds}
            onreadtracks={readTracks}
          />
        {:else if current === 'notes'}
          <StepNotes {api} {workspaceId} {role} {app} {view} {editable} {candidates} {chosenBuildId} track={releaseTrack} {locales} {promote} {promoteNotes} bind:drafts bind:extra />
        {:else if current === 'assets'}
          <StepAssets {api} {workspaceId} {role} {app} {view} {scope} release={{ version: releaseVersion, track: supports(app.platform, 'releaseTracks') ? releaseTrack || null : null, build: releaseBuildNumber }} />
        {:else if current === 'review'}
          <StepReview {api} {workspaceId} {role} {app} />
        {:else if current === 'confirm'}
          <StepConfirm
            bind:this={confirmStep}
            {api}
            {workspaceId}
            {role}
            {app}
            steps={confirmList}
            {releases}
            {apple}
            version={releaseVersion}
            track={releaseTrack}
            codes={stagedCodes === null ? [] : stagedCodes.value.split(',').filter((c) => c !== '')}
            {chosenLines}
            stagedShare={stagedShare ? stagedShare.value : ''}
            inReview={pipeline?.pipeline.state === 'in_review'}
            onreleased={() => {
              // The release started: the pipeline, the candidates and the store reads kept for the app are old (`invalidate` forgets them), then read.
              void invalidate('release_created', { workspaceId, appId: app.id });
              void loadPipeline();
            }}
          />
        {:else}
          <Alert tone="info">{t('release-stepper:rs.noStep')}</Alert>
        {/if}
      </div>

      {#if footer}
        <footer class="foot" data-testid="stepper-footer">
          <Button disabled={footer.back === null} onclick={() => footer.back !== null && onstep(footer.back)}>{t('common:action.back')}</Button>
          <span class="position muted">{footer.position}</span>
          <span class="spacer"></span>
          {#if footer.primary.kind === 'publish' && !publishState.enabled && publishState.reason}<span class="reason muted" data-testid="stepper-why">{publishState.reason}</span>{/if}
          {#if footer.primary.kind === 'step'}
            {@const to = footer.primary.to}
            <Button variant="primary" size="lg" onclick={() => onstep(to)}>{footer.primary.label}</Button>
          {:else if footer.primary.kind === 'publish'}
            <Button variant="primary" size="lg" icon="upload" disabled={!publishState.enabled} onclick={() => confirmStep?.publish()}>{footer.primary.label}</Button>
          {:else}
            <Button variant="primary" size="lg" onclick={onclose}>{footer.primary.label}</Button>
          {/if}
        </footer>
      {/if}
    </div>
  </div>
</section>

<style>
  /* The rail, the step's own buttons and the footer (Back, Step N of M, the primary) stay in view; only the step's content scrolls. */
  .stepper {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 4rem); /* until fitToViewport has measured */
    overflow: hidden;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  h3 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .spacer {
    flex: 1;
  }

  .stepper > * {
    flex: none;
  }

  .stepper > .shell {
    flex: 1 1 auto;
    min-height: 0;
  }

  .shell {
    display: flex;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .rail {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--space-3);
    width: 16.5rem;
    padding: var(--space-4) var(--space-3);
    overflow-y: auto;
    background: var(--surface-sunken);
    border-inline-end: 1px solid var(--line);
  }

  .steps {
    display: grid;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .step {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    width: 100%;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    text-align: left;
    white-space: normal;
    cursor: pointer;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-lg);
  }

  .step:hover {
    background: var(--surface-hover);
  }

  .step.current {
    background: var(--accent-bg);
    border-color: var(--accent);
  }

  .mark {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 1.5rem;
    height: 1.5rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
    border: 2px solid var(--line-strong);
    border-radius: 50%;
  }

  .mark.current {
    color: var(--accent-ink);
    background: var(--accent);
    border-color: var(--accent);
  }

  .mark.done {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }

  .mark.attention {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }

  .mark.blocked {
    color: var(--bad-ink);
    background: var(--bad-bg);
    border-color: var(--bad);
  }

  .mark.optional {
    border-style: dashed;
  }

  .what {
    display: grid;
    min-width: 0;
  }

  .label {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  /* One line of status; the full text is on hover. */
  .text {
    overflow: hidden;
    font-size: var(--text-sm);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step.current .text {
    white-space: normal;
  }

  .foot-note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface);
  }

  .problem {
    flex: none;
    padding: var(--space-3) var(--space-8) 0;
  }

  .body {
    display: grid;
    flex: 1 1 auto;
    align-content: start;
    gap: var(--space-5);
    min-width: 0;
    min-height: 12rem;
    padding: var(--space-6) var(--space-8);
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: var(--text-md);
  }

  .intro h4 {
    margin: 0;
    font-size: var(--text-2xl);
    line-height: 1.2;
  }

  .intro p {
    margin: var(--space-2) 0 0;
    font-size: var(--text-md);
    color: var(--muted);
  }

  .foot {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-4) var(--space-8);
    background: var(--surface);
    border-top: 1px solid var(--line);
  }

  .position,
  .reason {
    font-size: var(--text-sm);
  }

  @media (max-width: 859px) {
    .shell {
      flex-direction: column;
    }

    .rail {
      width: auto;
      padding: var(--space-2);
      overflow: auto hidden;
      border-inline-end: 0;
      border-bottom: 1px solid var(--line);
    }

    .steps {
      grid-auto-flow: column;
      grid-auto-columns: minmax(10rem, 1fr);
    }

    .foot-note {
      display: none;
    }

    .body,
    .foot,
    .problem {
      padding-inline: var(--space-4);
    }
  }
</style>
