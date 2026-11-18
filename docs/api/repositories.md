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
| `repositories.read`: list, read listing, read change sets | yes | yes | yes |
| `repositories.scan`: scan a repository | no | yes | yes |
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
  `{ repository, detection }` (the `ProjectDetection` of `@mrm/connectors`: kind, platforms,
  locales, paths, evidence, warnings). Synchronous with a timeout. Audit `repository.scan`.
- `GET /repositories/:id/listing` reads the fastlane listing files (at the default branch) and
  returns `{ listing, found, roots, warnings, problems }`: the `Listing` model of `@mrm/core`,
  where the files were, and `validateListing` problems (`severity` `error` or `warning`).

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
  files that differ. `201 { changeSet,
  problems }` (`problems` are `validateListing` results for the new listing, not blocking).
  `422 no_changes` when nothing differs. Locale keys must look like `en-US` or `default`;
  changelog keys are a version code or `default`.
- `GET /change-sets?repositoryId=&status=` returns `{ changeSets }`, newest first.
  `GET /change-sets/:id` returns `{ changeSet }` with file contents.
- `POST /change-sets/:id/approve` (draft only) returns `{ changeSet }`.
- `POST /change-sets/:id/apply` (approved only) claims the change set atomically, then opens
  branch `mrm/<first 8 of id>-<slug>` and a pull request. `200 { changeSet }` with `branch`,
  `prUrl`, `prNumber`, `commitSha`. A second apply while the first runs returns `409
  apply_in_progress`; after it finished it returns `200` with `alreadyApplied: true` and no new
  pull request. A claim older than 10 minutes counts as abandoned and can be claimed again.
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
| timeout | 504 | `timeout` |

Audit actions: `repository.connect`, `repository.disconnect`, `repository.scan`,
`changeset.create`, `changeset.approve`, `changeset.apply`, `changeset.apply_failed`,
`changeset.discard`.

## Not done yet

Expo `store.config.json` is detected, not edited. Scan and listing run in the request; they may
move to the job queue. Stale change sets are not refreshed: after a conflict, create a new one.
