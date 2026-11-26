# ADR 0012: Two way sync of store graphics

Status: implemented and tested against fakes on SQLite (the Postgres paths are written and share the migration and
drift tests, but were not run here). **Never run against the real Apple or Google services or a real repository**: the
test environment had no network. What was not verified is listed under [UNVERIFIED](#unverified) and in
[api/assets](../api/assets.md#two-way-sync).

## Context

The Assets tab showed the graphics of the repository and could stage them for a draft push. It could not bring the
store's images back ("Pull from store" was a disabled button and `from: "store"` answered `source_not_supported`), could
not show how the repository and the store differ (`storeSide` was always `null`), and a file could only be changed by
changing the repository. Users asked for the full set: pull, diff, add, replace, remove and fix errors in the app.

## Decision

1. **Pull = a draft change set, never a direct write.** Store images are downloaded by the server into a change set
   with base64 file changes (`FileChange.encoding: "base64"`), through the existing review, approve and apply flow. The
   GitHub connector writes them as binary blobs, the local clone connector with `git hash-object`. A change set with
   binary files cannot be refreshed or fixed up yet (`binary_change_set`), because those paths compare text.
2. **The server finds every address; the browser never holds one.** A store image has an opaque `ref`
   (`sha256(workspace|app|key|id|checksum)`, 32 hex characters) held in a memory map for 15 minutes. Thumbnails and
   downloads go through the server, which only fetches `https` from an allow list of CDN hosts, checks the resolved
   addresses, follows a redirect only to another allow listed host, caps the body (12 MiB a file, 48 MiB a pull, 120
   files, 120 s), and identifies the bytes with the same header parsers as the index. A thumbnail is the original,
   cached in an LRU (24 MiB) with an `ETag` from the ref.
3. **Checksums.** Google Play gives a SHA-256: a mismatching file is skipped. App Store Connect gives none for the
   image (the only mark is this server's own `kiln:sha256:` reference name), so Apple images are taken and flagged
   `unverified`, and the comparison says "probably the same" when only sizes agree.
4. **Platform generic keys.** A set is `platform/locale/slotKey`, an image is the set plus `#position`. macOS is a
   later value of `ASSET_PLATFORMS`, a connector reader and a slot map; it is not implemented.
5. **Where uploaded bytes live: the database.** A staged upload is a row of `staged_asset_blobs` (migration 26: base64
   text, git blob id, unique per app and id), with a cap of 8 MiB a file and 64 MiB and 100 files an app. The managed
   clone directory was the alternative; it was rejected because staged changes live in the database and must survive a
   restart and a move of the server, a clone can be purged or re-cloned at any time, a local clone must never be written
   to without a change set, and the database layer already backs up and deletes per app. The price is size (base64) and
   the caps. Rows are removed when no staged row refers to them and when the app is deleted.
6. **Staged like text.** Add, replace, remove and fix change the staged set (`staged_changes`, kind `asset`), and the
   existing gated push writes the whole set to the store's draft: nothing in this ADR adds a store write. A set can
   be emptied (a marker row; a push then removes every image of the set). "Put into the repository" makes a change set from the staged
   sets. Both are previewed in the UI with before and after thumbnails.
7. **Fixes are copies.** A fix makes a corrected file and stages it; the original is never overwritten. The PNG codec is
   pure TypeScript (`node:zlib`, no packages): 8 bit gray, RGB, palette with tRNS, gray alpha and RGBA, non interlaced;
   everything else is refused with a message. Resizing is area average down and bilinear up (tested), PNG only.
8. **Repository layout is planned, not guessed.** A new file takes over the path at its position when the extension
   matches; otherwise it gets `<device>-NN.ext`; if the names would not sort in the wanted order the whole set is renamed
   canonically. Pull deletes nothing unless `prune` is set.
9. **Gating.** New routes are in the operation registry (default deny), the OpenAPI description and the audit (ids and
   hashes only), with rate limits (store reads 12 a minute, CDN fetches 300, uploads 60). Store reads open the credential
   with the purpose `store.images_read`. Changing files needs `changesets.write`; the draft push keeps its flag, right,
   preview, hash and confirmation.

## Consequences

- The Assets tab can pull, compare, upload, replace, remove, fix and put staged files into the repository without a store
  write.
- Pulled Apple images are only as trustworthy as the CDN path; the report says so.
- Binary change sets are a new kind of change set; refresh and fix up of them are refused until they are made binary aware.
- Uploaded files take database space (base64), bounded by the caps.

## UNVERIFIED

Nothing was run against a store or a repository host.

- Apple: that `imageAsset.templateUrl` serves the original bytes at the full size, and the CDN hosts other than the
  documented example (`mzstatic.com`).
- Google: that `edits.images.list`'s `url` ("a preview") serves the full size image, and its hosts
  (`googleusercontent.com`, `ggpht.com`).
- That list order equals display order on both stores.
- iMessage sets, Apple app previews and the app icon are not pulled or pushed.
- macOS: the screenshot set names of a Mac version (`APP_DESKTOP`) and that the `mac` sizes accept the four
  listed sizes are UNVERIFIED (see [ADR 0013](0013-macos-platform.md)).
