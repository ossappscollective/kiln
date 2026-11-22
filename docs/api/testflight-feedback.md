# TestFlight feedback and crash reports

Beta feedback (a comment, optionally with screenshots) and crash reports that testers send from TestFlight, read from App Store Connect into a
stored copy and triaged in Kiln. Decision: [ADR 0049](../adr/0049-testflight-feedback.md); sources: [spike](../spikes/testflight-feedback.md).
All routes are under `/api/workspaces/{workspaceId}/apps/{appId}/testflight`. **Nothing here writes to Apple.** Google Play apps answer
`422 testflight_not_supported`.

| Operation | Route | Needs |
| --- | --- | --- |
| `listTestflightFeedback` | `GET /testflight` | `reviews.read` |
| `getTestflightCrashGroups` | `GET /testflight/crash-groups` | `reviews.read` |
| `getTestflightItem` | `GET /testflight/{id}` | `reviews.read` |
| `getTestflightScreenshots` | `GET /testflight/{id}/screenshots` | `reviews.read` (rate limited, `Cache-Control: no-store`) |
| `syncTestflightFeedback` | `POST /testflight/sync` | `reviews.sync` (the per-workspace app-sync budget) |
| `triageTestflightItem` | `PATCH /testflight/{id}` | `reviews.triage` |

## Reading

`GET /testflight` query: `kind` (`feedback` or `crash`), `build` (build number), `version`, `status`, `tester` (the pseudonym), `signature`
(crash group), `limit` (up to 200), `cursor` (opaque, newest first). The answer is `{ app, api, counts, builds, items, nextCursor, sync }`:
`counts` has `feedback`, `crashes`, `openFeedback`, `openCrashes` and `byStatus`; `builds` is the list of versions and builds that have
feedback (for the filters); `sync` is the last read (`syncedAt`, `complete`, `warnings`, `lastError`, `failures`) or null.

An item has `id`, `kind`, `createdAt`, `comment` (feedback), `appVersion`, `buildNumber`, `platform`, `deviceModel`, `osVersion`, `locale`,
`timeZone`, `architecture`, `connectionType`, `batteryPercentage`, `diskBytesAvailable`, `diskBytesTotal`, `appUptimeMs`, `screenshots`
(width and height only, never a link), `tester` (`{ key }`, plus `email` for users with `settings.write`), `signature` and `symbolicated`
(crashes), and the triage fields `status`, `assigneeId`, `note`. `GET /testflight/{id}` adds the crash log (`log`, `truncated`; capped at
64 KiB). Screenshot links come only from `GET .../screenshots` (`[{ url, width, height, expiresAt }]`, fresh from Apple, never stored).

## Crash grouping

`GET /testflight/crash-groups` returns `{ groups: [{ signature, exceptionType, frame, count, firstSeen, lastSeen, builds, symbolicated }] }`.
The signature (`crashSignature` in `packages/connectors/src/testflight-crash.ts`) is the first `Exception Type:` value plus the top frame
(frame 0) of the thread marked `Thread N Crashed`, with the offset, the file and line and any hexadecimal address removed. A frame that is
only an address groups by image name and has `symbolicated: false`. When the layout is not recognised the signature is null and the crash is
listed alone. The text is read before it is capped to 64 KiB.

## Sync and triage

`POST /testflight/sync` reads the two lists (newest first, at most 2 pages and 400 items), reads the crash log of each new crash and upserts
the rows. It returns `{ app, feedback, crashes, added, crashLogs, complete, warnings, syncedAt }`. Nothing is deleted and triage is never
overwritten. A list Apple refuses (403 or 404) is a warning; both refused fails the sync (`sync.lastError`, `sync.failures`). Errors:
`422 testflight_not_supported`, `504 timeout`, `429 rate_limited`, `404 not_found`. The same read also runs after the review read of the
app (the review scheduler; no extra setting). Reviews' `KILN_REVIEW_RETENTION_DAYS` also prunes these rows.

`PATCH /testflight/{id}` takes any of `status` (`new`, `seen`, `in_progress`, `resolved`, `ignored`), `assigneeId` (a member or null) and
`note` (2,000 characters or null). `422 assignee_not_member` for an outsider. Audit: `testflight.synced` (counts only), `testflight.triage`
(ids and status, never the note).

## Alerts and events

Event types `testflight.feedback` and `testflight.crash` (read needs `reviews.read`); alert types of the same names, group `reviews`,
severity info and warning, inbox by default. The first sync of an app emits nothing; later, up to 10 events per kind per sync and then one
grouped event (`grouped`, `count`). The payload is `submissionId`, `buildNumber`, `version` and `platform` only: no comment, email or log.

## Unverified (check with a real account)

No response was seen from a real App Store Connect account. The fixtures (`packages/connectors/src/testflight-feedback.fixtures.ts`) follow
the names on Apple's reference pages and are not recordings.

1. Any real response body, and the paging links (`links.next`) of the two list endpoints; the connector follows them when present and stops
   at its page and item caps otherwise.
2. What an app that never used TestFlight answers (an empty list, a 403 or a 404). A 403 or 404 on a list is read as "refused" and warns.
3. Whether `filter[build]` takes a build id or a build number (the connector does not use it; it filters in Kiln), and the include of
   `build` with `fields[builds]=version,preReleaseVersion` giving linkage; without it each build is read from `/v1/builds/{id}/preReleaseVersion`.
4. The host and the lifetime of screenshot links (`expirationDate` is read when given); that is why they are never stored.
5. The layout of `logText` and whether it is symbolicated; the grouping rule is built on the usual crash report layout and degrades to
   "no group".
6. Webhook event names of App Store Connect for new feedback (Kiln polls and does not use them).
7. The address `https://appstoreconnect.apple.com/apps/{appId}/testflight` for "Open App Store Connect".
8. Retention: Apple's pages say one year for feedback and 120 days for downloading crash reports; neither was observed.
9. Everything about writes: they do not exist (see the ADR for the delete design).
