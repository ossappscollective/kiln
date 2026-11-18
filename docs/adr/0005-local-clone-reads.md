# ADR 0005: Read repositories from a local clone

Status: proposed. It stays proposed until the clone path has run against real GitHub (see "What is
verified, and what is not"). Phase 1 is `GitCloneReader` in `packages/connectors/src/git-clone.ts`
(41 tests, no network). Phase 2, the server integration, is implemented and tested with local git
repositories (see "Implemented" below). Nothing was measured against GitHub itself.

## Context

Every scan, listing read and change set creation reads the repository through the GitHub REST API:
one call for the ref, one for the tree, then one call per file (`readFile`), a few at a time. That
is slow (a round trip per file), counts against the rate limit, and a large listing (60 locales
with 6 files each) is hundreds of requests. The request that started this ADR: "could we use a
local clone of the github repo? all that would be much faster".

Writes are different and stay as they are: the connector applies a change set as a branch, blobs,
tree, commit and a pull request through the API, with a conflict check against the live tree
([api/repositories.md](../api/repositories.md)). Nothing here changes that.

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
- Proposed, not built: touch the marker on use and prune clones idle for `MRM_CLONE_IDLE_DAYS`
  (default 30) at start and daily; a total budget `MRM_CLONE_MAX_MB` that evicts least recently
  used clones; `compact()` after every 50 refreshes.
- A first clone of a large repository is bounded by `fetchTimeoutMs` (120 s) and the server's
  request timeout (90 s), which cancels the fetch. Moving scan to the job queue would remove that
  limit ([architecture.md](../architecture.md)).

## Docker and deployment

The image (`node:22-bookworm-slim`) has no `git`. The Dockerfile now runs
`apt-get install -y --no-install-recommends git ca-certificates` (root, before `USER node`, apt
lists removed) and creates `/data/clones` (mode 0700, owned by `node`; `MRM_CLONE_DIR=/data/clones`).
**The image has not been built**: no Docker was available. The clone folder is under `/data`, which
is the volume the container already writes to. Needed: git 2.34 or newer (tested with 2.34.1; `GIT_CONFIG_COUNT` needs 2.31, `GIT_CONFIG_GLOBAL`
2.32). Debian 12 ships a newer git (expected 2.39); behaviour on it is unverified. The server
checks `git --version` at start when `MRM_READS` is not `api`.

## Desktop single-user mode: "use my local checkout"

`source: { type: 'local', path }` clones from a path on the machine, over the `file` protocol,
without a filter (copying from disk is cheap; the user's checkout is rarely set up to filter). Only
commits are read, so the desktop UI should say "committed changes only". This lets a person read a
private repository with no GitHub token at all and no network.

It must be limited to `MRM_MODE=single_user`: in the hosted server a user-chosen path would let
anyone read any repository on the server. The path is chosen in the desktop shell (a folder
dialog), stored on the repository (`local_path`, a migration), resolved with `realpath` and checked
to be a directory. `file` is enabled only for that source and only for its fetch. git running
`upload-pack` on the source reads that repository's config, but ignores the settings that run
programs (`uploadpack.packObjectsHook` in the source's config did not run, checked on 2.34.1). Newer git refuses
a repository owned by another user (`safe.directory`); that is reported as `forbidden`.

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
- **Not built:** step 8 (desktop "use my checkout", below), `MRM_CLONE_FILTER` (the filter stays
  `blob:none` for GitHub), idle pruning and the disk budget. `GitCloneError.reason` is not added to
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
| `MRM_CLONE_MAX_MB`, `MRM_CLONE_IDLE_DAYS` | unset, `30` | disk budget and idle pruning (not built) |

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
than 2.34; macOS and Windows (`detached` process groups, `/dev/null` as `GIT_CONFIG_GLOBAL`, path
and `file://` forms); behaviour on a very large repository; a read-only or `noexec` data folder.
No timing against GitHub exists: the benchmark compares local reads with simulated latency only.
