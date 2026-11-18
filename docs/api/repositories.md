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
| `repositories.write`: connect and disconnect repositories | no | no | yes |
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
  Synchronous with a timeout. Audit `repository.scan`.
- `GET /repositories/:id/listing` reads the listing at the default branch and returns
  `{ listing, found, roots, warnings, problems, sources }`: the `Listing` model of `@mrm/core`,
  whether text was found per store, the fastlane folders, repository-level warnings,
  `validateListing` problems (`severity` `error` or `warning`) and where each store's listing
  came from (see "Listing sources"). It uses the stored GitHub credential and sends traffic to
  GitHub, so it needs `repositories.scan` (member and up), like a scan; a viewer gets `403`.
  Viewers still read stored data (`GET /repositories`, `GET /repositories/:id`, change sets).

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

- `POST /repositories/:id/change-sets` with `{ summary, listing }`, where `listing` is the whole
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
`changeset.create`, `changeset.approve`, `changeset.apply`, `changeset.apply_failed`,
`changeset.apply_timeout`, `changeset.discard`.

`DELETE /repositories/:id` racing with a change set being created for it answers `409
open_change_sets` (nothing is deleted), not a server error.

Apply writes exactly the files stored in the change set, so it follows the source chosen when the
draft was made; it does not look at the sources again. A store config that changed meanwhile is a
`change_conflict` like any other file.

## Not done yet

Only a static JSON `store.config.json` is edited; `store.config.js` is never read. Scan and listing run in the request; they may
move to the job queue. Stale change sets are not refreshed: after a conflict, create a new one.
