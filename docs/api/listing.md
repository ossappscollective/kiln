# API: live store listing, drift and field history

The store listing of an app (name, subtitle, description, keywords, and the other per-locale texts)
as the **store** has it, compared with the **repository** and with what this tool last knew, plus a
history of every field. This is the read side of the listing work: **nothing here writes to a store**
(see "Read-only" below). The one action, `POST /listing/pull`, copies the store's text into the
repository's listing files as a **draft change set**. Changing a listing in a store still goes through
change sets on the repository ([repositories](repositories.md)), then the store step in App Store
Connect or Google Play Console.

Everything is under `/api/workspaces/:workspaceId`, needs a session, and follows the usual rules: a
non-member (or an unknown workspace or app, or an app of another workspace) gets
`404 {"error":"not_found"}`, a member without the right gets `403 {"error":"forbidden"}`, no session
gets `401`. Times are epoch milliseconds.

## Read-only

- The connectors only `GET` from Apple. On Google Play they insert an empty edit, `GET` the listings
  and `DELETE` the edit; **no edit is ever committed or validated**, and no listing is changed.
- Of the five endpoints below, three read only this tool's database. `POST /listing/repo-refresh`
  reads the linked repository on GitHub (the same read as the listing screen of the repository); it is
  a `POST` only because it records what it read. `POST /listing/pull` reads GitHub too and creates a
  **draft** change set (see "Pull the store listing into the repository"); it never writes to a store.
- The store listing is read as part of the app sync (`POST /apps/:id/sync`, see [apps](apps.md)),
  with the same credential and the same connector. It adds no new credential use and no audit event.
  A failure reading the listing **never fails the release sync**; it is stored as `listing_error`
  and shown here under `store.error`.

## Rights

| Action | viewer | member | admin / owner |
| --- | --- | --- | --- |
| `listing.read`: `GET .../listing/live`, `.../listing/drift`, `.../listing/history` | yes | yes | yes |
| `repositories.scan`: `POST .../listing/repo-refresh` | no | yes | yes |
| `listing.read` and `changesets.write`: `POST .../listing/pull` (a draft; approving it still needs `changesets.approve`) | no | yes | yes |
| `apps.sync` as well, only with `refresh: true` in that pull | no | yes | yes |
| `apps.sync`: refresh the store side (`POST /apps/:id/sync`) | no | yes | yes |

Why viewers read it: the values are the public texts of a store page, plus the repository's copy of
them; they hold no secret, and viewers already read the portfolio. No response contains a credential,
a token or a secret.

Reads are not audited (they are reads of our own database). Reading the repository is audited as a
`credential.use` (purpose `repository.listing`) like every other use of a repository credential.
The sync's own `credential.use` covers the store read.

## Where the values come from

Every value has a **source**, and a new snapshot row is stored **only when the value changed**
(compared by hash), so a history has no repeats however often the app is synced.

| `source` | When it is recorded | `sourceRef` | `channel` |
| --- | --- | --- | --- |
| `store` | each app sync (best effort) | the store version string, or `null` | `live` or `editable` |
| `repo` | `POST .../listing/repo-refresh` | the commit sha that was read | `default` |
| `change_set` | a change set of this app that was applied (found on the next read of drift or history, once per change set) | the change set id | `default` |

- **Channels (App Store).** Apple keeps the live version and the next version apart. The `live`
  channel is the version that is on sale; the `editable` channel is a version a person can still
  change (in preparation, in review, rejected). Both are read when they exist. The drift view
  compares the repository with the `live` channel, or with `editable` for an app that has no live
  version yet (`channel` in the drift response says which). Google Play has only a `live` channel (see
  "What each store has").
- **Removed fields.** When a read no longer has a field it had, an "absent" row (`value: null`) is
  stored, so removing a value is part of the history. When the editable version of an iOS app is
  released, the `editable` channel is recorded as removed and its values move to `live`.
- **Last synced / DB.** The `db` side of a field is what this tool last knew: the newest of the store
  snapshots and the change sets applied since. After a sync it equals `live`. After a change set is
  applied (before the store has it) it is the proposed value, so the three columns can all differ.

## What each store has

