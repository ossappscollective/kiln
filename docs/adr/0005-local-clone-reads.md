# ADR 0005: Read repositories from a local clone

Status: proposed. It stays proposed until the clone path has run against real GitHub (see "What is
verified, and what is not"). Phase 1 is `GitCloneReader` in `packages/connectors/src/git-clone.ts`
(41 tests, no network). Phase 2, the server integration, is implemented and tested with local git
repositories (see "Implemented" below). Phase 3 adds **local clones**: a folder on the server read as
a repository, attached to a GitHub repository or on its own (see "Local clones"). Nothing was
measured against GitHub itself, and phase 3 was not run on macOS, with a real repository, or in a
browser. Phase 4 adds **writing to a local clone**: an approved change set as one commit on a new
branch of the folder, with an optional push and pull request (see "Writing to a local clone"). It
was tested with real git repositories and a bare repository as the push remote; it was never run on
macOS, against GitHub, with real hooks or signing, in a browser or on Postgres.

## Context

Every scan, listing read and change set creation reads the repository through the GitHub REST API:
one call for the ref, one for the tree, then one call per file (`readFile`), a few at a time. That
is slow (a round trip per file), counts against the rate limit, and a large listing (60 locales
with 6 files each) is hundreds of requests. The request that started this ADR: "could we use a
local clone of the github repo? all that would be much faster".

Writes are different and stay as they are: the connector applies a change set as a branch, blobs,
tree, commit and a pull request through the API, with a conflict check against the live tree
([api/repositories.md](../api/repositories.md)). Nothing in phases 1 to 3 changes that. Phase 4
adds a second, opt-in way to apply, into a local clone (below); the GitHub way is unchanged and
still the default for a repository with a GitHub connection.

## Decision

Reads go through `GitCloneReader`, a drop-in for the read half of `RepoConnector`
(`listFiles(ref?)`, `readFile(path, ref?)`, plus `resolveCommit(ref?, signal?)` and
`defaultBranch()` as `GithubRepoConnector` has them). It is backed by the git CLI and a managed
clone. The GitHub API stays for connecting a repository, credential tests, apply and pull requests.

### The clone

- Location: `<MRM_CLONE_DIR>/<workspace id>/<repository id>`, default
  `<MRM_DATA_DIR>/clones/...`. Ids are checked (letters, digits, `-`, `_`), so they cannot
  traverse. The folder holds `mrm-clone.json` (a marker and the source URL, no secret); the
  marker is what allows deleting it.
- A bare repository made with `git init --bare --template=` (the empty template: no sample
  hooks), then `git fetch --depth 1 --filter=blob:none origin +refs/heads/<branch>:refs/mrm/heads/<branch>`.
  Branches are kept under `refs/mrm/heads`, tags under `refs/mrm/tags`, a commit fetched by sha under
  `refs/mrm/commits`. No working tree exists, so there is nothing to check out.
- Shallow (depth 1) and partial (no blobs). Measured on a throwaway repository of 4,120 files
  (4 MB of content): 112 KiB on disk after listing, 321 KiB after the 120 listing files were read.
- A tag or branch name is tried as a branch first, then as a tag (as `GithubRepoConnector` does).
  A full 40 character sha is fetched by id; this needs the host to allow it (GitHub does for
  reachable commits; unverified here).

### Reading without a checkout

`listFiles` is `git ls-tree -r -z <commit>`; `readFile` finds the blob id in that listing (cached
per commit, newest 8 kept) and reads it with `git cat-file --batch`. No path is ever passed to git:
the tree is listed once and files are addressed by object id, so there are no pathspec or quoting
problems. Why not `git checkout` or `git archive`:

- A checkout applies `.gitattributes` filters (smudge, `process`, LFS), may run `post-checkout`
  hooks, creates symlinks and, with submodules, fetches more repositories. A repository the user
  connected is untrusted input. Reading objects does none of that: a symlink is a blob holding
  text (`readFile` returns `undefined` for it, as the GitHub connector does), `.gitmodules` is a
  text file, a submodule is a `160000` tree entry that is not listed, and an LFS file is its
  pointer text.
- No file from the repository is ever written to disk outside git's object store.

Contract kept from the GitHub connector: `listFiles` is sorted and lists blobs only (symlinks
included, submodules not); `readFile` returns `undefined` for a missing file, folder, symlink or
submodule, throws `GithubError` `invalid_input` for a path that fails `checkRepoPath` (same rules,
same message, kept in step by a test), `not_text` for invalid UTF-8 (a BOM is kept), and `too_large`
above `maxFileBytes` (5 MiB here, 10 MiB there).

### Blobs: fetched in batches, never one by one

With `--filter=blob:none` the file contents are not in the clone. git can fetch a missing object
lazily when a command needs it, but that is one round trip per object, which is the problem we are
leaving. So:

- Every read command runs with lazy fetching off (`GIT_NO_LAZY_FETCH=1` and
  `GIT_ALLOW_PROTOCOL` set to an unknown name that blocks every transport). A missing blob is
  reported as missing, never fetched behind our back.
- The reader finds the blobs it lacks with `git cat-file --batch-check` and fetches them all in one
  request: `git fetch --stdin --filter=blob:none origin` with the object ids on stdin (what git
  itself runs for a partial clone).
- Reads asked for in the same turn of the event loop are coalesced (`loadListing` reads six at a
  time). On the first read of a commit the reader also downloads the files detection and listing
  need in one go (`defaultWarmPaths`: `package.json`, `app.json`, `eas.json`, store configs,
  Fastfile and Appfile, `fastlane/**/metadata/**.txt`). `warm(paths, ref)` is for callers that know
  better; `warmPaths: null` turns the default off.
- Alternatives: `--filter=blob:limit=N` downloads every small blob with the fetch (thousands for a
  source tree, for no reason). No filter (`filter: null`) downloads everything at depth 1. Both are
  options; `blob:none` plus a batch is the default because a scan reads about 1 to 5 percent of the
  files.
- A file's size is only known after it is downloaded (git cannot filter explicitly requested
  blobs by size), so a huge file in the warm set or a read is downloaded once and then refused. It
  stays in the clone until `compact()`. This is accepted: the cap protects server memory, and the
  warm set is narrow.

### Freshness

- `refresh(ref?)` always fetches the tip (a normal depth 1 fetch with `+` so a force push works) and
  returns `{ ref, commit, changed, fetchedAt }`.
- `listFiles` and `readFile` resolve the ref first: a full sha is used if the clone has it; a name
  uses the fetched tip until `ttlMs` (default 60 s) has passed, then fetches. `ttlMs: Infinity`
  never fetches when a copy exists (offline use). Concurrent resolves of one ref share one fetch.
- `resolveCommit(ref, signal)` returns the full sha. Callers pass it back as `ref`, or use
  `pin(ref)` for a reader fixed to one commit. Sha-addressed reads never go stale, which is what
  the server's `repo-snapshot.ts` cache is keyed on.
- Uncommitted changes in a local source are not seen: only commits are read.

### Concurrency

One mutex per clone directory (module level, so two readers of one folder share it) serialises
everything that writes: init, ref fetches, blob fetches, `compact`, `remove`. Reads (`ls-tree`,
`cat-file`) do not take it: git's object store is safe to read during a fetch. Two server
processes on one folder rely on git's own lock files; a lock error is reported as a retryable
`conflict`. Clones should not be shared between hosts.

### Errors

`GitCloneError extends GithubError`, so `githubFailure()` in the server maps it with no change.
git's stderr is classified: 401 or "could not read Username" is `auth`; 403 `forbidden`; 404 or
"not found" `not_found`; "couldn't find remote ref" `not_found` with the ref named; 429
`GithubRateLimitError` (60 s); 5xx `server`; connection errors, timeouts and cancellation
`network` with `reason: 'timeout' | 'aborted'`; a locked clone `conflict`; a failed fsck
`unexpected`. Anything unrecognised is `unexpected` with the first line of git's output, so a new
message is visible. Messages never include a token, a header, URL credentials or the clones
folder path (redacted a second time against the known secrets).

## Authentication

The clone URL is `https://github.com/<owner>/<repo>.git` (`baseUrl` for GitHub Enterprise Server).
It has no secret and is the only thing stored in the clone's config. The token (a GitHub App
installation token or a PAT, from a string or a function called before each network operation) is
passed only in the environment of the one git process that talks to the host:

    GIT_CONFIG_COUNT=1
    GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
    GIT_CONFIG_VALUE_0=Authorization: Basic base64("x-access-token:<token>")

