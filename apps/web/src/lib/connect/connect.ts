import { platformSupports } from '@kiln/core';
import { type ExpoDetection, projectReferenceProblem } from '../eas/eas.ts';
import { t } from '../i18n/t.ts';
import type { AppSummary, CredentialSummary } from '../types.ts';

/**
 * Pure logic of "Connect your apps" (components/connect/): which app records still need a RevenueCat or an Expo link, and the rows the
 * person reviews before anything is written. Nothing is fetched or saved here. A RevenueCat row comes from the server plan
 * (`GET .../revenuecat/plan`, matching rules in apps/server/src/modules/revenuecat/link.ts `planRow`); an Expo row from the project id that
 * `app.json` of the linked repository names. A row is never checked for the person unless there is exactly one match. Written for the
 * ES2017 web build.
 */

export type ConnectKind = 'revenuecat' | 'expo';

export const CONNECT_KINDS: readonly ConnectKind[] = ['revenuecat', 'expo'];

/** The credential kind each integration reads with. */
export const credentialKindOf = (kind: ConnectKind): string => kind;

// ---------------------------------------------------------------------------------------------
// The server plan (RevenueCat)

export type PlanCandidate = {
  projectId: string;
  projectName: string;
  revenueCatAppId: string;
  revenueCatAppName: string;
  type: string;
  identifier: string | null;
  suggested: boolean;
};

export type PlanRow = {
  appId: string;
  name: string;
  platform: string;
  identifier: string;
  linked: boolean;
  candidates: PlanCandidate[];
  proposal: { projectId: string; revenueCatAppId: string } | null;
  ambiguous: boolean;
};

export type RevenueCatPlan = {
  projects: { id: string; name: string }[];
  rows: PlanRow[];
  complete: boolean;
};

/** `GET .../integration-links`: the ids of the app records that have a link. */
export type IntegrationLinks = { revenuecat: string[]; expo: string[] };

// ---------------------------------------------------------------------------------------------
// Who is eligible, who is pending

/** RevenueCat serves the stores of its capability; Expo (EAS) builds iOS and Android apps. */
export function eligible(kind: ConnectKind, app: Pick<AppSummary, 'platform'>): boolean {
  if (kind === 'revenuecat') return platformSupports(app.platform, 'revenueCat');
  return app.platform === 'ios' || app.platform === 'android';
}

/**
 * Whether what the repository says makes this an Expo app: an app.json with an `expo` section (found, or found without a project id)
 * or a dynamic config (app.config.js/ts). No repository, no app.json or a failed read say nothing, so the Expo notice stays hidden
 * for a native or Flutter app instead of nagging it.
 */
export function looksLikeExpo(
  detection: { detected: unknown; reason: string | null } | null,
): boolean {
  if (detection === null) return false;
  if (detection.detected !== null) return true;
  return detection.reason === 'dynamic_config' || detection.reason === 'no_project_id';
}

/** The credentials of the workspace of this integration's kind, in the order given. */
export const credentialsFor = (
  kind: ConnectKind,
  list: readonly CredentialSummary[] | null,
): CredentialSummary[] => (list ?? []).filter((c) => c.kind === credentialKindOf(kind));

/** The app records that can be linked and are not yet. */
export function pendingApps<A extends Pick<AppSummary, 'id' | 'platform'>>(
  kind: ConnectKind,
  apps: readonly A[],
  links: IntegrationLinks | null,
): A[] {
  if (links === null) return [];
  const done = kind === 'revenuecat' ? links.revenuecat : links.expo;
  return apps.filter((a) => eligible(kind, a) && done.indexOf(a.id) < 0);
}

/**
 * The integrations to nudge about: a credential of the kind exists and at least one eligible record is not linked. Nothing for a person
 * who may not change links (`mayWrite`), or while the links or credentials are not read yet (null).
 */