The values map into the listing model of `@mrm/core` (the same fields and limits as the listing
editor and the repository listing). A field a store does not have is simply never present.

| Field | App Store | Google Play |
| --- | --- | --- |
| `name` / `title` | `name` (app info) | `title` |
| `subtitle` | `subtitle` (app info) | none |
| `short_description` | none | `shortDescription` |
| `description` / `full_description` | `description` (version) | `fullDescription` |
| `keywords` | `keywords` (version) | none |
| `promotional_text` | `promotionalText` (version) | none |
| `release_notes` | `whatsNew` (version) | none (release notes belong to a track release, not read here) |
| `marketing_url`, `support_url` | version | none |
| `privacy_url`, `apple_tv_privacy_policy` | `privacyPolicyUrl`, `privacyPolicyText` (app info) | none |
| `video` | none | `video` |

Not read: **categories** (an App Store category is a relationship of the app info, a Play category is
not in the listing), the age rating, screenshots and previews, Apple's `privacyChoicesUrl`, the
copyright, in-app purchase and subscription texts, and Play's `changelogs`. The roadmap's "category"
field is therefore not covered yet.

## Drift statuses

Per locale and field, the repository's value and the live store value are compared:

| Status | Meaning |
| --- | --- |
| `identical` | Both have the same value (or neither has one). |
| `repo-ahead` | They differ, and the store still shows a value the repository once had: the repository changed after they last agreed. It has not reached the store yet. |
| `store-ahead` | They differ, and the repository still holds a value the store once had: the store changed after they last agreed (someone edited it in the console). |
| `diverged` | They differ, and neither holds the value they last agreed on, or they never agreed. |
| `missing-in-one` | Only one side has a value. `missingIn` is `"repo"` or `"store"`, the side without it. |

The direction comes from the recorded history, not from one comparison: the last value both sides had
is the newest repository value the store has shown. A history that starts after the two already
differed (a first read) therefore gives `diverged`, not a guess. The repository's `default` locale
(the fallback folder) fills fields that a locale does not set, as the stores do.

Text is compared after normalizing line endings (`\r\n` and `\r` to `\n`) and dropping trailing white space (the stores trim, and the repository model drops one trailing line break); other whitespace counts.

