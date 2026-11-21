# Mail (SMTP)

The mail server this instance sends email through. Emailed confirmation codes and sign-in codes ([two-factor](two-factor.md)) and
alert emails use it. Design and reasons: [ADR 0021](../adr/0021-two-factor-and-smtp.md).

Without a mail server nothing breaks: every feature that needs mail says "No mail server is set up" and the rest works.

## Setting it up

**Environment** (the operator's choice; the screen then shows the settings read only):

| Variable                             | Meaning                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `KILN_SMTP_HOST`                      | Host name or IP address, without `smtp://` or a port. Setting it turns the environment on.                     |
| `KILN_SMTP_PORT`                      | 1 to 65535. Default 587 for `starttls`, 465 for `tls`, 25 for `none`.                                          |
| `KILN_SMTP_SECURE`                    | `starttls` (default), `tls` (TLS from the first byte) or `none`.                                               |
| `KILN_SMTP_USER`, `KILN_SMTP_PASSWORD` | Optional login (AUTH PLAIN or LOGIN). The password is only ever sent over TLS, or to a server on this machine. |
| `KILN_SMTP_FROM`                      | Required with the host. `kiln@example.com` or `Kiln <kiln@example.com>`.                              |
| `KILN_SMTP_ALLOW_PRIVATE_HOSTS`       | `true` to allow a mail host on a private, loopback or link-local address. Default `false`.                     |

A wrong value stops the server at start with one plain sentence naming the variable.

**Settings, Mail** (owners and admins): host, security, port, user, password, sender. Saved encrypted with the master key, like
credentials. The password is never shown or returned again. Leave it empty to keep the saved one; changing the host, the port or
the user name needs it typed again. When the environment sets `KILN_SMTP_HOST`, the screen is read only.

A mail host on your own network (a relay in a home lab, a container next to this one) is a private address. It is refused
until the person who runs the server sets `KILN_SMTP_ALLOW_PRIVATE_HOSTS=true` and restarts it: it cannot be turned on from the
screen, because the screen is the thing it protects.

Common settings: Gmail or Google Workspace `smtp.gmail.com`, `starttls`, 587, an app password; Microsoft 365
`smtp.office365.com`, `starttls`, 587 (SMTP AUTH must be on for the mailbox); Amazon SES, Mailgun, Postmark and others: the
SMTP host and credentials they give you, `starttls` 587 or `tls` 465. None of these was tried.

## Routes

Under `/api/workspaces/:workspaceId`. The setting is for the whole server, not the workspace. **API tokens are refused**
(`token: false`).

| Route                   | Role                    | What it does                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /mail/settings`    | settings.write          | `{ source: env \| settings \| none, configured, locked, host, port, secure, user, from, passwordSet, allowPrivateHosts }`. Never the password.                                                                                                                 |
| `PUT /mail/settings`    | settings.write, step-up | `{ host, port?, secure, user?, password?, from }`. `409 smtp_locked` when the environment decides; `400 password_required` when host, port or user changed and no password was sent; `400 address_not_allowed` with a `hint` (`private_address_blocked`, ...). |
| `DELETE /mail/settings` | settings.write, step-up | Removes the saved setting. `409 smtp_locked` under the environment.                                                                                                                                                                                            |
| `POST /mail/test`       | settings.write          | Sends one message to **your own account email** (single-user mode: to the `{ to }` you type). `200 { ok: true, to }` or `200 { ok: false, code, hint?, message }`. 5 per 10 minutes per person. It cannot be used to mail anyone else.                         |

## The mailer for other code

`apps/server/src/services/mailer.ts`:

```ts
sendMail({ to: string | string[], subject: string, text: string, html?: string })
  : Promise<{ ok: true } | { ok: false, code: MailErrorCode, hint?: MailHint }>
```

It never throws. `code` is one of `smtp_not_configured`, `smtp_connection_failed`, `smtp_auth_failed`, `smtp_tls_failed`,
`smtp_rejected`, `smtp_timeout`. Show the sentence for the code (`MAIL_ERROR_MESSAGES`), never the server's text. In tests,
`setMailer(createFakeMailer())` records what would have been sent (`sent`, `last()`, `lastCode()`) and can be told to fail
(`failWith`).

Limits: 20 recipients, subject 300 characters, 200,000 characters of body, 1 MiB per message; 15 seconds per step and 60 in
total. Addresses and header values with line breaks or NUL are refused (`invalid_address`), so user text can never add a header.
Non-ASCII subjects and names are encoded (RFC 2047) and bodies are quoted-printable.

## Failures

| Code                     | Meaning                                                     | Usual cause                                                                                   |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `smtp_not_configured`    | no mail server                                              | nothing set up                                                                                |
| `smtp_connection_failed` | could not connect, or the host is not allowed               | wrong host or port, firewall, `private_address_blocked`, `host_not_found`                     |
| `smtp_auth_failed`       | user name or password refused                               | wrong password; app password needed; `no_auth_mechanism`                                      |
| `smtp_tls_failed`        | TLS could not be made                                       | `certificate_rejected`, `starttls_not_offered`; wrong security for the port (STARTTLS on 465) |
| `smtp_rejected`          | the server refused the sender or a recipient or the message | sender not allowed to use that address; mailbox unknown                                       |
| `smtp_timeout`           | no answer in time                                           | blocked port, slow server                                                                     |

## Security notes

- Certificates are always verified. A relay with a private CA: add the CA to the container (`NODE_EXTRA_CA_CERTS`).
- STARTTLS is never downgraded: a server that does not offer it is an error, not a plain text session.
- The address checked is the address connected to, so a host name cannot change its answer between the check and the
  connection.
- Audit: `mail.settings_changed` (host, port, mode, whether a login is set, whether the password changed),
  `mail.settings_cleared`, `mail.test_sent` (ok or the code). No password, user name or address.

## Unverified

- **No real mail server.** Tested against an in-process fake SMTP server (plain, STARTTLS and implicit TLS with a throwaway
  certificate, PLAIN and LOGIN, error replies, a stalled server). Gmail, Microsoft 365, SES and the others were not tried:
  quirks such as unusual greetings, `SMTPUTF8`, pipelining or per-provider limits are untested.
- Internationalized (non-ASCII) addresses are refused, not sent with `SMTPUTF8`.
- Only text and html messages, no attachments.
- No browser run of the Mail card: only type checks and the tests of the pure logic.
