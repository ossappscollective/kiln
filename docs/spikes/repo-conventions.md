# Spike: repository and listing conventions

**Question:** what do fastlane and Expo projects look like on disk, which store limits apply to a
listing, and how does GitHub behave for the calls the repo connector makes?

**Status:** answered for the first Phase 1 slice. Pages were read on 2026-11-18. Anything in the
last section is not confirmed by a page and the code treats it as a guess (a warning, not an
error, or an option).

## What was verified, with the page

### fastlane deliver (App Store)

Source: [deliver docs](https://docs.fastlane.tools/actions/deliver/) and
[`upload_metadata.rb`](https://github.com/fastlane/fastlane/blob/master/deliver/lib/deliver/upload_metadata.rb).

- Default folder is `./fastlane/metadata` (`./metadata` without fastlane).
- Per locale, `<metadata>/<locale>/<key>.txt` with keys `name`, `subtitle`, `description`,
  `keywords`, `promotional_text`, `release_notes`, `support_url`, `marketing_url`, `privacy_url`,
  `apple_tv_privacy_policy`.
- Not localized, directly in `<metadata>/`: `copyright.txt`, `primary_category.txt`,
  `secondary_category.txt` and the four `*_sub_category.txt` files.
- Folders that are not locales: `review_information/` (`first_name`, `last_name`, `phone_number`,
  `email_address`, `demo_user`, `demo_password`, `notes`, plus deprecated `review_*` names),
  `trade_representative_contact_information/`, `app_clip_review_information/`.
- A `default/` folder holds fallback values. In the source, `assign_defaults` copies them into
  every language that has no value for that key. The code uses it for every localized key; the
  docs list `keywords`, `marketing_url`, `name`, `privacy_url`, `support_url`, `release_notes`.
- Screenshots are `./fastlane/screenshots/<locale>/...`; the device type is detected from the image
  size. Not parsed in this slice.
- Reading: `File.read(path)` with no strip. Each value gets `.to_s.strip` when uploading. So a
  trailing newline is harmless to deliver.

### fastlane supply (Google Play)

Source: [supply docs](https://docs.fastlane.tools/actions/supply/),
[`supply.rb`](https://github.com/fastlane/fastlane/blob/master/supply/lib/supply.rb),
[`options.rb`](https://github.com/fastlane/fastlane/blob/master/supply/lib/supply/options.rb),
[`uploader.rb`](https://github.com/fastlane/fastlane/blob/master/supply/lib/supply/uploader.rb),
[`setup.rb`](https://github.com/fastlane/fastlane/blob/master/supply/lib/supply/setup.rb).

- Default `metadata_path` is `./fastlane/metadata/android`, else `./metadata`
  (`options.rb`: `Dir["./fastlane/metadata/android"] + Dir["./metadata"]`).
- `AVAILABLE_METADATA_FIELDS = %w(title short_description full_description video)`, read as
  `<metadata>/<locale>/<key>.txt`.
- Release notes: `<metadata>/<locale>/changelogs/<versionCode>.txt`; `default.txt` is the fallback
  when no file matches the version code.
- Images: `<locale>/images/` with `featureGraphic`, `icon`, `tvBanner` (source) and the screenshot
  folders `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvScreenshots`,
  `wearScreenshots`. The docs page also names `promoGraphic`; the source constant does not.
  Not parsed in this slice.
- Reading: `File.read(path, encoding: 'UTF-8')`, **no strip or chomp**. Writing (`supply init`)
  adds no newline. So a trailing newline in a supply file is uploaded as part of the text.
  The docs page does not mention `full_description` or `video`; the source does.

### Expo and EAS

Sources: [EAS Metadata](https://docs.expo.dev/eas/metadata/),
[getting started](https://docs.expo.dev/eas/metadata/getting-started/),
[schema](https://docs.expo.dev/eas/metadata/schema/),
[config types](https://docs.expo.dev/eas/metadata/config/),
[eas.json](https://docs.expo.dev/build/eas-json/),
[eas.json reference](https://docs.expo.dev/eas/json/),
[app config](https://docs.expo.dev/workflow/configuration/),
[app.json reference](https://docs.expo.dev/versions/latest/config/app/).

- EAS Metadata is **current but in beta** ("subject to breaking changes") and **Apple only**:
  Google Play listings and screenshots are not supported.
- Config file: `store.config.json` at the project root by default; `metadataPath` under
  `submit.<profile>.ios` in `eas.json` changes the name and location. Dynamic JavaScript
  (`store.config.js`) is supported.
- Schema: `configVersion` (only `0`), then `apple` with `copyright`, `categories`, `info`,
  `review`, `advisory`, `release`, `version`. `apple.info.<locale>` has `title` (2..30),
  `subtitle` (30), `description` (10..4000), `keywords` (array of strings), `releaseNotes` (4000),
  `promoText` (170), `privacyPolicyUrl` (255), `privacyPolicyText`, `supportUrl` (255),
  `marketingUrl` (255), `privacyChoicesUrl` (255).
- `eas.json` top level: `cli`, `build` (named profiles, `extends`), `submit`
  (`submit.<profile>.{android,ios}`).
- App config files: `app.json`, `app.config.{js,ts}` (also `.mjs/.cjs/.mts/.cts` are discovered),
  at the project root next to `package.json`. If the config has a top-level `expo` object it
  replaces the root object. `ios.bundleIdentifier` and `android.package` are documented.

### Store limits

| Field | Limit | Source |
| --- | --- | --- |
| App Store name | 2 to 30 characters | [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information) |
| App Store subtitle | 30 characters | same |
| Promotional text | 170 characters | [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information) |
| Description | 4000 characters, required, plain text | same |
| Keywords | 100 bytes, required; each keyword more than two characters | same |
| What's new | 4000 characters | same |
| Support URL | required, full URL with protocol | same |
| Marketing URL | optional, full URL with protocol | same |
| Privacy policy URL | required for iOS and macOS | App information |
| Copyright | required, year then owner | Platform version information |
| Play app name | 30 characters | [Play Console store listing](https://support.google.com/googleplay/android-developer/answer/9859152) |
| Play short description | 80 characters | same |
| Play full description | 4000 characters | same |
| Play release notes | 500 Unicode characters per language | [Release notes](https://support.google.com/googleplay/android-developer/answer/9859348) |
| Play promo video | a YouTube URL | [`edits.listings`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings) |

Play's limits apply to full-width and half-width characters alike.

### GitHub

Sources: [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[workflows](https://docs.github.com/en/rest/actions/workflows),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[trees](https://docs.github.com/en/rest/git/trees),
[refs](https://docs.github.com/en/rest/git/refs),
[contents](https://docs.github.com/en/rest/repos/contents),
[app JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[installation token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
[changelog 2026-02-19](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids).

- **Workflow dispatch no longer always returns 204.** With `return_run_details: true` it answers
  `200` with `workflow_run_id`, `run_url` and `html_url`; without it, `204` and no body. The
  connector asks for the details and handles both answers, so `dispatchWorkflow` returns a
  `runId` when GitHub gives one. `inputs` is limited to 25 properties.
- Rate limits: `403` or `429`. A `retry-after` header means wait that long; `x-ratelimit-remaining: 0`
  means wait until `x-ratelimit-reset` (epoch seconds); otherwise wait at least a minute.
- Trees: `recursive` listing is cut at 100,000 entries or 7 MB and says `truncated: true`;
  then fetch one subtree at a time. A `null` sha in a created tree deletes the file.
- Contents: files over 1 MB return empty `content` and `encoding: "none"`; use the blob API or
  the raw media type (up to 100 MB). Directories list at most 1,000 entries.
- App JWT: RS256, claims `iat` (60 seconds in the past advised), `exp` (at most 10 minutes ahead),
  `iss` (client ID recommended, app ID allowed). Installation token: `POST
  /app/installations/{id}/access_tokens`, valid one hour, optional `repositories` to narrow it.
- `GET .../actions/workflows/{workflow_id}/runs` accepts `branch`, `event`, `status`,
  `per_page` (max 100), `page`, `created`, `head_sha`, and others.

## What could not be verified

- **Trailing newline convention.** No page says what fastlane expects. From the source:
  deliver strips on upload, supply does not. The code keeps each file's own convention, and
  for a new file follows the store's other files, or writes none if there are none.
- **How the stores count length.** Code points are used for characters. Apple does not say
  whether emoji or combining marks count as one, and whether commas count in the 100 byte keyword
  limit. The whole keyword string is measured in UTF-8 bytes.
- **Apple name required, What's new required**: not stated on the pages read (the second is
  required for updates in practice). Both are warnings.
- **Apple URL length (255), description minimum (10)**: from the EAS Metadata schema, not from
  Apple. Warnings.
- **Play required fields per language**, and which language is the default: not stated on the
  page read. Title, short and full description are warnings when missing.
- **Valid locale codes** for either store: the lists were not checked. Folder names are matched
  loosely (`en`, `en-US`, `zh-Hans`, `es-419`) only to tell locales from other folders.
- **Custom `metadata_path`** (a Fastfile can point anywhere): see "Layouts seen in real projects".
  Roots are detected by name (`metadata`, `metadata/ios`, `metadata/<app id>/ios`, and the
  Android counterparts), a literal or `File.join` `metadata_path` of a Deliverfile or Fastfile is
  a hint, and anything else needs an explicit folder (a saved listing target, or `roots`). Ruby is
  never run: a path built from a method call or a bare `ENV[...]` is not guessed.
- **EAS Metadata** accepting `.ts`, `.cjs`, `.mjs` store configs: only `.json` and `.js` are
  documented. Any non-`.json` path is reported as dynamic and not read.
- **GitHub**: the `422 Reference already exists` answer to creating a ref is not in the docs (they
  list generic `422`/`409`); the connector matches `422` plus that message. The `404` message
  `No commit found for the ref` (to tell a missing ref from a missing file) is from observed API
  behaviour, not the docs. `GET git/trees/{commit sha}` is used by `listFiles` (the docs say
  "tree SHA or ref"); `propose` uses the tree sha. Whether `return_run_details` exists on
  GitHub Enterprise Server is not stated; `dispatchRunDetails: false` turns it off.
- **Fixtures are hand-written from the documented response shapes, not recorded from a live
  GitHub.** No network was available to record them. Replace them with recordings when a test
  repository and App exist.

## Layouts seen in real projects

Checked on 2026-11-18 against three NativeScript projects of the maintainer (folder and file
names only, no content was copied; the test fixtures in `packages/connectors/src/fastlane.fixtures.ts`
are made up and only follow the structure):

- **a) one app:** `fastlane/metadata/ios/<locale>/*.txt`, `fastlane/metadata/ios/copyright.txt`
  (and the category files), `fastlane/metadata/ios/review_information/`,
  `fastlane/metadata/ios/screenshots/`, and `fastlane/metadata/android/<locale>/...`. The iOS root
  is `fastlane/metadata/ios`, not `fastlane/metadata`: the lanes call
  `upload_to_app_store(metadata_path: File.join(metadata_path_realpath, "ios"), ...)` where
  `metadata_path_realpath` joins the project root, `fastlane` and a `metadata_path` variable that
  defaults to `metadata` (`ENV["SUPPLY_METADATA_PATH"] || "metadata"`). The Deliverfile is only
  comments. Before this was handled the App Store listing was reported as not found.
- **b) several apps in one repository:** `fastlane/metadata/<app id>/ios/<locale>/...` and
  `fastlane/metadata/<app id>/android/<locale>/...`, one pair per app id. The same Fastfile
  defaults to `metadata`, so the per-app folder comes from `SUPPLY_METADATA_PATH` at run time: the
  default the hint evaluates to (`fastlane/metadata/ios`) does not exist, and is only mentioned in
  the diagnostic. The folders are found by name, one detected target per app id.
- **c) Android only:** `fastlane/metadata/android/<locale>/...`, no iOS folder.

Release notes are one file per version code (`changelogs/<code>.txt`): in these projects 70 to
155 files per locale. That is where the time went: each is a request to the contents API.

Hints (`parseMetadataHints`): a `metadata_path` argument of `upload_to_app_store` / `deliver` /
`upload_to_play_store` / `supply` in a Fastfile, or `metadata_path "..."` in a Deliverfile, is
evaluated when it is built from string literals, `File.join`, `ENV["X"] || "default"`,
`ENV.fetch("X", "default")`, `"#{var}"` and variables assigned earlier in the same file. The
result is taken relative to the fastlane folder (where lanes run) and to the repository; the
ones that hold listing files are used first. This evaluates text; no Ruby is run. An `Appfile`
`app_identifier "..."` literal prefers that app's folder when several exist. Not verified: that
fastlane resolves a relative `metadata_path` against the fastlane folder in every setup (both
readings are tried for that reason).

## Detection rules (what counts as evidence)

`detectProject` returns `kind`, `platforms` and `locales` only from files that state something:

- fastlane: a `Fastfile` or `Appfile`, or metadata files under a `fastlane/metadata` folder.
- Expo: `app.json` with an `expo` key, an `app.config.*` file, or an `expo` dependency in
  `package.json`.
- Not enough on its own: a lone `eas.json`, an `app.json` with `slug` but no `expo` key (bare React
  Native also has an `app.json`), metadata files outside a `fastlane` folder, a Fastfile that
  merely mentions `deliver` or `supply`, native `ios/` or `android/` folders. These appear in
  `evidence` as `inferred` and in `platformsInferred`; they never change `kind`.
- Code is never run: `app.config.js` and `store.config.js` are reported as unreadable.
- Only the repository root is inspected for Expo; Expo files in subfolders are a warning.
  fastlane folders are found up to two folders deep (`ios/fastlane`).