The same limits as the listing editor are applied to **each side** (`problems`): the field's maximum
in characters or bytes (Apple's keywords limit is bytes), required fields, URL shape. A side over the
limit shows a problem; this never changes the status.

## `GET /apps/:id/listing/drift`

The three-way view. Needs `listing.read`. Also records change sets of this app that were applied since
the last look.

```json
{
  "appId": "6f1c…",
  "platform": "ios",
  "channel": "live",
  "store": { "readAt": 1790000000000, "error": null },
  "repo": { "readAt": 1789990000000, "ref": "3fa9c1b2d4e5f60718293a4b5c6d7e8f90a1b2c3", "error": null },
  "summary": { "identical": 11, "repo-ahead": 1, "store-ahead": 0, "diverged": 1, "missing-in-one": 2 },
  "locales": [
    {
      "locale": "en-US",
      "fields": [
        {
          "locale": "en-US",
          "field": "subtitle",
          "label": "Subtitle",
          "limit": 30,
          "unit": "characters",
          "status": "repo-ahead",
          "repo": { "value": "Fast trips", "observedAt": 1789990000000, "sourceRef": "3fa9c1b…", "source": "repo" },
          "db": { "value": "Quick rides", "observedAt": 1789000000000, "sourceRef": "2.0.0", "source": "store" },
          "live": { "value": "Quick rides", "observedAt": 1789000000000, "sourceRef": "2.0.0", "source": "store" },
          "problems": { "repo": [], "live": [] }
        }
      ]
    }
  ]
}
```

- `channel`: `"live"`, `"editable"` (the store has no live version yet) or `null` (nothing was read
  from the store).
- `store.readAt` is the last successful read of the store listing; `store.error` is why the latest
  attempt failed, or `null`. The values are then those of the last good read. `repo.readAt`, `repo.ref`
  and `repo.error` are the same for the repository.
- Each side is `{ value, observedAt, sourceRef, source }`. `value: null` with `observedAt: null`:
  never seen; `value: null` with an `observedAt`: removed. `observedAt` is when the value was **first
  seen**, not when it was last read.
- `locales` has the locales with at least one value, sorted, with fields in the order of the store's
  field list. A field that neither side has is left out. `repo.value` can come from the `default`
  folder (`sourceRef` is then its commit as well).
- `problems.repo` and `problems.live` are `{ code, severity, message, limit?, actual?, unit? }`, the
  same codes as the listing editor (`too_long`, `too_short`, `missing_required`, `invalid_url`, ...).

## `GET /apps/:id/listing/live`

The live store values as recorded by the last sync, per channel, without the comparison.

```json
{
  "appId": "6f1c…",
  "platform": "ios",
  "readAt": 1790000000000,
  "error": null,
  "channels": [
    {
      "channel": "live",
      "sourceRef": "2.0.0",
      "observedAt": 1789000000000,
      "locales": { "en-US": { "name": "Acme Trips", "subtitle": "Quick rides" } }
    },
    {
      "channel": "editable",
      "sourceRef": "2.1.0",
      "observedAt": 1790000000000,
      "locales": { "en-US": { "name": "Acme Trips", "subtitle": "Fast trips" } }
    }
  ]
}
```

`channels` is empty before the first successful read. `readAt` and `error` are as above.

## `GET /apps/:id/listing/history`

The recorded values of one field (or a whole app), newest first, in pages.

Query: `locale` (such as `en-US`, optional), `field` (a field of the app's platform, optional, for
example `subtitle` or `short_description`), `limit` (1 to 200, default 50), `cursor` (the
`nextCursor` of the previous page).

```json
{
  "items": [
    {
      "id": "b7e2…",
      "locale": "en-US",
      "field": "subtitle",
      "channel": "default",
      "value": "Fast trips",
      "source": "repo",
      "sourceRef": "3fa9c1b2d4e5f60718293a4b5c6d7e8f90a1b2c3",
      "observedAt": 1789990000000,
      "actor": { "type": "user", "id": "u1…" }
    },
    {
      "id": "a1c4…",
      "locale": "en-US",
      "field": "subtitle",
      "channel": "live",
      "value": null,
      "source": "store",
      "sourceRef": "2.0.0",
      "observedAt": 1789000000000,
      "actor": { "type": "user", "id": "u1…" }
    }
  ],
  "nextCursor": null
}
```

`value: null` is a removal. `actor` is who started the read (`null` when no one did). An unknown `locale` or a field of the other store returns
an empty list or a 400 (below), never another app's rows.

## `POST /apps/:id/listing/repo-refresh`

Reads the repository linked to the app (`apps.repository_id`) with the listing target that points to
this app, and records the repository side. Needs `repositories.scan`. Shares one budget per workspace
per minute with repository reads (default 10).

Response `200`:

```json
{ "ref": "3fa9c1b2d4e5f60718293a4b5c6d7e8f90a1b2c3", "found": true, "changed": 3, "removed": 0, "unchanged": 19 }
```

`found: false` means the repository has no listing for this app's store; nothing is recorded and
`repo.error` of the drift view says so.

## `POST /apps/:id/listing/pull`

Pull the live store listing into the repository: it takes the store's text for the fields where the
**store is ahead** of the repository (or the two **diverged**) and makes a **draft change set** that
writes those values into the repository's listing files. Nothing is written to a store and nothing is
written to the repository: the draft is reviewed, approved and applied like every change set
(`POST /change-sets/:id/approve`, then `/apply`), and applying opens a **pull request on GitHub**
([repositories](repositories.md)). Committing straight to a branch of a local clone is a later task.

Needs `listing.read` and `changesets.write` (member and up), and `apps.sync` as well when `refresh` is
true. The app must be linked to a repository. The request body is limited to 64 KB.

The files come from the repository's **listing source**, the same rule as every other listing read: the
App Store listing goes into the Expo `store.config.json` when the repository has one (only the
edited values change; other keys and the formatting stay), else into fastlane metadata files; the
Google Play listing goes into fastlane metadata files. The usual change set protections apply: only
files inside the chosen listing target's folders (or the store config) can be in the draft
(`outside_target`), and the audit log records `changeset.create` with `source: "store_pull"`, the app,
the channel and whether the store was refreshed first.

Body, all optional:

| Field | Meaning |
| --- | --- |
| `items` | `[{ "locale": "en-US", "field": "subtitle" }]`: exactly these fields (the locale as the store has it, as the drift view shows it). A field the repository has no value for yet is pulled when it is named here. |
| `locales`, `fields` | Narrow to these store locales and/or these field ids. Combined with `items`, both apply. Without `items`, `locales` and `fields`, every field that can be pulled is. |
| `addLocales` | `true` also creates locales the repository has no folder (or Expo key) for. Default `false`: those are skipped with `locale_not_in_repo`. |
| `channel` | `live` or `editable`. Default: `live`, or `editable` for an app with no live version. |
| `summary` | One line, up to 200 characters. Default: "Pull the App Store listing of Acme into the repository". |
| `refresh` | `true` runs the read-only store sync first, so the pull is of the store as it is now. It counts toward the app sync limit (10 a minute per workspace). Default: use the last read. |
| `target`, `roots` | Which listing target or folders, exactly as for `GET /repositories/:id/listing`. Without them the saved target of this app, else the detected one, else the default; with several possible places and no choice the answer is `422 target_required`. |

```json
{
  "items": [
    { "locale": "en-US", "field": "subtitle" },
    { "locale": "de-DE", "field": "description" }
  ],
  "refresh": true,
  "summary": "Pull the store listing after the console edit"
}
```

Which fields are pulled, from the same history the drift view uses: `store-ahead` and `diverged`, when
the store has a non-blank value. **Never** pulled: `repo-ahead` (that would undo a change that has not
reached the store), identical fields, fields the store has no value for (the repository's value is never
blanked), and a store value over the field's limit (reported, never shortened). Store locale codes are
mapped to the repository's folder names (`en-US` to `en-US`, case and `_` or `-` differences, and the
equivalent codes such as `ja` and `ja-JP`, or `zh-Hans` and `zh-CN`); a locale that matches several folders is
skipped as ambiguous, and Expo store configs accept only the locales EAS Metadata supports.

