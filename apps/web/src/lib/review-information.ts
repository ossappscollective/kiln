import { REVIEW_CODES, type ReviewCarryStatus, type ReviewSummary, reviewCarryStatusOf } from '@kiln/core';
import { ApiError } from './api.ts';
import { t } from './i18n/t.ts';
import { stepUpMessage } from './step-up.ts';

/**
 * App Review Information of an App Store version (docs/api/review-information.md): what the server says about carrying it over to a
 * version Kiln creates, and the repair "Copy review information from 1.19.0" for a version that has none. Pure: the types of the API,
 * the words for each answer, and the masked line a screen may show. The server decides every rule. A contact name, phone number, email
 * address, demo account or note never reaches this app: the server sends initials and yes/no (`ReviewSummary`), and this file only
 * words them. Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export type ReviewOutcome =
  | 'created'
  | 'merged'
  | 'already_complete'
  | 'no_source'
  | 'failed'
  | 'not_read';

export type ReviewInformationView = {
  outcome: ReviewOutcome;
  /** The one word for the outcome (core `reviewCarryStatusOf`). Absent in an answer of an older server: derived from `outcome`. */
  status?: ReviewCarryStatus;
  /** The version string it comes from. */
  from: string | null;
  fieldsCopied: number;
  summary: ReviewSummary | null;
  code?: string;
};

export type ReviewCopyPreview = {
  version: { versionString: string | null; state: string };
  reviewInformation: ReviewInformationView;
  canCopy: boolean;
  confirmHash: string | null;
  note: string;
};

export type ReviewCopyResult = {
  version: { versionString: string | null; state: string };
  reviewInformation: ReviewInformationView;
  note: string;
};

/** Whether a check or blocker code is about the App Review Information. */
export const isReviewCode = (code: string): boolean => REVIEW_CODES.indexOf(code) >= 0;

/** The masked line of a source: "Contact: M. G., phone and email present. Demo account: required, credentials present. Notes: present." */
export function summaryText(summary: ReviewSummary | null): string {
  if (summary === null) return '';
  const who = summary.contact ?? t('release-store:review.summary.noName');
  const reach =
    summary.phone && summary.email
      ? t('release-store:review.summary.both')
      : summary.phone
        ? t('release-store:review.summary.phoneOnly')
        : summary.email
          ? t('release-store:review.summary.emailOnly')
          : t('release-store:review.summary.neither');
  const parts = [t('release-store:review.summary.contact', { who, reach })];
  if (summary.demoAccount === 'required')
    parts.push(
      summary.demoCredentials
        ? t('release-store:review.summary.demoRequired')
        : t('release-store:review.summary.demoRequiredNoCredentials'),
    );
  else if (summary.demoAccount === 'not_required')
    parts.push(t('release-store:review.summary.demoNotRequired'));
  if (summary.notes) parts.push(t('release-store:review.summary.notes'));
  return parts.join('. ') + '.';
}

/**
 * What the create-version form says about the review information, from the preview (`phase` 'preview': what will happen) or the
 * result (`phase` 'result': what happened). Null when there is nothing to say (not looked at).
 */
export function carryLine(
  info: ReviewInformationView | null | undefined,
  phase: 'preview' | 'result',
): string | null {
  if (!info) return null;
  const from = info.from ?? '';
  const status = info.status ?? reviewCarryStatusOf(info.outcome);
  switch (status) {
    case 'copied':
      if (info.outcome === 'already_complete')
        return phase === 'preview' ? null : t('release-store:review.carry.alreadyComplete');
      return phase === 'preview'
        ? t('release-store:review.carry.willCopy', { from, summary: summaryText(info.summary) })
        : t('release-store:review.carry.copied', { from });
    case 'nothing_to_copy':
      return t('release-store:review.carry.noSource');
    case 'skipped_disabled':
      return t('release-store:review.carry.disabled', { env: STORE_WRITE_ENV });
    default:
      // Never silent: the reason, and where the one-click repair is.
      return phase === 'preview'
        ? t('release-store:review.carry.previewFailed')
        : t('release-store:review.carry.notCopied', { reason: reviewReason(info.code) });
  }
}

/** The switch that turns store writes on (the server's `KILN_STORE_DRAFT_WRITE_ENABLED`). */
export const STORE_WRITE_ENV = 'KILN_STORE_DRAFT_WRITE_ENABLED';

/** Why a carry-over failed, from the kind of the failure the server names. */
export function reviewReason(code: string | undefined): string {
  switch (code) {
    case 'timeout':
      return t('release-store:review.reason.timeout');
    case 'network':
      return t('release-store:review.reason.network');
    case 'store_rejected':
    case 'rejected':
    case 'forbidden':
    case 'unauthorized':
      return t('release-store:review.reason.rejected');
    case 'not_attempted':
    case 'no_version_id':
      return t('release-store:review.reason.notAttempted');
    default:
      return t('release-store:review.reason.unknown');
  }
}

/** Whether the one-click "Copy review information" should be offered after this answer (anything that is not a copy). */
export const offersReviewCopy = (info: ReviewInformationView | null | undefined): boolean =>
  !info || (info.status ?? reviewCarryStatusOf(info.outcome)) !== 'copied';

/** The label of the repair button. */
export const copyLabel = (from: string | null): string =>
  from !== null && from !== ''
    ? t('release-store:review.copy.button', { from })
    : t('release-store:review.copy.buttonPrevious');

export type ReviewCopyFailure =
  | { kind: 'disabled'; message: string }
  | { kind: 'state_changed'; message: string; next: ReviewCopyPreview | null }
  | { kind: 'other'; message: string };

const isPreview = (value: unknown): value is ReviewCopyPreview =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ReviewCopyPreview).canCopy === 'boolean' &&
  typeof (value as ReviewCopyPreview).reviewInformation === 'object';

/** The words for each way the repair can answer; the server's own sentences are generic and carry no value. */
export function classifyReviewCopyFailure(error: unknown): ReviewCopyFailure {
  if (!(error instanceof ApiError))
    return { kind: 'other', message: t('release-store:review.copy.failRequest') };
  const step = stepUpMessage(error.code, error.retryAfter);
  if (step !== undefined) return { kind: 'other', message: step };
  const message =
    typeof error.body.message === 'string' && error.body.message !== ''
      ? error.body.message
      : error.message;
  switch (error.code) {
    case 'store_draft_disabled':
      return { kind: 'disabled', message: t('release-store:review.copy.failDisabled') };
    case 'forbidden':
      return { kind: 'other', message: t('release-store:version.roleReason') };
    case 'state_changed':
      return {
        kind: 'state_changed',
        message: t('release-store:review.copy.stateChanged'),
        next: isPreview(error.body.preview) ? error.body.preview : null,
      };
    case 'store_rejected':
      return { kind: 'other', message: t('release-store:review.copy.failStore') };
    default:
      return { kind: 'other', message };
  }
}

/** The version a blocker says the review information can be copied from (its `params.from`), or null. */
export function reviewFromParam(
  params: Readonly<Record<string, string | number>> | undefined,
): string | null {
  const from = params === undefined ? undefined : params.from;
  return typeof from === 'string' && from !== '' ? from : null;
}
