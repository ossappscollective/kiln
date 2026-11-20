# ADR 0033: Expo Application Services (EAS) integration

Status: started. The foundation exists (credential kind, client, link between an app and its EAS project). The features that build on
it follow one at a time (see "What follows").

## Context

A large share of mobile apps are Expo projects. The tool already reads an Expo repository (project detection, `store.config.json`
listings, the icon in `app.json`), but it knows nothing about EAS itself: where a project builds, which builds and submissions exist,
which updates (OTA) are published. EAS has a public GraphQL API (`https://api.expo.dev/graphql`) that `eas-cli` uses, and access
tokens for robot users. Several features need the same four things first: a credential for Expo, a client for its API, the link
between an app and its EAS project, and a place in the server where each feature adds itself. This ADR is those four.

## Decision

1. **A credential kind `expo`.** The secret is an Expo access token, stored as one string like a GitHub token, encrypted and bound
   to its workspace like every credential (`packages/core/src/credentials.ts`). The guide (`credential-guides.ts`, `docs/credentials.md`)
   says to create a **robot user with the Developer role** under the account's Access tokens (https://expo.dev/settings/access-tokens
   for a personal token; `expo.dev/accounts/<account>/settings/access-tokens` for a robot) rather than a token of a person. The connection
   test asks Expo who the token belongs to (`meActor`, a read) and names the robot or person and the accounts it can see; it never
   returns or logs the token. Owners and admins save and test (`credentials.write`), as for every credential.
2. **A client in `packages/connectors/src/expo/`.** `createExpoClient({ token, fetch?, apiOrigin?, timeoutMs? })` posts GraphQL to
   `{apiOrigin}/graphql` with `Authorization: Bearer <token>` (default origin `https://api.expo.dev`). It throws only `ExpoError`, whose
   `kind` is the vocabulary the other connectors use (`auth`, `forbidden`, `not_found`, `rate_limited`, `server`, `network`,
   `unexpected`, `invalid_input`) with a fixed sentence per kind: Expo's own text is never copied into a message, and the token is
   redacted anyway. No redirect is followed, answers are capped at 2 MB, each request has a time limit, nothing is retried. The typed
   functions are `expoViewer`, `expoProjectByFullName` and `expoProjectById` (`queries.ts`, types in `types.ts`); `readExpoProjectFromAppJson`
   reads `expo.extra.eas.projectId`, `expo.owner` and `expo.slug` from the TEXT of `app.json` (code is never run).
3. **The link between an app and its EAS project.** Migration 44, table `app_expo_links`, one row per app record (an iOS and an Android
   record of one product each have a row and may name the same project): the Expo credential, the project id, and the account, slug
   and name Expo reported, with when Expo last confirmed them. No foreign keys to apps or credentials (like `apps.credential_id`):
   `deleteApp` removes the row, and a deleted credential leaves the link, which then says `credentialAvailable: false`. The routes
   (`docs/api/eas.md`) are `GET`, `PUT`, `DELETE /apps/:appId/expo` and `GET /apps/:appId/expo/detect`. **Rights reuse `apps.read` and
   `apps.write`** (no new action): linking is configuration of an app, the same people may do it as may add or delete one. `PUT` asks
   Expo with the chosen credential before saving and stores what Expo answered, not what was typed. Link changes are audited
   (`eas.link_set`, `eas.link_remove`) and every use of the token is a `credential.use` with its purpose.
4. **A module with parts.** `apps/server/src/modules/eas/` lists its mounts in `parts.ts` and its operations in `operations.ts`; each
   feature owns its files and adds one entry to each. Features reach Expo only through `expoClientFor(db, masterKey, workspaceId,
   credentialId, deps, { actor, purpose, now })` (`client.ts`, re-exported by `index.ts`): it checks that the credential is an Expo
   credential of this workspace, decrypts the token for that one client, audits `credential.use` with the caller's `purpose`, and
   returns `{ ok: true, client }` or a ready `Failure`. `expoFailure(error)` turns an `ExpoError` into the same response codes
   everywhere (`expo_auth`, `expo_forbidden`, `expo_not_found`, `invalid_project`, `rate_limited`, `timeout`, `expo_unavailable`).
   `EasDeps` (`fetch`, `apiOrigin`) are the seams tests and proxies replace.
