# Store assets and app icons

A read-only index of the store media found in an app's repository (screenshots, app previews,
Google Play graphics, icons), checked against the sizes and counts the stores document, plus a safe
way to show those images and the icon of each app in the web app.

**Nothing is written anywhere.** No file is uploaded to a store or to this server, no store is
called to check the files, and the repository is only read. The checks hold the files against the
documented specs; a store can still refuse an upload. This is the read side that a later "push
assets" step could build on, and that step does not exist.

Never run against a real GitHub repository or a real store, and never shown in a browser by the
author of this feature: it is tested with fakes (a fake repository that serves blobs, a fake
network for the icon lookup) and with real PNG and JPEG bytes made in the tests.

Everything is under `/api/workspaces/{workspaceId}/apps/{id}`. A non-member gets 404, a member
without the right gets 403. An API token may hold the rights like any other action. The routes are
in the [OpenAPI description](openapi.md) (tag `assets`).

| Route | Right | Returns |
| --- | --- | --- |
| `GET /assets` | `listing.read` (every role) | The index (below) |
| `GET /assets/file?path=&commit=` | `listing.read` | The bytes of one indexed image |
| `GET /icon` | `apps.read` | The icon of the app, or 404 |

The apps JSON (`GET /apps`, `GET /apps/{id}`) gained two hints: `hasIcon` (boolean) and `iconUrl`
(the icon route with `?v=<etag>` when the server holds one, the plain route when a look is due, and
`null` when the last look found nothing and the next one is not due yet). The web app loads only
`iconUrl`, and only when it is a path under `/api/workspaces/`.

## Where the files are looked for

The repository linked to the app is read at the commit of its default branch. A listing target
(the folder of the app in a monorepo) is used when the repository has one. The index names the
folders it searched (`folders`).

- App Store: `fastlane/metadata/<locale>/` is the metadata folder; screenshots are searched in
  `fastlane/metadata/screenshots/<locale>`, `fastlane/screenshots/<locale>` (only when the folder is
  named `metadata`), and `<metadata folder>/screenshots/<locale>`; previews likewise.
- Google Play: `<metadata folder>/android/<locale>/images/` with `icon.png`, `featureGraphic.*`,
  `promoGraphic.*`, `tvBanner.*`, and the screenshot folders `phoneScreenshots`, `sevenInchScreenshots`,
  `tenInchScreenshots`, `tvScreenshots`, `wearScreenshots`.
- The icon of the project, for the icon of the app: Expo `app.json` (`expo.icon`, read at the
  repository root only), an Xcode `AppIcon.appiconset`, an Android `ic_launcher`.
- `screenshots_path` in a Fastfile is not followed (a Fastfile is Ruby and is never run or parsed).

Files over 25 MB are listed and never read. Only png, jpeg and webp content counts as an image for
the checks; the type comes from the bytes, never from the file name.

## What is read, and how much

Only the first bytes of an image are read (64 KB; 1 MiB for a JPEG whose size marker is further in)
to learn its size, format and whether it has an alpha channel. The index is limited by the source:

| Source | Images opened | Bytes pulled |
| --- | --- | --- |
| Local clone (fast) | 2000 | 4 GiB |
| Clone of the GitHub repository | 150 | 48 MiB |
| GitHub over the REST API (slower) | 60 | 24 MiB |

When a limit is reached the index says `partial` with the reasons; the remaining files are listed
without their size. App previews (video) are never opened.

The index is cached per repository commit, app, listing target and scope (48 entries). Only reads
that miss the cache count toward the limit of 30 per minute per workspace (`429 rate_limited`).

## The index

`GET /assets` returns, among others: `status` (`ok` or `no_repository`), `source` (`label` is
"Local clone (fast)", "Clone of the GitHub repository" or "GitHub (slower)", plus `fast`), `commit`,
`readAt`, `target`, `folders`, `limits`, `partial`, `totals`, `locales`, `devices`, `sets` (the count
of each locale, kind and device next to the most the store takes), `assets` (path, locale, kind,
device, order, size in bytes and pixels, format, alpha, blob id, whether it was read), `problems`,
`notes`, `specs` and `storeSide`.

