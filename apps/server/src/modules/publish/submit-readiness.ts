import type { SubmitState } from '@kiln/connectors';
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
  /** The languages this push adds to the draft (staged for a language the store does not have), with what is staged for each. */
  adds: AddedLanguage[];
};

export type PlanReadiness = { submit: PlanSubmitReadiness };

/** A language this push would ADD to the store's draft, and what is staged for it (so no staged language is hidden from the person). */
export type AddedLanguage = { locale: string; texts: number; sets: number; files: number };

/** The languages the staged push adds to the draft: staged for a locale the store's draft does not hold. Only real changes count. */
export function addedLanguagesOf(
  existing: readonly string[],
  changes: StagedDraftChanges,
): AddedLanguage[] {
  const have = new Set(existing);
  const out = new Map<string, AddedLanguage>();
  const at = (locale: string): AddedLanguage => {
    let a = out.get(locale);
    if (!a) {
      a = { locale, texts: 0, sets: 0, files: 0 };
      out.set(locale, a);
    }
    return a;
  };
  for (const t of changes.texts)
    if (!have.has(t.locale) && t.value !== null && t.value.trim() !== '') at(t.locale).texts += 1;
  for (const s of changes.sets)
    if (!have.has(s.locale) && s.images.length > 0) {
      const a = at(s.locale);
      a.sets += 1;
      a.files += s.images.length;
    }
  return [...out.values()].sort((x, y) => x.locale.localeCompare(y.locale));
}

/** The staged items of a push preview, in the plain shape of `predictDraft`. */
export function stagedChangesOf(push: DraftPreview | undefined): StagedDraftChanges {
  if (push === undefined) return { texts: [], sets: [] };
  return {
    // A row that changes nothing (the one baseline rule) is not part of the push: it never adds a language.
    texts: push.text
      .filter((t) => t.status !== 'unchanged')
      .map((t) => ({ locale: t.locale, field: t.field, value: t.after })),
    sets: push.assets
      .filter((a) => a.status !== 'unchanged')
      .map((a) => ({
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
    const predicted = predictDraft(
      draftContentOf(ios, state.locales, state.version?.versionString),
      stagedChangesOf(push),
    );
    blockers.push(...blockersOf(app, evaluateDraftContent(predicted)));
  }
  const adds = state.alreadySubmitted
    ? []
    : addedLanguagesOf(
        draftContentOf(ios, state.locales, state.version?.versionString).locales.map(
          (l) => l.locale,
        ),
        stagedChangesOf(push),
      );
  const unknown: string[] = [];
  if (ios && (push?.summary.filesToUpload ?? 0) > 0) unknown.push('image_not_ready');
  if (!ios) unknown.push('play_review_state_unknown');
  return {
    submit: {
      ...readinessOf(blockers, unknown),
      predicted: push !== undefined,
      checkedAt: input.now,
      adds,
    },
  };
}
