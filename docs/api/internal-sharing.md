# Google Play internal app sharing (share a build to a device)

Upload the `.aab` or `.apk` inside a CI artifact to **Google Play internal app sharing** and get an install link for a device. It
is a **store write** (a binary leaves this server for Google under your developer account) that **publishes nothing to users**,
but it cannot be taken back from here: Google's API has no delete or list call for it. So it is gated like the other store writes.
Design and reasons: [ADR 0020](../adr/0020-play-internal-sharing.md). Where builds come from: [builds](builds.md).

Switched **off by default**: `MRM_PLAY_INTERNAL_SHARING_ENABLED=true` turns it on. Android apps only (`422 not_android`).

## The gates

| Gate             | What                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server switch    | `MRM_PLAY_INTERNAL_SHARING_ENABLED` (default `false`). Off: every route but the config answers `409 internal_sharing_disabled`, no GitHub or Google call is made. It does **not** need `MRM_BUILDS_DOWNLOAD_ENABLED`; it uses the same size limit `MRM_BUILDS_DOWNLOAD_MAX_MB`. |
| Role             | `builds.share`: **owner and admin**. A member can download builds and cannot share them. **Explicit-only for API tokens**: a token that does not name `builds.share` in its actions never gets it.                                                                              |
| Preview and hash | The apply needs the `confirmHash` of a preview of the same artifact (`409 state_changed`, with a new `preview`, when the artifact changed).                                                                                                                                     |
| Typed phrase     | `SHARE <package>` exactly (`422 confirmation_mismatch`).                                                                                                                                                                                                                        |
| Step-up          | Class `internal_sharing` ([step-up](step-up.md)): with the workspace policy on, the apply needs a fresh passkey, password or recovery code (`X-Step-Up-Grant`, target = the app id and the `confirmHash`). A token gets `403 step_up_required_human`.                           |
| One in flight    | One upload per app at a time (`409 write_in_progress`).                                                                                                                                                                                                                         |

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404.

## Routes

