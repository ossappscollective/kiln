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
- It can also be read **on a schedule** (`KILN_LISTING_INTERVAL_MINUTES`, off by default; see
  "Scheduled reads"). That is the same read with the same connector, started by the scheduler.
- The **sections** beyond the texts (categories, age rating, privacy choices URL, app details, media
  counts, Play release notes; see "Sections beyond the texts") are read-only twice over: nothing is
  written to a store, and they are **never pulled into the repository**. The App Store review detail
  (contact person, phone number, demo account and its password) is **never read at all**.

## Rights

| Action                                                                                                                  | viewer | member | admin / owner |
| ----------------------------------------------------------------------------------------------------------------------- | ------ | ------ | ------------- |
| `listing.read`: `GET .../listing/live`, `.../listing/drift`, `.../listing/history`                                      | yes    | yes    | yes           |
| `listing.read`: `GET .../listing/fixes` (computed one-click fixes)                                                      | yes    | yes    | yes           |
| `changesets.write`: `POST .../listing/fixes/stage` (stages one fix)                                                     | no     | yes    | yes           |
| `repositories.scan`: `POST .../listing/repo-refresh`                                                                    | no     | yes    | yes           |
| `listing.read` and `changesets.write`: `POST .../listing/pull` (a draft; approving it still needs `changesets.approve`) | no     | yes    | yes           |
| `apps.sync` as well, only with `refresh: true` in that pull                                                             | no     | yes    | yes           |
| `apps.sync`: refresh the store side (`POST /apps/:id/sync`)                                                             | no     | yes    | yes           |

Why viewers read it: the values are the public texts of a store page, plus the repository's copy of
them; they hold no secret, and viewers already read the portfolio. No response contains a credential,
a token or a secret.

Reads are not audited (they are reads of our own database). Reading the repository is audited as a
`credential.use` (purpose `repository.listing`) like every other use of a repository credential.
The sync's own `credential.use` covers the store read.

## Where the values come from

Every value has a **source**, and a new snapshot row is stored **only when the value changed**
(compared by hash), so a history has no repeats however often the app is synced.

| `source`     | When it is recorded                                                                                         | `sourceRef`                         | `channel`            |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------- |
| `store`      | each app sync (best effort)                                                                                 | the store version string, or `null` | `live` or `editable` |
| `repo`       | `POST .../listing/repo-refresh`                                                                             | the commit sha that was read        | `default`            |
| `change_set` | a change set of this app that was applied (found on the next read of drift or history, once per change set) | the change set id                   | `default`            |

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

The values map into the listing model of `@kiln/core` (the same fields and limits as the listing
editor and the repository listing). A field a store does not have is simply never present.

| Field                                    | App Store                                          | Google Play                                                   |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `name` / `title`                         | `name` (app info)                                  | `title`                                                       |
| `subtitle`                               | `subtitle` (app info)                              | none                                                          |
| `short_description`                      | none                                               | `shortDescription`                                            |
| `description` / `full_description`       | `description` (version)                            | `fullDescription`                                             |
| `keywords`                               | `keywords` (version)                               | none                                                          |
| `promotional_text`                       | `promotionalText` (version)                        | none                                                          |
| `release_notes`                          | `whatsNew` (version)                               | none (release notes belong to a track release, not read here) |
| `marketing_url`, `support_url`           | version                                            | none                                                          |
| `privacy_url`, `apple_tv_privacy_policy` | `privacyPolicyUrl`, `privacyPolicyText` (app info) | none                                                          |
| `video`                                  | none                                               | `video`                                                       |

Not read: in-app purchase and subscription texts, Apple's phased release, and anything not named under
"Sections beyond the texts". Play's `changelogs` model field stays empty; Play release notes are the
`releaseNotes` section instead.

## Sections beyond the texts

Besides the text fields, a read has up to six **sections**, each a small structured value kept per
store version (`channel`). They are shown by `GET .../listing/live` (per channel, under `sections`)
and compared with the repository by `GET .../listing/drift` (`sections`). They are **read-only and
never pulled into the repository** (`POST .../listing/pull` takes text fields only; asking for a
section name there is a `422 invalid_field`).

