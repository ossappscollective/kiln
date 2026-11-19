# Testing credentials ("Test connection")

Both routes need the `credentials.write` right (owner or admin). A test only reads from the
service the credential belongs to. The secret is used for that one call and is never stored,
logged or returned; every message and detail is redacted against it before it leaves the server.

## Test a secret before saving it

`POST /api/workspaces/:workspaceId/credentials/test`

```json
{ "kind": "github_token", "secret": "ghp_..." }
```

`kind` is one of `app_store_connect`, `google_play`, `github_app`, `github_token`. `secret` is
the same single string that `POST /credentials` takes. A secret of the wrong shape is a `400`
`invalid_secret` with a reason, exactly as when saving.

## Test a saved credential

`POST /api/workspaces/:workspaceId/credentials/:id/test` (no body)

The secret is decrypted for the call. The result is remembered on the credential, and
`GET /credentials` items carry it as `lastTest`: `{ "at": 1760000000000, "ok": true, "message": "..." }`
(`at` in epoch milliseconds), or `null` when never tested. Rotating the secret clears it.
An unknown id, or one in another workspace, is `404`.

The result is recorded only on the exact secret that was tested. If the secret is rotated (or
the credential deleted) while the test is still running, the response carries `"superseded": true`
and nothing is stored: the answer is about the old secret and must not appear next to the new one.

## Response (both routes)

`200`, always, when the test ran, whether or not it passed:

```json
{
  "ok": false,
  "message": "The installation ID does not belong to this app. ...",
  "details": ["App: Release Bot"]
}
```

- `message` is a sentence a person can act on. `details` are short extra facts (account, scopes,
  permission warnings); a passing test may still carry `Warning: ...` details.
- Network errors, timeouts and verifier failures are `ok: false` with a sentence, never a `500`.
  A test is stopped after 10 seconds.
- A kind with no verifier yet answers `ok: false`, "Testing this kind of credential is not
  available yet."

## Limits

At most 10 tests per workspace per minute (in memory, per server process), counting both routes.
Over the limit: `429` `{ "error": "rate_limited", "message": "..." }` with a `Retry-After` header
in seconds. Requests that fail validation or name an unknown credential do not count.

## Audit

- Saved credential: `credential.use` (purpose `connection test`) and `credential.test` with
  detail `{ "ok": true }`, target the credential.
- Unsaved secret: `credential.test` with detail `{ "kind": "github_token", "ok": true, "saved": false }`.

Neither carries the secret or the message.
