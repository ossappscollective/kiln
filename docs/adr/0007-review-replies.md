# ADR 0007: Replying to customer reviews

Status: implemented and tested against fakes on SQLite; **never run against App Store Connect or
Google Play**. The facts about the two reply APIs that were not verified are listed below and in
[phase-3-reviews](../phase-3-reviews.md). The decision to build it was the maintainer's: "Google Play
needs the 'Reply to reviews': we want reply feature!".

## Context

Until now this product only read from stores and wrote to GitHub (as a reviewed change set, with an
approval). A reply to a review is different from both: it is a **public statement in the
organisation's name** in the App Store or on Google Play, it has no approval workflow in the stores,
and this tool **cannot recall it** (neither connector deletes a Google reply, and Apple's delete is
not instant and not exposed here). Every part of the design follows from "this cannot be taken back".

Facts the design relies on (checked on the pages named, 2026-11-18):

- Google `reviews.reply`: `{ "replyText" }`, at most 350 characters, a new reply replaces the old one,
  public, well formed HTML tags are stripped, 2000 reply requests a day per app, the service account
  needs the Play Console permission "Reply to reviews"
  (https://developers.google.com/android-publisher/reply-to-reviews). Only reviews created or modified
  in the last week can be read back.
- Apple `POST /v1/customerReviewResponses`: creates a response or overwrites an existing one; the state
  is `PENDING_PUBLISH` before `PUBLISHED`
  (https://developer.apple.com/documentation/appstoreconnectapi/post-v1-customerreviewresponses).
  Account Holder, Admin and Customer Support may respond in App Store Connect (help page).

Not verified, and treated as unknown rather than assumed: Apple's success status, the attribute and
relationship names (the field pages did not render), the length limit, which API key role may respond
(Admin is assumed; a forum report says Customer Support cannot be a key role and another reports HTTP
405 on some keys), whether `include=response` works when reading one review, and whether Google's
reply works past the 7 day window.

## Decision

Replying is built as a **gated, two-person-step-free but deliberate** write. Ten rules:

1. **A kill switch, off by default.** `MRM_REVIEW_REPLY_ENABLED=true` turns the feature on. While off,
   every reply route (draft, delete, translate, send, templates) answers `409 reply_disabled` naming
   the variable, the UI says the same, and no connector is ever built for a write.
2. **A separate right.** `reviews.reply` is **admin and up**. Writing a draft stays `reviews.triage`
   (member and up). An API token only gets `reviews.reply` when its action list **names it** (the
   rule `tokenExplicitOnlyActions` in `packages/core/src/roles.ts`): "no list" means "everything the
   role may do" for the other actions, and must never mean "may publish publicly".
3. **Draft first, then confirm with a hash.** A draft is saved (plain text, checked against the
   store's limit). Sending needs `confirmHash`, the SHA-256 of the text the person was shown; if the
   draft changed since, `409 stale_draft`. The confirmation dialog shows the store, the app, the
   review (rating and author), the exact text, the count against the limit, and the sentence "This will
   be published publicly in the store and cannot be recalled by this tool", with a tick to acknowledge.
4. **No automatic and no bulk send.** One review per request. No sync, job, schedule, template or
   translation sends anything; nothing is sent when a dialog closes.
5. **One send in flight per review, idempotent.** The send takes an atomic claim on the draft row
   (`status = sending`, `claim_at`, time to live 2 minutes) before any store call. A second send is
   `send_in_progress`; a repeat of a finished one is `already_sent` without a request. A failed send
   keeps the draft (`failed`, with a code) so nobody retypes it.
6. **An unknown outcome is settled by looking, never by retrying.** A timeout, a cut connection or a
   5xx may mean the store applied the reply. The write is never retried (also not for a 429; the
   write connector has no rate-limit waits): the service reads the review back. Found: `sent`
   (`confirmedByReread`). Another reply or none: `failed` with `outcome: not_applied`. Unreadable:
   `unknown`, which locks the draft; sending again only re-checks. A claim older than its time to
   live (a dead process) is handled the same way.
7. **A rate limit per workspace**, 30 sends an hour, counted from the audit log plus claims in flight
   so it survives restarts and several processes.
8. **Audit and events never carry the text.** `review.reply_draft`, `review.reply_sent` and
   `review.reply_failed` hold ids, the store, the length and the hash; the event `review.reply_sent`
   holds ids only. A test searches the audit log, events, jobs, webhook deliveries and logs for the
   text.
9. **The registry is default-deny.** Each new route is an operation of
   `services/api-operations.ts` with its action; the delete of a draft is `destructive`; the send is
   `write` with `reviews.reply`.
10. **Plain text only, never interpolated.** Control characters (tabs, direction overrides) and
    HTML-looking tags are refused (Google strips well formed tags, so what is published would differ
    from what was confirmed). The reply is never put into a prompt, a URL or markup. Templates only
    take `{{author}}` and `{{app}}`, filled in as plain text (one line, at most 60 characters).

An optional translation seam (`translateDraft`) can suggest text for a draft. This feature does not
depend on any translation service: without one the endpoint is `409 translation_unavailable` and the
UI hides the control (`reply-config.translation.available`). A translation is a suggestion that goes
through every check again when saved.

## Data model (migration 21)

- `review_reply_drafts`: one row per review (`UNIQUE review_id`, so saving replaces), `ON DELETE CASCADE`
  from `app_reviews`; `text`, `text_hash`, `status` (`draft`, `sending`, `sent`, `failed`, `unknown`),
  `error_code`, `evidence` (JSON without the text), actors and times, `claim_at`, `store_response_id`.
- `review_reply_templates`: per workspace, at most 50.
- Three indexes on `app_reviews` for the workspace-wide inbox: `(workspace_id, created_at, id)`,
  `(workspace_id, updated_at, id)` and `(workspace_id, rating, created_at, id)`.
- The review status enum is unchanged (`replied_in_console` still means "someone answered in the store's
  console"); where a reply stands is the separate `reply: { status, sentAt }`. A sent reply moves a
  `new` review to `triaged`.

## Alternatives considered

- **Send from the draft route** (no `confirmHash`). Faster, but a stale browser tab or a replayed request
  could publish text nobody read. Rejected.
- **A second person approves** like change sets. Stronger, and left as an open decision (21): it needs a
  queue and notifications, and the maintainer chose admin rights plus an explicit confirmation.
- **Retry on a timeout.** Rejected: Apple overwrites an existing response and Google replaces a reply,
  so a repeated write could replace a newer human edit.
- **Bulk or "reply to all low ratings".** Rejected: public, automated replies are discouraged by Google and
  would be exactly the failure this design guards against.
- **Store the text in the audit log** for accountability. Rejected: the audit log is read widely and
  exported; the text lives only in the draft row and in the store.

## Consequences

- A deployment that never sets the variable cannot publish anything, whatever its roles and tokens.
- A reply cannot be edited or deleted from here after it is sent (Apple's delete exists in the
  connector but no route calls it): a person fixes it in the store's console.
- The send path is the most failure-prone code in the product; it is covered by tests for the hash,
  the claim, concurrency, each unknown-outcome settlement, the rate limit, tokens and the absence of
  text everywhere but the draft. It still needs a run against real accounts (a test app, one review)
  before it is switched on for a real one: see "Not verified" in
  [phase-3-reviews](../phase-3-reviews.md).
- The workspace-wide inbox lets any member read the reviews (personal data of third parties) of every app;
  there is no per-member app visibility in this product. A token can be limited to some apps.
