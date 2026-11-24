# AI features

What the assistant can do for reviews, the store listing and ASO, where to find it, and what it sends. It is built on the AI foundation
([ADR 0016](adr/0016-ai-foundation.md), [route reference](api/ai.md)); the reasons for the choices below are in [ADR 0024](adr/0024-ai-features.md).

**The rule, again.** Every feature turns stored data into a **suggestion or a report** that a person reads. It never pushes, submits,
publishes, releases, rolls out or sends anything. Accepting a suggestion calls something that already exists (track keywords, stage a text,
save a reply draft) and a staged text still reaches a store only through Pending changes. A report is read and marked as reviewed; marking it
changes nothing else. The assistant is off by default (the server switch `KILN_AI_ENABLED` and the workspace setting) and every control below
is **not drawn at all** while it is off, or for a role that may not use it.

## Where things are

| Where                                                   | What                                                                                                                                                                 | Task                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| App, Reviews, under the rating summary                  | **Summarise**, **What to fix next**, **Tag reviews** and a period (7, 30, 90 days). The reports open in a tray of that app; tags show as small labels on each review | `review_summary`, `fix_next`, `review_classify`          |
| A review, "Reply"                                       | **Draft reply** (existing). The tone and voice come from the app's AI context                                                                                        | `review_reply_draft`                                     |
| Insights, ASO, overview                                 | **ASO health report** per app with data                                                                                                                              | `aso_health`                                             |
| Insights, ASO, Ideas                                    | **Suggest keywords** (existing) and **Ideas from reviews**                                                                                                           | `keyword_ideas`, `keyword_ideas_reviews`                 |
| Insights, ASO, Store listing, under the terms of an app | **Audit this language**, **Suggest variants**, **Translate into this language** (from another stored language), with an optional goal                                | `listing_audit`, `listing_variants`, `listing_translate` |
| Listing, a field of a language                          | **Suggest with AI** in the field editor and in the locale drawer (was "Improve"); shows the text now and the suggestion, then Stage or Dismiss                       | `listing_improve`                                        |
| App settings, "AI assistant"                            | The **AI context** of the app (admins edit, members read)                                                                                                            | none                                                     |
| Workspace settings, "AI assistant"                      | Provider, model, key, token budget, **soft warning**, **prices and cost cap**, usage by task                                                                         | none                                                     |

The first time a person runs a task in a session, a small popover says who receives the data and lists what is sent and what never is.
**Show exactly what will be sent** in it reads the real data of this run from our own database (`POST /ai/tasks/{id}/preview`: nothing goes
to a provider and nothing is spent) so the person can read it before saying yes. "Don't ask again for this task" is kept in the browser
(localStorage) per task, task version and provider: a new version or another provider asks again.

## What a keyword suggestion means

A keyword idea names a listing field, for example "Where it would go: Title". That is a **suggestion of where the keyword could be used**,
and it says so: "This is a suggestion for what to put there. Nothing changes until you stage it." Accepting an idea only **tracks** the keyword
(so its rank is followed); it never edits the listing. To use the keyword in the listing, press the button under the idea, "Stage in title",
"Stage in keyword field", "Stage in short description" and so on. It opens the field editor with the keyword added to the stored text: you see
the text before and after and the character or byte budget, change it as you like, and press Stage. Staging saves in our own database; a push
to a store is still the previewed, confirmed step of the staged changes. For the App Store name and subtitle, which a draft push cannot write,
the button says "Draft in title" and the editor is for working the text out and copying it.

A suggested text (Improve, variants, translation) shows what the field says now beside the suggestion with the changes underlined, and its
button names the field ("Stage in keyword field"). In the field editor the same suggestion is asked for with "Suggest with AI". The privacy
line and "Show exactly what will be sent" are unchanged.

## The AI context of an app

Written once per app, so it is not retyped in every request: what the app is (600 characters), who it is for (300), the tone in a few words
(120), how you sound (600), **words never to use**, **names to keep exactly as written** (up to 30 each) and up to 8 "always" and 8 "never"
rules. Only the filled-in parts are sent, and only to tasks that use it (not to the review tagger). The prompts treat it as the developer's
instructions: the review text and the data stay delimited as data.

