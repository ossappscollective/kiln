# ADR 0047: Chat integrations (Slack and Microsoft Teams)

Status: implemented and tested against fakes. **No real Slack or Teams endpoint was called**; the list of what is unverified is in
[chat-integrations](../chat-integrations.md#unverified).

## Context

[Alerts](0022-alerts.md) reach people by inbox, email, desktop notification and a signed [webhook](../api/webhooks.md). Teams already talk
in Slack or Microsoft Teams, so the request was: alerts, release events and the daily summary in a chat channel, without every self-hosted
install needing a public URL.

## Decision

1. **Providers: incoming webhooks only in v1.**
   - **Slack:** an incoming webhook (`https://hooks.slack.com/services/...`). It needs no public URL on our side and no OAuth app review. A
     bot token with a channel id would let us pick channels and thread replies, but it needs a Slack app installed with scopes and a token to
     store and rotate; it is a later option, not clearly better for the first version.
   - **Microsoft Teams:** a **Workflows** (Power Automate) webhook that posts an Adaptive Card to a channel. Microsoft's documentation says the
     Office 365 connectors, including the connector based incoming webhooks, were **retired in May 2026**, and that Workflows replaces them
     (the page names the template "Send webhook alerts to a channel" and the trigger "When a Teams webhook request is received"; the product
     may word them differently, so the help text describes the template instead of quoting a name). The legacy `*.webhook.office.com` host
     is still accepted so an old address fails with a readable code instead of a refusal. Workflows URLs moved from `*.logic.azure.com`
     (retired 30 November 2025 according to Microsoft's announcement as reported by third parties) to
     `<environment>.<region>.environment.api.powerplatform.com`; both are on the allow list.
2. **A destination is a workspace object, its URL is the secret.** Table `chat_destinations` (migration 52): provider, name, the URL
   **encrypted with the vault key bound to the workspace and the destination** (`chat:<workspace>:<id>`), its last four characters
   (`url_hint`, the only part ever shown), the language of the messages (en, fr, es, de), an enabled flag, an explicit `allow_any_host` flag
   and an optional daily summary (hour and time zone). No endpoint returns the URL; the audit log and the delivery log hold the provider, the
   name and the last four characters at most. Owners and admins only (`chat.read`, `chat.manage`), session only: both are in
   `tokenForbiddenActions`, as for webhooks, so **there is no MCP tool** (MCP runs with a token, and a read tool that lists destinations would
   be the only one a token could ever call).
3. **Routing rules** (`chat_routes`): a destination has rules; an alert goes to it when any enabled rule takes it. A rule has alert types
   (`["*"]` or a list), the lowest severity, optional apps and platforms. A new destination gets two defaults: every critical alert, and every
   alert of the `releases` group (rejected, approved, live, in review, halted, stalled, plan deadlines and steps) at any severity.
4. **Not a parallel pipeline.** Chat is a **workspace level channel next to the webhook channel**: `raiseAlert` calls `routeAlertToChat` for
   every _new_ alert, after the alert row is written. So everything the alert system decides first still applies: the workspace rule that
   switches a type off, the dedupe key and window (a repeat raises a count, no second message), the hourly cap, and the data redaction
   (`redactAlertData`). Titles, bodies, "what to do" sentences and button labels are the **same catalog text as the emails** (`alerts`
   namespace), in the destination's language; only the frame (field names, severity words, test and summary texts) is new (`chat`
   namespace). Links are built on the same origin as the emails (`KILN_PUBLIC_ORIGIN`, `mailLink`); without it the message has no buttons and
   names the screen in words.
   _Deviation from the brief, and why:_ `AlertChannel` (`in_app`, `email`, `desktop`, `webhook`) was **not** widened with `chat`. That list
   drives the per-person matrix, the workspace rule editor, the alert delivery log and the web screens; destinations have their own rules and
   their own log (`chat_deliveries`, with the destination and a fixed outcome vocabulary), so adding a fifth value there would have meant a
   second set of choices for the same thing. Personal preferences (mutes, quiet hours, minimum severity) are per person and do not apply to a
   shared channel; a destination's own rules and its daily summary are the equivalent.
5. **Daily summary.** With the summary on, alerts **below critical** wait (row `deferred` / `in_digest`, as for email) and are sent as one
   message at the destination's hour in its time zone, by the alert runner's 5 minute pass; critical alerts are still sent at once. At most 40
   lines are shown, then "and N more alerts".
6. **Safety.** The send reuses the webhook module's transport (`sendPinned`): https only, every resolved address must be public, the connection is
   pinned to the checked address, no redirects, a 64 KB response cap, 10 s timeout. On top: only the provider's known hosts
   (`hooks.slack.com`; `*.powerplatform.com`, `*.logic.azure.com`, `*.webhook.office.com` for Teams) unless the destination has the explicit
   `allowAnyHost` (for the admin's own gateway); the check runs when the destination is saved **and again at every send**, so switching the
   flag off stops an already stored address. `allowAnyHost` never lifts the private address rule (`KILN_WEBHOOKS_ALLOW_PRIVATE` does, as
   for webhooks). A provider's answer is **never stored or shown**: only the HTTP status and a code from `chatOutcomes`.
7. **Pacing and retries.** One message per second per destination (Slack's documented limit for incoming webhooks, short bursts above it are
   tolerated; Teams allows more but we pace both): a second job for the same destination waits until a second after the last send, and
   waiting costs no attempt. A timeout, a network or DNS error, a 5xx, a 408 and a **429** are retried, up to 5 attempts; for 429 the wait is the
   `Retry-After` header (seconds or a date, between 1 s and 5 minutes), otherwise the queue's exponential backoff (5 s, 10 s, 20 s, ...).
   The handler schedules its own retry (`enqueue` with `runAt`) so the header is honoured to the second. 404/410 (webhook deleted), 401/403
   (refused), 400/413/422 (message not accepted), other 4xx, 3xx and every refused address are final and logged with a distinct code.
8. **Messages.** Slack: Block Kit blocks inside one attachment with a `color` (the status colours of the emails; the coloured bar is the only
   accent a webhook post can have), `header` (plain text, 150 characters), a severity context line, the body as `plain_text`, a section with the
   app, platform and version as fields, a "What to do" section, a link-button `actions` block, a context footer. Teams: a `message` envelope
   with one Adaptive Card (version 1.4): a coloured container with the title and severity, the body, a `FactSet`, an emphasised "What to do"
   container, `Action.OpenUrl` buttons. No emoji anywhere. Escaping: Slack `&`, `<`, `>` become entities (this stops mentions and links such as
   `<!channel>`) and `* _ ~` and the backtick are wrapped in zero width spaces; Teams markdown characters are backslash escaped. Size: the
   renderers keep to the limits below and the Teams card is shortened until it fits 28 KB.
9. **v1 has no interactive buttons.** Slack interactivity and Teams actionable messages need a **public endpoint** that verifies a signature, which
   a self-hosted install behind a firewall often lacks. **v2 design (not built):** an optional per workspace "interaction endpoint" setting; Slack:
   an app with a signing secret (kept in the vault), `POST /api/chat/slack/interact` verifying `X-Slack-Signature` (v0, HMAC-SHA256 of
   `v0:<timestamp>:<body>`, five minute window), buttons "Snooze this alert" and "Acknowledge" that call the same functions as the inbox, each
   action mapped to the Slack user through a one time link between the Slack user id and the Kiln member; Teams: an Adaptive Card
   `Action.Execute` handled by a bot registration (JWT validation of the Bot Framework token), the same two actions. Nothing that publishes to a
   store would ever be offered as a chat button.
10. **Where it is in the app.** The brief asked for Settings, Integrations, Chat. The settings screen is one form with a shared save bar and four
    views; a screen with its own list, dialogs and log does not fit it, so Chat is a screen of its own in the Workspace group of the navigation,
    next to Webhooks and Alerts (`#/chat`). Moving it under a future "Integrations" heading is a one line change in `lib/views.ts`.

## Limits used (from the providers' documentation)

| Provider | Limit                                                                                                                                                                                                                          | Source                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Slack    | 50 blocks per message; header text 150 characters; section text 3000; at most 10 section fields of 2000 characters; button text 75 characters (may be cut near 30), button url 3000; `&`, `<`, `>` escaped as entities in text | docs.slack.dev block and formatting pages |
| Slack    | incoming webhooks: about 1 message per second per channel, short bursts tolerated; 429 with `Retry-After` in seconds                                                                                                           | docs.slack.dev rate limits                |
| Teams    | a message is 28 KB at most; more than 4 requests per second are throttled; Adaptive Card or MessageCard payloads; text fields take basic markdown                                                                              | learn.microsoft.com incoming webhook page |

## Consequences

- No new dependency, no public endpoint, one migration (52) and two new actions that no token can hold.
- A workspace without destinations pays one indexed query per new alert.
- Destinations of a deleted workspace member keep working: they belong to the workspace.
- Unverified (see the doc): real delivery to Slack and Teams, the exact Teams Workflows URL hosts, how Slack renders an attachment that has only
  blocks, Adaptive Card version 1.4 in every Workflows renderer, Slack's treatment of zero width spaces in mrkdwn, Postgres.
