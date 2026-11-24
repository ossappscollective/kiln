# Chat integrations (Slack and Microsoft Teams)

Alerts, release events and a daily summary can land in a Slack or Microsoft Teams channel. Design and reasons:
[ADR 0047](adr/0047-chat-integrations.md). HTTP endpoints: [api/chat-integrations](api/chat-integrations.md). The screen is **Chat** in the
Workspace group of the navigation (owners and admins).

## Set up

1. **Get the address.**
   - **Slack:** create an app at api.slack.com/apps, turn on Incoming Webhooks, add a webhook to the channel, copy the URL
     (`https://hooks.slack.com/services/...`).
   - **Teams:** in the Workflows app create a workflow from the template that posts to a channel when a webhook request is received (Microsoft names
     the template "Send webhook alerts to a channel"), pick the team and channel, copy the HTTP URL of the trigger. The old Office 365 connector
     webhooks are retired by Microsoft and are not a supported way in.
2. **Add the destination** (Chat, New destination): provider, a name, the address, the language of the messages (English, French, Spanish
   or German; the language of the channel, not of whoever set it up), and optionally a daily summary (hour and time zone).
3. **Press Send test message.** The result is shown under the buttons and in Deliveries.
4. **Adjust the routing** if the defaults are not what you want.

The address is **secret**: it is stored encrypted, never shown again (the screen and the API show its last four characters) and never written to the audit
log. To change it, paste a new one in Edit. Only owners and admins see the screen; members and viewers get 403, API tokens can never reach it.

## What is sent where

A destination has **rules**; an alert goes to it when any rule that is on takes it. A rule picks alert types (all, or by group or one by one,
the same groups as the Alerts screen), the lowest severity (everything, needs attention and critical, critical only), apps (all or some) and
platforms (all or some of iOS, macOS, Android). A new destination starts with two rules: **every critical alert**, and **every alert of the
releases group** (rejected, approved, live, in review, halted, stalled, plan deadlines and steps) at any severity. With no rule nothing is sent.

Chat sits behind the alert system, not beside it. An alert type switched off in Alerts never reaches chat; a repeat of an alert (same dedupe key, inside
its window) raises a counter and sends **no** second message; the hourly cap of the type applies. Personal choices (mute, quiet hours, minimum
severity) are per person and do not apply to a shared channel.

**Daily summary.** With it on, alerts below critical wait and go out together at the destination's hour (its time zone), up to 40 lines and "and N
more"; critical alerts are still sent at once. A day with nothing collected sends nothing.

## What a message looks like

Title, severity, app, platform and version, what happened, one sentence on **what to do**, and link buttons to the right Kiln page (the app's
releases, reviews, listing, the credentials screen, and so on: the same destinations as the email buttons, built on `KILN_PUBLIC_ORIGIN`; without
it there are no buttons and the message says where to go in words). Slack gets Block Kit blocks in a coloured attachment, Teams an Adaptive
Card. The colour is the accent: critical, needs attention, info; no emoji. The sentences are the alert catalog's own, in the destination's language
(`apps/server/locales/alerts` and `chat`, [i18n-server](i18n-server.md)). Values that come from outside (app names, versions) are escaped for the
target's markup, so a name such as `<!channel>` cannot ping a channel. v1 has no interactive buttons (they need a public endpoint; v2 is sketched in the ADR).

## Delivery

- Through the same SSRF-safe transport as [webhooks](api/webhooks.md): https only, public addresses only, pinned connection, no redirects.
- Only the provider's hosts are accepted (`hooks.slack.com`; `*.powerplatform.com`, `*.logic.azure.com`, `*.webhook.office.com` for Teams)
  unless the destination has **Allow a host other than Slack or Microsoft** (for your own gateway). The check runs when saving and at every send.
- One message per second per destination; a timeout, network error, 5xx or 429 is retried up to 5 times (a 429 waits for `Retry-After`, between 1 s
  and 5 minutes); a deleted or refused webhook, a refused message or a blocked address is final.
- Deliveries are kept 30 days. Each has a status (`queued`, `retrying`, `sent`, `failed`, `deferred`), the HTTP status, the number of attempts
  and an **outcome code** from a fixed list, explained in the screen; nothing a provider answered is stored.

| Outcome                                                                          | Meaning                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ok`                                                                             | Delivered.                                                                                                          |
| `queued`, `in_digest`, `digest_sent`                                             | Waiting to be sent; held for / sent in the daily summary.                                                           |
| `rate_limited`, `server_error`, `timeout`, `dns_failed`, `network_error`         | Retried later.                                                                                                      |
| `blocked_address`, `host_not_allowed`                                            | The address points inside a network, or is not a provider host and the destination does not allow others. Not sent. |
| `webhook_gone`, `webhook_rejected`, `payload_rejected`, `rejected`, `redirected` | The service said no. Not retried.                                                                                   |
| `disabled`, `secret_unreadable`                                                  | The destination is off; the stored address cannot be decrypted (paste it again).                                    |

## Operating notes

- Set `KILN_PUBLIC_ORIGIN`, or messages have no buttons.
- `KILN_WEBHOOKS_ALLOW_PRIVATE=1` (also for webhooks) allows private addresses and `http` to localhost, for development against a fake receiver.
- Audit entries: `chat.destination.create`, `chat.destination.update`, `chat.destination.delete`, `chat.destination.test`, `chat.routes.update`.
- Limits: 20 destinations per workspace, 20 rules per destination, 10 tests a minute per workspace.

## Unverified

Nothing here was sent to a real Slack workspace or Teams tenant; every test uses a fake transport or the real transport against refused addresses.

- **Delivery to the real services:** the payload shapes follow the providers' documentation. In particular unverified: a Slack message that has **only an
  attachment with blocks** and no top level `text` (a common pattern, but not stated on the pages we could read); Slack's treatment of the
  zero width spaces we use to stop `* _ ~` formatting; the exact Teams Workflows webhook host names beyond `powerplatform.com` and
  `logic.azure.com` (Microsoft's pages do not list them); Adaptive Card version `1.4` and `msteams.width` in every Workflows card renderer; whether
  Workflows answers 200 or 202 (we accept any 2xx).
- Teams: a workflow that fails **after** accepting the request still answers 2xx, so "sent" means "the webhook accepted it".
- Slack rate limit exact numbers are not published (documented: about one message per second per channel, with bursts).
- PostgreSQL: the migration passes the drift test, the Postgres cases of the tests were skipped (no Postgres here).
