# Alerts API

Alerts tell people what needs attention: an inbox per person, email, desktop notifications and a webhook event. What is alerted, how
repeats are collapsed and how a person's choices combine is in [alerts](../alerts.md); the reasons are in [ADR 0022](../adr/0022-alerts.md).

All paths are under `/api/workspaces/{workspaceId}`. Errors are `{ "error": "<code>", "message"?: "..." }`. A non-member and a missing
workspace both answer 404; a member without the right answers 403. Bodies larger than 8 KiB answer 413. Inbox answers are `Cache-Control:
no-store`.

Rights: `alerts.read` (owner, admin, member, viewer), `alerts.write` (owner, admin, member), `alerts.manage` (owner, admin).

## API tokens

Alerts belong to a person. A token may read the catalog, the inbox, the unread count and the delivery log (`alerts.read`). Reading or
changing a person's own settings, choices, mutes, marking alerts read and test alerts are **session only** (`token: false` in the
operation registry). `alerts.manage` is **explicit-only**: a token never gets it from its role ceiling; whoever makes the token must list it, and the
person's role must have it. The workspace rules can therefore be given to a token on purpose. (`alerts.write` is not on that list because
every operation that needs it is closed to tokens anyway.)

## Endpoints

| Method and path | Right | Token | What |
|---|---|---|---|
| `GET /alerts/catalog` | `alerts.read` | yes | Every alert type with the workspace rule applied. |
| `GET /alerts/inbox?unread=1&limit=&before=` | `alerts.read` | yes | The caller's alerts, newest first (by last seen). |
| `GET /alerts/unread-count` | `alerts.read` | yes | `{ "unreadCount": n }`. |
| `POST /alerts/inbox/read` | `alerts.read` | no | Body `{ "ids": [...] }` or `{ "all": true }`. Answers `{ marked, unreadCount }`. |
| `GET /alerts/settings` | `alerts.read` | no | The caller's settings, channel choices and mutes. |
| `PUT /alerts/settings` | `alerts.write` | no | Lowest severity, quiet hours, time zone, digest. |
| `PUT /alerts/preferences/{alertType}` | `alerts.write` | no | The caller's channels for a type, for all apps or one. |
| `POST /alerts/mutes`, `DELETE /alerts/mutes/{id}` | `alerts.write` | no | Mute or snooze; remove. |
| `PUT /alerts/rules/{alertType}`, `DELETE ...` | `alerts.manage` | explicit | Workspace rule; back to the default. |
| `GET /alerts/deliveries?limit=&scope=workspace` | `alerts.read` (`alerts.manage` for `scope=workspace`) | yes | The delivery log: the caller's rows, or the whole workspace for admins. |
| `POST /alerts/test` | `alerts.write` | no | Send a test alert through one channel (10 per workspace per minute; 429 with `Retry-After`). |

### Catalog

`GET /alerts/catalog` answers `{ "catalog": [ ... ] }`. Each entry: `id`, `group`, `groupLabel`, `label`, `description`, `severity`
(`info`, `warning`, `critical`), `scope` (`workspace`, `app`), `defaultChannels`, `allowedChannels`, `audience` (the action a role needs to be told),
`source` (`event` or `state`), `events`, `dedupe` (the key template), `dedupeWindowHours`, `params` (`key`, `label`, `unit`, `default`, `min`, `max`),
`visible` (false when the caller's role can never receive it) and `rule` (`enabled`, `channels`, `maxPerHour`, `params`, `custom`).
Channels are `in_app`, `email`, `desktop`, `webhook`.

### Inbox

`GET /alerts/inbox` answers `{ alerts, unreadCount, hasMore, now }`. An alert: `id`, `type`, `severity`, `title`, `body`, `appId`, `count`
(how often it repeated), `firstAt`, `lastAt`, `resolvedAt` (a state condition that cleared), `read`, `desktop` (whether a desktop notification
is due for this person). `limit` is 1 to 100 (default 30); `before` is an epoch milliseconds `lastAt`, for the next page.

### Settings

`PUT /alerts/settings` (all fields optional, unknown fields are 400): `minSeverity`, `quietStart` and `quietEnd` (minutes after midnight, 0 to
1439, both or neither), `timezone` (an IANA name), `digest` (`off`, `daily`, `weekly`), `digestHour` (0 to 23). A wrong value answers 400 with `invalid_severity`, `invalid_quiet_hours`, `invalid_timezone`, `invalid_digest` or `invalid_digest_hour`.

`PUT /alerts/preferences/{alertType}` body `{ "appId": null | "<app>", "channels": ["in_app", "email", "desktop"] | null }`. `null` removes the
choice (back to the default). A channel the type does not allow, and the webhook channel (which is not personal), answer 400 `channel_not_allowed`; an app for a workspace-scoped type answers 400 `not_app_scoped`. A type that does not exist, or an app of another workspace, is 404. Choosing `desktop` includes `in_app`.

`POST /alerts/mutes` body `{ "appId"?: null | "<app>", "alertType"?: null | "<type>", "hours"?: 1 to 8784 }`; without `hours` it lasts until removed. A time further than a year away answers 400 `invalid_until`; at most 100 mutes per person.

### Rules (admins)

`PUT /alerts/rules/{alertType}` body (all optional): `enabled`, `channels` (only what the type allows), `maxPerHour` (1 to 1000, or null), `params`
(integers inside each setting's range). Errors: 400 `channel_not_allowed`, `unknown_param`, `param_out_of_range`, `max_per_hour_out_of_range`. Audited as `alert.rule_set`; `DELETE` as `alert.rule_reset`.

### Delivery log

`GET /alerts/deliveries` answers `{ "deliveries": [ ... ] }`: `id`, `alertId`, `alertType`, `title`, `userId`, `channel`, `kind` (`alert`, `digest`,
`test`), `status` (`queued`, `retrying`, `sent`, `failed`, `skipped`, `deferred`), `outcome`, `attempts`, `createdAt`, `deliveredAt`. `outcome` is
always one of the fixed codes in [alerts](../alerts.md#email-and-the-delivery-log); no text from a mail server or store is stored or returned.

### Test alerts

`POST /alerts/test` body `{ "channel": "in_app" | "email" | "desktop" | "webhook" }` answers 202 `{ alertId, deliveries }`. It reaches the caller only (the
webhook test: the workspace's webhooks, admins only, 403 otherwise) and ignores mutes, limits and the repeat window. It is audited as `alert.test`.

## Webhook event: `alert.raised`

When a type's rule has the `webhook` channel and an enabled webhook listens for `alert.raised` (or `*`), one `alert.raised` [event](events.md) is written per alert and delivered, signed, to webhooks that
listen for it (or for all events). Data: `alertId`, `alertType`, `severity`, `title`, `appId`, `count`, `test`. The subject is `{ "appId" }` for an app alert.
Read right: `alerts.read`. Alerts are never raised for `alert.raised` itself.

Two further events were added for the alerts that depend on them: `token.created` and `member.added` (see [events](events.md)).