`storeSide` is always `null` today: it is the place where the listing reads can supply the counts
the store has, so the Assets tab can say "Not yet compared with the store". Until then the tab
shows exactly that text.

A problem has a `rule` code, a `severity` (`error`, `warning`, `info`), a message (the documented
rule, then what was found), the `source` page of the rule and `verified`. A rule whose number was
not found on an official page is `verified: false` and is never above `info`.

## Serving an image

`GET /assets/file` serves a file only when it is in the index for the same commit: the path is
looked up in the index, never opened by its name, so a path that is not an indexed media file is
404 whatever it contains. The type is the sniffed one (png, jpeg, webp or gif; never svg or html),
`Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, a CSP of
`default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, an `ETag` that is the
git blob id (and a `304` for `If-None-Match`). With `commit` (the commit of the index) the answer
is cacheable for good (`immutable`). Files over 8 MiB are `413`; a file that is not an image, or
a preview, is `415`. Nothing is downscaled: the original bytes are served.

## Icons

`GET /icon` serves the icon the server holds for the app, or `404` with `no-store`. Sources, in
order:

1. The repository: the store icon (`images/icon.png` for Google Play, the App Store icon of the
   project), then the project icon.
2. iOS only: the iTunes Lookup API (`https://itunes.apple.com/lookup?id=<trackId>`, the artwork
   `artworkUrl512`, else `artworkUrl100`, from `*.mzstatic.com`). Google Play icons come from the
   repository only; nothing is read from play.google.com and the connectors expose no icon.

An icon is a png, jpeg or webp by its bytes, square and at least 64 px. Images are limited to
256 KB and the lookup answer to 1 MB. The request goes through the SSRF-safe fetch
(`services/safe-fetch.ts`): only the two named hosts, no redirect to anywhere else, resolved
addresses checked, a timeout.

Rechecks: a repository icon is looked at again after 30 minutes and only replaced when its blob
changed; a remote icon after 7 days (the repository daily); an empty look after 1 hour; a failure
backs off from 15 minutes, doubling to 24 hours. A failed look never removes an icon already held.
iTunes lookups are limited to 6 per minute per workspace and 15 per minute for the server, and a
limited look changes nothing. The first icon request waits at most 8 seconds while the look
continues in the background. The icons are stored in the table `app_icons` (migration 18) as base64
text, because the database layer has no binary parameter; deleting an app deletes its icon.

## Specs and what is not verified

The rules come from these pages, read for this feature (see the comments of
`packages/core/src/store-asset-specs.ts`, which cite the rule next to every number):

- Apple, screenshot specifications and app preview specifications (App Store Connect Help), and the
  Human Interface Guidelines for app icons.
- Google Play Console Help, "Add preview assets to showcase your app" (answer 9866151).
- fastlane `deliver` and `supply` documentation for the folder layout.
- Apple, iTunes Search API documentation for the lookup.

**UNVERIFIED** (marked in the code, in the API as `verified: false`, and on the Assets tab; shown as
information only, never as an error):

- The App Store icon "no alpha channel" rule: the Apple pages that were read do not state it.
- The Google Play promo graphic: the page read has no requirement for it, so it is listed only.
- The pixel sizes of each Apple app preview display: that page was cut off when it was read, so
  previews are checked for format and count only.
- A file size limit for the Play feature graphic and Play screenshots was not found, so none is checked.
- For the iTunes lookup, `artworkUrl512`, `bundleId` and `country` are not on the official page that
  was read. Only `id` is sent, and no country.
- Apple's terms for the iTunes data allow artwork only to promote the content; the icon is shown
  next to the app in this tool only.

## Audit and cost

Reading an image through a non-clone source opens a credential for each read (that is what the
repository access does), so thumbnails can add audit entries. The opened connector is reused for
30 seconds to keep that low. A local clone has no credential and adds none.

## Configuration

There is no environment variable. The limits above are constants, and the seams for tests are the
`assets` dependencies of `createApp` (`limiter`, `icons.limiter`, `icons.net`).
