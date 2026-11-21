import type { Platform } from '@mrm/core';
import { platformSupports, supports } from '@mrm/core';
import { appAddress } from './app-scope.ts';
import { type EasBuildView, easBuildDetail, easBuildState, easBuildTitle } from './eas/eas-status.ts';

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
  /** Apps of a multi-app run whose artifact owner the name does not tell: shown under each of them. */
  sharedWith?: string[] | null;
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
  /** TestFlight: ids of the public-link groups the build is in; null when they were not read. */
  testflightGroupIds: string[] | null;
};

export type TestFlightProblemReason = 'no_access' | 'rate_limited' | 'unavailable' | 'not_synced';
export type TestFlightLink = {
  id: string;
  name: string;
  publicLink: string | null;
  enabled: boolean;
  limit: number | null;
};
export type TestFlightInfo = {
  groups: TestFlightLink[];
  withoutLink: number;
  problem: { reason: TestFlightProblemReason; needs: string | null } | null;
  readAt: number | null;
  cached: boolean;
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
  /** TestFlight public links, read only; null for an Android app. */
  testflight: TestFlightInfo | null;
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

export type RowSource = 'ci' | 'store' | 'eas';
export type RowKind = ArtifactKind | 'testflight' | 'play' | 'eas';

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
  /** An EAS build (docs/adr/0036-eas-build-submit-status.md): the third source, next to CI artifacts and store builds. */
  eas?: EasBuildView | undefined;
};

const runLabel = (a: ArtifactItem): string => {
  const run = a.run.number !== null ? `${a.run.workflow} #${a.run.number}` : a.run.workflow;
  return [run, a.run.branch, a.run.shortSha].filter((x): x is string => !!x).join(' · ');
};

const artifactState = (a: ArtifactItem): BuildRow['state'] => {
  if (a.expired) return { label: 'Expired', tone: 'bad' };
  if (a.tooLarge) return { label: 'Too large to download', tone: 'warn' };
  if (a.run.conclusion !== null && a.run.conclusion !== 'success')
    return { label: `Run ${a.run.conclusion.replace(/_/g, ' ')}`, tone: 'warn' };
  return { label: 'Available', tone: 'ok' };
};

const storeState = (b: StoreBuildItem): BuildRow['state'] => {
  if (b.expired === true) return { label: 'Expired', tone: 'bad' };
  if (b.state === 'processing') return { label: 'Processing', tone: 'info' };
  if (b.state === 'invalid') return { label: 'Invalid', tone: 'bad' };
  if (b.state === 'processed')
    return { label: b.channel === 'play' ? 'On a track' : 'Ready to test', tone: 'ok' };
  return { label: 'Unknown state', tone: 'neutral' };
};

/** The quiet chip for an artifact of a run shared by several apps when its owner is not known; '' otherwise. */
export const sharedNote = (a: Pick<ArtifactItem, 'sharedWith'>): string =>
  a.sharedWith && a.sharedWith.length > 1 ? `From a run shared by ${a.sharedWith.join(', ')}` : '';

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
  const where =
    b.channel === 'play'
      ? b.tracks.length > 0
        ? `Track ${b.tracks.join(', ')}`
        : 'No track'
      : 'TestFlight';
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

/** An EAS build as a row. Its files are not downloadable through this server: the Expo page of the build is the way to install it. */
export function easRow(b: EasBuildView, now: number = Date.now()): BuildRow {
  const expired = b.status === 'finished' && b.artifactExpiresAt !== null && b.artifactExpiresAt <= now;
  return {
    key: `eas:${b.id}`,
    source: 'eas',
    platform: b.platform,
    kind: 'eas',
    title: easBuildTitle(b),
    detail: easBuildDetail(b),
    runUrl: b.expoUrl,
    sizeBytes: null,
    at: b.createdAt,
    expiresAt: b.artifactExpiresAt,
    expired,
    state: expired ? { label: 'Expired', tone: 'bad' } : easBuildState(b),
    artifact: null,
    store: null,
    eas: b,
  };
}

