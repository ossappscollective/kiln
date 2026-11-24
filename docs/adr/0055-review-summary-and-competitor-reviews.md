# ADR 0055: Review summary v2 and competitor reviews

Status: server and web implemented, tested against fakes; **never run against a real AI provider or Apple's feed** (see the end).
API: [api/review-summary](../api/review-summary.md), [api/competitor-reviews](../api/competitor-reviews.md). Builds on [ADR 0024](0024-ai-features.md)
(the AI features) and [ADR 0011](0011-aso-keywords-competitors.md) (followed competitors). One migration (59).

## Context

The AI features already had `review_summary` (themes with evidence, counts by the server, redaction, the stored suggestion with provider, model
and tokens). What was missing for a developer who reads reviews every week: a summary that follows the filters of the Reviews page, that
shows the low-rated reviews too, that says what changed, that is written in the language of the screen, and that is not paid for twice.
Competitors were followed by store id (ASO) but their reviews were not visible.

## Decisions

1. **Build on the existing task, not beside it.** `review_summary` goes to version 2. A summary is still a row of `ai_suggestions`
   (provider, model, tokens, `createdAt`, a hash of the data); the Reviews page keeps its AI row and tray.
2. **Scope.** The app (so the store), `locale` (the stored review language filter of the page), `days` (the page offers 7, 28, 90), `limit`
   (hard cap 80, default 40, titles 80 and text 280 characters), `outputLanguage` (the language of the screen: en, fr, es, de).
3. **Sample.** The newest reviews plus a quarter of the most recent 1 and 2 star reviews, so complaints show even in a happy period. Because the
   sample leans negative, the mood (4 to 5, 3, 1 to 2 stars) and the trend (mean rating of the first and second half of the period) are counted by
   SQL over ALL reviews of the period, and a theme share says "of the reviews read" (an approximation, with a note).
4. **The server counts, the model words.** Shares, counts, means, the trend, the mood: code. The model writes labels, one sentence per theme,
   the overview and one change line. A cited review that was not sent is dropped; a theme left without evidence is removed; every citation
   links to a review of this app (internal links only). Output is validated against a strict schema and rendered as plain text.
5. **What changed.** The model receives the labels, kinds and shares (no text) of the previous summary of the same period and language and
   answers one sentence; without a previous summary the sentence is empty whatever it writes.
6. **Reuse and stale.** A run whose data is the same (hash of options and sent reviews, kept in `scope.key`, not a new column) as a
   stored, undismissed summary of the last 7 days returns it: nothing is sent, spent or audited (`cached: true`). `refresh: true` asks again.
   The screen says "Generated <time> from N reviews", and counts reviews that arrived after the newest one read (a read of our own database).
7. **Rights.** The run and the preview need `ai.use` and `reviews.read` (a token needs both). Never automatic: a button.
8. **Competitor reviews are Apple only.** Apple's customer-reviews feed is public; Google Play has no official API for the reviews of an app
   you do not own and scraping its pages is not done. A Play competitor is listed as not available, in the UI and the docs.
9. **Competitor reviews storage.** Table `aso_competitor_reviews` (migration 59) plus `aso_competitors.reviews_checked_at`. Stored: the feed's
   review id, stars, title (200), text (1,000), app version, day. Not stored: the author, in any form. Kept 90 days and 200 per competitor,
   deleted with the competitor and the app. A read is on demand (a button), at most once per 15 minutes per competitor, per storefront of the
   competitor, through the ASO SSRF-safe fetch (https, host `itunes.apple.com` only, public addresses, size and time caps), the per-process
   Apple limit and cool-down, and the per-workspace limiter. The audit entry holds ids and counts, never text.

## Privacy: what is sent to a model

Only the summary of your own reviews calls a model. Sent: the app name and store, per review the stars, title, text, language, app version and
day, the output language, and the labels and shares of the last summary. Emails, links, phone-like numbers and the reviewer's name are replaced
before sending. Never sent: reviewer names or ids, devices, countries, store review ids, replies, notes, credentials. Competitor reviews are
NOT sent to any model in this round.

## Limits

One storefront per competitor; at most 50 reviews per read (one feed page); no periodic read (on demand only); the sample is capped at 80
reviews of 280 characters, so a very large period is a sample. Cost is shown as tokens and provider and model; the estimated cost stays in the
AI settings card, where the prices live.

## Next

- Themes of competitor reviews through the same AI button (a task `competitor_review_summary`, same redaction, never mixing with your own).
- ~~A periodic read in the ASO refresh~~ and ~~a per-app switch "reviews may be sent to AI"~~: done in [ADR 0065](0065-ai-review-privacy-and-competitor-schedule.md).
- The cost estimate on the card itself; a comparison chart of our own rating and the competitors over time.

## Not verified

No real AI provider and no real Apple feed were contacted: tests use a scripted fake model and a fake feed (and a fake `fetch` for the URL).
Apple may change the feed's shape or redirect it; the parser then returns nothing and the read says 0 stored. The screens compile and
their logic is tested, but they were not seen in a browser. The Postgres variants run only with `KILN_TEST_POSTGRES_URL`.
