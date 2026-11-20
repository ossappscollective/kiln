import { timeAgo } from '../format.ts';
import { platformLabel } from '../portfolio.ts';
import type {
  EasBuildProfile,
  EasBuildTarget,
  EasConfig,
  EasConfigView,
  EasFinding,
  EasRuntimeVersion,
  EasSeverity,
  EasSubmitProfile,
  ExpoAppSummary,
} from '../types.ts';

/**
 * Pure helpers of the "EAS configuration" card (components/eas/EasConfigCard.svelte, docs/api/eas-config.md): the tone and order of
 * the findings, the chips of a build profile, the lines of a submit profile, and the sentences for the runtime version, the
 * update setup and what was read. Written for the ES2017 web build. Nothing here sees a value of `env`: the server sends names only.
 */

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'info' | 'accent';
export type Chip = { text: string; tone: ChipTone };

// ---------------------------------------------------------------------------------------------
// Findings

const RANK: Record<EasSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The `Alert` tone of a finding. */
export const alertTone = (severity: EasSeverity): 'error' | 'warn' | 'info' =>
  severity === 'error' ? 'error' : severity === 'warning' ? 'warn' : 'info';

/** The `Badge` tone of a finding. */
export const badgeTone = (severity: EasSeverity): 'bad' | 'warn' | 'info' =>
  severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : 'info';

export const severityLabel = (severity: EasSeverity): string =>
  severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Note';

/** Errors first, then warnings, then notes; the server's order within each. */
export function sortFindings(findings: readonly EasFinding[]): EasFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity] || a.index - b.index)
    .map((x) => x.finding);
}

