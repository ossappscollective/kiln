# ADR 0027: A new-review alert, and the combined reviews feed that already existed

Status: implemented and tested on SQLite against fakes. The PostgreSQL cases of the tests were skipped (no Postgres in the build
environment) and the web screens were not opened in a browser.

## Context

The request was to "follow reviews on iOS and Android": be told about every new review, and read the reviews of all apps and both
stores in one place. Two parts:

1. **An alert for every new review.** Only a low-star review raised an alert (`review.low_rating`, from the event
   `review.new_low_rating`).
2. **A combined feed.** A workspace-level page listing the newest reviews of every app, with filters, paging and a link to the app's
   own Reviews page. This already exists: the Reviews inbox (`#/reviews`, "Inbox" at the All apps level of the left panel,
   `ReviewsInbox.svelte`), backed by `GET /api/workspaces/{ws}/reviews` (cursor paging, `store`/`platform`, `rating`, `unanswered`,
   `appIds`, `assignee`, text search), the OpenAPI operation `listWorkspaceReviews` and the MCP tool `list_workspace_reviews`. See
   [api/reviews](../api/reviews.md#the-workspace-wide-inbox).

## Decision

1. **No second feed.** A second page and a second route would duplicate the inbox, its filters, keyboard triage and reply hand-off.
   The inbox stays the feed; docs now say so ([ux-ia](../ux-ia.md), [api/reviews](../api/reviews.md)). The six-item app rail is
   unchanged.
2. **A new event `review.new`**, written by the review read for every review that is new in that read, with ids, store, platform and
   rating only (never a title, a text or a name, like the other review events). It is in the event types, in the webhook
   choices of the web app (a server test keeps the two lists equal), in the demo and in the docs.
3. **A new alert type `review.new`** ("A new customer review", info, scope app, audience `reviews.read`), **inbox only by
   default**, with the usual per-person, per-app and workspace rule settings, mutes, mail, desktop and webhook channels allowed.
   It appears in the settings matrix from the catalog; no screen code was added.
4. **Grouping instead of flooding.** The read sends one event per new review only when at most `MAX_NEW_REVIEW_EVENTS_PER_SYNC`
   (10) are new and it is not the first read of the app. The first read, and any read with more, send **one grouped event**
   (`grouped: true`, `count`, `baseline`), which becomes one alert "N new reviews for App". The same limit applies to webhooks, so
   a receiver is not flooded either. A first read is a grouped alert and not silence, as asked; people who find that noisy for an
   app they just connected can mute the type for it. The existing caps still apply (30 alerts per type and hour, folded after that).
5. **Privacy.** The alert text holds the app name, the rating, the store and counts. A few characters of the title were allowed by
   the request but are not used: the event goes to webhooks too, and the title adds no information the inbox does not give.
6. **Dedupe.** A single alert is keyed by the review id (once per review, 30 days). A grouped alert is keyed by the app and the time
   of the event, so two reads are two alerts and a repeated read of the same reviews raises nothing (a review is new only once).

## Consequences

- A workspace with a webhook on `*` now also receives `review.new` events (one per new review, at most 10 per read per app).
- `review.new` and `review.new_low_rating` can both come from one review: the first answers "something arrived", the second "it is
  bad". Someone who wants only the second leaves `review.new` off, which is the default for mail and desktop.
- A "new review" is as fresh as the last review read of the app (scheduled or by hand), not as the store.

## Not done

- A review that was edited (rating or text) is not new again; a changed rating still raises `review.new_low_rating` as before.
- No per-app threshold for the grouping limit; it is a constant.
- No change to the inbox screen: no new filter or column was needed.
