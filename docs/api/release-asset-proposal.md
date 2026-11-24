# Release asset proposal (store assets changed in the repository)

While a release is prepared, the texts and graphics that changed in the linked repository since the previous release, and still differ from the store and from the pending changes, are proposed for staging, after the existing listing checks and graphics rules were run on them. See [ADR 0063](../adr/0063-release-asset-proposal.md). Nothing is written to a store: staging adds to the [pending changes](staged-changes.md).

All routes are under `/api/workspaces/{workspaceId}/apps/{id}/release/asset-proposal`. A release is named by `version` (App Store: the editable version string), `track` (Google Play) and optionally `build` (the build number whose commit is the release source). Each is a plain label of at most 40 characters (`400 invalid_request` otherwise).

| Route | Right | Does |
| --- | --- | --- |
| `GET .../asset-proposal?version=&track=&build=` | `listing.read` | Reads the repository at two commits and the stored store state. Changes nothing. |
| `POST .../asset-proposal/stage` `{ version?, track?, build?, itemIds[], acceptIssues? }` | `changesets.write` | Computes the proposal again and stages the named items. |
| `POST .../asset-proposal/dismiss` `{ version?, track?, mode: skip \| later \| reopen }` | `changesets.write` | Saves the decision for this release (audit `release.asset_proposal_decided`). |

Another workspace's app, or a non-member, answers `404`; a viewer can read and not stage (`403`).

## `GET`: `{ proposal }`

- `unavailable`: `null`, or why nothing is offered: `no_repository` (the repository is not read at all), `no_repo_metadata` (it holds no store listing for the app), `target_unreadable`. No `compareRepo` / `compareMedia` setting is needed.
- `baseRef`, `targetRef`: `{ sha, source }`. `source`: `build`, `previous_build`, `repo_snapshot`, `default_branch`. `noPreviousRelease`: no base (or it cannot be read): every difference from the store is a candidate.
- `changes[]`: `{ id, kind: "text", locale, field, before, after, hasErrors }` (`before` the store's text, `after` the repository's) or `{ id, kind: "graphics", locale, slot, slotKind, device, deviceLabel, before (images in the store, null when unread), after { count, commit, files[] }, hasErrors }`. Ids are `text:<locale>:<field>` and `graphics:<locale>:<slot>`.
- `issues[]`: errors first, then warnings, then tips: `{ id, itemId, source (listing_check | listing_rule | graphics_rule), severity (error | warning | tip), code, locale, field, params, message }`. `message` is the documented rule in English for `listing_rule` and `graphics_rule`; the listing checks carry `code` and `params` (the web app has the sentences).
- `alreadyStaged[]`: `{ id, kind, locale, field, state: same | edited }`: in the cart already; `edited` was changed by a person and is never overwritten.
- `locked`: `{ locked, reason, liveVersion }`, the Apple metadata lock; changes are listed and cannot be staged until a new version exists. Google Play never locks.
- `state`: `{ state: open | skipped | later, at }`, what was decided for this release. `storeUnread`: the store's graphics could not be read.
- `summary`: `{ texts, locales, graphics, errors, warnings, tips }`. `skipped`: `{ unchangedSinceRelease, sameAsStore, notStageable }`. `notes`: `truncated` (at most 400 items), `base_unreadable`, `base_media_unreadable`, `graphics_unreadable`.

## `POST .../stage`

`{ results: [{ id, status, code? }], proposal }`. `status`: `staged`, `already_staged`, `kept_edited`, `not_proposed` (an id that is not in the proposal: nothing is staged), `failed` (the staging rule's error code). An item with errors needs `acceptIssues: true`, else `409 has_issues` with `itemIds`. Apple with no editable version: `409 metadata_locked`. `422 no_proposal` when `unavailable`. Audit `release.asset_proposal_staged` (item ids and commits, never a text).

Texts are staged as typed (`local`) text with the repository's value, graphics as the repository's set at the target commit (`PUT .../staged/assets` with `commit`).

Reads of the repository are audited like every repository read (`credential.use`, purposes `repository.listing`, `repository.assets`) and limited like the Assets tab.
