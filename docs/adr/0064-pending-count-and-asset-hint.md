# ADR 0064: Pending changes across the workspace, and the asset proposal on the Releases list

Status: server and web implemented, tested against fakes; **not viewed in a browser**. No migration.
API: [api/pending](../api/pending.md) (`GET /pending/cart-summary`), [api/release-asset-proposal](../api/release-asset-proposal.md) (`GET .../asset-proposal/summary`).
Builds on [ADR 0054](0054-pending-cart.md) (the cart) and [ADR 0063](0063-release-asset-proposal.md) (the proposal).

## Context

The cart (ADR 0054) is per app: a floating button shows what one app has staged. Someone who works across several apps had no way to see, from
anywhere, that changes were waiting in another app. The release asset proposal (ADR 0063) appeared only inside the Assets step of "Prepare
release", so a person had to open the stepper to learn there was something to review.

## Decision

1. **A workspace "Pending" entry in the left nav**, in the Workspace group beside All apps and Inbox (`app-nav.ts` `RAIL_MAIN`, view `pending`,
   needs `listing.read`). Not on the app switcher: the switcher picks an app, this answers "what is waiting anywhere". Its badge is the usual
   `nav-count` (accent tone, a count above 99 reads `99+`), visible as a small badge in the collapsed rail; the accessible name carries the count in
   words: "12 pending changes across 4 apps" (changes are items of the carts, apps are products: the records of one product are merged as in the switcher).
2. **The count is the carts' own.** `GET /pending/cart-summary` finds the apps that hold anything with three small queries (an unpushed staged change,
   a staged price, a reply draft in a state the cart lists), builds the cart of only those apps with the function behind `GET /apps/{id}/pending/cart`
   and returns counts per app and kind, no item. So an app's count equals the length of its cart (tested), nothing is a second definition. It needs
   `listing.read`, a token limited to some apps sees only those, another workspace sees nothing (404 for a non-member). At most 200 apps are read.
3. **The count stays true without polling.** The shell reads it once on first paint and when the window gets focus again or becomes visible (not
   more often than every 30 seconds), and once, after 400 ms of quiet, after any `kiln:staged-changed` (stage, unstage, discard, publish, reply draft
   saved or deleted: the one invalidation of `lib/staged-sync.ts`). A burst is one read; a change of workspace drops the old count and ignores its late
   answer; a failed read keeps what was shown. `lib/cart-summary.ts` holds it, tested.
4. **The overview is a list with links, not a second cart.** The Pending page lists the apps with their number of changes and the kinds ("Store
   listing 2 · Graphics 1"), and "Open cart" goes to that app and opens ITS cart drawer (`queueCartOpen`, consumed once the app's records are
   known). Review, publish and discard stay in the per app drawer with all their rights, switches and step-up; nothing is published across apps.
5. **The asset proposal on the Releases list is a count from a cheap endpoint.** `GET /apps/{id}/release/asset-proposal/summary` returns counts only
   for the app's editable release. It reads nothing when there is no repository or the proposal was skipped; otherwise it answers from a cache (10
   minutes) keyed by what Kiln stores about the inputs (the repository as last read, the store as last read, the cart, the decision, the releases;
   no request to find out), computes once at a time per app and at most twice at once overall (`busy`), and gives up after 8 seconds (`computing`:
   the work finishes in the background and the next read is cached). The Releases page asks after it has drawn and again when the cart of the app
   changes; the line "3 store asset changes proposed" with "Review" (to the Assets step) sits under the Prepare release card, only for an app with a
   repository, not skipped, with something proposed ("remind later" still shows it).
6. **The header Sync follows the focused app.** Not part of this feature but found with it: the run state of the header Sync was one record for the
   whole page and an app switch left it behind (see ux-ia 0). It is now cleared on an app change and every reader takes only the runs of its own app.

## Consequences

- The cart summary builds a cart per app that holds something; for a workspace with dozens of apps each holding changes, a read costs dozens of
  small queries. The cap and the 30 second floor on focus bound it; a cheaper per kind SQL count would drift from the cart (the "unchanged" rule).
- The proposal count can lag the repository by up to 10 minutes when nothing in Kiln changed (a push to the repository is not seen until Kiln
  reads it); the card in the Assets step always computes fresh.
- A Google Play app with a draft in several tracks counts the newest editable release only.
- The nav entry also exists in the non-app navigation (same view list).

## Not verified (UNVERIFIED)

Not viewed in a browser (the badge in the collapsed rail, the page, the line, dark mode, screen reader wording). Not run against a real repository,
store or Postgres (the Postgres variants of the tests skip without `KILN_TEST_POSTGRES_URL`). Timing of the 8 second cut-off and the 10 minute TTL
are chosen, not measured. The cache is per server process (several instances each keep their own).