5. **Prefilling the link.** `detectExpoProject` reads the `app.json` at the root of the app's repository (a clone when local reads
   are on, else the API) and returns the project id, owner and slug, so the form is one click. A dynamic `app.config.js` is never
   run: the answer says so and the person enters the project.
6. **Web.** An "Expo project" card in the app Settings (`components/eas/`, `lib/eas/`), drawn only when it can matter (a record is
   linked, the workspace has an Expo credential, or the repository is an Expo project).

## What follows (each its own change, using the seams above)

- **EAS Workflows as a CI provider.** Run and watch workflows of the linked project next to GitHub Actions; needs a write call to Expo
  and therefore its own right (`ci.dispatch` is the likely fit) and switch.
- **EAS Build and Submit status.** Builds and submissions of the linked project in "Builds to test" and the release pipeline.
- **EAS Update (OTA) view.** Channels, branches and updates of the linked project, read-only first. Done: [ADR 0037](0037-eas-update.md).
- **The `eas.json` reader** (`packages/connectors/src/expo/eas-config.ts`, being written separately): profiles, channels and submit
  settings, to tell which profile a build used.

## Checked against Expo's sources (2026-11-20) and not checked

Checked in the open source of eas-cli (`packages/eas-cli/src/graphql`, `commandUtils/context/contextUtils/createGraphqlClient.ts`) and
docs.expo.dev: the endpoint (`<api base>/graphql`) and the bearer header; `meActor` with `__typename`, `id`, `displayName`,
`accounts { id name }` and `... on UserActor { username }`; `app { byId(appId: String!) }` and `app { byFullName(fullName: String!) }`
with `id name fullName slug ownerAccount { id name }`; that a robot has a role (Developer by default for the GitHub App robot), cannot
sign in or own projects, and authenticates with an access token only; that Developer "can create new projects, make new builds,
release updates, and manage credentials".

**Not checked, so not used or hedged:** what `meActor` answers for a token Expo does not know (the client treats `null` and an
authentication error alike); Expo's GraphQL error codes (errors are classified by wording and `extensions.errorCode`, which is
unverified and falls back to `unexpected`); whether a token expires (Expo's page describes creating and revoking tokens and says
nothing of expiry, so the guide does not claim either); which role is the least that can read a project; whether an organization
robot can be created on a personal account; the rate limits of the API; every field of builds, submissions, updates and workflows
(the features above verify theirs before adding a query). `githubRepository` of an app is in eas-cli's own fragment but is not selected
here: the link needs it nowhere.

## Deliberately not done

- No write to Expo. The foundation reads (`meActor`, `app`); linking and unlinking change only this tool's database.
- No project listing or search: the person gives the id or `@account/slug`, or reads it from `app.json`. Listing needs a field of the
  account's projects that was not verified.
- No token creation or rotation at Expo, and no storing of Expo session secrets: only access tokens.
- No webhook from Expo and no polling job yet; status features decide how they read.
- No new role action and no new environment switch: the foundation only reads. A feature that writes at Expo adds its own gate.
- `apiOrigin` applies to the module's calls and to `expoClientFor`; the generic "Test connection" of a credential always asks
  `api.expo.dev` (the credential test seam is the `fetch` of `deps.credentialTests`).

## Update: reading `eas.json`

One feature on the foundation reads nothing from Expo: `GET /apps/:appId/eas-config` parses `eas.json` and the JSON app config at the repository root through the repository connector, with a tolerant parser in `packages/connectors/src/expo/eas-config.ts` (names of `env` only, never their values; a dynamic app config is reported, never run). It needs `repositories.scan` and no Expo credential. What was checked against Expo's pages and what was not is in [docs/api/eas-config.md](../api/eas-config.md).
