# Store assets and app icons

A read-only index of the store media found in an app's repository (screenshots, app previews,
Google Play graphics, icons), checked against the sizes and counts the stores document, plus a safe
way to show those images and the icon of each app in the web app.

The index itself is read-only: it never writes anything. Around it, the **two way sync** (below) reads what a
store holds now, compares it with the repository, pulls it into a draft change set, and lets a person add, replace,
remove and fix files of a staged set. **None of that writes to a store**: the only store write stays the gated
draft push of [staged changes](staged-changes.md). The checks hold the files against the documented specs; a store can
still refuse an upload.

Never run against a real GitHub repository or a real store, and never shown in a browser by the author of this
feature: it is tested with fakes (a fake repository that serves blobs, a fake network for the icon lookup and the
store CDN, fake store connectors) and with real PNG and JPEG bytes made in the tests.

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
- macOS: a Mac App Store version takes only the `mac` display (`APP_DESKTOP`: 1280x800, 1440x900, 2560x1600,
  2880x1800; PNG or JPEG, no alpha, at most 10 per locale); an iPhone, iPad, TV, Watch or Vision screenshot belongs
  to the iOS record and a Mac screenshot to the macOS record, so a file is shown, compared and pushed only on the
  platform record whose display it fits. A file whose device is not known fits iOS only (as before). The folders
  are the App Store ones above. UNVERIFIED: the `mac` size list and the 10 per locale limit were taken from the
  spec table of the code (`store-asset-specs.ts`); Apple's `ScreenshotDisplayType` page lists no values.
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

`storeSide` is `null` until a store read of the last minutes exists (nothing reads a store just to fill it). After
`GET /assets/store`, `/assets/diff` or a pull, `GET /assets` carries `{ observedAt, counts[] }` (the number of images the
store has per locale, kind and device), and the tab shows the counts next to each set.

Changes since the first version of the index: an icon file inside an Xcode `AppIcon.appiconset` is checked against the
sizes of its slot in `Contents.json` and not as the 1024 px store icon (those were false errors), and an Apple
screenshot in a device's set is checked against the pixel sizes that device takes (`apple.screenshot.size`).

## Two way sync

All routes are under `/api/workspaces/{workspaceId}/apps/{id}`. Nothing here writes to a store.

