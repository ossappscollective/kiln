# Phase 1: GitHub and repos

**Exit gate:** a real fastlane or Expo repo is detected, its listing files are read and edited, and
the change lands as a pull request, with no store write involved.

**Where it stands:** the server side for fastlane repositories is built and tested against fixtures.
The gate is **not met**: no real repository has been used, the repositories screen has never been
rendered in a browser, and Expo is only done at library level.

## Done and tested

- [x] `GithubRepoConnector` in `@mrm/connectors`: GitHub App authentication, list and read files,
      propose a change set as a branch and pull request, dispatch workflows, list workflow runs.
      Writes to `.github/` are blocked by default (see [open-decisions.md](open-decisions.md))
- [x] `detectProject`: fastlane, Expo, both, or unknown, with evidence and warnings
- [x] Listing as files: read fastlane metadata into a per-locale model, write back only the files
      that changed, validate against store character limits
- [x] Repositories API ([docs/api/repositories.md](api/repositories.md)): connect and disconnect a
      repository, scan, read the fastlane listing, create, approve, apply and discard change sets.
      Approval is an admin or owner action; apply opens a branch and pull request and never pushes
      to the default branch. Apply timeouts, conflicts and a lost race are handled (covered by tests)
- [x] Credential connection tests for `github_app` and `github_token`
      ([docs/api/credential-tests.md](api/credential-tests.md)). A missing GitHub App permission is a
      warning on a passing test, not a failure
- [x] Invitations, so a second person can join a workspace ([docs/api/members.md](api/members.md))
- [x] Expo `store.config.json` at **library level**: `loadExpoStoreConfig`,
      `validateExpoStoreConfig` and `expoStoreChangeSet` in `packages/connectors/src/expo-store.ts`
      read the Apple listing into the shared model, validate it, and write back only changed
      values while keeping key order and unknown keys. No Google Play support exists in EAS
      Metadata, so none is built. Not wired into the server or UI
      ([docs/spikes/expo-store-config.md](spikes/expo-store-config.md))
- [x] Spike notes: [repo-conventions](spikes/repo-conventions.md), [expo-store-config](spikes/expo-store-config.md)

## Written but never run

- [ ] Repositories screen (list, connect form, detected project type, listing editor, change set
      review with diff): `apps/web/src/components/Repositories.svelte` and
      `apps/web/src/components/repositories/`. Its client-side helpers have unit tests
      (`apps/web/src/lib/repositories.ts`); **no browser has rendered it**

## Not verified

- Every GitHub call is tested against hand-written fixtures, never against live GitHub. Record real
  responses from a test repo and App.
- Character and byte counting rules, required fields, and locale code lists (see the spikes).
- Whether the GitHub App permission names and levels in the credential guide and the test match
  what GitHub requires ([credential-guides-unverified.md](spikes/credential-guides-unverified.md)).
- Pull request creation, branch naming and the neutralised summary text, end to end on GitHub.
- The Expo fixtures are hand-written, not recorded from `eas metadata:pull`.

## To build

- [ ] Wire Expo `store.config.json` into the server: scan, read, change set. Decided: when a
      repository has both, the Expo config wins as the App Store source
      ([open-decisions.md](open-decisions.md)); not implemented
- [ ] Workflow run tracking and build linking (the connector can list runs; nothing uses it)
- [ ] Move scan and listing to the job queue if they prove slow (they run in the request today)
- [ ] Refresh stale change sets (today a conflict means discarding and creating a new one)
- [ ] Decide whether approval needs a second person, and whether `.github/` stays blocked
      ([open-decisions.md](open-decisions.md))
- [ ] Use a real repository end to end to meet the exit gate