| Section        | App Store (App Store Connect API)                                                                                                                                    | Google Play (Play Developer API)                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories`   | `primaryCategory`, `secondaryCategory`, `primarySubcategoryOne/Two`, `secondarySubcategoryOne/Two` of the live app info, as the category ids (`GAMES`, `GAMES_CARD`) | **Not in the API.** None of the Play resources has an app category; it is set in Play Console only, so there is no section                                            |
| `ageRating`    | `ageRatingDeclaration` of the app info (its answers, such as `violenceCartoonOrFantasy: "NONE"`) and the label `AppInfo.appStoreAgeRating`                           | **Not read.** None of the `edits` resources this tool reads has one (as far as the reference pages say); the content rating questionnaire is answered in Play Console |
| `privacy`      | `privacyChoicesUrl` per locale (`appInfoLocalizations`). The privacy **policy** URL is the text field `privacy_url`                                                  | none                                                                                                                                                                  |
| `details`      | `copyright` of the version                                                                                                                                           | `edits.details`: default language, contact email and website. The contact **phone number is not read**                                                                |
| `media`        | screenshot sets and preview sets per locale and device type: **counts, file names and delivery states only**                                                         | `edits.images.list` per language and image type: **ids and counts only** (screenshots, icon, feature graphic, TV banner)                                              |
| `releaseNotes` | none (`release_notes` is the text field `whatsNew`)                                                                                                                  | the release notes of the current release of each track, per language (`edits.tracks`)                                                                                 |

Where each comes from (all `GET`; Google Play inside the same read-only edit that is deleted, never
committed):

- App Store Connect, categories and age rating: `GET /v1/apps/{id}/appInfos` with `include` of the six
  category relationships and `ageRatingDeclaration`
  ([appInfos](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-appinfos),
  [ageRatingDeclaration](https://developer.apple.com/documentation/appstoreconnectapi/ageratingdeclaration/attributes-data.dictionary)).
- App Store Connect, privacy choices URL:
  [`appInfoLocalizations` attributes](https://developer.apple.com/documentation/appstoreconnectapi/appinfolocalization/attributes-data.dictionary),
  already part of the text read. Copyright:
  [`appStoreVersions` attributes](https://developer.apple.com/documentation/appstoreconnectapi/appstoreversion/attributes-data.dictionary).
- App Store Connect, media: per version localization
  [`GET /v1/appStoreVersionLocalizations/{id}/appScreenshotSets`](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversionlocalizations-_id_-appscreenshotsets)
  and [`.../appPreviewSets`](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-appstoreversionlocalizations-_id_-apppreviewsets),
  with `include` of the assets, `limit[...]` and sparse `fields[...]`: the file name and the delivery
  state, never an image URL, a template URL or an upload operation. Apple marks the screenshot sets
  endpoint **deprecated** (since API 4.5, in favour of the asset library placements): when it is gone the
  read gives a warning and the `media` section stays "not read".
- App Store Connect, **review detail: deliberately skipped.** `appStoreReviewDetails` holds a contact
  name, email and phone number and a demo account's user name and password. Those are personal data and
  secrets this tool has no use for, so the resource is not requested at all.
- Google Play:
  [`edits.details.get`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.details/get),
  [`edits.images.list`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images/list)
  (image types in [`AppImageType`](https://developers.google.com/android-publisher/api-ref/rest/v3/AppImageType)),
  [`edits.tracks`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks). No
  `upload`, no `deleteall`, no `commit`.

**Not read, not empty.** A section that is **absent** from a response was _not read_: the store could
not say, the call failed (see `warnings`), the optional read was not asked for, or it has never been
read. A section that is **present, even with no content** (`{ "choicesUrls": {} }`), was read and the
store has nothing there. A read that does not have a section never erases what is known; a read
that has an empty one records that it is empty. The same rule applies to the repository side: a
section the repository's files cannot express is _not read_ there, and the comparison says
`not-comparable` instead of guessing.

**Upgrading is quiet.** Sections are stored as extra rows of the snapshot table (locale `_app`, field
`section:<name>`, one canonical JSON text, a row only when it changed), apart from the text fields.
Snapshots recorded before sections existed have no such rows and are not touched: no text field looks
changed, the history shows no new entries (section rows are not in `GET .../listing/history`), and
the sections read `not-read` until the first read that has them.

**Caps.** A read asks for up to 30 locales of media per version (2 requests each) and 50 items per
set; a larger listing is cut and says so (`media.truncated`, and a warning). Google Play reads images
for up to 25 languages (8 image types each). A large listing is therefore roughly up to 100 to 200
requests per read, which matters for the schedule below. Rate limiting (`429`), a bad credential and
the network stop the read; any other failure of an optional section is a warning.

**UNVERIFIED.** No real store response was recorded. The parsers follow the reference pages and
hand-written fixtures and are tolerant (an unknown member is ignored, a wrong type is skipped). Not
verified: that Apple sends the relationship linkage for what `include` names (the categories rely on
it; without linkage the section stays _not read_), the exact values of `appStoreAgeRating`, whether the
deprecated screenshot sets endpoint still answers, and what Apple answers to an `include` it does not
accept (the read then falls back to the plain app info list and warns).

### Comparing with the repository

| Section        | Repository side                                                                                                                                                                | Compared as                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories`   | fastlane `deliver` files in the metadata folder (`primary_category.txt`, `secondary_category.txt`, `primary_first_sub_category.txt`, ...), or Expo `apple.categories`          | names; `Food & Drink`, `FOOD_AND_DRINK` and `MZGenre.FOOD_AND_DRINK` are one category                                                                                               |
| `ageRating`    | Expo `apple.advisory` (the API's own names); for fastlane a file named `app_rating_config.json` next to or above the metadata folder (fastlane's docs name no fixed file name) | key by key, only for keys both sides have; fastlane's legacy `0`, `1`, `2` read as `NONE`, `INFREQUENT_OR_MILD`, `FREQUENT_OR_INTENSE`. No comparable key: `not-comparable`         |
| `privacy`      | Expo `apple.info.<locale>.privacyChoicesUrl`. fastlane has no file for it                                                                                                      | URL per locale                                                                                                                                                                      |
| `details`      | `copyright.txt` (fastlane) or `apple.copyright` (Expo)                                                                                                                         | the copyright text. Google Play: not comparable                                                                                                                                     |
| `media`        | fastlane: image files counted from the **paths** (`screenshots/<locale>/...`, `<locale>/images/<type>/...`); Expo has no media fields                                          | **counts only**, never content: App Store per-locale totals (fastlane cannot say the device type without reading the image), Google Play per image type. No image file is ever read |
| `releaseNotes` | none                                                                                                                                                                           | `not-comparable`: shown as the store has them                                                                                                                                       |

