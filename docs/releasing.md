# Releasing

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), builds the
desktop apps and the Docker image. Pushing a tag `vX.Y.Z` makes a **draft** GitHub Release; running
it by hand is a **build-only** dry run that publishes nothing.

| Trigger                                                       | What happens                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Push a tag `v*.*.*`                                           | Version check, desktop installers for every platform, multi-arch Docker image pushed to GHCR, draft GitHub Release with `SHA256SUMS` and build attestations. |
| Actions, Release, Run workflow, `mode = build-only` (default) | The same builds. Output is Actions artifacts that expire after 7 days. No release, no Docker push, no tag, nothing published.                                |
| Run workflow, `mode = release`, on a `vX.Y.Z` tag             | Same as a tag push. Used to re-run a release whose tag already exists.                                                                                       |

Run inputs: `ref` (branch, tag or commit; empty means the ref picked under "Use workflow from"),
`version` (build-only: pretend the version is this, uncommitted, for example `1.2.3-rc.1`),
`docker` (build the image, default on), `platforms` (comma separated subset of `macos-arm64`,
`macos-x64`, `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`; `all` or empty is every
platform except `windows-arm64`, which is opt-in; `none` skips the desktop builds).

## Cut a release

1. Bump every version in one go and review it:
   `node scripts/check-version.mjs --set 1.2.3 && git diff --stat`.
   It writes the root and workspace `package.json` files, `tauri.conf.json`, `Cargo.toml`,
   `Cargo.lock` (the `kiln-desktop` entry) and `apps/server/src/version.ts`.
   `node scripts/check-version.mjs` alone checks that they agree.
2. Commit it (`release: 1.2.3`) and merge it. CI must be green on that commit.
3. **Dry run first.** Actions, Release, Run workflow, branch `main`, `mode = build-only`. For a
   pre-release also try `version = 1.2.3-rc.1`, which exercises the pre-release rules (below).
   Download the artifacts, install one, and check the smoke jobs are green.
4. Tag the commit and push the tag:
   `git tag -a v1.2.3 -m "Kiln 1.2.3" && git push origin v1.2.3`.
5. Wait for the run. The `plan` job fails at once, before any build, unless the tag is `vX.Y.Z` (or
   `vX.Y.Z-pre`), every version file equals it, and no published release has that tag.
6. Open Releases. The draft has the installers, `SHA256SUMS`, the notes (downloads table, Docker
   line, signing instructions) and GitHub's generated changelog. Edit the text, then **Publish
   release** yourself. Nothing is public until you do. The Docker image is already pushed at that
   point (it is pushed only after every installer built); a draft you decide not to publish leaves
   the image tags in place.
7. A failed run can be re-run from the Actions page: it replaces its own earlier draft. A published
   release is never touched; use a new version.

Pre-release tags (`v1.2.3-rc.1`) mark the release as a pre-release, get no `X.Y` and no `latest`
Docker tag, and on Windows build only the NSIS installer (WiX MSI accepts numeric pre-release parts
only).

## What is built

Installer names are `kiln_<version>_<os>_<arch>.<ext>`. The two Mac builds are separate apps, not a
universal binary: each ships the Node binary for its own architecture ([ADR 0004](adr/0004-desktop-sidecar.md)).

| Platform                | Runner             | Files                                                         |
| ----------------------- | ------------------ | ------------------------------------------------------------- |
| macOS, Apple Silicon    | `macos-15`         | `kiln_<v>_macos_arm64.dmg`, `kiln_<v>_macos_arm64.app.tar.gz` |
| macOS, Intel            | `macos-15-intel`   | `kiln_<v>_macos_x64.dmg`, `kiln_<v>_macos_x64.app.tar.gz`     |
| Windows, x64            | `windows-latest`   | `kiln_<v>_windows_x64.exe` (NSIS), `kiln_<v>_windows_x64.msi` |
| Windows, ARM64 (opt-in) | `windows-11-arm`   | `kiln_<v>_windows_arm64.exe` (NSIS)                           |
| Linux, x64              | `ubuntu-22.04`     | `kiln_<v>_linux_x64.deb`, `.rpm`, `.AppImage`                 |
| Linux, ARM64            | `ubuntu-22.04-arm` | `kiln_<v>_linux_arm64.deb`, `.rpm`, `.AppImage`               |

Plus `SHA256SUMS` on the release. Each desktop job builds the web UI, stages the server sidecar for
its own target (`apps/desktop/scripts/prepare-sidecar.mjs`, which also starts the staged server once
as a smoke test), then runs `tauri build`. Windows ARM64 is off by default because Tauri's support
and the runner are the least proven; name it in `platforms` to try it.
There is no server tarball: the repository documents Docker and `node` from a checkout only.

The Docker image `ghcr.io/ossappscollective/kiln` is built for `linux/amd64` and `linux/arm64`
from the repository `Dockerfile`. Before anything is pushed, each architecture is built natively and
started: the smoke test checks `/api/health` (`status: ok`, database ok, the expected version),
that migrations ran on a fresh volume, that the process is not root, and that the web UI is served.
Tags: `X.Y.Z`, `X.Y` and `latest` (stable only), `sha-<short>`. It carries OCI labels (source,
version, revision, licenses `Apache-2.0`, description), an SBOM and max-mode provenance, and a signed
build attestation.

## Secrets (all optional)

Without them everything still builds, unsigned. The job summary and the release notes say which
installers are unsigned and tell users how to open them. Add them under Settings, Secrets and
variables, Actions. Values are never printed, and are present only in the build step.

