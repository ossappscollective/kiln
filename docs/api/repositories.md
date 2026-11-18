# API: repositories and change sets

Phase 1, GitHub only. Everything is under `/api/workspaces/:workspaceId`, needs a session, and
follows the usual rules: a non-member (or an unknown workspace, repository or change set) gets
`404 {"error":"not_found"}`, a member without the right gets `403 {"error":"forbidden"}`, a bad
body gets `400 {"error":"invalid_request","issues":[...]}`. Times are epoch milliseconds.

The only way anything is written to a repository is a **change set**: it is created as a draft,
approved by an admin or owner, then applied as a branch and pull request. Nothing is ever pushed
to the default branch. Every state change is an audit event (actor, ids, counts; never file
contents or secrets).

## Rights

| Action | viewer | member | admin / owner |
| --- | --- | --- | --- |
| `repositories.read`: list and read stored repositories and change sets | yes | yes | yes |
| `repositories.scan`: scan a repository, read its listing from GitHub | no | yes | yes |
| `changesets.write`: create a draft, discard your own draft | no | yes | yes |
| `repositories.write`: connect and disconnect repositories, add, change and delete listing targets | no | no | yes |
| `changesets.approve`: approve, apply, discard anyone's | no | no | yes |

Only admins and owners can approve, so a creator who is an admin or owner may approve their own
change set; a member never can. Approval and apply are recorded with the person who did them.

## Repositories

A repository is a GitHub `owner/repo` bound to a stored `github_app` or `github_token`
credential. Its shape:

```json
{ "id": "…", "credentialId": "…", "owner": "acme", "repo": "app", "defaultBranch": "main",
  "projectKind": "fastlane" | "expo" | "both" | "unknown" | null,
  "detectedAt": 1731900000000 | null, "createdAt": 1731900000000 }
```

- `GET /repositories` returns `{ repositories: [...] }`. `GET /repositories/:id` returns
  `{ repository, detection }` (`detection` is the last scan, or null).
- `POST /repositories` with `{ credentialId, owner, repo }` reads the repository with the stored
  credential and saves its default branch. `201 { repository }`. Errors: `422
  credential_not_found` (also for a credential of another workspace), `422
  credential_kind` (anything but `github_app` / `github_token`), `422 github_auth |
  github_forbidden | github_not_found` (GitHub refused; `message` says what to check), `409
  already_connected` (owner and repo compared without case), `429` rate limited, `502` GitHub
  unreachable, `504` timeout.
- `DELETE /repositories/:id` returns `204`. `409 open_change_sets` while a draft, approved or
  applying change set exists; finished ones are deleted with it.
- `POST /repositories/:id/scan` lists the files, runs project detection, stores it and returns
  `{ repository, detection, listingSources }` (the `ProjectDetection` of `@mrm/connectors`: kind,
  platforms, locales, paths, evidence, warnings; `listingSources` is described below).
  `detection.listing` (additive; absent from a scan stored by an older version) is
  `{ candidates, targets, hints }`: every folder that looks like a listing root, the candidates
  grouped per app (see "Listing targets"), and the `metadata_path` folders a Deliverfile or
  Fastfile names. Synchronous with a timeout. Audit `repository.scan`.
