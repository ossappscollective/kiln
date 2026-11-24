import type {
  ReviewAiDetail,
  ReviewAiEffective,
  ReviewAiPolicyStored,
  ReviewAiSwitch,
  ShapedReview,
} from '@kiln/core';
import { k, t } from '../i18n/t.ts';

/**
 * What reviews of an app may be sent to the AI provider, as the app settings and the reviews page show it
 * (docs/adr/0065-ai-review-privacy-and-competitor-schedule.md, docs/api/ai.md). The SERVER decides and enforces; this file only turns
 * its answer into forms and sentences. Pure: no network, no clock.
 */

export type ReviewPrivacyView = {
  stored: ReviewAiPolicyStored;
  effective: ReviewAiEffective;
  /** The workspace setting: the ceiling an app cannot exceed. */
  ceiling: { ownReviews: boolean; competitorReviews: boolean };
  updatedAt: number | null;
  updatedBy: string | null;
  canEdit: boolean;
};

export type ReviewPayloadPreview = {
  allowed: boolean;
  reason: 'workspace_off' | 'app_off' | null;
  detail: ReviewAiDetail;
  redact: boolean;
  reviews: ShapedReview[];
  sampleOf: number;
};

/** The three answers of a choice: follow the workspace (`inherit`), on, off. */
export type SwitchChoice = 'inherit' | 'on' | 'off';
export type ReviewPrivacyForm = {
  own: SwitchChoice;
  competitor: SwitchChoice;
  detail: ReviewAiDetail;
  redact: boolean;
};

export const switchChoices: readonly SwitchChoice[] = ['inherit', 'on', 'off'];
export const detailChoices: readonly ReviewAiDetail[] = ['text', 'full', 'ratings'];

/** The sentences of the form, by kind, choice and detail (keys kept in maps so the checker finds them). */
export const kindText = {
  own: { legend: k('app:aiPrivacy.own.legend'), sub: k('app:aiPrivacy.own.sub') },
  competitor: {
    legend: k('app:aiPrivacy.competitor.legend'),
    sub: k('app:aiPrivacy.competitor.sub'),
  },
} as const;
export const choiceText = {
  on: k('app:aiPrivacy.choice.on'),
  off: k('app:aiPrivacy.choice.off'),
} as const;
export const detailText = {
  text: { label: k('app:aiPrivacy.detail.text'), hint: k('app:aiPrivacy.detail.textHint') },
  full: { label: k('app:aiPrivacy.detail.full'), hint: k('app:aiPrivacy.detail.fullHint') },
  ratings: {
    label: k('app:aiPrivacy.detail.ratings'),
    hint: k('app:aiPrivacy.detail.ratingsHint'),
  },
} as const;

/** The label of a choice; "follow the workspace" says what that means now. */
export const choiceLabel = (choice: SwitchChoice, ceilingAllowed: boolean): string =>
  choice === 'inherit'
    ? t('app:aiPrivacy.choice.inherit', { state: effectiveWord(ceilingAllowed) })
    : t(choiceText[choice]);

const toChoice = (value: ReviewAiSwitch): SwitchChoice => (value === null ? 'inherit' : value);
const fromChoice = (value: SwitchChoice): ReviewAiSwitch => (value === 'inherit' ? null : value);

export const privacyToForm = (view: Pick<ReviewPrivacyView, 'stored'>): ReviewPrivacyForm => ({
  own: toChoice(view.stored.ownReviews),
  competitor: toChoice(view.stored.competitorReviews),
  detail: view.stored.detail,
  redact: view.stored.redact,
});

/** The body of the PUT: only what differs from what is saved (null follows the workspace). */
export function privacyChanges(
  view: Pick<ReviewPrivacyView, 'stored'>,
  form: ReviewPrivacyForm,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fromChoice(form.own) !== view.stored.ownReviews) out.ownReviews = fromChoice(form.own);
  if (fromChoice(form.competitor) !== view.stored.competitorReviews)
    out.competitorReviews = fromChoice(form.competitor);
  if (form.detail !== view.stored.detail) out.detail = form.detail;
  if (form.redact !== view.stored.redact) out.redact = form.redact;
  return out;
}

export const isPrivacyDirty = (
  view: Pick<ReviewPrivacyView, 'stored'>,
  form: ReviewPrivacyForm,
): boolean => Object.keys(privacyChanges(view, form)).length > 0;

/** What "follow the workspace" means right now, as a word for the option: "allowed" or "not allowed". */
export const effectiveWord = (allowed: boolean): string =>
  allowed ? t('app:aiPrivacy.allowed') : t('app:aiPrivacy.notAllowed');

/** The sentence under a choice that has no effect because the workspace turned the kind off; empty otherwise. */
export const lockedText = (
  kind: 'own' | 'competitor',
  view: Pick<ReviewPrivacyView, 'effective'>,
): string => (view.effective[kind].locked ? t('app:aiPrivacy.lockedByWorkspace') : '');

/**
 * Why AI cannot use the reviews of an app right now, or null when it can. The reviews page shows it instead of the buttons, with a link to
 * the setting; stored summaries stay visible and are labelled.
 */
export type ReviewAiGate =
  | { state: 'open' }
  | { state: 'off'; reason: 'workspace_off' | 'app_off'; text: string }
  | { state: 'ratings'; text: string };

export function reviewAiGate(view: Pick<ReviewPrivacyView, 'effective'> | null): ReviewAiGate {
  if (view === null) return { state: 'open' };
  const own = view.effective.own;
  if (!own.allowed) {
    const reason = own.reason === 'workspace_off' ? 'workspace_off' : 'app_off';
    return {
      state: 'off',
      reason,
      text: reason === 'workspace_off' ? t('reviews:ai.offWorkspace') : t('reviews:ai.offApp'),
    };
  }
  if (view.effective.detail === 'ratings')
    return { state: 'ratings', text: t('reviews:ai.ratingsOnly') };
  return { state: 'open' };
}

/** The address of the workspace switch (Settings > AI). */
export const workspaceAiSettingHref = '#/settings?view=ai';

/** The address of the setting (the "Privacy and AI" section of the app settings). */
export const privacySettingHref = (appId: string): string =>
  `#/portfolio/${encodeURIComponent(appId)}/settings?section=ai-privacy`;

/** The exact JSON of the sample, as it would be sent. */
export const previewJson = (preview: ReviewPayloadPreview): string =>
  JSON.stringify(preview.reviews, null, 2);
