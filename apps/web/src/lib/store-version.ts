import { newestDottedVersion, nextVersion, type Platform } from '@kiln/core';
import { ApiError } from './api.ts';
import { k, t } from './i18n/t.ts';
import { stepUpMessage } from './step-up.ts';

/**
 * Creating the next App Store version from the build step (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md):
 * a reversible draft write behind the draft-write switch. The types of the API, the version that is suggested, and the words for
 * each answer. The server decides every rule; nothing here sends anything. Written for the ES2017 web build: no flatMap, no
 * fromEntries.
 */

export const VERSION_ENV = 'KILN_STORE_DRAFT_WRITE_ENABLED';
/** The three sentences below are message keys: show them with `t(...)`. */
export const VERSION_ROLE_REASON = k('release-store:version.roleReason');
export const VERSION_NOTE = k('release-store:version.note');
/** What the build step said before there was a way to create it here: still the text when this app cannot. */
export const NO_VERSION_SENTENCE = k('release-store:version.noneSentence');

export type VersionCheck = { code: string; message: string };
export type VersionPreview = {
  live: string | null;
  suggested: string;
  checks: { blocking: VersionCheck[]; warnings: VersionCheck[]; canCreate: boolean };
  confirmHash: string | null;
  request: { versionString: string; releaseType: string | null };
};
export type VersionResult = {
  version: { id: string | null; versionString: string; state: string };
  confirmedByReread: boolean;
  warnings: VersionCheck[];
  note: string;
};

/** The version to offer: the next patch of the newest version this platform's stored releases show ('' when none is a number). */
export function suggestedVersion(
  releases: readonly { platform: Platform; version: string }[],
  platform: Platform,
): string {
  const newest = newestDottedVersion(
    releases.filter((r) => r.platform === platform).map((r) => r.version),
  );
  return newest === null ? '' : nextVersion(newest);
}

/** One sentence per blocking check, for the line under the field. */
export const blockingText = (checks: readonly VersionCheck[]): string =>
  checks.map((c) => c.message).join(' ');

export type VersionFailure =
  | { kind: 'disabled'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'state_changed'; message: string }
  | { kind: 'outcome_unknown'; message: string }
  | { kind: 'other'; message: string };

const bodyMessage = (error: ApiError): string =>
  typeof error.body.message === 'string' && error.body.message !== ''
    ? error.body.message
    : error.message;

const isCheck = (c: unknown): c is VersionCheck =>
  typeof c === 'object' && c !== null && typeof (c as VersionCheck).message === 'string';

/** The reasons Apple gave, as one sentence each (never more than three). */
function reasonsOf(error: ApiError): string {
  const details = Array.isArray(error.body.details) ? (error.body.details as unknown[]) : [];
  const out: string[] = [];
  for (const d of details) {
    if (typeof d !== 'object' || d === null) continue;
    const x = d as { title?: unknown; detail?: unknown };
    const text =
      typeof x.detail === 'string' ? x.detail : typeof x.title === 'string' ? x.title : '';
    if (text !== '' && out.indexOf(text) < 0) out.push(text);
    if (out.length === 3) break;
  }
  return out.join(' ');
}

export function classifyVersionFailure(error: unknown): VersionFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      message: t('release-store:version.failRequest'),
    };
  const message = bodyMessage(error);
  const step = stepUpMessage(error.code, error.retryAfter);
  if (step !== undefined) return { kind: 'other', message: step };
  switch (error.code) {
    case 'store_draft_disabled':
      return {
        kind: 'disabled',
        message: t('release-store:version.failDisabled', { env: VERSION_ENV }),
      };
    case 'forbidden':
      return { kind: 'forbidden', message: t(VERSION_ROLE_REASON) };
    case 'blocked': {
      const checks = error.body.checks as { blocking?: unknown } | undefined;
      const list = checks && Array.isArray(checks.blocking) ? checks.blocking.filter(isCheck) : [];
      return {
        kind: 'blocked',
        message: t('release-store:version.nothingCreated', {
          message: list.length > 0 ? blockingText(list) : message,
        }),
      };
    }
    case 'state_changed':
      return {
        kind: 'state_changed',
        message: t('release-store:version.stateChanged'),
      };
    case 'outcome_unknown':
      return {
        kind: 'outcome_unknown',
        message: t('release-store:version.outcomeUnknown', { message }),
      };
    case 'store_rejected': {
      const why = reasonsOf(error);
      return {
        kind: 'other',
        message: t('release-store:version.nothingCreated', {
          message: `${message}${why !== '' && message.indexOf(why) < 0 ? ` ${why}` : ''}`,
        }),
      };
    }
    case 'rate_limited':
      return { kind: 'other', message: t('release-store:version.nothingCreated', { message }) };
    default:
      return { kind: 'other', message };
  }
}
