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

