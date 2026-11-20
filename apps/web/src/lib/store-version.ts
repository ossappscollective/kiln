import { newestDottedVersion, nextVersion, type Platform } from '@mrm/core';
import { ApiError } from './api.ts';
import { stepUpMessage } from './step-up.ts';

/**
 * Creating the next App Store version from the build step (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md):
 * a reversible draft write behind the draft-write switch. The types of the API, the version that is suggested, and the words for
 * each answer. The server decides every rule; nothing here sends anything. Written for the ES2017 web build: no flatMap, no
 * fromEntries.
 */

export const VERSION_ENV = 'MRM_STORE_DRAFT_WRITE_ENABLED';
export const VERSION_ROLE_REASON = 'Creating a version needs the admin or owner role.';
export const VERSION_NOTE = 'Creates an editable draft version in App Store Connect. Nothing is submitted.';
/** What the build step said before there was a way to create it here: still the text when this app cannot. */
export const NO_VERSION_SENTENCE =
  'App Store Connect has no version a build can be attached to. Create the next version in App Store Connect, sync this app, then read again here.';

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
  const newest = newestDottedVersion(releases.filter((r) => r.platform === platform).map((r) => r.version));
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
  typeof error.body.message === 'string' && error.body.message !== '' ? error.body.message : error.message;

const isCheck = (c: unknown): c is VersionCheck =>
  typeof c === 'object' && c !== null && typeof (c as VersionCheck).message === 'string';

/** The reasons Apple gave, as one sentence each (never more than three). */
function reasonsOf(error: ApiError): string {
  const details = Array.isArray(error.body.details) ? (error.body.details as unknown[]) : [];
  const out: string[] = [];
  for (const d of details) {
    if (typeof d !== 'object' || d === null) continue;
    const x = d as { title?: unknown; detail?: unknown };
    const text = typeof x.detail === 'string' ? x.detail : typeof x.title === 'string' ? x.title : '';
    if (text !== '' && out.indexOf(text) < 0) out.push(text);
    if (out.length === 3) break;
  }
  return out.join(' ');
}

export function classifyVersionFailure(error: unknown): VersionFailure {
  if (!(error instanceof ApiError))
    return { kind: 'other', message: 'The request failed. Check your connection, then try again. Nothing is known to have been created.' };
  const message = bodyMessage(error);
  const step = stepUpMessage(error.code, error.retryAfter);
  if (step !== undefined) return { kind: 'other', message: step };
  switch (error.code) {
    case 'store_draft_disabled':
      return {
        kind: 'disabled',
        message: `Writing drafts to a store is switched off on this server (${VERSION_ENV}). Nothing was created. Someone who runs the server sets ${VERSION_ENV}=true and restarts it.`,
      };
    case 'forbidden':
      return { kind: 'forbidden', message: VERSION_ROLE_REASON };
    case 'blocked': {
      const checks = error.body.checks as { blocking?: unknown } | undefined;
      const list = checks && Array.isArray(checks.blocking) ? checks.blocking.filter(isCheck) : [];
      return { kind: 'blocked', message: `${list.length > 0 ? blockingText(list) : message} Nothing was created.` };
    }
    case 'state_changed':
      return {
        kind: 'state_changed',
        message: 'The versions in App Store Connect changed since you looked, so nothing was created. Check the version and try again.',
      };
    case 'outcome_unknown':
      return {
        kind: 'outcome_unknown',
        message: `${message} Look at the app in App Store Connect before you try again.`,
      };
    case 'store_rejected': {
      const why = reasonsOf(error);
      return { kind: 'other', message: `${message}${why !== '' && message.indexOf(why) < 0 ? ` ${why}` : ''} Nothing was created.` };
    }
    case 'rate_limited':
      return { kind: 'other', message: `${message} Nothing was created.` };
    default:
      return { kind: 'other', message };
  }
}
