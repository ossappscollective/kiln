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
