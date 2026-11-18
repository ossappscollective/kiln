# Open decisions

Decisions that are waiting for a person. For each: what the code does today, and what changes with
each answer. Nothing here is decided unless it says **Decided**. If you answer one, update the
linked document and remove it from this list.

## Security and approval

### 1. Second-person approval of change sets

- **Today:** an admin or owner approves and applies a change set, and may approve one they created
  themselves. A member cannot approve. Approval and apply are audited
  ([docs/api/repositories.md](api/repositories.md)).
- **Decide:** whether a change set must be approved by someone other than its creator (at least
  when it will touch a store, later). Options: keep as is for single-admin teams; require a
  different approver always; make it a per-workspace setting.
- **Effect:** a single-admin workspace could not apply its own change sets if it is always
  required.

### 2. Do edits under `.github/` stay blocked?

- **Today:** `GithubRepoConnector.propose` refuses any path under `.github/` (a workflow file
  change can run code with the repository's secrets). Applying such a change set fails with
  `422 github_invalid`.
- **Decide:** keep it blocked (recommended default in the code), or allow it with an explicit
  admin action.

### 3. First-run owner claim on a fresh instance

- **Today:** on an empty database the first `POST /api/auth/register` (or the first visit to the UI)
  creates the owner and workspace, and registration then closes. Whoever reaches a new hosted
  instance first becomes the owner.
- **Decide:** whether to require a setup token (printed to the server log or passed through the
  environment) for that first registration. Single-user mode already uses a launch secret
  ([ADR 0003](adr/0003-single-user-mode.md)).
- **Related:** the compose file publishes on 127.0.0.1 by default, which lowers the exposure but does
  not remove the question once a proxy is in front ([docs/deployment.md](deployment.md)).

## GitHub

### 4. Create the GitHub App

- **Today:** the connector supports a GitHub App or a fine-grained token. No App has been
  created for this project, and nothing has run against live GitHub.
- **Decide:** who creates the App (and the account that owns it), and whether to use one for
  testing the connector with real recordings.
- **Permissions it needs** (from the credential guide, [docs/credentials.md](credentials.md), and
  the connection test): repository permissions Contents, Pull requests and Actions at Read and
  write, Metadata read-only, webhook inactive, installed on only the repositories to manage.
  The exact permission names and the pull request permission are not confirmed from an official page
  ([docs/spikes/credential-guides-unverified.md](spikes/credential-guides-unverified.md)).

### 5. Missing GitHub permission: warning or failure?

- **Today:** when the credential test finds an App permission that is read-only or absent, the test
  still passes (`ok: true`) with `Warning: ...` details
  ([docs/api/credential-tests.md](api/credential-tests.md)). A token with no `repo` scope is also a
  warning.
- **Decide:** keep warnings (the credential can still read), or make a missing write permission fail
  the test so a bad setup is caught before the first apply.

### 6. Add `docs.cloud.google.com` to the guide-link allowlist?

- **Today:** the guides only link to hosts on an allowlist, enforced by a test in
  `packages/core/src/credential-guides.test.ts`. Google Cloud docs links use `cloud.google.com`,
  which currently redirects to `docs.cloud.google.com`
  ([docs/spikes/credential-guides-unverified.md](spikes/credential-guides-unverified.md)).
- **Decide:** add `docs.cloud.google.com` now, or only if the redirect is dropped.

### 7. Expo and fastlane in the same repository

- **Decided:** when a repository has both, the Expo config (`store.config.json`) wins as the source
  for the App Store listing.
- **Not built:** the server does not read Expo yet, so nothing enforces this. The Expo spike text
  still says the choice is not decided; it should be updated when the server is wired
  ([docs/spikes/expo-store-config.md](spikes/expo-store-config.md)). EAS Metadata has no Google Play
  support, so Play listings still come from fastlane.

## Store sync

### 8. Dedicated Google Play service account for sync

- **Today:** reads open a Play edit, and "each user may have only a single edit open at a time"; a
  new edit invalidates the previous one. The connector serializes reads per service account inside
  one process only.
- **Decide:** use a service account used only for sync, separate from any account that will later
  write. Without it, a sync can invalidate an edit someone else is preparing
  ([docs/spikes/store-api-conventions.md](spikes/store-api-conventions.md)). Reading review state
  through the tracks endpoint (see [phase-2.md](phase-2.md)) would reduce, not remove, the issue.

### 9. Apple state mappings

Current mapping (table in `packages/connectors/src/mappings.ts`); each is a judgment call, not a
documented fact. The Apple enum values themselves come partly from a secondary source.

| Apple state | Today | Question |
| --- | --- | --- |
| `PROCESSING_FOR_DISTRIBUTION` (and the older `PROCESSING_FOR_APP_STORE`) | `rolling_out` | iOS has no `propagating`; alternative is `approved` |
| `DEVELOPER_REJECTED` | `draft` | Submission withdrawn by the developer; is `draft` right? |
| `WAITING_FOR_EXPORT_COMPLIANCE` | unmapped (`status: null`) | Needs a person; which lifecycle state, if any? |
| Versions on non-iOS platforms (macOS, tvOS, visionOS) | skipped | Right for the product? `Platform` is only `ios` or `android` |

Also unmapped on purpose: `REPLACED_WITH_NEW_VERSION`, `REMOVED_FROM_SALE`,
`DEVELOPER_REMOVED_FROM_SALE`, `PENDING_CONTRACT`, `ACCEPTED`, `PREORDER_READY_FOR_SALE`,
`NOT_APPLICABLE`. Decide what the dashboard shows for an unmapped state (today the screen should show
the raw state). A phased release currently shows as `live` because it is not read.

### 10. Audit actor for background syncs

- **Today:** a queued sync records the job as actor `system` and the person who queued it as
  `requestedBy` in the detail ([docs/api/apps.md](api/apps.md)).
- **Decide:** keep that, or attribute the sync to the user who queued it, and what actor a future
  scheduled sync should have (it has no user).

### 11. App name from the store

- **Today:** the name is what the person typed (defaults to the identifier) and a sync never changes it.
  The Play connector can read a title from the default-language listing; Apple returns a name too.
- **Decide:** keep the manual name, fill it from the store on first sync only, or refresh it on every
  sync (which would overwrite a name the person chose).

## Desktop app ([ADR 0004](adr/0004-desktop-sidecar.md), proposed, not built into an app)

### 12. Node major to ship

- **Today:** CI and `.nvmrc` use Node 22; `engines` says 22.18 or newer. The app would ship one
  Node, so Node security fixes need an app release. `node:sqlite` is experimental in 22; its status
  in 24 was not checked.
- **Decide:** the major to ship, before Node 22 reaches end of life, and where releases fetch the
  verified official binary per target.

### 13. esbuild bundling (ADR option C)

- **Today:** the proposal copies the server sources and runs them with Node's type stripping, which
  is stability 1.2 in Node 22. Option C bundles to one `server.mjs` with esbuild, removing the resolve
  hook and about 900 files.
- **Decide:** adopt it now or only when size or file count hurts. It needs `esbuild` as a declared
  devDependency (a network install).

### 14. Apple notarization account

- **Today:** none. A free Apple Developer account cannot notarize, and ad-hoc signing still triggers
  the Gatekeeper prompt.
- **Decide:** who provides a paid account and signing identity for public macOS releases, and whether
  Windows signing is in scope.

## Smaller items

- Project name, then the `@mrm` scope, Tauri identifier and title ([phase-0.md](phase-0.md)).
- A security contact address in [SECURITY.md](../SECURITY.md) before the first release.
- Whether the web `Portfolio` screen shows `rawState` for unmapped statuses, and how to present Play
  `rolloutFraction` ("share of users eligible", not "installed").
