<!--
  StepConfirm: the last step of "Prepare release": "Review and publish all" (components/publish): one plan for the steps that wait
  (push the draft, submit for review, release; on Google Play with only release fields staged: ONE step, "Release to production", sent to
  Google for review without a draft, with "Save as a draft only" as the other choice), reviewed once and confirmed with one typed phrase. Under a quiet "Do just one step (advanced)" disclosure,
  the single gated flows are still here, each unchanged: push the draft (StagedTrayApp, push part: typed app name and
  an acknowledgement), submit for review (SubmitReady: typed phrase), release (StoreRelease: typed phrase, and for Google Play the share
  you type) and the rollout controls. They are separate: a push does not submit and a submit does not release.
  On Google Play "Check this release" (PlayCheck) comes first: local checks and "Check with Google Play" (errors only; nothing is saved).
  The heading and the primary button ("Review and publish") are the stepper's: this step draws the numbered list of what will be written, in order
  (`steps`, from lib/stepper-layout.ts), with the "Cannot be undone from here" badge on the step it applies to, and exports `publish()` and
  `publishState()` for the footer button.
  The build(s) chosen are shown first with their version and build date (BuildOriginLine) and, when a version read from a file or the
  store is not the version being released, a visible warning that does not block anything.
  Props: api, workspaceId, role, app, chosenLines (the chosen builds with version and date), steps (the numbered list; null while it is read), releases (store releases by app id, for the rollout controls), apple, version (App Store
  marketing version or null), track (Google Play), codes (staged version codes), stagedShare (staged intended share or ''),
  onreleased (called after a successful release).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import type { Api } from '../../../lib/api.ts';
  import { testBuildsHref } from '../../../lib/builds.ts';
  import type { ChosenBuildLine } from '../../../lib/release-candidates.ts';
  import { t } from '../../../lib/i18n/t.ts';
  import { fractionOf } from '../../../lib/play-check.ts';
  import { canRelease, percentFromFraction } from '../../../lib/store-release.ts';
  import { canSubmit } from '../../../lib/store-submit.ts';
  import type { ConfirmStep } from '../../../lib/stepper-layout.ts';
  import type { AppSummary, ReleaseSummary } from '../../../lib/types.ts';
  import StagedTrayApp from '../../listing/StagedTrayApp.svelte';
  import SubmitReady from '../../listing/SubmitReady.svelte';
  import PendingChanges from '../../publish/PendingChanges.svelte';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Disclosure from '../../ui/Disclosure.svelte';
  import RolloutControls from '../RolloutControls.svelte';
  import BuildOriginLine from './BuildOriginLine.svelte';
  import PlayCheck from './PlayCheck.svelte';
  import StoreRelease from './StoreRelease.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    steps,
    chosenLines = [],
    releases,
    apple,
    version,
    track,
    codes,
    stagedShare,
    inReview = false,
    onreleased,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    steps: readonly ConfirmStep[] | null;
    chosenLines?: readonly ChosenBuildLine[] | undefined;
    releases: Record<string, ReleaseSummary[]>;
    apple: boolean;
    version: string | null;
    track: string;
    codes: string[];
    stagedShare: string;
    /** The version is in store review. With nothing staged the checks for a release to come are left out: they would judge the one in review. */
    inReview?: boolean | undefined;
    onreleased: () => void;
  } = $props();

  const canTest = $derived(can(role, 'builds.read'));
  const waitingOnStore = $derived(inReview && (steps === null || steps.length === 0));

  let pending = $state<ReturnType<typeof PendingChanges> | undefined>();

  /** The stepper's "Review and publish": opens the plan (or shows what blocks it). */
  export function publish() {
    pending?.open();
  }

  /** Whether "Review and publish" can be pressed, and the one line that says why not. */
  export function publishState(): { enabled: boolean; reason: string } {
    return pending ? pending.publishState() : { enabled: false, reason: t('release-stepper:sc.reading') };
  }
</script>