/** Every build, newest first (a build with no date goes last). EAS builds are one more source; pass them when the app is linked to Expo. */
export function rowsOf(
  list: Pick<BuildsList, 'artifacts' | 'store'>,
  eas: readonly EasBuildView[] = [],
  now: number = Date.now(),
): BuildRow[] {
  const rows = [
    ...list.artifacts.map(artifactRow),
    ...list.store.map(storeRow),
    ...eas.map((b) => easRow(b, now)),
  ];
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

export const defaultFilters: BuildFilters = {
  platform: 'all',
  source: 'all',
  hideExpired: true,
  hideOther: true,
};

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
export function expiryText(
  row: Pick<BuildRow, 'expiresAt' | 'expired' | 'store'>,
  now: number,
): string {
  const estimated = row.store?.expiresAtEstimated === true;
  if (row.expiresAt === null) return row.expired ? 'expired' : '';
  const days = Math.floor((row.expiresAt - now) / DAY);
  const lead = estimated ? 'about ' : '';
  if (row.expired || row.expiresAt <= now) {
    const ago = Math.floor((now - row.expiresAt) / DAY);
    return row.expired && ago <= 0
      ? 'expired'
      : `expired ${ago <= 0 ? 'today' : `${ago} day${ago === 1 ? '' : 's'} ago`}`;
  }
  if (days <= 0) return `expires ${lead}today`;
  return `expires ${lead}in ${days} day${days === 1 ? '' : 's'}`;
}

export const kindLabel = (kind: RowKind): string =>
  ({
    ipa: 'IPA',
    apk: 'APK',
    aab: 'AAB',
    app: 'macOS app',
    dmg: 'DMG',
    pkg: 'PKG',
    zip: 'Zip',
    other: 'Other',
    testflight: 'TestFlight',
    play: 'Play',
    eas: 'EAS',
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

const ZIP_NOTE =
  'A workflow artifact is always a zip: unzip it first. The type shown is a guess from the artifact name.';

/** Installation guidance for an EAS build: this tool holds no file, so it points at the Expo page of the build. */
function easGuide(b: EasBuildView): Guide {
  const link = b.expoUrl ? { label: 'Open on Expo', href: b.expoUrl } : null;
  if (b.status !== 'finished') {
    return {
      title: b.status === 'errored' ? 'This EAS build failed' : 'This EAS build has not finished',
      steps: [
        b.status === 'errored'
          ? 'Open the build on Expo to read its log and the reason it failed, fix the cause and build again.'
          : 'Open the build on Expo to follow its progress. This page reads it again every few minutes while it runs.',
      ],
      caution: null,
      downloads: false,
      qr: false,
      link,
    };
  }
  if (b.simulator === true || b.distribution === 'simulator') {
    return {
      title: 'An iOS Simulator build',
      steps: [
        'A simulator build runs in the iOS Simulator on a Mac, not on a phone.',
        'Open the build on Expo to download it, then drag it onto a running simulator.',
      ],
      caution: 'Kiln does not download EAS builds; Expo does.',
      downloads: false,
      qr: false,
      link,
    };
  }
  if (b.internal) {
    return {
      title: 'Install an internal distribution build',
      steps: [
        'Open the build on Expo: for a build with internal distribution it has the install link for the device.',
        b.platform === 'android'
          ? 'On Android the link installs the build (the phone asks to allow installing from this source, once).'
          : 'On iOS an internal build only runs on devices that are in its provisioning profile (registered by UDID, or an enterprise profile).',
      ],
      caution: 'Kiln does not download EAS builds and holds no install link of its own; Expo does.',
      downloads: false,
      qr: false,
      link,
    };
  }
  return {
    title: 'A build for store distribution',
    steps: [
      'A store distribution build is meant to be sent to the store, not installed from a link.',
      'Submit it with EAS Submit (the submissions below show how that went), or upload it to the store yourself, then test it from TestFlight or Google Play.',
    ],
    caution: null,
    downloads: false,
    qr: false,
    link,
  };
}

/** Plain installation guidance for a row. Never promises more than the tool can do. */
export function installGuide(row: BuildRow): Guide {
  if (row.eas) return easGuide(row.eas);
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
        caution:
          b.expired === true
            ? 'This build has expired and cannot be installed any more.'
            : b.state === 'processing'
              ? 'Apple is still processing this build; it cannot be installed yet.'
              : b.expiresAtEstimated
                ? 'A TestFlight build lasts 90 days from its upload; the date shown is that estimate.'
                : null,
        downloads: false,
        qr: false,
        link: null,
      };
    }
    return {
      title: 'Install from Google Play',
      steps: [
        'Play builds cannot be downloaded as a file here. Testers install from the Play Store.',
        b.optInUrl
          ? 'A tester who was invited to the track opens the opt-in link below on the phone, joins, and installs from Play.'
          : 'For the internal track, the tester joins with the opt-in link from Play Console (Testing, Internal testing, Testers), then installs from Play.',
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
        steps: [
          'On the phone: scan the code, or download the zip here and unzip it.',
          'Open the APK and allow "Install unknown apps" for the app you opened it from, once.',
          'Or from a computer: adb install app.apk (USB debugging on).',
        ],
        caution: `${ZIP_NOTE} A debug or upload-key build cannot update a copy installed from Play (the signatures differ): remove that copy first.`,
        downloads: true,
        qr: true,
        link: null,
      };
    case 'aab':
      return {
        title: 'An Android App Bundle cannot be installed directly',
        steps: [
          'Turn it into installable APKs with bundletool: bundletool build-apks --connected-device --bundle=app.aab --output=app.apks',
          'Then: bundletool install-apks --apks=app.apks',
          'Or put the bundle on a Play internal test track and install from Play.',
        ],
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
          kind === 'dmg'
            ? 'Open the DMG and drag the app to Applications.'
            : kind === 'pkg'
              ? 'Open the PKG and follow the installer.'
              : 'Unzip it and move the app to Applications.',
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
        steps: [
          'Download it and unzip it to see what the workflow uploaded (an IPA, an APK, an AAB or a Mac app).',
          'Then install it as described for that type.',
        ],
        caution: ZIP_NOTE,
        downloads: true,
        qr: platformSupports(row.platform, 'sideloadInstall'),
        link: null,
      };
    default:
      return {
        title: 'Not recognised as a build',
        steps: [
          'This artifact does not look like an app build (a test report, logs or symbols, for example).',
          'You can still download it as a zip.',
        ],
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
export function problemNotice(
  problem: BuildsProblem | null,
  repo: { owner: string; repo: string } | null,
): PageNotice | null {
  if (!problem) return null;
  switch (problem.reason) {
    case 'no_repository':
      return {
        tone: 'info',
        title: 'No repository is linked to this app',
        body: 'CI builds appear here when the app is linked to a GitHub repository. The store builds below come from the last sync.',
      };
    case 'no_access':
      return {
        tone: 'warn',
        title: 'GitHub did not let us list the artifacts',
        body: `The credential of ${repo ? `${repo.owner}/${repo.repo}` : 'the repository'} needs read access to GitHub Actions: "Actions: read" for a fine-grained token or GitHub App, or the repo scope for a classic token. Add it in GitHub, then reload.`,
      };
    case 'rate_limited':
      return {
        tone: 'warn',
        title: 'GitHub asked us to slow down',
        body: 'The artifact list is paused for a moment. Try again in a minute.',
      };
    case 'unsupported':
      return {
        tone: 'info',
        title: 'This connection cannot list artifacts',
        body: 'The repository connection does not support reading workflow artifacts.',
      };
    default:
      return {
        tone: 'warn',
        title: 'GitHub could not be reached',
        body: 'The artifact list could not be read. Try again in a moment.',
      };
  }
}

/** What the "TestFlight" row of a store build shows. The app only READS these groups: it never creates or turns on a link. */
export type TestFlightView =
  | { kind: 'hidden' }
  | { kind: 'message'; tone: 'info' | 'warn'; text: string }
  | {
      kind: 'links';
      links: (TestFlightLink & { state: 'on' | 'off'; stateText: string; limitText: string })[];
    };

export const TESTFLIGHT_NONE_TEXT =
  'No TestFlight group has a public link. Kiln only reads TestFlight and never creates or turns on a group or a link: set one up in App Store Connect (TestFlight, a group, Enable Public Link).';

/** The one line for a failed TestFlight read, in the fixed vocabulary of the server (never Apple's text). */
const flightProblemText = (reason: TestFlightProblemReason): string => {
  switch (reason) {
    case 'no_access':
      return 'App Store Connect did not let us read the TestFlight groups. The API key of this app needs the App Manager role (the least role that works is not confirmed). Change the key in App Store Connect, then reload.';
    case 'rate_limited':
      return 'App Store Connect asked us to slow down. The TestFlight links are paused for a moment: try again in a minute.';
    case 'not_synced':
      return 'Sync this app once so its App Store id is known, then the TestFlight links can be read.';
    default:
      return 'The TestFlight links could not be read. Try again in a moment.';
  }
};

/**
 * What to say ONCE for the whole list about TestFlight, instead of on every row: the read failed (with a way to retry), or no group has a
 * public link. Null when there is nothing to say (no TestFlight build, or links to show). `short` is the line; `text` the full words.
 */
export type TestFlightNote = { tone: 'info' | 'warn'; short: string; text: string; retry: boolean };
export function testflightNote(
  list: Pick<BuildsList, 'testflight' | 'store'>,
): TestFlightNote | null {
  const info = list.testflight;
  if (!info || !list.store.some((b) => b.channel === 'testflight')) return null;
  if (info.problem) {
    const warn = info.problem.reason !== 'not_synced';
    return {
      tone: warn ? 'warn' : 'info',
      short:
        info.problem.reason === 'not_synced'
          ? 'TestFlight links: sync this app first.'
          : 'TestFlight links could not be read.',
      text: flightProblemText(info.problem.reason),
      retry: info.problem.reason !== 'not_synced',
    };
  }
  if (info.groups.length === 0)
    return {
      tone: 'info',
      short: 'No TestFlight public link yet.',
      text: TESTFLIGHT_NONE_TEXT,
      retry: false,
    };
  return null;
}

/** The TestFlight links of one store build. Whole-list messages (a failed read, no public link, an expired build) are not repeated per row: see `testflightNote`. */
export function testflightView(
  list: Pick<BuildsList, 'testflight'>,
  b: StoreBuildItem,
): TestFlightView {
  const info = list.testflight;
  if (
    !info ||
    b.channel !== 'testflight' ||
    info.problem ||
    b.expired === true ||
    info.groups.length === 0
  )
    return { kind: 'hidden' };
  const ids = new Set(b.testflightGroupIds ?? []);
  const links = info.groups
    .filter((g) => ids.has(g.id))
    .map((g) => ({
      ...g,
      state: g.enabled ? ('on' as const) : ('off' as const),
      stateText: g.enabled ? 'Link on' : 'Link off',
      limitText:
        g.limit === null ? 'No tester limit' : `Up to ${g.limit} tester${g.limit === 1 ? '' : 's'}`,
    }));
  if (links.length === 0)
    return {
      kind: 'message',
      tone: 'info',
      text: 'This build is not in a TestFlight group that has a public link.',
    };
  return { kind: 'links', links };
}

/**
 * One compact status line for the page, in place of stacked notices: downloads switched off and a problem reading the CI artifacts become
 * one sentence with their full words behind a "Details" button. Null when all is well.
 */
export type StatusLine = {
  tone: 'info' | 'warn' | 'error';
  text: string;
  details: { title: string; body: string }[];
};
export function statusLine(
  list: Pick<BuildsList, 'downloadEnabled' | 'problem' | 'repository'>,
): StatusLine | null {
  const notice = problemNotice(list.problem, list.repository);
  const parts: string[] = [];
  const details: StatusLine['details'] = [];
  if (!list.downloadEnabled) {
    parts.push('Downloads are off');
    details.push({ title: 'Downloads are switched off', body: DOWNLOADS_OFF_TEXT });
  }
  if (notice) {
    parts.push(notice.title);
    details.push({ title: notice.title, body: notice.body });
  }
  if (parts.length === 0) return null;
  const tone = notice && notice.tone !== 'info' ? notice.tone : 'info';
  return { tone, text: parts.join(' · '), details };
}

/** Shown instead of a download button while the server switch is off. */
export const DOWNLOADS_OFF_TEXT =
  'Downloads are switched off on this server. An administrator turns them on with MRM_BUILDS_DOWNLOAD_ENABLED=true, and the GitHub credential needs "Actions: read".';

export const NO_RIGHT_TEXT = 'Downloading builds needs the member role or above.';

/** Why a row has no download button, or null when it has one. */
export function downloadBlocker(
  row: BuildRow,
  list: Pick<BuildsList, 'downloadEnabled' | 'canDownload' | 'maxDownloadBytes'>,
): string | null {
  if (!row.artifact) return null;
  if (!list.downloadEnabled) return DOWNLOADS_OFF_TEXT;
  if (!list.canDownload) return NO_RIGHT_TEXT;
  if (row.artifact.expired)
    return 'GitHub no longer keeps this artifact. Run the workflow again to make a new one.';
  if (row.artifact.tooLarge)
    return `Larger than the download limit (${humanSize(list.maxDownloadBytes)}).`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Addresses

export const downloadPath = (workspaceId: string, appId: string, artifactId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/download`;

/** The address a phone opens: the server's path on the address this page was reached at. */
export const phoneUrl = (origin: string, path: string): string =>
  `${origin.replace(/\/+$/, '')}${path}`;

/** A phone cannot reach `localhost` or a private address by name; tell the person before they scan. */
export function phoneCannotReach(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return true;
  }
}

/** The address of the Test builds view of Builds for an app, optionally focused on one build (from the release stepper's build picker). */
export const testBuildsHref = (
  appId: string,
  platform: Platform | 'both' | null = null,
  build: string | null = null,
): string => {
  const base = appAddress(appId, 'builds', platform);
  const view = `${base}${base.includes('?') ? '&' : '?'}view=tests`;
  return build ? `${view}&build=${encodeURIComponent(build)}` : view;
};

/** Seconds left of a link, never negative. */
export const secondsLeft = (expiresAt: number, now: number): number =>
  Math.max(0, Math.ceil((expiresAt - now) / 1000));

/** The number in a stepper row title ("Build 240"), or null for "Build (number unknown)". */
export const buildNumberOfTitle = (title: string): string | null =>
  /^Build ([A-Za-z0-9._-]+)$/.exec(title)?.[1] ?? null;

// ---------------------------------------------------------------------------------------------
// Share to device: Google Play internal app sharing (docs/api/internal-sharing.md, docs/adr/0020-play-internal-sharing.md)

export type InternalSharingConfig = {
  enabled: boolean;
  envName?: string;
  linkRetentionHours: number;
  maxBytes: number | null;
  /** Whether the caller's role may share (owner and admin). */
  canShare: boolean;
  note?: string;
};

export type ShareCheck = { code: string; severity: 'blocking' | 'warning'; message: string };

export type SharePreview = {
  app: { id: string; name: string; platform: string; identifier: string };
  artifact: {
    id: string;
    name: string;
    kind: string;
    sizeBytes: number;
    zipSha256: string | null;
    runId: string | null;
    headSha: string | null;
    createdAt: number | null;
    expiresAt: number | null;
  };
  upload: {
    packageName: string;
    kind: 'bundle' | 'apk' | null;
    fileName: string | null;
    entry: string | null;
    versionCode: number | null;
    sha256: string | null;
    maxSizeBytes: number;
  };
  effects: string[];
  linkRetentionHours: number;
  checks: { blocking: ShareCheck[]; warnings: ShareCheck[]; canShare: boolean };
  confirmHash: string | null;
  confirmation: { phrase: string; instruction: string } | null;
  readAt: number;
};

export type ShareResult = {
  share: {
    id: string;
    packageName: string;
    kind: 'bundle' | 'apk';
    fileName: string | null;
    sizeBytes: number;
    sha256: string;
    createdAt: number;
    expiresAt: number;
    hasLink: boolean;
  };
  /** SENSITIVE: whoever holds it and is allowed by Google can install the build. Never log it, never put it in an address. */
  downloadUrl: string;
  checksumMatches: boolean | null;
  note: string;
};

/** The phrase to type, as the server expects it. The preview carries the same text; this is for tests and a fallback. */
export const sharePhrase = (packageName: string): string => `SHARE ${packageName}`;

/** The button shows only for an Android artifact that can be a build, when the server offers sharing and the role may use it. */
export function canOfferShare(
  row: Pick<BuildRow, 'source' | 'platform' | 'artifact'>,
  config: Pick<InternalSharingConfig, 'enabled' | 'canShare'> | null,
): boolean {
  if (!config?.enabled || !config.canShare) return false;
  if (row.source !== 'ci' || !platformSupports(row.platform, 'internalAppSharing') || !row.artifact)
    return false;
  return !row.artifact.expired && !row.artifact.tooLarge;
}

/** A name for the file inside the upload, or the honest "found when you confirm". */
export const uploadFileText = (u: Pick<SharePreview['upload'], 'fileName' | 'kind'>): string => {
  const kind = u.kind === 'bundle' ? 'Android App Bundle (.aab)' : u.kind === 'apk' ? 'APK' : null;
  if (u.fileName) return kind ? `${u.fileName} (${kind})` : u.fileName;
  return kind ?? 'The .aab or .apk inside the zip, found when you confirm';
};

/** The version code is known only when the server read the file; today it does not before the upload. */
export const versionCodeText = (v: number | null): string =>
  v === null ? 'Not known before the upload' : String(v);

export const shortHash = (sha: string | null): string =>
  sha ? `${sha.slice(0, 12)}…${sha.slice(-6)}` : 'Not known before the upload';

/** True when what was typed is the phrase (spaces at the ends do not matter; case does). */
export const phraseMatches = (typed: string, phrase: string | null | undefined): boolean =>
  !!phrase && typed.trim() === phrase;

/** Words for a link's life: "24 hours" for the server's copy; Google's own expiry is not known here. */
export const linkKeptText = (hours: number): string =>
  `This server keeps the link for ${hours} hour${hours === 1 ? '' : 's'}, then forgets it. Share the build again to get a new one.`;

export const LINK_SENSITIVE_TEXT =
  'This link is sensitive. Anyone who has it and whose Google account is allowed to use internal app sharing can install this build. Send it only to the people who should test it.';

/** What this does not do, said once in the preview. */
export const SHARE_CANNOT_UNDO_TEXT =
  'This cannot be taken back from here: Google offers no way to delete an uploaded build or its link.';

/** The entry names a server lists when one artifact holds several builds (at most 20). */
export function entryChoices(body: Record<string, unknown> | undefined): string[] {
  const list = body && Array.isArray(body.entries) ? body.entries : [];
  return list.filter((x): x is string => typeof x === 'string');
}

/**
 * One plain sentence for every fixed code the preview and the apply answer with. Unknown codes give undefined: the caller shows its own
 * fallback. Google's wording is never shown (the server does not pass it on).
 */
export function shareErrorMessage(code: string, retryAfter?: number): string | undefined {
  switch (code) {
    case 'internal_sharing_disabled':
      return 'Sharing to a device is switched off on this server.';
    case 'forbidden':
      return 'Only an owner or an admin can share a build to a device.';
    case 'not_android':
      return 'Sharing to a device is for Android apps.';
    case 'invalid_entry':
      return 'That is not the path of an .aab or .apk file inside the artifact.';
    case 'entry_required':
      return 'This artifact holds more than one build file. Choose the one to share.';
    case 'entry_not_found':
      return 'That file is not in the artifact. Choose another.';
    case 'no_android_build':
      return 'There is no .aab or .apk in this artifact, so nothing was uploaded.';
    case 'bad_zip':
      return 'This artifact could not be read as a zip, so nothing was uploaded.';
    case 'artifact_expired':
      return 'GitHub no longer keeps this artifact. Run the workflow again to make a new one.';
    case 'artifact_too_large':
      return 'This build is larger than the limit this server allows, so nothing was uploaded.';
    case 'confirmation_mismatch':
      return 'The words you typed do not match. Nothing was uploaded.';
    case 'state_changed':
      return 'The artifact changed since it was previewed. Nothing was uploaded. Review the new preview and confirm again.';
    case 'blocked':
      return 'Something stands in the way of sharing. Nothing was uploaded.';
    case 'write_in_progress':
      return 'A build of this app is being uploaded already. Wait for it to finish.';
    case 'store_auth':
      return 'Google rejected the credential of this app. Replace it in Credentials, then try again.';
    case 'store_forbidden':
      return 'The credential of this app is not allowed to do this, or the Android Publisher API is off for its Google Cloud project.';
    case 'store_not_found':
      return 'Google does not know this package. Nothing was uploaded.';
    case 'artifact_rejected':
      return 'Google did not accept the file: it is not a valid, signed build for this package.';
    case 'rate_limited':
      return `Too many requests. Try again in ${retryAfter && retryAfter > 0 ? (retryAfter < 60 ? `${Math.ceil(retryAfter)} seconds` : `${Math.ceil(retryAfter / 60)} minutes`) : 'a minute'}.`;
    case 'upload_failed':
      return 'The upload to Google failed. Nothing was shared. Try again later.';
    case 'outcome_unknown':
      return 'The upload may or may not have reached Google, and Google cannot be asked. Preview again before you share again; sharing twice only makes a second link.';
    case 'link_expired':
      return 'This link is no longer kept. Share the build again to get a new one.';
    case 'not_found':
      return 'That build or app was not found.';
    default:
      return undefined;
  }
}

/** The refusal the dialog shows for an error: a fixed sentence for the code, else the API client's own text. */
export function shareFailure(error: {
  code?: unknown;
  retryAfter?: unknown;
  message?: unknown;
}): string {
  const code = typeof error.code === 'string' ? error.code : '';
  const fixed = shareErrorMessage(
    code,
    typeof error.retryAfter === 'number' ? error.retryAfter : undefined,
  );
  return (
    fixed ??
    (typeof error.message === 'string' && error.message
      ? error.message
      : 'Could not share the build. Try again.')
  );
}

/** Blocking and warning lines of a preview as one list, blocking first. The server's messages are fixed text and safe to show. */
export function previewNotes(
  preview: Pick<SharePreview, 'checks'>,
): { tone: 'error' | 'warn'; text: string }[] {
  return [
    ...preview.checks.blocking.map((c) => ({ tone: 'error' as const, text: c.message })),
    ...preview.checks.warnings.map((c) => ({ tone: 'warn' as const, text: c.message })),
  ];
}

/** A preview the apply may use: not blocked, with a hash and a phrase. */
export const previewReady = (
  p: Pick<SharePreview, 'checks' | 'confirmHash' | 'confirmation'>,
): boolean => p.checks.canShare && !!p.confirmHash && !!p.confirmation;

/** The `state_changed` answer carries a new preview; this returns it when it looks like one. */
export function previewFromBody(body: Record<string, unknown> | undefined): SharePreview | null {
  const p = body?.preview as Partial<SharePreview> | undefined;
  return p && typeof p === 'object' && p.artifact && p.upload && p.checks
    ? (p as SharePreview)
    : null;
}
