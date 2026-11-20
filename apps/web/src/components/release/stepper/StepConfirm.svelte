<!--
  StepConfirm: the last step of "Prepare release": "Review and publish all" (components/publish): one plan for the steps that wait
  (push the draft, submit for review, release), reviewed once and confirmed with one typed phrase. Under a quiet "Advanced: do one
  step" disclosure the single gated flows are still here, each unchanged: push the draft (StagedTrayApp, push part: typed app name and
  an acknowledgement), submit for review (SubmitReady: typed phrase), release (StoreRelease: typed phrase, and for Google Play the share
  you type) and the rollout controls. They are separate: a push does not submit and a submit does not release.
  On Google Play "Check this release" (PlayCheck) comes first: local checks and "Check with Google Play" (errors only; nothing is saved).
  Props: api, workspaceId, role, app, releases (store releases by app id, for the rollout controls), apple, version (App Store
  marketing version or null), track (Google Play), codes (staged version codes), stagedShare (staged intended share or ''),
  onreleased (called after a successful release).
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import type { Api } from '../../../lib/api.ts';
  import { fractionOf } from '../../../lib/play-check.ts';
  import { canRelease, percentFromFraction } from '../../../lib/store-release.ts';
  import { canSubmit } from '../../../lib/store-submit.ts';
  import type { AppSummary, ReleaseSummary } from '../../../lib/types.ts';
  import StagedTrayApp from '../../listing/StagedTrayApp.svelte';
  import SubmitReady from '../../listing/SubmitReady.svelte';
  import PendingChanges from '../../publish/PendingChanges.svelte';
  import Disclosure from '../../ui/Disclosure.svelte';
  import RolloutControls from '../RolloutControls.svelte';
  import PlayCheck from './PlayCheck.svelte';
  import StoreRelease from './StoreRelease.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    releases,
    apple,
    version,
    track,
    codes,
    stagedShare,
    onreleased,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    releases: Record<string, ReleaseSummary[]>;
    apple: boolean;
    version: string | null;
    track: string;
    codes: string[];
    stagedShare: string;
    onreleased: () => void;
  } = $props();
</script>

<div class="stack loose">
  <p class="lead">
    Publish what is pending in one go. You see the plan first, step by step, and confirm it once. Nothing reaches a store before that.
  </p>
  {#if !apple}
    <PlayCheck {api} {workspaceId} {app} {track} {codes} fraction={fractionOf(stagedShare)} source="staged" />
  {/if}
  <PendingChanges {api} {workspaceId} {role} members={[app]} compact list={false} onpublished={onreleased} />
  <Disclosure summary="Advanced: do one step" stateKey="stepper-advanced-{app.id}">
    <div class="stack loose">
      <p class="lead">
        These steps write to the store. Each one shows what will happen first and asks you to confirm. They are separate: pushing a draft does not submit it, and submitting does not release it.
      </p>
      <section class="part" aria-label="Push the draft">
        <h4>1. Push the draft</h4>
        <StagedTrayApp {api} {workspaceId} {role} {app} part="push" />
      </section>
      {#if canSubmit(role)}
        <section class="part" aria-label="Submit for review">
          <h4>2. Submit for review</h4>
          <SubmitReady {api} {workspaceId} {role} {app} />
          <p class="muted small">A line appears here once a draft push is waiting to be submitted.</p>
        </section>
      {/if}
      {#if canRelease(role)}
        <section class="part" aria-label="Release">
          <h4>3. Release</h4>
          <StoreRelease {api} {workspaceId} {role} {app} version={apple ? version : null} track={apple ? '' : track} versionCodes={apple ? [] : codes} {stagedShare} {onreleased} />
          {#if !apple && percentFromFraction(stagedShare) !== ''}
            <p class="muted small">You staged an intended share earlier. It is not used: you type the share again when you release.</p>
          {/if}
        </section>
      {/if}
      <section class="part" aria-label="Rollout">
        <h4>{canRelease(role) ? '4' : '3'}. Rollout</h4>
        <RolloutControls {api} {workspaceId} {role} members={[app]} {releases} />
      </section>
    </div>
  </Disclosure>
</div>

<style>
  .lead {
    margin: 0;
  }

  h4 {
    margin: 0;
    font-size: var(--text-md);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .part {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
</style>
