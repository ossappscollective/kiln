# API: live store listing, drift and field history

The store listing of an app (name, subtitle, description, keywords, and the other per-locale texts)
as the **store** has it, compared with the **repository** and with what this tool last knew, plus a
history of every field. This is the read side of the listing work: **nothing here writes to a store**
(see "Read-only" below). Changing a listing still goes through change sets on the repository
([repositories](repositories.md)), then the store step in App Store Connect or Google Play Console.

Everything is under `/api/workspaces/:workspaceId`, needs a session, and follows the usual rules: a
non-member (or an unknown workspace or app, or an app of another workspace) gets
`404 {"error":"not_found"}`, a member without the right gets `403 {"error":"forbidden"}`, no session
gets `401`. Times are epoch milliseconds.

## Read-only

- The connectors only `GET` from Apple. On Google Play they insert an empty edit, `GET` the listings
  and `DELETE` the edit; **no edit is ever committed or validated**, and no listing is changed.
- Of the four endpoints below, three read only this tool's database. The fourth,
  `POST /listing/repo-refresh`, reads the linked repository on GitHub (the same read as the listing
  screen of the repository). It is a `POST` only because it records what it read.
- The store listing is read as part of the app sync (`POST /apps/:id/sync`, see [apps](apps.md)),
  with the same credential and the same connector. It adds no new credential use and no audit event.
  A failure reading the listing **never fails the release sync**; it is stored as `listing_error`
  and shown here under `store.error`.

## Rights

| Action | viewer | member | admin / owner |
| --- | --- | --- | --- |
| `listing.read`: `GET .../listing/live`, `.../listing/drift`, `.../listing/history` | yes | yes | yes |
| `repositories.scan`: `POST .../listing/repo-refresh` | no | yes | yes |
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

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | `history`: a bad `locale`, `field`, `limit` or `cursor`. `issues` lists them as `{ path, message }`. |
| 401 | `unauthenticated` | No session. |
| 403 | `forbidden` | A member without the right. |
| 404 | `not_found` | Not a member, or no such app in this workspace. |
| 422 | `no_repository` | `repo-refresh` for an app that is not linked to a repository. |
| 422 | `github_auth`, `github_forbidden`, `github_not_found`, `github_invalid` | `repo-refresh`: GitHub refused or the repository could not be read ([repositories](repositories.md)). |
| 429 | `rate_limited` | `repo-refresh` too often. `Retry-After` and `retryAfterSeconds` say when. |
| 504 | `timeout` | `repo-refresh`: GitHub did not answer in time. |

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
- These routes are not in the OpenAPI registry (`services/api-operations.ts`, another change's file), so an API token cannot call them yet; a session can.
- No push, submit or apply action toward a store exists, in the API or in the web UI.