export function findingCounts(findings: readonly EasFinding[]): Record<EasSeverity, number> {
  const counts: Record<EasSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

const plural = (n: number, one: string, many: string = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 error, 2 warnings" (notes are not counted as problems), or "No problems found". */
export function findingsHeadline(findings: readonly EasFinding[]): string {
  const c = findingCounts(findings);
  const parts: string[] = [];
  if (c.error > 0) parts.push(plural(c.error, 'error'));
  if (c.warning > 0) parts.push(plural(c.warning, 'warning'));
  if (parts.length === 0) return c.info > 0 ? `No problems found, ${plural(c.info, 'note')}` : 'No problems found';
  return parts.join(', ') + (c.info > 0 ? `, ${plural(c.info, 'note')}` : '');
}

// ---------------------------------------------------------------------------------------------
// Build profiles

const DISTRIBUTION: Record<string, { label: string; tone: ChipTone }> = {
  store: { label: 'Store distribution', tone: 'ok' },
  internal: { label: 'Internal distribution', tone: 'info' },
};

/** The platform sections a build profile has, with the label of the platform. */
export function platformSections(profile: EasBuildProfile): { label: string; target: EasBuildTarget }[] {
  const out: { label: string; target: EasBuildTarget }[] = [];
  if (profile.ios) out.push({ label: platformLabel('ios'), target: profile.ios });
  if (profile.android) out.push({ label: platformLabel('android'), target: profile.android });
  return out;
}

/**
 * The chips of a build profile: distribution, channel, development client, auto increment, simulator. A platform section that
 * ends up with another channel or distribution than the profile adds a chip with the platform in front of it.
 */
export function buildChips(profile: EasBuildProfile): Chip[] {
  const chips: Chip[] = [];
  const distribution = (target: EasBuildTarget, prefix: string) => {
    if (target.distribution === null) return;
    const known = DISTRIBUTION[target.distribution];
    chips.push({
      text: `${prefix}${known ? known.label : `Distribution ${target.distribution}`}`,
      tone: known ? known.tone : 'warn',
    });
  };
  const channel = (target: EasBuildTarget, prefix: string) => {
    if (target.channel !== null) chips.push({ text: `${prefix}Channel ${target.channel}`, tone: 'accent' });
  };
  distribution(profile, '');
  channel(profile, '');
  for (const { label, target } of platformSections(profile)) {
    if (target.distribution !== profile.distribution) distribution(target, `${label}: `);
    if (target.channel !== profile.channel) channel(target, `${label}: `);
  }
  if (profile.developmentClient === true) chips.push({ text: 'Development client', tone: 'neutral' });
  const increments = [profile, ...platformSections(profile).map((s) => s.target)].some(
    (t) => t.autoIncrement !== null && t.autoIncrement !== false,
  );
  if (increments) chips.push({ text: 'Auto increment', tone: 'neutral' });
  const simulator = [profile, ...platformSections(profile).map((s) => s.target)].some((t) => t.simulator === true);
  if (simulator) chips.push({ text: 'Simulator', tone: 'neutral' });
  return chips;
}

/** The variable names of a profile as one line: the first few, then how many more. */
export function envText(names: readonly string[], show = 4): string {
  if (names.length === 0) return 'None';
  const first = names.slice(0, show).join(', ');
  return names.length > show ? `${first} and ${names.length - show} more` : first;
}

/** "Extends production, then base", or an empty string when the profile extends nothing. */
export function extendsText(profile: { extends: string | null; extendsChain: readonly string[] }): string {
  if (profile.extends === null) return '';
  const rest = profile.extendsChain.slice(1);
  return rest.length > 1 ? `Extends ${rest.join(' > ')}` : `Extends ${profile.extends}`;
}

// ---------------------------------------------------------------------------------------------
// Submit profiles

const rolloutText = (fraction: number) => {
  const percent = Math.round(fraction * 10000) / 100;
  return `${percent}% rollout`;
};

/** The lines of a submit profile, one per store it has a section for. Paths and ids as written; the Apple ID is never shown. */
export function submitLines(profile: EasSubmitProfile): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  const ios = profile.ios;
  if (ios) {
    const parts: string[] = [];
    if (ios.ascAppId) parts.push(`App Store Connect app ${ios.ascAppId}`);
    if (ios.appleTeamId) parts.push(`team ${ios.appleTeamId}`);
    if (ios.bundleIdentifier) parts.push(ios.bundleIdentifier);
    if (ios.ascApiKeyPath) parts.push(`API key ${ios.ascApiKeyPath}`);
    else if (ios.hasAppleId) parts.push('signs in with an Apple ID');
    if (ios.groups.length > 0) parts.push(`TestFlight ${ios.groups.length === 1 ? 'group' : 'groups'} ${ios.groups.join(', ')}`);
    if (ios.metadataPath) parts.push(`store config ${ios.metadataPath}`);
    out.push({ label: platformLabel('ios'), text: parts.length > 0 ? parts.join(' · ') : 'Nothing set: EAS asks when you submit' });
  }
  const android = profile.android;
  if (android) {
    const parts: string[] = [];
    if (android.track) parts.push(`track ${android.track}`);
    if (android.releaseStatus) parts.push(`release status ${android.releaseStatus}`);
    if (android.rollout !== null) parts.push(rolloutText(android.rollout));
    if (android.changesNotSentForReview === true) parts.push('changes not sent for review');
    if (android.applicationId) parts.push(android.applicationId);
    if (android.serviceAccountKeyPath) parts.push(`service account key ${android.serviceAccountKeyPath}`);
    out.push({ label: platformLabel('android'), text: parts.length > 0 ? parts.join(' · ') : 'Nothing set: EAS asks when you submit' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Versions and updates

export function runtimeVersionText(runtime: EasRuntimeVersion | null): string {
  if (runtime === null) return 'Not set';
  return runtime.kind === 'string' ? runtime.value : `Policy ${runtime.policy}`;
}

/** The runtime version of the app config: the top level one, and what a platform overrides it with. */
export function runtimeLines(app: ExpoAppSummary): { label: string; text: string }[] {
  const out = [{ label: 'Runtime version', text: runtimeVersionText(app.runtimeVersion) }];
  if (app.iosRuntimeVersion) out.push({ label: `${platformLabel('ios')} runtime version`, text: runtimeVersionText(app.iosRuntimeVersion) });
  if (app.androidRuntimeVersion) {
    out.push({ label: `${platformLabel('android')} runtime version`, text: runtimeVersionText(app.androidRuntimeVersion) });
  }
  return out;
}

/** Whether expo-updates is configured, in words (what the card says next to the channels). */
export function updatesText(app: ExpoAppSummary): string {
  if (app.unreadable) return 'The app config could not be read';
  if (app.updatesConfigured === true) return 'Configured (updates.url is set)';
  if (app.updatesEnabled === false) return 'Turned off (updates.enabled is false)';
  if (app.updatesConfigured === false) return 'Not configured (no updates.url)';
  return app.dynamicPath !== null ? `Unknown: ${app.dynamicPath} is code and is not run` : 'Unknown: no app config was read';
}

export function versionSourceText(cli: EasConfig['cli']): string {
  if (cli.appVersionSource === null) return 'Not set (local)';
  return cli.appVersionSource === 'remote' ? 'Remote (kept by Expo)' : 'Local (in the project files)';
}

// ---------------------------------------------------------------------------------------------
// What was read

export const shortCommit = (commit: string) => commit.slice(0, 7);

/** "Read from eas.json at 1a2b3c4 on main, 2 minutes ago." */
export function readCaption(view: EasConfigView, now: number): string {
  const where = view.commit !== null ? ` at ${shortCommit(view.commit)}` : '';
  const branch = view.branch !== null ? ` on ${view.branch}` : '';
  return `Read from ${view.path ?? 'eas.json'}${where}${branch}, ${timeAgo(view.readAt, now)}.`;
}

/** The one line that shows while the card is collapsed. */
export function collapsedSummary(view: EasConfigView | null, state: 'idle' | 'loading' | 'error'): string {
  if (view === null) {
    return state === 'loading' ? 'Reading eas.json...' : state === 'error' ? 'Could not be read' : 'Build and submit profiles, channels, runtime version';
  }
  if (!view.found) return view.reason?.code === 'no_eas_json' ? 'No eas.json' : 'Nothing to show';
  const config = view.config;
  if (config === null) return 'eas.json could not be parsed';
  return [
    plural(config.build.length, 'build profile'),
    plural(config.submit.length, 'submit profile'),
    findingsHeadline(view.findings).toLowerCase(),
  ].join(' · ');
}

/** The empty state of a read without a model. */
export function emptyState(view: EasConfigView): { title: string; description: string } {
  const code = view.reason?.code;
  const message = view.reason?.message ?? '';
  if (code === 'no_repository') return { title: 'No repository linked', description: message };
  if (code === 'unreadable') return { title: 'eas.json could not be read', description: message };
  return {
    title: 'No eas.json',
    description:
      view.nested.length > 0
        ? message
        : 'This repository has no eas.json at its root, so there are no EAS build or submit profiles to show.',
  };
}
