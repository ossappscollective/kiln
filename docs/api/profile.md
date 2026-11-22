# Profile: the signed-in person

Routes under `/api/me` for the person who is signed in. **Session cookie only**: an API token has no identity of its own here
([tokens](tokens.md)), and there is no MCP tool for them.

| Route           | Body                         | Answer                                                                      |
| --------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `GET /api/me`   |                              | `200 { user, workspaces }`. `user` is `{ id, email, displayName, locale }`. |
| `PATCH /api/me` | `{ locale: string \| null }` | `200 { user }` with the stored `locale`. `400 invalid_request`; `401`.      |

## `locale`

The language the person reads, used by the emails the server sends **without a request** to read a language from: alert emails and the
alert digest ([alerts](alerts.md)). One of `en`, `fr`, `es`, `de`, or `null` (no choice: English).

- `PATCH` accepts a BCP-47 tag of a supported language, case and `_` forgiven; a region is dropped (`fr-CA` and `FR_ca` are `fr`). Any other
  value (`pt`, `""`, a number, a missing field) is `400 invalid_request` and changes nothing. `null` clears the choice.
- Emails that answer a request (sign-in code, step-up code, address verification, SMTP test) use that request's `Accept-Language` instead.
- The alert inbox (`GET /api/workspaces/{id}/alerts/inbox`) returns `title` and `body` in this language when it is set, and the stored English
  text otherwise.
- The web app sends it after a signed-in person picks a language, and applies it at sign-in when the browser has no choice of its own.
- Decision record: [ADR 0045](../adr/0045-server-message-localisation.md), amendment of 2026-11-22. How it is used:
  [i18n-server.md](../i18n-server.md).

```sh
curl -X PATCH -H "Cookie: kiln_session=..." -H "Content-Type: application/json" -d '{"locale":"fr"}' https://kiln.example.com/api/me
```
