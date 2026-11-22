import { formatList, formatPercent, formatRelativeTime } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
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
  severity === 'error' ? t('eas:config.severity.error') : severity === 'warning' ? t('eas:config.severity.warning') : t('eas:config.severity.note');

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

/**
 * "1 error, 2 warnings" (notes are not counted as problems), or "No problems found". `inline` is for the one line of the collapsed card,
 * where the sentence continues a list: "no problems found" starts with a lower-case letter. Only that sentence changes; the counts are
 * the same words either way (they are never lower-cased by code, because a noun is capital in German).
 */
export function findingsHeadline(findings: readonly EasFinding[], inline = false): string {
  const c = findingCounts(findings);
  const parts: string[] = [];
  if (c.error > 0) parts.push(t('eas:config.findings.errors', { count: c.error }));
  if (c.warning > 0) parts.push(t('eas:config.findings.warnings', { count: c.warning }));
  if (parts.length === 0) {
    if (c.info === 0) return inline ? t('eas:config.findings.noneInline') : t('eas:config.findings.none');
    return inline ? t('eas:config.findings.noneInlineNotes', { count: c.info }) : t('eas:config.findings.noneNotes', { count: c.info });
  }
  if (c.info > 0) parts.push(t('eas:config.findings.notes', { count: c.info }));
  return formatList(parts, { type: 'unit' });
}

// ---------------------------------------------------------------------------------------------
// Build profiles

const DISTRIBUTION: Record<string, { key: string; tone: ChipTone }> = {
  store: { key: k('eas:status.distribution.store'), tone: 'ok' },
  internal: { key: k('eas:status.distribution.internal'), tone: 'info' },
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
  // `platform` is the label of a platform section whose value differs from the profile's; its chip says which platform it is for.
  const named = (platform: string | null, text: string) => (platform === null ? text : t('eas:config.chip.platform', { platform, chip: text }));
  const distribution = (target: EasBuildTarget, platform: string | null) => {
    if (target.distribution === null) return;
    const known = DISTRIBUTION[target.distribution];
    chips.push({
      text: named(platform, known ? t(known.key) : t('eas:config.chip.distributionOther', { name: target.distribution })),
      tone: known ? known.tone : 'warn',
    });
  };
  const channel = (target: EasBuildTarget, platform: string | null) => {
    if (target.channel !== null) chips.push({ text: named(platform, t('eas:config.chip.channel', { name: target.channel })), tone: 'accent' });
  };
  distribution(profile, null);
  channel(profile, null);
  for (const { label, target } of platformSections(profile)) {
    if (target.distribution !== profile.distribution) distribution(target, label);
    if (target.channel !== profile.channel) channel(target, label);
  }
  if (profile.developmentClient === true) chips.push({ text: t('eas:config.chip.devClient'), tone: 'neutral' });
  const increments = [profile, ...platformSections(profile).map((s) => s.target)].some(
    (t) => t.autoIncrement !== null && t.autoIncrement !== false,
  );
  if (increments) chips.push({ text: t('eas:config.chip.autoIncrement'), tone: 'neutral' });
  const simulator = [profile, ...platformSections(profile).map((s) => s.target)].some((t) => t.simulator === true);
  if (simulator) chips.push({ text: t('eas:config.chip.simulator'), tone: 'neutral' });
  return chips;
}

/** The variable names of a profile as one line: the first few, then how many more. */
export function envText(names: readonly string[], show = 4): string {
  if (names.length === 0) return t('eas:config.env.none');
  const first = names.slice(0, show).join(', ');
  return names.length > show ? t('eas:config.env.more', { names: first, count: names.length - show }) : first;
}

/** "Extends production, then base", or an empty string when the profile extends nothing. */
export function extendsText(profile: { extends: string | null; extendsChain: readonly string[] }): string {
  if (profile.extends === null) return '';
  const rest = profile.extendsChain.slice(1);
  return t('eas:config.extends', { name: rest.length > 1 ? rest.join(' > ') : profile.extends });
}

// ---------------------------------------------------------------------------------------------
// Submit profiles

const rolloutText = (fraction: number) => {
  return t('eas:config.rollout', { percent: formatPercent(Math.round(fraction * 10000) / 10000, { maximumFractionDigits: 2 }) });
};

