# Deployment notes

Short notes on running the hosted server (`docker compose up`). They do not replace your own
hardening; they say what the defaults are.

## Network exposure and TLS

- The server speaks **plain HTTP** on port 8787. It does not terminate TLS.
- `docker-compose.yml` publishes 8787 on **127.0.0.1 by default** (`MRM_BIND`). Set
  `MRM_BIND=0.0.0.0` to publish it on every interface. Doing so exposes plain HTTP to that
  network: sign-in passwords and session cookies would cross it unencrypted.
- Put a **TLS-terminating reverse proxy** in front (Caddy, nginx, Traefik, a cloud load balancer)
  and send `X-Forwarded-Proto: https` with each request. The session cookie is marked `Secure`
  only when the request arrived over HTTPS, which the server learns from that header. Without it,
  behind a TLS proxy the cookie goes out without `Secure`.
- The proxy should also set HSTS. The server does not send `Strict-Transport-Security` itself.
- The proxy must pass the original `Host` (or set `X-Forwarded-Host`) so the same-origin check on
  writes sees the address people use in their browser.

## Client addresses and rate limits

Sign-in is rate limited per email address and, more loosely, per client address. The client
address is the socket address by default. Behind a reverse proxy every request would then come
from the proxy, so set `MRM_TRUST_PROXY=1`: the address becomes the last `X-Forwarded-For` entry.
Only do that when exactly one proxy you control sits in front and appends the address it saw;
otherwise anyone can pick their own address with a header. The limits are in memory and per
process.

## Request limits and headers

Request bodies are capped (1 MB; 256 KB on sign-in, setup and invitation routes) and answered
with `413 {"error":"payload_too_large"}`. Every response carries a Content-Security-Policy
(`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a
Referrer-Policy. The policy only allows the web UI's own scripts, styles, images (including
`data:`) and API calls; if you serve extra assets from elsewhere, change `SECURE_HEADERS` in
`apps/server/src/app.ts`.

## Container

The image runs as the unprivileged `node` user. The only writable path is `/data`
(`MRM_DATA_DIR`). The image still contains the development dependencies that the web build needs.

## Reading repositories: git and local clones

Scans, listings and change set creation read the repository from a local clone instead of one
GitHub API call per file (design and limits: [ADR 0005](adr/0005-local-clone-reads.md)). Applying a
change set (branch, commit, pull request) and connecting a repository still use the GitHub API.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MRM_READS` | `auto` | `auto`: clone, and the GitHub API for a request when the clone cannot be used. `clone`: clone only, errors are shown. `api`: API only, git is never run. |
| `MRM_CLONE_DIR` | `<MRM_DATA_DIR>/clones` | Where clones live. Created with mode 0700 at start. |
| `MRM_CLONE_TTL_SECONDS` | `60` | How long a fetched branch tip is reused. A scan always fetches. |
| `MRM_GIT_PATH` | `git` | The git program. |
| `MRM_LOCAL_REPO_ROOTS` | unset (off) | Folders that may hold local clones, absolute paths separated by `:` (`;` on Windows). See "Local clones" below. |
| `MRM_LOCAL_REPO_WRITE` | `false` | `true` allows applying a change set as a commit on a new branch of a local clone, and pushing it. See "Writing to a local clone" below. |
| `MRM_GIT_AUTHOR_NAME`, `MRM_GIT_AUTHOR_EMAIL` | unset | Author and committer of those commits; unset means the person who applied. |

- **git 2.34 or newer** must be on the server. The Docker image installs it (Debian 12 ships 2.39).
  At start, unless `MRM_READS=api`, the server runs `git --version` once and logs one line. If git is
  missing, `auto` reads through the API (the log line says so) and `clone` fails every read with an
  error that names git.
- **Fall back (`auto`).** When git is missing, a clone is not managed by us, or git fails in a way
  we did not expect, that one request is read through the API instead. It is written to the server
  log (`Reads: repository.scan of repository ... used the GitHub API instead of the clone`) and to
  the audit log as `repository.read_fallback` (purpose, operation, error kind and reason, never a
  message). Errors the API would repeat (bad credentials, a missing branch, a rate limit, a timeout)
  are not retried through the API.
- **Disk.** A clone holds the trees and the commit of the default branch plus the files that were
  read (shallow and partial: for a 4,000 file repository measured at about 0.1 to 0.3 MiB). It is a
  cache. Disconnecting a repository deletes its clone; you can delete the folder at any time and it
  is made again on demand. Old objects stay until the clone is compacted, so watch the volume.
  Idle pruning and a disk budget are proposed, not built.
- **Docker.** `/data/clones` is under the `/data` volume and owned by the unprivileged `node` user.
  The image was not built in this change's environment: `docker compose build` is the first real test.
- **Network.** git talks to `github.com` over https with the credential's token (a personal access
  token, or a GitHub App installation token) in an HTTP header that only the git process sees. If
  the server needs a proxy, `HTTPS_PROXY`, `NO_PROXY` and CA variables (`SSL_CERT_FILE`) are passed
  to git. GitHub Enterprise Server is not wired up.