Response `201` with a draft (a person reviews it next):

```json
{
  "changeSet": {
    "id": "c1f0…", "repositoryId": "9a2b…", "summary": "Pull the store listing after the console edit",
    "status": "draft", "createdBy": { "type": "user", "id": "u1…" },
    "branch": null, "prUrl": null, "filesChanged": 2,
    "files": [{ "path": "fastlane/metadata/en-US/subtitle.txt", "change": "modified", "before": "Quick rides", "after": "Fast trips" }]
  },
  "channel": "live",
  "store": { "readAt": 1790000000000, "error": null, "refreshed": true },
  "target": {
    "repositoryId": "9a2b…", "repository": "acme/trips", "branch": "main",
    "source": "fastlane", "path": "fastlane/metadata",
    "selected": { "id": null, "origin": "detected", "label": "fastlane/metadata" }
  },
  "changes": [
    { "locale": "en-US", "repoLocale": "en-US", "field": "subtitle", "label": "Subtitle",
      "status": "store-ahead", "before": "Quick rides", "after": "Fast trips", "newLocale": false }
  ],
  "skipped": [
    { "locale": "de-DE", "field": "description", "reason": "over_limit",
      "message": "Description is 4120 characters; the limit is 4000. It was not pulled and was not shortened." }
  ],
  "problems": [],
  "locales": [{ "locale": "en-US", "repoLocale": "en-US", "how": "exact" }],
  "warnings": []
}
```

- `changes[].status`: `store-ahead`, `diverged`, `missing-in-repo` (named in `items`, the repository had
  no value) or `new-locale` (`addLocales`). `before` is the repository's value now (`null` for none).
- `skipped[].reason`: `repo_ahead`, `missing_in_store`, `identical`, `over_limit`, `locale_not_in_repo`,
  `locale_ambiguous`, `locale_invalid`, `locale_unsupported`, `locale_conflict`. A whole-locale skip has
  no `field`. `problems` are `validateListing` results for the values written (not blocking).
- `warnings` carries what the change set could not write (such as an Expo locale EAS Metadata does not
  support) and, when the last store read failed, that the values of the last good read were used.
