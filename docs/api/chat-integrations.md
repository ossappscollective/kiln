# Chat integrations API

Slack and Microsoft Teams destinations, their routing rules and delivery log. Concepts: [chat-integrations](../chat-integrations.md).
**Owners and admins, session cookie only**: `chat.read` and `chat.manage` are among the actions no API token can hold (see
[tokens](tokens.md)), so there is no MCP tool either. A non-member gets 404, a member or viewer 403. Errors are
`{ "error": "<code>", "message"?, "code"?, "params"? }` ([i18n-server](../i18n-server.md)).

**The webhook URL is never returned.** It is accepted in `POST` and `PATCH` and stored encrypted; every answer carries only `urlHint`, its last four characters.

## The destination

```json
{ "id": "…", "provider": "slack", "name": "#releases", "urlHint": "Xy7Q", "locale": "fr", "enabled": true, "allowAnyHost": false,
  "digest": "daily", "digestHour": 8, "timezone": "Europe/Paris", "createdAt": 1766000000000, "updatedAt": 1766000000000,
  "routes": [{ "id": "…", "alertTypes": ["*"], "minSeverity": "critical", "appIds": null, "platforms": null, "enabled": true }],
  "lastDelivery": { "status": "sent", "outcome": "ok", "at": 1766000100000 } }
```

## Endpoints

- `GET /api/workspaces/:wid/chat/destinations` `{ destinations: [...] }`.
- `POST /api/workspaces/:wid/chat/destinations` body (32 KB at most) `{ provider: "slack"|"teams", name, url, locale?: "en"|"fr"|"es"|"de",
  enabled?, allowAnyHost?, digest?: "off"|"daily", digestHour?: 0-23, timezone?, routes? }`. Without `routes` the defaults apply (every critical
  alert, every alert of the releases group). 201 `{ destination }`. 400 `invalid_url` (`chat.urlInvalid`: not https, a user name in the URL, a
  private or blocked address), 400 `host_not_allowed` (`chat.hostNotAllowed`: not a host of the provider and `allowAnyHost` is not set), 400
  `invalid_request`, 409 `too_many_destinations` (20 per workspace).
- `GET /api/workspaces/:wid/chat/destinations/:id` `{ destination }`.
- `PATCH /api/workspaces/:wid/chat/destinations/:id` any of `name`, `url` (replaces the stored address and is checked again), `locale`,
  `enabled`, `allowAnyHost`, `digest`, `digestHour`, `timezone`; at least one. 200 `{ destination }`.
- `PUT /api/workspaces/:wid/chat/destinations/:id/routes` `{ routes: [{ alertTypes: ["*"] | [type, ...], minSeverity?: "info"|"warning"|"critical",
  appIds?: [id] | null, platforms?: ["ios"|"macos"|"android"] | null, enabled? }] }` (up to 20) replaces all rules. 200 `{ destination }`. The
  alert types are those of `GET /alerts/catalog`.
- `DELETE /api/workspaces/:wid/chat/destinations/:id` 204. Its rules and deliveries go with it.
- `POST /api/workspaces/:wid/chat/destinations/:id/test` queues a test message in the destination's language through the normal path (also
  from a disabled destination). 202 `{ deliveryId }`. 10 a minute per workspace (429 `rate_limited`, `Retry-After`). An unknown id is a 404 and costs no slot.
- `GET /api/workspaces/:wid/chat/destinations/:id/deliveries?limit=` newest first, 1 to 100 (default 20): `{ deliveries: [{ id, destinationId,
  alertId, kind: "alert"|"digest"|"test", status: "queued"|"retrying"|"sent"|"failed"|"skipped"|"deferred", outcome, httpStatus, attempts, title,
  createdAt, deliveredAt }] }`. `outcome` is one of the codes in [chat-integrations](../chat-integrations.md#delivery). Never the message body.

Creating, changing, replacing rules, deleting and testing are audited (`chat.destination.create|update|delete|test`, `chat.routes.update`). The audit log holds
the provider, the name, the last four characters and the names of changed fields, never the address.
