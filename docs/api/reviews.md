# Customer reviews

A read-only inbox of the customer reviews and ratings of an app, with internal triage (status,
assignee, a note) and two events. **Nothing is ever sent to a store.** There is no way to reply to a
review from this server: a reply is a store write, it stays gated like every other store write, and
this feature does not include it (the UI says so). A person replies in App Store Connect or in
Google Play Console, and can mark the review `replied_in_console` here to keep the inbox honest.

Never run against a real store: the connectors are tested with recorded-shape fixtures only. See
[phase-3-reviews](../phase-3-reviews.md) for what is and is not verified.

Everything is under `/api/workspaces/{workspaceId}/apps/{id}`. A non-member gets 404, a member
without the right gets 403. Rights:

| Right | Who | For |
| --- | --- | --- |
| `reviews.read` | every role (viewer and up) | list, summary |
| `reviews.sync` | member and up | read the store now |
| `reviews.triage` | member and up | status, assignee, note |

An API token may hold these like any other action, and a token limited to some apps can use them on
those apps only. The routes are in the [OpenAPI description](openapi.md) (tag `reviews`).

## What each store provides

| | App Store Connect | Google Play |
| --- | --- | --- |
| Endpoint | `GET /v1/apps/{id}/customerReviews` ([docs](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviews)) | `GET /androidpublisher/v3/applications/{packageName}/reviews` ([docs](https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/list)) |
| Reviews with no text | not stated on the page checked (a review with no body is stored with an empty body) | **no**: only reviews with a comment |
| How far back | all of them, paged newest first (this server reads at most 10 pages of 200 per sync and continues on the next) | **only the last 7 days** ([guide](https://developers.google.com/android-publisher/reply-to-reviews)) |
| Date filter | none documented: the read sorts newest first and stops | none: the whole window is read each time |
| Creation time | yes (`createdDate`) | no: only the last modified time. `createdAt` here is when this server first saw the review |
| Developer response | included (`customerReviewResponses`) | included (`developerComment`) |
| Rate limit | per key per hour, reported in `X-Rate-Limit`; the read stops with 25 left | 200 GET requests per hour per app |
| Store-wide average rating | not in the API: the public iTunes lookup is used (below) | **not available** from the Play Developer API |

Not used, and why:

- **Google Cloud Storage statistics export** (the Play Console "Statistics" reports, which include
  rating figures): it needs a separate Cloud Storage bucket and different permissions and delivers
  monthly files, not reviews. It would add a second setup for a number the stored reviews cannot
  replace. Not used.
- **Google Play Developer Reporting API**: it reports vitals (crashes, ANRs, slow starts), not
  ratings or reviews. Not used.
- **Replying** (`POST /v1/customerReviewResponses` on Apple, `reviews.reply` on Google): store writes.
  Not called anywhere in this repository.
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

| Parameter | Meaning |
| --- | --- |
| `rating` | one or more of 1 to 5, comma separated: `rating=1,2` |
| `store`, `platform` | `appstoreconnect`/`googleplay`, `ios`/`android`. An app has one store, so a different one gives an empty list |
| `territory`, `language`, `version` | exact match (`territory` is upper-cased) |
| `status` | one or more of `new`, `triaged`, `replied_in_console`, `ignored` |
| `hasResponse` | `true` or `false`: a developer response is or is not present |
| `q` | text search in title and body, up to 100 characters. `%`, `_` and `!` match themselves. Review text is only ever a stored value, never put in a URL by this server |
| `since`, `until` | epoch milliseconds on the creation time (`since` inclusive, `until` exclusive) |
| `sort` | `newest` (default), `rating` (lowest first, then newest), `updated` |
| `limit` | 1 to 100, default 25 |
| `cursor` | the `nextCursor` of the previous page, with the same filters and sort |

Answer: `{ "reviews": [Review], "nextCursor": string | null }`. A bad filter or cursor is `400
invalid_request` with `issues`.

A `Review` has `id`, `appId`, `store`, `platform`, `storeReviewId`, `rating`, `title`, `body`,
`authorName`, `territory`, `language`, `appVersion`, `buildNumber`, `device`, `createdAt`,
`updatedAt`, `firstSeenAt`, `fetchedAt`, `developerResponse` (`{ body, at, state }` or null) and the
internal fields `status`, `assigneeUserId`, `internalNote`, `statusChangedAt`, `statusChangedBy`.

`body`, `title` and `authorName` are written by customers: **untrusted text and personal data of a
third party**. Show them as plain text, never as HTML, and keep them out of URLs and logs.

### `GET /reviews/summary`

Optional `weeks` (1 to 52, default 12). Every figure carries its basis so a number is never shown
without saying what it is:

- `stored`: `basis: "stored_reviews"` and a `label` such as "From 42 stored reviews, not store-wide". Count, average, a five entry
  `histogram` (index 0 is one star), versions, territories, languages and weekly buckets (Monday UTC,
  weeks with no review included). Over at most 20000 stored reviews (`truncated` says so).
- `storeWide`: `basis: "store_wide"`, source `itunes_lookup`, territory, average, rating count and the
  same for the current version, with the time it was read. Empty for Google Play and when the
  lookup is unavailable.
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

## Events

`review.new_low_rating` and `review.sync_failed`, in the [event log](events.md), the live stream and
[webhooks](webhooks.md). They carry ids, the store and the rating only: **no review text and no
display name**, because a webhook receiver is another system. A receiver reads the review with this
API. `review.new_low_rating` is sent once per store review (also when a review is later edited down
to the threshold, 2 or less), not for the first read of an app, and at most 50 per read.
`review.sync_failed` is sent once per failure streak.

## Data protection

Review text and display names are personal data of people who are not users of this server.

- Stored only to show them to your team. They are not sent to webhooks, not put in audit entries,
  and not used to build any URL.
- `MRM_REVIEW_RETENTION_DAYS` (default 365, `0` keeps everything) deletes reviews older than that by
  the store's date, 1000 at most per run, at most once an hour in the scheduler's process.
- Deleting the app deletes its reviews, sync state and rating snapshots in the same transaction.
- Reviews are not encrypted at rest beyond what your database and disk provide.
