import { type Platform, supports } from '@kiln/core';

/**
 * Links to the store's own pages for a release, built from what is stored about the app: only addresses. Pure.
 *
 * - iOS and macOS: App Store Connect, the app's version page. The address needs the Apple app id (`storeAppId`). The version page of
 *   the version in review is `/apps/<app id>/appstore/<platform>/version/inflight` (the version that is not on the store yet); the
 *   id of the version record is not stored here, and the address with it is not documented by Apple, so this one is used.
 * - Android: Google Play Console. Its app pages need the developer account id and the numeric app id, and Google Play's API gives
 *   neither (it knows the package name only), so the best address that can be built from what is stored is the Console itself,
 *   where the app is one click away. `packageName` is not part of any Console address, so it is not used.
 */
export const PLAY_CONSOLE_URL = 'https://play.google.com/console/';

const APP_STORE_CONNECT = 'https://appstoreconnect.apple.com';

/** App Store Connect's list of apps: where a blocker of a submit is fixed when the app's own page cannot be built. */
export const APP_STORE_CONNECT_APPS_URL = `${APP_STORE_CONNECT}/apps`;

/** The address where the review of the version in progress can be followed, or null when none can be built. */
export function reviewUrl(app: { platform: Platform; storeAppId: string | null }): string | null {
  if (supports(app.platform, 'releaseTracks')) return PLAY_CONSOLE_URL;
  const id = (app.storeAppId ?? '').trim();
  if (!/^\d+$/.test(id)) return null;
  const store = app.platform === 'macos' ? 'macos' : 'ios';
  return `${APP_STORE_CONNECT}/apps/${id}/appstore/${store}/version/inflight`;
}