It guides a model; it does not bind it. So the server checks the answer too: a suggestion that contains a banned word (whole word, any
language) gets the flag `banned_term` and **cannot be accepted** as it is; a translation that dropped a protected name gets `brand_term_missing`.
Do not put secrets or customer data in it: it goes to the provider with every suggestion for that app.

## Reviews

All three read the reviews stored here (nothing is fetched from a store). Before they are sent, each review is **minimised**: email addresses,
links, phone-like numbers and the author's name are replaced by `[email]`, `[link]`, `[number]`, `[name]`; the author, the device, the
territory and the store ids are not sent at all. A review is cut to 2,000 characters. **Per app you choose what may leave** (app settings, "Privacy and AI", [ADR 0065](adr/0065-ai-review-privacy-and-competitor-schedule.md)): your own reviews and followed competitors' reviews each on, off or following the workspace (the workspace setting is the ceiling and an app cannot widen it), and the form: text without names (default: stars, title and text; no name, language, app version or date), full (adds language, version and day, never a name) or ratings and counts only (no text; the summary is statistical and the tasks that need text are refused). Emails, links, phone-like numbers and @handles are replaced before sending unless you turn that off (names are always removed). Everything is enforced on the server (`409 ai_reviews_disabled` / `ai_reviews_need_text`); "Preview payload" shows the first 3 reviews as they would be sent; turning a switch off keeps old summaries (labelled), and "Delete AI summaries for this app" removes them. No AI task sends competitor reviews today. The ids a model sees are short aliases (`r1`, `r2`, ...).

- **Summarise** (`review_summary`, version 2: see `docs/api/review-summary.md`). Follows the page: the app, the language filter and a period of 7, 28 or 90 days. Reads at most 40 reviews (at most 80): the newest and a quarter of low-rated ones (1 and 2 stars). Written in the language of the screen; the reviews keep theirs. A theme has an approximate share (counted by the server over the reviews read), the mood and the half-by-half trend are counted over every review of the period, and a line says what changed since the last summary of the same period and language (the model gets only the labels and shares of that summary). The same reviews reuse the stored summary (7 days; nothing is sent), a line says how old it is and how many reviews came after, and _Summarise again_ makes a new one. Needs `reviews.read` on top of `ai.use`. Older text of this bullet: the newest reviews with text in the period (40 by default, at most 80). The answer: an overview and a list
  of themes (problem, praise, request) each with the reviews that show it. **The server counts**: how many distinct reviews each theme cites,
  their mean stars, and the shares of 4 to 5, 3 and 1 to 2 stars. The model never supplies a number. A cited id that was not sent is dropped,
  and the report says so. A larger inbox is sampled (the newest) and the report says how many of how many it read.
- **Tag reviews** (`review_classify`). A topic list (from a fixed vocabulary of 17), a sentiment, a severity, a language and "needs a reply" per
  review, 20 per run (at most 40). Tags are **advisory labels**: they change nothing about the review. They are stored per review with the task
  version and a hash of the text, so a review is **paid for once**: tagged reviews are skipped, and an edited review or a new task version is
  tagged again. When nothing is left, the run is refused with `nothing_to_do` before anything is sent. Not-tagged-yet reviews are the newest first.
