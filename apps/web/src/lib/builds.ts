import type { Platform } from '@mrm/core';
import { appAddress } from './app-scope.ts';

/**
 * Builds to test (docs/api/builds.md): the rows of the "Test builds" section, their filters and the plain install guidance, as
 * pure functions. The server answers `GET /apps/:id/builds/artifacts`; nothing here touches the network or the window.
 */

export type ArtifactKind = 'ipa' | 'apk' | 'aab' | 'app' | 'dmg' | 'pkg' | 'zip' | 'other';

export type ArtifactItem = {
  id: string;
  name: string;
  kind: ArtifactKind;
  guessed: boolean;
  platform: Platform | null;
  sizeBytes: number;
  expired: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  downloadable: boolean;
  tooLarge: boolean;
  run: {
    id: string;
    number: number | null;
    workflow: string;
    title: string | null;
    branch: string | null;
    shortSha: string | null;
    status: string;
    conclusion: string | null;
    url: string | null;
  };
};

export type StoreBuildItem = {
  platform: Platform;
  buildNumber: string;
  version: string | null;
  state: 'processing' | 'processed' | 'invalid' | 'unknown';
  rawState: string | null;
  expired: boolean | null;
  uploadedAt: number | null;
  expiresAt: number | null;
  expiresAtEstimated: boolean;
  channel: 'testflight' | 'play';
  tracks: string[];
  releaseStatus: string | null;
  optInUrl: string | null;
  runId: string | null;
};

export type BuildsProblem = {
  reason: 'no_access' | 'rate_limited' | 'unavailable' | 'unsupported' | 'no_repository';
  needs: string | null;
};

export type BuildsList = {
  app: { id: string; name: string; platform: Platform; identifier: string };
  repository: { id: string; owner: string; repo: string } | null;
  artifacts: ArtifactItem[];
  hiddenArtifacts: number;
  truncated: boolean;
  store: StoreBuildItem[];
  problem: BuildsProblem | null;
  downloadEnabled: boolean;
  maxDownloadBytes: number;
  canDownload: boolean;
  readAt: number | null;
  cached: boolean;
};

export type DownloadLink = { path: string; expiresAt: number; filename: string };

// ---------------------------------------------------------------------------------------------
// Rows

export type RowSource = 'ci' | 'store';
export type RowKind = ArtifactKind | 'testflight' | 'play';

