# ADR 0059: Listing fixes staged through the cart

Status: core, server and web implemented, tested against fakes; **not viewed in a browser**. No migration.
API: [api/listing](../api/listing.md#one-click-fixes-of-the-listing-checks). Builds on [ADR 0051](0051-insights.md) (the listing checks) and [ADR 0054](0054-pending-cart.md) (the cart).

## Context

The listing checks said "Keywords is 101 bytes, over the limit of 100" and left the person to count, cut and retype. Some of those fixes are mechanical;
others (shortening a name) change the wording and must stay a person's decision.

## Decision

1. **Only mechanical fixes are automatic**, as pure functions in `packages/core/src/listing/fixes.ts` (`proposeFixes`, `analyzeFixes`): Apple keyword hygiene
   (trim, collapse spaces, empty and repeated terms, trailing commas), dropping terms the name or subtitle already index, dropping whole trailing terms to fit
   the byte limit (UTF-8 bytes; index terms first, last first; never a cut word, never an empty field), and collapsing stray white space in a text that is over
   its limit only because of it. Repeated terms use the same folding as the check (case, accents, English plurals), so a fix settles the finding it answers.
2. **Prose is never truncated.** An over-long name, subtitle, title or description gets `shorten_ai` (the existing `listing_improve` suggestion, drawn only
   when AI is on, accepted by a person, staged by its own accept path) and `edit_field` (the editor with the counter). A required field left empty gets
   `edit_field`: no invented text. The existing "Stage from repository" actions are unchanged.
3. **Every fix is checked again** with `checkListing` on the fixed text: a fix that would leave its finding is not offered, and the finding is reported in
   `cannot[]` ("cannot be fixed automatically").
4. **The server is the author.** `GET /apps/:id/listing/fixes` computes the fixes from the stored values (the staged text of a field where there is one, else
   the store's). `POST /apps/:id/listing/fixes/stage` `{ locale, field, fixId, beforeHash? }` computes them again and stages the match through `stageText`
   (same gates and audit, `source: local`), plus a `listing.fix_staged` audit entry with ids and hashes. A client cannot send text; a changed text is `409
   stale_fix`, a fix that no longer applies `409 fix_not_available`.
5. **The cart reflects it.** The staged value is an ordinary staged text (before and after in the cart, nothing published). `afterPending` re-runs the checks on
   the staged values: the finding row says "Fix staged" with "Discard", and the counts say "after pending changes".
6. **UI.** `ListingChecks` (Store listing page) and the locale panel (`FixBar`): a "Fix" button per fixable finding, "Fix all that can be fixed (N)" per
   language and for the app, a review modal (`FixReview`) with removed terms struck through or a word diff and the counter, then "Stage fix". Off, with the
   reason in words, for a locked version (live or in review), a role without `changesets.write`, and the App Store name and subtitle (a draft push cannot write them).

## Consequences

- The locked-version rule exists only in the web (`lockedPlatforms`), like every other staging control; the server does not know which version the page shows.
  The push preview still refuses a store with no editable version.
- The App Store name and subtitle can be reported but not staged (they are app information): their fixes say what to change and offer the editor to work out the text.
- Apple's own keyword rules were not verified against App Store Connect (UNVERIFIED): comma separated, no spaces after commas, 100 bytes, the field the checks already use.

## Not verified (UNVERIFIED)

Not viewed in a browser. Never run against a real store or Postgres.
