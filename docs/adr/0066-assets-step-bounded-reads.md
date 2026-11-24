# ADR 0066: The Assets step always ends: bounded reads, an explicit comparison table

Status: accepted (2026-11-24). Builds on [ADR 0063](0063-release-asset-proposal.md) and [ADR 0064](0064-pending-count-and-asset-hint.md).

## Context

On Prepare release, step 3 (Assets) showed two grey loading bars for ever ("Store assets changed in the repository" and the screenshot comparison), with "Compare again" disabled; "Stage selected" on the card could stay busy for ever too. Cause: no read or write of the step had a limit as a whole. A comparison reads the store, indexes the repository (a call with its own 90 s limit), reads up to 60 repository files for checksums one after the other, and the proposal does this at two commits and then the staging request did it again, plus a third time for the answer. A slow repository or store therefore kept the request open for minutes (worst case far longer), the web client had no timeout (`fetch` without an abort), the read cache joined every later read to the stuck request, and the `loading` / `busy` flags are only reset when the request ends, so the page stayed in "comparing" and "Compare again" (disabled while loading) could not be used as a retry.

## Decision

1. **Server deadlines.** `GET assets/diff` and `GET release/asset-proposal` stop after 25 s with `504 compare_timeout` (code `assets.compareTimeout`); `POST .../stage` after 45 s with `504 stage_timeout` (`assetProposal.stageTimeout`). The checksum reads of one comparison stop after 12 s (the rest is compared by size, with a note), and the item loop of staging stops at 35 s and answers the items it did not reach `failed` / `stage_timeout`. The answer of a stage request carries "what is left" only when it is read within 15 s; otherwise the client reads the card again. Work that was started finishes in the background and its repository index is cached, so asking again is usually quick. Tests shorten the limit with `assetSync.compareDeadlineMs` (staging gets twice that).
2. **Client bounds.** `lib/bounded-read.ts` `settle()` runs a request with an abort after 30 s (60 s for staging, 15 s for saving a decision) and returns the outcome as a value: it never throws and never stays pending, so a flag set before it and cleared after it is always cleared. Both cards use it; the read cache therefore never holds a stuck request.
3. **Every failure is visible and retryable.** A coded error becomes a translated message with "Try again"; "Compare again" is the same retry and is disabled only while a request is really in flight. After a staging timeout the card reads again (some items may be staged) and the cart count is refreshed.
4. **The comparison is explicit.** The step compares the repository (local screenshots) with the store on its own, without the `compareMedia` / `compareRepo` app settings (they stay about the warnings of the Store listing and Graphics pages). The answer carries `repoStatus` (`ok`, `no_repository`); the step shows a compact table per language and device (screenshots in the repository, in the store, one status: changed, missing in the store, only in the store, probably the same, same; a link to the Graphics tab), "No repository linked" or "Nothing to compare" as explicit states, at most 60 rows.
5. **The card's rows are a component** (`AssetProposalRow`, with an `extra` snippet) so a fuller comparison can be added under an item without changing the card.

## Not verified (UNVERIFIED)

Not viewed in a browser (the table, dark mode, keyboard). Never run against a real repository, store or Postgres. The 25 s / 45 s limits are a judgement: a very large first read of a repository may need a second click (the index is then cached). The hang itself was reproduced only with fakes that never answer.
