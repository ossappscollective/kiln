# ADR 0021: Two-factor codes and outgoing mail (SMTP)

Status: implemented and tested on SQLite against an in-process fake SMTP server (plain, STARTTLS and implicit TLS with a
throwaway certificate) and RFC 6238 test vectors. **Never run against a real mail provider, and never with a real
authenticator app.** The list of what was not verified is in [api/two-factor](../api/two-factor.md#unverified) and
[api/mail](../api/mail.md#unverified).

## Context

[ADR 0019](0019-step-up-confirmation.md) asks for a fresh proof before a hard action: a passkey, a confirmation password
or a recovery code. Two requests followed. People who cannot or will not use a passkey want the six digits an authenticator
app shows, or a code sent by email. And on a server with accounts, a stolen or guessed password should not be enough to
sign in. Both need something the app did not have: a way to send email. Alerts need it too, and are coded against the same
mailer.

The app runs as a single process, often in a home lab or a small company network, and has no mail dependency
(`nodemailer` is not installed and this decision does not add one).

## Decision

### Mail

1. **One module, `services/mailer.ts`, is the only door to email.** `sendMail({ to, subject, text, html? })` answers
   `{ ok: true }` or `{ ok: false, code }` and **never throws**. The code is one of a fixed list: `smtp_not_configured`,
   `smtp_connection_failed`, `smtp_auth_failed`, `smtp_tls_failed`, `smtp_rejected`, `smtp_timeout`. The text a mail server
   sends back is never shown or logged (it can name internal hosts and addresses); the screen shows a sentence for the code
   and, where it helps, one for a fixed `hint` (`certificate_rejected`, `starttls_not_offered`, `private_address_blocked`).
   Tests and other agents use `createFakeMailer()` through `setMailer()`.
2. **A small SMTP client on `node:net` and `node:tls`.** STARTTLS and implicit TLS, `AUTH PLAIN` and `AUTH LOGIN`, MIME
   with a text part and an optional html part (quoted-printable, RFC 2047 words for non-ASCII headers), dot-stuffing,
   header-injection-safe (CR, LF and NUL are refused in every header value and address), a timeout per step (15 s) and in
   total (60 s), a cap of 16 KiB per reply line, 100 reply lines, 20 recipients and 1 MiB per message. TLS certificates are
   always verified; there is no switch for "accept any certificate".
3. **No password in the clear.** `AUTH` is only sent over TLS (implicit, or after STARTTLS), or to a server on this machine.
   A server that does not offer STARTTLS when `starttls` is chosen is an error (`smtp_tls_failed`, hint
   `starttls_not_offered`); the client never falls back to plain text, so a network attacker cannot strip STARTTLS to read
   the password.
4. **A private-address policy.** The mail host is set by an admin, so it is a way to make the server open connections.
   Like webhooks, a host that resolves to a private, loopback, link-local or metadata address is refused unless
   `MRM_SMTP_ALLOW_PRIVATE_HOSTS=true` (default false), set by the person who runs the server and not changeable from the
   screen. The address that passed the check is the address connected to (no second lookup), which closes DNS rebinding.
   `MRM_SMTP_ALLOW_PRIVATE_HOSTS` is what a home-lab mail relay needs.
5. **Where the setting lives.** Either the environment (`MRM_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASSWORD`, `_FROM`),
   which wins and makes the screen read only, or an admin-edited instance setting stored encrypted with the master key like
   credentials (table `instance_settings`). The password is never returned by any route. Changing the host, the port or the
   user name asks for the password again, so an admin (or a stolen admin session) cannot point the saved password at a
   server they control to read it. Saving and clearing need a step-up confirmation (`step_up.manage`) and are audited
   (`mail.settings_changed`, `mail.settings_cleared`) without the password.
6. **"Send test email" goes to the person who clicks it**, to their own account email (in single-user mode, to an address
   they type). The route is not a way to send mail to anyone else, and is limited to 5 per 10 minutes per person.

### Second factors

7. **TOTP, RFC 6238**: SHA-1, six digits, 30 seconds, one step either side for clock drift. These are the parameters every
   authenticator app supports. The secret is 20 random bytes, shown once as text and as a QR code (`otpauth://` URI, drawn
   in the browser by the existing `lib/qr.ts`; the secret never goes to a third party), and stored encrypted with the
   master key, bound to the user. A code is **single use**: the last accepted time step is stored and a code from that
   step or an earlier one is refused (`code_already_used`), with a conditional update so two simultaneous requests cannot
   both win. Setup is confirmed by the first code; until then the secret is "pending" and does not count.
8. **Email codes**: six digits, **10 minutes**, **5 attempts**, one use, and only a keyed hash (HMAC under the master key,
   bound to user, purpose and, for confirmations, session, workspace, action and target) is stored. The number of
   attempts is counted in the same conditional update that checks the code, before the comparison, so parallel guesses do
   not get extra tries. A code is sent **only to the user's verified address**: the account email on a server with accounts,
   an address the person typed and proved with a code in single-user mode. The requests that send a login or confirmation code never name an address, so they cannot be used to mail a stranger.
   The one place an address is typed is verifying a new address in single-user mode, which needs a step-up confirmation as soon as the person has any way to confirm, sends one
   code to that address and counts against the same limits. Limits: one code per 60 seconds, 6 per hour per person, 30 per hour per
   workspace and 60 per hour per instance, so a stolen session cannot be used to flood a mailbox or the mail account.
9. **Both are additional step-up factors** next to passkey, password and recovery codes, with the same grant, the same
   binding to action and target and the same lockout (5 failures, then 30 seconds doubling up to 15 minutes, across all
   factors). They count as "enrolled". A passkey-only window (desktop shell without WebAuthn) now has a way out.
10. **An optional second step at sign-in, on servers with accounts.** The policy `security.twoFactor` per workspace is
    `off` (the default: nothing changes on upgrade), `optional` (people who set a factor up must use it), `admins` (owners
    and admins must have one) or `all`. A person's requirement is the strictest of their workspaces. After the password,
    the server answers `{ twoFactorRequired, enrollmentRequired, challenge, methods }` and **no session**. The `challenge`
    (`lgc_` plus 32 random bytes, stored as SHA-256) lasts 5 minutes and 5 wrong codes, and is the only credential for the
    second step. Recovery codes ([ADR 0019](0019-step-up-confirmation.md)) are the fallback when the phone is gone.
    **Enrolling at sign-in is offered only to an account that has no second factor yet.** An account that has one is
    always asked for it, and a stolen password cannot add a second factor of its own to it (`verify` and `enroll` are
    different challenge kinds). The password step still counts against the login limiter, and a correct password does not
    reset it before the second step succeeds.
11. **Single-user mode** has no login and therefore no login second factor. TOTP and email are step-up factors only.
12. **API tokens are closed to all of it.** Every route here is `token: false`: a token cannot enroll, remove, read the
    status of, or use a second factor, cannot change the mail server and cannot send a test message.
13. **An admin can reset** another member's second factor (`members.manage`, with a step-up confirmation), for a lost phone
    with no recovery codes. It is audited (`two_factor.reset`) and the person is asked to set one up again if the policy
    requires it.

### What is logged

Audit rows hold ids and fixed words, never a code, a secret, a challenge, an address or a mail server's text:
`two_factor.totp_enrolled`, `two_factor.totp_removed`, `two_factor.email_code_sent`, `two_factor.email_verified`,
`two_factor.email_removed`, `two_factor.policy_changed`, `two_factor.reset`, `two_factor.enrolled_at_login`,
`auth.second_factor_verified`, `auth.second_factor_failed` (`method`, `reason`), `mail.settings_changed`,
`mail.settings_cleared`, `mail.test_sent`. Events: `stepup.verified` and `stepup.failed` now also carry `totp` and `email`
as the factor, and `auth.second_factor_failed` is new ([events](../api/events.md)). Event types keep no underscore in the
first segment.

## Alternatives considered

- **Depend on `nodemailer`.** Not installed, and the sandbox cannot add it. A client of about 600 lines on the standard
  library, covering exactly what is needed (two connection modes, two login methods, text and html), is easier to audit than
  a general library. If a provider needs OAuth2 or an API (SES, SendGrid HTTP), that is a different `Mailer` behind the
  same `sendMail`; nothing else changes.
- **Accept self-signed certificates with a switch.** It makes a man-in-the-middle of the mail password a setting. A relay
  with a private CA can be reached by adding the CA to the container's trust store (`NODE_EXTRA_CA_CERTS`).
- **SMS codes.** They need a paid provider and are weaker than the other two.
- **WebAuthn as a login factor.** Passkeys are already supported for step-up; using them for login is a larger change
  (discoverable credentials, per-user origin rules) and is left for later.
- **Only email on a server with accounts, using the account email as given.** An unverified address can be a typo or an
  address someone else controls. The address is proved with a code before it counts.
- **Let the mail host be any address.** A host that is a private address turns the settings screen into a port scanner
  for the network behind the server. Opt-in by the operator keeps the home-lab case working.

## Consequences

- Nothing changes for an existing server until an admin turns something on: the policy defaults to `off`, and mail is not
  configured.
- Email codes are only as safe as the mailbox. They are the weakest of the step-up factors; a workspace that cares about
  that can leave email unconfigured (no mail server, no email factor).
- A server without a mail server cannot offer email codes. The screens say so and still offer the authenticator app.
- Raising the policy to `admins` or `all` makes the next sign-in of every affected member go through setup. An admin who has
  no way to receive a code, and no recovery codes, can be locked out of the web. Recovery is the operator's: reset a
  member's factor from another admin, or (single owner) remove the rows `user_totp` and `user_mail` for that user from the
  database, then sign in again. The screen shows how many members have no second factor before the policy is raised.
- Clock drift of more than 30 seconds breaks TOTP. A phone with automatic time is fine; the setup text says so.
- Mail is one more outbound connection from the server. The private-address policy, the pinned address and TLS
  verification are the controls; a network that blocks the mail port shows as `smtp_connection_failed`.

## Unverified

See [api/two-factor](../api/two-factor.md#unverified) and [api/mail](../api/mail.md#unverified): no real mail server, no real
authenticator app, no browser run of the screens.
