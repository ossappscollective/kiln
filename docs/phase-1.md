# Phase 1: GitHub and repos

**Exit gate:** a real fastlane or Expo repo is detected, its listing files are read and edited, and
the change lands as a pull request, with no store write involved.

**Where it stands:** the server side for fastlane repositories is built and tested against fixtures.
The gate is **not met**: no real repository has been used, the repositories screen has never been
rendered in a browser, and Expo is only done at library level.

## Done and tested

- [x] `GithubRepoConnector` in `@kiln/connectors`: GitHub App authentication, list and read files,
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
- Reading from a local clone against real GitHub: the https fetch with a personal access token and
  with an App installation token (an `Authorization` header on `git fetch`), the partial clone
  filter and fetch by object id on github.com, rate-limit and 403 bodies from git, and the Docker
  image with git installed. No timing against GitHub exists.
- Pull request creation, branch naming and the neutralised summary text, end to end on GitHub.
- The Expo fixtures are hand-written, not recorded from `eas metadata:pull`.

## To build

- [x] Expo `store.config.json` wired into the server and the repositories screen: when detection finds
      one it is the App Store listing source (fastlane otherwise; Google Play stays fastlane), edits
      are written back as a one-file change, an unreadable config blocks App Store edits. Tested with
      fake connector fixtures on SQLite; never run against real GitHub or in a browser
- [x] Scan, listing and change set creation can read from a local git clone instead of one GitHub
      API call per file (`KILN_READS=auto|clone|api`, default `auto` with a fall back to the API,
      [ADR 0005](adr/0005-local-clone-reads.md)). Apply as a pull request, connect and credential
      tests stay on the API. Tested with real local git repositories as the source for the fastlane layouts, the
      fall back, tokens in logs and audit rows, and disconnect; **never run against real GitHub
      over https**, with a GitHub App installation token, or in the Docker image (not built here)
- [x] Local clones: read a git folder on the server as a repository (`KILN_LOCAL_REPO_ROOTS`, off
      unless set, [ADR 0005](adr/0005-local-clone-reads.md)). Attach a folder to a connected GitHub
      repository, or connect it as a **local-only** repository (no credential, no owner/repo;
      a pull request apply is refused with `409 local_only`; see the next item for what it does
      instead). Committed state only, with the uncommitted count
      shown; the real path is validated against the roots at every read; git runs hardened in the
      user's repository; admin/owner only; audited. Migration 13 (nullable `credential_id`,
      `owner`, `repo`; `repository_local_checkouts`). API: [api/repositories.md](api/repositories.md).
      Web: a "Local clone" tab in the Connect dialog and a Local clone card on the repository
      page. Tested with real local git repositories (the fastlane layouts give the same results as
      the API), a hostile repository config, symlink swaps and roles; **not run on macOS, against a
      real repository, with a real dubious-ownership case, on Postgres, or in a browser**
- [x] Apply a change set to a local clone: a commit on a **new branch** of the folder, with an
      optional push of the branch to GitHub and an optional pull request ("sync listing data from
      store to fastlane metadata and commit in git with optional PR": `POST /apps/:id/listing/pull`
      drafts, this applies). `POST /change-sets/:id/apply` takes `{ mode?: "github_pr" |
      "local_branch", branch?, push?, openPr? }` (no body is the old pull request apply); `POST
      /change-sets/:id/push` retries a failed push or pull request. Opt-in
      (`KILN_LOCAL_REPO_WRITE=true`, `KILN_GIT_AUTHOR_NAME`/`_EMAIL`), admin and owner only, audited
      (`changeset.apply_local`, `.push`, `.push_failed`, `.pr_open`, `.pr_failed`). The commit is
      made with git plumbing in a temporary index (no checkout, hooks or filters, and signed only with
      the opt-in `KILN_GIT_SIGN=ssh|gpg` below; the working
      folder, index, HEAD and checked out branch are never touched; the base is verified, the branch
      can only be created); the push runs from a private bare repository that borrows the clone's
      objects, to an explicit https URL with the token in a header that only that git process sees,
      with an exact refspec. Each step (commit, push, pull request) is recorded on its own in
      `change_sets.outcome_json` (migration 14, with `publish_claim_at`), a failed push or pull
      request never undoes the commit and can be retried. Web: an Apply dialog with the two ways, a
      branch field, push and pull request checkboxes (disabled with the reason when writing is off or
      there is no GitHub connection), a result card with `git switch <branch>` and retries, and the
      "Review the draft" link from the Listing tab now opens the repository, its Change sets tab and
      the change set. Design, threat model and residual risks:
      [ADR 0005](adr/0005-local-clone-reads.md). Tested with real local git repositories (including
      hostile config and hooks), a bare repository as the push remote and an HTTP stub for the token
      header; **not run on macOS, against real GitHub (a real push or pull request), with hooks, on
      Postgres, or in a browser**
