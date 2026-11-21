<!--
  StepBuild: the first step of "Prepare release". App Store and Mac App Store: pick the build of the version in Prepare
  for Submission from the builds App Store Connect lists, each with its number, its date and the CI run that made it.
  A build that cannot be chosen is still listed, disabled, with the plain sentence the server gave (never just "not
  eligible"). Google Play: promote what is in one track to another: the version codes of the source track, the target
  track, and the share of users you intend (kept here only; you name the share again when you release).
  The list is compact: one line per build (number, version, uploaded, ONE state chip), the one to start from first and highlighted,
  the newest three with "Show all". The long sentence, the CI run, "Install to test" and the TestFlight line sit behind "Details of the
  selected build", which opens by itself only when the selected build has a real problem (lib/stepper-layout.ts).
  Choosing only STAGES the field in our own database (docs/api/releases-write.md). Nothing reaches a store here.
  Props: api, workspaceId, role, app, view (the staged changes), editable + editableState (the read of the editable
  release), candidates + candidatesState (the read of the builds or codes), appBuilds (our CI builds, for the run of each
  build), track (bindable; Google Play target), source (bindable; Google Play source track), promote? (Google Play: the codes
  of a release being promoted, selected once), onread (read again),
  onreadtracks (Google Play: read the tracks the person named).
-->
<script lang="ts">
  import { can, type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { buildNumberOfTitle, testBuildsHref } from '../../../lib/builds.ts';
  import {
    type AppleCandidates,
    type EditableRelease,
    type PlayCandidates,
    type ReleaseCandidates,
    SUGGESTED_TRACKS,
    buildRows,
    codeRows,
    codesInTrack,
    isTrackName,
    noBuildSentence,
    noCodeSentence } from '../../../lib/release-candidates.ts';
  import { type EditableState, stagedField } from '../../../lib/release-stepper.ts';
  import { type Promote, promoteNote } from '../../../lib/play-promote.ts';
  import { buildChip, buildHasProblem, orderBuilds, visibleBuilds } from '../../../lib/stepper-layout.ts';
  import { releaseInputsFor } from '../../../lib/release-settings.ts';
  import { releaseSettingsStore } from '../../../lib/release-settings-store.svelte.ts';
  import { parsePercent, percentFromFraction, percentText } from '../../../lib/store-release.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import type { AppBuild, AppSummary } from '../../../lib/types.ts';
  import type { StagedChangesView } from '@kiln/core';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import Disclosure from '../../ui/Disclosure.svelte';
  import InfoTip from '../../ui/InfoTip.svelte';
  import CreateVersion from './CreateVersion.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    view,
    editable,
    editableState,
    candidates,
    candidatesState,
    sourceCandidates = null,
    appBuilds,
    track = $bindable('production'),
    source = $bindable('beta'),
    promote = null,
    onread,
    onreadtracks }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    view: StagedChangesView | null;
    editable: EditableRelease | null;
    editableState: EditableState;
    candidates: ReleaseCandidates | null;
    candidatesState: EditableState;
    sourceCandidates?: PlayCandidates | null;
    appBuilds: AppBuild[];
    track?: string;
    source?: string;
    promote?: Promote | null;
    onread: () => void;
    onreadtracks: () => void;
  } = $props();

  const uid = $props.id();
  const apple = $derived(!supports(app.platform, 'releaseTracks'));
  const mayEdit = $derived(canStage(role));
  const canTest = $derived(can(role, 'builds.read'));

  let picked = $state('');
  let pickedCodes = $state<string[]>([]);
  let shareText = $state('');
  let staging = $state(false);
  let problem = $state('');
  let done = $state('');
  let showAll = $state(false);
  let showAllCodes = $state(false);

  const applePart = $derived(candidates !== null && candidates.store === 'appstoreconnect' ? (candidates as AppleCandidates) : null);
  const playPart = $derived(candidates !== null && candidates.store === 'googleplay' ? (candidates as PlayCandidates) : null);
  const rows = $derived(applePart ? buildRows(applePart.builds, appBuilds) : []);
  const none = $derived(applePart ? noBuildSentence(applePart.builds, applePart.version?.versionString ?? null) : null);
  const stagedBuild = $derived(stagedField(view, 'build'));
  const attachedId = $derived(applePart?.attachedBuildId ?? (editable && editable.store === 'appstoreconnect' ? (editable.build?.id ?? null) : null));
  const chosenId = $derived(stagedBuild !== null ? stagedBuild.value : attachedId);

  const ordered = $derived(orderBuilds(rows, chosenId));
  const listed = $derived(visibleBuilds(ordered.rows, { showAll, pickedId: picked }));
  const selectedRow = $derived(rows.filter((r) => r.id === (picked !== '' ? picked : (chosenId ?? ordered.firstId ?? '')))[0]);
  const problemOpen = $derived(buildHasProblem(selectedRow));
  const unstaged = $derived(picked !== '' && picked !== (stagedBuild?.value ?? '') && picked !== attachedId);

  const codes = $derived(playPart ? codeRows(playPart.codes, sourceCandidates ? codesInTrack(sourceCandidates.codes) : []) : []);
  const noCodes = $derived(playPart ? noCodeSentence(codes, track) : null);
  const stagedCodes = $derived(stagedField(view, 'version_codes'));
  const stagedTrack = $derived(stagedField(view, 'track'));
  const stagedShare = $derived(stagedField(view, 'user_fraction'));
  const draft = $derived(editable && editable.store === 'googleplay' ? editable.draft : null);
  // The intended share starts from the staged one, else the default of the app; it is not asked when Google Play offers no staged
  // rollout (the first release in production, or the app setting says never). The person can change it; nothing is confirmed here.
  const inputs = $derived(releaseInputsFor({ view: releaseSettingsStore.get(app.id), track, stagedPercent: stagedShare ? percentFromFraction(stagedShare.value) : '' }));
  const offered = $derived(inputs.offer.offered);
  const fraction = $derived(offered ? parsePercent(shareText) : null);
  const shownCodes = $derived(showAllCodes ? codes : codes.slice(0, 3));
  const trackOk = $derived(isTrackName(track));
  const sourceOk = $derived(source.trim() === '' || isTrackName(source));

  let promoted = false;
  $effect(() => {
    // "Promote to production": the codes of the release being promoted are selected once, ahead of what was staged before.
    if (promote !== null && !promoted) {
      promoted = true;
      pickedCodes = [...promote.codes];
    }
  });
  $effect(() => {
    // Start from what is staged, so coming back shows the person's choice.
    if (stagedBuild !== null && picked === '') picked = stagedBuild.value;
  });
  $effect(() => {
    if (!apple) void releaseSettingsStore.load(api, workspaceId, app.id);
  });
  $effect(() => {
    const start = inputs.share;
    if (!apple && inputs.offer.offered && start !== '' && untrack(() => shareText) === '') shareText = start;
  });
  $effect(() => {
    if (stagedCodes !== null && pickedCodes.length === 0) pickedCodes = stagedCodes.value.split(',').filter((c) => c !== '');
    if (stagedShare !== null && shareText === '') shareText = percentFromFraction(stagedShare.value);
  });

  function toggleCode(code: string, on: boolean) {
    pickedCodes = on ? [...pickedCodes, code].sort((a, b) => Number(a) - Number(b)) : pickedCodes.filter((c) => c !== code);
  }

  async function stageBuild() {
    if (picked === '' || staging) return;
    staging = true;
    problem = '';
    done = '';
    try {
      const out = await api.stageReleaseField(workspaceId, app.id, { field: 'build', value: picked });
      stagedStore.set(out.staged);
      const row = rows.filter((r) => r.id === picked)[0];
      done = `${row ? row.title : 'The build'} is staged for this release. Nothing was sent to the store.`;
    } catch (e) {
      problem = stagingError(e);
    } finally {
      staging = false;
    }
  }

  async function stageCodes() {
    if (pickedCodes.length === 0 || !trackOk || staging) return;
    staging = true;
    problem = '';
    done = '';
    try {
      // One field per request: the track first (the codes need it), then the codes, then the intended share if one was typed.
      let out = await api.stageReleaseField(workspaceId, app.id, { field: 'track', value: track.trim() });
      out = await api.stageReleaseField(workspaceId, app.id, { field: 'version_codes', value: pickedCodes.join(',') });
      if (fraction !== null) out = await api.stageReleaseField(workspaceId, app.id, { field: 'user_fraction', value: String(fraction) });
      stagedStore.set(out.staged);
      done = `Version codes ${pickedCodes.join(', ')} are staged for ${track.trim()}${fraction !== null ? ` at ${percentText(fraction)} (kept here only)` : ''}. Nothing was sent to the store.`;
    } catch (e) {
      problem = stagingError(e);
      void stagedStore.load(api, workspaceId, app.id);
    } finally {
      staging = false;
    }
  }
