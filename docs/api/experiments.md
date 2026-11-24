# Experiments and custom product pages

Product Page Optimization experiments and custom product pages of Apple apps, read from App Store Connect into a stored copy, and a manual
tracker for anything else (Google Play has no API for its store listing experiments and custom store listings). Decision:
[ADR 0048](../adr/0048-store-experiments.md); sources: [spike](../spikes/store-experiments.md). All routes are under
`/api/workspaces/{workspaceId}/apps/{appId}/experiments`. **Nothing here writes to a store.**

| Operation              | Route                                | Needs                                           |
| ---------------------- | ------------------------------------ | ----------------------------------------------- |
| `listAppExperiments`   | `GET /experiments`                   | `aso.read`                                      |
| `syncAppExperiments`   | `POST /experiments/sync`             | `apps.sync` (the per-workspace app-sync budget) |
| `createExperimentNote` | `POST /experiments/notes`            | `aso.write`                                     |
| `updateExperimentNote` | `PATCH /experiments/notes/{noteId}`  | `aso.write`                                     |
| `deleteExperimentNote` | `DELETE /experiments/notes/{noteId}` | `aso.write`                                     |

## Reading

`GET /experiments` reads the stored copy and asks no store. `api` is `false` for Google Play: `experiments` and `customPages` are then empty,
`sync` is `null` and only `notes` is used. For Apple: `experiments[]` (`name`, `platform`, `state`, `rawState`, `trafficProportion`,
`reviewRequired`, `startsAt`, `endsAt`, `treatments[]` with `locales[]` and media counts) and `customPages[]` (`name`, `state` of the version
that counts, `url` to share, `visible`, `deepLink`, `versions[]`, `locales[]` with `hasPromotionalText` and media counts). `state` is one of
`draft`, `in_review`, `approved`, `rejected`, `completed`, `stopped`, `replaced`, `unknown`; `rawState` is Apple's word. `approved` covers
Apple's `ACCEPTED` and `APPROVED`: whether a test is running is told by its dates. **Results (impressions, conversion, confidence) are not
available**: Apple's API has none; they are in App Store Connect, App Analytics.

`POST /experiments/sync` reads Apple (the experiments of the app and, for an iOS record, its custom product pages; a macOS record keeps the
`MAC_OS` experiments) and replaces the stored copy. A part Apple refuses (403: the key's role; 404: the app is not live) is a `warnings` entry
and that part is left as it was; if both parts are refused the call fails with `422 store_forbidden` or `store_not_found`. Any other failure
fails the whole sync and keeps the last good copy (`sync.lastError`, `sync.failures`). `422 experiments_not_supported` for Google Play,
`422 app_not_synced` before an App Store app has its store id, `504 timeout`, `429 rate_limited`. Audit: `experiments.synced` (counts only).

## Manual tracker

A note: `kind` (`experiment`, `custom_page`), `name` (1 to 120 characters, one line), `status` (`planned`, `running`, `finished`, `stopped`), `startedOn`
and `endedOn` (`YYYY-MM-DD` or null, the end not before the start: `422 invalid_dates`), `url` (http or https, 500 characters), `listing` (the Google
Play custom store listing parameter: lowercase letters, digits and `. - _ ~`), `note` (2,000 characters). At most 200 notes per app
(`409 too_many_notes`). Notes are Kiln's own data, never sent to a store. Audit: `experiments.note_created`, `experiments.note_updated`,
`experiments.note_deleted` (ids, kind and status; never the text).

## Unverified (check with a real account)

No response was seen from a real App Store Connect account. The fixtures (`packages/connectors/src/store-experiments.fixtures.ts`) follow the
names on Apple's reference pages and are not recordings.

1. The JSON:API `type` strings of the included resources, and that `include` on the two list endpoints returns the related resources together
   with `relationships.<name>.data` linkage. Without linkage the connector reads the treatments and the versions from their own endpoints.
2. Placements: `placementType` (`APP_SCREENSHOT`, `IMESSAGE_APP_SCREENSHOT`, `APP_PREVIEW`, others counted as `other`) is read from the
   `fields[appAssetLibraryPlacements]` and `filter[placementType]` lists; that there is one placement per screenshot is not stated. The deprecated
   screenshot sets are counted only when they come along (`screenshotSets`).
3. What `trafficProportion` is exactly (read as a percentage), `reviewRequired`, `controlVersions`, `latestControlVersion`, `promotedDate`; that
   `startDate` is set before a test runs; that an approved test inside its dates is the one Apple calls Running.
4. `filter[platform]` is not documented on the list endpoint: the connector filters on the `platform` attribute (`IOS`, `MAC_OS`; one without a
   platform is kept).
5. What an app that is not live answers (an empty list or an error); a 403 or a 404 on a list is read as "refused", which only warns.
6. The address `https://appstoreconnect.apple.com/apps/{appId}` for "Open App Store Connect" (the same base as the other Apple links in the app).
7. The page-level `state`: a custom product page has none; the state of the version that counts is used (work in progress first, then approved).
8. Custom product pages of a macOS record are not read (Apple's page says iPhone and iPad).
9. Everything about writes: they do not exist yet (see the ADR for the design).
