import {
  blockersOf,
  evaluateDraftContent,
  predictDraft,
  readinessOf,
  type StagedDraftChanges,
  type SubmitBlocker,
  type SubmitReadiness,
  supports,
} from '@kiln/core';
import type { SubmitState } from '@kiln/connectors';
import type { ManagedApp } from '../../services/apps.ts';
import type { DraftPreview } from './store-draft.ts';
import { BUILD_CODES, draftContentOf, earlyChecksOf } from './store-submit.ts';

/**
 * Whether the draft could be SUBMITTED once the staged push is made, known BEFORE anything is sent (docs/api/pending.md "Readiness").
 * One read of the store (`readStateForPlan`) plus the push preview the plan already holds: the draft the push would leave is
 * `predictDraft(what the store holds, what is staged)`, judged by the same pure rules as the submit itself (`evaluateDraftContent`),
 * so what the plan says is what the submit would later say. Pure: no store, no database.
 *
 * Certain (`blockers`): the version cannot be submitted, a build is missing, expired or unprocessed (unless the push attaches one), a
 * locale lacks a required text, a device size holds too many screenshots, a size or format the store documents is wrong, no screenshot at
 * all, Play release notes over the limit.
 * Known only after the push (`unknown`): an image the store is still processing, and on Google Play whether changes are already in review
 * (its API shows no review state).
 */
export type PlanSubmitReadiness = SubmitReadiness & {
  /** The staged push was merged into the store's draft (false: the draft is judged as the store holds it). */
  predicted: boolean;
  /** When the store was read (epoch ms). */
  checkedAt: number;
};

export type PlanReadiness = { submit: PlanSubmitReadiness };

/** The staged items of a push preview, in the plain shape of `predictDraft`. */
export function stagedChangesOf(push: DraftPreview | undefined): StagedDraftChanges {
  if (push === undefined) return { texts: [], sets: [] };
  return {
    texts: push.text.map((t) => ({ locale: t.locale, field: t.field, value: t.after })),
    sets: push.assets.map((a) => ({
      locale: a.locale,
      kind: a.slot.kind,
      device: a.slot.device,
      target: a.target,
      group: a.placementGroup ?? null,
      images: a.after.files.map((f) => ({ width: f.width, height: f.height })),
    })),
    releaseNotes: push.release
      .filter((r) => r.field === 'release_notes' && !r.localOnly)
      .map((r) => ({ locale: r.locale, value: r.after })),
  };
}

export function submitReadinessOf(input: {
  app: Pick<ManagedApp, 'id' | 'platform'>;
  state: SubmitState;
  push: DraftPreview | undefined;
  now: number;
}): PlanReadiness {
  const { app, state, push } = input;
  const ios = !supports(app.platform, 'transactionalEdits');
  const pushesBuild = push?.release.some((r) => r.field === 'build') === true;
  const early = earlyChecksOf(app, state).filter(
    (c) => !(pushesBuild && BUILD_CODES.includes(c.code)),
  );
  const blockers: SubmitBlocker[] = blockersOf(app, early);
  // A version already in review has no draft to judge: that is the whole answer.
  if (!state.alreadySubmitted) {
    const predicted = predictDraft(draftContentOf(ios, state.locales), stagedChangesOf(push));
    blockers.push(...blockersOf(app, evaluateDraftContent(predicted)));
  }
  const unknown: string[] = [];
  if (ios && (push?.summary.filesToUpload ?? 0) > 0) unknown.push('image_not_ready');
  if (!ios) unknown.push('play_review_state_unknown');
  return {
    submit: {
      ...readinessOf(blockers, unknown),
      predicted: push !== undefined,
      checkedAt: input.now,
    },
  };
}