</script>

<div class="stack">
  {#if apple}
    {#if editableState.state === 'none'}
      <Alert tone="warn" title="No version is in Prepare for Submission">
        <CreateVersion {api} {workspaceId} {role} {app} {onread} />
      </Alert>
    {:else if editableState.state === 'error'}
      <Alert tone="error" title="Could not read the version">{editableState.message}</Alert>
    {/if}

    {#if candidatesState.state === 'loading'}
      <div role="status" aria-label="Reading the builds"><Skeleton width="70%" height="16px" /></div>
    {:else if candidatesState.state === 'error'}
      <Alert tone="error" title="Could not read the builds">
        {candidatesState.message}
        <div class="retry"><Button size="sm" icon="refresh" onclick={onread}>Try again</Button></div>
      </Alert>
    {:else if applePart}
      {#if none && editableState.state !== 'none'}<Alert tone="warn" title="No build can be chosen yet">{none}</Alert>{/if}
      {#if rows.length > 0}
        <fieldset class="builds" disabled={!mayEdit || staging}>
          <legend class="visually-hidden">Builds</legend>
          {#each listed.shown as row (row.id)}
            {@const chip = buildChip(row, { attached: row.id === attachedId, staged: stagedBuild !== null && row.id === stagedBuild.value })}
            <label class="build" class:off={!row.eligibility.selectable} class:on={picked === row.id || (picked === '' && row.id === ordered.firstId)} data-testid="build-row">
              <input type="radio" name="{uid}-build" value={row.id} bind:group={picked} disabled={!row.eligibility.selectable} />
              <span class="num">{row.title}</span>
              <span class="ver">{#if row.version}version {row.version}{/if}</span>
              <span class="when">Uploaded {row.uploaded}</span>
              <Badge tone={chip.tone} icon={chip.tone === 'ok' ? 'check' : undefined}>{chip.text}</Badge>
            </label>
          {/each}
        </fieldset>
        <p class="muted small more">
          {#if listed.hidden > 0}Showing {listed.shown.length} of {rows.length} builds. <button type="button" class="link" onclick={() => (showAll = true)}>Show all</button>{:else if showAll && rows.length > 3}Showing all {rows.length} builds. <button type="button" class="link" onclick={() => (showAll = false)}>Show fewer</button>{:else}{rows.length === 1 ? '1 build' : `${rows.length} builds`}.{/if}
          {#if applePart.truncatedAt !== null}Only the newest {applePart.truncatedAt} are listed.{/if}
          <button type="button" class="link" disabled={staging} onclick={onread}>Read the builds again</button>
        </p>

        {#if selectedRow}
          <Disclosure summary="Details of the selected build (CI run, install to test, version label)" open={problemOpen} stateKey="stepper-build-details-{app.id}-{selectedRow.id}">
            <div class="details" data-testid="build-details">
              <p class="sentence" class:bad={selectedRow.eligibility.tone === 'bad'}>{selectedRow.eligibility.sentence}</p>
              <p class="meta">
                {#if selectedRow.run.url}Made by <a href={selectedRow.run.url} target="_blank" rel="noreferrer">{selectedRow.run.text}</a>.{:else}{selectedRow.run.text}.{/if}
                {#if canTest}<a href={testBuildsHref(app.id, app.platform, buildNumberOfTitle(selectedRow.title))}>Install to test</a>{/if}
              </p>
              <p class="meta">{selectedRow.testNotes}</p>
            </div>
          </Disclosure>
        {/if}
      {/if}

      <div class="row step-actions">
        {#if !mayEdit}
          <span class="muted small">Staging needs the member role or above.</span>
        {:else if unstaged}
          <Button loading={staging} disabled={staging || rows.every((r) => r.id !== picked || !r.eligibility.selectable)} onclick={stageBuild}>
            Use {selectedRow ? selectedRow.title : 'this build'}
          </Button>
          <span class="muted small">Not used yet. Press the button to keep this choice.</span>
        {/if}
        <InfoTip label="About choosing a build" text="Choosing a build stages it in this tool. It reaches App Store Connect only when you push the draft in the last step." />
      </div>
    {/if}
  {:else}
    {#if promote !== null}<Alert tone="info" title="Promote to {promote.to}">{promoteNote(promote)}</Alert>{/if}
    <div class="tracks">
      <div class="field">
        <label for="{uid}-source">Promote from</label>
        <input id="{uid}-source" type="text" list="{uid}-tracks" autocomplete="off" spellcheck="false" bind:value={source} />
      </div>
      <div class="field">
        <label for="{uid}-track">Release in</label>
        <input id="{uid}-track" type="text" list="{uid}-tracks" autocomplete="off" spellcheck="false" bind:value={track} aria-invalid={!trackOk} />
      </div>
      <datalist id="{uid}-tracks">{#each SUGGESTED_TRACKS as name (name)}<option value={name}></option>{/each}</datalist>
      <Button size="sm" icon="refresh" disabled={!trackOk || !sourceOk} onclick={onreadtracks}>Read the tracks</Button>
    </div>
    {#if !trackOk}<p class="small bad">A track name uses letters, digits and . _ : - only.</p>{/if}

    {#if editableState.state === 'ready' && editable && editable.store === 'googleplay'}
      <p class="muted small">
        {#if draft}The draft release of {track} holds version codes {draft.versionCodes.join(', ') || 'none yet'}.{:else}{track} has no draft release yet. Staging codes creates one when you push.{/if}
      </p>
    {:else if editableState.state === 'error'}
      <Alert tone="error" title="Could not read the track">{editableState.message}</Alert>
    {/if}

    {#if candidatesState.state === 'loading'}
      <div role="status" aria-label="Reading the version codes"><Skeleton width="70%" height="16px" /></div>
    {:else if candidatesState.state === 'error'}
      <Alert tone="error" title="Could not read the version codes">
        {candidatesState.message}
        <div class="retry"><Button size="sm" icon="refresh" onclick={onreadtracks}>Try again</Button></div>
      </Alert>
    {:else if playPart}
      {#if noCodes}<Alert tone="warn" title="No version code can be added yet">{noCodes}</Alert>{/if}
      {#if codes.length > 0}
        <fieldset class="builds" disabled={!mayEdit || staging}>
          <legend class="visually-hidden">Version codes</legend>
          {#each shownCodes as row (row.versionCode)}
            <label class="build" class:off={!row.eligibility.selectable} class:on={pickedCodes.indexOf(row.versionCode) >= 0}>
              <input
                type="checkbox"
                checked={pickedCodes.indexOf(row.versionCode) >= 0}
                disabled={!row.eligibility.selectable}
                onchange={(e) => toggleCode(row.versionCode, e.currentTarget.checked)}
              />
              <span class="num">Version code {row.versionCode}</span>
              <span class="ver">{row.source}{#if row.inSource}, in {source}{/if}</span>
              <span class="when">{#if row.where}Held by {row.where}{/if}{#if canTest}{row.where ? '. ' : ''}<a href={testBuildsHref(app.id, app.platform, row.versionCode)}>Install to test</a>{/if}</span>
              <Badge tone={row.eligibility.tone === 'warn' ? 'warn' : row.eligibility.tone === 'bad' ? 'bad' : row.eligibility.tone === 'ok' ? 'ok' : 'neutral'}>{row.eligibility.label}</Badge>
            </label>
            {#if row.eligibility.tone !== 'ok' || !row.eligibility.selectable}<p class="sentence code-sentence" class:bad={row.eligibility.tone === 'bad'}>{row.eligibility.sentence}</p>{/if}
          {/each}
        </fieldset>
        {#if codes.length > 3}
          <p class="muted small more">{showAllCodes ? `Showing all ${codes.length} version codes.` : `Showing 3 of ${codes.length} version codes.`} <button type="button" class="link" onclick={() => (showAllCodes = !showAllCodes)}>{showAllCodes ? 'Show fewer' : 'Show all'}</button></p>
        {/if}
      {/if}

      {#if !offered}
        <p class="muted small" data-testid="no-staged-rollout">{inputs.offer.message}</p>
      {:else}
      <div class="field share">
        <label for="{uid}-share">
          Intended share of users (%)
          <InfoTip label="About the intended share" text="Google Play cannot hold a share in a draft. This is a note kept here only. When you release, you type the share again, and that is what is used." />
        </label>
        <input id="{uid}-share" type="text" inputmode="decimal" autocomplete="off" placeholder="Optional, for example 10" bind:value={shareText} disabled={!mayEdit || staging} />
        {#if shareText.trim() !== '' && fraction === null}<p class="small bad">Type a number from 0.01 to 100.</p>{/if}
      </div>
      {/if}

      <div class="row step-actions">
        {#if mayEdit}
          <Button loading={staging} disabled={pickedCodes.length === 0 || !trackOk || staging || (offered && shareText.trim() !== '' && fraction === null)} onclick={stageCodes}>
            Use these version codes
          </Button>
        {:else}
          <span class="muted small">Staging needs the member role or above.</span>
        {/if}
        {#if stagedTrack !== null}<span class="muted small">Staged track: {stagedTrack.value}.</span>{/if}
      </div>
    {/if}
  {/if}

  {#if problem}<Alert tone="error" ondismiss={() => (problem = '')}>{problem}</Alert>{/if}
  {#if done}<Alert tone="ok" ondismiss={() => (done = '')}>{done}</Alert>{/if}
</div>

<style>
  .builds {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  /* One line per build: radio, number, version, date, ONE chip. It wraps on a narrow window. */
  .build {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .build.on {
    background: var(--accent-bg);
    border: 2px solid var(--accent);
    padding: calc(var(--space-3) - 1px) calc(var(--space-4) - 1px);
  }

  .build.off {
    cursor: default;
    background: var(--surface-sunken);
  }

  .num {
    min-width: 6.5rem;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .ver {
    min-width: 7rem;
    color: var(--ink);
  }

  .when {
    flex: 1;
    min-width: 8rem;
    color: var(--muted);
  }

  .more {
    margin: 0;
  }

  .link {
    padding: 0;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    background: none;
    border: 0;
  }

  .details {
    display: grid;
    gap: var(--space-2);
  }

  .details p {
    margin: 0;
  }

  .meta {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .sentence {
    font-size: var(--text-base);
  }

  .code-sentence {
    margin: 0;
    padding-inline: var(--space-4);
  }

  .sentence.bad,
  .bad {
    color: var(--bad-ink);
  }

  .tracks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .share {
    max-width: 16rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
