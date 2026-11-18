# Staged changes and store drafts (a store write, off by default)

Collect listing changes (texts per locale, icon, screenshots, Google Play graphics) for an app,
check them against the stores' rules, and write them to the store's **draft**. Nothing is submitted:
"push to store as draft" is a different action from submitting, sending for review or publishing. Submitting
is a separate, gated and irreversible step with its own switch and right: [submit](submit.md).
Design: [ADR 0009](../adr/0009-staged-store-drafts.md), [ADR 0010](../adr/0010-store-submit.md).

**Never run against a real store**: the connectors are tested with fakes only. See
[below](#unverified-check-with-a-real-account).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right
gets 403. For the push routes the kill switch is checked after the rights check.

| Right | Who | For |
| --- | --- | --- |
| `apps.read` | every role | `GET /store-draft/config` |
| `listing.read` | every role | `GET /apps/{id}/staged` |
| `changesets.write` | member and up | stage, unstage, clear |
| `store.push_draft` | **admin and up** | preview and **push** |

An API token holds `store.push_draft` only when its list of actions **names it** (explicit-only): a
token with no list never gets it, and its role must be admin or owner (`400 action_above_role`
otherwise). A token limited to some apps reaches those apps only (404 for others). A push by a token is
audited with `actor_type = token`. All routes are in the [OpenAPI description](openapi.md) (tag
`staged-changes`); the push is `x-mrm-risk: destructive`.

## Switching it on

`MRM_STORE_DRAFT_WRITE_ENABLED=true` (default `false`; only `true` and `false`; blank is off). See
[deployment](../deployment.md#writing-listing-drafts-to-a-store-a-store-write-off-by-default).

## Staging

An app (one platform) has one staged change set. Staging never contacts a store and never builds a
connector.

### `GET /store-draft/config`

`{ enabled, envName, submit: { implemented: true, configRoute: "/store-submit/config", note }, limits }`. A push never submits; `submit` only points to the separate step. `limits` is the server's caps
(`maxItems` 600, `maxTextChars` 20000, `maxAssetFilesPerPush` 100, `maxAssetBytesPerPush` 64 MiB,
`maxAssetFileBytes` 8 MiB).

### `GET /apps/{id}/staged`

`{ staged: StagedChangesView }`:

- `app` `{ id, name, platform, store }`, `valid` (no item has an error), `limits`,
  `pushable` `{ textFields, slots }` (what can be staged for this platform).
- `text[]`: `{ id, locale, field, label, source (repo|store|local), value, before, status
  (changed|unchanged|new_locale), limit, unit, length, problems[], pushed, pushedAt }`.
  `before` is the last read of the store (the stored snapshot, not a live read: the preview reads the
  live draft).
- `assets[]`: one per set `{ id (<locale>/<slotKey>), locale, slot, slotKey, label, files[] { path, oid,
  bytes, width, height, format }, problems[], pushed, pushedAt }`.
- A problem is `{ code, severity (error|warning), message }`. Codes include the listing and asset
  validation codes plus `slot_not_pushable`, `format_not_pushable`, `file_too_large`, `set_too_large`,
  `mixed_display_types`, `no_display_type` and `field_not_pushable`.

### `PUT /apps/{id}/staged/text`

Body `{ locale, field, from: "local" | "repo" | "store", value? }`. `value` is required for `local`;
`repo` reads the text from the connected repository, `store` from the last store read. The value is
normalized (line breaks, trailing white space). Staging the same field again replaces it.
Errors: `field_not_pushable` (422, with `allowed`), `invalid_locale`, `empty_text`, `text_too_long`,
`no_source_value` (the repository or the last store read has no value for it), `too_many_items`, `invalid_staged`. Returns `{ staged }`.

### `PUT /apps/{id}/staged/assets`

Body `{ locale, kind, device?, from?: "repo" (default), paths?, commit? }`. Without `paths` all files
of that slot in the asset index are staged in the index's order; with `paths` exactly these, in this
order (each a path of that set; no `..`). Errors: `slot_not_pushable` / `asset_not_pushable`, `no_assets`, `not_in_index`, `no_repository`, `no_commit`, `too_many_files`, `too_many_items`, `invalid_staged`. `from: "store"` and `"local"` answer `422 source_not_supported`
(see [reverse sync](#reverse-sync-store-to-repository)). Replaces the whole set of that slot. Returns `{ staged }`.

### `DELETE /apps/{id}/staged/items?id=`

`id` is a text row `id` or an asset set `id` (`en-US/screenshot:iphone_6_5`). Returns `{ staged }`.

### `DELETE /apps/{id}/staged`

Clears everything staged for the app. Returns `{ staged }`.

## Pushing a draft

### `POST /apps/{id}/staged/push/preview`

Reads the store's draft (not a write) and the staged files. Returns `{ preview }`:

- `app`, `version` (App Store: the editable version `{ id, versionString, state }`; Google Play: `null`),
  `submits: false`, `confirmHash`, `warnings[]`, `readAt`.
- `text[]`: `{ id, locale, field, before, after, localeExists, status }`.
- `assets[]`: `{ id, locale, slot, slotKey, target, before { setExists, files[] { id, name, checksum,
  state } }, after { files[] { path, name, oid, bytes, width, height, format } }, status, willUpload,
  willRemove }`. `target` is the store's own name of the set; `placementGroup` (App Store only) is the App Asset
  Library placement group the set is written to, found from Apple's reference data and the pixel size.
- `summary` `{ textChanged, textUnchanged, assetSetsChanged, assetSetsUnchanged, filesToUpload,
  filesToRemove, nothingToDo }`.

### `POST /apps/{id}/staged/push`

Body `{ confirmHash }` (64 lower-case hex characters; anything else is `400`). Returns `{ result }`:
`{ app, version, steps[] { type, locale, target, outcome (applied|already_same), uploaded?, removed? },
counts { applied, alreadySame, filesUploaded, filesRemoved }, commit (not_sent_for_review|none), draft: true,
submitted: false, confirmedByReread, pushedAt, note }`. What was written is marked `pushed` in the staged view.
Staged items stay staged (a second push skips what matches).

A successful push also **records what it wrote** (`store_draft_pushes`: for each text the locale, field and a hash
of the value; for each set the locale, slot, target, pixel size and the MD5 and SHA-256 of each file; the version
for the App Store). Later pushes of the same version merge into it; a refused or partial push records nothing.
The [submit](submit.md) step requires it and checks the store's draft against it.

| Status | `error` | Meaning |
| --- | --- | --- |
| 409 | `store_draft_disabled` | The kill switch is off. |
| 422 | `nothing_staged`, `staged_invalid` (`problems`) | Nothing to push, or an item has an error. |
| 422 | `asset_changed`, `asset_unreadable` | A staged file changed, vanished or cannot be read. Stage the set again. |
| 409 | `state_changed` (`preview`) | The staged items or the store's draft changed since the preview; nothing was written. |
| 409 | `write_in_progress` | Another push for this app is running. |
| 409 | `outcome_unknown` | The store did not answer and the draft could not be read back (or Google Play cannot show it yet). Preview again. |
| 409 | `draft_partial` (`items`) | After an unknown outcome the draft holds some of the changes. |
| 502 | `draft_partial` (`completed`, `failed`, `storeError`) | The App Store refused part way; what was written stays. |
| 502 | `write_failed` (`outcome: not_applied`) | App Store: the store did not answer and nothing was written. |
| 409 | `draft_not_allowed` | Google would not hold the changes back from review; nothing was committed. |
| 409 | `changes_in_review` | Changes are in review; this server never cancels one. |
| 422 | `no_editable_version` | The App Store has no version that can be edited. Create it in App Store Connect. |
| 422 | `store_auth`, `store_forbidden`, `store_not_found`, `store_rejected` | The store refused; the message is redacted. |
| 429 | `rate_limited` | `Retry-After` is set. Never retried here. |
| 502 | `store_unavailable` | Network or 5xx; nothing was changed. |
| 504 | `timeout` | A read did not answer in time. |
| 422 | `credential_*`, `app_not_synced` | The credential is of the wrong kind, cannot be read, or the app's App Store id is unknown. |

## What can be pushed

- **App Store** (the editable version's localization): `description`, `keywords`, `promotional_text`,
  `release_notes`, `marketing_url`, `support_url`; screenshots by display type. Not `name`, `subtitle`,
  `privacy_url` (app info, not the version), not previews, not the app icon, not `imessage:` devices.
- **Google Play** (an edit): `title`, `short_description`, `full_description`; images `icon`,
  `feature_graphic`, phone, 7-inch and 10-inch tablet, TV and Wear screenshots. Not the promo graphic.
- Files: PNG or JPEG, at most 8 MiB each, 100 files and 64 MiB per push.

## Audit and events

Audit: `staged.text_set`, `staged.assets_set`, `staged.item_removed`, `staged.cleared` (ids and blob ids),
`listing.draft_pushed`, `listing.draft_push_failed`, and `credential.use` with purpose `store.draft_push`.
Event: [`listing.draft_pushed`](events.md) (ids, counts, `commit`, `submitted: false`). Never a text,
a file, a credential or an upload address.

## Reverse sync (store to repository)

- **Texts:** `POST /apps/{id}/listing/pull` with `channel: "editable"` ([listing](listing.md)) pulls the
  store's texts into a change set against the repository.
- **Assets: not built.** Pulling store images into the repository as a change set needs the image
  download (App Store `imageAsset` templates, Google Play `url`) and a commit of binary files through
  the repository connector, which only writes text today. The gap is documented, not hidden: staging with
  `from: "store"` answers `source_not_supported`. Download the images from the store consoles and commit
  them to the repository; stage them from there.

## Submit and publish

A push never submits, sends for review or publishes. Handing the pushed draft to the store's review is a separate
step with its own switch (`MRM_STORE_SUBMIT_ENABLED`), right (`store.submit`), preview, hash and typed
confirmation: see [submit](submit.md). Publishing a release is not done by this server at all.

## UNVERIFIED (check with a real account)

Read on Apple's and Google's pages on 2026-11-18: the **App Asset Library** screenshot flow of App Store Connect
(the library id, the reference data, reserve an image, PUT parts to the unauthenticated upload URLs, PATCH
`uploaded: true`, poll until processed or `FAILED`, placements, ordering requests; Apple deprecated the set based
`appScreenshotSets` / `appScreenshots` in API 4.5.1 and this server no longer uses them), the names of the
resources and of Play's `edits.listings`, `edits.images` and `edits.commit` with `changesNotSentForReview`.
Not verified (nothing was run):

- App Store: the request bodies of the PATCH and POST of version localizations, the `screenshotDisplayType` names
  that `target` shows (the placement group is found from the reference data, not from these names), the states in
  which a version can be edited, which key role is needed, and the **checksum**: the library has none, so this server
  writes the SHA-256 (first 32 hex characters) into the image's `referenceName` (`mrm:sha256:<hex>`) to tell "the same
  file"; whether Apple accepts that text, the `filter[referenceName]` semantics and the `limit` / `fields` parameters
  of the placements list, and the `deviceFamily` strings of the display classes. Images of the library are never
  deleted except one that failed processing here: replacing a set deletes its placements only.
- Google Play: whether `edits.listings.update` replaces the listing (the connector sends every member it
  read), `uploadType=media`, accepted image types and sizes, whether upload order is display order,
  whether `changesNotSentForReview` is allowed for every app (e.g. managed publishing off), and
  whether a committed but unsent draft shows in a later edit (so an unknown outcome on Google Play cannot be
  confirmed by a re-read).
