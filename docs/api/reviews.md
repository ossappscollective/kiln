# Customer reviews

An inbox of the customer reviews and ratings of every app, with internal triage (status, assignee,
a note), a workspace-wide inbox and summary, replies to reviews, and three events. Reading, syncing
and triage **send nothing to a store**. **Replying is the one store write, and it is off by default**
(`KILN_REVIEW_REPLY_ENABLED`, see [Replying](#replying-to-reviews) and
[ADR 0007](../adr/0007-review-replies.md)): a reply is published publicly in the store and this tool
cannot recall it.

Never run against a real store: the connectors are tested with recorded-shape fixtures only. See
[phase-3-reviews](../phase-3-reviews.md) for what is and is not verified.

The per app routes are under `/api/workspaces/{workspaceId}/apps/{id}`; the inbox, the summary, the
reply settings and the reply templates are under `/api/workspaces/{workspaceId}/reviews`. A non-member
gets 404, a member without the right gets 403. Rights:

| Right            | Who                        | For                                                                |
| ---------------- | -------------------------- | ------------------------------------------------------------------ |
| `reviews.read`   | every role (viewer and up) | lists, inbox, summaries, one review with its draft, reply settings |
| `reviews.sync`   | member and up              | read the store now                                                 |
| `reviews.triage` | member and up              | status, assignee, note; **reply drafts** and reply templates       |
| `reviews.reply`  | **admin and up**           | **send a reply to the store**                                      |

An API token may hold these like any other action, and a token limited to some apps can use them on
those apps only. **`reviews.reply` is explicit-only for tokens**: a token with no list of actions
(which means "everything the role may do") never gets it; its list must name `reviews.reply`, and the
token's role must allow it. The routes are in the [OpenAPI description](openapi.md) (tag `reviews`).

## What each store provides

|                           | App Store Connect                                                                                                                                                                                                                                 | Google Play                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                  | `GET /v1/apps/{id}/customerReviews` ([docs](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviews))                                                                                                       | `GET /androidpublisher/v3/applications/{packageName}/reviews` ([docs](https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/list))                                                                                                                                     |
| Reviews with no text      | not stated on the page checked (a review with no body is stored with an empty body)                                                                                                                                                               | **no**: only reviews with a comment                                                                                                                                                                                                                                                      |
| How far back              | all of them, paged newest first (this server reads at most 10 pages of 200 per sync and continues on the next)                                                                                                                                    | **only the last 7 days** ([guide](https://developers.google.com/android-publisher/reply-to-reviews))                                                                                                                                                                                     |
| Date filter               | none documented: the read sorts newest first and stops                                                                                                                                                                                            | none: the whole window is read each time                                                                                                                                                                                                                                                 |
| Creation time             | yes (`createdDate`)                                                                                                                                                                                                                               | no: only the last modified time. `createdAt` here is when this server first saw the review                                                                                                                                                                                               |
| Developer response        | included (`customerReviewResponses`)                                                                                                                                                                                                              | included (`developerComment`)                                                                                                                                                                                                                                                            |
| Reply (a write)           | `POST /v1/customerReviewResponses` ([docs](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-customerreviewresponses)): creates a response, or overwrites an existing one; shown as `PENDING_PUBLISH` until Apple publishes it | `POST .../reviews/{reviewId}:reply` ([docs](https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/reply), [guide](https://developers.google.com/android-publisher/reply-to-reviews)): `{ "replyText" }`, at most **350** characters, replaces an earlier reply; public |
| Reply length              | no limit documented: this server caps at 5000 (**unverified**)                                                                                                                                                                                    | 350, documented                                                                                                                                                                                                                                                                          |
| Delete a reply            | `DELETE /v1/customerReviewResponses/{id}` exists ([docs](https://developer.apple.com/documentation/appstoreconnectapi/delete-v1-customerreviewresponses-_id_)); the connector has it, **no route calls it**                                       | no delete call                                                                                                                                                                                                                                                                           |
| Rate limit                | per key per hour, reported in `X-Rate-Limit`; the read stops with 25 left                                                                                                                                                                         | 200 GET requests per hour per app                                                                                                                                                                                                                                                        |
| Store-wide average rating | not in the API: the public iTunes lookup is used (below)                                                                                                                                                                                          | **not available** from the Play Developer API                                                                                                                                                                                                                                            |

Not used, and why:

- **Google Cloud Storage statistics export** (the Play Console "Statistics" reports, which include
  rating figures): it needs a separate Cloud Storage bucket and different permissions and delivers
  monthly files, not reviews. It would add a second setup for a number the stored reviews cannot
  replace. Not used.
- **Google Play Developer Reporting API**: it reports vitals (crashes, ANRs, slow starts), not
  ratings or reviews. Not used.
- **Replying** is used, but only through the reply service (below): never by a sync, a job, a
  schedule or any automatic or bulk path.
- **Scraping** public store pages: never.

The App Store rating shown as "store-wide" comes from one public request per sync to
`https://itunes.apple.com/lookup?id=<numeric app id>&country=US` (no credential; fixed host; the id
is digits only; redirects refused; the reply is cut at 256 KiB and 10 seconds). Only the US
storefront is read. Apple documents lookup by id; the `country` parameter and the rating fields in
the answer are **unverified** against Apple's pages, so a missing field simply means "no store-wide
rating" and never an error. Apple limits this service to roughly 20 calls a minute; one per sync is far
below that.

## Routes

### `GET /reviews`

The stored reviews of the app, from this server's database. No store is contacted.

Query (all optional):

| Parameter                          | Meaning                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rating`                           | one or more of 1 to 5, comma separated: `rating=1,2`                                                                                                               |
| `store`, `platform`                | `appstoreconnect`/`googleplay`, `ios`/`android`. An app has one store, so a different one gives an empty list                                                      |
| `territory`, `language`, `version` | exact match (`territory` is upper-cased)                                                                                                                           |
| `status`                           | one or more of `new`, `triaged`, `replied_in_console`, `ignored`                                                                                                   |
| `hasResponse`                      | `true` or `false`: a developer response is or is not present                                                                                                       |
| `q`                                | text search in title and body, up to 100 characters. `%`, `_` and `!` match themselves. Review text is only ever a stored value, never put in a URL by this server |
| `since`, `until`                   | epoch milliseconds on the creation time (`since` inclusive, `until` exclusive)                                                                                     |
| `sort`                             | `newest` (default), `rating` (lowest first, then newest), `updated`                                                                                                |
| `limit`                            | 1 to 100, default 25                                                                                                                                               |
| `cursor`                           | the `nextCursor` of the previous page, with the same filters and sort                                                                                              |

Answer: `{ "reviews": [Review], "nextCursor": string | null }`. A bad filter or cursor is `400
invalid_request` with `issues`.

Each review also carries `replyDraft` (the draft, **with its text**, or null) and `reply`
(`{ status, sentAt }`, where `status` is `none`, `draft`, `sending`, `sent`, `failed` or `unknown`), so a
card can show where a reply stands. A `Review` has `id`, `appId`, `store`, `platform`, `storeReviewId`, `rating`, `title`, `body`,
`authorName`, `territory`, `language`, `appVersion`, `buildNumber`, `device`, `createdAt`,
`updatedAt`, `firstSeenAt`, `fetchedAt`, `developerResponse` (`{ body, at, state }` or null) and the
internal fields `status`, `assigneeUserId`, `internalNote`, `statusChangedAt`, `statusChangedBy`.

`body`, `title` and `authorName` are written by customers: **untrusted text and personal data of a
third party**. Show them as plain text, never as HTML, and keep them out of URLs and logs.

### `GET /reviews/summary`

Optional `weeks` (1 to 52, default 12) and `maxRating` (1 to 5, default 5; `400` otherwise). Every figure carries its basis so a number is never shown
without saying what it is:

- `stored`: `basis: "stored_reviews"` and a `label` such as "From 42 stored reviews, not store-wide". Count, average, a five entry
  `histogram` (index 0 is one star), versions, territories, languages and weekly buckets (Monday UTC,
  weeks with no review included). Over at most 20000 stored reviews (`truncated` says so).
- `storeWide`: `basis: "store_wide"`, source `itunes_lookup`, territory, average, rating count and the
  same for the current version, with the time it was read. Empty for Google Play and when the
  lookup is unavailable.
- `unanswered`: `{ count, oldestAt, maxRating }`, the stored reviews with no developer response, not
  `ignored`, rated at or below `maxRating` (default 5: every rating), and when the oldest of them was
  written (`null` with none). Counts and a time only, never a text.
- `byStatus`, `sync` (see below), `lowRatingThreshold` and `retentionDays`.

### `POST /reviews/sync`

Reads the reviews from the store now. Needs `reviews.sync`. Rate limited per workspace on the same
budget as the app sync (`429 rate_limited` with `Retry-After`). `?background=true` queues a
`review.sync` job and answers `202 { jobId }`.

Answer `200 { sync, state }`. `sync`: `at`, `fetched`, `added`, `updated`, `responses` (developer
responses that appeared, changed or went away), `skipped` (entries that could not be read),
`complete`, `gap`, `warnings`, `baseline`, `lowRatingEvents`, `ratingSummary`. `state`: the sync
state of the app: `lastAttemptAt`, `lastSuccessAt`, `lastError`, `consecutiveFailures`,
`backoffUntil`, `lastGapAt`, `moreToRead`, `lastResult`.

Behaviour:

- **Idempotent.** A review is upserted by the store's id; reading it again changes nothing. An edit
  (rating, text) and a changed or removed developer response are applied. A sync never touches
  `status`, `assigneeUserId` or `internalNote`.
- **Incremental.** Apple: newest first, from the last success minus 14 days (to catch edits and new
  responses on recent reviews); an unfinished first read continues from a saved cursor
  (`moreToRead`). Google: the whole 7 day window every time.
- **Gap warning (Google Play).** If the previous success is older than 7 days, reviews written in
  between are gone for good: `sync.gap` is `{ from, to }`, `state.lastGapAt` is set and a warning
  says so. It is shown, never hidden. Schedule the read at least every 6 hours (see
  [deployment](../deployment.md#customer-reviews-and-data-protection)).
- **One read at a time** per app and per credential in this process; a second request for the same
  app gets `409 sync_in_progress`.
- **Failures** are kept on the state (message, streak, a backoff the scheduler honours; a manual sync
  ignores it) and returned with an error code: `422 store_auth` (the store rejected the key),
  `422 store_forbidden` (the key may not read reviews, or the API is off), `422 store_not_found`,
  `422 credential_not_found`, `credential_kind`, `credential_unreadable` or `app_not_synced` (sync the
  app first so its App Store id is known), `429 rate_limited` with `Retry-After`, `502
  store_unavailable` and `504 timeout`. Nothing thrown here reaches the scheduler or the worker.

### `PATCH /reviews/{reviewId}`

Internal triage. Needs `reviews.triage`. Body, at least one of:

```json
{ "status": "triaged", "assigneeUserId": "<member id> | null", "internalNote": "text | null" }
```

`status` is `new`, `triaged`, `replied_in_console` or `ignored`. `replied_in_console` is a note by a
person that they answered in the store's own console: **nothing is sent**. The assignee must be a
member of the workspace (`422 assignee_not_member`); the note is at most 2000 characters. The change
is audited as `review.triage` with the fields that changed and the old and new status and assignee,
**never the note and never the review text**. Answer `{ review }`.

## The workspace-wide inbox

This is also the **combined reviews feed** of the web app (`#/reviews`, "Inbox" at the bottom of the left panel at the All apps
level; App Store and Google Play together, "Load more" paging, filters for store, rating, unanswered and apps, and a link to each
app's own Reviews page where the reply dialog lives) and of the MCP tool `list_workspace_reviews` (review text marked as untrusted
data). It reads only reviews already stored here and never calls a store. [ADR 0027](../adr/0027-review-feed-and-new-review-alert.md)
records why no second feed was built.

### `GET /api/workspaces/{ws}/reviews`

The stored reviews of **every app** of the workspace in one list, newest first by default. Needs
`reviews.read`. Everything `GET /apps/{id}/reviews` takes, plus:

| Parameter             | Meaning                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `appIds` (or `appId`) | one or more app ids, comma separated, at most 50. Unknown ids match nothing           |
| `assignee`            | `me` or a member's user id                                                            |
| `unassigned`          | `true`: nobody is assigned (not together with `assignee`)                             |
| `unanswered`          | `true`: no developer response; `false`: has one (the same as `hasResponse`, inverted) |

`store`/`platform`, `rating`, `status`, `territory`, `language`, `version`, `q`, `since`/`until`,
`sort` (`newest`, `rating`, `updated`), `limit` (1 to 100, default 25) and `cursor` work as for one app.
Answer `{ reviews, nextCursor }`; each review is a `Review` (with `replyDraft` and `reply`) plus `app`
(`{ id, name, platform }`). A cursor belongs to its sort and filters; a bad one is `400`.

- **Scope.** A non-member gets 404. A token limited to some apps sees only those apps, whatever
  `appIds` it asks for (an app it may not see simply contributes nothing). Members see every app of
  the workspace: this product has no per-member app visibility.
- **Paging is a keyset** on `(sort key, id)`: stable when reviews arrive between pages, equal
  timestamps neither repeat nor skip.
- **Efficiency.** Migration 21 adds `app_reviews (workspace_id, created_at, id)`, `(workspace_id,
  updated_at, id)` and `(workspace_id, rating, created_at, id)`. A page is an index range scan in the
  sort order with `LIMIT`, no sort step (a test reads the SQLite query plan for each sort). Filters
  narrow the scan; the app names come from one more query for the apps on the page. A review whose
  app no longer exists is not listed. The text search is a `LIKE` over the filtered rows: for a
  workspace with very many reviews, narrow with `appIds`/`since` too.

### `GET /api/workspaces/{ws}/reviews/summary`

Counts only, no review text and no names. Needs `reviews.read`; a limited token gets only its apps.
Optional `maxRating` (1 to 5, default 5, `400` otherwise): `unanswered` and `unansweredOldestAt` count
only reviews rated at or below it (`2`: the one and two star reviews nobody answered). With the default the
numbers are the ones older clients know; the other counts never change with it.

```json
{
  "basis": "stored_reviews",
  "label": "From 42 stored reviews across 3 apps, not store-wide",
  "lowRatingThreshold": 2,
  "apps": [
    {
      "app": { "id": "", "name": "", "platform": "ios", "store": "appstoreconnect" },
      "total": 0,
      "new": 0,
      "unanswered": 0,
      "unansweredOldestAt": null,
      "lowRating": 0,
      "average": null,
      "oldestAt": null,
      "newestAt": null
    }
  ],
  "unansweredMaxRating": 5,
  "totals": {
    "total": 0,
    "new": 0,
    "unanswered": 0,
    "unansweredOldestAt": null,
    "lowRating": 0,
    "average": null
  }
}
```

`new` is status `new`; `unanswered` is no developer response; `lowRating` is a rating at or below the
threshold. **Reviews with status `ignored` count in neither `unanswered` nor `lowRating`.** `average`
is over the stored reviews and the `label` says so: it is never the store-wide rating (see the per app
summary for that).

## Replying to reviews

**Off by default.** With `KILN_REVIEW_REPLY_ENABLED` not `true`, every route below except the reads
answers `409 reply_disabled` (`envName` names the variable) and nothing can reach a store. Reading
the review view and the settings keeps working.

`GET /reviews/reply-config` (`reviews.read`): `{ enabled, envName, limits: { appstoreconnect,
googleplay }, sendsPerHour, translation: { available }, templates: { max, placeholders } }`. The web
app reads this to decide what to show.

### The flow: draft first, then confirm and send

1. `PUT /apps/{id}/reviews/{reviewId}/reply-draft` (`reviews.triage`) with `{ "text" }` or `{
   "templateId" }` saves the draft (one per review; saving again replaces it). The text is
   **plain text**: line breaks are normalised to `\n` and the edges trimmed; control characters
   (including tabs and invisible direction overrides), HTML-looking tags and text over the store's
   limit (350 Google Play, 5000 App Store) are `422 invalid_reply` with `problem` (`empty`,
   `too_long`, `control_characters`, `markup`). Answer `{ draft }` with `text`, `textHash` (SHA-256 of
   the text), `length`, `limit` and `status`. Editing a sent reply makes it a draft again.
   `DELETE` the same path removes a draft (`204`; `409` while a send is in progress or unknown).
2. `POST /apps/{id}/reviews/{reviewId}/reply` (`reviews.reply`, admin and up) with `{ "confirmHash":
   "<textHash>" }` sends it. The hash proves the sender saw this exact text: if the draft changed since,
   `409 stale_draft` with `currentHash`, and nothing is sent. One review per request: there is **no
   bulk, scheduled or automatic send**.

Answer `200 { reply, review, confirmedByReread }`: `reply` is the draft with `status: "sent"`,
`sentAt` and `storeResponseId`; `review` has the new `developerResponse` (Apple may say
`PENDING_PUBLISH`) and a `new` review becomes `triaged`.

### What happens on the way (and the errors)

- **One send in flight per review.** The send takes an atomic claim on the draft (`status:
  sending`, with a time to live of 2 minutes). A second send meanwhile is `409 send_in_progress`; a
  repeat of a finished one is `409 already_sent` and makes no store request.
- **No retry on a write**, not even for a 429: a repeated POST could overwrite a newer reply. The
  request has a 60 second timeout.
- **A refusal by the store** (nothing published): the draft is kept with `status: failed` and an
  `errorCode`, and can be sent again once fixed: `422 store_auth`, `store_forbidden` (the key may not
  reply, the API is off, or Apple answered 405: see [credentials](../credentials.md#replying-to-reviews)),
  `store_not_found`, `store_rejected`, `invalid_reply`, `credential_not_found`/`credential_kind`/
  `credential_unreadable`/`app_not_synced` (the claim is given back, nothing was asked of the store),
  `429 rate_limited` with `Retry-After`.
- **An unknown outcome** (a timeout, a cut connection or a 5xx: the store may or may not have applied
  it) is never retried. The service **reads the review back** from the store: if the stored reply is
  this text the reply is `sent` (`confirmedByReread: true`, the evidence, without text, is kept on the
  draft); if it is not there the draft is `failed` with `502 send_failed` and `outcome: "not_applied"`;
  if the read-back fails too the draft is `unknown` (`409 outcome_unknown`): it cannot be edited or
  deleted, and sending again **only re-checks** (it publishes only if the reply is not there).
  A claim that expired (a process died mid-send) is treated the same way.
- **Rate limit:** at most 30 sends an hour per workspace (`429 rate_limited`; counted from the audit
  log plus sends in flight, so it holds across restarts and processes). The stores have their own
  quotas (Google: 2000 reply requests a day per app).
- **Audit and events carry no text.** `review.reply_draft`, `review.reply_sent` and
  `review.reply_failed` are audit entries with the review and app ids, the store, the length and the
  hash: **never the text**. The event `review.reply_sent` carries ids only. The text is in the draft
  row and in the store, nowhere else (not in logs, jobs or webhooks).
- The text is plain text and is never interpolated into a prompt, a URL or markup by this server.

### Templates and the translation seam

`GET /reviews/reply-templates` (`reviews.read`), `POST` and `PUT /{id}` with `{ name, body }`, `DELETE
/{id}` (`reviews.triage`; off with the kill switch). At most 50 per workspace (`422
too_many_templates`). A body may use `{{author}}` and `{{app}}` only; they are filled in as plain
text (one line, at most 60 characters, no markup or control characters) when a draft is saved with
`templateId`. An unknown placeholder or a stray `{{` is `422 invalid_template`.

`POST /apps/{id}/reviews/{reviewId}/reply-draft/translate` with `{ text, target, source? }` is an
optional seam: it answers `{ text }` only when the server was given a translator, else `409
translation_unavailable` (`reply-config.translation.available` says which). It saves nothing and
sends nothing; the result is a suggestion that goes through the same checks when saved as a draft.

## Events

`review.new`, `review.new_low_rating`, `review.sync_failed`, `review.reply_sent` and `review.unanswered`, in the [event log](events.md), the live stream and
[webhooks](webhooks.md). They carry ids, the store and the rating only: **no review text and no
display name**, because a webhook receiver is another system. A receiver reads the review with this
API. `review.new` is sent for every review that is new in a read: one event each up to 10 per read, and ONE grouped event
(`grouped: true`, `count`) for the first read of an app or a read with more than 10 new reviews. It feeds the alert
`review.new` ([alerts](../alerts.md)). `review.new_low_rating` is sent once per store review (also when a review is later edited down
to the threshold, 2 or less), not for the first read of an app, and at most 50 per read.
`review.sync_failed` is sent once per failure streak. `review.reply_sent` is sent when a reply was
published (ids, store and the actor only, no text). `review.unanswered` is an opt-in digest (workspace
setting `reviews.unansweredReminderHours`, default `0` = off, and `reviews.unansweredMaxRating`): counts
per app and the time of the oldest unanswered review, at most one per interval; no text, title or name
([events](events.md#release-watch)).

## Data protection

Review text and display names are personal data of people who are not users of this server.

- Stored only to show them to your team. They are not sent to webhooks, not put in audit entries,
  and not used to build any URL.
- `KILN_REVIEW_RETENTION_DAYS` (default 365, `0` keeps everything) deletes reviews older than that by
  the store's date, 1000 at most per run, at most once an hour in the scheduler's process.
  The same setting prunes the stored TestFlight feedback and crash reports ([testflight-feedback](testflight-feedback.md)), and the
  review job also reads TestFlight for Apple apps after the reviews of the same app.
- Deleting the app deletes its reviews, sync state and rating snapshots in the same transaction.
- Reviews are not encrypted at rest beyond what your database and disk provide.
- A reply draft and the template bodies are stored as plain text. A draft is deleted with its review
  (retention) and with the app. The audit log never holds a reply's text, only its length and hash.
