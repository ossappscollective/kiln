import type { GuardedAction, PrimaryAction, TopBarBadge } from './types.ts';

/**
 * The surfaces that draw what the state model decides, and what each of them handles (docs/state-model.md, "Enforcement").
 *
 * `surfaces.test.ts` reads the SOURCE of every file named here and fails when a surface does not handle an action of the model, and when a
 * component outside this registry reads a verdict or draws the model's offers. So a new action (or a new surface) cannot be added without
 * every screen that renders actions saying what it does with it:
 *
 *  - a new `PrimaryAction`: add it to `OFFER_HANDLERS` of the card (the type of the record makes tsc fail until you do);
 *  - a new `GuardedAction`: give it a surface in `VERDICT_SURFACES`, or say in `MODEL_ONLY` why none shows it;
 *  - a new top bar kind: add it to `BADGE_HANDLERS`;
 *  - a new component that asks `appStateStore.verdict(...)` or draws `primaryAction`/`secondaryActions`: register it here.
 *
 * Paths are relative to `apps/web/src`. `evidence` is what the source must contain for the claim "this surface handles it".
 */

/** The offers of the model (`primaryAction`, `secondaryActions`, the promotion, the flow rows) are drawn by these files. */
export const OFFER_SURFACES: readonly {
  id: string;
  file: string;
  handlers: Readonly<Record<PrimaryAction, RegExp | 'not_drawn'>>;
}[] = [
  {
    id: 'next-step-card',
    file: 'components/app/NextStep.svelte',
    handlers: {
      // Opens the pending panel on the failure or the publish (or the pending changes).
      show_pending: /offer\.action === 'show_pending'/,
      // Opens the publish dialog with the same selection.
      publish_again: /offer\.action === 'publish_again'/,
      // The draft was pushed and the submit is blocked: opens the submit checklist (SubmitReady) with the blockers.
      fix_blockers: /offer\.action === 'fix_blockers'/,
      // A link to the step of the release that takes the build.
      attach_build: /href=\{offer\.href\}/,
      open_release: /href=\{offer\.href\}/,
      // The Prepare release button (a link, or the stepper's own handler).
      prepare_release: /offer\.action === 'prepare_release'/,
      // StartRelease owns the dialog; the card hands it the verdict as `blockedReason`.
      start_release: /<StartRelease/,
      // A link to the create-version step with the version and the TestFlight build filled in (`&version=2.0.1&build=95`).
      create_release: /href=\{offer\.href\}/,
      promote: /href=\{offer\.href\}/,
      follow_review: /href=\{offer\.href\}/,
      // Draws nothing: there is no button.
      none: 'not_drawn',
    },
  },
  {
    // The Releases table draws the model's candidates ("Ready to release" rows) and their one button; the card and the table read the same offers.
    id: 'releases-table',
    file: 'components/release/ReleaseTable.svelte',
    handlers: {
      show_pending: 'not_drawn',
      publish_again: 'not_drawn',
      fix_blockers: 'not_drawn',
      attach_build: /data-action=\{c\.offer\.action\}/,
      open_release: 'not_drawn',
      prepare_release: /data-action=\{c\.offer\.action\}/,
      start_release: 'not_drawn',
      create_release: /data-action=\{c\.offer\.action\}/,
      promote: /appStateStore\.promoteFor\(/,
      follow_review: 'not_drawn',
      none: 'not_drawn',
    },
  },
];

/** Which file draws each kind of the top bar badge, and the line that proves it. */
export const BADGE_SURFACE = 'components/app/PendingCartButton.svelte';
export const BADGE_HANDLERS: Readonly<Record<TopBarBadge['kind'], RegExp>> = {
  idle: /badge\.kind !== 'idle'/,
  pending: /cartButton\.press/,
  publishing: /badge\.kind === 'publishing'/,
  failed: /badge\.kind === 'failed'/,
};

/** A component that asks the model whether `action` may be done now, and the line that proves it asks. */
export type VerdictSurface = { file: string; action: GuardedAction; evidence: RegExp };

export const VERDICT_SURFACES: readonly VerdictSurface[] = [
  { file: 'components/app/PendingCartDrawer.svelte', action: 'push', evidence: /can\('push'\)/ },
  {
    file: 'components/app/PendingCartDrawer.svelte',
    action: 'publish',
    evidence: /can\('publish'\)/,
  },
  {
    file: 'components/app/PendingCartDrawer.svelte',
    action: 'discard',
    evidence: /can\('discard'\)/,
  },
  {
    file: 'components/publish/PendingChanges.svelte',
    action: 'publish',
    evidence: /canDo\('publish'\)/,
  },
  {
    file: 'components/publish/PendingChanges.svelte',
    action: 'discard',
    evidence: /canDo\('discard'/,
  },
  {
    file: 'components/listing/StagedTrayApp.svelte',
    action: 'push',
    evidence: /appStateStore\.verdict\(workspaceId, role, app, 'push'\)/,
  },
  {
    file: 'components/listing/SubmitReady.svelte',
    action: 'submit',
    evidence: /appStateStore\.verdict\(workspaceId, role, app, 'submit'\)/,
  },
  {
    file: 'components/release/stepper/StoreRelease.svelte',
    action: 'release',
    evidence: /appStateStore\.verdict\(workspaceId, role, app, 'release'\)/,
  },
  {
    file: 'components/release/stepper/CreateVersion.svelte',
    action: 'create_version',
    evidence: /appStateStore\.verdict\(workspaceId, role, app, 'create_version'\)/,
  },
  {
    file: 'components/release/RolloutAppControl.svelte',
    action: 'rollout',
    evidence: /appStateStore\.verdict\(workspaceId, role, app, 'rollout'\)/,
  },
  {
    file: 'components/release/ReleaseRowDetail.svelte',
    action: 'promote',
    evidence: /appStateStore\.verdict\(workspaceId, role, app, 'promote'\)/,
  },
  {
    file: 'components/release/ReleaseTable.svelte',
    action: 'promote',
    evidence: /appStateStore\.promoteFor\(/,
  },
  { file: 'components/app/NextStep.svelte', action: 'promote', evidence: /appState\.promotion/ },
  // The card draws these two through the model's offers (see OFFER_SURFACES); the release flow's own buttons take the verdict as a reason.
  {
    file: 'components/app/NextStep.svelte',
    action: 'prepare_release',
    evidence: /data-action=\{offer\.action\}/,
  },
  { file: 'components/app/NextStep.svelte', action: 'start_release', evidence: /blockedReason/ },
];

/** Guarded actions that no screen draws a button for of its own: the model decides them for the offers only. Say why. */
export const MODEL_ONLY: Readonly<Partial<Record<GuardedAction, string>>> = {};
