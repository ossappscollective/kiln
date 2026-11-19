# ADR 0013: macOS as a third platform of an app

Status: implemented; not run against a real store or account (the test environment had no network).

## Decision

An app entry (the "app group" of the web layer) has up to three records, one per platform: `ios`, `macos`,
`android`. The `platform` columns are plain TEXT with no CHECK and the unique index is
`(workspace_id, platform, identifier)`, so **no migration was needed** (`packages/db/src/migration-macos-platform.test.ts`
holds that: it fails if a later migration adds a CHECK that does not admit `macos`).

One helper, `packages/core/src/platform.ts`, holds the labels ("macOS"), the store name ("Mac App Store"), the glyph
(`platform-macos`), the store family (`apple` for iOS and macOS, `google` for Android), the credential kind and the order.
Code asks it instead of comparing with `'ios'`.

## Rules

- macOS is Apple's family: App Store Connect connector and credential, the lifecycle rules of Apple (no
  "propagating"), the staged draft push, the submit and the phased release, each with the Apple `platform`
  (`MAC_OS`) on the version. Every connector call is made for one platform and filters on it, so a Mac read never
  shows iOS versions or builds (and the reverse). Guards, gates, claims and audits are the existing ones keyed
  by `(app_id, platform)`.
- An iOS and a macOS record may share a bundle id and a store id (universal purchase) or not.
  Sync of a macOS record with no macOS version in App Store Connect answers `store_not_found` with a message.
- Customer reviews are per App Store Connect app: the macOS record that shares its store id with an iOS record
  owns none (409 `reviews_shared`, skipped by the scheduler); they are read once, under iOS.
- Name and subtitle are app level; the description, keywords, promotional text, URLs and "what's new" are per
  version, so per platform record.
- Discovery lists one candidate per Apple platform of an app when the platforms could be read; when they could not,
  an app is an iOS candidate, as before.
- Build linking: the platform words `macos`, `mac` and `osx` in a tag or release name mean `macos`.

## UNVERIFIED

Apple's `.md` pages that could be fetched omit the query parameter lists and the enum values, so:

- `MAC_OS` as the value of `appStoreVersions.platform` and of `preReleaseVersions.platform` (the attribute is
  documented; the values were taken from usage). Versions are filtered client side; builds through the pre release
  version.
- That `include=appStoreVersions` with sparse `fields[appStoreVersions]=platform` works for the platform read
  of discovery, and the page size limit used there.
- Whether a macOS review submission needs the `platform` of `reviewSubmissions` (it is optional on create in the
  docs; this server sends it for macOS).
- The screenshot display type of a Mac version (`APP_DESKTOP`) and the four Mac sizes.
- iTunes lookup of a Mac app's rating by `entity=macSoftware` and the Mac search by `entity=desktopSoftware`: Apple's
  pages document `desktopSoftware` for search and the lookup by id only.
- That the phased release endpoints behave on a macOS version as on iOS (Apple's help page says macOS has phased release).
- Which minimum API key role may write a macOS version (the iOS assumption, App Manager or Admin, is reused).

## Not done

- Release plans, ASO tracking, listing pull into a repository, fastlane metadata detection and the CI
  dispatch knew iOS and Android only; macOS reuses the iOS folders (no separate fastlane `mac` folder is searched).
- No browser run: the web changes were checked with svelte-check and the unit tests only.
