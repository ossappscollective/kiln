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

## Codes (53 sent by the server and connectors, 36 implicit `api.*`)

| Area | Codes |
| --- | --- |
| `api.*` (36) | the legacy `error` word of a response: accountExists, alreadyInvited, alreadyMember, appGone, appNotFound, appRelinked, appRepositoryMismatch, applyInProgress, badOrigin, baseChanged, baseChangedFiles, branchMoved, changedMeanwhile, ciUnsupported, credentialKind, credentialNotFound, disabledInSingleUserMode, emailMismatch, fixupInProgress, forbidden, invalidCredentials, invalidRequest, invalidState, noBaseBuild, noBranch, noChanges, notFound, nothingToApply, openChangeSets, payloadTooLarge, registrationClosed, runWithoutCommit, timeout, tooManyAttempts, unauthenticated, unknownPath |
| `store.*` (31) | rateLimited, requestTimedOut, unreachable, connectionCutOff, fileTooLarge, `apple.clockSkew{Ahead,Behind}`, and 24 `google.*` (sign-in, access, API disabled, app not found, clock skew, key problems, edit id) |
| `github.*` (10) | branchExists, branchMissing, branchMoved, changeConflict(More), defaultBranch, pullRequestFailed, rateLimitPrimary, rateLimitSecondary, timeout |
| `sync.*` (5) | failed, inProgress, reviewsFailed, timeout, tooManySyncs |
| `tokens.*` (3), `events`, `members`, `repositories`, `webhooks` | roleAboveYours, tooMany, unknownApp; events.tooManyStreams; members.lastOwner; repositories.cloneBusy; webhooks.tooMany |

`http.*` (4) are web-only codes for a failed request that never reached the server.

## Left in English

- About 300 one-off `message: '...'` literals in routes and services keep only their English text; the ones that share a legacy `error` word with a
  catalog entry are translated through `api.<error>`, the others show the English `message`. They are converted by adding a `coded()` and a catalog entry.
- Alert and digest emails, and every background email (no recipient language).
- MCP tool output (it is for a model; English by decision).
- Audit log action names and webhook payloads (data for machines).
- A user language preference: not built (no locale field); it is the prerequisite for translating background emails.