- **Not verified against real GitHub yet** (HTTPS fetch with a PAT or installation token, fetch by
  commit id): keep `MRM_READS=api` if you need the proven path.


## Local clones: read a folder on the server

A repository can be read from a git clone that already exists on the machine the server runs on
(for example `/Volumes/dev/nativescript/oss-weather`), instead of from GitHub. Two uses:

- **Attach** a folder to a repository that is connected to GitHub. Scans, listings and change set
  creation read the folder; applying a change set opens a pull request on GitHub with the stored
  credential (the default), or commits it to a new branch of the folder (opt-in, below).
- **Connect as a local-only repository**: no credential, no `owner/repo`. Reads come from the
  folder. A change set is applied as a commit on a new branch of the folder (opt-in, below); a pull
  request needs GitHub, so `github_pr` is refused with `409 local_only`. See
  [ADR 0005](adr/0005-local-clone-reads.md).

The feature is **off unless `MRM_LOCAL_REPO_ROOTS` is set**, in every mode (hosted, and
`single_user` too):

    MRM_LOCAL_REPO_ROOTS=/Volumes/dev                # one folder
    MRM_LOCAL_REPO_ROOTS=/Volumes/dev:/Users/me/src  # several, separated by ':'

Each entry must be an absolute path with no `..` and no control characters, and `/` itself is
refused. At most 20 entries. A bad value stops the server at start with a message naming the
entry. With nothing set, the web app shows "Local clones are not enabled: set
`MRM_LOCAL_REPO_ROOTS=/Volumes/dev`"; with it set, the Connect dialog lists the roots. It does
nothing with `MRM_READS=api` (git is never run in that mode) and needs git on the server.

**What a folder must be, checked when it is attached and again before every read:**

- Its real path (symbolic links resolved) is inside one of the roots, and it is a directory.
- It has a `.git` directory with a `HEAD`, or a `.git` file (a worktree) whose git directory is also
  inside a root. A symlinked `.git` and a bare repository are refused.
- It is not the server's own data or clone folder (`MRM_DATA_DIR`, `MRM_CLONE_DIR`) and holds no
  `mrm-clone.json`.
- The person has the right `repositories.write` (admin or owner). Members and viewers can see which
  repository reads from a folder, but cannot check, attach, change or detach one.

**What is read.** Only what is committed: the tip of one chosen branch (the folder's own checkout is
not changed, and nothing is checked out). Uncommitted and untracked files are never read. The web
app says so ("Reads commit abc1234 on branch main; 3 uncommitted changes are not included"); the
count comes from a read-only `git status`.

**How git is run in your folder.** The repository is untrusted input even when it is yours. git
runs with hooks, `fsmonitor`, external diff, credential helpers, askpass and `ssh` commands switched
off on the command line, with `filter.*` drivers emptied for `status`, with global and system
config ignored, an allowlisted environment, optional locks off (so `git status` does not write the
index), lazy fetching and all network transports blocked, and a timeout. Reading goes through the
same hardened reader as GitHub clones, over a managed copy in `MRM_CLONE_DIR`. The origin URL is
shown as host, owner and name only; credentials in a URL are never returned or logged.

**Ownership.** Newer git refuses a repository owned by another user ("dubious ownership"). The
server does not set `safe.directory`, because that would let it read any folder. The error says to
run the server as the folder's owner or to change the owner. Run the server as the user who owns
your clones (on a Mac, your own account).

**Audit.** `repository.local_check`, `repository.local_connect`, `repository.local_attach`,
`repository.local_change` and `repository.local_detach` record the actor, the path and the branch,
never any file content. A scan says `reads: "local"`.

