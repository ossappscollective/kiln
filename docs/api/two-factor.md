# Two-factor codes

An authenticator app (TOTP) and codes sent by email, as extra ways to confirm a hard action ([step-up](step-up.md)) and, on a
server with accounts, as an optional second step when signing in. Design and reasons:
[ADR 0021](../adr/0021-two-factor-and-smtp.md). Sending mail needs a mail server: [mail](mail.md).

**API tokens cannot use any of this.** Every route on this page answers `403` to a token (`token: false` in the operation
registry). They are for people in a browser.

## What a person can set up

| | Authenticator app | Email code |
| --- | --- | --- |
| Standard | TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds | 6 digits |
| Valid | the current 30 second step and one either side | 10 minutes, 5 tries |
| Use | once: a code from a step already used is refused | once |
| Stored | the secret, encrypted with the master key | a keyed hash only; the address is stored with its verified time |
| Sent to | not sent: the app shows it | the person's verified address only |
| Needs | nothing from the server | a mail server ([mail](mail.md)) |

Both count as "enrolled" for [step-up](step-up.md): once a person has one, hard actions can be confirmed with it, and the
passkey and password stay as they were. A wrong code counts toward the same lockout as a wrong password (5 failures, then 30
seconds, doubling to 15 minutes, for all ways together).

## Routes

All under `/api/workspaces/:workspaceId`, for the signed-in member; answers carry `Cache-Control: no-store`.

| Route | Role | What it does |
| --- | --- | --- |
| `GET /two-factor/status` | member | `{ totp: { state: none \| pending \| active, confirmedAt }, email: { address, verified, verifiedAt, usable } \| null, mailConfigured, emailAddressEditable, recovery, login: { supported, mode, membersWithoutSecondFactor? } }`. `membersWithoutSecondFactor` is for owners and admins. |
| `POST /two-factor/totp/begin` | member, step-up once enrolled | Makes a new secret (not active yet). Answers `201 { secret, uri, issuer, account }`: the secret as text and the `otpauth://` URI to draw as a QR code. Shown once; a second `begin` replaces a pending secret. `409 already_enrolled` when one is active. |
| `POST /two-factor/totp/confirm` | member | `{ code }`. The first right code turns it on. `409 not_started`, `400 invalid_code`. |
| `DELETE /two-factor/totp` | member, step-up | Removes it. |
| `POST /two-factor/email/begin` | member, step-up once enrolled | Sends a code to prove an address. On a server with accounts it goes to the account email. In single-user mode there is no account email: send `{ email }`. `202 { expiresAt, resendAfterSeconds, to }` with `to` masked. |
| `POST /two-factor/email/confirm` | member | `{ code }`. Marks the address verified. `400 invalid_code`, `400 code_expired` (ask for a new code), `429 too_many_attempts` (5 wrong tries: ask for a new code). |
| `DELETE /two-factor/email` | member, step-up | Removes it. |
| `POST /step-up/email-code` | member | `{ action, target? }`. Sends a code for one confirmation, bound to this session, workspace, action and target. The address is never part of the request. `409 factor_not_enrolled` when no address is verified. |
| `PUT /two-factor/policy` | settings.write, step-up | `{ mode: off \| optional \| admins \| all }`. Servers with accounts only (`409 single_user_mode`). `409 two_factor_not_enrolled` when the person asking has no factor and `mode` would require one of them. |
| `DELETE /two-factor/members/:userId` | members.manage, step-up | Removes that member's app and email. For a lost phone with no recovery codes. Audited. |