- `GET /repositories/:id/listing` reads the listing at the default branch and returns
  `{ listing, found, roots, warnings, problems, sources, targets, selected, candidates,
  diagnostics }`: the `Listing` model of `@mrm/core`, whether text was found per store, the
  fastlane folders that were read, repository-level warnings, `validateListing` problems
  (`severity` `error` or `warning`), where each store's listing came from (see "Listing
  sources"), and the target fields described under "Listing targets". Query (all optional):
  `target` (a saved target's id, or `auto:<key>` of a detected one), `appStoreRoot` and
  `googlePlayRoot` (folders; they win over the target; an empty value means that store is not
  read). It uses the stored GitHub credential and sends traffic to GitHub, so it needs
  `repositories.scan` (member and up), like a scan; a viewer gets `403`. Viewers still read stored
  data (`GET /repositories`, `GET /repositories/:id`, change sets, `GET .../listing-targets`).

### Listing sources

Where a store's listing lives is decided by one rule, the same for reading, scanning, creating
and applying:

- **App Store:** the Expo `store.config.json` (EAS Metadata) when project detection reports a
  JSON store config (the default file or one named by an `eas.json` submit profile; a script such
  as `store.config.js` is never read). Otherwise the fastlane metadata folder. The two are never
  merged: with a store config, the App Store files under `fastlane/metadata` are ignored (and
  said to be, in `warnings`), and a change set writes only the store config.
- **Google Play:** fastlane only. EAS Metadata has no Google Play support.

A repository with both therefore has its App Store listing in `store.config.json` and its Play
listing in fastlane. `GET .../listing` reports this per store in `sources`:

```json
{ "sources": {
    "appStore": { "source": "expo-store-config" | "fastlane", "path": "store.config.json",
                  "found": true, "error": "…", "warnings": ["…"],
                  "uncovered": ["apple.review"], "unknown": ["apple.futureFlag"] },
    "googlePlay": { "source": "fastlane", "path": "fastlane/metadata/android", "found": false,
                    "warnings": [], "uncovered": [], "unknown": [] } } }
```

- `path` is the store config file, or the fastlane folder the listing is read from.
- `found` is whether any listing text was found there. `found` at the top level is the same two
  booleans; `roots` stays the fastlane folders; top-level `warnings` are the fastlane warnings
  plus notes the rule adds (shadowed fastlane files, a skipped `store.config.js`).
- `warnings`, `uncovered` and `unknown` are the Expo connector's: JSON paths the listing model
  does not cover (`apple.review`, screenshots, ... read-only here and left untouched) and keys
  that are not in the EAS schema. They are empty for fastlane.
- `error` is set when the store config exists but cannot be read (not valid JSON, not an
  object, too large). The response is still `200`: `listing.appStore` is then absent and
  `found.appStore` false, Google Play is unaffected, and the App Store is **not** read from
  fastlane instead. Creating a change set that has an App Store listing is refused (below).

`listingSources` in the scan response, and in `GET /repositories/:id` when a scan is stored, is
the same decision judged from the scan alone, without reading files:
`{ appStore: { source, path } | null, googlePlay: { source, path } | null }` (`null`: no listing
found for that store).

Using the stored secret is itself audited (`credential.use`, purpose `repository.scan`, …).

### Listing targets

A repository can hold several apps (a monorepo with one metadata folder per app id), or keep its
listing in an unusual place. A **listing target** names where one app's listing lives: a label,
an optional app id, a folder for the App Store locale folders and a folder for the Google Play
locale folders (either may be missing). Two kinds:

- **Detected** targets come from the scan: `auto:<key>`, where the key is `app:<app id>` for
  `metadata/<app id>/ios` + `metadata/<app id>/android`, `default` for the folders of no app, and
  `root:<folder>` for an extra folder of a store. Nothing is stored for them.
- **Saved** targets are written by an admin or owner. They are rows of their own
  (`repository_listing_targets`: id, repository, name unique per repository, app id, the two
  folders), not a JSON list on the repository: a target has an id a request can name, the
  database decides when two people save the same name at once, and an edit or delete is one row
  with its own audit event. At most 20 per repository. They are deleted with the repository.

Folders that are detected by name (`<folder>` is any folder, usually `fastlane`):
`<folder>/metadata`, `<folder>/metadata/ios` and `/android`, `<folder>/metadata/<app id>/ios` and
`/android`, plus the folders a Deliverfile or Fastfile `metadata_path` names when they hold
listing files. **An explicit folder always wins**: a saved target's folders, or `appStoreRoot` /
`googlePlayRoot` in a request, are used as given, with no hint and no name rule, even if nothing
is in them (that is then said, see `diagnostics`, never replaced by a detected folder). A store
with no folder (null in a saved target, `''` in a request) is not read, and a change set leaves it
alone (with a warning). A saved target with an App Store folder also means the Expo
`store.config.json` is not used for that read (the person chose the folder; a note says so).

Without a choice the default is deterministic: a folder named by a hint, then the app named by an
`Appfile` `app_identifier` literal, then the shallowest folder, then by name; both stores follow
the same app. With several apps this is reported in `warnings` ("Several App Store metadata
folders were found ...") and in `selected.origin = "default"`.

The listing response fields:

```json
{ "targets": [
    { "id": "auto:app:com.acme.cards", "origin": "detected", "label": "com.acme.cards",
      "app": "com.acme.cards",
      "roots": { "appStore": "fastlane/metadata/com.acme.cards/ios",
                 "googlePlay": "fastlane/metadata/com.acme.cards/android" } },
    { "id": "…", "origin": "custom", "label": "Weather", "app": null,
      "roots": { "appStore": "store/apple", "googlePlay": null },
      "createdAt": 0, "updatedAt": 0 } ],
  "selected": { "id": "auto:app:com.acme.cards",
                "origin": "default" | "detected" | "custom" | "folders", "label": "…" },
  "candidates": [ { "store": "app_store", "root": "…", "app": "…", "platform": "ios",
                    "origin": "convention" | "hint", "locales": ["en-US"], "files": 10,
                    "label": "…" } ],
  "diagnostics": { "appStore": { "root": "…", "explicit": false,
                                 "state": "found" | "missing" | "no_listing_files" | "not_used",
                                 "entries": ["en-US/"], "message": "…", "searched": ["…"],
                                 "unused": [ { "path": "…", "store": "app_store" | "google_play" | null,
                                               "reason": "…" } ] },
                   "googlePlay": { "…": "…" } } }
```

`diagnostics` says, per store, what was checked (the folder that was chosen, or the places looked
at), what is directly inside it, and which folders look like metadata but were not used and why
(for example `fastlane/metadata` with no listing files in it, or a folder with locale folders
whose name is not one of the detected layouts: choose it as a folder to use it). A custom folder
with no listing files has `state` `missing` (not in the repository) or `no_listing_files` (it is,
with nothing usable; `entries` says what is there).

Endpoints (`/repositories/:id/listing-targets`), for the saved ones:

- `GET` returns `{ targets: [...] }` (`repositories.read`). The detected ones are in the scan and
  listing responses.
- `POST { name, appId?, appStoreRoot?, googlePlayRoot? }` creates one: `201 { target }`
  (`repositories.write`, audit `repository.listing_target_create`).
- `PATCH { name?, appId?, appStoreRoot?, googlePlayRoot? }` changes the fields that are sent
  (`repositories.write`, audit `repository.listing_target_update`). `DELETE` returns `204`
  (audit `repository.listing_target_delete`).
- Folders follow the repository path rules: relative, no leading slash, no empty, `.` or `..`
  segment, no `.git`, no backslash or control character, at most 300 characters (a leading `./`
  and a trailing slash are removed). At least one folder is needed. Refused with `422
  invalid_target` and `problems: [{ field, message }]` (`field`: `name`, `appId`, `appStoreRoot`,
  `googlePlayRoot`, `roots`), `409 duplicate_name` (names compared without case), `422
  too_many_targets`, `404 not_found` (repository or target of another repository or workspace).
- A request that names a target or folder: `404 target_not_found` (a deleted saved target, or a
  detected one that is not in the repository any more) and `422 invalid_root` (a bad folder).
- Using a target is reading the listing (`repositories.scan`, member and up) or making a change
  set (`changesets.write`).

## Change sets

```json
{ "id": "…", "repositoryId": "…", "summary": "Update German subtitle",
  "status": "draft" | "approved" | "applying" | "applied" | "discarded" | "failed",
  "createdBy": { "type": "user", "id": "…" },
  "branch": null, "prUrl": null, "prNumber": null, "commitSha": null, "error": null,
  "createdAt": 0, "updatedAt": 0, "approvedBy": null, "approvedAt": null, "appliedAt": null,
  "files": [{ "path": "…", "change": "added" | "modified" | "deleted",
              "before": "…", "after": "…" }] }
```

Lists return the same without `before`/`after` and with `filesChanged` instead of content in
`files` (paths and `change` only). The detail response carries both sides of every file; the
client renders the diff.

Lifecycle: `draft` → `approved` → `applying` → `applied` or `failed`; `draft`, `approved` and
`failed` can be `discarded`. `applied` always has a PR url or a commit sha.

- `POST /repositories/:id/change-sets` with `{ summary, listing, target?, roots? }`. `target` and
  `roots` (`{ appStore?, googlePlay? }`) pick the folders exactly as for `GET .../listing`: send
  the same ones the listing was read with. The change set only ever contains files inside the
  chosen target's folders (or the Expo store config when that is the App Store source); a file
  outside them is refused (`422 outside_target`). `listing` is the whole
  desired `Listing` for the store(s) to change (a store left out is untouched). Send the listing
  as `GET .../listing` returned it, with your edits: a locale or field that is missing from a
  store you send is a deletion. The server reads the current repository state and keeps only the
  files that differ, in the store's source (see "Listing sources"): an App Store edit is a
  one-file change to `store.config.json` that touches only the edited values (key order,
  indentation and unrelated keys such as `apple.review` stay as found), never a fastlane App
  Store file, and a Play edit is fastlane files. `201 { changeSet, problems, warnings }`
  (`problems` are `validateListing` results for the new listing, not blocking; `warnings` are
  what could not be written to the source, such as an App Store locale EAS Metadata does not
  support, which is left out). `422 no_changes` when nothing differs (with the same `warnings`).
  `422 store_config_invalid` (with `path`) when the listing has an App Store part and the store
  config cannot be read: fix the file in the repository first; nothing is written elsewhere. Locale keys must look like `en-US` or `default`;
  changelog keys are a version code or `default`. Counts are capped: at most 100 locales per
  store, 40 fields per locale, 50 version codes per changelog locale, and the whole request body
  at 1 MB (`413 payload_too_large`). A repository disconnected while the change set was being
  made gives `404 not_found`.
- `summary` is shown as typed, but what is sent to GitHub (commit message, pull request title and
  body) is neutralised: a zero-width space follows `@`, `#` and the `//` of a URL, and one splits
  the words close/fix/resolve (any form), so the summary cannot mention a user or team, link or
  close an issue, or reference another repository. In the pull request body it is a one-line
  quote.
- `GET /change-sets?repositoryId=&status=` returns `{ changeSets }`, newest first.
  `GET /change-sets/:id` returns `{ changeSet }` with file contents.
- `POST /change-sets/:id/approve` (draft only) returns `{ changeSet }`.
- `POST /change-sets/:id/apply` (approved only) claims the change set atomically, then opens
  branch `mrm/<first 8 of id>-<slug>` and a pull request. `200 { changeSet }` with `branch`,
  `prUrl`, `prNumber`, `commitSha`. A second apply while the first runs returns `409
  apply_in_progress`; after it finished it returns `200` with `alreadyApplied: true` and no new
  pull request. A claim older than 10 minutes counts as abandoned and can be claimed again.
  The request is cut off after 90 seconds (see below).
- `POST /change-sets/:id/discard` (draft, approved or failed) returns `{ changeSet }`. A member
  may discard only their own draft.

Wrong state: `409 { error: "invalid_state", status }`.

Apply failures set `status: "failed"` with `error` text, except a rate limit, which puts it back
to `approved` (nothing was written) so it can be retried:

| GitHub | HTTP | `error` |
| --- | --- | --- |
| files changed since the draft | 409 | `change_conflict` with `paths` and a hint to discard and re-read |
| rate limit | 429 | `rate_limited`, `retryAfterSeconds`, `Retry-After` header |
| branch exists, default branch, repo already matches | 409 | `branch_exists`, `default_branch`, `no_changes` |
| refused input, blocked path (`.github/`), not text | 422 | `github_invalid` |
| credential refused, no access, repository gone | 422 | `github_auth`, `github_forbidden`, `github_not_found`; credential deleted: `credential_not_found` |
| branch made, PR failed | 502 | `pull_request_failed`, `branch` and `commitSha` kept on the change set |
| GitHub down, network | 502 | `github_unavailable` |
| timeout | 504 | `timeout`; the change set stays `applying` (see below) |

**Timeout of apply.** After the timeout the server aborts the connector: no further request is
sent and the one in flight is cancelled (the pull request step is finished once a branch exists,
so a branch is not stranded without a PR). It cannot take back what GitHub already accepted, so
the branch `mrm/<id>-<slug>`, even its pull request, may exist. The change set is therefore
**not** marked `failed` (that would say nothing was applied and invite a retry that collides with
the branch). It stays `applying` with `error` saying what happened; it cannot be approved,
applied again or discarded meanwhile (`409 apply_in_progress` / `invalid_state`). The note and
audit `changeset.apply_timeout` tell the person to check GitHub. Ten minutes after the timeout the
claim counts as abandoned and apply may be called again; if the branch was created, that apply
fails with `409 branch_exists`, and the existing branch or pull request is the result. Scan and
listing also time out (`504`), but they only read, so nothing is left half done.

Audit actions: `repository.connect`, `repository.disconnect`, `repository.scan`,
`repository.listing_target_create`, `repository.listing_target_update`,
`repository.listing_target_delete`, `changeset.create`, `changeset.approve`, `changeset.apply`,
`changeset.apply_failed`, `changeset.apply_timeout`, `changeset.discard`.

## How a read stays fast

Opening the listing used to list the tree again, read the detection files again, and read one
file per Google Play release note (a long running app has hundreds, one request each). Now:

- The commit is resolved first (one small call), and the file list and the file texts are cached
  in memory by repository and commit sha for five minutes (a commit never changes, so the cache
  cannot be stale; at most 16 commits and 4 MB of text per commit). A scan, a listing and the
  change set made from it share them, and all read the same commit. A connector that cannot name
  a commit is read as before, without the cache.
- Only the files of the chosen target are read: the metadata text files, never screenshots,
  images or `review_information`. A file read for detection is not read again.
- Reads run 8 at a time, and the scan reads its fixed files together.
- Of the release notes of each locale only the 10 newest (by version code, plus `default`) are
  read, and the response says how many older ones were left alone. A change set never touches the
  files that were not read.
- When the request times out (90 seconds) no further request is sent to GitHub.

`DELETE /repositories/:id` racing with a change set being created for it answers `409
open_change_sets` (nothing is deleted), not a server error.

Apply writes exactly the files stored in the change set, so it follows the source chosen when the
draft was made; it does not look at the sources again. A store config that changed meanwhile is a
`change_conflict` like any other file.

## Not done yet

Only a static JSON `store.config.json` is edited; `store.config.js` is never read. Scan and listing run in the request; they may
move to the job queue. Stale change sets are not refreshed: after a conflict, create a new one.
