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
- **Built:** the server and the repositories screen follow this rule (tested with fixtures only).
  An unreadable Expo config blocks App Store edits (422) instead of falling back to fastlane, and
  a dynamic `store.config.js` is never read. EAS Metadata has no Google Play support, so Play
  listings always come from fastlane. See [docs/spikes/expo-store-config.md](spikes/expo-store-config.md).

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

## Local clones ([ADR 0005](adr/0005-local-clone-reads.md))

### 15. Attaching a clone whose `origin` names another repository

- **Decided:** attaching needs an explicit confirmation (`allowRemoteMismatch`), and the attach is audited.

### 16. Attached repository when local reads are unavailable

- **Decided:** when `MRM_READS=api` or no `MRM_LOCAL_REPO_ROOTS` is set, an attached repository keeps
  reading from GitHub and its status badge says so (it does not refuse). A local-only repository still
  refuses, because it has nothing else to read from.

### 17. Commits written to a local clone

- **Today:** signing is **opt-in** (`MRM_GIT_SIGN=ssh|gpg`, with a key and a program the operator
  configures; off by default, then the commits are unsigned). No hooks run, and Git LFS or attribute
  filters are not applied (an LFS-tracked listing path would be committed as plain text). Signed
  means the commit holds a signature; nothing verifies it, and it was not run on macOS or in Docker.
- **Decide:** whether hook support is ever wanted (as an opt-in), whether to refuse repositories with
  LFS-tracked listing paths, accept that for listing text, and whether the server key may sign for
  every admin and owner or only for the person who applied (see 18).

### 18. Who may push a locally applied branch

- **Today:** anyone with `changesets.approve` can trigger the push (and PR) of a branch that was just
  committed, using the repository's stored credential.
- **Decide:** keep that, or limit the push to the person who applied the change set.

### 19. Fixing up a branch

- **Today:** `POST /change-sets/:id/fixup` adds one commit on top of an existing branch, with no second
  approval (`changesets.approve` is the approval), the merge base being the last committed text, and a
  push only without force. A merged or closed pull request is refused.
- **Decide:** whether a fix up of an approved-then-applied set should need a new approval when the
  text changes, whether a fix up may also be offered for a branch whose pull request is merged (a
  new branch from it), and whether the push of a fix up should be limited to the person who applied
  (see 18).

### 20. Recomputing a store pull

- **Today:** the origin of a store pull is kept as hashes (no text) in `change_sets.origin_json`;
  older rows have none and answer `not_recomputable`. A recompute needs `changesets.write` and
  `listing.read`; a store refresh also `apps.sync`.
- **Decide:** whether to backfill `origin_json` for old pulls from the audit trail, and whether a
  recompute of an approved set should keep the approval when only whitespace changed.

## Reviews ([ADR 0007](adr/0007-review-replies.md))

### 21. Replying to reviews

- **Today:** off by default (`MRM_REVIEW_REPLY_ENABLED`); an admin or owner sends one reply at a
  time after a draft and a confirmation of the exact text; a member may write drafts; no bulk or
  automatic send; 30 sends an hour per workspace; a token needs `reviews.reply` named explicitly.
  Nothing was run against a real store.
- **Decide:** whether replies need a second person's approval (like change sets), whether members
  should be allowed to send, whether the 30 an hour limit and the 5000 character App Store cap are
  right, and whether the web should offer deleting a published Apple reply (the connector can, no
  route calls it).
- **Check with a real account:** the unverified Apple facts listed in
  [phase-3-reviews](phase-3-reviews.md#not-verified-to-check-with-a-real-account).

### 22. A per-app deep link from the inbox

- **Today:** the inbox links to the app's page; the app's Reviews tab is one click away because the
  app page does not read a tab from the address.
- **Decide:** whether the app page should accept a tab in the address (a small change to the
  portfolio screen, which another work stream owns).

### 21. Review translation: privacy and spend

- **Today:** off by default. An admin turns it on per workspace and chooses Google (the default),
  DeepL, Azure or a LibreTranslate address. Review text then leaves the server for that provider;
  nothing is logged or audited, a daily character budget (default 50,000, UTC) applies, and
  `mode: auto` translates at most 20 new reviews per sync.
- **Decide:** whether Google should stay the default (it is a third party with your customers' text),
  whether `auto` should exist at all, the default budget, and whether the terms of each store allow
  sending review text to a translator.

### 22. Settings and who may see them

- **Today:** `settings.read` is member and above, `settings.write` admin and above; a token may hold
  either. The oldest credential of a provider's kind is used (no setting names one).
- **Decide:** whether viewers should read settings (they cannot open the Settings screen now),
  whether a setting should name the credential, and whether `settings.write` should be limited to
  owners for the translation provider and address.

### 23. Private LibreTranslate addresses

- **Today:** `MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true` lets an admin point translation at a private or
  loopback address (metadata addresses stay refused). The same trust question as
  `MRM_WEBHOOKS_ALLOW_PRIVATE`.
- **Decide:** whether an allow list of hosts would be better than one switch.

## Smaller items

- Project name, then the `@mrm` scope, Tauri identifier and title ([phase-0.md](phase-0.md)).
- A security contact address in [SECURITY.md](../SECURITY.md) before the first release.
- Whether the web `Portfolio` screen shows `rawState` for unmapped statuses, and how to present Play
  `rolloutFraction` ("share of users eligible", not "installed").
- Device install and test (phase 5, proposed): the maintainer's decisions are listed at the end of
  [ADR 0006](adr/0006-device-install-and-test.md#open-decisions-for-the-maintainer).