| Secret                         | Value                                                                                                  | Enables                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `APPLE_CERTIFICATE`            | Base64 of a "Developer ID Application" certificate exported as `.p12` (`base64 -i cert.p12 \| pbcopy`) | macOS signing (needs the next two as well) |
| `APPLE_CERTIFICATE_PASSWORD`   | Password chosen when exporting the `.p12`                                                              | macOS signing                              |
| `APPLE_SIGNING_IDENTITY`       | `Developer ID Application: Your Name (TEAMID)`, see `security find-identity -v -p codesigning`         | macOS signing                              |
| `APPLE_ID`                     | Apple ID e-mail                                                                                        | Notarization (needs the next two as well)  |
| `APPLE_PASSWORD`               | An app-specific password from appleid.apple.com, not the account password                              | Notarization                               |
| `APPLE_TEAM_ID`                | The 10-character team ID                                                                               | Notarization                               |
| `WINDOWS_CERTIFICATE`          | Base64 of a code-signing certificate as `.pfx`                                                         | Windows signing (needs the next one)       |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` password                                                                                    | Windows signing                            |

A partial set is ignored (the build is unsigned, or signed but not notarized). Both need paid
accounts: Apple Developer Program for the first six, a certificate authority for the Windows pair.
The app has no auto-updater, so there is no updater signing key. Linux packages are not signed.
Release signing is not yet tried end to end; see "Not verified" below.

## Verify a download

```sh
sha256sum -c SHA256SUMS --ignore-missing          # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify kiln_1.2.3_linux_x64.deb --repo ossappscollective/kiln
gh attestation verify oci://ghcr.io/ossappscollective/kiln:1.2.3 --repo ossappscollective/kiln
```

Unsigned macOS app: drag it to Applications, then `xattr -dr com.apple.quarantine /Applications/Kiln.app`
(or System Settings, Privacy & Security, Open Anyway). Unsigned Windows installer: SmartScreen,
More info, Run anyway. Linux AppImage: `chmod +x` it first. Only do this for files whose checksum and
attestation you checked.

## Docker

```sh
docker pull ghcr.io/ossappscollective/kiln:1.2.3
docker run -d --name kiln -p 127.0.0.1:8787:8787 -v kiln-data:/data \
  -e KILN_MASTER_KEY="$(openssl rand -base64 32)" ghcr.io/ossappscollective/kiln:1.2.3
```

Keep the master key: it encrypts the stored credentials, and a new key cannot read the old data.
Put a TLS-terminating proxy in front ([deployment.md](deployment.md)). With Postgres, as in the
repository's `docker-compose.yml` but pulling the image instead of building it:

```yaml
services:
  app:
    image: ghcr.io/ossappscollective/kiln:1.2.3
    ports: ["127.0.0.1:8787:8787"]
    environment:
      DATABASE_URL: postgres://mrm:mrm@db:5432/mrm
      KILN_MASTER_KEY: ${KILN_MASTER_KEY:?set it in .env}
    volumes: [mrm-data:/data]
    depends_on: { db: { condition: service_healthy } }
  db:
    image: postgres:17
    environment: { POSTGRES_USER: mrm, POSTGRES_PASSWORD: mrm, POSTGRES_DB: mrm }
    volumes: [pg-data:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U mrm -d mrm"], interval: 5s, retries: 10 }
volumes: { mrm-data: {}, pg-data: {} }
```

## First release checklist

- [ ] Settings, Actions, General: Actions enabled; workflow permissions can stay "Read repository
      contents" (the workflow asks for more per job).
- [x] The bundle identifier in `apps/desktop/src-tauri/tauri.conf.json` is `com.akylas.kiln`
      (`check-version.mjs` warns only for a `dev.example.` placeholder). Do not change it after the first
      public release: macOS and Windows key the app's data folder on it.
- [ ] Run a build-only dry run on `main` and install the artifacts on each OS you can reach.
- [ ] Optional: add the signing secrets above.
- [ ] After the first tagged run: open the new `kiln` package under the organisation's Packages,
      Package settings, and set visibility to Public (and link it to the repository). GHCR packages
      start private, so `docker pull` fails for everyone else until you do.
- [ ] Publish the draft release.
- [ ] Later: enable GitHub Pages for the website.

## Not verified

The workflow and its helper scripts were written without running them on GitHub. The scripts have
tests (`pnpm test:scripts`); the YAML parses; nothing else was run. Check these on the first dry run:

- Runner labels: `macos-15`, `macos-15-intel`, `windows-11-arm`, `ubuntu-22.04-arm` (arm runners
  are free for public repositories only; private ones need a larger-runner plan).
- Tauri bundle names (`app,dmg`, `nsis,msi`, `deb,rpm,appimage`), and the output folders and file
  names `scripts/release/collect.mjs` looks for. It fails loudly when one is missing.
- ADR 0004's open points: the directory form of `resources`, the sidecar inside each package
  format, the entitlements path, whether Tauri signs `kiln-node(.exe)` and the AppImage on arm64.
- `.rpm` and `.deb` with a pre-release version (`1.2.3-rc.1`): use the `version` input to try it.
- Windows signing through `certificateThumbprint`, and macOS notarization: never run.
- `docker/build-push-action` OCI export of a multi-arch image, and QEMU build time for arm64
  (about 20 minutes expected, the job limit is 90).
- GHCR push and attestations with the default `GITHUB_TOKEN` (organisation package settings may
  need "Write" for the repository's Actions under the package's access list).
- Action versions are major tags (`actions/*@v4`, `docker/*`, `pnpm/action-setup@v4`,
  `Swatinem/rust-cache@v2`, `dtolnay/rust-toolchain@stable`), not commit SHAs.