<div class="stack loose">
  {#if !apple && !waitingOnStore}
    <PlayCheck {api} {workspaceId} {app} {track} {codes} fraction={fractionOf(stagedShare)} source="staged" />
  {/if}

  {#if chosenLines.length > 0}
    <section class="chosen" aria-label={t('release-stepper:og.confirmTitle')} data-testid="confirm-build">
      <h4>{t('release-stepper:og.confirmTitle')}</h4>
      {#each chosenLines as line (line.id)}
        <div class="build-line">
          <span class="build-title">{line.title}</span>
          <BuildOriginLine origin={line.origin} sayUnknown={line.sayUnknown} findHref={canTest && !apple ? testBuildsHref(app.id, app.platform, line.id) : null} />
        </div>
        {#if line.mismatch}<Alert tone="warn"><span data-testid="build-mismatch">{line.mismatch}</span></Alert>{/if}
      {/each}
    </section>
  {/if}

  {#if steps !== null && steps.length > 0}
    <ol class="plan" aria-label={t('release-stepper:sc.planAria')} data-testid="confirm-plan">
      {#each steps as s, i (s.type)}
        <li class="item">
          <span class="num" aria-hidden="true">{i + 1}</span>
          <div class="what">
            <div class="title">{s.title}</div>
            {#if s.detail}<div class="detail">{s.detail}</div>{/if}
          </div>
          {#if s.irreversible}<Badge tone="warn" icon="alert-triangle">{s.note}</Badge>{:else if s.note}<span class="note">{s.note}</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}

  <PendingChanges bind:this={pending} {api} {workspaceId} {role} members={[app]} compact list={false} headless onpublished={onreleased} />

  <Disclosure summary={t('release-stepper:sc.advanced')} stateKey="stepper-advanced-{app.id}">
    <div class="stack loose">
      <p class="muted small">
        {t('release-stepper:sc.advancedNote')}
      </p>
      <section class="part" aria-label={t('release-stepper:sc.pushAria')}>
        <h4>{t('release-stepper:sc.push')}</h4>
        <StagedTrayApp {api} {workspaceId} {role} {app} part="push" />
      </section>
      {#if canSubmit(role)}
        <section class="part" aria-label={t('release-stepper:sc.submitAria')}>
          <h4>{t('release-stepper:sc.submit')}</h4>
          <SubmitReady {api} {workspaceId} {role} {app} />
          <p class="muted small">{t('release-stepper:sc.submitNote')}</p>
        </section>
      {/if}
      {#if canRelease(role)}
        <section class="part" aria-label={t('release-stepper:sc.releaseAria')}>
          <h4>{t('release-stepper:sc.release')}</h4>
          <StoreRelease {api} {workspaceId} {role} {app} version={apple ? version : null} track={apple ? '' : track} versionCodes={apple ? [] : codes} {stagedShare} stagedFields={!apple && track.trim() !== '' && codes.length > 0} {onreleased} />
          {#if !apple && percentFromFraction(stagedShare) !== ''}
            <p class="muted small">{t('release-stepper:sc.shareNote')}</p>
          {/if}
        </section>
      {/if}
      <section class="part" aria-label={t('release-stepper:sc.rolloutAria')}>
        <h4>{t('release-stepper:sc.rollout', { n: canRelease(role) ? 4 : 3 })}</h4>
        <RolloutControls {api} {workspaceId} {role} members={[app]} {releases} />
      </section>
    </div>
  </Disclosure>
</div>

<style>
  h4 {
    margin: 0;
    font-size: var(--text-md);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .plan {
    display: grid;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .item {
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
    padding: var(--space-4) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .num {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    font-weight: var(--weight-bold, 700);
    background: var(--surface-sunken);
    border-radius: 50%;
  }

  .what {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .detail {
    margin-top: 2px;
    font-size: var(--text-md);
    color: var(--muted);
  }

  .note {
    font-size: var(--text-sm);
    color: var(--muted);
    white-space: nowrap;
  }

  .chosen {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-xl);
  }

  .build-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: baseline;
  }

  .build-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
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
