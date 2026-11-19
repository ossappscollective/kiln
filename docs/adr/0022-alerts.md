# ADR 0022: Alerts

Status: implemented and tested against fakes. Real SMTP, native desktop notifications and PostgreSQL were **not run**; the list is in
[alerts](../alerts.md#unverified).

## Context

The app already records what happens (the [event log](../api/events.md)) and can push events to a person's server through signed
[webhooks](../api/webhooks.md). Nothing tells a person that something needs them: a rejected version, a credential that stopped working,
a rating that fell, a sync that has failed for an hour. People find out by opening the app or from a store email. The request was an alert
system: a typed catalog, email, webhook, an in-app inbox with a count in the top bar, desktop notifications, an optional digest, per-person
preferences, workspace defaults, collapsing of repeats, a delivery log with fixed outcome codes, mutes and snoozes, and a test for each channel.

## Decision

1. **The event log is the only hook.** `emitEvent` offers each event to the alert catalog (`observeEventForAlerts`) right after it queues
   webhook deliveries, in the same transaction. A new feature needs no alert code: it needs an event, and a catalog entry or a reason in
   `notAlertable`. A test fails for an event type that is in neither, so the decision cannot be skipped.
2. **State conditions have a small evaluator, not more events.** Things that stay true (a sync failing for 30 minutes, a credential
   that does not test, a rating that fell, a listing that changed outside this tool) are read from the database every 5 minutes by a pass on
   the existing scheduler. It never calls a store. A row per condition (`alert_conditions`) remembers what was raised, so an alert is
   raised once when the condition starts, again after the type's repeat window while it holds, and is marked resolved when it clears.
3. **The catalog is typed code, not a table.** Each type: id, severity, scope (workspace or app), who is told (an `Action`, so `can()` decides),
   allowed and default channels, a dedupe key template and window, a cap per hour, settings with ranges, and title and body templates. Admins
   change only what the type declares changeable (enabled, channels, cap, thresholds); the rest is code and changes with a release. Templates
   see only ids, names and numbers: data passes an allow-list (`redactAlertData`) first, so a template cannot print a secret, a review or a
   store's answer even if an event carries one.
4. **Repeats are collapsed, then capped.** The dedupe key and window turn a repeat into a higher `count` on one alert. A cap per type and hour
   folds anything beyond it into the newest alert. A person gets at most 20 alert emails an hour. Nothing is dropped silently: each
   suppression is a delivery row with a code.
5. **Channels are decided per person, in one place.** Order: the person's choice for the app, their choice for all apps, the workspace rule,
   limited to the type's allowed channels; then mute, lowest severity, quiet hours and digest. **Critical alerts ignore quiet hours and the
   digest.** Quiet hours hold email until they end and keep the inbox entry from being shown as a desktop notification.
6. **Email reuses the mailer through a job.** `sendMail({ to, subject, text, html? })` returns `{ ok: true }` or `{ ok: false, code }`.
   The handler is given the mailer (the real one by default, a fake in tests). Only connection failures and timeouts are retried, with
   the queue's backoff; a refused login or message is final. The result is stored as a code from a fixed list, never the provider's text,
   so the delivery log cannot leak a server banner, an address or a credential.
7. **Webhook = one new event type.** The webhook channel writes `alert.raised` into the event log, only when an enabled webhook listens for it, and the existing signed delivery, retries and
   log do the rest. No second transport was built. It is a workspace choice, not a personal one. Consequences: a webhook subscribed to `*` also
   receives alerts, and a workspace with no webhook that listens gets the code `no_endpoint` in the log instead of silence. `token.created` and
   `member.added` were added as events because two alerts needed them.
8. **Desktop notifications are made by the client.** The server only marks an inbox row as due for a desktop notification (`desktop`, from the
   person's choices and quiet hours). The web app polls (every minute and when the page becomes visible) and shows each once, only for alerts
   newer than the page. This works in a browser (Notification API) and, through the Tauri bridge, in the desktop app. It cannot work while the
   app is closed; that needs push, which is out of scope. The Tauri side is a plugin, a capability and a bridge call that were not compiled here.
9. **Rights.** `alerts.read` (everyone), `alerts.write` (members and above: own settings, choices, mutes, tests), `alerts.manage` (admins: workspace
   rules, the workspace's delivery log). Alerts are personal state, so everything that changes or reads a person's own settings is session only
   for tokens, and `alerts.manage` is explicit-only (a token must name it). A non-member gets 404. Workspace rule changes and test alerts are audited;
   a person's own preferences are not (they are theirs, high volume, and not a security event).
10. **Alerts are read-only side effects.** Nothing here changes a store, a repository or a listing, and an alert never triggers an action.

## Consequences

- One more thing runs on the scheduler every 5 minutes (`alerts.intervalMs`, a constant for now; no environment switch was added). A pass reads
  a handful of indexed tables and ends. Old alerts, inbox rows and delivery rows are pruned hourly.
- `events.ts` imports `alerts.ts`, which imports `emitEvent` from `events.ts`. The cycle is only used at call time, never during module
  evaluation, and works in Node's ESM loader; a bundler that evaluates eagerly would need the hook injected. An error inside the hook is
  swallowed so an alert can never block the event that caused it; on PostgreSQL a failed statement inside a transaction would still abort that
  transaction, which is why the hook only runs statements that are expected to succeed.
- A persistent condition alerts again once per repeat window (daily for most). Someone who does not want that mutes the type or the app.
- The catalog is code: adding a type is a pull request. This was chosen over rows in a table so that the title, body and redaction rules are
  reviewed and tested like the rest.

## Not done

- Push when the app is closed (mobile push, web push). Email is the channel for that.
- Per-channel digests other than email; digests of the webhook channel.
- Chat integrations (Slack, Teams): the webhook is the extension point.
- A per-app workspace rule (the rule is per type for the whole workspace; a person can choose per app).
- Listing drift is a heuristic (a listing that differs from what this tool last pushed or published and that no known event explains). It is
  tested with constructed data only.
