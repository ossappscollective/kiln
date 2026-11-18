# Phase 1: GitHub and repos

**Exit gate:** a real fastlane or Expo repo is detected, its listing files are read and edited, and
the change lands as a pull request, with no store write involved.

## Done (library level, nothing wired into the server or UI yet)

- [x] `GithubRepoConnector` in `@mrm/connectors`: GitHub App authentication, list and read files,
      propose a change set as a branch and pull request, dispatch workflows, list workflow runs
- [x] `detectProject`: fastlane, Expo, both, or unknown, with evidence and warnings
- [x] Listing as files: read fastlane metadata into a per-locale model, write back only the files
      that changed, validate against store character limits
- [x] [docs/spikes/repo-conventions.md](spikes/repo-conventions.md): what was checked against
      current docs and what was not

## Not verified

- Every GitHub call is tested against hand-written fixtures, never against live GitHub. Record real
  responses from a test repo and App.
- Character and byte counting rules, required fields, and locale code lists (see the spike doc).

## To build

- [ ] Server routes: connect a repository (credential plus owner/repo), scan, read listing, propose
- [ ] Repository screen from the design canvas: files, detected project type, change set review
- [ ] Decide whether `propose` requires an approved change set, and whether `.github/` stays blocked
- [ ] Expo `store.config.json` read and write (the connector only detects it)
- [ ] Workflow run tracking and build linking
- [ ] Invitations, so a second person can join a workspace
