# Webhooks

A webhook sends a signed HTTP POST to your server when an [event](events.md) happens. Owners and
admins manage them in the web app (**Webhooks**) or through the endpoints below. Session cookie
only: an API token can never manage webhooks (see [tokens](tokens.md)).

Rights: `webhooks.read` and `webhooks.manage`, both owner and admin. A non-member gets 404; a
member without the right gets 403. Errors are `{ "error": "<code>", "message"?: "..." }`.

## What is sent

```
POST /hooks/mrm HTTP/1.1
Content-Type: application/json
User-Agent: MobileReleaseManager-Webhooks/1
X-MRM-Event: changeset.applied
X-MRM-Delivery: 7f0c5d0e-...
X-MRM-Timestamp: 1766000000
X-MRM-Signature: v1=3b5e...

{"id":1043,"type":"changeset.applied","workspaceId":"...","createdAt":1766000000000,
 "subject":{"repositoryId":"..."},"data":{"changeSetId":"...","prUrl":"https://github.com/..."}}
```

- The body is the event: `id` (null for a test), `type`, `workspaceId`, `createdAt`, `subject`, and
  the event's payload as `data`. See [events](events.md) for each type.
- `X-MRM-Delivery` is the id of the delivery; it stays the same across retries of one delivery, so
  use it to ignore duplicates. A redelivery is a new delivery with a new id and the same body.
- `X-MRM-Timestamp` is seconds since the epoch, set for each attempt.

## Verifying the signature

The signature is `v1=` followed by the hex HMAC-SHA256, keyed with the endpoint's secret, of
`<timestamp>.<raw body>`: the timestamp header, a dot, and the body exactly as received.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const timestamp = headers['x-mrm-timestamp'];
  const given = (headers['x-mrm-signature'] ?? '').replace(/^v1=/, '');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // reject replays
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

Compare in constant time, verify against the raw bytes before parsing JSON, and reject old
timestamps. The secret is `whsec_` plus 256 random bits. It is stored encrypted with the vault key,
bound to the workspace and the webhook, and shown once, when the webhook is created or its secret
rotated.

## Delivery, retries and the log

- A delivery succeeds on any 2xx answer. Anything else (a non-2xx status, a timeout after 10
  seconds, a connection failure, a DNS failure) is retried with exponential backoff (5 s, 10 s,
  20 s, 40 s) for 5 attempts in all, then it is `failed`. Delivery uses the job queue, so a server
  restart does not lose a delivery.
- A delivery to an address that is not allowed (see below) fails at once and is not retried.
- Statuses: `pending`, `retrying`, `success`, `failed`. Each delivery keeps its attempts, the last
  response code, the first 1000 printable characters of the last response (with the signing secret
  removed if the receiver echoes it) and the last error. Deliveries older than 30 days are removed
  at start-up.
- Delivery is at least once. Make receivers idempotent.
- A webhook that is disabled, or whose secret cannot be read, fails its waiting deliveries instead
  of sending them. Rotating the secret repairs the second case.
- Ordering is not guaranteed between deliveries.

## Where a webhook may point (SSRF protection)

A webhook is a request this server makes on your behalf, so it is a way to reach the server's own
network. The rules, enforced both when a webhook is saved and again at every delivery:

- `https://` only, with no user name or password in the URL, at most 2048 characters. Host names
  that are plainly internal (`localhost`, `*.local`, `*.internal`, a name without a dot) are refused.
- Every address the host name resolves to must be public. If **any** answer is loopback, private
  (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7), link-local (including the cloud metadata
  address 169.254.169.254), multicast, unspecified or otherwise not a public unicast address, the
  host is refused. IPv4-mapped IPv6 addresses and the IPv4 addresses inside NAT64 and 6to4 are
  judged as the IPv4 address they hold. Numeric forms such as `2130706433` or `0x7f.0.0.1` are not
  accepted.
- The connection goes to the checked address itself (the name is not looked up a second time),
  with the original name for TLS and the `Host` header. The peer address is checked again after
  connecting.
- Redirects are never followed. A new connection is made for every request.
- The response is read up to 64 KB and the rest is thrown away.
- `MRM_WEBHOOKS_ALLOW_PRIVATE=1` lifts the private-address rule for development and for receivers on
  your own network, and allows plain `http://` to `localhost` and loopback addresses. Link-local
  addresses (the cloud metadata endpoint) stay refused. Leave it off on a shared or hosted server.

## Endpoints

- `POST /api/workspaces/:wid/webhooks` body (16 KB at most)
  `{ "url", "description"?, "eventTypes": ["app.synced"] | ["*"], "enabled"? }`. `eventTypes` lists
  [event types](events.md#types), or `*` for all of them including types added later. 201
  `{ webhook, secret }`; the secret is in this response only (`Cache-Control: no-store`). 400
  `invalid_url` with a message for an address that is not allowed, 400 `invalid_request`, 409
  `too_many_webhooks` (20 per workspace).
- `GET /api/workspaces/:wid/webhooks` `{ webhooks: [...] }`. Each has `id`, `url`, `description`,
  `eventTypes`, `enabled`, `createdAt`, `updatedAt` and `lastDelivery` (`{ status, at, responseCode }`
  or null). Never the secret.
- `GET /api/workspaces/:wid/webhooks/:id` `{ webhook }`.
- `PATCH /api/workspaces/:wid/webhooks/:id` any of `url`, `description` (or null), `eventTypes`,
  `enabled`; at least one. A changed URL is checked again. 200 `{ webhook }`.
- `DELETE /api/workspaces/:wid/webhooks/:id` 204. Its deliveries go with it.
- `POST /api/workspaces/:wid/webhooks/:id/rotate-secret` 200 `{ secret }`. The old secret stops
  working at once.
- `POST /api/workspaces/:wid/webhooks/:id/test` queues a delivery of a `webhook.test` event
  (`{"id":null,"type":"webhook.test","data":{"message":"..."}}`) through the normal path, signed
  like any other. 202 `{ deliveryId }`. It is not written to the event log.
- `GET /api/workspaces/:wid/webhooks/:id/deliveries?limit=` newest first, 1 to 100 (default 20):
  `{ deliveries: [{ id, endpointId, eventId, eventType, status, attempts, responseCode,
  responseBody, error, redeliveryOf, createdAt, deliveredAt }] }`.
- `POST /api/workspaces/:wid/webhooks/:id/deliveries/:deliveryId/redeliver` sends the same body
  again as a new delivery whose `redeliveryOf` is the first one. 202 `{ deliveryId }`.

Tests and redeliveries share a budget of 10 a minute per workspace (429 `rate_limited` with
`Retry-After`). An unknown id answers 404 and does not use the budget.

Creating, changing, deleting, rotating, testing and redelivering are audited (`webhook.create`,
`webhook.update`, `webhook.delete`, `webhook.rotate_secret`, `webhook.test`, `webhook.redeliver`).
The audit log holds the address and the names of changed fields, never a secret.

## Not verified

- **No real receiver was called.** The delivery path was tested against a local HTTP server on
  loopback (with `allowPrivate`) and fake senders; TLS to a public host, certificate checking with
  the pinned address and `servername`, and real DNS were not exercised.
- The address checks were tested on the IPv4 and IPv6 cases listed above, not against every
  encoding a resolver or `URL` could produce. Treat the SSRF rules as defence in depth and keep the
  server on a network where it cannot reach what it should not.
- Only SQLite has run the tables and queries. Postgres has not.