To confirm with a code, use [`POST /step-up/verify`](step-up.md#confirming-an-action) with `{ factor: "totp" | "email", action,
target?, code }`. The answer is the usual grant. Reasons for a refusal: `invalid_code`, `code_already_used` (app),
`code_not_sent` and `code_expired` and `code_locked` (email: ask for a new code).

Failure answers use fixed codes. Mail ones: `mail_not_configured` (`409`), `busy` (`429`, another code is being sent), `email_required` and `invalid_email` (`400`), `already_verified` (`409`), `rate_limited` (`429`, with `Retry-After`: one code per
60 seconds, 6 per hour per person, 30 per hour per workspace, 60 per hour per server), `mail_failed` (`502`, with `code` one of
the mail codes and an optional `hint`). Nothing a mail server said is in an answer.

## Signing in with a second factor

Servers with accounts only. Single-user mode has no sign-in, so there it is only a step-up factor.

The policy `security.twoFactor`, per workspace, set by an owner or admin:

| Mode | Meaning |
| --- | --- |
| `off` (default) | Signing in needs the password only. Nothing changes when you upgrade. |
| `optional` | A person who has an app or a verified email must use it after the password. |
| `admins` | Owners and admins must have one; they set it up at the next sign-in if they have none. Others as `optional`. |
| `all` | Every member must have one. |

A person who belongs to several workspaces gets the strictest of them. Raising the policy does not sign anyone out; it applies to
the next sign-in. The Security card shows how many members have no second factor yet.

### The two steps

`POST /api/auth/login` with the right email and password, when a second factor is asked for, answers `200` **without a session**:

```json
{ "twoFactorRequired": true, "enrollmentRequired": false, "challenge": "lgc_...", "methods": ["totp", "email", "recovery"] }
```

`challenge` is the only credential for the next calls. It lasts 5 minutes and 5 wrong codes, is kept by the browser in memory,
and is stored by the server only as a SHA-256. Wrong password still answers `401 invalid_credentials` and counts toward the
login limit; a right password does not reset that count before the second step succeeds.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/auth/login/two-factor` | `{ challenge, method: totp \| email \| recovery, code }` | `200 { user }` and the session cookie. `401 invalid_second_factor`; `401 challenge_invalid` (expired or used up: sign in again); `429 too_many_attempts`. |
| `POST /api/auth/login/two-factor/email-code` | `{ challenge }` | `202 { expiresAt, resendAfterSeconds, to }` |

When `enrollmentRequired` is true the account has no second factor and the policy requires one. Only then these work, and only
with a challenge of that kind (a challenge for an account that already has a factor cannot enroll a second one, so a stolen
password cannot add a factor of the thief's):

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/auth/login/enroll/totp` | `{ challenge }` | `201 { secret, uri, issuer, account }` |
| `POST /api/auth/login/enroll/totp/confirm` | `{ challenge, code }` | `200 { user }` and the session cookie |
| `POST /api/auth/login/enroll/email` | `{ challenge }` | `202 { expiresAt, resendAfterSeconds, to }` (the account email) |
| `POST /api/auth/login/enroll/email/confirm` | `{ challenge, code }` | `200 { user }` and the session cookie |

`methods` lists what can be used now: `totp` when an app is active, `email` when an address is verified and a mail server is
set up, `recovery` while recovery codes are left. Recovery codes are the way in when the phone is gone.

## Events and audit

Events: `stepup.verified` and `stepup.failed` (factor `totp` or `email`), `auth.second_factor_failed` ([events](events.md)).
Audit actions: `two_factor.totp_enrolled`, `two_factor.totp_removed`, `two_factor.email_code_sent`, `two_factor.email_verified`,
`two_factor.email_removed`, `two_factor.policy_changed` (`from`, `to`), `two_factor.reset`, `two_factor.enrolled_at_login`,
`auth.second_factor_verified` and `auth.second_factor_failed` (`method`, `reason`). Ids and fixed words only: never a code, a
secret, a challenge or an address.

## If someone is locked out

- Another admin resets them: `DELETE /two-factor/members/:userId`.
- With recovery codes they sign in with one (`method: recovery`).
- The only owner, with no codes and no phone: the person who runs the server deletes the rows for that user in `user_totp` and
  `user_mail` and sets the policy to `off`, or removes it with a database tool.
  There is deliberately no web-only way around a second factor.

## Unverified

- **No real authenticator app was used.** Tests use the RFC 6238 vectors and a software generator. Google Authenticator,
  1Password, Authy, Microsoft Authenticator and Apple Passwords should all accept the URI; none was tried, nor the QR scan.
- **No real mailbox.** Email codes were tested with an in-process fake mailer and a fake SMTP server. Delivery, spam filters and
  delay are untested.
- **No browser run** of the Security card, the confirmation dialog or the sign-in step: only type checks, a compile check and the
  tests of the pure logic.
- PostgreSQL: the migrations and queries are written for both dialects, but the tests ran on SQLite.
- The 30 second step assumes the server clock is right (NTP).
