# Step-up confirmation

Hard actions can ask for a fresh proof: a **passkey** (Touch ID, Face ID, Windows Hello, a PIN, a security
key) or a **password**. Design and reasons: [ADR 0019](../adr/0019-step-up-confirmation.md). Switched **off by
default**; **recommended on**. With it off, nothing below applies and every route behaves as before.

Routes are under `/api/workspaces/{workspaceId}/step-up`. **Every one is closed to API tokens.** A non-member
gets 404.

## The policy

`PUT /step-up/policy` (owner, admin: `settings.write`): `{ mode: "off" | "hard_actions", actions?, unattended? }`.

| Class | Covers |
| --- | --- |
| `store.publish` | `POST /apps/{id}/publish` (several steps at once) |
| `store.submit` | `POST /apps/{id}/store-submit` |
| `store.release` | `POST /apps/{id}/store-release` |
| `rollout` | `POST /apps/{id}/rollout/apply` |
| `internal_sharing` | reserved: Google Play internal app sharing has no route here yet |
| `analytics.enable_apple` | `POST /apps/{id}/analytics/apple/enable` |
| `credential.delete` | `DELETE /credentials/{id}` |
| `flags` | `PUT /settings` when it turns `analytics.enabled` or `translation.enabled` **on** (turning off is free) |
| `store.push_draft` | `POST /apps/{id}/staged/push` (not in the default list: a draft never reaches users) |

`actions` defaults to every class but `store.push_draft`. `unattended` is the list of classes API tokens may do
without a person (default empty, see [tokens](#api-tokens-and-ci)). Changing an active policy needs a fresh
confirmation (class `step_up.manage`). Audited as `step_up.policy_changed`.

`GET /step-up/status` (any member): `{ policy, factors: { passkeys[], password: { kind: "account" | "confirmation" } | null,
confirmationPasswordSettable }, enrolled, lockedUntil, supported: { webauthn, rpId, maxPasskeys }, grantTtlSeconds }`.
No key, hash or credential id is returned.

## Confirming an action

1. Call the apply endpoint. When the policy covers it and no valid grant came with it:
   `403 { error: "step_up_required", action, target, factors: ["passkey","password"], reason }` and **nothing is
   done**. `reason` is `missing`, `invalid`, `expired`, `used` or `mismatch`.
2. `POST /step-up/verify` with `{ factor, action, target?: { id?, hash? }, ... }`:
   - `factor: "password"`: `password`. In multi-user mode the account password; in single-user mode the
     confirmation password.
   - `factor: "passkey"`: first `POST /step-up/passkeys/assertion/options` `{ action, target? }`, which returns
     `{ challengeId, publicKey }` (options for `navigator.credentials.get`, base64url strings, `userVerification:
     "required"`); then `challengeId` and `assertion: { id, clientDataJSON, authenticatorData, signature }` (base64url).
   - Answer `200 { grant, expiresAt }`. The grant is valid **5 minutes**, for **one use**, for this **session**, person,
     workspace, `action` and `target.id` / `target.hash` if given.
3. Repeat the call from step 1 with `X-Step-Up-Grant: <grant>` (or the body field `stepUp`; never in a URL).
   Use `target.id` = the app (or credential, or setting) id and `target.hash` = the `confirmHash` or `planHash` the call
   carries (`hashField`: `confirmHash` for rollout, submit, release, analytics enable and push; `planHash` for publish),
   so the grant cannot be used for another plan.

Errors: `403 step_up_failed` (`reason`: `invalid_password` or `invalid_passkey`), `429 step_up_locked` with
`Retry-After` (five wrong answers in a row lock confirmation for 30 s, doubling to 15 min; a success resets it),
`429 step_up_busy` (one check at a time), `409 factor_not_enrolled`, `409 webauthn_unavailable` (not https or
localhost, or an IP address). The grant is spent **before** the action runs: if it then fails, confirm again.

Not enrolled: `403 step_up_not_enrolled` with a message saying to add a passkey or a confirmation password in
Settings, Security.

## Ways to confirm

- `POST /step-up/passkeys/register/options` then `POST /step-up/passkeys/register/verify` `{ challengeId, name,
  credential: { id, clientDataJSON, attestationObject, transports? } }`. Only attestation `none`, ES256 or
  EdDSA keys, user verification required; at most 10 per person. `201 { passkey }`.
  `400 passkey_rejected` with a fixed `reason` (`bad_origin`, `bad_challenge`, `user_not_verified`,
  `unsupported_algorithm`, `already_registered`, ...). A challenge lasts 2 minutes and is spent by its first use.
- `DELETE /step-up/passkeys/{id}`.
- `PUT /step-up/confirmation-password` `{ password }` (at least 12 characters): **single-user mode only**
  (`409 account_password_used` elsewhere). Hashed like account passwords.
- Adding or removing a way to confirm, setting the password and weakening an active policy need a fresh
  confirmation (action `step_up.manage`) **whenever the person already has a way to confirm**; the first one needs
  nothing. In multi-user mode that is always (the account password).

## API tokens and CI

A token cannot confirm: a token that does a covered action gets `403 step_up_required_human` (audited as
`step_up.refused`). To let automation do a class anyway, an admin lists it in `unattended`. **That removes the
confirmation for that class for every holder of any token that may do it**: use app-restricted, short-lived tokens,
and leave publishing, submitting and releasing off the list unless a pipeline truly needs them.

## Events and audit

Events `stepup.verified` and `stepup.failed` ([events](events.md)). Audit: `step_up.verified`, `step_up.failed`
(`factor`, `action`, `reason`, `failedCount`), `step_up.refused`, `step_up.passkey_added`,
`step_up.passkey_removed`, `step_up.password_set`, `step_up.policy_changed`. Never a password, key or grant.

## Origin

Passkeys are bound to the origin: `MRM_PUBLIC_ORIGIN` if set (for example `https://mrm.example.com`), else the origin
of the request (`Host`, or `X-Forwarded-Host` with `MRM_TRUST_PROXY=1`). `https` or `http://localhost`, and a host name.
Origins in `MRM_TRUSTED_ORIGINS` with the same host name (a dev server on another port) are accepted too.

## Unverified

- **No real authenticator was used.** The WebAuthn code is tested against a software authenticator built in
  the tests (real ES256 and Ed25519 keys, real CBOR, real signatures). Touch ID, Face ID, Windows Hello, security
  keys and synced passkeys (their flags, counters, attestation) have not been tried.
- **The desktop shell (Tauri web view) may not offer WebAuthn at all**, or may not accept `http://localhost` as a secure
  context; unverified. The UI detects it and falls back to the password; in single-user mode set a confirmation
  password in Settings, Security. If the web view's origin is not the server's origin, passkey checks fail with
  `bad_origin`.
- Windows Hello on hardware that offers only RS256 cannot be enrolled (RS256 is not supported).
- No browser run of the dialog and the Security card; only type checks and the pure logic.
