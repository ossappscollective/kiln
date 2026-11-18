# Spike: store API conventions (App Store Connect and Google Play, read-only)

**Question:** which calls does the read-only store connector make, what do the vendors' pages
promise about them, and what is still a guess?

**Status:** answered for the Phase 2 library slice (`packages/connectors`: `AppStoreConnectConnector`,
`GooglePlayConnector`, `verifyAppStoreConnectCredential`, `verifyGooglePlayCredential`, the two state
mappings). Pages were read on 2026-11-18. Nothing was run against a live store: this sandbox has no
network, and no store account was used.

**The fixtures are not live recordings.** `packages/connectors/src/store.fixtures.ts` is written by
hand from the response shapes on the pages below. Error bodies marked "from memory" in that file use
wording seen in community reports, not in a vendor page. The contract tests prove that the code
handles those shapes; they do not prove that the stores still send them. The first run against a real
account (see "Open questions") should replace the fixtures with recordings.

No write call exists in the code: Apple requests are all `GET`; Google requests are `POST` of an
empty edit, `GET`, and `DELETE` of that edit. There is no `commit`, no `validate`, no upload.

## App Store Connect

Base URL `https://api.appstoreconnect.apple.com`. Apple's reference pages render only with
JavaScript; the `.md` form of each page (append `.md`) was read instead. Several pages come back
as a title without a body (attribute and enum pages), which is why some items are under "not verified".

### Authentication: JWT

Page: <https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests>

Verified (quoted from the page):

- Header `alg: ES256`, `kid` = the key id, `typ: JWT`.
- Payload for team keys: `iss` (issuer id), `iat`, `exp`, `aud: appstoreconnect-v1`; `scope` optional.
  Individual keys use `sub: user` and no `iss`. The credential form has an issuer id, so only team
  keys are supported.
- "For most requests, App Store Connect rejects a token with a lifetime greater than 20 minutes";
  lifetime is `exp - iat`. Longer lifetimes (up to six months) are only accepted for a list of
  GET-only resources with a scope; none of the resources used here is on it.
- Reuse the token until it expires. The code signs one token with `iat = now - 30 s` and
  `exp = iat + 19 min`, and renews it a minute before expiry. The back-dated `iat` is our choice, to
  tolerate a clock slightly behind Apple's; Apple's page does not mention a tolerance.
- The `.p8` is a P-256 key in PKCS#8. The page says "sign the JWT" and points to JWT libraries; that
  it is P-256 follows from ES256 and from every `.p8` in practice. The code checks the curve and
  signs with `dsaEncoding: 'ieee-p1363'` (JWS wants raw `r||s`, not DER).

Not verified: what Apple does when `iat` is in the future or `exp` has passed (a `Date` header is
used to detect skew; see the error section); whether Apple tolerates some skew.

### Errors and rate limits

