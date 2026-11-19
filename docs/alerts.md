# Alerts

Alerts tell people what needs attention without making them watch the app: a store rejected a version, a credential stopped working, a
rating fell, a sync keeps failing. They arrive in the **inbox** (the bell in the top bar), by **email**, as a **desktop notification**,
and as a signed **webhook** (`alert.raised`). Each person chooses their own channels; admins set the workspace defaults.

Design and reasons: [ADR 0022](adr/0022-alerts.md). HTTP endpoints: [api/alerts](api/alerts.md).

An alert is a read-only side effect. Raising one never changes anything in a store, a repository or a listing, and it never calls a
store: conditions that need a look at the store are read from what the app already synced.

## How an alert is made

1. **From an event.** Every event written to the [event log](api/events.md) is offered to the catalog. A matching type turns it into an alert.
   The webhook delivery of the event itself is unchanged.
2. **From a state.** Some conditions are not events but things that stay true (a store sync that has been failing for 30 minutes). A pass
   every 5 minutes on the worker's scheduler checks them. It raises an alert once when the condition starts, raises it again after the type's
   repeat window if it still holds, and marks the alert **resolved** when it clears.
3. **Collapsing.** Each type has a **dedupe key** (for example `release.rejected:{appId}:{version}:{track}`) and a **repeat window**. A second
   alert with the same key inside the window does not make a new alert: it raises the **count** on the first one ("12 times") and moves its
   last-seen time. A cap per type and hour (see the table) keeps one workspace from flooding: past it, further alerts are folded into the
   newest one.
4. **Who is told.** People whose role has the action the type needs (listed under the table). A member who cannot read
   the app hears nothing about it.
