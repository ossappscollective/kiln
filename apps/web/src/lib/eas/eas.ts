import { ApiError } from '../api.ts';
import { formatRelativeTime } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';
import type { CredentialSummary } from '../types.ts';

/**
 * Pure helpers of the Expo (EAS) project card in the app Settings (docs/adr/0033-eas-integration.md, docs/api/eas.md): the types of
 * what the API answers, the sentence for each error code, what the card shows, and the check of what is typed. Written for the
 * ES2017 web build.
 */

/** `GET /apps/{appId}/expo`: the link of an app record to its EAS project. */
export type ExpoLinkView = {
  appId: string;
  credentialId: string;
  /** Null when the credential was deleted. */
  credentialLabel: string | null;
  /** False when the credential was deleted or is not an Expo credential: another must be chosen. */
  credentialAvailable: boolean;
  projectId: string;
  accountName: string;
  slug: string;
  /** `@account/slug`. */
  fullName: string;
  projectName: string;
  verifiedAt: number;
  linkedBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ExpoDetectionReason =
  | 'no_repository'
  | 'repository_unavailable'
  | 'dynamic_config'
  | 'no_app_json'
  | 'unreadable'
  | 'no_project_id'
  | 'read_failed';

/** `GET /apps/{appId}/expo/detect`: what app.json of the repository says. */
export type ExpoDetection = {
  detected: {
    projectId: string | null;
    owner: string | null;
    slug: string | null;
    fullName: string | null;
    path: 'app.json';
  } | null;
  reason: ExpoDetectionReason | null;
  message: string | null;
};

export type SetExpoLinkBody = { credentialId: string; project: string };

// ---------------------------------------------------------------------------------------------
// What is typed

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A sentence when the text cannot be a project reference, else ''. The server checks it again, and Expo has the last word. */
export function projectReferenceProblem(text: string): string {
  const value = text.trim();
  if (value === '') return t('eas:link.refEmpty');
  if (UUID.test(value) || FULL_NAME.test(value)) return '';
  return t('eas:link.refInvalid');
}

/** The Expo credentials of the workspace, in the order given. */
export const expoCredentials = (list: readonly CredentialSummary[] | null): CredentialSummary[] =>
  (list ?? []).filter((c) => c.kind === 'expo');

/**
 * What to put in the form: the saved link, else the project of another record of the same app (an iOS and an Android record usually
 * share one EAS project), else nothing. `fromSibling` tells the form to say where it came from.
 */
export function formStart(
  own: ExpoLinkView | null,
  siblings: readonly (ExpoLinkView | null)[],
): { credentialId: string; project: string; fromSibling: boolean } {
  if (own) return { credentialId: own.credentialAvailable ? own.credentialId : '', project: own.fullName, fromSibling: false };
  const other = siblings.filter((l): l is ExpoLinkView => l !== null && l.credentialAvailable)[0];
  if (other) return { credentialId: other.credentialId, project: other.fullName, fromSibling: true };
  return { credentialId: '', project: '', fromSibling: false };
}

// ---------------------------------------------------------------------------------------------
// Whether and how the card shows

/**
 * The card is drawn when it can matter: the app is already linked, the workspace has an Expo credential, or its repository is an
 * Expo project. Otherwise an iOS or Android app that never touches Expo would carry a card it cannot use.
 */
export function showExpoCard(input: {
  links: readonly (ExpoLinkView | null)[];
  expoCredentialCount: number;
  repositoryKinds: readonly (string | null)[];
}): boolean {
  return (
    input.links.some((l) => l !== null) ||
    input.expoCredentialCount > 0 ||
    input.repositoryKinds.some((k) => k === 'expo' || k === 'both')
  );
}

/** The one line of the collapsed card. */
export function expoSummary(links: readonly (ExpoLinkView | null)[]): string {
  const linked = links.filter((l): l is ExpoLinkView => l !== null);
  if (linked.length === 0) return t('eas:link.summaryNone');
  const names = linked.map((l) => l.fullName).filter((n, i, all) => all.indexOf(n) === i);
  return names.length === 1 ? names[0] ?? '' : t('eas:link.summaryMany', { count: names.length });
}

/** "Confirmed with Expo 3 minutes ago.", or what is wrong with the credential. */
export function linkStatus(link: ExpoLinkView, now: number): { tone: 'ok' | 'warn'; text: string } {
  if (!link.credentialAvailable) {
    return { tone: 'warn', text: t('eas:link.credentialDeleted') };
  }
  return { tone: 'ok', text: t('eas:link.confirmed', { ago: formatRelativeTime(link.verifiedAt, { now }) }) };
}

/** What the detection button says when it found a project, and when it did not. */
export function detectionText(detection: ExpoDetection): string {
  const found = detection.detected;
  if (found === null) return detection.message ?? t('eas:detect.none');
  if (found.projectId !== null) return t('eas:detect.foundId');
  return t('eas:detect.foundName');
}

/** The text the form takes from a detection: the project id when there is one, else `@owner/slug`. */
export function detectedProject(detection: ExpoDetection): string {
  const found = detection.detected;
  if (found === null) return '';
  return found.projectId ?? found.fullName ?? '';
}

// ---------------------------------------------------------------------------------------------
// Errors

/** "30 seconds", "1 minute", "10 minutes": how long to wait, rounded up (the same words as `waitPhrase` of the API client). */
export function waitText(seconds: number): string {
  if (seconds < 60) return t('eas:wait.seconds', { count: Math.max(1, Math.ceil(seconds)) });
  return t('eas:wait.minutes', { count: Math.ceil(seconds / 60) });
}

/** A sentence for what the API said. The generic messages of the API client are written for GitHub, so these codes are said here. */
export function easErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return t('eas:err.link.forbidden');
    case 'not_found':
      return t('eas:err.link.notFound');
    case 'credential_not_found':
      return t('eas:err.link.credentialNotFound');
    case 'credential_kind':
      return t('eas:err.link.credentialKind');
    case 'credential_unreadable':
      return t('eas:err.link.credentialUnreadable');
    case 'invalid_request':
    case 'invalid_project':
      return own || t('eas:err.link.invalid');
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
      return own || t('eas:err.expoAsk');
    case 'rate_limited':
      return t('eas:err.rateLimited', { wait: waitText(error.retryAfter ?? 60) });
    case 'timeout':
      return t('eas:err.timeout');
    default:
      return error.status >= 500 ? t('errors:http.serverError') : error.message;
  }
}

export const expoLinks = {
  /** Where an Expo access token is created and kept. */
  accessTokens: 'https://expo.dev/settings/access-tokens',
  credentials: '#/credentials',
};
