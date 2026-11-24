# ADR 0061: Install dialog for EAS builds, build file address, Open with Orbit

Status: web, server, connector and migration 65 implemented, tested against hand-written fixtures; **not viewed in a browser, no real Expo or Orbit run**.
API: [api/eas-builds](../api/eas-builds.md). Amends decision 5 of [ADR 0036](0036-eas-build-submit-status.md).

## Context

"Install" on an EAS build only opened a help text that sent people to expo.dev. Expo's own build page has an install dialog (QR code, the link, help
for Android, a download button), and Expo Orbit installs builds from a desktop menu bar. People asked for the same inside Kiln.

## Decision

1. **The install dialog** (`EasInstallDialog`, shared `Modal`) opens from Install for a finished, unexpired build with internal or simulator
   distribution. Other builds show the button disabled with the reason. It shows a QR code of the build's page at expo.dev (`expoUrl`, the address
   Expo's own dialog encodes: UNVERIFIED against a live dialog), the address in a read-only field with Copy, Open on Expo, platform help, and the
   expiry date. A simulator build gets no QR code (a camera cannot install it).
2. **The QR code is drawn locally** by `lib/qr.ts` (our own encoder, already used for the authenticator and the phone link). No service, no
   image from outside, CSP unchanged (ADR 0049). Always black on white with a quiet zone, in every theme.
3. **The build file address is now stored** (`eas_builds.artifact_url`, migration 65; Expo's `artifacts.buildUrl`, else `applicationArchiveUrl`,
   https only). This reverses ADR 0036 decision 5 on purpose, because "Download build" and "Open with Orbit" need it. The guard moves from
   "never stored" to "returned only when allowed": the routes include `artifactUrl` only when `KILN_BUILDS_DOWNLOAD_ENABLED` is on and the role
   has `builds.download`; otherwise it is `null`. It is never logged, audited, put in an event or an alert.
4. **No binary proxy.** "Download build" is a plain link to Expo (new tab, `rel="noopener noreferrer"`). The file never passes through Kiln.
   Expo gives no file size, so none is shown.
5. **Open with Orbit** is a link with Orbit's custom scheme, drawn on desktop only (not on a phone or tablet), for builds Orbit can install (see
   the API doc). A click cannot be detected, so a hint with the Orbit release page appears after it. The scheme and parameters are **not
   documented by Expo**: `expo-orbit://download?url=<encoded file address>` is an ASSUMPTION kept in one constant (`ORBIT_SCHEME` in
   `lib/eas/eas-install.ts`) and must be checked against a real Orbit before it is trusted.
6. **No CSP or desktop change.** A link to a custom scheme is not governed by the CSP directives this app sets. The Tauri shell has no opener
   plugin and no navigation allowlist (`capabilities/default.json` is `core:default`), so there was nothing to extend; whether the system hands
   `expo-orbit://` to Orbit from inside the desktop webview is UNVERIFIED.

## Consequences

A database holds Expo's file addresses (readable by anyone with the database, like the other synced data). If Expo's addresses prove to be signed
and short-lived, the stored one goes stale until the next read of Expo (every 30 minutes by default).