Pages: [About the HTTP Status Code](https://developer.apple.com/documentation/appstoreconnectapi/about-the-http-status-code),
[Parsing the Error Response Code](https://developer.apple.com/documentation/appstoreconnectapi/parsing-the-error-response-code),
[Identifying Rate Limits](https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits).

Verified:

- The status table lists 400, 403, 404, 405, 406, 409, 410, 415, 422, 429, 500. **It has no 401.**
  Its 403 text: "can happen if your API key is revoked, your token is incorrectly formatted, or if
  the requested operation is not allowed."
- `403 FORBIDDEN_ERROR`: valid method and path but "not allowed due to business rules; for example,
  because the caller's role permissions don't allow access." `404 NOT_FOUND`, `404 PATH_ERROR`.
- Error codes are hierarchical and should be matched by prefix; the body is
  `ErrorResponse {errors: [{id, status, code, title, detail, source}]}` (the field list itself is
  not on the fetched page; `code`, `status`, `id`, `title` are named in the text).
- Rate limit: every response has `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:500;` (rolling hour
  per key; "actual limits can vary"), and an excess is `429` with code `RATE_LIMIT_EXCEEDED`. **No
  `Retry-After` is documented.**

Decisions that follow:

- The code treats **both 401 and 403** as credential problems: 401 is expected in practice for a
  bad or expired token (widely reported, not on the page); `403` with a `NOT_AUTHORIZED*` code is
  "key not accepted", any other 403 is "role or revoked key".
- Clock skew: on a 401, our clock is compared with the response's `Date` header; a difference over
  30 s is reported as `clock_skew` with the size of the difference. Apple has no dedicated code for
  this; the heuristic cannot see skew if a proxy rewrites `Date`.
- 429: a `Retry-After` is honoured if sent (at most 10 s of waiting, two retries); otherwise the
  error says 60 seconds, which is a guess (the window is a rolling hour).

Not verified: the exact text of 401 and 403 bodies (the fixtures use wording from memory); whether
the 403 for a revoked key has the code `FORBIDDEN_ERROR` or `NOT_AUTHORIZED`.

### `GET /v1/apps` (verification, `listApps`)

Page: <https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps>

Verified: example response (`data[]` of `type: apps` with `attributes.name`, `bundleId`, `sku`,
`primaryLocale`, ...), `links.next` with a `cursor`, `meta.paging.total` and `limit`. Verification
calls `GET /v1/apps?limit=1` and reads `meta.paging.total` for the count of visible apps.

Verified later (see "Parameter check of the other list calls"): `limit` has a maximum of 200.

Not verified: that `App` has no platform (the example has none, so every app
is reported as `ios`; a macOS-only app would show up too).

### `GET /v1/apps/{id}/appStoreVersions` (`listVersions`)

Page: <https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-appstoreversions>

Verified: example response with `attributes.platform: "IOS"`, `versionString`,
`appStoreState: "PREPARE_FOR_SUBMISSION"`, `releaseType`, `createdDate`; relationships including
`appStoreVersionPhasedRelease`, `build`, `appStoreVersionSubmission`; `links.next`/`meta.paging`.
The example still uses the **old** field name.

**State fields (the migration).** Verified from release notes
[3.3](https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-3-3-release-notes)
and [3.7](https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-3-7-release-notes):
"The `appStoreState` attribute is now deprecated and replaced with `appVersionState`" on
`AppStoreVersion.Attributes` (and with `state` on `AppInfo`). The type pages say `AppStoreVersionState`
is available "1.2.0 - 3.7.0" and `AppVersionState` "3.3.0 -". The code reads `appVersionState`
first and falls back to `appStoreState`, and maps whichever it finds (`mapAppStoreState`).

The enum **values** are not on Apple's pages (they render as a bare type). What is known:

- `AppVersionState` has 15 values, taken from a review thread in
  [fastlane PR 21895](https://github.com/fastlane/fastlane/pull/21895): `ACCEPTED`, `DEVELOPER_REJECTED`,
  `IN_REVIEW`, `INVALID_BINARY`, `METADATA_REJECTED`, `PENDING_APPLE_RELEASE`,
  `PENDING_DEVELOPER_RELEASE`, `PREPARE_FOR_SUBMISSION`, `PROCESSING_FOR_DISTRIBUTION`,
  `READY_FOR_DISTRIBUTION`, `READY_FOR_REVIEW`, `REJECTED`, `REPLACED_WITH_NEW_VERSION`,
  `WAITING_FOR_EXPORT_COMPLIANCE`, `WAITING_FOR_REVIEW`. A secondary source, not Apple.
- The older `AppStoreVersionState` has 20 values with the retired names `READY_FOR_SALE`,
  `PROCESSING_FOR_APP_STORE`, `REMOVED_FROM_SALE`, `DEVELOPER_REMOVED_FROM_SALE`, `PENDING_CONTRACT`
  (a third-party article; the exact 20 are not confirmed. The code also lists `PREORDER_READY_FOR_SALE`
  and `NOT_APPLICABLE` from memory, as explicit "unmapped").
- Apple's 8 February 2024 release note, as quoted by that article: "Ready for Sale has been renamed to
  Ready for Distribution".

`mapAppStoreState` is table-driven (`mappings.ts`, `mappings.test.ts`). It returns `undefined` for
anything not in the table and, deliberately, for: `WAITING_FOR_EXPORT_COMPLIANCE` (needs a person),
`REPLACED_WITH_NEW_VERSION`, `REMOVED_FROM_SALE`, `DEVELOPER_REMOVED_FROM_SALE` (not an active
release), `PENDING_CONTRACT`, `ACCEPTED`, `PREORDER_READY_FOR_SALE`, `NOT_APPLICABLE` (meaning unclear).

Judgment calls in the table, to review (each is a decision, not a documented fact):

- `PREPARE_FOR_SUBMISSION` is `draft`; Apple's state does not say whether a build is attached, so
  `build_chosen` and `ready` need the build relationship (not read yet).
- `READY_FOR_REVIEW` is `ready`; `DEVELOPER_REJECTED` (submission withdrawn) is `draft`.
- `PROCESSING_FOR_DISTRIBUTION` / `PROCESSING_FOR_APP_STORE` is `rolling_out`. iOS has no
  `propagating`; the alternative is `approved`.
- `READY_FOR_DISTRIBUTION` is `live`. **A phased release keeps this state**, so it cannot be told
  from a full release by the state alone. `mapAppStoreState(raw, {phasedRelease})` turns `ACTIVE`
  into `rolling_out` and `PAUSED` into `halted`, but the connector does not read the phased release
  resource yet, and Apple's `PhasedReleaseState` page lists no values (the strings are from memory).

`filter[platform]` is documented on this endpoint (see the parameter check below); it is not used,
non-iOS versions are filtered client-side.

### `GET /v1/builds` and `GET /v1/apps/{id}/builds` (`listBuilds`)

Pages: [List builds](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds),
[List all builds of an app](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-builds),
[List prerelease versions](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-prereleaseversions).
The query parameters were read on 2026-11-18 from the JSON behind each page
(`https://developer.apple.com/tutorials/data/documentation/appstoreconnectapi/<page>.json`, the
"Query Parameters" section; the `.md` form has no parameter table). The pages were read through a
summarizing fetch tool, not downloaded, so the lists should be re-checked against the raw JSON or
Apple's OpenAPI spec (not reachable from this sandbox) when someone has network access.

**What went wrong (bug).** The connector used `GET /v1/apps/{id}/builds?limit=200&sort=-uploadedDate&include=preReleaseVersion`.
The maintainer's sync of an iOS app failed with `HTTP 400 (PARAMETER_ERROR.ILLEGAL: A given parameter
is not allowed for this request)`. The page of the **app-scoped** endpoint lists only two query
parameters, `fields[builds]` and `limit` (max 200). It has **no `sort` and no `include`**, so both were
rejected. The top-level `GET /v1/builds` does list them. The 400 body that Apple sent was not kept (the
old message dropped `errors[].source`), so which of the two Apple named first is not known; both are
undocumented for that path.

Verified (parameter lists as read from the pages above):

- `GET /v1/apps/{id}/builds`: `fields[builds]`, `limit` (max 200). Nothing else. The example response
  shows `meta.paging.limit: 50` (the default page size), `attributes.version` (the build number),
  `uploadedDate`, `expirationDate`, `expired`, `processingState: "VALID"`, `buildAudienceType`, and
  `relationships.preReleaseVersion` as a link only, with no `data`.
- `GET /v1/builds`: `filter[app]`, `filter[expired]`, `filter[id]`, `filter[preReleaseVersion]`,
  `filter[preReleaseVersion.version]`, `filter[preReleaseVersion.platform]`, `filter[processingState]`,
  `filter[version]`, `filter[usesNonExemptEncryption]`, `filter[buildAudienceType]`, ..., `include`
  (`preReleaseVersion`, `individualTesters`, `betaGroups`, `betaBuildLocalizations`,
  `appEncryptionDeclaration`, `betaAppReviewSubmission`, `app`, `buildBetaDetail`, `appStoreVersion`,
  `icons`, `buildBundles`, `buildUpload`), `limit` (max 200), `limit[individualTesters]` (max 50),
  `sort` (`version`, `-version`, `uploadedDate`, `-uploadedDate`, `preReleaseVersion`,
  `-preReleaseVersion`).
- `GET /v1/preReleaseVersions`: `filter[app]`, `filter[platform]` (`IOS`, `MAC_OS`, `TV_OS`,
  `VISION_OS`), `filter[version]`, `filter[builds...]`, `include` (`builds`, `app`), `limit` (max 200),
  `limit[builds]` (max 50), `sort` (`version`, `-version`).
- `GET /v1/builds/{id}/preReleaseVersion` takes only `fields[preReleaseVersions]`.

**Decision.** `listBuilds` now calls
`GET /v1/builds?filter[app]=<id>&include=preReleaseVersion&limit=200&sort=-uploadedDate`: every
parameter is on the page of that endpoint, and one filtered request returns the builds and their
pre-release versions (marketing version and platform) as before. If Apple still answers a 400 whose body
names a parameter (`PARAMETER_ERROR.*` or `source.parameter`), the read is repeated once with
`GET /v1/apps/<id>/builds?limit=200` (documented minimal query), and the marketing versions come from
`GET /v1/preReleaseVersions?filter[app]=<id>&include=builds&limit=200&limit[builds]=50`, matched by the
build ids in each version's `relationships.builds.data`. The result has the same shape. Limits of that
fallback: a pre-release version with more than 50 builds leaves its older builds without a
`versionString`; if that request is rejected too, the builds come back without versions and without the
macOS/tvOS filter (the platform lives on the pre-release version). A 400 that is not about a parameter
is not retried.

**Error text.** Every Apple error now keeps `errors[].code`, `title`, `detail` and `source.parameter`
or `source.pointer` (clipped, redacted like the message) in `StoreError.details`; for answers that are
not a credential problem the message lists them, e.g. `... with HTTP 400 (PARAMETER_ERROR.ILLEGAL: A
given parameter is not allowed for this request - <detail> (parameter: sort))`. The next failure of this
class names the parameter.

**Paging.** The loop follows `links.next` verbatim (after checking it stays on the API host), at most
`maxPages` (10) times, so at most 2,000 builds are read, newest first. `pageSize` defaults to and is
clamped at 200, the documented `limit` maximum of every list used here. The shape of Apple's `next` link
(a `cursor` plus the original parameters) is taken from the example on the `GET /v1/apps` page
(`links.next` with `cursor` and `limit`); that it carries `filter[app]`, `sort` and `include` unchanged
is **not verified** (the pages show no `next` link for builds). The test only proves that a link is
followed as given and that `included` data of every page is used.

Not verified (no live call was possible; the fixtures are hand-written, see the top of this page):

- `processingState` values `PROCESSING`, `FAILED`, `INVALID`, `VALID`. Only `VALID` appears in the
  examples; `filter[builds.processingState]` on the pre-release page lists exactly those four, which
  supports them. Anything else maps to `processing` and is kept in `rawProcessingState`.
- That `GET /v1/builds?filter[app]=...` accepts all of its documented parameters together as one request
  (each is documented; the combination was not run).
- That `include=builds` on `GET /v1/preReleaseVersions` fills `relationships.builds.data` (standard
  JSON:API behaviour; the page shows no example).
- The `detail` wording of the 400 (the test fixture reconstructs it; `code` and `title` are the ones
  from the real failure).

## Parameter check of the other list calls

Read from the same JSON as above, on 2026-11-18. Both calls were already within the documented
parameters; this only records it.

- `GET /v1/apps?limit=200` (`listApps`, and `limit=1` for verification): `limit` max **200**; `sort`
  (`name`, `-name`, `bundleId`, `-bundleId`, `sku`, `-sku`), `include`, `filter[bundleId|id|name|sku]`
  also exist and are not used.
- `GET /v1/apps/{id}/appStoreVersions?limit=200` (`listVersions`): `limit` max **200**; `include`,
  `filter[platform]` (`IOS`, `MAC_OS`, `TV_OS`, `VISION_OS`), `filter[appVersionState]`,
  `filter[appStoreState]` (deprecated), `filter[versionString]`, `filter[id]`. **There is no `sort`** on
  this endpoint, which is why none is sent. `filter[platform]=IOS` is documented and would drop
  non-iOS versions server-side; the code still filters on the client.

`connectors/src/appstoreconnect.test.ts` asserts that every request the connector makes (including the
fallback) uses only parameters from these lists, with `limit` at most 200 and `limit[builds]` at most 50.

## Live store listing reads (`readListing`)

Added for the listing drift view ([docs/api/listing.md](../api/listing.md)). Read on 2026-11-18 through
the same summarizing fetch tool as above (not downloaded), so the lists should be re-checked against
Apple's OpenAPI spec when someone has network access. Pages (the `.md` form of each):
[App Infos](https://developer.apple.com/documentation/appstoreconnectapi/app-infos),
[App Info Localizations](https://developer.apple.com/documentation/appstoreconnectapi/app-info-localizations),
[App Store Version Localizations](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-localizations),
and the three endpoint pages below (parameters from the JSON behind each page).

| Request | What it gives | Query parameters Apple documents | Sent |
| --- | --- | --- | --- |
| `GET /v1/apps/{id}/appStoreVersions` | version string and state, both live and editable | see above | `limit` |
| `GET /v1/apps/{id}/appInfos` | the app info(s) of the app, with their state | `fields[appInfos]`, `limit` (max **200**), `include` (`app`, `ageRatingDeclaration`, `appInfoLocalizations`, the category relationships), `fields[apps]`, `fields[appInfoLocalizations]`, `fields[appCategories]`, `fields[ageRatingDeclarations]`, `limit[appInfoLocalizations]` (max **50**). No `sort`, no `filter` | `limit` |
| `GET /v1/appInfos/{id}/appInfoLocalizations` | per locale: `name`, `subtitle`, `privacyPolicyUrl`, `privacyChoicesUrl`, `privacyPolicyText` | `fields[appInfoLocalizations]`, `fields[appInfos]`, `filter[locale]`, `include` (`appInfo`), `limit` (max **200**). No `sort` | `limit` |
| `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations` | per locale: `description`, `keywords`, `marketingUrl`, `promotionalText`, `supportUrl`, `whatsNew` | `filter[locale]`, `fields[...]` of five types, `include` (`appStoreVersion`, `appScreenshotSets`, `appPreviewSets`, `searchKeywords`), `limit` (max **200**), `limit[appScreenshotSets]`, `limit[appPreviewSets]`, `limit[searchKeywords]` (each max **50**). No `sort` | `limit` |

Verified on the pages:

- The three endpoints exist and are read-only `GET`s ("List all app infos for an app", "List all app info
  localizations for an app info", "List all app store version localizations for an app store version").
- Apple's example for `GET /v1/apps/{id}/appInfos` says: "If the app has both a "Ready for Sale" version
  and a version you're preparing for release, it will have two app infos. One represents information
  about the app currently in the App Store, and the other represents the information that takes effect
  when you release the next version. Use the `appStoreState` attribute to differentiate them." That is
  why a listing read needs both app infos, and why the code keeps the live and the editable one apart.
- `AppInfo` carries `state`; `appStoreState` is its deprecated predecessor (the parameter lists name both;
  release notes 3.3 and 3.7 above). The code reads `state` first, then `appStoreState`.
- The version localization attributes are the ones the page lists (locale, description, keywords,
  marketing URL, promotional text, support URL, what's new). Promotional text "can be updated at any
  time"; the others only "when your app is in an editable state".
- Every request the connector sends uses only parameters from these lists (`limit`, at most 200).
  `connectors/src/store-listing.test.ts` asserts it for each of the four paths, plus no `sort`, no
  `include`, and that a `pageSize` above 200 is clamped.
- A rejected parameter surfaces Apple's `source.parameter` (and `source.pointer`) in `StoreError.details`,
  as for builds.

Not verified:

- **Which states mean "live" and "editable".** The names are Apple's, but the pages do not say which
  `AppVersionState` or `AppInfo.State` values are the one on sale and which a person can still edit.
  `READY_FOR_DISTRIBUTION` and `READY_FOR_SALE` are treated as live; `PREPARE_FOR_SUBMISSION`,
  `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`, `WAITING_FOR_REVIEW`,
  `READY_FOR_REVIEW` as editable. A version in neither set is ignored. The sets come from the state names and
  fastlane's `AppStoreVersion` model (a secondary source), not from a response. Versions in review
  (`IN_REVIEW`) or waiting to be released are in neither set.
- **Whether a second app info always exists** when a new version is being prepared, and what
  `appStoreState` and `state` say on each; the fixtures follow Apple's example only.
- **Empty versus absent.** Whether an attribute Apple has no value for comes back as `null`, as `""` or not
  at all. The code treats `null` and absent as "no value" and keeps `""` as an empty value.
- **`links.next`** keeps `limit` and every other parameter on these three endpoints (assumed, as for builds).
- **Not read:** categories (relationships of the app info; they would need `include` or the related
  endpoints), `privacyChoicesUrl`, age ratings, screenshots, previews and search keywords. The core listing
  model has no field for them.
- **Which locales a version has** when only some were localized for a new version; the code reports what
  the endpoint returns and does not copy a missing locale from the live version.

## Google Play Developer API

Base URL `https://androidpublisher.googleapis.com/androidpublisher/v3`; scope
`https://www.googleapis.com/auth/androidpublisher` for every method below.

### Authentication: service account JWT bearer

Page: <https://developers.google.com/identity/protocols/oauth2/service-account>

Verified: header `alg: RS256` (mandatory, only value), `typ: JWT`, optional `kid`; claims `iss` (service
account email), `scope`, `aud` (`https://oauth2.googleapis.com/token`), `exp`, `iat`; `exp` at most one
hour after `iat`; `POST` to the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
and `assertion`; response `access_token`, `token_type: Bearer`, `expires_in` (3600 in the example);
tokens can be reused for `expires_in`. `invalid_grant` descriptions that the code classifies:

- "Invalid JWT Signature." (key deleted, disabled or expired, or not this account's key);
- "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe." (the
  page says: usually a wrong system clock, or `exp` more than 65 minutes after `iat`);
- "Not a valid email" / "Invalid email or User ID" (unknown account).

The code signs with `exp = iat + 55 min` and renews a minute before `expires_in`. Clock skew is quantified
from the token response's `Date` header; Google's token endpoint is assumed to send one.

Not verified: other `invalid_grant` descriptions (the catch-all message says "may be disabled or deleted,
or the clock may be wrong"); whether `invalid_client` or `unauthorized_client` ever occur for this grant.

### What can be proven without an app (`verifyGooglePlayCredential`)

Page: <https://developers.google.com/android-publisher/api-ref/rest> (resource list).

Verified: **no method lists apps for a developer account**; `applications` only has `dataSafety`.
Everything per app needs a package name. So there are three levels, and the result message says which
one was reached:

1. Token exchange succeeds: the key is valid and the clock is right. Any service account of any
   project gets this token, so it says nothing about Play.
2. Without a package name, one `edits.insert` for `com.example.mrm.credentialcheck` (a `com.example`
   package cannot be a real Play app, so nothing is created or touched). If the API is enabled and the
   token is accepted, Google answers 403 or 404 for it, and the code reports "API reachable, access to
   apps **not proven**". A 403 "API not enabled", a 401 or `projectNotLinked` is a failure.
   *This level relies on error shapes that are not on a vendor page; see below.*
3. With a package name (`options.packageName`), `edits.insert` then `edits.delete` for that app. Success
   proves the key, the API and that the account may open an edit for that app (it was invited).

Not provable from the API: which apps the account can see; its Play Console permissions (the message
says so).

### `edits` (insert, delete) and the one-edit rule

Pages: [edits](https://developers.google.com/android-publisher/api-ref/rest/v3/edits),
[edits.insert](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/insert),
[edits.delete](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/delete),
[Edits guide](https://developers.google.com/android-publisher/edits).

Verified: `POST .../applications/{packageName}/edits` returns an `AppEdit` with `id` and
`expiryTimeSeconds`; `DELETE .../edits/{editId}` returns an empty object. From the guide: a new edit is
"a copy of the current deployed state"; changes "can take several hours to take effect" after commit;
"Each user may have only a single edit open at a time"; "If you create a new edit, any existing edit you
may have open is invalidated"; a commit or a Play Console change "invalidates all other edits for the
app (owned by any user)"; committing an invalid edit throws. The guide states no expiry time (the
`expiryTimeSeconds` field exists, its length is unknown). The API "only works on existing apps with at
least one APK uploaded".

Consequences in the code (comments in `googleplay.ts`):

- Reads are serialized per service account inside the process (`withEdit`), because a concurrent read
  would invalidate the other's edit. Across processes, or with a future writer using the same service
  account, that is not enforced: a read here can invalidate an edit someone else is preparing.
  **Decision for the user:** give the read-only connector a service account of its own.
- A read invalidated by a Console change is retried once with a new edit.
- The edit is always deleted afterwards (best effort), and never committed.

### `edits.tracks.list`, `edits.bundles.list`, `edits.apks.list`, `edits.details.get`, `edits.listings.list`

Pages: [tracks](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks),
[tracks.list](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/list),
[bundles](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles),
[apks](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.apks),
[details](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.details),
[listings](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings).

Verified:

- `tracks.list` returns `{kind, tracks[]}`, "all tracks (including tracks with no releases)". `Track` has
  `track` (e.g. `wear:production` for form factors) and `releases[]` ("in a read request, all active
  releases in the track"). `Release` has `name`, `versionCodes[]` (int64 as strings), `status`,
  `userFraction`, `releaseNotes`, `countryTargeting`, `inAppUpdatePriority`.
- `status`: `statusUnspecified`, `draft` ("APKs are not served to users"), `inProgress` ("served to a
  fraction of users set by `userFraction`"), `halted` ("stop being served, users who already have them are
  unaffected"), `completed` ("no further changes; APKs go to all users, except those eligible for a newer
  release").
- `userFraction`: "Fraction of users who are eligible for a staged release", 0 < fraction < 1, "can only be
  set when status is `inProgress` or `halted`".
- `bundles.list` / `apks.list` return `{kind, bundles[]}` / `{kind, apks[]}`; `Bundle.versionCode`,
  `sha1`, `sha256`; `Apk.versionCode`, `binary.{sha1, sha256}`.
- `details.get` returns `defaultLanguage`, `contactWebsite`, `contactEmail`, `contactPhone`. The app title
  is **not** in details; it is `Listing.title` in `listings.list` (`{kind, listings[]}`, per language).
  `listApps` takes the title of the default-language listing, else the first one, else the package name.
- No pagination parameters are documented for these list calls; the code does not paginate.
- **Listing read (`readListing`).** The listing drift view calls `edits.listings.list` through the same
  serialized `withEdit` as every other read: insert an edit, `GET .../edits/{editId}/listings`, delete the
  edit. It never commits or validates. The Listing resource is `language` (a BCP-47 tag such as "de-AT"),
  `title`, `fullDescription`, `shortDescription` and `video` (a YouTube URL); the page lists methods
  `delete`, `deleteall`, `get`, `list`, `patch`, `update`, and states no field limits and nothing about
  committing (read 2026-11-18). They are mapped to `title`, `full_description`, `short_description`,
  `video` per locale. Not verified: whether an edit shows listing changes that are saved in the Console
  but not yet published (the edit is documented as a copy of the live state), and the language-tag casing
  Play returns (kept as returned).

`mapPlayTrackRelease` (`mappings.ts`): `draft` is `draft`; `inProgress` is `rolling_out` with the fraction;
`halted` is `halted` with the fraction; `completed` is `live`; anything else (including
`statusUnspecified`) is `undefined`. Fractions outside (0, 1] are dropped, not clamped.

Not verified / limits of the mapping:

- **`userFraction` semantics.** The page says what it is, not whether Play reports the *current* rollout
  percentage (the number a person set in the Console) or something coarser, nor how a halted release keeps
  it. It is passed through unchanged as 0 to 1; the UI should show it as "eligible users", not "installed".
- **Review is not visible in the edits API.** A `draft` release may be unsent, in review or approved, and
  `completed` cannot be told from "in review of an update". So a track read never yields `in_review`,
  `rejected`, `approved` or `propagating`. Another endpoint exists and was found while reading the index:
  `GET /applications/{package}/tracks/{track}/releases` ([page](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list)).
  It needs no edit (which removes the edit-invalidation problem for reads) and returns
  `releaseLifecycleState` (`DRAFT`, `NOT_SENT_FOR_REVIEW`, `IN_REVIEW`, `APPROVED_NOT_PUBLISHED`,
  `NOT_APPROVED`, `PUBLISHED`), `releaseName` and `activeArtifacts[].versionCode`, max 20 releases, no
  `userFraction`. It is **not used yet**; see open questions.
- Whether `bundles.list` / `apks.list` return everything ever uploaded or only what the edit (a copy of
  the live state) still holds. The code reports what it gets and sorts by version code.
- Version strings: the tracks API has no `versionName`; `Release.name` is "derived from the APK's
  versionName" if unset, so `versionString` is the release name, else the version codes.

### Errors and rate limits

Pages: [AIP-193](https://google.aip.dev/193) (error model),
[Quotas](https://developers.google.com/android-publisher/quotas).

Verified: error body shape `{error: {code, message, status, details[]}}` with `ErrorInfo.reason` and
`domain`; the default quota is "3000 queries per minute for each bucket". The Quotas page does **not**
say what an over-quota response looks like (no 429, no `Retry-After` mentioned).

From community reports only (not on a vendor page; the fixtures are marked "from memory"):

- API not enabled: 403 `PERMISSION_DENIED`, message "Google Play Android Developer API has not been used
  in project N before or it is disabled" (the code matches that text, `SERVICE_DISABLED` and
  `accessNotConfigured`).
- No permission: 403, reason `forbidden`, "The caller does not have permission".
- Package missing or invisible: 404, reason `notFound`, "Package not found: ...".
- `projectNotLinked`: 403, "The project id used to call the Google Play Developer API has not been
  linked in the Google Play Developer Console." This is an old requirement and may no longer occur.
- An edit that was invalidated mid-read: assumed to be 404 with a message that mentions the edit. **This
  is a guess** and the retry relies on it.
- Quota: a 429 or a 403 with reason `rateLimitExceeded` / `quotaExceeded`; `Retry-After` honoured if
  present, otherwise 60 s is reported.

The getting-started page also says: create a Cloud project, enable the API, create a service account,
invite it under Users and permissions in Play Console. It gives **no timing** for how long an invitation
takes to work, so the message says "wait and try again" without a number.

## Open questions

1. **Live run.** Run both verifiers and each list call against a real App Store Connect team key and a real
   service account, record the responses, and replace the fixtures. Most "from memory" items above settle
   in one run: Apple's 401 vs 403 split for a wrong key, the build `processingState` and `include` behaviour,
   the Play error bodies for a disabled API, a missing package and an invalidated edit.
2. **Which Play read path?** Edits give `userFraction` but no review state and cost an exclusive edit; the
   `tracks/{track}/releases` endpoint gives review state and no edit but no `userFraction`. Likely answer:
   use both (the second for state, the first only when a rollout fraction is needed). Not built.
3. **Separate service account for reads** (see the one-edit rule). Needs a decision before a writer exists.
4. **Phased release on iOS.** `appStoreVersionPhasedRelease` is a relationship of the version; reading its
   `phasedReleaseState` is needed to tell `rolling_out` from `live`. The state strings are unverified.
5. **The three Apple judgment calls** (processing is `rolling_out`, `DEVELOPER_REJECTED` is `draft`, export
   compliance unmapped) and what the dashboard should show for an unmapped state.
6. **Platforms.** App Store Connect apps and versions can be macOS, tvOS or visionOS; `Platform` is only
   `ios | android`, so non-iOS versions and builds are skipped. Is that right for the product?
7. **Apple `limit` maximum**: 200 is documented for every list used here (verified 2026-11-18). A live run should still confirm that a `next` link for `GET /v1/builds` keeps `filter[app]`, `sort` and `include`.
8. **Live listing read.** Run `readListing` against a real app that has a live version and a version in
   preparation, and a real Play package, and replace the hand-written listing fixtures
   (`connectors/src/store-listing.fixtures.ts`). That settles the live and editable state sets, the second
   app info, and whether `null` or `""` marks an empty field.
