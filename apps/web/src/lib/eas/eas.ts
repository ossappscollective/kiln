import { ApiError, waitPhrase } from '../api.ts';
import { timeAgo } from '../format.ts';
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
  if (value === '') return 'Enter the project id or its name as @account/slug.';
  if (UUID.test(value) || FULL_NAME.test(value)) return '';
  return 'That is neither a project id (a UUID, as in app.json under extra.eas.projectId) nor a name like @account/slug.';
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
  if (linked.length === 0) return 'Not linked';
  const names = linked.map((l) => l.fullName).filter((n, i, all) => all.indexOf(n) === i);
  return names.length === 1 ? names[0] ?? '' : `${names.length} projects`;
}

/** "Confirmed with Expo 3 minutes ago.", or what is wrong with the credential. */
export function linkStatus(link: ExpoLinkView, now: number): { tone: 'ok' | 'warn'; text: string } {
  if (!link.credentialAvailable) {
    return {
      tone: 'warn',
      text: 'The Expo credential of this link was deleted. Choose another and save.',
    };
  }
  return { tone: 'ok', text: `Confirmed with Expo ${timeAgo(link.verifiedAt, now)}.` };
}

/** What the detection button says when it found a project, and when it did not. */
export function detectionText(detection: ExpoDetection): string {
  const found = detection.detected;
  if (found === null) return detection.message ?? 'No Expo project was found in the repository.';
  if (found.projectId !== null) return 'Found the project id in app.json. Save to confirm it with Expo.';
  return 'app.json names the project but has no project id. Save to look it up by name.';
}

/** The text the form takes from a detection: the project id when there is one, else `@owner/slug`. */
export function detectedProject(detection: ExpoDetection): string {
  const found = detection.detected;
  if (found === null) return '';
  return found.projectId ?? found.fullName ?? '';
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what the API said. The generic messages of the API client are written for GitHub, so these codes are said here. */
export function easErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return 'Only an owner or an admin can change the Expo project of an app.';
    case 'not_found':
      return 'That app or link no longer exists. Reload the page.';
    case 'credential_not_found':
      return 'That credential no longer exists. Choose another one.';
    case 'credential_kind':
      return 'Choose a credential of the Expo access token kind.';
    case 'credential_unreadable':
      return 'The credential could not be decrypted. Enter its token again under Credentials.';
    case 'invalid_request':
    case 'invalid_project':
      return own || 'Choose a credential and enter the project id or @account/slug.';
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
      return own || 'Expo could not be asked. Try again in a moment.';
    case 'rate_limited':
      return `Too many requests. Try again in ${waitPhrase(error.retryAfter ?? 60)}.`;
    case 'timeout':
      return 'Expo took too long to answer. Try again.';
    default:
      return error.status >= 500 ? 'The server had a problem. Try again.' : error.message;
  }
}

export const expoLinks = {
  /** Where an Expo access token is created and kept. */
  accessTokens: 'https://expo.dev/settings/access-tokens',
  credentials: '#/credentials',
};