/** The lines of a submit profile, one per store it has a section for. Paths and ids as written; the Apple ID is never shown. */
export function submitLines(profile: EasSubmitProfile): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  const ios = profile.ios;
  if (ios) {
    const parts: string[] = [];
    if (ios.ascAppId) parts.push(t('eas:config.submit.ascApp', { id: ios.ascAppId }));
    if (ios.appleTeamId) parts.push(t('eas:config.submit.team', { id: ios.appleTeamId }));
    if (ios.bundleIdentifier) parts.push(ios.bundleIdentifier);
    if (ios.ascApiKeyPath) parts.push(t('eas:config.submit.apiKey', { path: ios.ascApiKeyPath }));
    else if (ios.hasAppleId) parts.push(t('eas:config.submit.appleId'));
    if (ios.groups.length > 0) parts.push(t('eas:config.submit.groups', { count: ios.groups.length, groups: ios.groups.join(', ') }));
    if (ios.metadataPath) parts.push(t('eas:config.submit.metadata', { path: ios.metadataPath }));
    out.push({ label: platformLabel('ios'), text: parts.length > 0 ? parts.join(' · ') : t('eas:config.submit.nothing') });
  }
  const android = profile.android;
  if (android) {
    const parts: string[] = [];
    if (android.track) parts.push(t('eas:config.submit.track', { track: android.track }));
    if (android.releaseStatus) parts.push(t('eas:config.submit.releaseStatus', { status: android.releaseStatus }));
    if (android.rollout !== null) parts.push(rolloutText(android.rollout));
    if (android.changesNotSentForReview === true) parts.push(t('eas:config.submit.notSent'));
    if (android.applicationId) parts.push(android.applicationId);
    if (android.serviceAccountKeyPath) parts.push(t('eas:config.submit.serviceAccount', { path: android.serviceAccountKeyPath }));
    out.push({ label: platformLabel('android'), text: parts.length > 0 ? parts.join(' · ') : t('eas:config.submit.nothing') });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Versions and updates

export function runtimeVersionText(runtime: EasRuntimeVersion | null): string {
  if (runtime === null) return t('eas:config.runtime.notSet');
  return runtime.kind === 'string' ? runtime.value : t('eas:config.runtime.policy', { policy: runtime.policy });
}

/** The runtime version of the app config: the top level one, and what a platform overrides it with. */
export function runtimeLines(app: ExpoAppSummary): { label: string; text: string }[] {
  const out = [{ label: t('eas:config.runtime.label'), text: runtimeVersionText(app.runtimeVersion) }];
  if (app.iosRuntimeVersion) out.push({ label: t('eas:config.runtime.platformLabel', { platform: platformLabel('ios') }), text: runtimeVersionText(app.iosRuntimeVersion) });
  if (app.androidRuntimeVersion) {
    out.push({ label: t('eas:config.runtime.platformLabel', { platform: platformLabel('android') }), text: runtimeVersionText(app.androidRuntimeVersion) });
  }
  return out;
}

/** Whether expo-updates is configured, in words (what the card says next to the channels). */
export function updatesText(app: ExpoAppSummary): string {
  if (app.unreadable) return t('eas:config.updates.unreadable');
  if (app.updatesConfigured === true) return t('eas:config.updates.configured');
  if (app.updatesEnabled === false) return t('eas:config.updates.off');
  if (app.updatesConfigured === false) return t('eas:config.updates.notConfigured');
  return app.dynamicPath !== null ? t('eas:config.updates.unknownDynamic', { path: app.dynamicPath }) : t('eas:config.updates.unknownNone');
}

export function versionSourceText(cli: EasConfig['cli']): string {
  if (cli.appVersionSource === null) return t('eas:config.versionSource.none');
  return cli.appVersionSource === 'remote' ? t('eas:config.versionSource.remote') : t('eas:config.versionSource.local');
}

// ---------------------------------------------------------------------------------------------
// What was read

export const shortCommit = (commit: string) => commit.slice(0, 7);

/** "Read from eas.json at 1a2b3c4 on main, 2 minutes ago." */
export function readCaption(view: EasConfigView, now: number): string {
  const params = {
    path: view.path ?? 'eas.json',
    commit: view.commit !== null ? shortCommit(view.commit) : '',
    branch: view.branch ?? '',
    ago: formatRelativeTime(view.readAt, { now }),
  };
  if (view.commit !== null) return view.branch !== null ? t('eas:config.read.full', params) : t('eas:config.read.commit', params);
  return view.branch !== null ? t('eas:config.read.branch', params) : t('eas:config.read.plain', params);
}

/** The one line that shows while the card is collapsed. */
export function collapsedSummary(view: EasConfigView | null, state: 'idle' | 'loading' | 'error'): string {
  if (view === null) {
    return state === 'loading' ? t('eas:config.collapsed.loading') : state === 'error' ? t('eas:config.collapsed.error') : t('eas:config.collapsed.idle');
  }
  if (!view.found) return view.reason?.code === 'no_eas_json' ? t('eas:config.collapsed.noFile') : t('eas:config.collapsed.nothing');
  const config = view.config;
  if (config === null) return t('eas:config.collapsed.unparsed');
  return [
    t('eas:config.profiles.build', { count: config.build.length }),
    t('eas:config.profiles.submit', { count: config.submit.length }),
    findingsHeadline(view.findings, true),
  ].join(' · ');
}

/** The empty state of a read without a model. */
export function emptyState(view: EasConfigView): { title: string; description: string } {
  const code = view.reason?.code;
  const message = view.reason?.message ?? '';
  if (code === 'no_repository') return { title: t('eas:config.empty.noRepoTitle'), description: message };
  if (code === 'unreadable') return { title: t('eas:config.empty.unreadableTitle'), description: message };
  return {
    title: t('eas:config.empty.noFileTitle'),
    description: view.nested.length > 0 ? message : t('eas:config.empty.noFileDesc'),
  };
}