Statuses of a section: `identical`, `differs`, `missing-in-repo` (the store has something, the
repository says nothing), `missing-in-store`, `not-comparable` (the repository cannot say this
faithfully, or was not read) and `not-read` (the store side has not been read). A section with
`differs` or `not-comparable` carries one short sentence per difference or limit in `details`.

## Drift statuses

Per locale and field, the repository's value and the live store value are compared:

| Status           | Meaning                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identical`      | Both have the same value (or neither has one).                                                                                                           |
| `repo-ahead`     | They differ, and the store still shows a value the repository once had: the repository changed after they last agreed. It has not reached the store yet. |
| `store-ahead`    | They differ, and the repository still holds a value the store once had: the store changed after they last agreed (someone edited it in the console).     |
| `diverged`       | They differ, and neither holds the value they last agreed on, or they never agreed.                                                                      |
| `missing-in-one` | Only one side has a value. `missingIn` is `"repo"` or `"store"`, the side without it.                                                                    |

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
  "repo": {
    "readAt": 1789990000000,
    "ref": "3fa9c1b2d4e5f60718293a4b5c6d7e8f90a1b2c3",
    "error": null
  },
  "summary": {
    "identical": 11,
    "repo-ahead": 1,
    "store-ahead": 0,
    "diverged": 1,
    "missing-in-one": 2
  },
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
          "repo": {
            "value": "Fast trips",
            "observedAt": 1789990000000,
            "sourceRef": "3fa9c1b…",
            "source": "repo"
          },
          "db": {
            "value": "Quick rides",
            "observedAt": 1789000000000,
            "sourceRef": "2.0.0",
            "source": "store"
          },
          "live": {
            "value": "Quick rides",
            "observedAt": 1789000000000,
            "sourceRef": "2.0.0",
            "source": "store"
          },
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
- `sections` (additive; the sections of the app's platform only: iOS `categories`, `ageRating`, `privacy`,
  `details`, `media`; Android `details`, `media`, `releaseNotes`):

  ```json
  "sections": [
    {
      "name": "categories",
      "store": { "primary": "PRODUCTIVITY", "secondary": "BUSINESS" },
      "storeObservedAt": 1789000000000,
      "repo": { "primary": "Productivity" },
      "repoObservedAt": 1789990000000,
      "compare": { "status": "differs", "details": ["secondary category: store BUSINESS, repository none"] }
    }
  ]
  ```

  `store` or `repo` is `null` when that side did not read the section. The values are as in `live`,
  below. Media is `{ "screenshots": { "en-US": [{ "type": "APP_IPHONE_67", "count": 3, "names": [...] }] },
  "previews": {...} }` (Google Play: `graphics` too, with `ids` in place of `names`). Counts only.

## Listing settings: the repository comparison is opt in

`GET /apps/:id/listing-settings` (`apps.read`) and `PUT /apps/:id/listing-settings` (`apps.write`, a partial update, audited as
`app.listing_settings_update`) hold two booleans per app, both **false by default** (an app that never changed them, every existing app,
reads false): `compareRepo` (compare the repository's text with the store's) and `compareMedia` (compare the repository's graphics with the
store's). They are stored as one JSON value in `workspace_settings` under `app.<appId>.listing` (no migration) and deleted with the app. An
unknown key or a non boolean is `422 invalid_setting` with `issues`.

With `compareRepo` off, `GET .../listing/drift` answers `compare: { repo: false, media: ... }`: the repository's values are not read into the
answer, every field has status `identical` and `repo.value` null, nothing is `missing` or `differs`, and a field is still judged by the store
value alone (`problems.live`: limits, required fields). With `compareMedia` off the `media` section is not compared. Nothing is written to a
store or a repository either way.

## `GET /apps/:id/listing/live`

The live store values as recorded by the last sync, per channel, without the comparison.

```json
{
  "appId": "6f1c…",
  "platform": "ios",
  "readAt": 1790000000000,
  "error": null,
  "warnings": ["Age rating declaration could not be read (HTTP 403)."],
  "schedule": {
    "enabled": true,
    "intervalMinutes": 360,
    "lastAttemptAt": 1790000000000,
    "failures": 0,
    "nextReadAt": 1790021600000
  },
  "channels": [
    {
      "channel": "live",
      "sourceRef": "2.0.0",
      "observedAt": 1789000000000,
      "locales": { "en-US": { "name": "Acme Trips", "subtitle": "Quick rides" } },
      "sections": {
        "categories": { "primary": "PRODUCTIVITY", "secondary": "BUSINESS" },
        "privacy": { "choicesUrls": { "en-US": "https://acme.example/choices" } },
        "details": { "copyright": "2026 Acme" },
        "media": {
          "screenshots": {
            "en-US": [{ "type": "APP_IPHONE_67", "count": 3, "names": ["a.png", "b.png", "c.png"] }]
          },
          "previews": {}
        }
      }
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

- `warnings` (additive) is what the connector noticed in the **last successful read**: an optional
  section it could not read, a limit it hit, an Apple state it does not know. Redacted, at most 20 of
  at most 400 characters; a read without warnings clears them. A section named in a warning is _not
  read_ (absent from `sections`), never shown as empty.
- `schedule` (additive) is the state of the scheduled read of this app: `enabled` and
  `intervalMinutes` (the server setting; `0` when off), `lastAttemptAt` (the later of the last
  attempt and the last successful read; `null` when never), `failures` (reads in a row that failed;
  `0` after a success) and `nextReadAt` (the earliest the scheduler reads it again, backed off after
  failures; `null` when off or when it has never been tried, which means at its next pass).
- `sections` (additive, per channel) has only the sections that were read. See "Sections beyond the
  texts".

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
{
  "ref": "3fa9c1b2d4e5f60718293a4b5c6d7e8f90a1b2c3",
  "found": true,
  "changed": 3,
  "removed": 0,
  "unchanged": 19
}
```

`found: false` means the repository has no listing for this app's store; nothing is recorded and
`repo.error` of the drift view says so.

## `POST /apps/:id/listing/pull`

Pull the live store listing into the repository: it takes the store's text for the fields where the
**store is ahead** of the repository (or the two **diverged**) and makes a **draft change set** that
writes those values into the repository's listing files. Nothing is written to a store and nothing is
written to the repository: the draft is reviewed, approved and applied like every change set
(`POST /change-sets/:id/approve`, then `/apply`), and applying opens a **pull request on GitHub**, or, with `mode: "local_branch"` (opt-in,
`KILN_LOCAL_REPO_WRITE=true`), **commits to a new branch of the repository's local clone** with an
optional push and pull request ([repositories](repositories.md)). For a repository with a local clone,
that is the way to "sync the store listing into fastlane metadata and commit it in git".

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

| Field               | Meaning                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items`             | `[{ "locale": "en-US", "field": "subtitle" }]`: exactly these fields (the locale as the store has it, as the drift view shows it). A field the repository has no value for yet is pulled when it is named here.                                      |
| `locales`, `fields` | Narrow to these store locales and/or these field ids. Combined with `items`, both apply. Without `items`, `locales` and `fields`, every field that can be pulled is.                                                                                 |
| `addLocales`        | `true` also creates locales the repository has no folder (or Expo key) for. Default `false`: those are skipped with `locale_not_in_repo`.                                                                                                            |
| `channel`           | `live` or `editable`. Default: `live`, or `editable` for an app with no live version.                                                                                                                                                                |
| `summary`           | One line, up to 200 characters. Default: "Pull the App Store listing of Acme into the repository".                                                                                                                                                   |
| `refresh`           | `true` runs the read-only store sync first, so the pull is of the store as it is now. It counts toward the app sync limit (10 a minute per workspace). Default: use the last read.                                                                   |
| `target`, `roots`   | Which listing target or folders, exactly as for `GET /repositories/:id/listing`. Without them the saved target of this app, else the detected one, else the default; with several possible places and no choice the answer is `422 target_required`. |

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
    "id": "c1f0…",
    "repositoryId": "9a2b…",
    "summary": "Pull the store listing after the console edit",
    "status": "draft",
    "createdBy": { "type": "user", "id": "u1…" },
    "branch": null,
    "prUrl": null,
    "filesChanged": 2,
    "files": [
      {
        "path": "fastlane/metadata/en-US/subtitle.txt",
        "change": "modified",
        "before": "Quick rides",
        "after": "Fast trips"
      }
    ]
  },
  "channel": "live",
  "store": { "readAt": 1790000000000, "error": null, "refreshed": true },
  "target": {
    "repositoryId": "9a2b…",
    "repository": "acme/trips",
    "branch": "main",
    "source": "fastlane",
    "path": "fastlane/metadata",
    "selected": { "id": null, "origin": "detected", "label": "fastlane/metadata" }
  },
  "changes": [
    {
      "locale": "en-US",
      "repoLocale": "en-US",
      "field": "subtitle",
      "label": "Subtitle",
      "status": "store-ahead",
      "before": "Quick rides",
      "after": "Fast trips",
      "newLocale": false
    }
  ],
  "skipped": [
    {
      "locale": "de-DE",
      "field": "description",
      "reason": "over_limit",
      "message": "Description is 4120 characters; the limit is 4000. It was not pulled and was not shortened."
    }
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
- **Pull is text only.** Categories, age rating, privacy choices URL, app details, screenshots and
  release notes are never written into the repository by a pull, whatever differs (the repository side
  of those is read, never written). A section name in `fields` or `items` is a `422 invalid_field`.
- **Nothing to pull is not an error.** Status `200` with `"changeSet": null`, the same `target`,
  `skipped` and `warnings`, and `explanation` saying why (for example that every difference is
  `repo-ahead`).

## `POST /change-sets/:id/recompute`

Makes a store pull again from the **live store listing** and the repository as they are now. For a
change set made by `POST /apps/:id/listing/pull` (its `origin.source` is `store_pull`; the request and a
hash per field are kept in `change_sets.origin_json`, never text). Needs `changesets.write` and
`listing.read`. Body (optional): `{ "refresh": true }` reads the store first, read only and under the
same limiter as a pull (`apps.sync` needed; `429` with `Retry-After`).

Allowed on a `draft`, `approved` or `failed` set **without a branch**. The set keeps its id and creator,
its files are replaced, approvals are cleared and the status is `draft`. For a set whose branch exists,
use `POST /change-sets/:id/fixup` with `{ "recompute": true }` ([repositories](repositories.md)).
Nothing changed since (`unchanged: true`) writes nothing and keeps an approval.

Answer: the pull shape (`changes`, `skipped`, `problems`, `target`, `store`, `warnings`) plus
`changeSet`, `unchanged`, `nothingLeft` (every field is already in the repository: discard the set),
`approvalCleared` and `diffFromPrevious: [{ locale, repoLocale, field, change, reason? }]`, where
`change` is `store_changed`, `unchanged`, `added` or `dropped` (`reason` is the skip reason, or
`identical`). Errors: `409 not_recomputable` (another source, or a row from before migration 17),
`409 invalid_state`, `409 has_branch`, `409 app_gone`, `409 app_relinked`, `409 changed_meanwhile`.
Audit `changeset.recompute` with counts only.

## Scheduled reads

`KILN_LISTING_INTERVAL_MINUTES` (default `0`, off; otherwise 30 to 10080) makes the scheduler read the
listing of every app that has a store credential, without anyone pressing a button. Without it the
listing is read only when the app is synced (by hand or by `KILN_SYNC_INTERVAL_MINUTES`, which also
reads the listing) or refreshed from the store. It runs where the background worker runs
(`KILN_WORKER=inline`); see [deployment](../deployment.md#scheduled-listing-reads).

- The scheduler only **queues** an `app.listing` job per app that is due; the worker reads it with
  the same read-only connector, credential use and snapshot recording as the sync's listing step. It
  never throws out of the scheduler's timer, and a failed read is recorded on the app, never retried
  by the queue.
- **Spaced and bounded.** At most 3 apps per scheduler pass (all workspaces) and 2 per workspace; the
  jobs of one pass run 15 seconds apart plus a random delay of up to a tenth of the interval (at most
  a minute). Each queued read also takes a slot of the per workspace store rate limit that manual
  syncs use, so scheduled and manual reads share one budget.
- **One read per credential at a time** (Google Play allows one open edit per service account, and
  Apple's limit counts per key): one job per credential is queued at a time, and a running job whose
  credential has another running listing job puts itself back 30 seconds (at most 10 times).
- **Never twice for one app**, also with several server instances on one database: no job is queued
  while the app has a queued or running `app.listing` or `app.sync` job, and the job claims the read
  with a compare-and-set on `app_listing_status.listing_attempt_at` (an app attempted within the last
  two minutes is not read again), so two instances that queued it at once read it once. The jobs
  themselves follow the job queue's optimistic claim (one worker gets a job).
- **Due** means an interval after the last attempt (successful or not), so an app that a person just
  refreshed, or that the sync just read, is not read again at once.
- **Backoff.** After each failure in a row the wait doubles (`interval * 2^failures`, at most
  `max(interval, 1 day)`), so a revoked key is not hammered. The first success resets it.
- **Audit.** The use of the credential is a `credential.use` event (purpose `app.listing`) with the
  actor type `system` and id `app.listing`, and `requestedBy: "scheduler"` in the job payload: the
  convention of [open decision 10](../open-decisions.md) (background syncs), not a person.
- **Request volume.** One read of a large listing is 100 to 200 requests (see "Caps"). With many apps,
  choose an interval of hours, not minutes.

## One-click fixes of the listing checks

Design: [ADR 0059](../adr/0059-listing-fixes-via-cart.md). The checks (`GET .../insights/listing-checks`) only say what is wrong. These routes offer the
fixes that are mechanical and safe and STAGE them in the pending changes (the cart, [staged changes](staged-changes.md)): nothing is published without the
review of the cart. The server is the only author of a fix. The pure functions are `proposeFixes` / `analyzeFixes` in `packages/core/src/listing/fixes.ts`.

### `GET /apps/:id/listing/fixes` (`listing.read`)

`{ appId, store, afterPending, locales[] }`. Per locale `{ locale, fixes[], cannot[], staged[] }`. The fixes are computed from the text **staged** for a
field when there is one, else the store's last read (live, or editable when there is no live version); `staged[]` is `{ field, id }` (the staged item, to
discard it). A fix is `{ id, labelKey, kind, locale, field, before, after, removed[], risk, resolves[], limit, unit, stageable }`:

| `id`                     | `kind`       | What it does                                                                                                                                  | `risk`   |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `keywords_tidy`          | `stage`      | Apple keywords: trim, collapse spaces, drop empty terms and trailing commas, drop a repeated term (the first stays), comma and no space.       | `safe`   |
| `keywords_drop_in_title` | `stage`      | The same, and drops the terms the name or subtitle already index (`removed[]` lists them).                                                    | `review` |
| `keywords_fit`           | `stage`      | Over the byte limit: hygiene, then whole terms the name or subtitle index (last first), then whole trailing terms, until it fits. Never cuts a word, never empties the field. | `review` |
| `text_tidy`              | `stage`      | A text over its limit only because of stray white space (runs of spaces, line ends, three line breaks): collapsed, only when that makes it fit. | `review` |
| `shorten_ai`             | `ai_shorten` | `after` is null: the interface offers the existing AI suggestion (only when AI is on); a person accepts it. Never staged by this route.       | `review` |
| `edit_field`             | `edit_field` | `after` is null: open the editor with the counter (an over-long text, or a required field left empty: no invented text).                       | `safe`   |

Prose (name, subtitle, titles, descriptions) is never truncated. Every `after` is checked again with `checkListing`: a fix that would leave the finding
(or empty the field) is not offered and the finding is listed in `cannot[]` (`{ locale, field, code }`: "cannot be fixed automatically"). Byte limits count
UTF-8 bytes. Repeated terms follow the check (`keywords_duplicate`): case and accents folded, English plurals folded. `stageable` is false for the App Store
name and subtitle (a draft push cannot write them): the fix still says what to change, and the interface says it cannot be staged. `afterPending` is
`null` when nothing is staged, else `{ score, issueCount, counts, resolved[] }`: the checks run on the staged values, and the ids of the findings of the
live values that they settle (the interface shows "Fix staged" on those and the counts "after pending changes").

### `POST /apps/:id/listing/fixes/stage` (`changesets.write`)

Body `{ locale, field, fixId, beforeHash? }`, nothing else (a `value` is `400`). The server computes the fixes again from the stored values and stages the
one that matches, as a typed text (`source: local`) through the same path as `PUT .../staged/text` (same limits, normalisation, item cap and rights), then
audits `listing.fix_staged` (`fixId`, counts and hashes, never the text). Returns `{ staged, fix }`. Errors: `409 fix_not_available` (the text changed, it is
already fixed, the fix is `ai_shorten` or `edit_field`, or unknown), `409 stale_fix` (`beforeHash`, the SHA-256 of the `before` the person reviewed, is not the
hash of the current text), `422 field_not_pushable`. Nothing is sent to a store. The locked-version rule (a live or in-review version) is enforced by the
interface only, like every other staging control.

## Errors

| Status | `error`                                                                 | When                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`                                                       | `history`: a bad `locale`, `field`, `limit` or `cursor`. `issues` lists them as `{ path, message }`.                                                                      |
| 401    | `unauthenticated`                                                       | No session.                                                                                                                                                               |
| 403    | `forbidden`                                                             | A member without the right.                                                                                                                                               |
| 404    | `not_found`                                                             | Not a member, or no such app in this workspace.                                                                                                                           |
| 400    | `invalid_request`                                                       | `pull`: a bad body (a locale code, more than the allowed number of items, a summary of more than one line).                                                               |
| 413    | `payload_too_large`                                                     | `pull`: a body over 64 KB.                                                                                                                                                |
| 422    | `no_repository`                                                         | `repo-refresh` or `pull` for an app that is not linked to a repository (or whose repository was disconnected).                                                            |
| 422    | `invalid_field`                                                         | `pull`: a field that the app's store does not have.                                                                                                                       |
| 422    | `no_store_listing`                                                      | `pull`: no listing was read from the store yet (or not that `channel`). `channels` lists what exists. Sync the app, or pull with `refresh`.                               |
| 422    | `target_required`                                                       | `pull`: the repository has several places this listing could be; `candidates` lists them. Send `target` or `roots`.                                                       |
| 422    | `no_target_folder`                                                      | `pull`: the chosen listing target has no folder for this store.                                                                                                           |
| 422    | `store_config_invalid`                                                  | `pull`: the Expo `store.config.json` cannot be read (`path` says which); fix it in the repository.                                                                        |
| 422    | `outside_target`                                                        | `pull`: a file would fall outside the chosen target's folders; nothing is created.                                                                                        |
| 422    | `refresh_unavailable`                                                   | `pull` with `refresh` on a server that cannot read the store.                                                                                                             |
| 403    | `forbidden`                                                             | Also: `pull` with `refresh: true` without `apps.sync`.                                                                                                                    |
| 422    | `github_auth`, `github_forbidden`, `github_not_found`, `github_invalid` | `repo-refresh` or `pull`: GitHub refused or the repository could not be read ([repositories](repositories.md)).                                                           |
| 429    | `rate_limited`                                                          | `repo-refresh` or `pull` too often (they share the repository read limit); `pull` with `refresh` also the app sync limit. `Retry-After` and `retryAfterSeconds` say when. |
| 504    | `timeout`                                                               | `repo-refresh` or `pull`: GitHub did not answer in time.                                                                                                                  |

Errors reading the **store** are not HTTP errors here: they are `store.error` in the drift response
(and `error` in `live`), with the last good values still shown. The message is one redacted sentence,
for example "The store did not answer in time while reading the listing."

## Limits and known gaps

- **No live store call has been made.** The connectors are tested against hand-written fixtures; see
  [store API conventions](../spikes/store-api-conventions.md) for what was and was not verified.
- **Which version is "live" and which is "editable"** is decided by Apple's state names. That
  `READY_FOR_DISTRIBUTION` is the one on sale, and which states are still editable, is not stated on
  Apple's pages; a version in neither list is ignored. The connector returns a warning for it, which the server stores (`warnings` in `live`) and the Listing tab shows.
- **Google Play drafts.** Whether a listing read through a new edit shows unpublished changes made in
  the console (an edit is a copy of the live state) is not documented. The Play side is treated as the
  live listing.
- **Monorepos.** The repository side uses the saved listing target whose app is this app; a repository
  with several apps and no saved target can read the wrong folder. Save a target (see
  [repositories](repositories.md)).
- **History starts at the first read.** Nothing is backfilled; the first sync records every field as
  new. A change set is recorded when the next read of drift or history finds it, with the time it was applied.
- Deleting an app deletes its listing history with it, the section rows included.
- **Sections and scheduled reads have not run against a real store.** Tested on SQLite with fakes and
  fixtures from the reference pages; the real response shapes (see UNVERIFIED above), the request
  volume of a large listing and Apple's and Google's rate limits under a schedule are untried.
- The listing routes, including `pull`, are in the OpenAPI registry (`operations/registry.ts`); `pull` needs `changesets.write` for an API token too, and its answer is described in part.
- No push or submit action toward a store exists, in the API or in the web UI. `pull` only makes a draft in the repository's change sets; applying it opens a pull request on GitHub or commits to a new branch of a local clone (opt-in).
- **`pull` has not been run against a real store, GitHub or Postgres.** It is tested on SQLite with fakes for the store and GitHub; the store snapshot it uses is the last sync (or the refresh it runs).
- A token whose scopes include only `changesets.write` can pull, because the registry names one action per operation; the session route still checks `listing.read` too.