| Route | Right | What it does |
| --- | --- | --- |
| `GET /assets/store[?fresh=1]` | `listing.read` | What the store holds now: per locale, kind and device the images with an opaque `ref`, size, checksum (when the store gives one) and state. A read of the store (App Store Connect: the version's screenshot sets; Google Play: `edits.images.list` per type). Reused for 60 seconds; 12 reads a minute per workspace. |
| `GET /assets/diff[?fresh=1]` | `listing.read` | The repository against the store: per set and position `identical`, `likely_same`, `differs`, `only_repo` or `only_store`, with both sides' size and checksum. |
| `GET /assets/store/thumb?ref=&size=` | `listing.read` | A thumbnail of one store image through the server (160, 320 or 640 px wide). `ETag` from the ref, `private` cache, an LRU of 24 MiB; `404 ref_expired` once the ref is older than 15 minutes (read the store again). |
| `POST /assets/pull` | `changesets.write` | Downloads store images into a **draft change set** (body: `sets`, `files`, `prune`). |
| `POST /assets/inspect?locale=&kind=&device=&name=` | `changesets.write` | The raw bytes of a file in the body: what it is and what is wrong with it for that set, with the fixes that apply. Stages nothing. |
| `PUT /staged/assets/upload?...` | `changesets.write` | Stages the raw bytes of a file as an add or a replace. |
| `DELETE /staged/assets/file?locale=&kind=&device=&position=` | `changesets.write` | Removes a file from the staged set. |
| `POST /staged/assets/fix` | `changesets.write` | Makes a corrected file of a staged file (`remove_alpha`, `resize`, `rename_extension`) and stages it. |
| `GET /staged/assets/blob?oid=` | `listing.read` | The bytes of an uploaded or fixed staged file (same safe headers as `/assets/file`). |
| `POST /staged/assets/to-repo` | `changesets.write` | Makes a draft change set that writes the staged sets into the repository. |

**Keys.** A set is `platform/locale/slotKey` (`ios/en-US/screenshot:iphone_6_9`), an image is the set plus
`#position`. `platform` is the first part so that macOS can be added later (a value of `ASSET_PLATFORMS`, a connector
reader and a slot map); it is **not implemented**.

**Pulling.** The server finds the address of each image from the store's answer (Apple's `imageAsset.templateUrl`
with the width, height and format filled in; Google's `url`), never from the client. A download is only made over
`https` to an allow listed CDN host (`mzstatic.com` for Apple; `googleusercontent.com` and `ggpht.com` for Google),
the addresses the name resolves to are checked, a redirect is followed only to another allow listed host, and the
body is limited to 12 MiB a file, 48 MiB and 120 files a pull and 120 seconds, one after the other. The bytes are
identified by their magic bytes (PNG or JPEG), never by a header. Google Play gives a SHA-256: a file that does not
match it is left out (`checksum_mismatch`). App Store Connect gives no checksum of the image: its images are taken and
listed under `unverified`. Files go to the repository's screenshot folder (iOS: the folder the repository already
uses, else deliver's default) or Play's `images` folders, named so that they sort in the store's order; nothing in the
repository is deleted unless `prune: true`. The answer is `{ pull: { changeSet, written, deleted, unchanged, bytes,
skipped[], unverified[], left[], notes[] } }`; `changeSet` is `null` when nothing differs. A person reviews and
applies it like any change set. The change set carries base64 file changes (`encoding: "base64"`), which the GitHub
and the local clone connectors write as binary files.

**Staging bytes.** An uploaded file is kept in the table `staged_asset_blobs` (migration 26) as base64, with its git blob
id, so a push reads it from there (`source: "local"`, path `uploads/<id>/<name>`). Caps: 8 MiB a file, 64 MiB and 100
files for an app; a staged set that is removed or replaced drops the bytes nothing refers to. A file is accepted only
when its bytes are a PNG or a JPEG with a readable header, and it passes the rules of its set; otherwise the answer is
`422 spec_errors` with `problems[]` and `fix` (`options[]`, `manual[]`), and the same request with `fix=` (and
`background=#rrggbb`) stages the corrected file. A set cannot be emptied (`empty_set`): a push cannot clear a store's
set, so the last file stays.

**Fixes.** `remove_alpha` flattens the picture onto a background (default white); `resize` scales a PNG to the nearest
size the store requires (area average down, bilinear up); `rename_extension` fixes the name. They run on 8 bit,
non interlaced PNG (gray, RGB, palette with tRNS, gray alpha, RGBA); anything else is refused with a message. A wrong
pixel size of a JPEG, or a size that has no single answer, is reported as a manual fix with the exact sizes.

Audit: `assets.pulled`, `staged.asset_added`, `staged.asset_replaced`, `staged.asset_removed`, `staged.asset_fixed`,
`staged.assets_to_repo`, with ids, counts and hashes only. Event: [`assets.pulled`](events.md). Store reads open the
credential with the purpose `store.images_read` (never the draft purpose).

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

**UNVERIFIED for the sync** (nothing was run against a store):

- Apple: that `imageAsset.templateUrl` (documented) serves the original bytes at the template's full size, and the
  CDN host list (`mzstatic.com` is the host of Apple's documented example). The pull therefore treats Apple images as
  unverified.
- Google: the `Image` fields `id`, `url`, `sha1` and `sha256` are documented; that `url` is "a preview", whether it
  serves the full size image, and which hosts it uses (`googleusercontent.com`, `ggpht.com`) are not.
- That the stores' placement order equals the order of the lists read.

## Audit and cost

Reading an image through a non-clone source opens a credential for each read (that is what the
repository access does), so thumbnails can add audit entries. The opened connector is reused for
30 seconds to keep that low. A local clone has no credential and adds none.

## Configuration

There is no environment variable. The limits above are constants, and the seams for tests are the
`assets` dependencies of `createApp` (`limiter`, `icons.limiter`, `icons.net`).
