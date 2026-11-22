# Localisation of server messages

How the sentences the server produces reach people in their language. The decision is [ADR 0045](adr/0045-server-message-localisation.md);
the web side is [i18n.md](i18n.md); translators read [translating.md](translating.md).

## Error responses

```json
{ "error": "rate_limited", "message": "Google Play rate limit reached. Retry in 30 seconds.", "code": "store.rateLimited", "params": { "store": "Google Play", "count": 30 } }
```

- `message` is English and always present. `code` and `params` are optional: an error without them is shown in English.
- A code is dot.case: `<area>.<name>` (`tokens.tooMany`, `store.google.noAccess`). Params are scalars, never a secret, text cut at 300 characters.
- In server code: `failure(409, 'sync_in_progress', 'A sync of this app is already running.', coded('sync.inProgress'))` or
  `{ ...coded('tokens.tooMany', { count: 30 }) }` in a body. Connector errors take a coding in their constructor; a route forwards it with
  `messageCoding(error, sentMessage)` (only when the text sent is the error's own).
- The web finds the sentence in `apps/web/locales/errors/<language>.json` under the code. With no `code` the key is the `error` word in camel case
  (`not_found` is `api.notFound`). Unknown code: the English `message` is shown.
- To add one: write `coded('area.name', { ... })` (or `code:` in a connector error), add `area.name` (with `_one`/`_other` when `count` is a param) to
  `errors/en.json`, then `pnpm i18n:fix`. `apps/server/src/i18n/errors-catalog.test.ts` fails until the English entry exists. Add fr/es/de only
  if you are fluent and follow the glossary; otherwise Weblate does it.

## Stored notes

`apps.last_sync_error` (English) plus `apps.last_sync_error_code` and `apps.last_sync_error_params` (JSON, migration 50). The API returns
`lastSyncError`, `lastSyncErrorCode`, `lastSyncErrorParams`; the web shows `noteText()` (code and params in the person's language, else the English
text). Old rows have no code and keep working.

## Emails

Catalogs: `apps/server/locales/email/{en,fr,es,de}.json`. Code: `apps/server/src/i18n/` (`translator(locale)`, `negotiateLocale`). Language: the
requester's `Accept-Language` for interactive emails (sign-in code, step-up code, address verification, SMTP test), English for background ones.

| Email | Where | Language |
| --- | --- | --- |
| Code for sign-in, step-up and address verification | `services/two-factor.ts` `codeMessage` | requester |
| SMTP test message | `routes/mail.ts` | requester |
| Alert emails and the digest | `modules/alerts/email.ts` | English, not converted |

## Codes (about 460 sent by the server and connectors, 36 implicit `api.*`)

The old table of every code is gone: the catalog is the list (`apps/web/locales/errors/en.json`), and
`apps/server/src/i18n/errors-catalog.test.ts` fails when a code written in the server has no message, when a language lacks it or has other
`{{placeholders}}`, and when a `coded()` call does not pass a param its English message needs. Areas (dot.case prefix):

| Area | What it holds |
| ---- | ------------- |
| `api.*` (36) | the legacy `error` word of a response, translated without a code on the wire (see above) |
| `store.*`, `github.*`, `sync.*`, `tokens.*`, `events`, `members`, `repositories`, `webhooks` | connector and first-wave codes (ADR 0045) |
| `rate.*` (16) | "Too many X. Try again in N seconds" with `count` (the web picks seconds or minutes plurals): token, requests, ci, ai, translation, tests, analytics, lookups, downloads, repositoryReads, storeReads, expo, reads, uploads, images, checks |
| `notFound.*` (10) | a thing that does not exist: app, review, suggestion, repository, product, listingTarget, aiTask, replyDraft, replyTemplate, checklistTemplate |
| `credential.*` (9) | gone, undecryptable, wrongKind, not in the workspace and the kind a connector needs (Expo, RevenueCat, service account) |
| `confirm.*` (4) | the typed confirmation does not match (`phrase`), one per outcome: uploaded, published, released, submitted |
| `publish.*` (46) | the store write steps (draft push, release, submit, rollout, version, publish): `inProgress.<step>`, `unknown.<step>` (outcome not known), `blocked.<step>`, `changedSince<Step>`, "store did not answer" variants |
| `staged.*` (34), `listing.*` (22), `changeSet.*` (31), `repository.*` (6), `local.*` (9) | staged changes and graphics, listing pull and compare, change sets and fix-ups, repository connection, local clones |
| `ai.*`, `alerts.*`, `analytics.*`, `aso.*`, `builds.*`, `ci.*`, `eas.*`, `monetization.*`, `plan.*`, `playCheck.*`, `revenuecat.*`, `reviews.*`, `translation.*`, `app.*` | one area per module |
| `auth.*`, `twoFactor.*`, `stepUp.*`, `mail.*`, `invitations.*` | sign-in, second factor, confirmation, mail settings |

Params are what the person already sees or typed (a name, a limit, a branch, a phrase they typed). A `count` param is a number with `_one` and
`_other` messages; a wait is a `count` of seconds (the server sends `count`; the web also passes a `wait` it formats from `Retry-After`, used by
the messages that name `{{wait}}`, such as `api.tooManyAttempts`).

`http.*` (4) are web-only codes for a failed request that never reached the server.

## Inventory: converted and intentionally English

Converted (a `coded()` next to the English `message`, about 550 call sites): every top-level error body of a route or service that a person can
reach from the UI with a fixed sentence, found by an AST scan of `message:` literals and the `failure`, `fail`, `aiFail`, `invalid` and `bad`
helpers (`failure(status, error, message, extra)` takes the coding as `extra`; `invalid(code, message, extra)` too). Sentences that only differ
by a noun share a code where the meaning is the same (credential gone, store did not answer, in progress per step).

Intentionally English, with the reason:

| Kept in English | Why |
| --------------- | --- |
| Field hints of a validation failure (`issues: [{ path, message }]`: "A whole number from 1 to 100.", "A language tag such as en-US.", "Use ios, macos or android.") | read by API clients and MCP, which send valid values from the web app; the web shows its own field messages. They would need a code per issue and a changed shape of `issues`. |
| Operator switches and environment hints ("... is switched off on this server. Set KILN_X=true", `KILN_SMTP_HOST`) | for the person who runs the server, not for members; they name environment variables. |
| Sentences with a variable noun or a conditional plural built in code ("One file / N files changed ...", `file${max === 1 ? '' : 's'}`, a store's own error text, a status word) | a translated sentence cannot be assembled from fragments; they need a rewrite into counted messages first. |
| Local clone path diagnostics (`services/local-git.ts`, `local-reads.ts`), passkey ceremony failures (`services/webauthn.ts`), outbound fetch reasons (`safe-fetch.ts`, `webhook-transport.ts`, `translate-net.ts`) | developer diagnostics: they carry a `reason` code the UI already maps, or a text a person cannot act on. |
| AI task input checks ("Name the fields as a list of text.") and translation API limits ("At most N texts per call.") | the web app never sends them; they are the contract of the API. |
| `The request body is too large.` and the other fixed `error` words | already translated through `api.<error>`. |
| MCP tool output, audit action names and webhook payloads, demo data, OpenAPI text | machine readers; English by decision. |
| The alert settings screen's own labels (`label`, `description`, group names in `GET /alerts/catalog`) | English from the server; the web app has its own words for the screen. |
| Persisted `last_error` columns other than `apps.last_sync_error_code` | no code column exists and no migration was added; the English sentence is stored and shown. |

A new fixed sentence a person reads gets a `coded()` and an English entry; add fr, es and de with the glossary (the catalog test fails without
them).

## Not built

- A workspace default language (the order for a background email is the recipient's `locale`, then English; a workspace default would sit between them).