export type BuildRow = {
  key: string;
  source: RowSource;
  platform: Platform | null;
  kind: RowKind;
  /** The build or version number, or the artifact's name. */
  title: string;
  /** Run, branch and commit; or the version and tracks. */
  detail: string;
  /** Link to the CI run, when there is one. */
  runUrl: string | null;
  sizeBytes: number | null;
  at: number | null;
  expiresAt: number | null;
  expired: boolean;
  /** A plain word for the state, with a tone for a badge. */
  state: { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' };
  artifact: ArtifactItem | null;
  store: StoreBuildItem | null;
};

const runLabel = (a: ArtifactItem): string => {
  const run = a.run.number !== null ? `${a.run.workflow} #${a.run.number}` : a.run.workflow;
  return [run, a.run.branch, a.run.shortSha].filter((x): x is string => !!x).join(' · ');
};

const artifactState = (a: ArtifactItem): BuildRow['state'] => {
  if (a.expired) return { label: 'Expired', tone: 'bad' };
  if (a.tooLarge) return { label: 'Too large to download', tone: 'warn' };
  if (a.run.conclusion !== null && a.run.conclusion !== 'success') return { label: `Run ${a.run.conclusion.replace(/_/g, ' ')}`, tone: 'warn' };
  return { label: 'Available', tone: 'ok' };
};

const storeState = (b: StoreBuildItem): BuildRow['state'] => {
  if (b.expired === true) return { label: 'Expired', tone: 'bad' };
  if (b.state === 'processing') return { label: 'Processing', tone: 'info' };
  if (b.state === 'invalid') return { label: 'Invalid', tone: 'bad' };
  if (b.state === 'processed') return { label: b.channel === 'play' ? 'On a track' : 'Ready to test', tone: 'ok' };
  return { label: 'Unknown state', tone: 'neutral' };
};

export function artifactRow(a: ArtifactItem): BuildRow {
  return {
    key: `ci:${a.id}`,
    source: 'ci',
    platform: a.platform,
    kind: a.kind,
    title: a.name,
    detail: runLabel(a),
    runUrl: a.run.url,
    sizeBytes: a.sizeBytes,
    at: a.createdAt,
    expiresAt: a.expiresAt,
    expired: a.expired,
    state: artifactState(a),
    artifact: a,
    store: null,
  };
}

export function storeRow(b: StoreBuildItem): BuildRow {
  const where = b.channel === 'play' ? (b.tracks.length > 0 ? `Track ${b.tracks.join(', ')}` : 'No track') : 'TestFlight';
  return {
    key: `store:${b.platform}:${b.buildNumber}`,
    source: 'store',
    platform: b.platform,
    kind: b.channel,
    title: `${b.version ? `${b.version} ` : ''}(${b.buildNumber})`.trim(),
    detail: where,
    runUrl: null,
    sizeBytes: null,
    at: b.uploadedAt,
    expiresAt: b.expiresAt,
    expired: b.expired === true,
    state: storeState(b),
    artifact: null,
    store: b,
  };
}

/** Every build, newest first (a build with no date goes last). */
export function rowsOf(list: Pick<BuildsList, 'artifacts' | 'store'>): BuildRow[] {
  const rows = [...list.artifacts.map(artifactRow), ...list.store.map(storeRow)];
  return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------
// Filters

export type BuildFilters = {
  platform: 'all' | Platform;
  source: 'all' | RowSource;
  hideExpired: boolean;
  /** Test reports, logs and other artifacts that do not look like a build. */
  hideOther: boolean;
};

export const defaultFilters: BuildFilters = { platform: 'all', source: 'all', hideExpired: true, hideOther: true };

export function applyFilters(rows: readonly BuildRow[], f: BuildFilters): BuildRow[] {
  return rows.filter(
    (r) =>
      (f.platform === 'all' || r.platform === f.platform) &&
      (f.source === 'all' || r.source === f.source) &&
      (!f.hideExpired || !r.expired) &&
      (!f.hideOther || r.kind !== 'other'),
  );
}

/** What the filters hide, so a person is told why a list is short. */
export function hiddenBy(rows: readonly BuildRow[], f: BuildFilters): number {
  return rows.length - applyFilters(rows, f).length;
}

// ---------------------------------------------------------------------------------------------
// Words

export function humanSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const DAY = 24 * 60 * 60_000;

/** "expires in 12 days", "expires today", "expired 3 days ago", or "" when nothing is known. */
export function expiryText(row: Pick<BuildRow, 'expiresAt' | 'expired' | 'store'>, now: number): string {
  const estimated = row.store?.expiresAtEstimated === true;
  if (row.expiresAt === null) return row.expired ? 'expired' : '';
  const days = Math.floor((row.expiresAt - now) / DAY);
  const lead = estimated ? 'about ' : '';
  if (row.expired || row.expiresAt <= now) {
    const ago = Math.floor((now - row.expiresAt) / DAY);
    return row.expired && ago <= 0 ? 'expired' : `expired ${ago <= 0 ? 'today' : `${ago} day${ago === 1 ? '' : 's'} ago`}`;
  }
  if (days <= 0) return `expires ${lead}today`;
  return `expires ${lead}in ${days} day${days === 1 ? '' : 's'}`;
}

export const kindLabel = (kind: RowKind): string =>
  ({
    ipa: 'IPA', apk: 'APK', aab: 'AAB', app: 'macOS app', dmg: 'DMG', pkg: 'PKG', zip: 'Zip', other: 'Other', testflight: 'TestFlight', play: 'Play',
  })[kind];

// ---------------------------------------------------------------------------------------------
// Install guidance

export type Guide = {
  title: string;
  steps: string[];
  /** The honest limits: what this cannot do, or what is a guess. */
  caution: string | null;
  /** May a zip be downloaded for this kind (when the server allows it at all)? */
  downloads: boolean;
  /** Is a code for a phone useful (a file the phone itself can install)? */
  qr: boolean;
  /** A link to open instead (TestFlight, Play opt-in). */
  link: { label: string; href: string } | null;
};

const ZIP_NOTE = 'A workflow artifact is always a zip: unzip it first. The type shown is a guess from the artifact name.';

/** Plain installation guidance for a row. Never promises more than the tool can do. */
export function installGuide(row: BuildRow): Guide {
  if (row.store) {
    const b = row.store;
    if (b.channel === 'testflight') {
      return {
        title: 'Install from TestFlight',
        steps: [
          'Store builds cannot be downloaded as a file. Open the TestFlight app on the device.',
          'Internal testers (people in App Store Connect) see a processed build there automatically.',
          'External testers need an invitation or the public link of a beta group, made in App Store Connect.',
        ],
        caution: b.expired === true ? 'This build has expired and cannot be installed any more.' : b.state === 'processing' ? 'Apple is still processing this build; it cannot be installed yet.' : b.expiresAtEstimated ? 'A TestFlight build lasts 90 days from its upload; the date shown is that estimate.' : null,
        downloads: false,
        qr: false,
        link: null,
      };
    }
    return {
      title: 'Install from Google Play',
      steps: [
        'Play builds cannot be downloaded as a file here. Testers install from the Play Store.',
        b.optInUrl ? 'A tester who was invited to the track opens the opt-in link below on the phone, joins, and installs from Play.' : 'For the internal track, the tester joins with the opt-in link from Play Console (Testing, Internal testing, Testers), then installs from Play.',
      ],
      caution: b.tracks.length === 0 ? 'No track holds this version code at the moment.' : null,
      downloads: false,
      qr: false,
      link: b.optInUrl ? { label: 'Open the opt-in page', href: b.optInUrl } : null,
    };
  }
  const kind = row.kind as ArtifactKind;
  switch (kind) {
    case 'apk':
      return {
        title: 'Install an Android APK',
        steps: ['On the phone: scan the code, or download the zip here and unzip it.', 'Open the APK and allow "Install unknown apps" for the app you opened it from, once.', 'Or from a computer: adb install app.apk (USB debugging on).'],
        caution: `${ZIP_NOTE} A debug or upload-key build cannot update a copy installed from Play (the signatures differ): remove that copy first.`,
        downloads: true,
        qr: true,
        link: null,
      };
    case 'aab':
      return {
        title: 'An Android App Bundle cannot be installed directly',
        steps: ['Turn it into installable APKs with bundletool: bundletool build-apks --connected-device --bundle=app.aab --output=app.apks', 'Then: bundletool install-apks --apks=app.apks', 'Or put the bundle on a Play internal test track and install from Play.'],
        caution: `${ZIP_NOTE} A phone cannot do this on its own, so there is no code for a phone.`,
        downloads: true,
        qr: false,
        link: null,
      };
    case 'ipa':
      return {
        title: 'Install an iOS IPA',
        steps: [
          'An ad hoc or development IPA only runs on devices that are in its provisioning profile (by UDID). Any other device refuses it.',
          'On a Mac: unzip, connect the device, and drag the IPA onto it in Finder, or use Apple Configurator or Xcode (Window, Devices and Simulators).',
          'An IPA built for the App Store cannot be installed this way: upload it to TestFlight instead.',
        ],
        caution: `${ZIP_NOTE} Installing over the air from a link is not offered: Apple needs a trusted public HTTPS address and a manifest for it.`,
        downloads: true,
        qr: false,
        link: null,
      };
    case 'app':
    case 'dmg':
    case 'pkg':
      return {
        title: 'Install a Mac build',
        steps: [
          kind === 'dmg' ? 'Open the DMG and drag the app to Applications.' : kind === 'pkg' ? 'Open the PKG and follow the installer.' : 'Unzip it and move the app to Applications.',
          'A downloaded app is checked by Gatekeeper. A notarized build opens normally; one that is not asks you to allow it in System Settings, Privacy and Security, "Open Anyway".',
        ],
        caution: ZIP_NOTE,
        downloads: true,
        qr: false,
        link: null,
      };
    case 'zip':
      return {
        title: 'A build in a zip',
        steps: ['Download it and unzip it to see what the workflow uploaded (an IPA, an APK, an AAB or a Mac app).', 'Then install it as described for that type.'],
        caution: ZIP_NOTE,
        downloads: true,
        qr: row.platform === 'android',
        link: null,
      };
    default:
      return {
        title: 'Not recognised as a build',
        steps: ['This artifact does not look like an app build (a test report, logs or symbols, for example).', 'You can still download it as a zip.'],
        caution: ZIP_NOTE,
        downloads: true,
        qr: false,
        link: null,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// States of the page

export type PageNotice = { tone: 'info' | 'warn' | 'error'; title: string; body: string };

/** Why the CI part of the list is empty or partial, in words a person can act on. */
export function problemNotice(problem: BuildsProblem | null, repo: { owner: string; repo: string } | null): PageNotice | null {
  if (!problem) return null;
  switch (problem.reason) {
    case 'no_repository':
      return { tone: 'info', title: 'No repository is linked to this app', body: 'CI builds appear here when the app is linked to a GitHub repository. The store builds below come from the last sync.' };
    case 'no_access':
      return {
        tone: 'warn',
        title: 'GitHub did not let us list the artifacts',
        body: `The credential of ${repo ? `${repo.owner}/${repo.repo}` : 'the repository'} needs read access to GitHub Actions: "Actions: read" for a fine-grained token or GitHub App, or the repo scope for a classic token. Add it in GitHub, then reload.`,
      };
    case 'rate_limited':
      return { tone: 'warn', title: 'GitHub asked us to slow down', body: 'The artifact list is paused for a moment. Try again in a minute.' };
    case 'unsupported':
      return { tone: 'info', title: 'This connection cannot list artifacts', body: 'The repository connection does not support reading workflow artifacts.' };
    default:
      return { tone: 'warn', title: 'GitHub could not be reached', body: 'The artifact list could not be read. Try again in a moment.' };
  }
}

/** Shown instead of a download button while the server switch is off. */
export const DOWNLOADS_OFF_TEXT =
  'Downloads are switched off on this server. An administrator turns them on with MRM_BUILDS_DOWNLOAD_ENABLED=true, and the GitHub credential needs "Actions: read".';

export const NO_RIGHT_TEXT = 'Downloading builds needs the member role or above.';

/** Why a row has no download button, or null when it has one. */
export function downloadBlocker(row: BuildRow, list: Pick<BuildsList, 'downloadEnabled' | 'canDownload' | 'maxDownloadBytes'>): string | null {
  if (!row.artifact) return null;
  if (!list.downloadEnabled) return DOWNLOADS_OFF_TEXT;
  if (!list.canDownload) return NO_RIGHT_TEXT;
  if (row.artifact.expired) return 'GitHub no longer keeps this artifact. Run the workflow again to make a new one.';
  if (row.artifact.tooLarge) return `Larger than the download limit (${humanSize(list.maxDownloadBytes)}).`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Addresses

export const downloadPath = (workspaceId: string, appId: string, artifactId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/download`;

/** The address a phone opens: the server's path on the address this page was reached at. */
export const phoneUrl = (origin: string, path: string): string => `${origin.replace(/\/+$/, '')}${path}`;

/** A phone cannot reach `localhost` or a private address by name; tell the person before they scan. */
export function phoneCannotReach(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return true;
  }
}

/** The address of the section for an app, optionally focused on one build (from the release stepper's build picker). */
export const testBuildsHref = (appId: string, platform: Platform | 'both' | null = null, build: string | null = null): string => {
  const base = appAddress(appId, 'test-builds', platform);
  return build ? `${base}${base.includes('?') ? '&' : '?'}build=${encodeURIComponent(build)}` : base;
};

/** Seconds left of a link, never negative. */
export const secondsLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000));

/** The number in a stepper row title ("Build 240"), or null for "Build (number unknown)". */
export const buildNumberOfTitle = (title: string): string | null => /^Build ([A-Za-z0-9._-]+)$/.exec(title)?.[1] ?? null;
