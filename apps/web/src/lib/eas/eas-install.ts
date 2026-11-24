/**
 * The install dialog of an EAS build (docs/adr/0061-eas-install-dialog.md): what may be offered for one build, and the links. Pure: no DOM
 * and no text (the dialog words everything through i18n; this file returns codes). Inputs are the stored build (`EasBuildView`).
 *
 * - The install address is the page of the build at expo.dev (`expoUrl`, `https://expo.dev/accounts/<account>/projects/<slug>/builds/<id>`):
 *   it is what Expo's own install dialog puts in its QR code, and Expo shows the install link for the device there.
 * - "Download build" and "Open with Orbit" need the address of the build file (`artifactUrl`), which the server returns only where the
 *   downloads switch is on and the role may download. Both are plain links to Expo: the file never passes through this server.
 */
import type { EasBuildView } from './eas-status.ts';

/** The Expo Orbit release page (macOS, Windows, Linux builds; `brew install expo-orbit` on macOS). Documented by Expo. */
export const ORBIT_DOWNLOAD_URL = 'https://github.com/expo/orbit/releases';
/** Expo's page on internal distribution (ad hoc and enterprise provisioning, installing from the link). */
export const INTERNAL_DISTRIBUTION_DOCS_URL = 'https://docs.expo.dev/build/internal-distribution/';
/**
 * UNVERIFIED: Expo's documentation does not describe Orbit's URL scheme. `expo-orbit://download?url=<encoded address>` is the shape this
 * tool uses; it is built in ONE place (`orbitLink`) so it can be corrected without touching the dialog.
 */
export const ORBIT_SCHEME = 'expo-orbit://download';

export type InstallBlock =
  /** Queued or running. */
  | 'running'
  | 'failed'
  | 'expired'
  /** Store distribution: meant for the store, not for a link. */
  | 'store'
  /** Neither the Expo page nor a file address is known. */
  | 'noLink';

export type InstallPlan = {
  /** Why the Install button is disabled; null when the dialog may open. */
  block: InstallBlock | null;
  /** Draw the QR code: an internal build for a device (not a simulator build) with the Expo page address. */
  qr: boolean;
  /** An iOS Simulator build (no QR flow; Orbit or a download is the way). */
  simulator: boolean;
};

type Installable = Pick<
  EasBuildView,
  | 'status'
  | 'distribution'
  | 'internal'
  | 'simulator'
  | 'platform'
  | 'expoUrl'
  | 'artifactUrl'
  | 'artifactExpiresAt'
>;

const isSimulator = (b: Pick<EasBuildView, 'simulator' | 'distribution'>): boolean =>
  b.simulator === true || b.distribution === 'simulator';

/** Whether the artifact is past its expiry date (a build without a date does not expire here). */
export const isExpired = (b: Pick<EasBuildView, 'status' | 'artifactExpiresAt'>, now: number) =>
  b.status === 'finished' && b.artifactExpiresAt !== null && b.artifactExpiresAt <= now;

/** What the Install button may do for a build. */
export function installPlan(b: Installable, now: number): InstallPlan {
  const simulator = isSimulator(b);
  const plan = (block: InstallBlock | null): InstallPlan => ({
    block,
    qr: block === null && !simulator && b.internal && b.expoUrl !== null,
    simulator,
  });
  if (b.status === 'errored' || b.status === 'canceled') return plan('failed');
  if (b.status !== 'finished') return plan('running');
  if (isExpired(b, now)) return plan('expired');
  if (!b.internal && !simulator) return plan('store');
  if (b.expoUrl === null && b.artifactUrl === null) return plan('noLink');
  return plan(null);
}

export type FileKind = 'apk' | 'aab' | 'ipa' | 'tar.gz' | 'file';

/** The kind of a build file from the end of its address (`.apk`, `.aab`, `.ipa`, `.tar.gz`); anything else is `file`. */
export function fileKind(address: string): FileKind {
  let path = address;
  try {
    path = new URL(address).pathname;
  } catch {
    // keep the text as it is
  }
  const p = path.toLowerCase();
  if (p.endsWith('.apk')) return 'apk';
  if (p.endsWith('.aab')) return 'aab';
  if (p.endsWith('.ipa')) return 'ipa';
  if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) return 'tar.gz';
  return 'file';
}

const isHttps = (address: string): boolean => {
  try {
    return new URL(address).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The direct download of the build file, or null (no address, not finished, expired). Opened in a new tab; never proxied. */
export function downloadOf(b: Installable, now: number): { href: string; kind: FileKind } | null {
  if (b.status !== 'finished' || isExpired(b, now)) return null;
  if (b.artifactUrl === null || !isHttps(b.artifactUrl)) return null;
  return { href: b.artifactUrl, kind: fileKind(b.artifactUrl) };
}

/**
 * The link that opens a build in Expo Orbit, or null when Orbit cannot install it. Per Expo's Orbit page: Orbit installs builds on
 * simulators and devices, and local files that are an Android `.apk`, an iOS Simulator `.app` or an ad hoc signed app. So: an internal
 * Android build that is not an AAB, an iOS Simulator build, and an internal iOS device build. A store build or an AAB: null.
 * (Simulator `tar.gz` and device `.ipa` downloads are what Expo builds produce; that Orbit takes those addresses is UNVERIFIED.)
 */
export function orbitLink(b: Installable, now: number): string | null {
  const file = downloadOf(b, now);
  if (!file) return null;
  const simulator = isSimulator(b);
  if (!simulator && !b.internal) return null;
  if (b.platform === 'android' && (simulator || file.kind === 'aab')) return null;
  if (b.platform !== 'android' && b.platform !== 'ios') return null;
  return `${ORBIT_SCHEME}?url=${encodeURIComponent(file.href)}`;
}

/** Phones and tablets: Orbit is a desktop app, so its button is not drawn there. */
export function isMobileUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS/i.test(userAgent);
}
