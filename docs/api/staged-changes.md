# Staged changes and store drafts (a store write, off by default)

Collect listing changes (texts per locale, icon, screenshots, Google Play graphics) for an app,
check them against the stores' rules, and write them to the store's **draft**. Nothing is submitted:
"push to store as draft" is a different action from submitting, sending for review or publishing. Submitting
is a separate, gated and irreversible step with its own switch and right: [submit](submit.md).
Design: [ADR 0009](../adr/0009-staged-store-drafts.md), [ADR 0010](../adr/0010-store-submit.md).

**Release fields** (build, version, release type, date, copyright, phased release; a Google Play draft release) are a third kind of staged item
(`release[]` in the view, `PUT .../staged/release-fields`) written by the same push, with `release[]` and `checks` in the preview: see
[releases-write](releases-write.md) and [ADR 0014](../adr/0014-release-management.md). Releasing is yet another gated step.

Creating the next App Store version, when there is no editable one to push into, is a reversible draft write behind the same switch and right: [store-version](store-version.md), [ADR 0031](../adr/0031-create-app-store-version.md).

**Never run against a real store**: the connectors are tested with fakes only. See
[below](#unverified-check-with-a-real-account).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right
gets 403. For the push routes the kill switch is checked after the rights check.

| Right              | Who              | For                       |
| ------------------ | ---------------- | ------------------------- |
| `apps.read`        | every role       | `GET /store-draft/config` |
| `listing.read`     | every role       | `GET /apps/{id}/staged`   |
| `changesets.write` | member and up    | stage, unstage, clear     |
| `store.push_draft` | **admin and up** | preview and **push**      |

An API token holds `store.push_draft` only when its list of actions **names it** (explicit-only): a
token with no list never gets it, and its role must be admin or owner (`400 action_above_role`
otherwise). A token limited to some apps reaches those apps only (404 for others). A push by a token is
audited with `actor_type = token`. All routes are in the [OpenAPI description](openapi.md) (tag
`staged-changes`); the push is `x-kiln-risk: destructive`.

## Switching it on

`KILN_STORE_DRAFT_WRITE_ENABLED=true` (default `false`; only `true` and `false`; blank is off). See
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

### Locked versions (`409 metadata_locked`)

One server rule, `metadataLock(app)` (`apps/server/src/modules/publish/metadata-lock.ts`, pure part `computeMetadataLock` in `@kiln/core`),
from STORED state (`app_releases` as of the last sync): an Apple app (iOS, macOS) is locked when one of its versions is live, rolling out,
halted, in review or approved and none is editable (draft, build chosen, ready, rejected). Result `{ locked, reason, liveVersion }`; `reason`
is that version's state. An app that was never synced, or whose versions have no known state, is open. Google Play never locks: a listing
edit there is a draft that is always editable (there is no live version whose metadata freezes), so Play passes whatever its releases say.
Locked: `PUT .../staged/text`, `PUT .../staged/assets`, the upload, move, remove and fix routes of a set, and
`POST .../listing/fixes/stage` answer `409 { error: "metadata_locked", code: "staged.metadataLocked", params: { version } }` (tell the person to
prepare a new version first). Unstaging and clearing still work. `POST .../staged/push/preview` and `POST .../staged/push` re-check and answer the same, and
the cart (`GET /apps/{id}/pending/cart`) gives every staged item the reason `metadata_locked` (publish skips them with that reason). The web
`lockedPlatforms` (per selected version) uses the same list of locking states from core, and a test checks that both agree.

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
counts { applied, alreadySame, filesUploaded, filesRemoved }, commit (not_sent_for_review|draft_release|none), draft: true,
submitted: false, confirmedByReread, pushedAt, note }`. What was written is marked `pushed` in the staged view.
Staged items stay staged (a second push skips what matches).

A successful push also **records what it wrote** (`store_draft_pushes`: for each text the locale, field and a hash
of the value; for each set the locale, slot, target, pixel size and the MD5 and SHA-256 of each file; the version
for the App Store). Later pushes of the same version merge into it; a refused or partial push records nothing.
The [submit](submit.md) step requires it and checks the store's draft against it.

| Status | `error`                                                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 409    | `store_draft_disabled`                                               | The kill switch is off.                                                                                                                                                                                                                                                                                                                                                                                     |
| 422    | `nothing_staged`, `staged_invalid` (`problems`)                      | Nothing to push, or an item has an error.                                                                                                                                                                                                                                                                                                                                                                   |
| 422    | `asset_changed`, `asset_unreadable`                                  | A staged file changed, vanished or cannot be read. Stage the set again.                                                                                                                                                                                                                                                                                                                                     |
| 409    | `state_changed` (`preview`)                                          | The staged items or the store's draft changed since the preview; nothing was written.                                                                                                                                                                                                                                                                                                                       |
| 409    | `write_in_progress`                                                  | Another push for this app is running.                                                                                                                                                                                                                                                                                                                                                                       |
| 409    | `outcome_unknown`                                                    | The store did not answer and the draft could not be read back (or Google Play cannot show it yet). Preview again.                                                                                                                                                                                                                                                                                           |
| 409    | `draft_partial` (`items`)                                            | After an unknown outcome the draft holds some of the changes.                                                                                                                                                                                                                                                                                                                                               |
| 409    | `applied_with_differences` (`completed`, `differences`) | App Store: every request was accepted but the set read back from the store is not the pushed one (for example a removed screenshot is still listed). The sets that differ stay staged, nothing is submitted; `differences` has per set `removed`, `uploaded`, `kept`, `stillPresent` (id, file name), `missing`, `order`. |
| 502    | `draft_partial` (`completed`, `failed`, `storeError`)                | The App Store refused part way; what was written stays.                                                                                                                                                                                                                                                                                                                                                     |
| 502    | `write_failed` (`outcome: not_applied`)                              | App Store: the store did not answer and nothing was written.                                                                                                                                                                                                                                                                                                                                                |
| 409    | `draft_not_allowed`                                                  | Google would not hold the changes back from review (it sends this app's changes for review by itself); nothing was committed. (A push of only the draft release of a track is committed without the hold-back instead, `commit: draft_release`.) To send them for review anyway, the batch publish has the explicit step `push_and_submit` ([pending](pending.md#push-and-submit-in-one-step-google-play)). |
| 409    | `changes_in_review`                                                  | Changes are in review; this server never cancels one.                                                                                                                                                                                                                                                                                                                                                       |
| 422    | `no_editable_version`                                                | The App Store has no version that can be edited. Create it in App Store Connect.                                                                                                                                                                                                                                                                                                                            |
| 422    | `store_auth`, `store_forbidden`, `store_not_found`, `store_rejected` | The store refused; the message is redacted.                                                                                                                                                                                                                                                                                                                                                                 |
| 429    | `rate_limited`                                                       | `Retry-After` is set. Never retried here.                                                                                                                                                                                                                                                                                                                                                                   |
| 502    | `store_unavailable`                                                  | Network or 5xx; nothing was changed.                                                                                                                                                                                                                                                                                                                                                                        |
| 504    | `timeout`                                                            | A read did not answer in time.                                                                                                                                                                                                                                                                                                                                                                              |
| 422    | `credential_*`, `app_not_synced`                                     | The credential is of the wrong kind, cannot be read, or the app's App Store id is unknown.                                                                                                                                                                                                                                                                                                                  |

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
- **Assets:** `POST /apps/{id}/assets/pull` downloads the store's images into a draft change set (see
  [assets](assets.md#two-way-sync)). Staging with `from: "store"` still answers `source_not_supported`: a store
  image is not staged directly, it is pulled into the repository and staged from there, or the file is uploaded.

## Uploading, replacing, removing and fixing

Files of a set can be added, replaced, removed and fixed in the browser; each of these **stages** the whole set (our
own database, no store is called):

- `PUT /apps/{id}/staged/assets/upload?locale=&kind=&device=&mode=add|replace&position=&name=&fix=&background=` with
  the raw bytes as the body (at most 8 MiB, PNG or JPEG by magic bytes). A set that is not staged yet starts from the
  repository's files, so a replace or a remove keeps the others as they are. A file with a spec error answers
  `422 spec_errors` (`problems[]`, `fix`) and is not staged.
- `DELETE /apps/{id}/staged/assets/file?locale=&kind=&device=&position=`: removes one file by its 1-based place (the older route;
  prefer the batch route below, which names files by what identifies them). Removing the LAST file is allowed: the set is
  staged **empty** (see "Emptying a set"). The store keeps the image until the set is pushed, and a push replaces the store's
  whole set.
- `POST /apps/{id}/staged/assets/remove` `{ locale, kind, device?, base?, files: [{ ref?, oid?, position? }] }` (1 to 100 files):
  takes several files out of ONE set in ONE change and answers for each of them. A file is named by `ref` (an image the
  store holds, as `GET /assets/store` lists it), by `oid` (the git blob id of a staged or repository file) or, last, by
  `position` (1-based, in the set as it is now); `ref` wins over `oid`, `oid` over `position`. The set is the one a push would now
  write: the staged rows; else, with `base: "store"`, the images the store holds; else the repository's files. A set whose files
  were all pushed counts as not staged with `base: "store"` (the store may hold other images than the push wrote: the Graphics tab
  shows the store's). The answer (`200`) is
  `{ results: [{ index, id, outcome, reason?, position? }], summary: { removed, alreadyRemoved, notFound }, emptied, remaining, staged }`:
  `outcome` is `removed`, `already_removed` (taken out by an earlier entry of the same request: `duplicate_in_request`; or the
  staged set no longer keeps a file the store still lists: `not_in_staged_set`) or `not_found` with a `reason`
  (`unknown_file`, `stale_store_ref` (read the store again), `position_out_of_range`, `no_identifier`). A file that is not found
  never fails the others; everything removed is staged as one change (one audit entry `staged.asset_removed` with `count`,
  `positions`, `removedOids`), and nothing is staged when nothing was removed. A request that is wrong as a whole is refused
  (`400 invalid_request`, `403`, `409` metadata locked, a store that cannot be read).
- `base=store` (query of the upload and the remove, `base` in the body of the move): a set that is not staged yet starts from the
  images the store holds, not from the repository: each is downloaded once from the store's CDN (the original size, checked
  against Google's SHA-256 where there is one) and kept as a staged upload, so the push, which replaces the store's set, keeps the
  images that were not touched. The Graphics tab edits the store's side this way.
- `POST /apps/{id}/staged/assets/move` `{ locale, kind, device?, from, to, base? }`: moves one file of the set (reorder; audit
  `staged.asset_moved`). A push writes the order (App Store Connect: an ordering request; Google Play: the upload order, UNVERIFIED).
- `POST /apps/{id}/staged/assets/fix` `{ locale, kind, device, position, fix, background? }`: stages a corrected copy.
- `POST /apps/{id}/staged/assets/to-repo` `{ sets? }`: a draft change set that makes the repository's sets exactly the
  staged ones (files the staged set no longer holds are deleted; files that are already right are not touched).
- In the staged view a file has `upload: true` when this server keeps its bytes; the set's `source` is `local` when any
  file is.

**Emptying a set.** Taking out every file of a set stages the set *empty*: the staged view shows it with `files: []` and
`cleared: true` (one marker row of source `cleared` keeps the size of an image the set held, so a push finds the store's
display type). A push then removes every image the store holds in that set (App Store Connect: the placements of the display
type; Google Play: `images.deleteall` of the image type). The App Store requires screenshots for the largest iPhone and iPad
display types (and Google Play for phones): emptying one of those is allowed, and `predictDraft` / the plan readiness say that a
submit would be blocked (`no_screenshots`, `locale_without_screenshots`); the web shows "This display type will have no
screenshots: the App Store needs at least one" before the change is made. Legacy sizes (iPhone 5.5" and smaller) are optional.
A set that was staged only to add files and is then emptied pushes as `already_same` when the store holds none.

Errors added: `spec_errors`, `invalid_position`, `too_large` (413), `too_many_bytes`, `too_many_files`,
`ref_expired`, `image_blocked`, `binary_change_set` (a change set with binary files cannot be refreshed or fixed up
yet), and `fix_*` (`fix_not_png`, `fix_nothing_to_fix`, `fix_no_target_size`, ...).

Audit: `staged.asset_added`, `staged.asset_replaced`, `staged.asset_removed`, `staged.asset_fixed`, `staged.assets_to_repo`,
`assets.pulled`. Rate limits: uploads, inspections and fixes 60 a minute per workspace.

## Submit and publish

A push never submits, sends for review or publishes. Handing the pushed draft to the store's review is a separate
step with its own switch (`KILN_STORE_SUBMIT_ENABLED`), right (`store.submit`), preview, hash and typed
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
  writes the SHA-256 (first 32 hex characters) into the image's `referenceName` (`kiln:sha256:<hex>`) to tell "the same
  file"; whether Apple accepts that text, the `filter[referenceName]` semantics and the `limit` / `fields` parameters
  of the placements list, and the `deviceFamily` strings of the display classes. Images of the library are never
  deleted except one that failed processing here: replacing a set deletes its placements only.
- Google Play: whether `edits.listings.update` replaces the listing (the connector sends every member it
  read), `uploadType=media`, accepted image types and sizes, whether upload order is display order,
  whether `changesNotSentForReview` is allowed for every app (e.g. managed publishing off), and
  whether a committed but unsent draft shows in a later edit (so an unknown outcome on Google Play cannot be
  confirmed by a re-read).