- `GET /builds/internal-sharing/config` (`builds.read`): `{ enabled, envName, action, minimumRole, stepUpClass, linkRetentionHours, maxBytes, canShare, note }`.
- `POST /apps/{id}/builds/artifacts/{artifactId}/internal-share/preview` (`builds.share`) body `{ entry? }`: reads the artifact **list** of the
  repository (cached 30 s) and shows what would be uploaded. **Nothing is downloaded and Google is not contacted.** Answer:
  `{ preview: { app, artifact, upload, effects, linkRetentionHours, checks, confirmHash, confirmation, readAt } }`.
  - `artifact`: `{ id, name, kind, sizeBytes, zipSha256, runId, headSha, createdAt, expiresAt }` (`zipSha256` is GitHub's digest of the zip when it gave one).
  - `upload`: `{ packageName, kind: "bundle" | "apk" | null, fileName, entry, versionCode: null, sha256: null, maxSizeBytes }`. `fileName` and `kind` are
    known only when the artifact name or `entry` says; **`versionCode` and `sha256` of the file are not known before the upload** (the zip is read
    only when you confirm; the apply answer carries the file's `sha256`).
  - `checks.blocking` (`share_in_progress`, `not_an_android_build`) stop the share: `confirmHash` and `confirmation` are null. `checks.warnings`:
    `previous_upload_unknown`, `not_obviously_a_build`. A preview **clears** an earlier unknown outcome.
  - `entry` names the `.aab` or `.apk` inside a zip that holds several (`422 invalid_entry` for a path that is not one). It is part of the `confirmHash`.
- `POST /apps/{id}/builds/artifacts/{artifactId}/internal-share` (`builds.share`) body `{ confirmHash, confirmation, entry? }`: the upload. Answer
  `{ result: { share, downloadUrl, checksumMatches, note } }`. `downloadUrl` is a **secret** (below). `checksumMatches` compares Google's SHA-256 with the
  one computed here (`null`: Google did not give one).
- `GET /apps/{id}/builds/internal-shares` (`builds.share`): the shares of the app, newest first, `{ enabled, inFlight, unknownOutcome, shares[] }`. **No link in the
  list**: `hasLink` says whether this server still holds it. Database only.
- `GET /apps/{id}/builds/internal-shares/{shareId}/link` (`builds.share`): `{ downloadUrl, expiresAt }`; `410 link_expired` after 24 hours. `Cache-Control: no-store`.
  Audited as `build.share_link_read` (ids).

## What the apply does

1. Checks the switch, then step-up, then the phrase, the artifact (a re-read of the list; `404`, `410 artifact_expired`, `413 artifact_too_large`, `409 state_changed`)
   and the checks (`409 blocked`), all **before** anything is downloaded.
2. Takes the claim, reads the Google credential of the app (audited as `credential.use`, purpose `builds.share`), and downloads the zip through the same guards as
   a build download (size limit, time limit, rate limit; audited as `build.download` with `via: share`). **The zip is held in memory** (up to the limit,
   500 MB by default; the file inside it is a second copy), so size the limit for your server.
3. Chooses the file: the only `.aab` or `.apk` in the zip (`__MACOSX` junk is ignored), or the one named by `entry`. `422 entry_required` (with the names, at most 20)
   when there are several, `422 entry_not_found`, `422 no_android_build`, `422 bad_zip`, `413 artifact_too_large` for a file bigger than the limit.
4. Uploads **once** to Google (`kind` `bundle` or `apk`). Never retried.
5. Keeps a record with the **link encrypted** and answers.

### Errors from Google

Nothing was stored for these, the claim is released, and each is audited as `build.share_failed` with a code and `outcome: failed` (never Google's text):
`422 store_auth` (key rejected), `422 store_forbidden` (no access, or the Android Publisher API is off in the Cloud project), `422 store_not_found`
(Google does not know the package), `422 artifact_rejected` (400: not a valid, signed bundle or APK, or not for this package), `413 artifact_too_large` (413),
`429 rate_limited` (with `Retry-After`), `502 upload_failed`.

### Unknown outcome

A lost answer, a cut connection, a timeout, a Google 5xx, or a 2xx with no usable link is **`409 outcome_unknown`**. **Google has no call to read an uploaded
artifact back**, so this cannot be settled by reading; it is reported, never retried. The app is blocked from another apply until someone previews again (the preview
warns `previous_upload_unknown` and clears it). Sharing again only makes a second link. Audited as `build.share_failed` with `outcome: unknown` and the SHA-256 of the file.

## The link is a secret

- Stored **encrypted** (AES-256-GCM with the master key, bound to its row), set to null **24 hours** after the upload, and the record is deleted after 30 days.
- Returned only by the apply answer and by `.../link`, both for `builds.share`, both `no-store`.
- **Never logged, never in an audit row, never in an event, never in a list.** Audit rows hold ids, a kind, a size and hashes (the file name is on the record, not in the audit).
- Whoever holds the link and is allowed by Google for this account can install the build. Google says access can be limited to email lists in Play Console or open to
  anyone with the link, and that "a maximum of 100 users will be able to download your app using the link".

## Audit and events

Audit: `build.shared` (`appId`, `artifactId`, `shareId`, `kind`, `sizeBytes`, `fileSha256`, `hash`), `build.share_failed` (`code`, `outcome`, ...), `build.share_link_read`
(`appId`, `shareId`), plus `credential.use` and `build.download`. **No event is sent** (there is nothing to alert on that the audit does not hold).

## In the app

Test builds shows **Share to device** on an Android artifact when the server switch is on and you are an owner or admin: a preview, the typed phrase, the step-up
dialog when the policy asks, then the link with **Copy** and a **QR code** (drawn in the browser) for the device.

## Unverified

Read on 2026-11-19 from Google's pages, **not run against Google**:

- **Verified (page text):** `POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/internalappsharing/{packageName}/artifacts/bundle` (and
  `.../apk`), scope `https://www.googleapis.com/auth/androidpublisher`; the resource `InternalAppSharingArtifact` has `downloadUrl`, `certificateFingerprint` and `sha256`;
  Google recommends a 2 minute timeout for the call. The help page says "Download links expire 60 days after the upload date".
- **Unverified:** that `?uploadType=media` with `Content-Type: application/octet-stream` is what Google accepts (the reference page does not name the parameter; it is the
  standard simple media upload); the exact shape of `downloadUrl`; whether Google checks the package name inside the file against the path; the largest file Google
  accepts (no figure found; the limit here is `MRM_BUILDS_DOWNLOAD_MAX_MB`); whether the app must already exist in Play Console; Google's real error bodies for 400/403/404 (this server
  maps the HTTP status, not the wording); whether the 60 day expiry holds for API uploads; that the link works for the testers you expect (they must turn on internal app
  sharing in the Play Store app and be allowed in Play Console).
- The version code of the build is **not shown** (it would need the binary manifest of the file to be read).
- No real Google account, device or artifact was used; every test runs against fakes.
