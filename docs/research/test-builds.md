# Research: seeing, downloading and installing test builds

Goal: "a place to see bundles / ipa / builds, download them and install them on a device before publishing".
Sources: official docs read on 2026-11-19 (GitHub REST "Artifacts", Apple Deployment guide "Distribute
proprietary in-house apps", Android Publisher `internalappsharingartifacts.uploadbundle`, Android
`bundletool`). **Nothing here was run against live GitHub, Apple or Google.** UNVERIFIED marks what is from
memory or inference only.

## 1. GitHub Actions artifacts

| Fact                                                                                                                                                                                              | Status                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `GET /repos/{o}/{r}/actions/artifacts` (`per_page` max 100, `page`, `name`), `GET /actions/runs/{id}/artifacts`, `GET /actions/artifacts/{id}`                                                    | documented                     |
| Fields: `id, name, size_in_bytes, url, archive_download_url, expired, created_at, updated_at, expires_at, digest (sha256), workflow_run{id, head_branch, head_sha, repository_id}`                | documented                     |
| `GET /actions/artifacts/{id}/zip` answers `302` with the URL in `Location`; the URL is short-lived (docs: "expires after 1 minute"); `410` when the artifact is gone; format is only `zip`        | documented                     |
| Token: fine-grained "Actions: read" for list, get and download (write only for delete); classic PAT / OAuth need `repo` for private repositories; public repositories can be read unauthenticated | documented                     |
| The `Location` URL carries its own signature: it must be fetched WITHOUT the `Authorization` header (sending the GitHub token to the blob host is wrong and may fail)                             | UNVERIFIED (standard practice) |
| Default retention 90 days (repository/org setting 1 to 90 days, `retention-days` per upload); the docs page does not state it, so read `expires_at`, never assume                                 | partly documented              |
| A GitHub App installation token needs the App permission "Actions: read"                                                                                                                          | UNVERIFIED                     |
| Every artifact is a zip, even a single file: `upload-artifact` v4 zips the files; v4+ has `archive: false` for a single file (newer; no zip wrapper)                                              | UNVERIFIED                     |
| Artifacts are immutable per run in v4 and listed per name once                                                                                                                                    | UNVERIFIED                     |

How a build workflow typically produces them: `actions/upload-artifact` with a `path:` (`build/*.ipa`,
`app/build/outputs/apk/release/*.apk`, `**/*.aab`, `build/macos/Build/Products/Release/*.app` zipped as
`App.app.zip` by `ditto -c -k --keepParent`, `*.dmg`). The artifact is a zip that holds those files, so the
user downloads a zip. Names are chosen by the team (`ios-build`, `app-release`), so the name alone often
does not say what is inside. Recognising content cheaply: a zip keeps its **central directory at the end**
(End Of Central Directory record, 22 bytes plus comment, then entries with name, sizes and offsets).
Reading the last 64 KiB (an HTTP `Range` request against the signed URL, if the blob store honours it:
UNVERIFIED) lists the entries without downloading the artifact. This build does NOT do that: kind is guessed
from the artifact name, the workflow name and the platform of the app, and says "guess" in the UI. A
ranged central-directory read is a follow-up (needs a decision, see the report).

## 2. Installing on a device, by platform

**Android**

