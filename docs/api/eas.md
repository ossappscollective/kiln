# Expo (EAS) project of an app

The link between an app record and its Expo Application Services project ([ADR 0033](../adr/0033-eas-integration.md)). It needs a
credential of the kind `expo` (an Expo access token; a robot user with the Developer role is recommended, see
[credentials](../credentials.md#expo-access-token-eas)). One link per app record: an iOS and an Android record of the same product each
have their own and may name the same project. Nothing in Expo is ever changed by these routes.

| Route | Right | What it does |
| --- | --- | --- |
| `GET /api/workspaces/:workspaceId/apps/:appId/expo` | `apps.read` | The link, or `{ "link": null }`. Database only. |
| `PUT /api/workspaces/:workspaceId/apps/:appId/expo` | `apps.write` | Links the app (or changes the link). Asks Expo first. |
| `DELETE /api/workspaces/:workspaceId/apps/:appId/expo` | `apps.write` | Removes the link. `204`; `404` when there was none. |
| `GET /api/workspaces/:workspaceId/apps/:appId/expo/detect` | `apps.write` | Reads the project id from `app.json` of the repository. |

`apps.write` is owners and admins. A token limited to some apps may use these routes for those apps only. Non-members and apps of
another workspace are `404`.

## The link

```json
{
  "link": {
    "appId": "…",
    "credentialId": "…",
    "credentialLabel": "Expo robot",
    "credentialAvailable": true,
    "projectId": "2f1c8e5a-7b3d-4c9e-8a61-0d5b9e4f7a12",
    "accountName": "acme",
    "slug": "trail-notes",
    "fullName": "@acme/trail-notes",
    "projectName": "Trail Notes",
    "verifiedAt": 1760000000000,
    "linkedBy": "user id",
    "createdAt": 1760000000000,
    "updatedAt": 1760000000000
  }
}
```

`credentialAvailable` is `false` (and `credentialLabel` `null`) when the credential was deleted: the link stays; choose another
credential and save again. Times are epoch milliseconds. `verifiedAt` is when Expo last confirmed the project.

## Save

`PUT` with `{ "credentialId": "…", "project": "…" }`. `project` is the project id (a UUID, `expo.extra.eas.projectId` of `app.json`) or
`@account/slug` (the `@` may be left out). The server decrypts the token for this one call (audited as `credential.use`, purpose
`eas.link`), asks Expo for the project, and stores what Expo answered (id, account, slug, name), never what was typed. A project the
token cannot see is not saved. At most 20 saves a minute per workspace.

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Missing or extra fields. |
| `404` | `not_found` | No such app in this workspace. |
| `422` | `credential_not_found` | The credential is not in this workspace. |
| `422` | `credential_kind` | The credential is not an Expo access token. |
| `422` | `credential_unreadable` | The stored secret cannot be decrypted. |
| `422` | `invalid_project` | Neither a UUID nor `@account/slug`. |
| `422` | `expo_auth` | Expo did not accept the token. |
| `422` | `expo_forbidden` | The token may not do this (role, account). |
| `422` | `expo_not_found` | Expo has no such project, or the token cannot see it. |
| `429` | `rate_limited` | Our limit, or Expo's; `Retry-After` and `retryAfterSeconds`. |
| `502` | `expo_unavailable` | Expo could not be reached or answered something unreadable. |
| `504` | `timeout` | Expo did not answer in time. |

Messages are fixed sentences; Expo's own text and the token are never in them.

## Detect

`GET …/expo/detect` reads one file, `app.json` at the root of the app's repository, as JSON text (a local clone when local reads are
on, else the GitHub API), audited as `credential.use` with purpose `eas.detect` on the repository's credential. A dynamic
`app.config.js` or `app.config.ts` is **never run**. Expo is not called and nothing is saved.

```json
{ "detection": { "detected": { "projectId": "…", "owner": "acme", "slug": "trail-notes", "fullName": "@acme/trail-notes", "path": "app.json" }, "reason": null, "message": null } }
```

`detected` is `null` with a `reason` and a `message` when nothing usable was found: `no_repository`, `repository_unavailable`,
`dynamic_config`, `no_app_json`, `unreadable`, `no_project_id`, `read_failed`. `projectId` is `null` when app.json names only the owner
and the slug. A rate limit or a timeout of the repository is a `429` or `504` as for any repository read.

## Audit

`eas.link_set` (target: the app; detail: `appId`, `credentialId`, `projectId`, `fullName`, `replaced`), `eas.link_remove` (detail: `appId`,
`projectId`, `fullName`), and `credential.use` with purpose `eas.link` or `eas.detect`. The token is never in an audit row.

## For other server features

`expoClientFor(db, masterKey, workspaceId, credentialId, deps, { actor, purpose, now })` in `apps/server/src/modules/eas/client.ts`
gives a client for one credential (and audits the use under your `purpose`); `getExpoLink` and `listExpoLinks` in `link.ts` read the
links; `expoFailure` turns an Expo error into the response codes above.
