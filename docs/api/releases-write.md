# Releases: edit a draft release and release it (store writes, off by default)

What a person needs to get a version out, from the app: pick the build or the version codes, edit the fields of the
**draft** release, preview before and after, push them as a draft, and then **release** (the one step that cannot be
taken back). Design and the arguments: [ADR 0014](../adr/0014-release-management.md).

There are three parts, each with its own gate:

| Part | What it does | Gate |
| --- | --- | --- |
| [Reads](#reads-what-a-draft-is-made-of) | Lists processed builds / uploaded version codes, and shows the release fields the store holds. | `listing.read`. No switch: they change nothing. |
| [Staging and the draft push](#staging-and-pushing-release-fields) | Release fields are staged items; the existing draft push writes them. | `changesets.write` to stage; `store.push_draft` and `MRM_STORE_DRAFT_WRITE_ENABLED` to push. Never submits, never releases. |
| [Release](#release-irreversible) | Releases an approved App Store version, or starts a Google Play draft release at a share you name. | `store.release` and `MRM_STORE_RELEASE_ENABLED`, a preview, a hash and a typed phrase. |

**Never run against a real store**: the connectors are tested with fakes only. Read [UNVERIFIED](#unverified-check-with-a-real-account)
before turning anything on.

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right gets 403.

## Reads: what a draft is made of

The reads (`candidates`, `editable` and `notes-history`) use the credential of the app (audited as `credential.use`,
purpose `store.release_read`), change nothing, and are rate limited per workspace (`429`, `Retry-After`).

### `GET /apps/{id}/release/candidates?track=&version=`

Needs `listing.read`. Returns `{ candidates }`:

- **App Store (iOS and macOS)**: `{ store: "appstoreconnect", platform, version, builds[], attachedBuildId, truncatedAt }`.
  `version` is the editable version a build would be attached to (or `null`). Each build: `id`, `buildNumber`, `version`
  (marketing version), `uploadedDate`, `processingState`, `expired`, `selectable` (processed and not expired), `reason`
  (why not), `attached`. A macOS app lists the macOS builds only. `?version=2.4.0` narrows the list. The `id` is what you
  stage as the `build` field. Also, per build: `eligibility`, `exportCompliance` and `testNotes` (below).
- **Google Play**: `track` is required (`422 track_required`). `{ store: "googleplay", platform: "android", track, codes[] }`;
  each code: `versionCode`, `source` (`bundle` or `apk`), `sha256`, `inTrack[] { name, status }` (the releases of that track
  that already hold it) and `eligibility`.

**Is this build eligible?** Every build and every code has `eligibility: { eligible, severity, code, message }`: `eligible`
says whether it can be chosen for the draft now, `severity` is `ok`, `warning` (it can be chosen, read the message) or `blocked`,
`code` is a machine reason and `message` a plain sentence built from build numbers, versions and states only. Codes:

| `code` | `severity` | Meaning |
| --- | --- | --- |
| `ok` | `ok` | Processed, not expired, belongs to the version being prepared (Google Play: not in a release of the track yet). |
| `processing` | `blocked` | Apple is still processing the build. |
| `failed`, `invalid` | `blocked` | Apple could not process it / marked it invalid: upload a new build. |
| `state_unknown` | `blocked` | Apple did not say, or said a state this server does not know. |
| `expired` | `blocked` | The build expired. Wins over the processing state. |
| `wrong_version` | `blocked` | The build belongs to another marketing version than the one being prepared. |
| `no_editable_version` | `blocked` | The build is processed but no version is in "Prepare for Submission". |
| `already_attached` | `ok` (`eligible` false) | It is the build of the version already. |
| `export_compliance_missing` | `warning` | Apple holds no export compliance answer for it; it can be chosen, App Store Connect may ask later. |
| `already_in_draft` | `ok` (`eligible` false) | Google Play: the draft release of the track holds the code already. |
| `already_live` | `blocked` | Google Play: a release of the track that is live or rolling out holds the code. |

New codes may be added: a client should fall back to `severity`. `selectable` and `reason` stay for older clients and ignore
the version.

**TestFlight notes.** Each App Store build has `testNotes: { read, locales[] { locale, text, truncated }, error? }`, the "What to
Test" text TestFlight shows testers. It is read for the **newest eight processed, unexpired builds** only (four requests at a
time); for the others `read` is `false` with no `error`. A build whose notes cannot be read has `read: false` and `error`
(`forbidden`, `rate_limited`, `not_found`, `unavailable`) and never hides the other builds. Each text is cut at 4000 characters
(`truncated`), a build keeps at most 40 languages, and empty texts are left out. **The notes are shown to the caller only: they
are never logged, never audited and never in an event.** `exportCompliance` is `answered`, `missing` or `unknown` (Apple did not
return the attribute; the read is repeated without the field when Apple rejects it).

### `GET /apps/{id}/release/editable?track=`

Needs `listing.read`. Returns `{ editable }`:

- **App Store**: `version { id, versionString, state, editable: true }`, `releaseType`, `earliestReleaseDate`, `copyright`,
  `build`, `phasedRelease` (`null` means the version has none, so it is off), `releaseNotes[] { locale, text }` (the
  "what's new" of each locale). `422 no_editable_version` when there is no editable version.
- **Google Play**: `track` required. `draft { name, status, userFraction, versionCodes[], notes[] { locale, text } } | null` and
  `others[]` (the other releases of the track, read only).

### `GET /apps/{id}/release/notes-history?platform=&locale=&limit=`

Needs `listing.read`. The "what is new" texts earlier releases used, to reuse in the next one. `platform` (optional) must be
the platform of the app (`422 platform_mismatch`); `locale` narrows to one language (`en-US`; `de_DE` works too); `limit` is 1 to
100 (default 30). Returns `{ history: { app, locale, notes[], truncated, limit, store, generatedAt } }`:

- `notes[]` is **deduplicated by text** (line ends and surrounding space do not count): `{ text, truncated, locales[],
  lastUsedAt, uses[] }`, newest first by `lastUsedAt`; a text with no date follows the dated ones in the store's order. `uses[]`
  (newest first, at most 10) says where each was used: `{ source, locale, version, track, state, at }` with `source`
  `appstoreconnect`, `googleplay` or `plan` (a release note of a [release plan](plans.md) of this app).
- **App Store**: the notes of the newest twelve versions of the platform (`version` is the marketing version, `state` Apple's
  version state, `at` the creation date of the version). `store.truncated` says more versions exist; `store.failed` counts versions
  whose notes could not be read.
- **Google Play**: only the releases the tracks hold **now** (`edits.tracks.list`; Google lists no replaced release), so this is a
  short history. `version` is the release name, `track` the track, `state` the release status, and `at` is `null`: Google gives no date.
- The store read is **cached in memory for ten minutes** per app and language (`store.cached`); only a read that reaches the
  store counts against the rate limit. When the store cannot be read the answer is still `200` with the plans' notes and
  `store: { read: false, error }` (`error` is a code such as `store_forbidden`, `credential_unreadable`, `timeout` or
  `rate_limited`, the last with a `Retry-After` header). Responses are `Cache-Control: no-store`.
- Texts are cut at 4000 characters. **They are never logged, never audited and never in an event.**

## Staging and pushing release fields

Release fields are staged like a listing text: nothing reaches a store by staging. They are a third kind of staged item
(`kind: "release_field"`) next to `listing_text` and `asset`, and the existing **draft push**
([staged-changes](staged-changes.md)) writes them together with the texts and graphics.

### `PUT /apps/{id}/staged/release-fields`

Needs `changesets.write`. Body `{ field, locale?, value }`; one field per request. Returns `{ staged }` (the whole staged view,
which now has `release[]`, `totals.release` and `pushable.releaseFields`). The value is normalized so what is previewed is
what is pushed, and checked on its own. An empty value is refused (`422 empty_value`: this server does not clear a store field;
remove the item instead).

| Platform | `field` | Value (canonical form) |
| --- | --- | --- |
| App Store, macOS | `build` | The id of a processed build from `release/candidates`. |
| | `version_string` | Marketing version: numbers separated by dots, up to three parts (`2.4.0`). |
| | `release_type` | `MANUAL`, `AFTER_APPROVAL` or `SCHEDULED` (upper cased). |
| | `earliest_release_date` | A future ISO 8601 date and time, normalized to UTC (`2026-12-01T10:00:00Z`). |
| | `copyright` | Text (`2026 Acme Inc.`). |
| | `phased_release` | `on` or `off` (a boolean is accepted). |
| | *what's new* | **Not here**: it is the existing listing field `release_notes` (`PUT .../staged/text`), per locale. |
| Google Play | `track` | The track of the draft release (`production`, `beta`, ...). **Required** when anything else of the release is staged. |
| | `release_name` | A name only you see. |
| | `version_codes` | Unique, ascending, comma separated (`240,241`); an array or `240, 241` is accepted. |
| | `release_notes` | Per language: send `locale` (`en-US`). |
| | `user_fraction` | The **intended** share (`0.1` or `10%`). **Kept here only**: Google cannot hold a share in a draft, so it is never written to the store. The release step needs an explicit share of its own. |

Errors: `422 field_not_stageable` (not a field of this platform), `422 invalid_locale`, `422 empty_value`,
`422 invalid_staged` (with the first error `code`), `422 too_many_items`, `400 invalid_request`.

Staged problems (in `release[].problems`): errors block a push (`422 staged_invalid`), warnings do not. Errors:
`invalid_version_string`, `invalid_release_type`, `invalid_date`, `date_in_past`, `invalid_phased_release`, `invalid_build`,
`invalid_track`, `invalid_version_codes`, `too_many_version_codes`, `invalid_user_fraction`, `track_required`,
`too_many_languages`. Warnings: `too_long` for limits **no official page states** (Play release notes 500 characters,
release name 50, copyright 200, version 18: UNVERIFIED, so only warnings), `submit_needs_manual` (a release type other than
`MANUAL` keeps [submit](submit.md) blocked), `scheduled_needs_date`, `date_without_schedule`.

Audit: `staged.release_field_set` (`appId, platform, field, locale?, valueHash, chars`): a hash, never the value.
Remove an item with `DELETE .../staged/items?id=<id>` (the `id` of `release[]`), or clear everything.

### The push (`POST .../staged/push/preview` and `.../staged/push`)

Same routes, same switch (`MRM_STORE_DRAFT_WRITE_ENABLED`), same confirm hash, same re-read right before the first write. Added:

- Preview `release[] { id, field, label, locale, before, after, status, localOnly }`: the store's value now and the staged one, in
  the same canonical text. `status`: `changed`, `unchanged`, or `local` (the intended Play share).
- Preview `checks { blocking[], warnings[], canPush }`: what the store says about the staged fields (from facts read next to
  each field). **Blocking** (a push is refused with `409 blocked`, `checks`, nothing written): `build_not_found`,
  `build_expired`, `build_not_processed`, `version_codes_not_uploaded`, `no_draft_release`, `field_unreadable`,
  `release_fields_unreadable`. **Warnings**: `new_draft_release`, `rollout_in_progress`, `scheduled_needs_date`.
- Preview `summary` has `fieldsChanged` and `fieldsUnchanged`; `nothingToDo` counts fields.
- Result `fields` (how many release fields were part of the push) and steps with `type: "field"`.
- Audit `listing.draft_pushed` and the event `listing.draft_pushed` carry `fields` (a count).
- A pushed field is marked `pushed` in the staged view (`user_fraction` never is).

How the fields are written:

- **App Store**: one `PATCH` of the editable version for the version string, release type, earliest release date, copyright and
  build; the phased release is switched on (`POST`) or off (`DELETE`) in its own request. Only what differs from the store is
  sent. The version must be editable (`422 no_editable_version`). A refusal part way is `502 draft_partial`.
- **Google Play**: the draft release of the track is rewritten in the same edit as the texts and images (every other release as
  read), committed with `changesNotSentForReview=true`. Two drafts in one track are refused (`422 store_rejected`): this server
  will not guess which one.

A lost answer is read back, fields included (`confirmedByReread`, `502 write_failed`, `409 draft_partial`,
`409 outcome_unknown`), as for texts. The push record for [submit](submit.md) holds texts and graphics only: release
fields are not part of what submit checks.

## Release (irreversible)

Makes an approved App Store version available, or starts a Google Play draft release at a share of users you name.
**It cannot be taken back from this server.** It never edits a draft, never submits, never creates a version.

### Switch and right

| Setting | Value |
| --- | --- |
| `MRM_STORE_RELEASE_ENABLED` | Default `false`; only `true` and `false`; blank is off. **Independent of** the draft and submit switches. See [deployment](../deployment.md#releasing-a-store-write-off-by-default). |
| `store.release` | **admin and up** (owner, admin). **Explicit-only on API tokens**: the token's `actions` must name it (a token with no list never gets it) and the role ceiling still applies. Neither `store.push_draft` nor `store.submit` implies it. |

While the switch is off, preview and release answer `409 store_release_disabled` after the rights check and no connector is
built; the config and state routes still work.

### The flow

1. `POST .../store-release/preview`: reads the store, shows what would be released, to whom, the checks, and gives a
   `confirmHash` and the **phrase to type**. Writes nothing; a successful read also settles an unknown outcome.
2. `POST .../store-release` with `confirmHash`, `confirmation` (the typed phrase) and the **same request fields**. The store is
   read again right before the write; if it is not what was previewed nothing is written.

### Request fields (preview and release)

- **App Store**: `version` (optional, the marketing version; required when more than one version waits for release). macOS is the
  macOS version of the same App Store Connect app. `track`, `versionCodes` and `userFraction` are `422 not_applicable`.
- **Google Play**: `track` (required, `422 track_required`), `userFraction` (required and **never implied**, more than 0 and at
  most 1, at most 4 decimals: `422 user_fraction_required`, `422 invalid_user_fraction`), `versionCodes` (optional: picks the
  draft release when the track holds several). `version` is `422 not_applicable`. A share of `1` completes the release (100%).

### `GET /store-release/config`

Needs `apps.read`. `{ enabled, envName, action: "store.release", minimumRole: "admin", irreversible: true, note }`.

### `GET /apps/{id}/store-release`

Needs `store.release`. **Reads the database only**, works with the switch off. `{ release: { enabled, inFlight { release, push,
submit }, unknownOutcome { release, push, submit } } }`.

### `POST /apps/{id}/store-release/preview`

Needs `store.release` and the switch. Returns `{ preview }`:

- `request`: what was asked (the share is the one named).
- `version`, `build`, `phasedRelease`: App Store, from the store. `track`, `release`, `others`: Google Play.
- `audience { kind: "all" | "phased" | "percent", userFraction, description }`.
- `irreversible[]`: what cannot be undone, in words, for the dialog.
- `releases: true`.
- `checks { blocking[], warnings[], canRelease }`. **Blocking**: `not_releasable` (no version in Pending Developer Release; the
  message lists the states of the platform's versions), `ambiguous_version`, `no_draft_release`, `ambiguous_release`,
  `not_a_draft`, `no_version_codes`, `version_codes_not_uploaded`, `rollout_in_progress` (Google Play: another release of the
  track is already rolling out; this server does not start a second one beside it), `push_in_progress`,
  `push_outcome_unknown`, `submit_in_progress`, `submit_outcome_unknown`. **Warnings**: `unpushed_release_fields` (staged fields
  that are not in the store's draft: a release releases what the store holds), `fraction_differs_from_staged`, `full_rollout`,
  `no_release_notes`, `halted_release`, `release_type_not_manual`, `build_expired`, `no_build_read`,
  `play_review_state_unknown`.
- `confirmHash` and `confirmation { phrase, instruction }`: **null while anything blocks**. The phrase is
  `release <identifier> <version>` (App Store) or `release <identifier> <track> <percent>%` (Google Play), so a typed phrase
  cannot be for another release or another share.

### `POST /apps/{id}/store-release`

Needs `store.release` and the switch. Body: the request fields, `confirmHash`, `confirmation`. Returns `{ result }`
(`released: true`, `via: "release_request" | "edit_commit"`, `releaseRequestId`, `audience`, `confirmedByReread`,
`releasedAt`, `note`).

Refusals, all **before anything is written**: `422 confirmation_mismatch` (with `phrase`), `409 state_changed` (with a new
`preview`), `409 blocked` (with `checks`), `409 write_in_progress`, `409 push_outcome_unknown`, `409 submit_outcome_unknown`,
`409 outcome_unknown` (an earlier release of this app whose outcome is unknown: preview again).

How it is written:

- **App Store**: `POST /v1/appStoreVersionReleaseRequests` for the version in `PENDING_DEVELOPER_RELEASE`. Apple: "Send this request
  only when you're ready to publish your version. You can't cancel this request."
- **Google Play**: one edit that rewrites the track: the draft release gets `status: inProgress` with `userFraction` (or
  `completed`, no fraction, for 1), every other release as read, committed **without** `changesNotSentForReview` and with
  `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (`409 changes_in_review` when changes are in review: a review in progress is
  never cancelled).

One release per app and platform at a time (`store_release_claims`); a draft push or a submit in flight blocks it. **Never
retried.** After a timeout or a 5xx the store is read back:

- App Store: the version is no longer waiting: `200`, `confirmedByReread: true` (`releaseRequestId` is `null`). Still waiting:
  `502 write_failed` (`outcome: not_applied`). Unreadable or unclear: `409 outcome_unknown`.
- Google Play: a release with the same version codes is `inProgress` or `completed`: `200`, `confirmedByReread: true`. Otherwise
  `409 outcome_unknown` (a commit can be slow to show, so the old draft is not proof).

`outcome_unknown` blocks releasing this app until a **preview** has read the store successfully.

### Audit and events

Audit: `store.released` (`appId, store, platform, versionId | track + versionCodes, userFraction?, releaseRequestId?, via,
confirmedByReread, hash`), `store.release_failed` (`code`, `outcome`: `refused`, `failed` or `unknown`, ids and the hash) and
`credential.use` with purpose `store.release`. Event: [`release.started`](events.md) (`appId, store, platform,
versionString? | track + versionCodes, userFraction?, via, confirmedByReread, actor`). Never a text, a credential, a token or a
store response body.

## UNVERIFIED (check with a real account)

Read on Apple's and Google's pages on 2026-11-19.

**Verified**: Apple's `POST /v1/appStoreVersionReleaseRequests` exists, "Manually release an app store approved version of your
app", with "When you submit your app for review, if it's approved and the status changes to Pending Developer Release, then you can
release a version" and "You can't cancel this request"; Google's `Release` (`name`, `versionCodes[]`, `releaseNotes[]`, `status`:
`draft`, `inProgress`, `halted`, `completed`; `userFraction`: "0 < fraction < 1 ... can only be set when status is inProgress or
halted"), `edits.tracks.get` / `update`, `edits.bundles.list`, `edits.apks.list`, and `edits.commit` with
`changesNotSentForReview` and `changesInReviewBehavior`.

**Not verified** (Apple's pages for these resources are nearly empty; nothing was run):

- Eligibility, TestFlight notes and the notes history (Apple): the resource `betaBuildLocalizations` and `GET
  /v1/builds/{id}/betaBuildLocalizations` exist on Apple's pages, but its attributes `locale` and `whatsNew`, the `fields[...]`
  filter and any length limit are UNVERIFIED (this server cuts at 4000 characters itself); the build attribute
  `usesNonExemptEncryption` (export compliance) and whether it can be requested in `fields[builds]`; the `createdDate` attribute of
  a version (the date and order of the history; without it the order is the version string, newest first, and `at` is `null`);
  that a build must belong to the marketing version it is attached to (`wrong_version`); that Apple lists `appStoreVersions` of
  every state (the history reads the newest twelve of this platform); the processing state names.
- Eligibility, notes history (Google Play): VERIFIED on Google's page, `Track` holds `releases[]` and `edits.tracks.list` shows the
  active releases, so replaced releases are not in the history; Google gives no upload time and no release date, so `at` is `null`.

- App Store: the body of the release request (`relationships.appStoreVersion`, modelled on Apple's other resources) and its
  success status; that the API name of "Pending Developer Release" is `PENDING_DEVELOPER_RELEASE`; the version attributes
  `versionString`, `releaseType` (`MANUAL`, `AFTER_APPROVAL`, `SCHEDULED`), `earliestReleaseDate`, `copyright`, `appVersionState`;
  that the version update accepts `relationships.build`; the build attributes and processing states (`version`,
  `processingState`, `expired`, `uploadedDate`) and the builds filters and sort; the phased release resource and its attribute
  `phasedReleaseState`; how Apple treats an existing phased release when a release request is made (the preview says what Apple's
  help page says); which key role may release (App Manager or Admin is assumed); the limits of the version string and the
  copyright.
- Google Play: whether `tracks.update` replaces all the releases of a track (this server sends every other release back as read);
  whether a track may hold more than one draft release (refused here); whether a draft release can be started through the API at
  all or only in Play Console; whether a commit without `changesNotSentForReview` of an edit that changes a track sends the
  release at once or leaves it in review (the API shows no review state); whether tracks other than `production` accept
  `userFraction`; the version code and bundle fields of `edits.apks.list`; the limits of release notes (500 characters a language)
  and the release name (50).
