# Security

This tool holds credentials that can publish apps to the App Store and Google Play. Treat
reports accordingly.

Please report vulnerabilities privately to the maintainers (add a contact address before the
first release) and do not open a public issue. Include steps to reproduce and the version.

Design rules that matter for reviews:

- Secrets are encrypted with AES-256-GCM before storage and are never logged.
- Every write is recorded in the audit log with its actor.
- Store credentials should have the least privilege the store allows.
- Hard actions (publish, submit, release, rollout, delete a credential) can require a fresh passkey or password
  confirmation ([docs/api/step-up.md](docs/api/step-up.md)). It is off by default; turn it on in Settings, Security.
- Sharing a build to Google Play internal app sharing ([docs/api/internal-sharing.md](docs/api/internal-sharing.md)) is a store write that is off by
  default, owners and admins only, behind a preview, a typed phrase and the step-up class `internal_sharing`. The install link Google returns is a secret:
  stored encrypted, cleared after 24 hours, never logged, audited or sent in an event.
- Step-up recovery codes are shown once, stored only as salted hashes, spent by one use and rate limited like the confirmation password.
- Two-factor codes ([docs/api/two-factor.md](docs/api/two-factor.md), [ADR 0021](docs/adr/0021-two-factor-and-smtp.md)): an authenticator app (TOTP, RFC 6238)
  and emailed codes are extra step-up factors and, on a server with accounts, an optional second step at sign-in. TOTP secrets are encrypted at rest and a code
  works once; email codes are six digits, valid 10 minutes for 5 tries, stored only as a keyed hash, sent only to a verified address and rate limited per person,
  per workspace and per server. A stolen password cannot enroll a second factor on an account that has one. API tokens cannot use any of it.
- Outgoing mail ([docs/api/mail.md](docs/api/mail.md)): the SMTP password is stored encrypted and never returned, TLS certificates are always verified, a password
  is never sent without TLS (except to this machine), STARTTLS is never downgraded, a mail host on a private address needs the operator to set
  `KILN_SMTP_ALLOW_PRIVATE_HOSTS=true`, and the test message goes only to the person who asks for it. Changing the host, port or user name needs the password again.
  Nothing a mail server says is shown or logged.