The header is scoped to the host's URL and `http.followRedirects=false`, so a redirect cannot carry
it to another host (a redirect is reported as an error that says the repository may have moved).
It is not in argv (visible to every process in `ps`), not in the clone's config, not in logs.
Tests check: the header arrives at a stub host; the token and its base64 are in no argv of any
git process, no file in the clone, no thrown error, and not in the environment of any git process
that does not talk to the host; whatever git prints is redacted. An askpass helper script was
considered and not used: it needs an executable file on disk (noexec data volumes, Windows) and
makes git ask first and send second; the header form works on every platform and sends credentials
once.

## Threat model

The repository, the owner of a repository we are connected to, and anyone who can push to it are
untrusted. The attacker wants code execution, file access outside the clone, a leaked token, or
disk or memory exhaustion.

| Threat | Mitigation | Tested |
| --- | --- | --- |
| `.gitattributes` filter, textconv, LFS smudge | never checked out; reads are `ls-tree` and `cat-file` without `--filters`/`--textconv`; `filter.lfs.*` emptied | yes, with a filter configured in the clone |
| Hooks | empty init template; `core.hooksPath=/dev/null` on every command and in the clone's config; hooks are not objects | yes, control showed a `reference-transaction` hook does run without it |
| Symlink to `/etc/passwd` or `../..` | nothing is on disk; a symlink is a blob, `readFile` gives `undefined` | yes |
| Submodule, `.gitmodules` | no recursion (`--recurse-submodules=no`), no checkout; a `160000` entry is not listed | yes |
| Path traversal in a file path or in ids | `checkRepoPath` rules (same as the connector), no path ever reaches git, ids are validated, `remove` resolves symlinks | yes |
| Malicious objects (`.git` entries, bad trees) | `fetch.fsckObjects` and `transfer.fsckObjects` | yes (`.git` tree entry) |
| Token leak | environment-only header, redaction, env allowlist (see below) | yes |
| Other protocols (`ext::`, `file`, ssh) | `GIT_ALLOW_PROTOCOL=https` for a GitHub source; `file` only for an explicit local source; the name is blocked for reads | yes |
| Env or config of the host process changing git | git gets an allowlisted environment (`PATH`, proxy and CA variables, `TMPDIR`), `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=<clones dir>`; `GIT_TRACE*`, `GIT_SSH_COMMAND`, `GIT_DIR` are dropped; `GIT_TERMINAL_PROMPT=0` | yes |
| Hung or runaway git | timeout and `AbortSignal` kill the whole process group; stdout cap on every call; 5 MiB per file, 64 MiB per listing | yes |
| Two fetches corrupting a clone | per-clone mutex; damaged clone is rebuilt | yes |
| Deleting the wrong folder | `remove` needs a real folder (not a symlink) with our marker, resolved inside the base directory | yes |
| Huge repository fills the disk | see below | no |

Not covered: a git vulnerability in `fetch`/`ls-tree`/`cat-file` themselves (keep git current), and
local-source mode, which trusts the path (below).

## Disk usage and cleanup

A clone is a cache: it can be deleted at any time and is made again on demand.

- Size: trees and one commit, plus the blobs that were read. Old commits and blobs stay until
  `compact()` (`git gc --prune=now`, which also drops sha pins). Disk is for deployment to watch;
  `diskUsage()` reports a clone's size.
- Deleted by: `remove()` / `removeClone()` when the repository is disconnected;
  `removeWorkspaceClones()` for a workspace; the operator by hand.
- Pruned by the **clone sweep** (built, see "Idle pruning and the disk budget" below); `compact()`
  after every 50 refreshes is still not done.
- A first clone of a large repository is bounded by `fetchTimeoutMs` (120 s) and the server's
  request timeout (90 s), which cancels the fetch. Moving scan to the job queue would remove that
  limit ([architecture.md](../architecture.md)).

### Idle pruning and the disk budget (built)

- [x] Idle pruning and a disk budget for `MRM_CLONE_DIR`.

`services/clone-upkeep.ts` (`createCloneUpkeep`) runs one sweep over the folder; the scheduler calls
it every `MRM_CLONE_SWEEP_INTERVAL_MINUTES` (default 360, `0` = off; the first run is at the first
scheduler tick after start, not at start itself).

- **Last use.** The marker `mrm-clone.json` has its mtime touched when a clone is resolved or
  verified for a read (`GitCloneReader.#touch`, at most once every 30 s per clone), so the marker is
  the clock. A clone with no marker is not a clone and is not touched.
- **Idle phase.** Clones unused for `MRM_CLONE_IDLE_DAYS` (default 30, `0` = never) are removed.
- **Budget phase.** If the folder is still over `MRM_CLONE_MAX_BYTES` (default 2 GiB, accepts `500m`,
  `2g`, `10 GiB`; `0` = unlimited) the least recently used clones are removed until it is not. The
  budget is for the whole folder, so one workspace's clones can make room for another's; the audit
  event is written per workspace, with counts only (`clone.prune`: scanned, removed, idle, budget, bytes
  freed, skipped in use, failed).
- **Never in use.** A clone is skipped when its per-directory lock is held (`isCloneBusy`) or it was
  touched in the last ten minutes (`IN_USE_GRACE_MS`). Skipped clones are counted; if they keep the
  folder over budget the summary says `overBudget` and the next sweep tries again.
- **Safety.** `listClones` lists only direct children that are real directories with a regular-file
  marker whose real path is inside the base; symlinks, strangers and anything that resolves
  elsewhere are counted as `refused` and never followed or removed. Removal goes through
  `GitCloneReader.remove` under the same lock as reads.
- **Concurrent reads.** A read that arrives after a removal finds no clone and makes it again
  (the first read after a prune is as slow as a first clone); a read that is mid-flight holds the
  lock, so the sweep skips it.
- **Sizes** are a du-style walk (no symlink following, 200k entries cap, `sizeIsLowerBound` when
  reached), cached for ten minutes for the report; the sweep walks fresh, once per clone.
- **By hand.** `POST /repositories/:id/clone/purge` (admin, owner) removes one clone now
  (`409 clone_busy` while it is read), audited as `clone.purge`; `GET /clones` and
  `GET /repositories/:id/clone` show sizes ([api](../api/repositories.md)). The web app shows the size on
  the repository page with a "Free space" button (`CloneCard`).

**Single-flight instead of a job queue.** The "move scan and listing to the job queue" item was
decided against for now: a scan and a listing return a result the person waits for in the same
screen, so the queue would add a polling flow (job rows, a result store, web progress) in several
places that a concurrent reader would also have to share; and what actually hurts, many people
asking for the same repository at once, is cured more cheaply. `GitCloneReader.refresh()` is
now single-flight per clone: requests that arrive while a fetch runs share it (a caller that gives
up leaves the shared fetch running while another waits, and the last one to leave aborts it).
Five concurrent scans cost one fetch. The first clone of a very large repository is still bounded by
the 90 s request timeout.

## Docker and deployment

The image (`node:22-bookworm-slim`) has no `git`. The Dockerfile now runs
`apt-get install -y --no-install-recommends git ca-certificates` (root, before `USER node`, apt
lists removed) and creates `/data/clones` (mode 0700, owned by `node`; `MRM_CLONE_DIR=/data/clones`).
**The image has not been built**: no Docker was available. The clone folder is under `/data`, which
is the volume the container already writes to. Needed: git 2.34 or newer (tested with 2.34.1; `GIT_CONFIG_COUNT` needs 2.31, `GIT_CONFIG_GLOBAL`
2.32). Debian 12 ships a newer git (expected 2.39); behaviour on it is unverified. The server
checks `git --version` at start when `MRM_READS` is not `api`.

## Local clones (phase 3)

The original idea was "use my local checkout" in the desktop app only. It became a general feature
with a stricter model, because the maintainer runs the multi-user server on their own Mac with
projects under `/Volumes/dev`. Reading a folder is only safe if the operator names, in advance,
which folders may ever be read.

### Decision