- [x] Opt-in signing of those local commits (`KILN_GIT_SIGN=off|ssh|gpg`, `KILN_GIT_SIGNING_KEY`,
      `KILN_GIT_SIGNING_PROGRAM`, `KILN_GIT_GNUPGHOME`): the server's own key and a program pinned at
      start, set with `-c` on the plumbing `commit-tree` call, so nothing in the repository's or the
      user's git config can choose the program or the key; no prompts (`--batch --pinentry-mode
      error` through a one-line wrapper for gpg, a private HOME and temp folder, a 20 second kill of
      the process group); a failure to sign stops before the branch exists (change set back to
      `approved`, `502`/`504 signing_failed` with a fixed `reason`, never an unsigned fallback); the
      object is checked for a signature header of the right format and the outcome says `signature:
      { status: "signed", format }` (signed, **not** verified); `GET /repositories/local/config` has
      `signing: { enabled, format? }` (never the key or its path); the Apply dialog says whether the
      commit will be signed and the result card shows "Signed (ssh)" with the GitHub "signing key"
      tip. Configuration is validated at start (a table test). Tested with real git 2.34.1,
      ssh-keygen, a real ssh-agent and gpg with throw-away keys (verify-commit against allowed
      signers and a keyring in the tests), a hostile repository config, a locked key, a missing
      program and a program that never answers. The GitHub-API commits of `github_pr` are not signed
      by this and are not changed. **Not run on macOS, in Docker, with a real gpg-agent/pinentry
      setup or hardware key**; see [ADR 0005](adr/0005-local-clone-reads.md) and
      [deployment](deployment.md)
- [x] CI workflows, runs and build linking ([docs/api/ci.md](api/ci.md)): list workflows and their
      `workflow_dispatch` inputs, dispatch a workflow (new right `ci.dispatch`, member and up,
      rate limited, audited with input names only), store runs in `workflow_runs` and follow them
      with a `ci.poll` job (backoff, 3 hour limit) or an on-demand refresh, link store builds to
      runs by build number (pluggable matchers, an Unlinked state, a manual link that wins),
      `GET /apps/:id/builds`, and "what changed" between two builds through a new
      `compareCommits` connector method. Web: a CI tab on the repository page (workflows, a
      Dispatch dialog with a confirmation, runs that update every few seconds only while one is
      active and the tab is visible) and a Builds tab on the app page. Tested against a fake GitHub
      and fixtures on SQLite; **never run against live GitHub, never rendered in a browser**, and
      not run on Postgres. Build numbers are matched only by the conventions in the doc, so a
      team whose CI does not put the number in a run input or title sees "Unlinked" until the
      matcher or a manual link covers it
- [x] Move scan and listing to the job queue if they prove slow: **decided against** for now. They still run in the
      request; concurrent reads of one repository share one fetch (single-flight in `GitCloneReader.refresh`) and
      idle clones are pruned, see [ADR 0005](adr/0005-local-clone-reads.md). A first clone of a very large
      repository can still hit the 90 s request timeout
- [x] Refresh stale change sets: `POST /change-sets/:id/refresh` and `GET /change-sets/:id/staleness`, a
      dependency free line based diff3 (`text-merge.ts`), per file conflicts the person settles ("keep mine" /
      "keep theirs"), approval cleared when the text changes, audit `changeset.refresh`; web banner, "Check for
      updates" and a refresh dialog. Tested on SQLite with real git repositories and a fake GitHub; **never
      run against live GitHub, never rendered in a browser**, not run on Postgres (no migration was needed)
- [x] Fix up a branch: `POST /change-sets/:id/fixup` adds ONE commit on top of an existing branch (local
      plumbing with `update-ref <ref> <new> <old>`, or the GitHub API with `force: false`), never a rewrite or
      a force; per-file conflicts with the repository and with the branch, `branch_moved`,
      `branch_checked_out`, `pr_closed`, `remote_diverged`, an optional push and pull request, audit
      `changeset.fixup`; web "Fix up this branch" dialog. ADR 0005. Tested on SQLite with real git
      repositories and a fake GitHub connector; **never run against live GitHub, with a real gpg-agent, or in
      a browser**, not run on Postgres
- [x] Idle pruning and a disk budget for the clone folder (`KILN_CLONE_MAX_BYTES`, `KILN_CLONE_IDLE_DAYS`,
      `KILN_CLONE_SWEEP_INTERVAL_MINUTES`), a scheduled sweep, `POST /repositories/:id/clone/purge`, and a
      size card in the web app. Not tried on macOS, Windows or Docker volumes
- [ ] Decide whether approval needs a second person, and whether `.github/` stays blocked
      ([open-decisions.md](open-decisions.md))
- [ ] Use a real repository end to end to meet the exit gate