**Limits to know.** The path is checked and then opened by git a moment later, so a person with
write access to a root could swap a folder in between; keep roots to folders only you can write.
Files inside the roots are trusted as paths (a repository's `.git/objects/info/alternates` is
followed by git). Do not put a root over a folder that other people can write to.

### Writing to a local clone

Applying an approved change set can also **commit it to a new branch of the local clone**, with an
optional push of that branch to GitHub and an optional pull request. It is **off unless
`MRM_LOCAL_REPO_WRITE=true`**, and it needs `MRM_LOCAL_REPO_ROOTS` to name the folder. Without it,
`POST /change-sets/:id/apply` with `mode: "local_branch"` answers `409 local_write_disabled`, the web
app shows the option disabled with the reason, and nothing is written to any folder.

    MRM_LOCAL_REPO_WRITE=true
    MRM_GIT_AUTHOR_NAME="Release Bot"          # optional
    MRM_GIT_AUTHOR_EMAIL=release-bot@example.com   # optional

| Variable | Default | Meaning |
| --- | --- | --- |
| `MRM_LOCAL_REPO_WRITE` | `false` | `true` allows a commit on a new branch of a local clone, and its push. Anything other than `true` or `false` stops the server at start. |
| `MRM_GIT_AUTHOR_NAME`, `MRM_GIT_AUTHOR_EMAIL` | unset | Author and committer of those commits. Unset means the name and email of the person who applied. One line, no `<` or `>`; the email must look like `name@example.com`. |

What you are allowing:

- **A new branch and one commit, nothing else.** The commit is made from git objects: the folder's
  checked out branch, working files, index and `HEAD` are never touched, no hook runs, nothing is
  signed (the commit is unsigned whatever `commit.gpgsign` says) and no filter or line-ending
  conversion is applied. The branch must not exist (it is never moved or overwritten), and every file
  must still match what the change set was drafted from (otherwise `base_changed`, nothing written).
  Look at it later with `git switch <branch>`; delete it with `git branch -D <branch>`.
- **Who:** the same right as apply (admin or owner). A viewer, a member, or a non-member cannot.
- **The push** (only when asked for, and only for a repository connected to GitHub) uses the
  repository's stored credential, to `https://github.com/<owner>/<repo>.git`, for that one branch name
  and that one commit, never forced. It does not use the folder's own remotes, git config, credential
  helpers or hooks: it runs from a private temporary repository that reads the clone's objects only.
  The clone's `origin` must name that same GitHub repository (`409 remote_mismatch` otherwise). A
  failed push keeps the commit and can be retried from the change set. The token is never in a URL,
  an argument, a file, the audit log or a response.
- **Permissions on the folder.** The server process needs write access to the folder's `.git`
  (objects and `refs/heads`). If the server runs as another user than the folder's owner, git refuses
  ("dubious ownership") as it does for reading.
- **Audit.** `changeset.apply_local` (folder path, branch, commit, number of files, whether a push
  and a pull request were asked for), `changeset.push`, `changeset.push_failed`, `changeset.pr_open`,
  `changeset.pr_failed`. No file content, no secret.
- **Limits to know.** The folder is validated again right before the write, but the gap between
  checking and writing remains for anyone who can write inside a root. Git LFS and
  `.gitattributes` filters are not applied to the files. Not run on macOS or Windows, and not
  against real GitHub: see the verified list in [ADR 0005](adr/0005-local-clone-reads.md).


## Tokens, event streams and webhooks

- **API tokens** work with a `Authorization: Bearer` header and are rate limited per token (300 a
  minute) in memory. Do not log request headers at the proxy. Revoke a token in the web app.
- **The event stream** (`/api/workspaces/<id>/events/stream`) is a long-lived response. The proxy
  must not buffer it or cut idle connections within 15 seconds (the server sends a heartbeat comment
  every 15 seconds and `X-Accel-Buffering: no`). For nginx add `proxy_read_timeout 1h;` for that
  path. Each person may hold 5 streams. Never tested through a real proxy.
- **Webhooks** make requests from the server. They go to public https addresses only, so a webhook
  cannot be pointed at your internal network. `MRM_WEBHOOKS_ALLOW_PRIVATE=1` lifts that for
  development; leave it off on a shared host. Allow outbound https from the server to the receivers.
  See [webhooks](api/webhooks.md).
