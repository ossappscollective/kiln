# ADR 0040: The product is called Kiln

Status: built. Tested with unit and server tests; the Rust changes in the desktop shell and the compose
substitutions were not compiled or run here.

## Amendment, 2026-11-21: the fallbacks were removed

Decisions 2 to 7 and 9 below describe compatibility fallbacks (`MRM_*` variables, the `mrm_session`
cookie, `mrm_` tokens, `.mrm-data` and `mrm.db`, `mrm-clone.json` and `refs/mrm/*`, `mrm:sha256:`
image names, `mrm.*` browser keys, the desktop shell's `MRM_` variables and earlier app-data folder).
They were removed again because there turned out to be no old installs to support. Only the Kiln
names are read and written now, and the code, tests and the deployment upgrade notes for those
fallbacks are gone. The webhook headers (8), the names renamed without a fallback (10) and the labels
kept on purpose (11) are unchanged; the compose substitutions of `MRM_MASTER_KEY` and `MRM_BIND`
are gone as well. The text below is the record of the original decision.

## Context

The project began under the working title MRM (Mobile Release Manager). The name was only a placeholder
and was spread over package names, environment variables, cookie and token prefixes, folder names, wire
headers and browser storage keys. The product is now **Kiln**. The display name, the MCP server name,
the user agents and the desktop identifier changed first; this ADR covers everything else and records
which old names keep working. The product was not released, but a few people run it on real data (one
SQLite folder, a desktop app, a hosted compose setup), so an upgrade must not log them out, lose data
or stop scripts that already hold a token.

## Decision

The rule of thumb: **new names are written, old names are still read, nothing is migrated in place,
and stored or derived data keeps its old label**.

1. **Package scope** `@mrm/*` is `@kiln/*` (workspace packages, imports, lockfile names, docs).
2. **Environment** `MRM_*` is `KILN_*`. `applyLegacyEnv` (`apps/server/src/legacy-env.ts`) copies
   `MRM_X` to `KILN_X` when only the old one is set. It never overwrites, never logs a value, and warns
   once with the names. It runs at server start (before `loadConfig` and the demo check), in the MCP
   stdio bridge and in the demo entry. The desktop shell reads `KILN_NODE` and
   `KILN_USE_PACKAGED_SERVER` with an `MRM_` fallback and removes both spellings of
   `TRUSTED_ORIGINS` from the server's environment. Compose reads `MRM_MASTER_KEY` and `MRM_BIND` in
   its substitutions.
3. **Session cookie** `kiln_session` is written. `mrm_session` is accepted when the new cookie is absent
   (`sessionToken` in `http.ts`, used by login checks, the bearer gate, invitations and step-up). A new
   sign-in drops an old cookie the request carried, and sign-out ends and clears both. The same-origin
   guard treats either cookie as "a browser is involved".
4. **API tokens** are created as `kiln_<43 chars>`. Validation accepts `kiln_` and `mrm_`; lookup is by the
   SHA-256 of the whole presented string, so stored rows are untouched. The MCP output redaction covers
   both prefixes.
5. **Local data** defaults to `./.kiln-data`, `kiln.db` and `./.kiln-demo`. When the old folder or file
   exists and the new one does not, the old one is used (`legacy-data.ts`; the demo folder and its
   marker, the SQLite URL rule for `kiln.db`, the desktop shell for its data folder and `mrm.db`). Nothing
   is moved, copied or deleted. A configured `KILN_DATA_DIR` or `DATABASE_URL` is used as written.
   `.gitignore` lists both names.
6. **Clone markers and refs**: `kiln-clone.json` and `refs/kiln/*` are written; `mrm-clone.json` and
   `refs/mrm/*` are still read, listed, touched, removed and compacted.
7. **Store image names**: the App Store asset library reference is written as `kiln:sha256:<hex>`; images
   already uploaded as `mrm:sha256:<hex>` are recognised as the same file and are not uploaded again.
8. **Webhook headers** are `X-Kiln-Event`, `-Delivery`, `-Timestamp` and `-Signature`. This is a
   deliberate break with no fallback (a receiver reads the headers by name, and sending both would
   double the surface). The signature is unchanged: HMAC-SHA256 over `<timestamp>.<raw body>`; the signed
   string never contained a header or product name.
9. **Browser storage** keys are `kiln.*`; `readMigrated` (`apps/web/src/lib/legacy-storage.ts`) copies a
   value from the old `mrm.*` key when the new key is absent. The old key is left in place; choosing
   "auto" for the theme removes both so the old value does not return.
10. **Renamed without a fallback**: the OpenAPI extensions `x-kiln-*`, the MCP resource scheme `kiln://`,
    the default change-set branch prefix `kiln/`, the Expo GraphQL operation names, temporary folder
    prefixes, the desktop sidecar `kiln-node` and the Cargo package.
11. **Kept on purpose** (changing them would break stored or derived data): the single-user address
    `local-user@mrm.invalid` (the user is found by it), the HMAC and hash labels `mrm-recovery-v1`,
    `mrm-step-up:`, `mrm-mail-code-v1` and `mrm-builds-link-v1`, the demo master key label, the compose
    Postgres user, database and volume names (`mrm`), and the desktop's earlier identifier folder
    `dev.example.mobilereleasemanager`, which is searched for when the new app folder does not exist.

## Consequences

- An upgrade needs no change by the operator; the server logs which `MRM_` names it read. Renaming them
  at leisure removes the warning.
- The legacy readers are small and tested; they can be deleted together once nobody runs a pre-rename
  installation (search for `mrm`, `MRM_` and `legacy`).
- Webhook receivers, OpenAPI consumers that read `x-mrm-*`, MCP clients that use `mrm://` addresses and
  scripts that look for the `mrm_session` cookie by name must be updated.
- Postgres and compose volume names still say `mrm`. A later migration (dump and restore into a new
  database) is the operator's decision.
- Repository folders on disk keep their old name; this ADR does not rename them.
