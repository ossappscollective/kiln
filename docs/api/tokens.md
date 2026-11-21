# API tokens

For scripts, CI jobs and assistants. A token is a long random string sent in an `Authorization`
header. It acts for the person who made it, with three further limits: a role ceiling, optionally a
list of apps, and optionally a list of actions. Owners and admins manage tokens in the web app
(**API tokens**) or through the endpoints below.

Errors are `{ "error": "<code>", "message"?: "..." }`. A non-member and a missing workspace both
answer 404; a member without the right answers 403.

## Using a token

```sh
curl -H "Authorization: Bearer kiln_..." https://kiln.example.com/api/workspaces/<workspaceId>/apps
```

- A token works in exactly one workspace. Another workspace answers 404, as if it did not exist.
- A request that carries a session cookie is treated as a session request and the `Authorization`
  header is ignored. A request with only the header is a token request. Because no cookie rides
  along, there is nothing for another website to forge, so the same-origin check that protects
  cookie sessions does not apply to token requests.
- Wrong, revoked, expired or malformed tokens answer 401 `invalid_token` with a
  `WWW-Authenticate: Bearer error="invalid_token"` header. The same answer is given for all of
  them. Repeated bad tokens from one client address are rate limited (60 per 5 minutes, then 429
  `too_many_attempts`).
- Each token has its own rate limit: 300 requests a minute, then 429 `rate_limited` with
  `Retry-After`. It is separate from the per-workspace limits on syncs and tests.
- The token is a secret like a password. Keep it out of URLs, logs and source control. The server
  never puts it in a URL, a log line or an audit entry, and it cannot show it again.

## What a token may do

A token may do an operation when **all** of these hold:

1. The operation is open to tokens (`x-kiln-token-access: true` in
   [the OpenAPI document](openapi.md)). Anything not listed there, including every route added later
   without an entry, is closed to tokens until someone lists it. **Tokens can never**: manage
   tokens (`tokens.read`, `tokens.manage`), manage members and invitations (`members.manage`),
   write credentials (`credentials.write`), or manage webhooks (`webhooks.read`,
   `webhooks.manage`). They cannot use `GET /api/me`, sign-in or the other account routes.
2. The **role ceiling** allows it. A token has `viewer`, `member` or `admin`, never `owner`, and
   never a role above the person who makes it. The effective ceiling is the lower of the token's
   role and its creator's current role, so demoting a person demotes their tokens.
3. If the token lists **actions**, the operation's action is in the list. Listed actions must be
   ones the role holds and tokens may hold.
4. If the token lists **apps**, the call is about one of them. Endpoints about one app
   (`/apps/{id}/...`) need that app, otherwise 404. Lists of apps are filtered to them, and events
   to events about them. Endpoints that are not about one app (repositories, change sets,
   credentials, members) answer 403 to an app-restricted token.
5. **Some actions are explicit-only.** A token whose `actions` is left out holds every action its role has **except** these, which it holds only when `actions`
   names them: `reviews.reply`, `releases.rollout`, `store.push_draft`, `store.submit`, `store.release`, `store.publish`, `ai.use`, `ai.manage` ([ai](ai.md)) and `analytics.manage` ([analytics](analytics.md)). An admin
   token without a list cannot run an AI task.

A token stops working at once when it is revoked or expires, and when its creator is no longer a
member of the workspace. Every call a token makes is recorded in the audit log with
`actorType: "token"`, `actorId` the token's id and `actorName` its name; the creator, whom the
token acts for, is in `detail.onBehalfOf`. Approval of change sets by tokens is up to the role: a `member` token can draft
and cannot approve; an `admin` token can approve and apply.

### Step-up confirmation

A token cannot confirm a hard action with a passkey or password. When the workspace has [step-up confirmation](step-up.md)
on, a token that does a covered action (publish, submit, release, rollout, enable Apple analytics, delete a credential,
turn a feature on) gets `403 step_up_required_human`, unless an admin allowed that class for unattended use. The step-up
routes themselves are not open to tokens.

## Endpoints

Rights: `tokens.read` (owner, admin) to list, `tokens.manage` (owner, admin) to create and revoke.
Session cookie only.

### `POST /api/workspaces/:wid/tokens`

Body (16 KB at most):

```json
{
  "name": "Release CI",
  "role": "member",
  "appIds": ["<appId>"],
  "actions": ["apps.read", "apps.sync"],
  "expiresAt": 1798761600000
}
```

`name` and `role` are required. `appIds` and `actions` are optional; leave them out for no limit.
`expiresAt` is epoch milliseconds in the future; leave it out for a token that does not expire.

201:

```json
{
  "token": "kiln_...",
  "summary": {
    "id": "...",
    "name": "Release CI",
    "prefix": "kiln_ab12cd",
    "role": "member",
    "appIds": ["..."],
    "actions": ["apps.read", "apps.sync"],
    "expiresAt": 1798761600000,
    "lastUsedAt": null,
    "revokedAt": null,
    "createdAt": 1766000000000,
    "createdBy": { "id": "...", "name": "Ada" },
    "status": "active"
  }
}
```

The `token` is in this response and nowhere else, ever (`Cache-Control: no-store`). It is `kiln_`
plus 256 random bits, base64url. Only its SHA-256 is stored. Tokens made before the product was
renamed start with `mrm_` instead; they stay valid and are not rewritten (the stored hash covers the
whole string), and the list shows the prefix they were made with.

Errors: 400 `invalid_request` (validation, or an expiry in the past), 400 `action_not_allowed`
(an action tokens can never hold), 400 `action_above_role` (an action the role does not include),
400 `unknown_app`, 403 `role_above_yours`, 409 `too_many_tokens` (100 active tokens per workspace),
413 `payload_too_large`.

### `GET /api/workspaces/:wid/tokens`

`{ "tokens": [summary] }`, newest first, revoked and expired ones included with their `status`
(`active`, `revoked`, `expired`). Never the token or its hash. `prefix` is `kiln_` and six
characters, enough to tell tokens apart. `lastUsedAt` is updated at most once a minute.

### `DELETE /api/workspaces/:wid/tokens/:id`

Revokes the token. 204. Takes effect on the next request; an open event stream ends at its next
heartbeat. Revoking a revoked token is fine and answers 204; an unknown id is 404.

## Audit

`token.create` (name, role, apps, actions, expiry) and `token.revoke` are audited with the person
as actor. Calls made with a token are audited under the token. The audit log never contains a token.

## Not verified

- Only SQLite has run it. The migration and queries are portable and a schema drift test passes,
  but nothing ran on Postgres.
- The web screen was compiled and type-checked and its logic unit tested; it was never rendered in
  a browser.
- Rate limits are per process and reset on restart, like the others.
