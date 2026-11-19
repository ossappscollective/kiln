# ADR 0024: AI features on the foundation: reports, variants, per-app context and a cost cap

Status: server, database (migrations 40 and 41) and web implemented and tested against the fake provider on SQLite. **No real model was
contacted; the web screens compile and their logic is tested but were not run in a browser.** User guide: [AI features](../ai-features.md). API:
[api/ai](../api/ai.md). Builds on [ADR 0016](0016-ai-foundation.md).

## Context

ADR 0016 built one narrow path (stored data in, validated proposal out, a person accepts it through an existing mechanism) and three tasks. The
work people actually want from it is wider: make sense of a pile of reviews, see what to fix and what to say next, audit and vary the listing,
translate it, and know what it costs, all without it ever acting by itself and without it working only with a frontier model.

## Decision

1. **Same path, new kinds of output.** Two proposal kinds join `keywords`, `listing_text` and `reply_draft`: `insight` (a report: read, then marked as
   reviewed, which creates nothing) and `listing_variants` (alternatives per field, one chosen per field). Tasks are still data plus a function; the
   registry grows from 3 to 11 ready tasks. `listing_translate`, which 0016 listed as planned, is built; `release_notes` and `rank_drop_explain` stay
   planned (a "what is new" draft is part of `fix_next` and of the variants for now).
2. **The server counts, the model judges.** Anything countable is computed by code from stored data: reviews per theme and per version, shares of stars,
   lengths against limits, keyword coverage and rank, the basis of a report. The model supplies words, an order and a judgement. Evidence is a list of
   short aliases (`r1`, `r2`) that are checked against what was sent; an unknown one is dropped and the report says so. A claim about a rank or a
   position that the data does not contain is flagged `unverified_number`. This keeps a wrong or invented number out of a screen, whichever model answers.
3. **Per-app AI context, injected in one place.** What a developer says about an app (about, audience, tone, voice, banned words, protected names, do
   and don't rules) is stored once (`ai_app_context`, migration 40) and added to the task data centrally in `buildRun` (`withAppContext`), only the filled
   parts, only for tasks that use it. The tasks' prompts treat it as instruction and everything else as data. Because a model does not always obey,
   the server enforces what it can: `banned_term` makes an item not acceptable; `brand_term_missing` warns. Editing needs `apps.write` (admins), reading
   needs `ai.use`: it is brand copy, not a secret, but it is sent to the provider, and the form says so. The audit holds field names only.
4. **Review tags are advisory and cached.** `review_classify` stores topics, sentiment, severity, language and needs-reply per review
   (`review_classifications`, migration 41), keyed by review with the task version and a hash of the text. A tagged review is never paid for twice and an
   edited review or a new version is tagged again. Tags are labels: they never change a review's status, assignee or reply, and the vocabulary is a fixed
   list so counting and filtering work whatever the model says (anything else becomes `other`).
5. **Data minimisation for reviews.** Review text is the one input written by strangers. Before it is sent: emails, links, phone-like numbers and the author's
   name are replaced by placeholders; author, device, territory and store ids are not sent; ids are aliases. A reply draft that still seems to contain personal
   data is flagged `personal_data` and cannot be accepted. This is best effort, not anonymisation, and the documents say so.
6. **A "what will be sent" preview.** `POST /ai/tasks/{id}/preview` builds a run's data with the same code and returns it with the instruction text and an
   estimate of tokens, and contacts nobody. The disclosure of 0016 says what _kinds_ of data go out; the preview says what _this_ data is. It is offered
   inside the disclosure popover. The "don't ask again" choice stays in the browser's localStorage (per task, version and provider) as in 0016: it is a
   convenience of one person's browser, not a workspace decision, and losing it only asks again.
7. **Cost: a soft warning and a hard cap, both optional.** Tokens are not what a provider bills. An admin may type the prices (whole cents per million tokens),
   which gives an estimate, a **monthly cost cap** that refuses a run whose estimate would pass it (`ai_cost_cap_reached`, like the token budget), and a
   **soft warning** share (default 80%) that only informs: the run still works and its answer carries `warning`. The reason for two levels is that a hard stop
   at 100% is a surprise in the middle of work, while a warning that blocks nothing is ignored; the warning comes first and the stop is the backstop. Money is
   whole cents (no floats), the estimate says it is not a bill, and no price is built in (they change and differ by contract).
8. **Small models keep working.** Schemas ask for plain strings and numbers-or-strings, never for tight enums or tight lengths (a model that writes a
   sentiment of "mostly positive" or a 200 character label must not void the run). A post-processing step (`ai-task-lenient.ts`) maps to the vocabulary with a
   safe fallback, clamps, deduplicates and drops what cannot be used, and records what it did in `notes`. Prompts are short. Every ready task must still pass the
   strict-schema check of the foundation.
9. **Entry points are quiet.** Each control is drawn only when AI is on and the role may use it and accept the result; a screen without AI looks as before.
   Reports show in the tray of the app, where they are read and marked reviewed. Subtitle and name cannot be staged by a draft push, so their suggestions
   are shown for copying and cannot be accepted: no AI path writes a field the product does not otherwise write.
10. **Reply language defaults to the review's own language**, not the workspace's, because a reply in another language than the review is wrong more often than not.

## Consequences

- One shared `buildRun` serves run and preview, so what is shown is what is sent. Adding a task that uses the context or reviews inherits the redaction, the
  injection and the banned-term rule.
- The new tables are per app and workspace and are removed with the app and by the AI data deletion. They hold no review text (a hash) and no prompt.
- Cost control is an estimate. A provider's own spending limit is still the real one; the settings say so.
- A report's quality depends on the model. The counts are right whatever it does; the themes and findings are as good as the model.
- A hard cap that depends on prices an admin typed can be wrong in either direction; it fails safe only if the prices are not too low.

## Not verified

- No live provider was contacted. Real models may differ in how they handle the schemas (strict structured output is attempted first), in the quality of tags
  and themes, and in how often a small model fails the shape. Try each task with the model you will use.
- The redaction patterns are regular expressions for emails, links and phone-like numbers in common shapes, not a privacy guarantee.
- The web screens were checked by the type checker and the compiler and by tests of their logic; they were not run in a browser.
- The Postgres variants of the two migrations and their queries run only when `MRM_TEST_POSTGRES_URL` is set.
- Migration ids 40 and 41 were reserved for this work; the id sequence has a gap until the other work in flight lands its migrations (the contiguity test fails until then).
