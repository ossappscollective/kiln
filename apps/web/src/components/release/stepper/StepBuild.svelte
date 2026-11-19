<!--
  StepBuild: the first step of "Prepare release". App Store and Mac App Store: pick the build of the version in Prepare
  for Submission from the builds App Store Connect lists, each with its number, its date and the CI run that made it.
  A build that cannot be chosen is still listed, disabled, with the plain sentence the server gave (never just "not
  eligible"). Google Play: promote what is in one track to another: the version codes of the source track, the target
  track, and the share of users you intend (kept here only; you name the share again when you release).
  Choosing only STAGES the field in our own database (docs/api/releases-write.md). Nothing reaches a store here.
  Props: api, workspaceId, role, app, view (the staged changes), editable + editableState (the read of the editable
  release), candidates + candidatesState (the read of the builds or codes), appBuilds (our CI builds, for the run of each
  build), track (bindable; Google Play target), source (bindable; Google Play source track), onread (read again),
  onreadtracks (Google Play: read the tracks the person named).
-->
<script lang="ts">
  import { type Role, isApplePlatform } from '@mrm/core';
  import type { Api } from '../../../lib/api.ts';
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
    noCodeSentence,
  } from '../../../lib/release-candidates.ts';
  import { type EditableState, stagedField } from '../../../lib/release-stepper.ts';
  import { parsePercent, percentFromFraction, percentText } from '../../../lib/store-release.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import type { AppBuild, AppSummary } from '../../../lib/types.ts';
  import type { StagedChangesView } from '@mrm/core';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import InfoTip from '../../ui/InfoTip.svelte';
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
    onread,
    onreadtracks,
  }: {
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
    onread: () => void;
    onreadtracks: () => void;
  } = $props();

  const uid = $props.id();
  const apple = $derived(isApplePlatform(app.platform));
  const mayEdit = $derived(canStage(role));

  let picked = $state('');
  let pickedCodes = $state<string[]>([]);
  let shareText = $state('');
  let staging = $state(false);
  let problem = $state('');
  let done = $state('');

  const applePart = $derived(candidates !== null && candidates.store === 'appstoreconnect' ? (candidates as AppleCandidates) : null);
  const playPart = $derived(candidates !== null && candidates.store === 'googleplay' ? (candidates as PlayCandidates) : null);
  const rows = $derived(applePart ? buildRows(applePart.builds, appBuilds) : []);
  const none = $derived(applePart ? noBuildSentence(applePart.builds, applePart.version?.versionString ?? null) : null);
  const stagedBuild = $derived(stagedField(view, 'build'));
  const attachedId = $derived(applePart?.attachedBuildId ?? (editable && editable.store === 'appstoreconnect' ? (editable.build?.id ?? null) : null));
  const chosenId = $derived(stagedBuild !== null ? stagedBuild.value : attachedId);

  const codes = $derived(playPart ? codeRows(playPart.codes, sourceCandidates ? codesInTrack(sourceCandidates.codes) : []) : []);
  const noCodes = $derived(playPart ? noCodeSentence(codes, track) : null);
  const stagedCodes = $derived(stagedField(view, 'version_codes'));
  const stagedTrack = $derived(stagedField(view, 'track'));
  const stagedShare = $derived(stagedField(view, 'user_fraction'));
  const draft = $derived(editable && editable.store === 'googleplay' ? editable.draft : null);
  const fraction = $derived(parsePercent(shareText));
  const trackOk = $derived(isTrackName(track));
  const sourceOk = $derived(source.trim() === '' || isTrackName(source));

  $effect(() => {
    // Start from what is staged, so coming back shows the person's choice.
    if (stagedBuild !== null && picked === '') picked = stagedBuild.value;
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
    <p class="lead">
      Choose the build to attach to
      {#if editable && editable.store === 'appstoreconnect'}version <strong>{editable.version.versionString ?? 'in Prepare for Submission'}</strong>{:else}the version in Prepare for Submission{/if}.
      {#if chosenId !== null && stagedBuild !== null}<Badge tone="info">Staged</Badge>{:else if chosenId !== null}<Badge tone="ok" icon="check">In the store draft</Badge>{/if}
    </p>

    {#if editableState.state === 'none'}
      <Alert tone="warn" title="No version is in Prepare for Submission">
        App Store Connect has no version a build can be attached to. Create the next version in App Store Connect, sync this app, then read again here.
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
      {#if none}<Alert tone="warn" title="No build can be chosen yet">{none}</Alert>{/if}
      {#if rows.length > 0}
        <fieldset class="builds" disabled={!mayEdit || staging}>
          <legend class="visually-hidden">Builds</legend>
          {#each rows as row (row.id)}
            <label class="build" class:off={!row.eligibility.selectable} class:on={picked === row.id}>
              <input type="radio" name="{uid}-build" value={row.id} bind:group={picked} disabled={!row.eligibility.selectable} />
              <span class="body">
                <span class="title">
                  <strong>{row.title}</strong>
                  {#if row.version}<span class="muted">version {row.version}</span>{/if}
                  <Badge tone={row.eligibility.tone === 'warn' ? 'warn' : row.eligibility.tone === 'bad' ? 'bad' : row.eligibility.tone === 'ok' ? 'ok' : 'neutral'}>{row.eligibility.label}</Badge>
                  {#if row.id === attachedId}<Badge tone="ok" icon="check">In the store draft</Badge>{/if}
                  {#if stagedBuild !== null && row.id === stagedBuild.value}<Badge tone="info">Staged</Badge>{/if}
                </span>
                <span class="meta">
                  Uploaded {row.uploaded}.
                  {#if row.run.url}Made by <a href={row.run.url} target="_blank" rel="noreferrer">{row.run.text}</a>.{:else}{row.run.text}{/if}
                </span>
                <span class="sentence" class:bad={row.eligibility.tone === 'bad'}>{row.eligibility.sentence}</span>
              </span>
            </label>
          {/each}
        </fieldset>
        {#if applePart.truncatedAt !== null}<p class="muted small">Only the newest {applePart.truncatedAt} builds are listed.</p>{/if}
      {/if}

      <div class="row">
        {#if mayEdit}
          <Button variant="primary" loading={staging} disabled={picked === '' || staging || picked === (stagedBuild?.value ?? '') || rows.every((r) => r.id !== picked || !r.eligibility.selectable)} onclick={stageBuild}>
            Use this build
          </Button>
        {:else}
          <span class="muted small">Staging needs the member role or above.</span>
        {/if}
        <Button size="sm" icon="refresh" disabled={staging} onclick={onread}>Read the builds again</Button>
        <InfoTip label="About choosing a build" text="Choosing a build stages it in this tool. It reaches App Store Connect only when you push the draft in the last step." />
      </div>
    {/if}
  {:else}
    <p class="lead">
      Promote what is in one track to another. Choose the track to read from, the track to release in, and the version codes.
      {#if stagedCodes !== null}<Badge tone="info">Staged</Badge>{:else if draft !== null && draft.versionCodes.length > 0}<Badge tone="ok" icon="check">In the store draft</Badge>{/if}
    </p>

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
          {#each codes as row (row.versionCode)}
            <label class="build" class:off={!row.eligibility.selectable} class:on={pickedCodes.indexOf(row.versionCode) >= 0}>
              <input
                type="checkbox"
                checked={pickedCodes.indexOf(row.versionCode) >= 0}
                disabled={!row.eligibility.selectable}
                onchange={(e) => toggleCode(row.versionCode, e.currentTarget.checked)}
              />
              <span class="body">
                <span class="title">
                  <strong>Version code {row.versionCode}</strong>
                  <span class="muted">{row.source}</span>
                  <Badge tone={row.eligibility.tone === 'warn' ? 'warn' : row.eligibility.tone === 'bad' ? 'bad' : row.eligibility.tone === 'ok' ? 'ok' : 'neutral'}>{row.eligibility.label}</Badge>
                  {#if row.inSource}<Badge tone="info">In {source}</Badge>{/if}
                </span>
                {#if row.where}<span class="meta">Held by: {row.where}.</span>{/if}
                <span class="sentence" class:bad={row.eligibility.tone === 'bad'}>{row.eligibility.sentence}</span>
              </span>
            </label>
          {/each}
        </fieldset>
      {/if}

      <div class="field share">
        <label for="{uid}-share">
          Intended share of users (%)
          <InfoTip label="About the intended share" text="Google Play cannot hold a share in a draft. This is a note kept here only. When you release, you type the share again, and that is what is used." />
        </label>
        <input id="{uid}-share" type="text" inputmode="decimal" autocomplete="off" placeholder="Optional, for example 10" bind:value={shareText} disabled={!mayEdit || staging} />
        {#if shareText.trim() !== '' && fraction === null}<p class="small bad">Type a number from 0.01 to 100.</p>{/if}
      </div>

      <div class="row">
        {#if mayEdit}
          <Button variant="primary" loading={staging} disabled={pickedCodes.length === 0 || !trackOk || staging || (shareText.trim() !== '' && fraction === null)} onclick={stageCodes}>
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
  .lead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .builds {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .build {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3);
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .build.on {
    border-color: var(--accent);
  }

  .build.off {
    cursor: default;
    background: var(--surface-sunken);
  }

  .body {
    display: grid;
    flex: 1;
    gap: var(--space-1);
    min-width: 0;
  }

  .title {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .meta {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .sentence {
    font-size: var(--text-sm);
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