- **Off by default.** `MRM_LOCAL_REPO_ROOTS` is an absolute-path list (colon separated). Unset means
  no folder can be checked, attached or read, in hosted and in `single_user` mode alike. The web app
  says so and names the variable; when it is set, the Connect dialog lists the roots.
  `MRM_READS=api` ("git is never run") also turns it off.
- **Two uses.** (a) Attach a folder to an existing GitHub repository: reads come from the folder,
  apply still opens a pull request on GitHub by default (or commits to the folder, phase 4). (b)
  Connect a folder as a **local-only** repository with no credential and no `owner/repo`: reads come
  from the folder; a change set is applied as a commit on a new branch of the folder (phase 4,
  `MRM_LOCAL_REPO_WRITE=true`); `github_pr` is refused with `409 local_only` (checked before the
  change set is claimed, so it stays approved).
- **Committed state only.** The reader fetches the tip of one chosen branch from the folder into a
  managed bare clone (`<MRM_CLONE_DIR>/<ws>/<repoId>-local`, ttl 0, so every request sees the newest
  commit). Nothing is checked out and the folder is never written to. Uncommitted work is not read;
  the UI shows the count from a read-only `git status` ("Reads commit abc1234 on branch main; 3
  uncommitted changes are not included").

### Data model

Migration 13 makes `repositories.credential_id`, `owner` and `repo` nullable (NULL, not a sentinel
such as an empty string: a unique index on `owner, repo` must not collide, and a foreign key to
`credentials` must not point at an invented row) and adds `repository_local_checkouts`
(`repository_id` primary key, `workspace_id`, `path`, `branch`, `name`, `last_commit`,
`last_read_at`, audit columns; unique on `(workspace_id, path)`). A separate table keeps the local
facts out of every query that does not care and lets a GitHub repository gain or lose a folder.
SQLite cannot drop NOT NULL, so the migration rebuilds the table inside its transaction with
`PRAGMA defer_foreign_keys = ON` (the foreign keys from change sets and listing targets resolve at
commit); Postgres uses `DROP NOT NULL`. A migration test runs migrations 1 to 12 with data, then 13,
and checks the rows, the joins, `foreign_key_check` and the unique index.
In TypeScript, `Repository` keeps `credentialId`, `owner` and `repo` as strings (`''` for a
local-only one) with `localOnly` as the discriminator, so code written for GitHub repositories still
compiles; HTTP responses give `null`, and `openConnector` refuses an empty credential with `409
local_only`.

### Threat model

The person who attaches a folder is an admin or owner, but the *contents* of the folder are
untrusted (a cloned repository carries its own config), and the *path* is attacker-shaped input.

| Threat | Mitigation | Tested |
| --- | --- | --- |
| Reading any folder on the machine | allowed roots from the environment only; the real path must be inside one; `/` is refused as a root | yes |
| Traversal, symlink out of a root, NUL bytes, long paths | text rules (absolute, no `..`, no control characters, 4096 bytes); `realpath` before the root test; a symlinked `.git` is refused; a `.git` file's git directory (and `commondir`) must be inside a root too | yes |
| Swapping a folder for a symlink after it was attached | the real path is validated again at every read, not only when attached | yes |
| Reading the server's own data or clones | `MRM_DATA_DIR`, `MRM_CLONE_DIR` and any folder with `mrm-clone.json` are refused | yes |
| Bare repositories and non-repositories | need a `.git` directory with `HEAD` or a worktree `.git` file | yes |
| Code execution through the repository's own config (`core.fsmonitor`, hooks, `core.sshCommand`, `diff.external`, filters, `core.alternateRefsCommand`) | every git call gets `--no-pager` and `-c` overrides that empty them; `status` also empties configured `filter.<name>.*` drivers; `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`, an allowlisted environment, `GIT_OPTIONAL_LOCKS=0`, lazy fetch and all transports blocked | yes, with a hostile repository config and a control showing plain git does run it |
| A person without the right | `repositories.write` (admin, owner) for check, connect, attach, detach; config shows the roots only to them; non-members get 404 | yes |
| Credentials in the origin URL | the URL is parsed to host, owner and name; userinfo is dropped and never returned, logged or audited | yes |
| Using git when told not to | `MRM_READS=api` means git never runs; attached repositories then read from GitHub, local-only ones refuse | yes |
| The repository's or user's git config choosing the signing program or key (`gpg.program`, `gpg.ssh.program`, `user.signingkey`, `commit.gpgsign`) | key, program and format come from the server's environment, passed with `-c` after the config files; the program is pinned by absolute path at start; `GIT_CONFIG_GLOBAL=/dev/null` | yes (recording program vs a repository program, and which key signed) |
| A signing program or `gpg` waiting for a passphrase, a hung agent | `--batch --no-tty --pinentry-mode error` through the wrapper; no `DISPLAY`, `SSH_ASKPASS` or tty in the environment; the process runs in its own process group, killed after 20 seconds; `signing_failed` with reason `locked` or `timeout` | yes (locked ssh key, locked gpg key, a program that sleeps) |
| An unsigned commit where a signed one was promised | signing failure stops before `update-ref`; the object must hold a `gpgsig` block of the configured format before any ref points at it; no fallback | yes |
| The key or its path leaking (response, audit, log, outcome, repository); the path is in the process arguments while signing runs | never returned or stored: the config endpoint gives the format only; the program's output is classified and dropped; config errors do not name the path; the start-up log has the format and the public fingerprint; the key file is read by ssh-keygen only | yes |
| The server environment reaching the signing program | allowlisted environment plus `HOME`, `TMPDIR`, `GNUPGHOME`, `SSH_AUTH_SOCK` only as described; `HOME` is a private temporary folder | yes (a planted master key and socket are not seen) |
| A key file others can read | refused at start when it has group or other permission bits (ssh would refuse it too) | yes |
| Audit gaps | check, connect, attach, change and detach are audited with the path and branch, never content | yes |

Decisions:

- **No `safe.directory`.** Newer git refuses a repository owned by another user. Setting
  `safe.directory=*` would make that protection meaningless for exactly the folders we should be
  careful about. The error is `dubious_ownership` with advice to run the server as the folder's
  owner or change the owner. Not tested for real (it needs a different owner and the test run is
  unprivileged); only the mapping of git's message is tested.
- **A branch, not "whatever is checked out".** The person picks the branch; a detached HEAD must be
  resolved by choosing one.
- **Remote mismatch needs a confirmation.** Attaching a clone whose `origin` names another GitHub
  repository is refused unless `allowRemoteMismatch` (forks, mirrors); the confirmation is audited.

Accepted residuals, to be revisited:

- **Check, then use.** The path is validated with `realpath`, then git opens it a moment later. A
  person who can write inside a root can swap things in that gap. Keep roots to folders only the
  operator writes.
- **Trust inside a root.** A repository's `.git/objects/info/alternates`, or a worktree's `commondir`
  inside a root, is followed by git. Roots must not hold folders other people control.
- **Cost.** ttl 0 means one local fetch (file protocol, no network) per request. It is cheap for a
  disk-to-disk copy; revisit with a short ttl if a large repository makes it slow.
- **Working-tree reads.** Not built. Reading uncommitted edits would mean running git with a working
  tree (filters, `core.autocrlf`, smudge) and is a different risk class.

### What is not built

- ~~Applying a local-only change set.~~ Built in phase 4 as a commit on a new branch of the folder
  ("Writing to a local clone"): the decision was a commit made with git plumbing, not a patch file.
- Reading uncommitted work, a folder picker (the web app takes a typed path), pruning of the managed
  copies, a per-workspace list of roots, Windows paths.

## Writing to a local clone (phase 4)

Phase 3 read a folder. The request that started this phase was "sync listing data from store to
fastlane metadata and commit in git with optional PR". The first half exists (`POST
/apps/:id/listing/pull` makes a draft change set). This phase adds the second: an approved change
set can be applied as **one commit on a new branch of the local clone**, with an **optional push**
of that branch to GitHub and an **optional pull request**. It is the first place this tool writes
into a repository on the server's disk, so it has its own opt-in, its own threat model and its own
git path.

### Decision

- **Opt-in, off by default.** `MRM_LOCAL_REPO_WRITE=true` (and `MRM_LOCAL_REPO_ROOTS`, which
  must name the folder). Without it, `mode: local_branch` is refused with `409 local_write_disabled`
  and nothing is touched. Reading local clones does not need it. The web app reads the setting from
  `GET /repositories/local/config` (`write`) and shows the option disabled with the reason.
- **Signing is opt-in and the server's own.** `MRM_GIT_SIGN=off|ssh|gpg` (default `off`, which is
  exactly the behaviour before signing existed). With `ssh` or `gpg` the commit is signed with a key
  the operator configured, never one from the clone's or the user's git config. See "Signing".
- **Same right as apply.** `changesets.approve` (admin, owner). Members and viewers get 403,
  non-members 404 (as every change set route). The push endpoint needs the same right.
- **Two modes of apply.** `POST /change-sets/:id/apply` takes an optional body
  `{ mode?: 'github_pr' | 'local_branch', branch?, push?, openPr? }`. No body or `github_pr` is the
  call as it was (a branch and a pull request through the GitHub API). `local_branch` commits to
  the local clone. A local-only repository can use `local_branch` only; `github_pr` stays `409
  local_only`. `branch`, `push` and `openPr` with `github_pr` are `400`.
- **A commit, not a checkout.** The base is the tip of the branch the clone is read from. The new
  branch is `refs/heads/<name>` (default `mrm/<slug of the summary>-<first 8 of the id>`). The
  checked out branch, the working folder, the index and HEAD are not touched, so nothing the person
  has open changes. The UI shows `git switch <branch>` to look at it.
- **Each step reports on its own.** The result and the stored outcome carry three steps: commit,
  push, pull request. A failed push or pull request **does not roll back the commit**; the change
  set stays `applied`, the step is marked failed with a fixed message and a code, and
  `POST /change-sets/:id/push` (`{ openPr? }`) retries exactly what is left. Repeating it when
  everything is done answers `alreadyDone`.
- **The push goes to the repository's own GitHub address**, `https://github.com/<owner>/<repo>.git`
  from the stored connection, with that connection's credential, never to a remote configured in
  the folder. A local-only repository has no GitHub connection: push and pull request are refused
  (`409 local_only`).

### State machine and data

```
approved --claim (applying, TTL 10 min)--> [commit ok] --> applied  (commit exists)
   ^                                  \--> [nothing written] --> approved (+ error, retry later)
applied --publish claim (publish_claim_at, TTL 10 min)--> push --> pull request --> applied
```

- `applied` means the commit exists. `outcome_json` holds `{ mode, base: {branch, commit}, commit:
  {branch, sha, at}, requested: {push, openPr}, signature?: {status: 'signed', format}, push: {status, at?, code?, error?}, pr: {status,
  at?, url?, number?, code?, error?} }`. `push.status` is `not_requested | pushed | failed`;
  `pr.status` is `not_requested | opened | failed | skipped` (skipped: the push failed first). The
  older columns `branch`, `commit_sha`, `pr_url`, `pr_number` are kept in step for the existing
  screens and the list.
- The `applying` claim is the existing atomic one, so two applies cannot both commit. The push
  has its own claim, `publish_claim_at`, so two retries cannot push or open two pull requests; a
  second caller gets `409 publish_in_progress`. A claim older than its TTL can be taken over (a
  crashed process does not wedge the change set).
- A failure before the branch exists (`base_changed`, `branch_exists`, `no_changes`, a path rule,
  `signing_failed`) returns the change set to `approved` with the reason and writes nothing. After `update-ref`
  succeeded, the change set is `applied` whatever happens next.
- Migration 14 adds `change_sets.outcome_json` (TEXT) and `change_sets.publish_claim_at`
  (timestamp), in both dialects. A migration test runs 1 to 13 with data, then 14.

### Why plumbing, and not `git commit`

`git commit`, `switch`, `worktree add` or `stash` all read or write the working tree and the
index, and run the repository's hooks (`pre-commit`, `commit-msg`, `post-commit`, `post-checkout`),
filters (`clean`, `smudge`, `autocrlf`), signing (`commit.gpgsign` runs the repository's `gpg.program`) and
config-defined programs. Those are the things the read path took pains to keep out, and the person
may have uncommitted work in that working tree. So the commit is built from objects:

1. The folder is validated again (real path inside an allowed root, the `.git` rules), immediately
   before anything is written.
2. The base is `refs/heads/<base>`; the new branch must not exist.
3. Every changed file is compared with the base: the blob there must equal the change set's
   `before` text (absent for a new file). Anything else is `base_changed`, nothing is written. This
   is the same conflict check the GitHub apply makes against the live tree.
4. `hash-object -w --no-filters --stdin` writes each blob byte for byte (no line-ending
   conversion, no filter). A private index (`GIT_INDEX_FILE` in a new temporary folder) gets
   `read-tree <base>`, `update-index --index-info` and `write-tree`. `commit-tree` makes the commit
   (parent: the base; author and committer set explicitly; signed only with `MRM_GIT_SIGN`, see
   "Signing"). `update-ref
   refs/heads/<branch> <commit> <zero oid>` creates the branch and can only create it: if it appeared
   in the meantime the call fails and nothing is replaced.
5. Every git call carries the same hardening as the read path (`--no-pager`, `-c` overrides that
   empty `core.hooksPath` (so the `reference-transaction` hook that `update-ref` would run does not),
   `core.fsmonitor`, `core.sshCommand`, `credential.helper` and the like; an allowlisted
   environment; `GIT_CONFIG_GLOBAL=/dev/null`; `GIT_CONFIG_NOSYSTEM`; process group kill on
   timeout), plus write-time overrides (`commit.gpgSign=false`, `core.splitIndex=false`, sparse
   checkout off). Aliases cannot shadow built-in commands, so a configured `alias.update-ref` is
   never run.
6. Never run in the person's repository: `checkout`, `switch`, `reset`, `add`, `commit`, `merge`,
   `stash`, `clean`, `push`, `gc`. A test records every git subcommand of an apply and checks that
   list.

A failure before `update-ref` leaves only unreachable objects, which `git gc` removes.

### The push

`git push` run inside the person's clone would read its config (remotes, `url.<x>.insteadOf`,
credential helpers, `core.sshCommand`) and run its hooks (`pre-push`). So the push runs in
a **private, empty bare repository** made in a temporary folder for the one push, whose
`objects/info/alternates` names the clone's object folder (read only). Git finds the commit and its
history there, and reads no other file of the clone: its config, hooks and remotes are never
consulted.

- **The URL is explicit** and built from the stored owner and repository name. Only `https` is
  allowed (`GIT_ALLOW_PROTOCOL`), redirects are off.
- **The token** (from the repository's credential: a PAT, or a GitHub App installation token minted
  for this call) goes in the environment of the one process as `http.<url>.extraheader`
  (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`), scoped to that URL. It is not in argv, not in a file, not
  in a URL. This is how the clone path (phase 1) already sends it.
- **The refspec is exact:** `<commit>:refs/heads/<branch>`. No `+`, no delete, no tags, no
  `--all`, no `--mirror`; a branch that exists on the remote with other history is rejected by the
  remote (`push_rejected`), never forced. `--no-verify` and an empty template: no hook runs.
- **A timeout** (the request timeout, at most 60 seconds) kills the process group.
- **Output is never passed on.** What git printed is scrubbed (the token and its encodings,
  `Authorization:` lines, URL credentials, the folder paths), classified (`push_auth`,
  `push_declined`, `push_rejected`, `push_not_found`, `push_network`, `push_timeout`,
  `push_failed`) and replaced by a fixed message for the class.
- The pull request is opened by the GitHub connector (`openPullRequest`, the same call `propose`
  uses), from the pushed branch into the base branch the commit was made on.
- **Tested with a bare repository as the remote** (`file` protocol through a test-only seam), a
  clone whose config has `insteadOf`, hooks and a credential helper (none of it is used), a
  rejected non-fast-forward, an unreachable remote followed by a successful retry, a timeout, and an
  HTTP stub that receives the extraheader (the token arrives there and appears in no response,
  audit row, log line, git argument or stored outcome).

### Signing

Opt-in, added after the first version of this phase (which never signed). The request was that the
commits made here be signed; the constraint is the one this whole phase rests on: nothing in the
clone or in the user's git configuration may decide what code runs. So signing is configured by the
operator, in the server's environment, and applied to the plumbing `commit-tree` call only.

**Configuration** (validated at start, `config.ts`; a bad value stops the server with a message that
names the variable and never contains the key's path):

| Variable | Meaning |
| --- | --- |
| `MRM_GIT_SIGN` | `off` (default), `ssh` or `gpg`. Off or unset: nothing below is read. |
| `MRM_GIT_SIGNING_KEY` | `ssh`: absolute path of a private key file (not readable by group or others), or of the `.pub` of a key an `ssh-agent` holds. `gpg`: a key id or fingerprint (hex, 8 to 64 characters; a user name or e-mail address is refused). |
| `MRM_GIT_SIGNING_PROGRAM` | Absolute path of `ssh-keygen` or `gpg`. Unset: looked up in `PATH` **once at start** and pinned. |
| `MRM_GIT_GNUPGHOME` | `gpg` only, required: the keyring folder. The server does not use its user's home folder. |

**How.** `git -c gpg.format=ssh -c gpg.ssh.program=<pinned> -c user.signingkey=<key> commit-tree -S
...` for ssh; `-c gpg.format=openpgp -c gpg.program=<wrapper> -c gpg.openpgp.program=<wrapper> -c
user.signingkey=<id> commit-tree -S<id> ...` for gpg. `-c` settings come after the repository's
config in git's order, so a repository that sets `gpg.program`, `gpg.ssh.program`,
`gpg.openpgp.program`, `gpg.format`, `user.signingkey`, `gpg.ssh.defaultKeyCommand` or
`commit.gpgsign` changes nothing (tested with a recording program for the pinned one and a program
that leaves a marker for the repository's: only the first runs, and the signature is made by the
configured key). `git` cannot pass arguments to `gpg.program`, so for gpg it points at a two-line
script written into the private temporary folder of that apply, which runs the pinned `gpg --batch
--no-tty --pinentry-mode error`: gpg can never ask for a passphrase or open a pinentry window. The
environment of that one `git` call is the usual allowlist plus: `HOME`, `TMPDIR`, `TMP` and `TEMP`
pointing into a private folder that is deleted afterwards (git's signing buffer and ssh-keygen's
`.sig` live there, so even a killed run leaves nothing), `GNUPGHOME` (gpg) and `SSH_AUTH_SOCK` (ssh,
only when the key is a `.pub` and the server's own environment had one at start). Nothing else of
the server's environment reaches the program (a test plants `MRM_MASTER_KEY` and a socket and
checks the program does not see them).

**Failure.** If signing is on and fails (no key, key file unreadable or not a key, passphrase
protected and not unlocked in an agent, program missing or not startable, no signature produced,
no answer within 20 seconds), the apply fails **before `update-ref`**: no branch, the change set
returns to `approved` with `error` set, the answer is `502 signing_failed` (`504` for a timeout)
with a `reason` (`timeout`, `locked`, `key`, `program`, `failed`) and a fixed sentence per reason.
The process group is killed on timeout. The objects written by `hash-object` and `write-tree`
stay as unreachable objects, as for any other failure. **There is never a fallback to an unsigned
commit.** The text the signing program printed is classified and dropped: it can contain the key's
path, so it is not forwarded (a test checks the key path, the passphrase and the key text appear in
no response, audit row, change set or server log line). The key's **path** (never its content) is
necessarily in the command line of the `git` and `ssh-keygen` processes while they run, where another
local user can see it in the process list.

**What "signed" means here.** After `commit-tree` the server reads the commit object
(`git cat-file commit`) and checks that its header has a `gpgsig` block of the right format, before
the branch is created. That is all it checks: it **does not verify** the signature, because
verification needs the verifier's trust data (allowed signers for ssh, the keyring's trust for gpg).
The outcome records `signature: { status: "signed", format }`, the audit event `changeset.apply_local`
has `signed` and `signature`, and the UI says "Signed (ssh)", never "Verified". GitHub shows
"Verified" only if the public key is on the committer's account as a signing key (an SSH key must be
added with the type "Signing Key") and the commit's e-mail is a verified e-mail of that account:
`MRM_GIT_AUTHOR_EMAIL` should be set to such an address, because by default the committer is the
person who applied.

**What the UI may know.** `GET /repositories/local/config` returns `signing: { enabled, format? }`.
Never the key, its path, the program or the keyring folder. The start-up log says `signing: ssh`
(plus the public fingerprint when `ssh-keygen -l` can read it without a prompt) or `signing: gpg`.
The push is unchanged: it pushes the commit that was signed, byte for byte.

**New places where code runs, all operator-configured.** git runs the signing program (`ssh-keygen`
or `gpg`, and for gpg the wrapper script) on every apply when signing is on. The program is the
operator's choice, pinned by an absolute path at start; it is not user-controlled and not
repository-controlled. A person with `changesets.approve` can cause it to run and to sign **with the
server's key**: they cannot choose the key, the message beyond the change set's summary and files,
or the identity beyond what `MRM_GIT_AUTHOR_*` and their own account give. In effect the server key
vouches for any change set an admin or owner applies. Use a key that is meant for that, not a
person's everyday key.

**Not built.** Signing with a key held in a file whose passphrase the server would be given (an
agent or an unprotected file only, by design: the server never stores or asks for a passphrase),
x509/smime signing, signing the GitHub API commits (below), verifying signatures, a key per
repository or per person, and rotating or reloading the key without a restart.

**Commits made through the GitHub API (`github_pr`).** That path is not changed by signing and does
not use this key. GitHub itself signs some commits made through its web interface and API; I am not
sure of the exact rules for commits created with a GitHub App or installation token (they may be
signed by GitHub in some cases and not in others), and nothing was checked here. Do not assume a
`github_pr` commit is signed or shows Verified; read the commit on GitHub.

### Threat model for writes

| Threat | Mitigation | Tested |
| --- | --- | --- |
| Writing into repositories nobody agreed to write to | `MRM_LOCAL_REPO_WRITE` off by default; `409 local_write_disabled` before the change set is claimed; the folder must be inside `MRM_LOCAL_REPO_ROOTS` | yes |
| A person without the right | `changesets.approve` for apply and push; viewers and members 403; non-members and other workspaces 404 | yes |
| Swapping the folder (symlink, other repository) after it was attached | the real path is validated again immediately before the write (and the read); a symlinked `.git` is refused | yes |
| Code execution through the repository (hooks, `core.fsmonitor`, filters, `gpg.program`, `core.sshCommand`, aliases, `reference-transaction`) | plumbing only; `-c` overrides; `core.hooksPath` emptied; allowlisted environment; the hostile repository in the tests runs none of its hooks or programs, with a control that plain git does | yes |
| Overwriting the person's work | working tree, index, HEAD and the checked out branch are never touched (snapshot before and after); the branch is created, never moved (`update-ref` with the zero oid) | yes |
| Committing over changes made after the draft | the base blob of every file must equal the change set's `before`: `base_changed`, nothing written | yes |
| Branch name as an option or a ref trick | ASCII letters, digits and `._-/` only, a letter, digit or `_` first, no `..`, `//`, `@{`, `/.`, `.lock`, not `HEAD` or `refs/...`, at most 200 characters; always used as `refs/heads/<name>` | yes |
| File paths that leave the repository or hit a symlink, a submodule or a file/folder clash | the same path rules as the GitHub connector; symlink, submodule and conflicting entries are refused (`unsupported_entry`, `path_conflict`) | yes |
| Line-ending or filter rewriting of the text | `hash-object --no-filters`; a CRLF text is committed as is | yes |
| A secret in the commit, the audit trail, a response or a log | the commit holds the files and a message from the summary; the message is neutralised (@mentions, `#1`) when the repository has a GitHub connection, as for a pull request body; the token never leaves the environment of the push process; output scrubbed | yes |
| Pushing somewhere else (a remote in the folder's config, `insteadOf`, `pushurl`) | explicit URL from the stored repository; the clone's config is never read; `GIT_ALLOW_PROTOCOL=https`; the push (not the commit) is refused with `409 remote_mismatch` unless the clone's `origin` names this very GitHub repository, so the folder is the one the person thinks it is; the origin is only compared, never used | yes |
| Force-pushing, deleting or touching other refs | exact refspec, no `+`; the remote rejects a branch with other history | yes |
| Two applies or two retries at once | the `applying` claim and `publish_claim_at`; one commit, one push, one pull request | yes |
| A hung git | a deadline checked before the ref is written; the process group is killed on timeout (git and push) | yes |
| Audit gaps | `changeset.apply_local` (folder path, branch, files changed, whether push and pull request were requested), `changeset.push`, `changeset.push_failed`, `changeset.pr_open`, `changeset.pr_failed`, `credential.use`; no content, no secret | yes |

Decisions:

- **Author and committer** are `MRM_GIT_AUTHOR_NAME` and `MRM_GIT_AUTHOR_EMAIL` when set, otherwise
  the person who applied (their display name and email). Cleaned to one line, no `<`, `>` or control
  characters, with a fixed fallback. Never read from the folder's git config.
- **Signing is opt-in** (`MRM_GIT_SIGN`, see "Signing"), with the server's key and a pinned program.
  Off, the commit is not signed whatever `commit.gpgsign` says, and a repository that requires signed
  commits will not merge it as is (the person can re-sign after `git switch`: `git commit --amend
  -S`). Running the person's or the repository's `gpg.program` from a server request is the kind of
  code execution this phase exists to avoid, and still never happens.
- **No hooks.** `pre-commit` and `commit-msg` do not run. Checks that depend on them (a linter, a
  length limit) should be in CI, where the pull request will meet them anyway.
- **Stricter branch names than git** (ASCII only), so that a name is never an option, a ref trick or
  a case-folding surprise.
- **The push is a separate, retryable step**, not a part of apply that can fail the whole apply: the
  commit is the thing the person asked for and it is kept.
- **`local_write_disabled` is a 409**, like `local_not_enabled`: the request is fine, the server's
  setting refuses it.

Accepted residuals, to be revisited:

- **Check, then use.** The folder is validated, then git opens it a moment later (the same gap as
  reading, narrowed by validating again right before the write). A person who can write inside a
  root can still race it. Keep roots to folders only the operator writes.
- **Trust inside a root.** `objects/info/alternates` or `commondir` of a repository in a root is
  followed by git (read path) and the new objects are written into that object store. Roots must
  not hold folders other people control.
- **LFS and attribute-driven filters are not applied.** The text is written byte for byte, so a
  path that `.gitattributes` sends to Git LFS is committed as the text, not as a pointer. Listing
  text files are not normally LFS-tracked; nothing checks.
- **Unreachable objects** remain after a failure before `update-ref` until the next `git gc`.
- **Signing runs an operator-configured program and uses the server's key** (see "Signing"): anyone
  with `changesets.approve` can have a commit signed by that key. A key that an agent holds is
  reachable by every process that can reach the agent's socket; with `SSH_AUTH_SOCK` passed on, that
  includes this server and the programs it starts. A key file is readable by the server user, and its path is visible in the process list while a
  commit is signed. The
  signature is checked for presence only, never verified. Unverified on macOS, with a real
  `gpg-agent`/`pinentry`, a hardware key, and in Docker.
- **A server credential pushes.** Anyone with `changesets.approve` can cause a push with the
  repository's stored credential to its own repository, only of a branch this tool just made, only
  with a new name. The audit trail names who and what.
- **Shallow clones, case-insensitive file systems, Windows** are not exercised (below).

### What is not built (writing)

- Checking out the new branch or switching to it for the person (they run `git switch`), merging,
  rebasing, signing with anything but the server's own pinned key, running hooks, pushing to a remote other than the repository's GitHub address,
  force-push, deleting the branch, a patch file as an alternative, writing the first commit into an
  empty repository (a base is required), writing to a local clone of a repository that is not in the
  allowed roots, and applying to a branch other than the one the clone is read from.

## Fixing up a branch (phase 4b)

A change set whose branch exists (applied, or failed after the branch was made) cannot be refreshed
(`409 branch_created`), because the branch holds the old text. `POST /change-sets/:id/fixup` adds
**one new commit on top of the branch** instead. It never rewrites history, never forces a push and
never moves a ref backwards. Rights: `changesets.approve`, like apply; there is no second approval
(the person who fixes up is the approver). The change set keeps its status (`applied` or `failed`);
a failed GitHub set whose pull request exists, or was opened by the fix up, becomes `applied`.

### Flow

1. **Stage 1, against the repository** (the refresh merge): base = the stored `before`, ours = the
   stored `after`, theirs = the repository now. The result is the desired text **D**. Conflicts are
   `409 refresh_conflicts`, settled with `resolutions`. A file that leaves the set (the repository has
   it now) is reset on the branch to the repository text.
2. **Stage 2, against the branch**: base **A** = the last committed text (the stored `after`, which a
   fix up keeps equal to what the branch holds), ours = D, theirs = the branch tip text **T**. `T == D`:
   keep. `D == A`: nothing new is wanted, edits made on the branch stay. `T == A`: write D. Otherwise a
   three-way merge; a conflict is `409 fixup_conflicts`, settled with `branchResolutions` (`mine`
   overwrites the branch text in the new commit, `theirs` keeps the branch's). Using the original
   `before` as the base would conflict with our own earlier commit on every correction; that is why A
   is the last committed text.
3. The delta of the changed paths only. An empty delta is `200 nothingToFix` (no commit, no audit
   row, no write): the same delta twice is idempotent.
4. One commit, parent = the current tip. **Local mode**: the plumbing of `createBranchCommit`
   (`hash-object --no-filters`, a private index read from the tip, `write-tree`, `commit-tree`, the same
   hardened environment, no hooks, the same server-pinned signing) and then
   `update-ref -m <msg> refs/heads/<b> <new> <old-tip>`: the old value is supplied, so the update
   succeeds only from the tip that was read (`409 branch_moved` otherwise, nothing is changed). The
   branch is refused when it is checked out in the clone or in a linked worktree, or a rebase of it is
   in progress (`409 branch_checked_out`), checked again right before the ref moves. The working tree,
   index, HEAD, config and every other ref stay as they were; the `MRM_LOCAL_REPO_WRITE` gate, the path
   re-validation and the folder roots apply as for apply. **GitHub mode**: `commitOnBranch` creates
   blobs, a tree on the tip's tree and a commit with the tip as its only parent, then
   `PATCH git/refs/heads/<b>` with `force: false`. A non-fast-forward answer is `409 branch_moved`, a
   missing branch `409 branch_missing`, a merged or closed pull request `409 pr_closed` (checked
   before writing). The default branch is refused (`default_branch`) before anything is written.
5. Optional (local mode only; `push`, `openPr`): a non-force push of the new tip (`409 remote_diverged`
   when the remote has other commits; the commit stays local and is recorded with `pushed: false`) and
   the pull request, opened with the existing `openPullRequest` when there is none. GitHub mode updates
   the pull request by moving its branch; `push`/`openPr` there are `422`.
6. Records: `outcome_json.fixups[] = { at, commit, parent, files, pushed, signature? }`;
   `commit_sha` and `outcome.commit` mean "the latest commit"; `outcome.base` is unchanged. A GitHub
   set stores `{ mode: 'github_pr', fixups }`. After the commit the stored `after` of each file is what
   the branch holds, and a file whose final text equals the repository's leaves the set. Where a local
   fix up commit exists and the earlier push was `pushed`, `push.status` becomes `behind` until pushed.

### State machine

`applied | failed(with branch)` -- fixup --> same status (a failed GitHub set with a pull request
becomes `applied`). Claim: `publish_claim_at` (TTL 10 minutes) is taken for both statuses
(`409 fixup_in_progress`), shared with the push step, released at the end; a dry run takes none.
The final write is guarded by `status = ?` (`409 changed_meanwhile`). Audit: `changeset.fixup`,
`changeset.fixup_failed` and `changeset.pr_open` with counts and commit ids, never text or paths of
file content.

### Recompute

`POST /change-sets/:id/recompute` (see [the listing API](../api/listing.md)) makes a store pull again
from the live store listing. For a set with a branch, `POST /change-sets/:id/fixup` with
`{ "recompute": true }` plans the same pull and feeds the files to the fix up as the desired content.
The set's own recorded values (`listing_snapshots` rows of source `change_set` with its id) are left
out of the repository side of the drift history when it is recomputed: otherwise the fields it
committed would look "repo ahead" and be dropped. The origin (`change_sets.origin_json`, migration 17)
holds the request and per-field hashes, never text.

### Threat model

- **Ref integrity.** The only ref written is the named existing branch, by `update-ref` with the old
  oid, so a concurrent move (a person, a push, another fix up) fails instead of being overwritten.
  GitHub: `force: false`, a fast-forward only. A race between the check and the update is closed by
  the old-oid compare; a race with a checkout is narrowed by checking again right before the update.
- **No rewrite.** The new commit's parent is the tip that was read; nothing resets, rebases, amends or
  deletes. The default branch is never written.
- **People's work.** Edits on the branch are merged or shown as conflicts, never silently dropped;
  "keep mine" is an explicit choice per file.
- **Same hardening as apply.** Hardened git environment, no hooks or filters, UTF-8 text only (a
  non-text, symlink or submodule path on the branch is refused), path allowlist, signing only with the
  server key (a failing signer leaves the ref untouched), pushes through the private bare repository
  with the exact refspec and scrubbed output, secrets in no response, log or audit row.
- **Rights.** `changesets.approve` (owner, admin); recompute needs `changesets.write` and
  `listing.read` (and `apps.sync` for `refresh`). App-restricted tokens are refused on these routes.

### Accepted residuals

- A person can still check the branch out between the last check and `update-ref`; the window is
  milliseconds, and the working tree is then stale as after any `git branch -f`.
- Only UTF-8 text files are merged. A GitHub fix up that changes many files makes one API call per
  blob.
- For a recompute with a path new in the set, the base A is approximated by the repository text.
- Not run against live GitHub, with a real gpg-agent, or on other git versions' worktree output.

## Implemented (phase 2)

Steps 1 to 6 and 9 of the plan below are built, in `apps/server/src/services/clone-reads.ts`
(the adapter, the reader pool, the start-up check), `services/repositories.ts` (wiring),
`config.ts`, `index.ts`/`app.ts` (one optional `reads` dependency), the Dockerfile and the docs.
How it differs from or adds to the plan:

- **Default is `auto`**, not `api` first: the clone is used when git is present, and a request
  falls back to the API on `git_missing`, `not_managed` or any other unexpected clone failure
  (`GitCloneError` of kind `unexpected`, or an error that is not a `GithubError`). One source per
  request: after the first fall back every later read of that request uses the API, at the commit
  the clone had resolved. Errors the API would repeat (`auth`, `not_found`, rate limits, timeouts,
  `too_large`, `not_text`) are not retried through it, and an aborted request never falls back.
  The fall back is logged (with the redacted cause) and audited as `repository.read_fallback`
  (purpose, operation, kind, reason; no message). `clone` never falls back.
- **`withCloneReads(api, reader, options)`** is a `Proxy` over the API connector: the four read
  methods are the reader's, anything else (`propose`, `dispatchWorkflow`, `listWorkflowRuns`, a
  method a later feature adds) is the connector's, bound to it. `ConnectorFactory` and the test
  fakes are unchanged. It adds `refresh`, `warm`, `useSignal` and a `reads` report.
- **Which requests switch** is a whitelist of purposes (`CLONE_READ_PURPOSES`: `repository.scan`,
  `repository.listing`, `changeset.create`). Connect, apply and any purpose a later feature adds get
  the plain API connector.
- **Readers are pooled** per repository (`createCloneReads`, at most 64), because the freshness
  window (`ttlMs`) lives in the reader's memory. The token is swapped in on every request.
- **Token:** the PAT for `github_token`; for `github_app` the new public
  `GithubRepoConnector.installationToken(signal?)`, passed as the function form of `token`. If a
  connector has no such method, the clone cannot be used for that credential (fall back in `auto`).
- **Scan** calls `refresh()` first; **a listing of folders chosen by hand** calls `warm()` with the
  text files under them (detected folders are in the reader's default warm set). The request's
  `AbortSignal` (the 90 s timeout) is passed to every reader call and kills git (tested).
- **Start-up** (`setUpReads`, not in `api` mode): creates the clone folder with mode 0700 and runs
  `git --version` once, logging one line. `auto` without git behaves as `api`; `clone` without git
  fails each read with an error naming git.
- **Disconnect** removes the clone after the transaction commits; a failure is logged and ignored.
  There is no workspace deletion in the server yet, so `removeWorkspaceClones` is available
  (`CloneReads.removeWorkspace`) but not called.
- **Not built here:** step 8 was done later as "Local clones" (above), `MRM_CLONE_FILTER` (the filter stays
  `blob:none` for GitHub). Idle pruning and the disk budget were built later (see above). `GitCloneError.reason` is not added to
  response messages.

### Why step 8 (a local checkout) was not built here

It looked small and is not. A repository row requires a credential, and connecting validates it
against the API, so "no GitHub token at all" needs a nullable `credential_id`, a connect flow
without a credential and an apply story (a local checkout cannot be applied to). Setting only a
`local_path` on a connected repository is smaller but needs a migration and both Drizzle schemas
(shared files edited concurrently by other work), `MRM_MODE` plumbed into `RepoContext`, a route in
`routes/repositories.ts`, realpath, directory and git repository validation, an audit event and a
role check, with the hosted-mode refusal tested. The reader already has the `local` source and
`createCloneReads` takes a `source` hook, so the remaining work is the settings and the UI. Do it
as its own change after deciding whether a local checkout may replace the credential.

## Integration plan (original, kept for reference)

Read the current code: `apps/server/src/services/repositories.ts` (`RepoClient`,
`ConnectorFactory`, `defaultConnectorFactory`, `RepoContext`, `openConnector`/`openFor`,
`scanRepository`, `readRepositoryListing`, `getRepositoryListing`, `disconnectRepository`),
`change-sets.ts` (`createChangeSet`, `applyChangeSet`), `repo-snapshot.ts` (`openRepoSnapshot`),
`config.ts`, `app.ts` (builds the `RepoContext`).

1. `config.ts`: new knobs (below); `Config` gets `reads`, `cloneDir` and the rest. `index.ts`
   creates the folder (mode 0700) and checks `git --version` unless `reads` is `api`.
2. `RepoContext` (repositories.ts) gets `reads: { mode, cloneDir, ttlMs, gitPath, filter }`. Add
   a small adapter in the server, `withCloneReads(api: RepoClient, reader): RepoClient`, that
   returns an object with `listFiles`, `readFile`, `resolveCommit` and `defaultBranch` of the
   reader and everything else (`propose`, `dispatchWorkflow`, `listWorkflowRuns`) of the API
   connector. `ConnectorFactory` and its fakes in tests are unchanged.
3. `openConnector()` (called by `openFor` and `openConnectorForRepository`) builds the API connector as
   today, then, when `reads` is `clone` (or `auto` and git is present), creates the
   `GitCloneReader` for `{ workspaceId, repository.id, owner, repo, token, defaultBranch }`. The token:
   for `github_token` the secret; for `github_app` a new small public method on
   `GithubRepoConnector` (`installationToken(signal)`) passed as the function form of `token`.
   The secret is still decrypted per request and audited (`credential.use`).
4. Functions that read, and so switch with no further change because they go through
   `openRepoSnapshot` (which calls `resolveCommit`, `listFiles`, `readFile`):
   `scanRepository` (call `reader.refresh(defaultBranch, { signal })` first so a scan a person
   asked for sees the newest commit), `readRepositoryListing` (used by `getRepositoryListing` and
   `createChangeSet`; TTL freshness, and `reader.warm(...)` with the listing paths from
   `listingFilePaths` when the chosen roots are outside the default warm set). Pass the request's
   `AbortSignal` (`controller.signal` from `withTimeout`) to the reader so a timeout kills git.
5. Functions that do not switch: `connectRepository` (it validates the credential and the
   repository against the API and stores the default branch), `applyChangeSet` (`connector.propose`:
   conflict check against the live tree, branch, commit, pull request), credential tests
   (`verify-github.ts`). After a successful apply the next read refreshes by TTL; calling
   `reader.refresh()` is optional.
6. `disconnectRepository`: after the transaction commits, `removeClone(cloneDir, workspaceId,
   repositoryId)`; a failure is logged and ignored (the folder is a cache). Same for workspace
   deletion with `removeWorkspaceClones`.
7. Errors: `githubFailure()` already maps `GithubError` kinds. Add `GitCloneError.reason` values to
   its messages only if wanted (`git_missing` should read as a server problem, 502).
   `MRM_READS=auto` falls back to the API for the request on `git_missing`, `not_managed` or an
   `unexpected` clone failure, and says so in the audit detail; `clone` does not fall back.
8. Single-user: migration for `repositories.local_path`, a route to set it (single-user mode
   only, admin), and the `local` source in the adapter when it is set.
9. Tests: server tests with a local source repository (as in `git-clone.test.ts`) through a
   `ConnectorFactory` that returns the adapter; keep the existing fake-connector tests for the API
   path. Update docs: `deployment.md` (git, `MRM_CLONE_DIR`, disk), `architecture.md`, and the
   Dockerfile.

## Config knobs (proposed)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MRM_READS` | `auto` (built) | `api`, `clone`, or `auto` (clone when git is installed, API otherwise and on clone failure) |
| `MRM_CLONE_DIR` | `<MRM_DATA_DIR>/clones` | where clones live |
| `MRM_CLONE_TTL_SECONDS` | `60` | how long a fetched tip is reused (`ttlMs`) |
| `MRM_CLONE_FILTER` | `blob:none` | partial clone filter; `none` downloads all blobs (not built) |
| `MRM_GIT_PATH` | `git` | the git program |
| `MRM_LOCAL_REPO_WRITE` | `false` | allow a change set to be committed to a new branch of a local clone, and pushed (phase 4, built) |
| `MRM_GIT_AUTHOR_NAME`, `MRM_GIT_AUTHOR_EMAIL` | unset | author and committer of those commits; unset means the person who applied (built) |
| `MRM_CLONE_MAX_BYTES`, `MRM_CLONE_IDLE_DAYS`, `MRM_CLONE_SWEEP_INTERVAL_MINUTES` | `2g`, `30`, `360` | disk budget, idle pruning and how often the sweep runs (built; `0` turns each off) |

## Alternatives considered

- Keep the API and batch it: GraphQL can read many files in one request, but it is still one
  request per ref and size-limited, and costs rate-limit points per node.
- The tarball endpoint (`GET /repos/{owner}/{repo}/tarball/{ref}`): one request, the whole
  repository every time, no incremental update, and the archive must be unpacked (or streamed) by
  our code.
- A full clone with a checkout: simplest, and unsafe for the reasons above, plus much more disk.
- A JavaScript git library (isomorphic-git): a new dependency in a security-sensitive path.

## What is verified, and what is not

Verified here (git 2.34.1, Linux, Node 22, local repositories and a stub HTTP server): everything in
`git-clone.test.ts`, including partial and shallow behaviour, the blob batch, abort and timeout
(the process group is killed), the hostile-content cases and the token checks.

Verified in phase 2 (server tests, local git repositories as the source, no network): scan and
listing for the three fastlane layouts in `fastlane.fixtures.ts` give the same results from a clone
as from the API fake, including the monorepo targets; change set creation reads from the clone and
apply goes through the API connector; the by-commit cache keeps one `ls-tree` per commit; `auto`
falls back with a bad `MRM_GIT_PATH`, `api` never runs git, `clone` surfaces the error; a token
printed by git reaches no response, audit row or log line; the request timeout kills git; disconnect
removes the clone; the token wiring for both credential kinds (with a stand-in reader).

Not verified: real GitHub over https (the `extraheader` with an installation token or PAT, a
fetch by blob id and by commit sha, the `--filter` support, rate-limit and 403 bodies, redirects
for a renamed repository); the App installation token flow (`installationToken` is unit tested against the connector's fake,
never against GitHub); the Docker image with git installed (never built); GitHub Enterprise Server; git newer
than 2.34; local clones (phase 3) on macOS, with a real repository, with a real dubious-ownership
case, with Postgres, and in a browser (the web screens compile and are type checked, and their
logic is unit tested, but were never run); macOS and Windows (`detached` process groups, `/dev/null` as `GIT_CONFIG_GLOBAL`, path
and `file://` forms); behaviour on a very large repository; a read-only or `noexec` data folder.
No timing against GitHub exists: the benchmark compares local reads with simulated latency only.

Verified in phase 4 (server and connector tests; real git 2.34.1 repositories, a bare repository as
the push remote over the `file` protocol, an HTTP stub for the header; no network):
- the commit: tree, parent, author and message; `update-ref` creates only; working tree, index,
  HEAD, checked out branch and the folder's config are byte-identical before and after; the list of
  git subcommands run is exactly the plumbing set; hooks (`pre-commit`, `post-commit`,
  `reference-transaction`, `pre-push`), `core.fsmonitor`, `core.sshCommand`, `credential.helper`,
  `commit.gpgsign` with a `gpg.program`, and an `alias.update-ref` in a hostile repository run
  nothing; `base_changed`, `branch_exists`, symlink, submodule and path conflicts, deleted and new
  files, a CRLF text, the branch name table, the deadline, and the re-validation of the path;
- through the API, for the fastlane layouts (one app, a monorepo with `auto:app:<id>`, android only)
  and Expo `store.config.json`: the commit holds exactly the change set's files with its texts;
  roles, workspace isolation, `local_write_disabled`, `local_only`, the audit rows, concurrency (one
  commit from many applies);
- the push: bare remote, the clone's `insteadOf`, hooks and credential helper unused, a rejected
  non-fast-forward, an unreachable remote then a successful retry, the timeout, the token header
  at the stub and nowhere else, the classification and the scrubbing; the pull request step and its
  retry through the fake connector, and `openPullRequest` against the GitHub connector's fake HTTP
  layer;
- migration 14 with data, schema drift (SQLite and Postgres definitions agree), the OpenAPI
  registry, and the web logic (the choices, their reasons, the body, the steps, the retries, the
  default branch name equal to the server's) as unit tests.

Verified for signing (git 2.34.1, OpenSSH 8.9, GnuPG 2.2.27 on Linux; throw-away keys in temp
folders; the key generation for gpg is batch mode and the test skips with a message where it cannot
run): an ssh-signed commit holds a `gpgsig` block and `git verify-commit` accepts it with an
allowed-signers file given in the test, and rejects it for another key; the same for gpg (the
signer's fingerprint is the configured one); a `.pub` key with a passphrase-protected private key
signs through a real `ssh-agent`, and fails with `locked` without it; a passphrase-protected gpg key
without a cached passphrase, an unknown key id, a garbage key file, a missing key file, a missing
program, a program that writes no signature and a program that never answers (killed, no process
left) all fail with `signing_failed`, leave refs, working tree, index and HEAD untouched and leave
no temporary file; a hostile repository config (`gpg.program`, `gpg.ssh.program`,
`gpg.openpgp.program`, `gpg.format`, `user.signingkey`, `gpg.ssh.defaultKeyCommand`) changes neither
the program nor the key; with signing off a repository that asks for signing gets an unsigned commit
and no program runs; the key path and key text appear in no response, audit row, change set or log
line; configuration validation (a table of good and bad values); the API: signed apply with
push (the pushed commit is the signed one), the audit fields, the config endpoint's `signing`, a
failed signing answering 502/504 with the change set back to `approved`; the web logic.

Not verified for signing: macOS (Keychain-backed agents, `pinentry-mac` and its prompts, the
`/usr/bin/ssh-keygen` there, FIDO or hardware keys, a different default `PATH`), a real `gpg-agent`
with a long-lived cached passphrase and `pinentry` configured by the operator, gpg older than 2.1
(`--pinentry-mode` needs 2.1), git older than 2.34 (ssh signing; the server warns at start),
Docker and docker-compose (the image does not contain `ssh-keygen` or `gpg`; a key and the agent
socket must be mounted, and a `noexec` temporary folder would stop the gpg wrapper), whether GitHub
shows "Verified" for such a commit, and signing from a server running under another user than the
key's owner beyond the file-permission check.

Not verified in phase 4: a push to real GitHub (https, the extraheader with a real PAT or an
installation token, protected branches, a push from a shallow clone, rate limits), a real pull
request; macOS, Windows, a case-insensitive file system (two branch names differing only by case);
a real GPG signing setup (the test proves `gpg.program` is not run, not that a signing repository
behaves); real hook scripts beyond the test ones; Git LFS repositories; Postgres (the migration is
written for it and drift-tested, but the Postgres run is skipped without `MRM_TEST_POSTGRES_URL`);
the web screens in a browser (they type check, compile without warnings and their logic is unit
tested); a very large change set.