- APK: direct. `adb install app.apk` (USB or `adb connect`), or open the file on the phone (needs "Install
  unknown apps" for the browser/file app once). A QR code that holds a short-lived link to the APK is the
  quickest hand-off. A release APK must be signed; an unsigned or debug-signed one installs for testing only
  and cannot update a Play-signed install (signature mismatch). UNVERIFIED for upload-key vs app-signing key
  detail.
- AAB: **cannot be installed directly.** `bundletool build-apks --connected-device --bundle=a.aab
  --output=a.apks`, then `bundletool install-apks --apks=a.apks` (documented). Without signing flags it signs
  with a debug key (documented). A phone cannot do this alone, so the UI shows the commands, never a QR.
- Play internal testing: testers join through an opt-in link and install from the Play Store. The API
  (`tracks`, `bundles`) tells which version codes sit on a track; the opt-in URL of the internal track is
  shown in Play Console only, NOT in the Publisher API (UNVERIFIED: nothing in `tracks`/`testers` returns it).
  Closed/open tracks use `https://play.google.com/apps/testing/<package>` (UNVERIFIED, long-standing pattern).
- Internal app sharing: `POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/internalappsharing/{packageName}/artifacts/bundle` (and `/apk`),
  scope `androidpublisher`; the response has `downloadUrl`, `certificateFingerprint`, `sha256` (documented).
  It is a binary UPLOAD to Google: a store write, outside the read-only store rule. **Not built.** It would
  give a shareable install link for an AAB without bundletool. Needs an explicit gated feature.

**iOS / iPadOS**

- Store builds (TestFlight, App Store) cannot be downloaded as files. Install through the TestFlight app:
  internal testers (App Store Connect users, up to 100) get the build automatically; external testers join via
  an email invite or a **public link** (`betaGroups` attributes `publicLink`, `publicLinkEnabled`, `publicLinkLimit`,
  `publicLinkLimitEnabled`; read-only, see "TestFlight public links" below). A TestFlight build
  expires 90 days after upload (Apple's TestFlight help; the build's `expired` attribute is the truth).
- Ad hoc or development-signed IPA: only runs on devices whose UDID is in the provisioning profile (ad hoc
  profile: 100 devices per device type per membership year: UNVERIFIED here, commonly cited). Install options:
  (a) Finder (macOS), drag the IPA onto the device; Apple Configurator "Add apps" (documented in Apple
  Configurator help: UNVERIFIED here); Xcode "Devices and Simulators" "+"; (b) over the air with
  `itms-services://?action=download-manifest&url=https://.../manifest.plist`.
- OTA via itms-services: Apple's deployment guide describes it for **in-house (Enterprise Program)** apps:
  HTTPS for the manifest and the IPA, a certificate iOS trusts (no self-signed), `text/xml` for the plist and
  `application/octet-stream` for the IPA, the device must reach `ocsp.apple.com`, and the profile expires
  after 12 months (documented). That page does not mention ad hoc; OTA of ad hoc IPAs works in practice
  (UNVERIFIED, third-party sources only). iOS 18+ asks to trust a manually installed in-house profile.
  **Decision: not built.** A manifest must name the IPA URL and bundle id/version, and the IPA must be served
  over a public HTTPS URL the phone can reach; the manifest is plain text we could generate, but it needs a
  trusted public TLS origin (not `localhost`, not a self-hosted-on-LAN cert), a bundle identifier read from
  inside the IPA (zip + plist parsing) and a profile check we cannot do, so a wrong click yields a failed
  install without a useful error. Document only.

**macOS**

- `.app` (zipped), `.dmg`, `.pkg`: a browser download gets the quarantine attribute, so Gatekeeper checks
  signature and notarization. Developer ID signed + notarized: opens normally. Signed, not notarized, or ad
  hoc signed: macOS 15 requires "System Settings, Privacy and Security, Open Anyway" (right-click Open no
  longer bypasses it) (UNVERIFIED for exact macOS versions). `xattr -dr com.apple.quarantine App.app` removes
  the flag for a build you trust. A Mac App Store build is installed through TestFlight for Mac.

## 3. What this build ships

- `GET /apps/:id/builds/artifacts`: CI artifacts of the runs linked to the app plus the store builds of the
  last sync (no store call): `builds.read`, member and above.
- `GET .../artifacts/:artifactId/download`: streamed through the server, GitHub token never leaves it.
  `builds.download`, member and above, explicit-only for API tokens, off unless
  `KILN_BUILDS_DOWNLOAD_ENABLED=true` (a build binary is the product's source of truth and often unreleased:
  the exfiltration surface the other switches also guard).
- `POST .../artifacts/:artifactId/link` and public `GET /api/builds/dl/:token`: a 10 minute, single use,
  HMAC signed link (47 character token; the claims live in memory) for a phone (QR). The link holds ids only, never a GitHub URL.
- The QR encoder (`apps/web/src/lib/qr.ts`, no library) was decoded back by the browser's `BarcodeDetector` for 2, 94, 98 and 218 byte
  texts (versions 1, 5, 5, 9). A scan with a real phone camera is not verified.
- Not built: ranged zip listing, creating or enabling TestFlight groups and links, Play opt-in URL, internal app sharing upload,
  itms-services manifest.

## TestFlight public links (read only)

Built against a fake connector and a fake fetch only; never run against live App Store Connect.

| Claim                                                                                                                                                                                                | Status                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/betaGroups` takes `filter[app]`, `filter[isInternalGroup]`, `include`, `fields[betaGroups]` and `limit` up to 200 (Apple's reference page "List beta groups", read through its JSON mirror) | read in the docs, not run                                                                                                                                                  |
| `fields[betaGroups]` allows `name`, `isInternalGroup`, `hasAccessToAllBuilds`, `publicLinkEnabled`, `publicLinkId`, `publicLinkLimitEnabled`, `publicLinkLimit`, `publicLink`                        | read in the docs, not run                                                                                                                                                  |
| `GET /v1/betaGroups/{id}/builds` lists the builds of a group (`fields[builds]=version`, `limit` up to 200)                                                                                           | read in the docs, not run                                                                                                                                                  |
| The value format of `filter[isInternalGroup]` (`false`)                                                                                                                                              | UNVERIFIED (the page gives no values). A parameter error falls back to `GET /v1/apps/{id}/betaGroups` and internal groups are dropped by their `isInternalGroup` attribute |
| `GET /v1/apps/{id}/betaGroups` accepts a `filter`                                                                                                                                                    | UNVERIFIED (the page lists only `fields` and `limit`); only used as the fallback, without it                                                                               |
| `GET /v1/builds/{id}/betaGroups`                                                                                                                                                                     | UNVERIFIED (its page could not be read); NOT used. Build membership comes from `GET /v1/betaGroups/{id}/builds` for each group that has a link (at most 20 groups)         |
| `publicLink` is returned while `publicLinkEnabled` is false                                                                                                                                          | UNVERIFIED. Both are passed on as they are; a group with a link or an enabled flag counts as "has a public link" and a disabled one is shown as off, without a QR code     |
| A group with `hasAccessToAllBuilds` holds every build of the app (its build list is not read)                                                                                                        | UNVERIFIED                                                                                                                                                                 |
| `publicLinkLimit` means anything while `publicLinkLimitEnabled` is false                                                                                                                             | UNVERIFIED; the limit is shown only when the flag is true                                                                                                                  |
| The lowest API key role that may read beta groups                                                                                                                                                    | UNVERIFIED; the message names App Manager, which is what the connector already asks for                                                                                    |
| Builds of other platforms in a group (iOS and macOS builds share a group) are told apart by build number only                                                                                        | a build number that exists on both platforms would match both; UNVERIFIED how often                                                                                        |

Decisions: nothing is ever created, enabled, disabled or edited (no POST, PATCH or DELETE exists in the connector), so an app
with no public group shows a plain "none" text that points to App Store Connect. A QR code is drawn from the link address
with the same encoder as the phone link (`apps/web/src/lib/qr.ts`); a camera scan is not verified.
