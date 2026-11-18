# Security

This tool holds credentials that can publish apps to the App Store and Google Play. Treat
reports accordingly.

Please report vulnerabilities privately to the maintainers (add a contact address before the
first release) and do not open a public issue. Include steps to reproduce and the version.

Design rules that matter for reviews:

- Secrets are encrypted with AES-256-GCM before storage and are never logged.
- Every write is recorded in the audit log with its actor.
- Store credentials should have the least privilege the store allows.