- **What to fix next** (`fix_next`). Only reviews of 3 stars or fewer. The answer: a ranked list of problems with a reason, an area and a severity,
  and a **draft for "What is new"**. The server counts reviews per problem, per **app version** (from the review's own version), and the complaints
  and mean stars per version. The draft is checked against the store's limit (4,000 characters on the App Store, 500 on Google Play: `over_limit`)
  and for promises (`risky_promise`). It is a text to copy: it is not staged.
- **Draft reply** (existing, version 2). The tone comes from the AI context when it has one. The review is redacted before it is sent. The draft is
  flagged `personal_data` (blocks: an email, link or number appeared) and `risky_promise` (warns), besides `markup` and `over_limit`. The reply language
  defaults to the language of the review. A draft is saved as a draft; sending is a separate, confirmed call.

## ASO

- **Audit this language** (`listing_audit`). The **server counts** the length of every field against its limit and the coverage of the tracked
  keywords (which field holds each, and its rank). The model writes findings with an impact, a recommendation and its reasoning, and may only name
  keywords the app tracks. It is told it has no search volume: a finding that states a rank the data does not hold gets `unverified_number`.
- **ASO health report** (`aso_health`). Combines the coach steps, the keywords whose rank changed in the last 4 weeks and the totals of the last
  28 days against the 28 before into five prioritised actions. Counts (`basedOn`) are the server's. It reads only data that already exists here.
- **Ideas from reviews** (`keyword_ideas_reviews`). Keyword ideas from the words customers use, with a short reason, a relevance and the sources. They
  arrive as the usual keyword proposal: sorted acceptable first, then by relevance; a competitor's name is flagged `invalid_term`; accepting tracks
  the chosen terms (tag `ai`) like the other ideas. The original `keyword_ideas` task is unchanged apart from taking the context (version 2).
- **Suggest variants** (`listing_variants`). Two to five alternatives for each of: App Store subtitle, promotional text, "What is new"; Google Play
  title, short description. The person picks **at most one per field**. Accepting stages the chosen text (source `ai`). A **subtitle cannot be staged**
  (a draft push cannot write it), so its variants are shown for copying and cannot be accepted. "What is new" alone needs a goal (`goal_needed`) so it is
  about something true.
- **Translate** (`listing_translate`). The stored text of one language into another, field by field, as the usual listing-text proposal. Names listed in
  `brandTerms` must survive (`brand_term_missing` if not). `name` and `subtitle` are shown for copying (not stageable). Limits are checked in the store's
  unit; an over-long translation is kept for reading and cannot be accepted.

## Settings, cost and what is sent

- **Budget and cost.** The token budget is unchanged. New: **prices** (dollars per million tokens, from your provider's price list), a **monthly cost
  cap** and a **soft warning** share (default 80%). The cap refuses a run whose estimate would pass it (`ai_cost_cap_reached`), like the budget does. The
  warning only informs: a run near a limit shows one message ("82% of the monthly token budget is used. Runs still work; they stop at 100%"), and the
  settings card shows the same with the estimated cost and a list by task. The estimate is not a bill: prices are typed by an admin and a provider may
  bill differently (caching, rounding, taxes). A model on your own machine costs nothing: leave the prices empty.
- **Data minimisation.** Each task sends only what its disclosure lists (`GET /ai/tasks`). Reviews are redacted as above. Credentials, people of the workspace
  and other apps are never sent. The audit trail and the usage rows hold ids, counts and a hash of the data, never a prompt or an answer.
- **Retention.** Suggestions are kept 90 days and deleted with their app. Review tags and the AI context are deleted with their app and by "delete AI data".

## Small and local models

Every schema in these tasks accepts what a small model tends to write: loose choices are plain text (the server maps them to the fixed vocabulary, with a
safe fallback), numbers may come as text, a list of ids may mix numbers and strings, and lengths are loose enough that a rambling answer is still valid
(the server then cuts or flags). Prompts are short. If a model still cannot answer in the shape, the run fails with the usual fixed `ai_invalid_output`
and nothing is saved. Use a model made for structured output. A thinking model that spends its tokens before answering will often fail.

## Not verified

The per-app review privacy and the scheduled competitor reads (ADR 0065) were tested against fakes only: no real provider, Apple feed or scheduler clock, and nothing was seen in a browser.

No real model was contacted for these features. They were built and tested against the fake provider, which returns what a well-behaved and a badly
behaved model could. Before relying on them, try each task once with the provider and model you will use, with a handful of real reviews, and read what
comes back; the quality of the themes, the tags and the variants depends on the model. The web screens compile and their logic is tested, but they were not
run in a browser here. The Postgres variants of the new tables run only when `KILN_TEST_POSTGRES_URL` is set.
