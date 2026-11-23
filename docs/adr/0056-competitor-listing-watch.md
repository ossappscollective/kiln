# ADR 0056: Competitor listing watch

Status: server and web implemented, tested against hand-written fixtures; **never run against Apple's real service and not looked at in a browser** (see the end).
API: [api/aso](../api/aso.md) (changes, check now, image proxy). Builds on [ADR 0011](0011-aso-keywords-competitors.md) (followed competitors and their snapshots),
[ADR 0049](0049-csp-and-headers.md) (CSP: `img-src 'self' data:`), [ADR 0053](0053-timeline-and-reports.md) (timeline events) and
[ADR 0055](0055-review-summary-and-competitor-reviews.md) (the other thing read from Apple for a competitor). One migration (60).

## Context

Followed competitors kept hashes and a screenshot count, so Kiln could say "media changed" but not show what, and a CDN re-encode of the same picture
looked like a change. People want to see when a rival changes screenshots, icon, name, description or release notes, next to the charts of their own app.

## Decisions

- **Detection runs where the competitor is already read**: the ASO refresh (`recordCompetitorCheck`) and "Check now" (`POST .../competitors/{id}/check`),
  which is the same code with the same shared cache, rate limit and cool-down. No new outbound call, no new host.
- **App Store only.** Kiln does not read Google Play pages (ADR 0011). A Play competitor is listed as `not_watched`, with the reason, in the API, the UI and these docs.
- **Compare against a stored state, not against hashes.** `aso_competitors.listing_state` (JSON) holds the last compared listing: name, description, release notes,
  version, price, category, icon, iPhone and iPad screenshot addresses, rating and count. The snapshots of ADR 0011 are unchanged. The pure `diffListing`
  (`packages/core/src/aso/competitor-listing.ts`) compares two states.
- **Stable image identity** (`imageKey`): the Apple CDN host (`is1-ssl`, `is3-ssl`, ...) is one host, and the trailing rendition segment
  (`/392x696bb.jpg`, `/600x0w.webp`, `/1242x2688bb-85.png`) and the query are dropped. A re-encode or another size is no change. The hash of the old
  `aso.competitor_changed` media field now uses the same identity, so after the upgrade one competitor read can raise one last false "media" change.
- **Per device**: iPhone and iPad lists are compared separately; the result counts `added`, `removed`, `replaced` (one gone and one new), and `reordered`.
- **Noise rules**: text is compared after collapsing whitespace (whitespace-only edits are no change); an empty name, description, icon or screenshot list after
  a filled one is a failed read, ignored, and the old value is kept in the state (`carryOver`); the rating counts from 0.1 star, the rating count from 10 % and 50.
- **Stored as one row per detection**: `aso_competitor_changes` (kinds, and the changes with before and after: image addresses and texts cut to 2000 characters, all public store data).
  Kept 180 days and 200 per competitor, deleted with the competitor. It is a new table because the snapshots do not keep the lists, so a diff cannot be derived on read.
  The first read stores the state and records no change; history starts when following began and the UI says so.
- **Subtitle is not watched**: Apple's lookup has no subtitle (ADR 0011, UNVERIFIED list). The name is.
- **Surfaces.** (a) The competitor card has a collapsed "Listing changes" section: newest first, paged by 10, before and after strips for screenshots and the icon, short
  word diffs (collapsed) for name, description and release notes, "Check now", and honest states (not checked, first look only, none since we started watching,
  not watched for Play, rate limit). (b) Timeline: a Kiln event `competitor_change`, one per competitor and day, none for rating drift alone, read from the table.
  (c) Event `aso.competitor_listing_changed` (ids, the kinds; never a name, an address or a text, like every ASO event) and the alert `competitor.listing_changed`:
  default off, one per competitor per day (the existing dedupe window), the sentence names the kinds of change in the reader's language.
- **Images through the server.** The CSP blocks `mzstatic.com`, so thumbnails come from `GET .../competitors/{id}/image?ref=` and, for the add dialog, `GET .../competitors/search-image?ref=`.
  The client never sends an address: a ref names something Kiln stored (`icon`, `s.p.<n>`, `s.i.<n>`, `c.<change>.<b|a>.<icon|p|i>.<n>`), or is an opaque digest the search handed out
  (kept in memory for 15 minutes, per app). The fetch is `downloadStoreImage` with the host narrowed to `mzstatic.com` and subdomains, https, no credentials or port, redirects
  checked, resolved addresses public, 2 MiB cap, type sniffed from the bytes (never SVG), a per workspace limit (300 a minute), a small LRU, `private` cache with `ETag` and
  stale-while-revalidate, the safe image headers of the other proxies. Rights: `aso.read` (search icons: `aso.write`, like the search).

## Limits

At most 20 screenshots per device are kept; 200 changes and 180 days per competitor; "Check now" does not read a competitor again within 5 minutes (and the source cache
may return a lookup up to an hour old, so a very fresh change can show up on the next refresh).

## Not verified

- Apple's real lookup answers: that `screenshotUrls` and `ipadScreenshotUrls` are the two device lists, that `releaseNotes` is present, and the shapes of the image addresses
  (`imageKey` assumes the `/<w>x<h><suffix>.<ext>` rendition segment of `mzstatic.com`).
- That `mzstatic.com` serves `/<n>x<n>bb.jpg` as a bounded rendition for every stored address (the proxy rewrites the segment and falls back to the stored path when there is none).
- Nothing was run against the real service and nothing was looked at in a browser (layout, dark theme, keyboard order were written to the design tokens, not seen).