export function bannerKinds(input: {
  mayWrite: boolean;
  credentials: readonly CredentialSummary[] | null;
  apps: readonly Pick<AppSummary, 'id' | 'platform'>[] | null;
  links: IntegrationLinks | null;
}): { kind: ConnectKind; pending: number; credentialLabel: string }[] {
  if (!input.mayWrite || input.apps === null || input.credentials === null) return [];
  const out: { kind: ConnectKind; pending: number; credentialLabel: string }[] = [];
  for (const kind of CONNECT_KINDS) {
    const keys = credentialsFor(kind, input.credentials);
    const pending = pendingApps(kind, input.apps, input.links).length;
    if (keys[0] && pending > 0) out.push({ kind, pending, credentialLabel: keys[0].label });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rows

export type ConnectChoice = { value: string; label: string; suggested: boolean };

export type ConnectRow = {
  appId: string;
  name: string;
  platform: string;
  identifier: string;
  /** `linked`: left alone. `proposed`: one match. `ambiguous`: several, the person chooses. `none`: no match, the person chooses or types. */
  status: 'linked' | 'proposed' | 'ambiguous' | 'none';
  /** RevenueCat only: what can be chosen. */
  choices: ConnectChoice[];
  /** RevenueCat: the chosen `choiceValue` (empty for none). Expo: the project typed or detected (an id or `@account/slug`). */
  value: string;
  checked: boolean;
};

const SEP = '\t';
export const choiceValue = (projectId: string, revenueCatAppId: string): string =>
  `${projectId}${SEP}${revenueCatAppId}`;

export function decodeChoice(value: string): { projectId: string; revenueCatAppId: string } | null {
  const at = value.indexOf(SEP);
  if (at <= 0 || at === value.length - 1) return null;
  return { projectId: value.slice(0, at), revenueCatAppId: value.slice(at + SEP.length) };
}

/** The text of one RevenueCat app in the select: its name, type and identifier, and the project when the key sees several. */
export function candidateLabel(c: PlanCandidate, withProject: boolean): string {
  const base = t('connect:rc.choice', {
    name: c.revenueCatAppName,
    details: c.identifier === null ? c.type : `${c.type}, ${c.identifier}`,
  });
  return withProject
    ? t('connect:rc.choiceInProject', { project: c.projectName, choice: base })
    : base;
}

/** The rows of the review from the server plan: a proposal is checked, everything else waits for the person. */
export function rcRows(plan: RevenueCatPlan, only: readonly string[] | null = null): ConnectRow[] {
  const showProject = plan.projects.length > 1;
  return plan.rows
    .filter((r) => only === null || only.indexOf(r.appId) >= 0)
    .map((r): ConnectRow => {
      const choices = r.candidates.map((c) => ({
        value: choiceValue(c.projectId, c.revenueCatAppId),
        label: candidateLabel(c, showProject),
        suggested: c.suggested,
      }));
      const proposed = r.proposal
        ? choiceValue(r.proposal.projectId, r.proposal.revenueCatAppId)
        : '';
      return {
        appId: r.appId,
        name: r.name,
        platform: r.platform,
        identifier: r.identifier,
        status: r.linked
          ? 'linked'
          : proposed !== ''
            ? 'proposed'
            : r.ambiguous
              ? 'ambiguous'
              : 'none',
        choices,
        value: proposed,
        checked: proposed !== '',
      };
    });
}

/** The project the detection of app.json names: the id when there is one, else `@owner/slug`; empty for none. */
export function detectionProject(d: ExpoDetection | null | undefined): string {
  const found = d?.detected;
  if (!found) return '';
  return found.projectId ?? found.fullName ?? '';
}

/**
 * The rows of the Expo review. `detections` holds what `app.json` said per repository (an iOS and an Android record of one repository
 * share one answer); a record without one starts empty and unchecked, to be typed. Records that are already linked are left alone.
 */
export function expoRows(
  apps: readonly Pick<AppSummary, 'id' | 'name' | 'platform' | 'identifier' | 'repositoryId'>[],
  links: IntegrationLinks,
  detections: Readonly<Record<string, ExpoDetection | null | undefined>>,
): ConnectRow[] {
  return apps
    .filter((a) => eligible('expo', a))
    .map((a): ConnectRow => {
      const linked = links.expo.indexOf(a.id) >= 0;
      const found =
        linked || a.repositoryId === null ? '' : detectionProject(detections[a.repositoryId]);
      return {
        appId: a.id,
        name: a.name,
        platform: a.platform,
        identifier: a.identifier,
        status: linked ? 'linked' : found !== '' ? 'proposed' : 'none',
        choices: [],
        value: found,
        checked: found !== '',
      };
    });
}

/** A person chose or typed a value: the row is checked when it can be saved. */
export function withValue(kind: ConnectKind, row: ConnectRow, value: string): ConnectRow {
  const next = { ...row, value };
  return { ...next, checked: canLink(kind, next) };
}

export const withChecked = (row: ConnectRow, checked: boolean): ConnectRow => ({ ...row, checked });

/** Can this row be saved: RevenueCat needs a chosen app, Expo a project id or `@account/slug`. */
export function canLink(kind: ConnectKind, row: ConnectRow): boolean {
  if (row.status === 'linked') return false;
  if (kind === 'revenuecat') return decodeChoice(row.value) !== null;
  return row.value.trim() !== '' && projectReferenceProblem(row.value.trim()) === '';
}

/** What will be written on Confirm: the checked rows that can be saved. */
export const toLink = (kind: ConnectKind, rows: readonly ConnectRow[]): ConnectRow[] =>
  rows.filter((r) => r.checked && canLink(kind, r));

/** Rows that wait for the person: not linked, not saved by this review. */
export function counts(rows: readonly ConnectRow[]): {
  linked: number;
  proposed: number;
  ambiguous: number;
  none: number;
} {
  const n = { linked: 0, proposed: 0, ambiguous: 0, none: 0 };
  for (const r of rows) n[r.status] += 1;
  return n;
}

/** The apps to read app.json for: one repository once, whatever the number of records that use it. */
export function repositoriesToDetect(
  apps: readonly Pick<AppSummary, 'id' | 'platform' | 'repositoryId'>[],
  links: IntegrationLinks,
): { repositoryId: string; appId: string }[] {
  const seen: Record<string, true> = {};
  const out: { repositoryId: string; appId: string }[] = [];
  for (const a of apps) {
    if (!eligible('expo', a) || a.repositoryId === null || links.expo.indexOf(a.id) >= 0) continue;
    if (seen[a.repositoryId]) continue;
    seen[a.repositoryId] = true;
    out.push({ repositoryId: a.repositoryId, appId: a.id });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// After linking

export type LinkOutcome = { appId: string; name: string; ok: boolean; problem: string };

/** The two sentences after linking: what appears now, and what is still empty and why. */
export function afterLinking(kind: ConnectKind): { appears: string; empty: string } {
  return kind === 'revenuecat'
    ? { appears: t('connect:done.rc.appears'), empty: t('connect:done.rc.empty') }
    : { appears: t('connect:done.expo.appears'), empty: t('connect:done.expo.empty') };
}

/** The page to open after linking: Products for RevenueCat, Builds for Expo. */
export const destinationHref = (kind: ConnectKind, appId: string): string =>
  `#/portfolio/${encodeURIComponent(appId)}/${kind === 'revenuecat' ? 'products' : 'builds'}`;

/** What the Products and Builds pages say when the integration is not linked: which key was found and what is missing. */
export function missingLinkText(
  kind: ConnectKind,
  keys: readonly Pick<CredentialSummary, 'label'>[] | null,
  mayWrite: boolean,
): string {
  const first = keys?.[0];
  if (keys === null) {
    return kind === 'revenuecat'
      ? t('connect:missing.rc.unknown')
      : t('connect:missing.expo.unknown');
  }
  if (!first)
    return kind === 'revenuecat' ? t('connect:missing.rc.noKey') : t('connect:missing.expo.noKey');
  const params = { label: first.label };
  if (kind === 'revenuecat') {
    return mayWrite
      ? t('connect:missing.rc.keyFound', params)
      : t('connect:missing.rc.keyFoundAsk', params);
  }
  return mayWrite
    ? t('connect:missing.expo.keyFound', params)
    : t('connect:missing.expo.keyFoundAsk', params);
}
