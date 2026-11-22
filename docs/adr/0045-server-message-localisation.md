# ADR 0045: Localising the sentences the server produces

Status: built for API errors, persisted failure notes and the two interactive emails. Alert emails, the digest and most one-off error
sentences are still English (see the inventory in [docs/i18n-server.md](../i18n-server.md)). Builds on [ADR 0044](0044-localisation.md).

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
7. **No user locale field.** It would need a migration, a picker and a rule for team members who differ. Until it exists a background email
   cannot know the reader's language, so it stays English. Follow-up, not built.
8. **MCP output stays English.** It is read by a model that handles English best, and tool results are data, not UI.
9. **Everything is checked by tests, not by convention**: `errors-catalog.test.ts` fails when a code written in the server or the connectors has
   no English message in `errors/en.json`, when a code is malformed or when the email catalogs differ in keys or placeholders between languages;
   `scripts/i18n.mjs` checks placeholders, tags and plural forms of the `errors`, `email` and desktop catalogs.

## Consequences

- A new sentence the person reads gets a code and an English entry in `apps/web/locales/errors/en.json`; translators do the rest in Weblate.
- A code is part of the API: renaming one changes what people see (old clients fall back to English). Change the key when the meaning changes.
- The OpenAPI error schema documents `code` and `params`; the app schema documents `lastSyncErrorCode` and `lastSyncErrorParams`.
- Alert text is still built in code with English fragments; making it translatable means keys per alert kind and a recipient language, which
  needs decision 7 first.
