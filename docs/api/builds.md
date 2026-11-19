# API: builds to test

Everything is under `/api/workspaces/:workspaceId`, needs a session or an API token, and follows the usual error rules
([ci.md](ci.md)). Built and tested against fakes only (fixtures written from GitHub's "Artifacts" REST documentation); never
run against live GitHub. See [../research/test-builds.md](../research/test-builds.md) for what is verified and what is not.

| Route | Right | Notes |
| --- | --- | --- |
| `GET /apps/:id/builds/artifacts` | `builds.read` (member and above) | CI artifacts of the runs that count for the app, the store builds of the last sync, and (iOS and macOS) the TestFlight public links (a read-only App Store Connect call). Kept 30 s, ETag read, shared between callers; 60 a minute per workspace |
| `GET /apps/:id/builds/artifacts/:artifactId/download` | `builds.download` | Streams the zip through the server. `409 builds_download_disabled` unless `MRM_BUILDS_DOWNLOAD_ENABLED=true` |
| `POST /apps/:id/builds/artifacts/:artifactId/link` | `builds.download` | `{ path, expiresAt, filename }`: `/api/builds/dl/<token>` |
| `GET /api/builds/dl/:token` | none (the token) | Public, for a phone. Single use, 10 minutes |

`builds.read` and `builds.download` are member rights (a viewer sees releases, not binaries). `builds.download` is explicit-only
for API tokens: a token with no list of actions never holds it. A token limited to some apps may call all four for those apps only.

## The list

`artifacts[]`: `id, name, kind (ipa|apk|aab|app|dmg|pkg|zip|other), guessed, platform, sizeBytes, expired, createdAt, expiresAt,
downloadable, tooLarge, run{id, number, workflow, title, branch, shortSha, status, conclusion, url}`. **`kind` and `platform` are
guesses from the artifact name** (an artifact is always a zip; the content is not read). Only artifacts of stored runs that count for
the app (`appIds`, or no app) and of its platform are listed; the rest are counted in `hiddenArtifacts`. At most the 200 newest
artifacts of the repository are read (`truncated`) and runs are the 100 newest stored.
`store[]`: from `app_builds` and `app_releases`: `channel (testflight|play)`, `state`, `expired`, `uploadedAt`, `expiresAt`
(TestFlight: upload + 90 days, `expiresAtEstimated: true`), `tracks`, `optInUrl` (Play, closed or open tracks only).
`testflight` (iOS and macOS apps with synced builds; `null` otherwise): a READ of the app's external TestFlight groups that
have a public link: `groups[] {id, name, publicLink, enabled, limit}` (`limit` null = no limit), `withoutLink` (external groups
without a link, not listed), `readAt`, `cached`, and `problem {reason, needs}` with a fixed reason (`no_access` for a 401 or 403 from
Apple, with `needs` naming the App Manager role (UNVERIFIED as the least role), `rate_limited`, `unavailable`, `not_synced` for an
app without an App Store id), never Apple's text; the list still answers `200`. Each `store[]` item then carries
`testflightGroupIds` (the groups the build is in; `null` when not read, so nothing is claimed). One App Store Connect call for the
groups plus one per group that has a link (at most 20), all GET: `GET /v1/betaGroups?filter[app]&filter[isInternalGroup]=false` and
`GET /v1/betaGroups/{id}/builds` (the filter value and several details are UNVERIFIED, see
[../research/test-builds.md](../research/test-builds.md#testflight-public-links-read-only)). Cached 30 s (a failure 60 s) in the same
read cache; the credential use is audited as `credential.use` with purpose `builds.testflight`. This app never creates, enables or
changes a group or a link.
`problem` replaces a GitHub failure with a fixed reason (`no_access` with `needs: "actions: read"`, `rate_limited`, `unavailable`,
`unsupported`, `no_repository`) and a `200`; a refused repository is left alone for a minute. `downloadEnabled`, `maxDownloadBytes`,
`canDownload` tell a client whether to draw a download button.

## Download and link

- The GitHub token never leaves the server. The `302` of `GET /actions/artifacts/:id/zip` is followed here, without the token, over
  https to a public host only (no address literal, `localhost`, `.internal`, no dot), at most three hops.
- Limits: `MRM_BUILDS_DOWNLOAD_MAX_MB` (default 500; refused with `413` before any byte moves, and enforced while streaming), 20 a
  minute per workspace, 3 at a time (`429`), 10 minutes of transfer. `410 artifact_expired`, `404` for an artifact that is not one
  of this app's.
- Headers: `application/zip`, `Content-Disposition: attachment` with a sanitised `.zip` name, `no-store`, `nosniff`.
- Audit: `build.download` and `build.link_created`, ids and a size only (artifact, run, repository, via `session` or `link`).
  The GitHub credential use is audited as `credential.use` with purposes `builds.list` and `builds.download`.
- The link token is `<12 random bytes + expiry>.<HMAC-SHA256, 16 bytes>` (about 47 characters, so the QR code stays small). What it
  opens is kept in memory under that id: a restart forgets links. It is checked again on use (the person who made it must still be a
  member with `builds.download`), works once, and is released again if the artifact could not be opened.
- **Why downloads are off by default.** An unreleased build is the product. The same pattern as the store switches: a server
  switch the administrator turns on, a role, rate limits and an audit row.

## Not built

itms-services over-the-air install (needs a public trusted HTTPS origin, a manifest, the bundle id read out of the IPA), creating or enabling TestFlight groups and links (a store write: only read), and reading the zip's
central directory over a ranged request. All described in the research note.

## Share to a device (Android)

A gated store write, off by default: upload the `.aab` or `.apk` inside an artifact to Google Play internal app sharing and get an install link
([internal-sharing](internal-sharing.md), [ADR 0020](../adr/0020-play-internal-sharing.md)).
