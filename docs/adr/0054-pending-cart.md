# ADR 0054: The pending cart

Status: server and web implemented, tested against fakes; **never run against App Store Connect or Google Play** (see the end).
API: [api/pending](../api/pending.md#the-pending-cart). Builds on [ADR 0015](0015-pending-and-batch-publish.md). No migration.

## Context

Play Console and e-shops have one "cart": every change you prepare is added to it, you review all of it in one place, then send all
or only some of it. Here the same facts were spread over three screens: staged listing texts, graphics and release fields (the
staging area, pushed to a store draft), reply drafts of reviews, and the publish page of ADR 0015. `PendingBar` was a slim strip that
only linked to the publish page and knew nothing about replies.

## Decision

1. **One read model, no new state.** `GET /apps/{id}/pending/cart` returns a flat list of typed items: `listing` (a staged text),
   `graphics` (a staged set), `release` (a staged release field), `review_reply` (a reply draft). Each is an adapter over an existing
   table (`staged_changes`, `review_reply_drafts`); nothing is copied. An item carries title, excerpts (`summary` = new text,
   `before`), platform, locale, author, `risk`, `needsApproval`, `publishable` and, when not, a `reason` code (`no_right`,
   `switch_off`, `invalid`, ...). An item the caller cannot publish is listed with its reason and cannot be selected.
2. **Only what is unsent is in the cart.** Pushed drafts waiting for submit, versions in review, approved versions and rollout steps
   are irreversible steps with typed phrases and stay on the publish page ([ADR 0015](0015-pending-and-batch-publish.md)); the cart
   links there. Nothing irreversible can be sent from the cart.
3. **Publish delegates, never re-implements.** `POST /apps/{id}/pending/publish` takes `{ id, version }` pairs and calls
   `previewDraftPush` + `applyDraftPush` (staged changes: a store DRAFT, nothing is submitted) and `sendReviewReply` (public at once)
   with their switches, rights, step-up, claims, re-reads, rate limits and audit. The cart adds one audit entry per call (ids and
   outcome codes, never text). "Publish" in the cart is therefore each kind's own send, said plainly in the dialog.
4. **Subsets, with one honest limit.** The push of staged changes writes the whole staged set of an app, so staged items form a
   **bundle**: all or none. A request that names part of a bundle is skipped (`bundle_incomplete`); the web selects a bundle as one.
   This also guarantees that nothing is pushed that the request did not name (a change staged in another tab after the list was
   loaded is not sent). Replies are independent: any subset.
5. **Stale content is never sent.** The request carries each item's `version` (a hash of its content). A changed item is skipped
   (`changed_since_review`), a gone one is skipped (`not_pending`), so repeating a request is safe.
6. **One failure never blocks the others.** The answer is 200 with `ok | failed | skipped` and a reason code per item.
   `POST .../pending/discard` removes Kiln's draft only (`unstage`, `deleteReplyDraft`; no store is contacted), per kind rights.
7. **Web.** A compact button in the top bar (next to the account menu; it was a floating button at the bottom right until it covered primary buttons such as the wizard's Next) with the count opens the shared right drawer: groups per kind, a checkbox per row
   (bundle rows move together), select all/none, "Publish N selected" with a confirm that states the count and the stores, "Discard
   selected", per item progress and reasons afterwards. It replaces `PendingBar`; pure logic is in `lib/pending-cart.ts`. A page that
   stages something calls `announceCartAdded()`: the button pulses once (not with reduced motion) and a toast says so.

## Not in this change (Next)

- Publishing part of the staged set: needs a push that writes only chosen rows (the preview and its confirm hash are per app today).
- Submit, release and rollout in the cart: they need typed phrases; they stay on the publish page.
- A workspace-wide count endpoint for the navigation (the existing `GET /pending/summary` counts staged and store items, not replies).
- Reply drafts exist already (`review_reply_drafts`: draft first, then confirm and send), so no draft or queue state was invented.

## Not verified (UNVERIFIED)

Publishing against real stores never ran: the push and the reply send are exercised with fakes only, and the screens were not viewed in a browser.