- **Nothing to pull is not an error.** Status `200` with `"changeSet": null`, the same `target`,
  `skipped` and `warnings`, and `explanation` saying why (for example that every difference is
  `repo-ahead`).

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | `history`: a bad `locale`, `field`, `limit` or `cursor`. `issues` lists them as `{ path, message }`. |
| 401 | `unauthenticated` | No session. |
| 403 | `forbidden` | A member without the right. |
| 404 | `not_found` | Not a member, or no such app in this workspace. |
| 400 | `invalid_request` | `pull`: a bad body (a locale code, more than the allowed number of items, a summary of more than one line). |
| 413 | `payload_too_large` | `pull`: a body over 64 KB. |
| 422 | `no_repository` | `repo-refresh` or `pull` for an app that is not linked to a repository (or whose repository was disconnected). |
| 422 | `invalid_field` | `pull`: a field that the app's store does not have. |
| 422 | `no_store_listing` | `pull`: no listing was read from the store yet (or not that `channel`). `channels` lists what exists. Sync the app, or pull with `refresh`. |
| 422 | `target_required` | `pull`: the repository has several places this listing could be; `candidates` lists them. Send `target` or `roots`. |
| 422 | `no_target_folder` | `pull`: the chosen listing target has no folder for this store. |
| 422 | `store_config_invalid` | `pull`: the Expo `store.config.json` cannot be read (`path` says which); fix it in the repository. |
| 422 | `outside_target` | `pull`: a file would fall outside the chosen target's folders; nothing is created. |
| 422 | `refresh_unavailable` | `pull` with `refresh` on a server that cannot read the store. |
| 403 | `forbidden` | Also: `pull` with `refresh: true` without `apps.sync`. |
| 422 | `github_auth`, `github_forbidden`, `github_not_found`, `github_invalid` | `repo-refresh` or `pull`: GitHub refused or the repository could not be read ([repositories](repositories.md)). |
| 429 | `rate_limited` | `repo-refresh` or `pull` too often (they share the repository read limit); `pull` with `refresh` also the app sync limit. `Retry-After` and `retryAfterSeconds` say when. |
| 504 | `timeout` | `repo-refresh` or `pull`: GitHub did not answer in time. |

Errors reading the **store** are not HTTP errors here: they are `store.error` in the drift response
(and `error` in `live`), with the last good values still shown. The message is one redacted sentence,
for example "The store did not answer in time while reading the listing."

## Limits and known gaps

- **No live store call has been made.** The connectors are tested against hand-written fixtures; see
  [store API conventions](../spikes/store-api-conventions.md) for what was and was not verified.
- **Which version is "live" and which is "editable"** is decided by Apple's state names. That
  `READY_FOR_DISTRIBUTION` is the one on sale, and which states are still editable, is not stated on
  Apple's pages; a version in neither list is ignored. The connector returns a warning for it, but the server does not store or show connector warnings yet.
- **Google Play drafts.** Whether a listing read through a new edit shows unpublished changes made in
  the console (an edit is a copy of the live state) is not documented. The Play side is treated as the
  live listing.
- **Monorepos.** The repository side uses the saved listing target whose app is this app; a repository
  with several apps and no saved target can read the wrong folder. Save a target (see
  [repositories](repositories.md)).
- **History starts at the first read.** Nothing is backfilled; the first sync records every field as
  new. A change set is recorded when the next read of drift or history finds it, with the time it was applied.
- Deleting an app deletes its listing history with it.
- The listing routes, including `pull`, are in the OpenAPI registry (`services/api-operations.ts`); `pull` needs `changesets.write` for an API token too, and its answer is described in part.
- No push or submit action toward a store exists, in the API or in the web UI. `pull` only makes a draft in the repository's change sets; applying it opens a pull request on GitHub. Committing to a branch of a local clone is a later task.
- **`pull` has not been run against a real store, GitHub or Postgres.** It is tested on SQLite with fakes for the store and GitHub; the store snapshot it uses is the last sync (or the refresh it runs).
- A token whose scopes include only `changesets.write` can pull, because the registry names one action per operation; the session route still checks `listing.read` too.
