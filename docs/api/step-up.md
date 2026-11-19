# Step-up confirmation

Hard actions can ask for a fresh proof: a **passkey** (Touch ID, Face ID, Windows Hello, a PIN, a security
key), a **password**, a one-time **recovery code**, the six digits of an **authenticator app** or a **code sent by email**
([two-factor](two-factor.md)). Design and reasons: [ADR 0019](../adr/0019-step-up-confirmation.md). Switched **off by
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
| `internal_sharing` | `POST /apps/{id}/builds/artifacts/{artifactId}/internal-share` (upload a build to Google Play internal app sharing, [internal-sharing](internal-sharing.md)) |
| `analytics.enable_apple` | `POST /apps/{id}/analytics/apple/enable` |
| `credential.delete` | `DELETE /credentials/{id}` |
| `flags` | `PUT /settings` when it turns `analytics.enabled` or `translation.enabled` **on** (turning off is free) |
| `store.push_draft` | `POST /apps/{id}/staged/push` (not in the default list: a draft never reaches users) |

`actions` defaults to every class but `store.push_draft`. `unattended` is the list of classes API tokens may do
without a person (default empty, see [tokens](#api-tokens-and-ci)). Changing an active policy needs a fresh
confirmation (class `step_up.manage`). Audited as `step_up.policy_changed`.

`GET /step-up/status` (any member): `{ policy, factors: { passkeys[], password: { kind: "account" | "confirmation" } | null,
confirmationPasswordSettable }, enrolled, recovery: { remaining, total, generatedAt }, lockedUntil, supported: { webauthn, rpId, maxPasskeys }, grantTtlSeconds }`.
No key, hash or credential id is returned.

## Confirming an action

1. Call the apply endpoint. When the policy covers it and no valid grant came with it:
   `403 { error: "step_up_required", action, target, factors: ["passkey","password"], reason }` and **nothing is
   done**. `reason` is `missing`, `invalid`, `expired`, `used` or `mismatch`.
2. `POST /step-up/verify` with `{ factor, action, target?: { id?, hash? }, ... }`:
   - `factor: "password"`: `password`. In multi-user mode the account password; in single-user mode the
     confirmation password.
   - `factor: "recovery"`: `code`, one of the ten [recovery codes](#recovery-codes). Spent by its first use; wrong ones count like wrong passwords.
   - `factor: "passkey"`: first `POST /step-up/passkeys/assertion/options` `{ action, target? }`, which returns
     `{ challengeId, publicKey }` (options for `navigator.credentials.get`, base64url strings, `userVerification:
     "required"`); then `challengeId` and `assertion: { id, clientDataJSON, authenticatorData, signature }` (base64url).
   - Answer `200 { grant, expiresAt }`. The grant is valid **5 minutes**, for **one use**, for this **session**, person,
     workspace, `action` and `target.id` / `target.hash` if given.
3. Repeat the call from step 1 with `X-Step-Up-Grant: <grant>` (or the body field `stepUp`; never in a URL).
   Use `target.id` = the app (or credential, or setting) id and `target.hash` = the `confirmHash` or `planHash` the call
   carries (`hashField`: `confirmHash` for rollout, submit, release, analytics enable and push; `planHash` for publish),
   so the grant cannot be used for another plan.

Errors: `403 step_up_failed` (`reason`: `invalid_password`, `invalid_passkey` or `invalid_recovery_code`), `429 step_up_locked` with
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
- Authenticator app and email codes: set up, removed and used through the routes in [two-factor](two-factor.md); they confirm with
  `POST /step-up/verify` `{ factor: "totp" | "email", action, target?, code }` (an emailed code is requested first with
  `POST /step-up/email-code`). They count as enrolled, so a passkey-only window has a way out. A wrong code counts toward the same lockout.
- Adding or removing a way to confirm, setting the password and weakening an active policy need a fresh
  confirmation (action `step_up.manage`) **whenever the person already has a way to confirm**; the first one needs
  nothing. In multi-user mode that is always (the account password).

## Recovery codes

Ten one-time codes a person keeps offline (a password manager, a printout). They are a **third way to confirm**, and the way back in when the only passkey or
confirmation password is lost.

- `POST /step-up/recovery-codes` (owner, admin: `settings.write`, closed to tokens): makes ten new codes and **invalidates any older ones**.
  `201 { codes[], remaining, generatedAt }`, `Cache-Control: no-store`. **The codes are in this answer only**: stored as salted SHA-256 (a code is 100 random bits,
  `XXXXX-XXXXX-XXXXX-XXXXX`, Crockford base 32; case, dashes and spaces do not matter, `O` is `0`, `I` and `L` are `1`). Needs a fresh confirmation (class
  `step_up.manage`: a passkey, the password, or a code that is left), so a stolen session cannot make codes for itself, and at least one passkey or password
  (`409 factor_not_enrolled`). Make them when you turn the policy on; the Security card offers it.
- `GET /step-up/status` shows `recovery: { remaining, total, generatedAt }` (counts only, for the signed-in person).
- Confirming: `POST /step-up/verify` `{ factor: "recovery", action, target?, code }`. The code is **spent before the grant exists**, constant-time compared against the
  person's unused codes, and works for any class and for `step_up.manage`. A wrong code counts as a wrong answer (the same five-in-a-row lockout, doubling to 15 minutes,
  shared with the password and the passkey). `409 factor_not_enrolled` (`reason: recovery`) when none is left. The `step_up_required` answer lists `recovery` in
  `factors` when the person has one left, beside a real factor (never instead of one).
- **Replacing a lost factor:** confirm with a code for `step_up.manage`, then `DELETE /step-up/passkeys/{id}` or `PUT /step-up/confirmation-password`. Removing the last
  factor leaves the person not enrolled, so the first new one needs nothing; the remaining codes wait until there is a factor again.
- Audit: `step_up.recovery_generated` (`count`, `replaced`), `step_up.recovery_used` (`action`, `remaining`), plus the ordinary `step_up.verified` / `step_up.failed`.
  Event `stepup.recovery_used` (admins read it: a code used is worth a look). **Never a code.**
- Not done: no way to see the codes again (make new ones), no codes for people who cannot confirm at all, no per-code labels.

## API tokens and CI

A token cannot confirm: a token that does a covered action gets `403 step_up_required_human` (audited as
`step_up.refused`). To let automation do a class anyway, an admin lists it in `unattended`. **That removes the
confirmation for that class for every holder of any token that may do it**: use app-restricted, short-lived tokens,
and leave publishing, submitting and releasing off the list unless a pipeline truly needs them.

## Events and audit

Events `stepup.verified`, `stepup.failed` and `stepup.recovery_used` ([events](events.md)); the factor can also be `totp` or `email`. Audit: `step_up.verified`, `step_up.failed`
(`factor`, `action`, `reason`, `failedCount`), `step_up.refused`, `step_up.passkey_added`,
`step_up.passkey_removed`, `step_up.password_set`, `step_up.policy_changed`, `step_up.recovery_generated`, `step_up.recovery_used`. Never a password, key or grant.

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
