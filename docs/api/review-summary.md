# Review summary

`POST /workspaces/{workspaceId}/ai/tasks/review_summary/run` (and `/preview`, which returns exactly what a run would send and calls no provider). It is the
`review_summary` task of the AI features (docs/ai-features.md, docs/api/ai.md), version 2. Rights: `ai.use` and `reviews.read`; a token needs both.

## Body

| Field            | Meaning                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `appId`          | Required. The app (so the store: an iOS and an Android app are summarised separately).                                          |
| `days`           | 1 to 180, default 30 (the screen offers 7, 28, 90).                                                                              |
| `limit`          | 5 to 80, default 40: the hard cap of reviews sent. A quarter of them (from a limit of 8) are the most recent 1 and 2 star reviews, the rest the newest of all. Each is cut to 80 characters of title and 280 of text. |
| `locale`         | Only reviews stored with this language code (`fr`). Default: all languages. The reviews are sent in their own language.         |
| `outputLanguage` | `en`, `fr`, `es` or `de`: the language of the overview, the labels, the sentences and the change line. Default `en`.             |
| `refresh`        | `true`: ask the model again even when a stored summary has the same reviews.                                                     |

## Answer

`201 { suggestion, warning, cached }`. `cached: true` means a stored summary of the same data (same options and same reviews, up to 7 days old, not dismissed)
was returned: nothing was sent, no tokens were spent, nothing was audited. `suggestion.createdAt`, `provider`, `model` and `usage` say when, by what and at what
size it was made. `suggestion.proposal` is the `review_summary` insight (docs/api/ai.md) plus, in version 2: `themes[].share` (0 to 1, of the reviews read),
`trend` (mean rating of the first and of the second half of the period over ALL reviews, with counts), `sampled` (`newest`, `lowest`), `changes` (one sentence, empty
without an earlier summary), `previousAt`, `latestReviewAt`, `reviewIdsUsed`, `locale`, `outputLanguage`. `sentiment` counts every review of the period, not the sample.

Every number is counted by the server. A cited review (`refs`) that was not in the data is dropped and said so in `notes`; a theme left with none is removed. Review
text is untrusted: it is a JSON string in the data, the prompt says so, the answer must match a strict schema, and it is shown as plain text with links that only open
reviews of this app.

## What is sent, and what is not

Sent: the app name and store, the stars, title, text, language, app version and day of the reviews read, the output language, and the labels, kinds and shares of the last
summary. Email addresses, links, phone-like numbers and the reviewer's name are replaced by markers first. Never sent: reviewer names or ids, devices, countries, store
review ids, replies, notes, credentials. The audit entry (`ai.run`) holds ids, a hash and token counts, never text. Nothing is sent unless AI is on for the workspace and
the caller may use it.

## Errors

The usual AI errors (docs/api/ai.md): `no_reviews` (422), `ai_input_too_large`, `ai_budget_exhausted`, `ai_cost_cap_reached`, `ai_invalid_output`, and `403` without `reviews.read`.