5. **Which channels.** For each person: their own choice for that app, else their choice for all apps, else the workspace rule, limited to the
   channels the type allows. The desktop notification is shown from the inbox, so turning it on turns the inbox on. Then, in order:
   - **Muted or snoozed** (per app, per type, or both): nothing is delivered, and the log says so.
   - **Below the lowest severity** the person asked for: nothing is delivered.
   - **Quiet hours** (a time range and a time zone): email is held until quiet hours end and the inbox entry is not shown as a desktop
     notification. **Critical alerts ignore quiet hours.**
   - **Digest** (daily, or weekly on Mondays, at an hour in the person's time zone): email for alerts below critical is collected into one
     message. Critical alerts are still sent at once.
   - **Email limit:** at most 20 alert emails per person per hour; the rest are only logged (`user_rate_limited`).

The webhook channel is a workspace choice, not a personal one: when it is on for a type and an enabled webhook listens for `alert.raised` (or for everything), the event is
written once and delivered. With no listening webhook nothing is written to the event log and the delivery log says `no_endpoint`.

## Catalog

The action a person's role needs is listed under the table. Repeat window and cap are the defaults; an admin can change the cap and the
thresholds. Channels are the workspace defaults. The webhook is only on where listed.

| Type | What | Severity | Scope | Raised from | Default channels | Repeat window | Settings (range) |
|---|---|---|---|---|---|---|---|
| `release.rejected` | Store review rejected a version | critical | app | `app.release.status_changed` | inbox, email, desktop, webhook | 7d | |
| `release.approved` | A version was approved | info | app | `app.release.status_changed` | inbox, desktop | 7d | |
| `release.live` | A version is live or rolling out | info | app | `app.release.status_changed` | inbox | 7d | |
| `release.in_review` | A version entered store review | info | app | `app.release.status_changed` | none | 7d | |
| `release.halted` | A rollout was paused or halted | critical | app | `release.rollout_changed`, `app.release.status_changed` | inbox, email, desktop, webhook | 3d | |
| `release.stalled` | A release has stalled | warning | app | `release.stalled` | inbox, desktop | 3d | |
| `plan.deadline_overdue` | A release plan is past its target day | warning | app | `plan.deadline_overdue` | inbox, email | 3d | |
| `plan.deadline_due_soon` | A release plan target day is close | info | app | `plan.deadline_due_soon` | inbox | 3d | |
| `plan.rollout_step_due` | A planned rollout step is due | info | app | `plan.rollout_step_due` | inbox, desktop | 3d | |
| `review.low_rating` | A new low-star review | warning | app | `review.new_low_rating` | inbox, desktop | 30d | |
| `review.sync_failed` | Reading reviews keeps failing | warning | app | `review.sync_failed` | inbox | 24h | |
| `review.unanswered` | Reviews are waiting for an answer | info | workspace | `review.unanswered` | inbox | 24h | |
| `rating.dropped` | The average rating dropped | warning | app | state, every 5 minutes | inbox, email | 7d | Drop that counts: 20 hundredths of a star (5 to 200); compared with 7 days (1 to 60) |
| `store.sync_failed` | A store sync failed | warning | app | state, every 5 minutes | inbox, email | 24h | |
| `credential.invalid` | A credential does not work | critical | workspace | `credential.test_failed`, and state | inbox, email, desktop, webhook | 24h | |
| `listing.drift` | The store listing changed outside this tool | warning | app | state, every 5 minutes | inbox | 7d | |
| `listing.read_failing` | Reading the store listing keeps failing | warning | app | state, every 5 minutes | inbox | 24h | Failed reads in a row: 3 (1 to 50) |
| `ci.run_failed` | A build run failed | warning | app | `ci.run_finished` (failed runs only) | inbox, desktop | 30d | |
| `changeset.failed` | A change set could not be applied | warning | workspace | `changeset.failed` | inbox | 7d | |
| `pending.stale` | Pending changes are waiting too long | info | app | state, every 5 minutes | inbox | 7d | Older than: 7 days (1 to 90) |
| `analytics.sync_failing` | Analytics sync keeps failing | warning | app | state, every 5 minutes | inbox | 24h | Failed syncs in a row: 3 (2 to 50) |
| `aso.rank_dropped` | A tracked keyword dropped in the ranking | warning | app | `aso.rank_changed` | inbox | 24h | Places lost: 10 (1 to 200) |
| `aso.competitor_changed` | A competitor changed its listing | info | app | `aso.competitor_changed` | none | 24h | |
| `ai.suggestion_ready` | An AI suggestion is ready | info | app | `ai.suggestion_created` | inbox | 30d | |
| `security.stepup_failed` | Repeated failed confirmations | warning | workspace | `stepup.failed` | inbox, email | 1h | Failures in a row: 3 (1 to 20) |
| `security.recovery_used` | A recovery code was used | warning | workspace | `stepup.recovery_used` | inbox, email | 1h | |
| `security.token_created` | An API token was created | info | workspace | `token.created` | inbox | 30d | |
| `security.member_added` | A member joined | info | workspace | `member.added` | inbox | 30d | |
| `system.smtp_failing` | Alert email is failing | critical | workspace | state, every 5 minutes | inbox, desktop, webhook | 24h | Failed emails in a row: 3 (2 to 50) |

Who is told, by type: the `release.*`, `store.sync_failed` and `pending.stale` types go to people who can read apps; `plan.*` to plans;
`review.*` and `rating.dropped` to reviews; `credential.invalid` to credentials; `listing.*` to listings; `ci.run_failed` and
`changeset.failed` to repositories; `analytics.sync_failing` to analytics; `aso.*` to ASO; `ai.suggestion_ready` to AI use; the
`security.*` and `system.*` types to people who can change workspace settings, except `security.member_added` (people who manage
members). The exact action of each type is `audience` in `GET /alerts/catalog`.

### Events that never alert

Some events are the success of something a person just did, or routine noise; an alert for them would only repeat what the screen already
said. They are listed in code (`notAlertable` in `services/alert-catalog.ts`) and a test fails if an event type is in neither the catalog nor that list,
so a new event type has to be decided:

`app.synced`, `changeset.created`, `changeset.approved`, `changeset.applied`, `plan.rollout_step_done`, `plan.rollout_step_skipped`,
`plan.rollout_step_reopened`, `review.reply_sent`, `listing.draft_pushed`, `listing.submitted`, `release.started`, `pending.published`,
`ci.run_started`, `assets.pulled`, `analytics.synced`, `stepup.verified`, `auth.second_factor_failed` (one wrong sign-in code is routine; see `security.stepup_failed`), and `alert.raised` itself (an alert about an alert would loop).

## What is in an alert

A title and a short body built from a template with the facts of the event (app name, version, track, counts). Templates never include a
secret, a credential, a token, a review text or a reply text, and never the text a store or a mail server answered with; data that reaches
a template passes `redactAlertData`, which drops everything not on an allow-list. Tests render every type from ids and names alone and check that no review text, store answer or secret-looking value gets through.

## Email and the delivery log

Email goes through `sendMail` (`services/mailer.ts`, which reads the workspace's SMTP settings) from a background job, so a failure is retried with backoff. Only a connection
failure and a timeout are retried (up to the job queue's attempt limit); a refused login, a refused message or a missing mail setup are
final and say so. Every delivery is a row in the **delivery log** with a status (queued, retrying, sent, failed, skipped, deferred) and an
**outcome code from a fixed list**. The screen explains each in a sentence; nothing a provider said is ever stored.

| Outcome | Meaning |
|---|---|
| `ok` | Delivered. |
| `queued_for_client` | Waiting for the app to show it as a desktop notification. |
| `queued_for_endpoints` | Handed to the workspace's webhooks; each has its own delivery log. |
| `in_digest` / `digest_sent` | Held for the digest / sent in a digest. |
| `quiet_hours` | Held back by quiet hours. |
| `muted` | Muted or snoozed by the person. |
| `below_minimum_severity` | Below the lowest severity the person asked for. |
| `user_rate_limited` | Over 20 alert emails in an hour for that person. |
| `no_address` / `recipient_gone` | No email address, or the person left the workspace. |
| `no_endpoint` | The webhook channel is on but no webhook listens for `alert.raised`. |
| `smtp_not_configured` | No mail server is set up. |
| `smtp_connection_failed` / `smtp_timeout` | The mail server could not be reached / did not answer. Retried. |
| `smtp_auth_failed` / `smtp_tls_failed` / `smtp_rejected` | Login refused / no secure connection / message refused. Not retried. |

The web app's test (`apps/web/src/lib/alerts.test.ts`) reads the server's list and fails if a code has no sentence.

When email keeps failing, `system.smtp_failing` raises a critical alert (inbox, desktop and webhook only: it never tries email).

## Desktop notifications

The notification is shown by the web app, not by the server: while the app is open, the bell polls every minute and when the page becomes
visible, and shows one notification for each alert the server marked for it (the person's choices allow it and it is not quiet hours), once,
and only for alerts that arrived after the page was opened. Nothing is shown when the app is closed.

- **Browser:** the Notification API. The person must allow notifications (Settings, Alerts, "Allow notifications").
- **Desktop app (Tauri):** the same code calls the native notification plugin when it finds the Tauri bridge. The plugin and a capability
  for the local server's address are in `apps/desktop/src-tauri`. **Not compiled or run when it was written**; see [Unverified](#unverified).

## Mute and snooze

A mute covers an app, a type, or both; with a time (1 hour, 8 hours, 1 day, 1 week) or until the person turns it back on. It applies to
that person's inbox, email and desktop notifications; it does not stop the alert from being raised, collected in the workspace's log or
sent to webhooks. The inbox's Snooze menu makes the mute for the alert's app and type.

## Roles

| Action | Who | Used for |
|---|---|---|
| `alerts.read` | owner, admin, member, viewer | the inbox, the catalog, the delivery log (own rows) |
| `alerts.write` | owner, admin, member | own settings, choices, mutes, test alerts |
| `alerts.manage` | owner, admin | workspace rules, the whole workspace's delivery log |

A non-member gets 404. API tokens: only the read endpoints for the catalog, the inbox, the unread count and the delivery log are open to a
token by default (`alerts.read`); anything that changes a person's own state is session only; `alerts.manage` is
explicit-only (a token must list it, and the person's role must have it). See [api/alerts](api/alerts.md).

## Unverified

- **Real SMTP.** Mail goes through `sendMail`; every test uses a fake. Nothing here was sent through a real mail server.
- **Tauri notifications.** The code paths (`__TAURI_INTERNALS__` calls to the notification plugin, the capability with `remote` URLs, the
  Cargo dependency) follow the plugin's documented shape, but the desktop app was not built or run. The capability's URL patterns must match
  the address the shell loads.
- **PostgreSQL.** The queries are portable and the migration passes the drift test, but the Postgres cases of the alert tests were skipped
  (no Postgres in the build environment).
- **Listing drift.** The heuristic ("the listing differs from the last thing this tool pushed or published") is covered by tests with
  constructed data, not by real store listings.
