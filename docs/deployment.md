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

| Variable                                      | Default                 | Meaning                                                                                                                                                               |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MRM_READS`                                   | `auto`                  | `auto`: clone, and the GitHub API for a request when the clone cannot be used. `clone`: clone only, errors are shown. `api`: API only, git is never run.              |
| `MRM_CLONE_DIR`                               | `<MRM_DATA_DIR>/clones` | Where clones live. Created with mode 0700 at start.                                                                                                                   |
| `MRM_CLONE_TTL_SECONDS`                       | `60`                    | How long a fetched branch tip is reused. A scan always fetches.                                                                                                       |
| `MRM_CLONE_MAX_BYTES`                         | `2g`                    | Disk budget for `MRM_CLONE_DIR`: `500m`, `2g`, `10 GiB` or plain bytes. When the folder is over it, the sweep removes the least recently used clones. `0` = no limit. |
| `MRM_CLONE_IDLE_DAYS`                         | `30`                    | The sweep removes clones not used for this many days. `0` = never.                                                                                                    |
| `MRM_CLONE_SWEEP_INTERVAL_MINUTES`            | `360`                   | How often the sweep runs (`0` = off, else 5 to 10080). Needs reads to use clones (`MRM_READS` other than `api`).                                                      |
| `MRM_GIT_PATH`                                | `git`                   | The git program.                                                                                                                                                      |
| `MRM_LOCAL_REPO_ROOTS`                        | unset (off)             | Folders that may hold local clones, absolute paths separated by `:` (`;` on Windows). See "Local clones" below.                                                       |
| `MRM_LOCAL_REPO_WRITE`                        | `false`                 | `true` allows applying a change set as a commit on a new branch of a local clone, and pushing it. See "Writing to a local clone" below.                               |
| `MRM_GIT_AUTHOR_NAME`, `MRM_GIT_AUTHOR_EMAIL` | unset                   | Author and committer of those commits; unset means the person who applied.                                                                                            |
| `MRM_GIT_SIGN`                                | `off`                   | `ssh` or `gpg` signs those commits with the server's own key. See "Signing the commits" below.                                                                        |

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
  is made again on demand. Old objects stay until the clone is removed. A scheduled sweep (see the
  three `MRM_CLONE_*` settings above) removes clones idle for `MRM_CLONE_IDLE_DAYS`, then the least
  recently used until the folder fits `MRM_CLONE_MAX_BYTES`; it never removes a clone that is being
  read, logs one line when it removed something, and an admin can free one clone from the repository
  page. The budget is checked at each sweep, so the folder can exceed it between sweeps.
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

| Variable                                      | Default | Meaning                                                                                                                                                                |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MRM_LOCAL_REPO_WRITE`                        | `false` | `true` allows a commit on a new branch of a local clone, and its push. Anything other than `true` or `false` stops the server at start.                                |
| `MRM_GIT_AUTHOR_NAME`, `MRM_GIT_AUTHOR_EMAIL` | unset   | Author and committer of those commits. Unset means the name and email of the person who applied. One line, no `<` or `>`; the email must look like `name@example.com`. |

What you are allowing:

- **A new branch and one commit, nothing else.** The commit is made from git objects: the folder's
  checked out branch, working files, index and `HEAD` are never touched, no hook runs, the commit is
  signed only if you turn on `MRM_GIT_SIGN` (below, whatever `commit.gpgsign` says) and no filter or
  line-ending conversion is applied. The branch must not exist (it is never moved or overwritten), and every file
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

### Signing the commits

Off by default: the commits are then unsigned, exactly as before. To have the server sign them, set
`MRM_GIT_SIGN` and a key. The signing setup is **only** what you put in the server's environment; the
clone's git config and the user's global config are ignored (a repository that sets `gpg.program` or
`user.signingkey` changes nothing).

