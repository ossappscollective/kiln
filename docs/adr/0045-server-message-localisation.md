# ADR 0045: Localising the sentences the server produces

Status: built for API errors (including the one-off sentences a person reads from the UI), persisted failure notes and the two interactive
emails, and, since the amendment of 2026-11-22, a per-user language with the alert and digest emails. Validation field hints and operator hints are still English (see the inventory in [docs/i18n-server.md](../i18n-server.md)). Builds on [ADR 0044](0044-localisation.md).

## Context

The web app is translated, but people also read sentences the server wrote: the `message` of an error response, the failure note kept on an
app row (`last_sync_error`), emails (sign-in codes, the SMTP test, alerts). The server has no idea which language a person reads: there is
no user locale field, a background job (an alert, a sync) runs with no request, and API and MCP clients depend on the English `message` and on
rows written before this change.

## Decision

1. **A stable machine `code` plus `params` next to the English `message`.** An error body is `{ error, message, code?, params? }`. `code` is
   dot.case (`store.google.noAccess`), `params` are plain scalars the sentence needs (a store name, a branch, a count), never a secret
   (`apps/server/src/i18n/problem.ts` drops secret-looking names, objects and long text). The English `message` stays, always: an API or MCP
   client, an old web build or an unknown code shows it. `coded('code', params)` is the one way to write the pair and checks the shape.
2. **The web app translates.** `lib/error-text.ts` looks up `errors:<code>` in `apps/web/locales/errors/{en,fr,es,de}.json` (the app's own
   catalogs, so Weblate handles them like any namespace) and falls back to the server's `message`. A response with no `code` has an implicit one,
   the legacy `error` word in camel case (`not_found` is `api.notFound`); the web has messages for the ones people meet. A code is a message
   key: plurals follow the web rules (`count`), a wait is passed as `wait` text built by the web.
3. **Connector errors carry the pair too.** `StoreError` and `GithubError` take an optional coding; a route returns it only when the text it sends
   is exactly the error's own sentence (`messageCoding`), so a caller that rewrites or extends the message gets no code and the English shows.
4. **Persisted notes store code and params, not text in a language.** Migration 50 adds `apps.last_sync_error_code` and
   `apps.last_sync_error_params` (JSON object of scalars). `last_sync_error` keeps the English sentence. Rows written before are not rewritten:
   both new columns are NULL and the web shows the English text. Both schema files and a migration test carry it.
5. **Emails use server-side catalogs**, `apps/server/locales/<namespace>/<language>.json`, same format and rules as the web (flat keys,
   `{{name}}`, `_one`/`_other`), namespace `email`, read with plain `fs` by a small runtime (`apps/server/src/i18n/`) that is a pinned copy of
   the web's (`runtime.test.ts` compares plural choice, interpolation and rich-text parsing). It is a copy, not an import, because the
   desktop build stages `apps/server` and `packages/*` but not `apps/web/src`. `scripts/i18n.mjs` checks these catalogs like the web's.
6. **Recipient language.** An interactive email (a sign-in code, a step-up code, an address verification, the SMTP test) uses the requester's
   `Accept-Language` (`negotiateLocale`, q-values, regions, English when nothing matches). A background email (alerts, the digest) uses English.
7. **No user locale field.** Superseded by the amendment below.
8. **MCP output stays English.** It is read by a model that handles English best, and tool results are data, not UI.
9. **Everything is checked by tests, not by convention**: `errors-catalog.test.ts` fails when a code written in the server or the connectors has
   no English message in `errors/en.json`, when a code is malformed or when the email catalogs differ in keys or placeholders between languages;
   `scripts/i18n.mjs` checks placeholders, tags and plural forms of the `errors`, `email` and desktop catalogs.

## Consequences

- A new sentence the person reads gets a code and an English entry in `apps/web/locales/errors/en.json`; translators do the rest in Weblate.
- A code is part of the API: renaming one changes what people see (old clients fall back to English). Change the key when the meaning changes.
- The OpenAPI error schema documents `code` and `params`; the app schema documents `lastSyncErrorCode` and `lastSyncErrorParams`.
- Alert text used to be built in code with English fragments; see the amendment.

## Amendment 2026-11-22: a user language preference

Decision 7 is replaced, and decision 6 extended to background emails.

1. **`users.locale`**, nullable text (migration 51, both schema files and a migration test): one of the languages the server has catalogs
   for (`en`, `fr`, `es`, `de`). NULL means no choice. Nothing is backfilled. A stored value the server does not know reads as English.
2. **The person sets it** with `PATCH /api/me` `{ "locale": "fr" | null }` (session only, documented in the registry and in
   [docs/api/profile.md](../api/profile.md)); a region is accepted and dropped (`fr-CA` is `fr`), anything else is `400 invalid_request`.
   `GET /api/me` and the sign-in answer carry `user.locale`. No MCP tool.
3. **Order for an email with no request**: the recipient's `locale`, then the workspace default (none exists, none is added), then English.
   Emails that answer a request still use `Accept-Language`.
4. **Alert and digest emails are translated** from catalogs (`alerts`, `digest`); the alert row keeps its English `title`/`body` (stored, shown
   by API clients and in the English email). For another language the email rebuilds the sentences from the alert type and its data. The
   inbox does the same for a person who has a language. Webhook payloads, audit action names and MCP output stay as they were.
5. **The web app** saves the choice after a signed-in person picks a language and adopts the account language at sign-in when the browser has
   no choice. The browser's own choice (`kiln.locale`) still decides what the screen shows; the account value only serves the server.
6. **Different people, different languages**: each recipient gets their own rendering, so a team can mix languages; the alert is raised once.