| Variable                  | Meaning                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MRM_GIT_SIGN`            | `off` (default), `ssh` or `gpg`.                                                                                                                                                      |
| `MRM_GIT_SIGNING_KEY`     | `ssh`: absolute path of a private key file (mode `600`), or of the `.pub` of a key held by `ssh-agent`. `gpg`: the key id or fingerprint (hexadecimal; not a name or e-mail address). |
| `MRM_GIT_SIGNING_PROGRAM` | Optional. Absolute path of `ssh-keygen` or `gpg`. Unset: found in `PATH` once at start and kept.                                                                                      |
| `MRM_GIT_GNUPGHOME`       | `gpg` only, required: the keyring folder (usually `~/.gnupg` of the user who owns the key).                                                                                           |

A wrong value stops the server at start with a message that names the variable (never the key's
path). The start-up log says `signing: ssh` (with the key's public fingerprint when it can be read
without a prompt) or `signing: gpg`. If signing is on and fails when a change set is applied, nothing
is committed: the change set stays `approved` and the answer is `signing_failed`. It never falls
back to an unsigned commit. Needs git 2.34 or newer for ssh, GnuPG 2.1 or newer for gpg; not
available for gpg on Windows.

**Use a key meant for this.** Anyone who may apply change sets (admin, owner) can have the server
sign a commit with it. Prefer a dedicated key (and a dedicated committer address in
`MRM_GIT_AUTHOR_EMAIL`) over a person's everyday key. The server runs your signing program: it is the
one you configured (or found in `PATH` at start), never one named by a repository.

**ssh, with a key file.** The simplest setup, and the only one that does not depend on an agent:

    ssh-keygen -t ed25519 -N '' -C "mrm release bot" -f ~/.ssh/mrm_signing   # no passphrase
    chmod 600 ~/.ssh/mrm_signing
    MRM_GIT_SIGN=ssh
    MRM_GIT_SIGNING_KEY=/Users/you/.ssh/mrm_signing

The server cannot ask for a passphrase. A key file with a passphrase fails with `signing_failed`
(`reason: locked`) unless an agent holds it unlocked, which is the next setup.

**ssh, with a passphrase and `ssh-agent`.** Point `MRM_GIT_SIGNING_KEY` at the **`.pub`** file, load
the key into the agent (on macOS `ssh-add --apple-use-keychain ~/.ssh/mrm_signing`), and start the
server from an environment that has the agent's `SSH_AUTH_SOCK` (it is passed on to `ssh-keygen`,
for a `.pub` key only, and read once at start). From a terminal that is your normal shell; from
`launchd` or a service manager it usually is not, so set it explicitly. The agent must hold the
unlocked key at the time of the apply.

**gpg.** Make a key without a passphrase, or with one that `gpg-agent` has cached; the server runs
`gpg --batch --no-tty --pinentry-mode error`, so a passphrase that is not cached fails at once
instead of opening a `pinentry` window.

    gpg --quick-generate-key "MRM Release Bot <release-bot@example.com>" ed25519 sign never
    gpg --list-secret-keys --keyid-format long      # copy the 40-character fingerprint
    MRM_GIT_SIGN=gpg
    MRM_GIT_SIGNING_KEY=<fingerprint>
    MRM_GIT_GNUPGHOME=/Users/you/.gnupg

On macOS, GnuPG usually comes from Homebrew (`/opt/homebrew/bin/gpg`); if `PATH` of the server does
not include it, set `MRM_GIT_SIGNING_PROGRAM`.

**Show "Verified" on GitHub.** Add the **public** key to the GitHub account whose verified e-mail
address is the commit's committer address (`MRM_GIT_AUTHOR_EMAIL`, or the person who applied):
Settings, SSH and GPG keys; for an ssh key choose the type "Signing Key" (an authentication key is
not enough). The web app shows "Signed (ssh)" on the change set: that means the commit holds a
signature, not that anything has verified it.

**Docker.** The image includes `openssh-client` (`ssh-keygen`) and `gnupg` for this. In
`docker-compose.yml` the key must be mounted into
the container (read-only, readable by the `node` user, mode `600`, for example
`- ./secrets/mrm_signing:/run/secrets/mrm_signing:ro`) and `MRM_GIT_SIGNING_KEY` must name the path
**inside** the container; for an agent, mount its socket and set `SSH_AUTH_SOCK` for the service. A
`gpg` setup needs the keyring folder mounted and writable enough for `gpg-agent`.

**Not verified.** None of this was run on macOS or in Docker; the ssh and gpg flows were run on Linux
with throw-away keys, a real `ssh-agent` and gpg (see [ADR 0005](adr/0005-local-clone-reads.md)). A
macOS Keychain agent, `pinentry-mac`, hardware keys and a launchd-started server are untested: if
signing fails there, the `reason` in the answer (`locked`, `key`, `program`, `timeout`, `failed`) is
the first place to look; the program's own error text is deliberately not shown.

## Reminders

The scheduler sends **plan reminders** as events (a plan's target date due soon or passed, a rollout
step whose planned time passed): they reach the event stream and [webhooks](api/webhooks.md), **not
email and not push**. `MRM_REMINDER_INTERVAL_MINUTES` sets how often it looks (default 15; `0` turns
reminders off; otherwise 5 to 10080). They run in the process that runs the background worker
(`MRM_WORKER=inline`, the default); with `MRM_WORKER=off` nothing is sent from that process. Each
reminder is recorded in the table `plan_reminders` under a unique key in the same transaction as its
event, so a restart or several server instances sharing one Postgres database send it once (the
Postgres path was **not** run). The first run after an upgrade sends one overdue reminder for each
open plan whose target date passed in the last 30 days; set the interval to `0` first if you do not
want that. See [events](api/events.md#plan-reminders).

### Release watch

The same scheduler runs the **release watch**, again as events only (never email or push):
`release.stalled` when the release of an app has stood still for longer than the workspace setting
`release.stalledAfterHours` (default 6; `0` turns it off for the workspace), and `review.unanswered`,
a digest of reviews that wait for an answer (workspace setting `reviews.unansweredReminderHours`,
default `0` = off). `MRM_RELEASE_WATCH_INTERVAL_MINUTES` sets how often it looks (default 15; `0`
turns the watch off; otherwise 5 to 10080). It reads only this server's own tables, so it calls neither
GitHub nor a store. A stall is reminded once per episode and again only after
`release.stalledRepeatHours` (default 24; `0` never repeats); the episode is kept in
`release_stall_reminders` and `review_unanswered_reminders`, changed in the same transaction as the
event, so a restart or several instances sharing one database send it once (the Postgres path was **not**
run). The first run after an upgrade can send a `release.stalled` event for each app whose release has
stood still for longer than the threshold; set the interval or `release.stalledAfterHours` to `0`
first if you do not want that. See [events](api/events.md#release-watch) and
[the release pipeline](api/release-pipeline.md).

## Scheduled listing reads

The store listing of an app (texts, categories, age rating, privacy choices URL, screenshot and
preview counts; see [listing](api/listing.md)) is read when the app is synced. To also read it on a
schedule, set `MRM_LISTING_INTERVAL_MINUTES` (default `0`, off; otherwise 30 to 10080). The scheduler
only queues `app.listing` jobs, at most 3 per pass and 2 per workspace, 15 seconds apart plus a random
delay, one per store credential at a time, never for an app that already has a sync or a listing read
queued or running, and with a growing wait after failures (doubling, at most a day). It shares the
per workspace store rate limit of the app sync and runs where the background worker runs
(`MRM_WORKER=inline`). With several server instances on one database an app is still read once (the
job claims it with a compare-and-set on `app_listing_status.listing_attempt_at`).

- **Request volume.** One read of a large listing is roughly 100 to 200 store requests (up to 30
  locales of screenshots and previews per App Store version, up to 25 languages of images on Google
  Play). Use an interval of hours, not minutes, with many apps; the default of off is deliberate.
- It is read-only: no store is written, and the use of the credential is audited as `credential.use`
  by the system actor `app.listing`. **Never run against a real store**, so the defaults (3 per pass,
  15 seconds, the backoff) are untried.
- Upgrade: migration 16 adds three columns to `app_listing_status` (last attempt, failures in a row
  and the connector warnings). Nothing else changes for an existing database; apps read before the
  upgrade have no sections until their next read.

## Customer reviews and data protection

The reviews of an app are read from its store (read-only; replying is a separate, off by default feature, see below) by hand from the
Reviews tab, and on a schedule when `MRM_REVIEW_SYNC_INTERVAL_MINUTES` is set (default `0`, off;
otherwise 15 to 10080). The scheduler only queues `review.sync` jobs, a few per run and spread out,
and shares the per workspace rate limit of the app sync. It runs in the process that runs the
background worker (`MRM_WORKER=inline`, the default).

- **Google Play returns only the last 7 days of reviews.** Set the interval to **360 (6 hours) or
  less** if you have Android apps. If nothing reads for more than 7 days, the reviews written in
  between cannot be recovered; the app's Reviews tab and the sync result then show a gap warning.
  Google also limits `reviews.list` to 200 requests per hour per app.
- A failing read is retried by the scheduler with a growing backoff (15 minutes, doubling, at most 6 hours), and a
  `review.sync_failed` event is sent once per failure streak.
- **Personal data.** Review text and display names are written by people who are not users of this
  server. They are stored in the database (`app_reviews`) in plain text, shown only to workspace
  members with `reviews.read`, and are never put in events, webhooks, audit entries or URLs.
  `MRM_REVIEW_RETENTION_DAYS` (default `365`; `0` keeps everything; at most `3650`) deletes older
  reviews by the store's date, at most 1000 per run and once an hour. Deleting an app deletes its
  reviews. Decide a retention that fits your privacy policy, include the database in your backups
  accordingly, and note that a backup keeps deleted reviews until it expires.
- Network: the server needs outbound https to `api.appstoreconnect.apple.com`,
  `androidpublisher.googleapis.com` and, for the App Store's store-wide rating,
  `itunes.apple.com`.

### Replying to reviews (a store write, off by default)

`MRM_REVIEW_REPLY_ENABLED` (default `false`) is the kill switch for answering reviews from this tool.
While it is `false`, every reply route answers `409 reply_disabled` and the Reviews screens say that
this variable enables replying; reading, syncing and triaging are not affected. Set it to `true` only
when you want people to publish replies **publicly in the App Store and Google Play, in your
organisation's name**. Things to settle first:

- **Who can send.** Only owners and admins (`reviews.reply`); members and above can write drafts
  (`reviews.triage`). An API token sends only when its list of actions names `reviews.reply`.
- **The store credential must be allowed to reply** (Google Play: the permission "Reply to reviews";
  App Store Connect: a key role allowed to respond to reviews, in practice Admin). The same
  credential also reads reviews. See [credentials](credentials.md#replying-to-reviews).
- Sends are limited to 30 an hour per workspace (and the stores' own quotas apply). A reply cannot
  be recalled by this tool: the person deletes or edits it in the store's own console.
- The reply text lives in the database (`review_reply_drafts`) and in the store; it is never put in
  the audit log, in events or in logs.

See [adr/0007-review-replies](adr/0007-review-replies.md).

### Changing a store rollout (a store write, off by default)

`MRM_STORE_ROLLOUT_ENABLED` (default `false`; only `true` and `false`; blank means off) is the kill
switch for changing the staged rollout of Google Play and the phased release of the App Store from
this tool. While `false`, the rollout state, preview and apply routes answer `409 rollout_disabled`;
reading, syncing and planning are not affected. Set it to `true` only when you want people to change
**who receives an update in the live stores**. Things to settle first:

- **Who can change it.** Only owners and admins (`releases.rollout`). An API token only when its list
  of actions names `releases.rollout`.
- **The store credential must be allowed to release** (see [credentials](credentials.md#changing-a-rollout-what-the-same-credentials-need)).
- Google Play only goes up (the way down is halt); completing a Play rollout and releasing an App
  Store phased release to all users cannot be undone from this tool. Changes are confirmed against a
  fresh read of the store, one at a time per app, and never retried after an unknown outcome.
- The table `store_rollout_claims` (one row while a change is in flight) is created by migration 22.

See [adr/0008-store-rollout-writes](adr/0008-store-rollout-writes.md) and [api/rollout](api/rollout.md).

### Raising an EAS Update rollout (an Expo write, off by default)

`MRM_EAS_UPDATE_ROLLOUT_ENABLED` (default `false`; only `true` and `false`; blank means off) is the kill switch for raising the rollout
percentage of an over-the-air update at Expo from this tool. While `false`, the preview and apply routes answer `409 eas_update_write_disabled`;
reading channels, updates and insights is not affected and needs no switch. It changes what the clients of an app receive and cannot be
lowered from here, so settle first: only owners and admins can do it (`releases.rollout`); the workspace's step-up policy applies (the
action class `rollout`); the Expo token needs the Developer role; a change is confirmed against a fresh read of Expo and never retried after
an unknown outcome. No table is created. See [adr/0037-eas-update](adr/0037-eas-update.md) and [api/eas-update](api/eas-update.md).

### Writing listing drafts to a store (a store write, off by default)

`MRM_STORE_DRAFT_WRITE_ENABLED` (default `false`; only `true` and `false`; blank means off) is the kill
switch for writing staged listing texts and graphics to the **draft** of an app in App Store Connect or
Google Play. While `false`, the preview and push routes answer `409 store_draft_disabled`; staging and
viewing are not affected, and nothing is ever submitted, sent for review or published by this server.
Things to settle first:

- **Who can push.** Only owners and admins (`store.push_draft`). An API token only when its list of
  actions names it.
- **The draft is overwritten.** Pushing replaces the texts and the whole screenshot sets that were staged,
  in the draft of the store. A change made by somebody else after the preview is refused (`state_changed`).
- **Files.** Screenshots are read from the connected repository's clone at push time, within the asset
  budgets; PNG or JPEG, 8 MiB per file, 100 files and 64 MiB per push.
- **The store credential must be allowed to edit the listing** (see [credentials](credentials.md#writing-listing-drafts-what-the-same-credentials-need)).
- The table `staged_changes` (the staged items, by reference) and `store_draft_claims` (one row while a
  push is in flight) are created by migration 23.

See [adr/0009-staged-store-drafts](adr/0009-staged-store-drafts.md) and [api/staged-changes](api/staged-changes.md). The same switch also lets the release stepper create the next App Store version ([api/store-version](api/store-version.md)).

### Submitting a draft for store review (a store write, off by default)

`MRM_STORE_SUBMIT_ENABLED` (default `false`; only `true` and `false`; blank means off) is the kill switch for handing
the **pushed** draft of an app to App Review or to Google Play review. It is independent of
`MRM_STORE_DRAFT_WRITE_ENABLED`. While `false`, the preview and submit routes answer `409 store_submit_disabled`; the
state and config routes still work. Things to settle first:

- **It cannot be taken back from this server.** A submission is cancelled only in App Store Connect, a Google Play
  review only in Play Console. It never releases a version and never changes a rollout.
- **Who can submit.** Only owners and admins (`store.submit`). An API token only when its list of actions names it.
- **The flow.** A successful draft push, then a preview (reads the store, shows what goes to review, the checks, a
  hash and a phrase to type), then the submit with the hash and the typed phrase. The store is read again right before
  the write; one submit per app at a time; never retried.
- **App Store:** the version must be set to be released manually and have a valid build; otherwise it is blocked.
  **Google Play:** everything held back for the app goes to review, including changes made in Play Console.
- **The store credential must be allowed to submit** (App Store Connect: a role that can submit for review; Google
  Play: a service account that can edit and release; UNVERIFIED which minimum).
- The tables `store_draft_pushes` (what the last pushes wrote, as hashes) and `store_submit_claims` (one row while a
  submit is in flight) are created by migration 24.

See [adr/0010-store-submit](adr/0010-store-submit.md) and [api/submit](api/submit.md).

See [api/reviews](api/reviews.md) and [phase-3-reviews](phase-3-reviews.md).

### Releasing (a store write, off by default)

`MRM_STORE_RELEASE_ENABLED` (default `false`; only `true` and `false`; blank means off) is the kill switch for **releasing**: making
an approved App Store version available (`POST appStoreVersionReleaseRequests`), or starting a Google Play draft release at a share of
users you name. It is independent of `MRM_STORE_DRAFT_WRITE_ENABLED` and `MRM_STORE_SUBMIT_ENABLED`. While `false`, the preview and
release routes answer `409 store_release_disabled`; the config and state routes work, and so do the **reads** of builds and version
codes (they change nothing). Things to settle first:

- **It cannot be taken back from this server.** Apple does not allow cancelling a release request; a Google Play rollout can be
  halted or completed with the [rollout](api/rollout.md) controls, not unsent.
- **Who can release.** Only owners and admins (`store.release`). An API token only when its list of actions names it.
- **The flow.** A preview (reads the store, shows what is released and to whom, the checks, a hash and a phrase to type), then the
  release with the hash, the phrase and the same request. The store is read again right before the write; one release per app at a
  time; never retried. Google Play needs an explicit share every time.
- **Credentials.** The App Store key must be allowed to release a version (App Manager or Admin is assumed, UNVERIFIED); the Google
  service account must be allowed to release apps in Play Console.
- Everything not verified on a real account is listed in [api/releases-write](api/releases-write.md#unverified-check-with-a-real-account).

### Publishing several steps at once (a store write, off by default)

`MRM_STORE_PUBLISH_BATCH_ENABLED` (default `false`; only `true` and `false`; blank means off) is the master switch of the **batch publish**:
one preview and one typed confirmation for several gated steps of an app (push the draft, submit, release, rollout). **It turns no step on**:
every step in a batch still needs its own switch (`MRM_STORE_DRAFT_WRITE_ENABLED`, `MRM_STORE_SUBMIT_ENABLED`, `MRM_STORE_RELEASE_ENABLED`,
`MRM_STORE_ROLLOUT_ENABLED`), its own role right and its own hash; a step whose switch is off is shown as unavailable in the plan, and a
request that includes it is refused. While `false`, the two batch routes answer `409 publish_batch_disabled` (after the rights check); the
pending view (`GET /apps/{id}/pending`, `GET /pending/summary`) reads this server's own database only and works either way. Only owners and
admins (`store.publish`); an API token only when its list of actions names `store.publish` **and** the action of every step in the batch.
The table `store_publish_claims` (one row while a batch runs) is created by migration 29. See [adr/0015](adr/0015-pending-and-batch-publish.md)
and [api/pending](api/pending.md).

### Review translation

Translating reviews is **off by default** and chosen per workspace under Settings
([api/settings](api/settings.md)). It sends review text to a third party: Google Cloud Translation
(the default), DeepL, Microsoft Translator, or a LibreTranslate server whose address an admin enters.
Settle first: that the provider's terms fit your privacy policy and the stores' terms, whether review
text may leave your network at all (then use a LibreTranslate server you run), and a spending cap with
the provider as well as the workspace's daily character limit (`translation.dailyCharBudget`, default
50,000 a day).

- Network: outbound https to `translation.googleapis.com`, `api.deepl.com` and `api-free.deepl.com`,
  `api.cognitive.microsofttranslator.com`, or the LibreTranslate address, depending on the provider.
- Keys are vault credentials, never settings; see [credentials](credentials.md#review-translation-provider-keys).
- The LibreTranslate address is a user-entered URL, so the server treats it like a webhook address:
  `https` only, no credentials in the URL, the name is resolved and checked at **every** call and the
  connection is pinned to the checked address, redirects are not followed, the answer is limited to
  2 MiB and the call to 15 seconds, and private, loopback and link-local addresses are refused. Cloud
  metadata addresses (169.254.169.254, 100.100.100.200, fd00:ec2::254) are always refused.
- `MRM_TRANSLATE_ALLOW_PRIVATE_URLS` (default `false`; only `true` or `false`). **Warning:** set it
  to `true` only to use a LibreTranslate on your own network (or `http://localhost`). It lets anyone
  who can change workspace settings (admins and owners) make this server send requests, carrying
  review text, to any host it can reach, such as internal services. Plain `http` is then accepted for
  loopback only. Leave it `false` when LibreTranslate is public or when you do not trust every admin.
- Review text is never logged or audited; the audit log has counts and the provider. Translations are
  stored in `review_translations` (plain text, like the reviews) and deleted with the reviews.
- Upgrade: migration 20 adds `workspace_settings`, `review_translations` and `translation_usage`.
  The low rating threshold moves from a constant to the setting `reviews.lowRatingThreshold`
  (default 2, the old behavior).

## AI assistance (off by default)

AI assistance ([api/ai](api/ai.md), [ADR 0016](adr/0016-ai-foundation.md)) suggests keywords, listing text and review reply drafts. It only
**proposes**: a person accepts a suggestion, and accepting calls the existing keyword, staged text or reply draft service with its own right. Nothing
here pushes, submits, publishes, releases or sends a reply.

- `MRM_AI_ENABLED` (default `false`; only `true` or `false`). While `false`, nothing is ever sent to an AI provider, whatever a workspace has set.
  A workspace must also turn it on (an admin, in the AI settings), choose a provider and a model, and add a key (a vault credential, see
  [credentials](credentials.md#ai-provider-keys)); a local model server that needs no key needs no credential.
- **Privacy.** When on, the data listed for a task (listing text, tracked keywords, competitor names and titles, one review's text and rating) goes to the
  provider the workspace chose. Anthropic and OpenAI are third parties: check their terms for your account. A model you run yourself (Ollama, LM Studio, vLLM
  through the `openai_compatible` provider) keeps it on your own network. The API returns each task's disclosure so a screen can show it before first use.
  Review text is never logged or audited; the audit log has ids, versions, token counts and a hash of the data sent.
- `MRM_AI_ALLOW_PRIVATE_URLS` (default `false`; only `true` or `false`). The address of an OpenAI compatible server is a workspace setting. By default it must be
  `https` to a public host, is checked when saved and at every call, is not redirected, and the connection is pinned to the checked address. **Warning:** `true`
  lets anyone who can change the AI settings (admins and owners) make this server send requests, carrying listing and review text, to any host it can reach; plain
  `http` is then accepted for loopback only. Turn it on only to reach a model on your own network or machine, and only when you trust every admin.
  Cloud metadata addresses stay refused either way. When an address is refused the settings screen says why (`private_address_blocked`: this switch is off; `plain_http_not_allowed`: plain `http`
  works to `localhost` only, so a model on another machine needs `https`). Changing it needs a restart. **Docker:** `localhost` inside the container is the container, not the host, and `docker compose`
  passes the container only the variables listed under `environment:` in `docker-compose.yml`, not every line of `.env`: add `MRM_AI_ENABLED` and `MRM_AI_ALLOW_PRIVATE_URLS` there (or use `env_file`) for
  them to take effect, and reach a model on the host through an `https` address.
- **Cost.** Each workspace has a monthly token budget (UTC month, input plus output, default 500,000, `0` means no limit here), a cap on the input and on the
  output of one run, two runs at a time and ten runs a minute. The token counts are estimates before a call and the provider's own numbers after it. Also set a
  spending limit with the provider.
- Suggestions are kept 90 days (and deleted with their app); usage rows (counts only) 400 days.
- Upgrade: migration 30 adds `ai_usage` and `ai_suggestions`. Nothing changes until `MRM_AI_ENABLED=true` and a workspace turns it on.

## ASO: keyword ranks and competitors (public store data)

The ASO feature ([api/aso](api/aso.md), [ADR 0011](adr/0011-aso-keywords-competitors.md)) reads the **public** search results and
listings of the stores to track where an app ranks for a keyword and what competitors change. It uses no credential and writes
nothing to a store. By hand from the ASO screens or the API, and on a schedule when `MRM_ASO_INTERVAL_MINUTES` is set (default `0`, off;
otherwise 60 to 10080). The scheduler only queues `aso.refresh` jobs, a few per pass and spread out, and runs where the worker runs
(`MRM_WORKER=inline`, the default).

- **Apple** is read through the documented iTunes Search and Lookup APIs (`itunes.apple.com`). Apple states about 20 calls per minute
  (subject to change) and asks for caching, so the defaults are 10 calls per minute per process (`MRM_ASO_APPLE_CALLS_PER_MINUTE`, at most 20)
  and a one hour cache (`MRM_ASO_CACHE_MINUTES`). Several server processes each have their own limit: with more than one, lower it.
- **Google Play is unofficial and off by default.** `MRM_ASO_PLAY_UNOFFICIAL_ENABLED=true` makes the server read the public pages of
  `play.google.com`. Google Play has no official API for this, reading its pages from a program **may be against the Google Play Terms of Service
  or Google's Terms of Service**, and it breaks when Google changes its markup. This was not reviewed by a lawyer; it is your decision and
  your risk. While it is off, no request to Google is ever made and the Play routes answer `409 play_unofficial_disabled`. When it is on the server logs
  a warning at start, uses an identifying User-Agent, no cookie and no login, 4 calls per minute (`MRM_ASO_PLAY_CALLS_PER_MINUTE`), and stops on a refusal or a robot check.
- **Limits.** `MRM_ASO_MAX_KEYWORDS_PER_APP` (50), `MRM_ASO_MAX_COMPETITORS_PER_APP` (10), `MRM_ASO_MAX_CHECKS_PER_RUN` (25 keyword checks in one refresh, the rest stays due),
  `MRM_ASO_RANK_DEPTH` (50 results read per search; Google Play at most 50), `MRM_ASO_HEARTBEAT_DAYS` (7: a quiet competitor still gets a snapshot).
- **Retention.** `MRM_ASO_RETENTION_DAYS` (default `365`; `0` keeps everything; at most `3650`) deletes older rank checks and competitor snapshots, at most 2000 of each per run and
  once an hour; the newest snapshot of each competitor is kept. Deleting an app deletes its ASO data. What is stored is the terms and notes your team typed, ranks, and
  public data about other apps (including the first 1000 characters of a competitor's description): no customer data. A backup keeps deleted rows until it expires.
- **Network.** Outbound https to `itunes.apple.com` and, only when Google Play is switched on, `play.google.com`. Requests go through the same address checks as the app icon
  lookup (https, a fixed host list, public addresses only, size cap, timeout).
- **Nothing here was run against the real services** (see the UNVERIFIED lists in [ADR 0011](adr/0011-aso-keywords-competitors.md#unverified)): start with a few keywords and a long interval.

## EAS builds and submissions (read-only, only for linked apps)

An app linked to an Expo project ([api/eas](api/eas.md)) shows that project's EAS builds and submissions in "Builds to test" ([api/eas-builds](api/eas-builds.md), [ADR 0036](adr/0036-eas-build-submit-status.md)). Nothing is created, cancelled or resubmitted at Expo, and a workspace without an Expo credential costs nothing.

- `MRM_EAS_STATUS_INTERVAL_MINUTES` (default 30; `0` turns the scheduled read off; otherwise 5 to 10080): how often the scheduler queues one read per linked app record. A record with a build or a submission still running is read again every three minutes. Reads are spaced out, bounded and backed off after a failure; a manual read is `POST .../eas/status/refresh`.
- **Upgrade:** migration 47 adds three tables (`eas_builds`, `eas_submissions`, `eas_status_sync`). Nothing is read until an app is linked.
- **What is stored:** per build and submission: ids, status, profile, channel, versions, runtime, distribution, the first line of the commit message and, for a failure, Expo's error text (at most 500 characters). **The address of a build file is not stored.** Rows are deleted when the link is removed or changed and with the app.
- **Not checked against a live Expo account:** see the UNVERIFIED list in the ADR (page size limit, rate limits, how Expo words errors).

## Analytics (off by default)

Analytics ([api/analytics](api/analytics.md), [ADR 0017](adr/0017-analytics-foundation.md)) reads daily numbers of your apps from App Store Connect (analytics reports, sales) and Google Play (vitals, monthly reports) into the database. A workspace admin turns it on with the setting `analytics.enabled` (default `false`); until then nothing is requested from a store. Reading stored numbers and importing an Apple report file always work.

- `MRM_ANALYTICS_INTERVAL_MINUTES` (default 360; `0` turns the scheduled job off; otherwise 15 to 10080): how often the scheduler queues one sync per app that has something to read. Syncs are spaced out and bounded; a manual sync is `POST .../analytics/sync`.
- **Upgrade:** migration 31 adds six tables (`analytics_*`). Nothing changes until the setting is on.
- **What is stored:** daily facts per app (counts, rates, proceeds per currency, an optional territory, source type, app version or currency). No user, device or review data. Daily facts are **kept for ever** (Apple deletes its report instances after 35 days, so this copy is the history) and are deleted with the app. Run records are pruned after 90 days and instance bookkeeping after 120.
- **Download links:** Apple's report links last about five minutes. They are fetched at once without the API token, and never logged, stored or returned.
- **Import size:** an uploaded Apple report may be 10 MiB (64 MiB unpacked); the usual 1 MiB request limit is lifted for the two import routes only.
- **Not verified:** nothing was run against Apple or Google. See [the study](research/analytics-apis.md) and [api/analytics](api/analytics.md#not-verified-unverified).

## Outgoing mail and two-factor codes

Emailed codes and alert emails need a mail server: `MRM_SMTP_HOST`, `MRM_SMTP_PORT`, `MRM_SMTP_SECURE`, `MRM_SMTP_USER`, `MRM_SMTP_PASSWORD`,
`MRM_SMTP_FROM` in `.env`, or an admin enters it under Settings, Mail. See [mail](api/mail.md).

- Allow outbound TCP from the server to the mail host and port (587 or 465). A network that blocks it shows as "could not be reached".
- Inside Docker, `localhost` is the container. A relay on the host or on your network is a **private address** and is refused until you set
  `MRM_SMTP_ALLOW_PRIVATE_HOSTS=true`; only the operator can, on purpose (the setting screen cannot).
- Certificates are verified. For a relay with a private CA, add the CA to the container with `NODE_EXTRA_CA_CERTS`.
- The authenticator app needs the server clock to be right (NTP); codes are accepted 30 seconds either side.
- An authenticator app and email codes confirm hard actions with no mail server for the app. A sign-in second step
  (Settings, Security, "Signing in") needs accounts, not single-user mode. Before you set it to "required", check that every owner and admin has
  a phone or recovery codes; the way back for a locked-out only owner is in [two-factor](api/two-factor.md#if-someone-is-locked-out).

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
