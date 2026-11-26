# Releasing

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), builds the
desktop apps and the Docker image. You do not tag by hand: run it with `mode = release` and it works
out the version from your commit messages, builds everything, and only then commits the version,
tags it, pushes the Docker image and drafts the GitHub Release. Running it with the default
`mode = build-only` is a dry run that publishes nothing. Pushing a `vX.Y.Z` tag yourself still works.

| Trigger                                               | What happens                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run workflow, `mode = release`, on a **branch**       | Computes the next version and the changelog from the commits, builds every platform, then commits `chore(release): X.Y.Z`, tags `vX.Y.Z`, pushes the image to GHCR and creates a draft GitHub Release with `SHA256SUMS` and attestations. |
| Run workflow, `mode = build-only` (default)           | The same builds. Output is Actions artifacts that expire after 7 days. No release, no Docker push, no commit, no tag.                                                                                                                     |
| Push a tag `v*.*.*` by hand                           | Version check (every version file must equal the tag), builds, Docker push, draft release with GitHub's generated notes. There is no `tag` job: the tag is the input.                                                                     |
| Run workflow, `mode = release`, on a `vX.Y.Z` **tag** | Same as a tag push. Used to re-run a release whose tag already exists.                                                                                                                                                                    |

Run inputs: `mode`; `bump` (release on a branch: `auto`, `patch`, `minor` or `major`, default `auto`);
`prerelease` (release on a branch: an identifier such as `rc`, empty for a stable release);
`ref` (branch, tag or commit; empty means the ref picked under "Use workflow from"; release mode
needs a branch or a tag, not a commit); `version` (build-only: pretend the version is this,
uncommitted, for example `1.2.3-rc.1`); `docker` (build the image, default on); `platforms` (comma
separated subset of `macos-arm64`, `macos-x64`, `windows-x64`, `windows-arm64`, `linux-x64`,
`linux-arm64`; `all` or empty is every platform except `windows-arm64`, which is opt-in; `none`
skips the desktop builds). `bump` and `prerelease` are errors anywhere but a release on a branch, so
a typo cannot be silently ignored.

## Cut a release

1. Merge what you want to ship and wait for CI to be green on that commit.
2. Optional, locally (a clone with its tags, `git fetch --tags`): see what the release would be.
   `node scripts/release/bump.mjs next --print-section` prints the base, the commit counts, the next
   version and the changelog section, and changes nothing.
3. Optional dry run: Actions, Release, Run workflow, branch `main`, `mode = build-only`. Download
   the artifacts, install one, check the smoke jobs are green. For a pre-release also try
   `version = 1.2.3-rc.1`, which exercises the pre-release rules (below).
4. **Release:** Actions, Release, Run workflow, branch `main`, `mode = release`, `bump = auto`
   (leave `prerelease` empty). The run summary of the `plan` job shows the version and the
   changelog it computed before anything is built.
5. The run, in order: `plan` (fails at once, before any build, with "Nothing to release" when there
   are no commits since the last release, or when the tag would already exist); every desktop build
   and the Docker smoke tests, each with the new version written into its own checkout; then `tag`
   (commits the version files and `CHANGELOG.md` as `chore(release): X.Y.Z` on top of the built
   commit, pushes it to the branch, creates the tag); then `docker-publish` and the draft release.
   **If any build fails, nothing is committed, tagged or pushed.**
6. Open Releases. The draft has the installers, `SHA256SUMS`, and the notes: the changelog
   section, the downloads table, the Docker line and the signing instructions. Edit the text, then
   **Publish release** yourself. Nothing is public until you do. The Docker image is already pushed
   at that point; a draft you decide not to publish leaves the image tags and the tag in place.
7. A published release is never touched; use a new version.

### How the version is decided (`bump = auto`)

The base is the newest **stable** `v*` tag (compared as versions, so `v1.10.0` is newer than
`v1.9.0`; pre-release tags are skipped). The commits are those since it, without the
`chore(release): ...` commits and without merge commits. With no tag yet the base is the version in
the files and every commit counts.

| Commit message                                                             | Bump                                                                     | Changelog section |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------- |
| `type!: ...` or a `BREAKING CHANGE:` footer                                | major, but **minor while the major is 0**                                | Breaking changes  |
| `feat: ...`                                                                | minor (also while the major is 0)                                        | Features          |
| `fix: ...`                                                                 | patch                                                                    | Fixes             |
| `perf: ...`                                                                | patch                                                                    | Performance       |
| `revert: ...` or git's `Revert "..."`                                      | patch                                                                    | Reverts           |
| `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore`, anything else | patch, only when nothing above is there and there is at least one commit | Other             |

The highest level wins. A message that is not `type: subject` (older history, merge-style text)
counts as "other". No commits since the tag fails the run with "Nothing to release"; so does a
forced `bump` with no commits. `bump = patch|minor|major` ignores what the commits say and applies
that level (the way to reach `1.0.0` is `bump = major` on `0.x`). The tool refuses to go backwards:
if the files already say a higher version than the computed one (someone bumped by hand without
tagging), tag that commit by hand instead (below).

Each entry in the changelog is `- scope: subject (short sha)`. The section
`## [X.Y.Z] - date` starts with a compare link (`.../compare/vOLD...vNEW`), is prepended to
`CHANGELOG.md` in the release commit, and is the top of the GitHub Release notes.

### Pre-releases

Set `prerelease = rc`: the target version is computed as above from the last **stable** tag, then
numbered from the existing tags: `1.3.0-rc.1`, then `1.3.0-rc.2`. A later run with `prerelease`
empty releases the stable `1.3.0` (the same commits are listed again in its changelog section).
Pre-release tags mark the release as a pre-release, get no `X.Y` and no `latest` Docker tag, and on
Windows build only the NSIS installer (WiX MSI accepts numeric pre-release parts only).

### When a run fails

| Where it fails                            | State                               | What to do                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`                                    | Nothing built or pushed             | Read the error: nothing to release, bad input, tag exists, version files inconsistent or ahead.                                                                                                                             |
| A desktop build or a Docker smoke test    | Nothing committed, tagged or pushed | Fix it, merge, run again. Re-running the failed jobs is fine too (same commit, same version).                                                                                                                               |
| `tag`: push refused, "moved"              | Nothing tagged                      | The branch got a new commit during the run. Run the release again (it will include that commit).                                                                                                                            |
| `tag`: push refused, protected branch     | Nothing tagged                      | See "Protected branches".                                                                                                                                                                                                   |
| `tag`: commit pushed, tag creation failed | Commit on the branch, no tag        | The error prints the commands: `git tag vX.Y.Z <sha> && git push origin vX.Y.Z` (starts the tag-push release).                                                                                                              |
| `docker-publish` or the draft release     | Commit and tag exist                | **Re-run the failed jobs** of the same run (the `tag` job is not repeated). A fresh run would say "Nothing to release". Or run the workflow on the tag `vX.Y.Z`, `mode = release`. A re-run replaces its own earlier draft. |

### Protected branches

The `tag` job pushes a commit to the branch with the workflow token (`contents: write`). If the
branch requires pull requests or status checks for everyone, that push is refused. Either allow the
bot to bypass in the branch rule or ruleset, or create a secret `RELEASE_PUSH_TOKEN` (a fine-grained
personal access token or GitHub App token with Contents: read and write, owned by someone who may
bypass the rule). The job then pushes the commit with it, and CI runs on the release commit. The tag
is always created with the workflow token, so it never starts a second release. The commit it pushes
only touches version files and `CHANGELOG.md`.

### Why pushing does not start a second release

Events caused by the workflow's own `GITHUB_TOKEN` (the commit and the tag the `tag` job pushes) do
not start new workflow runs: GitHub's rule is that "events triggered by the `GITHUB_TOKEN` will not
create a new workflow run", with `workflow_dispatch` and `repository_dispatch` as the exceptions
([docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).
So the `push: tags` trigger of this workflow does not fire for the tag it just made. A side effect:
CI does not run on the `chore(release)` commit either (it changes only version files and the
changelog, and the same code was built and tested just before).

### Manual tag (still works)

Use this when the files are ahead of the last tag, or to release without the `tag` job:

1. `node scripts/release/bump.mjs next --write` computes the version and writes the version files and
   `CHANGELOG.md` for review (`git diff`); or set a version yourself:
   `node scripts/check-version.mjs --set 1.2.3`. `node scripts/check-version.mjs` alone checks that
   every version file agrees (root and workspace `package.json` files, `tauri.conf.json`,
   `Cargo.toml`, the `kiln-desktop` entry of `Cargo.lock`, `apps/server/src/version.ts`).
2. Commit it (`chore(release): 1.2.3`) and merge it. CI must be green on that commit.
3. Tag the commit and push the tag: `git tag -a v1.2.3 -m "Kiln 1.2.3" && git push origin v1.2.3`.
4. The `plan` job fails at once unless the tag is `vX.Y.Z` (or `vX.Y.Z-pre`), every version file
   equals it, and no published release has that tag. The draft release gets GitHub's generated notes;
   paste the changelog section in if you want it there too.

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
its own target (`apps/desktop/scripts/prepare-sidecar.mjs`: the Node binary, the web UI and the
server bundled into one minified `launcher.mjs` with esbuild, which also starts the staged server once
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

Without them everything still builds, unsigned (the macOS app is signed ad hoc, because Apple Silicon refuses code with no signature at all; Gatekeeper still blocks the first launch until the user allows it). The job summary and the release notes say which
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
| `APPLE_API_KEY`                | App Store Connect API key id (alternative to the Apple ID set, preferred when all three are set)       | Notarization                               |
| `APPLE_API_ISSUER`             | The issuer id shown on the App Store Connect Keys page                                                 | Notarization (API key)                     |
| `APPLE_API_KEY_CONTENT`        | The text of the downloaded `AuthKey_<id>.p8` file                                                      | Notarization (API key)                     |
| `WINDOWS_CERTIFICATE`          | Base64 of a code-signing certificate as `.pfx`                                                         | Windows signing (needs the next one)       |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` password                                                                                    | Windows signing                            |

`APPLE_IDENTITY_ID` is accepted as another name for `APPLE_SIGNING_IDENTITY`, so organization-level
secrets can be shared with sibling apps that use that name. To share one set across all apps, create
the secrets at the organization level (Organization settings, Secrets and variables, Actions) with
access to the repositories that release.

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

- [ ] Settings, Actions, General: Actions enabled. Workflow permissions can stay "Read repository
      contents" because each job asks for what it needs (the `tag` job asks for `contents: write`);
      if your organization caps the token at read-only, choose "Read and write permissions". The
      first release from a branch is the first run of the `tag` job: see "Not verified".
- [x] The bundle identifier in `apps/desktop/src-tauri/tauri.conf.json` is `com.akylas.kiln`
      (`check-version.mjs` warns only for a `dev.example.` placeholder). Do not change it after the first
      public release: macOS and Windows key the app's data folder on it.
- [ ] Run a build-only dry run on `main` and install the artifacts on each OS you can reach.
- [ ] If `main` is protected: allow the Actions bot to bypass, or add `RELEASE_PUSH_TOKEN` (see
      "Protected branches").
- [ ] Optional: add the signing secrets above.
- [ ] After the first tagged run: open the new `kiln` package under the organisation's Packages,
      Package settings, and set visibility to Public (and link it to the repository). GHCR packages
      start private, so `docker pull` fails for everyone else until you do.
- [ ] Publish the draft release.
- [ ] Later: enable GitHub Pages for the website.

## Not verified

The workflow and its helper scripts were written without running them on GitHub. The scripts have
tests (`pnpm test:scripts`); the YAML parses; nothing else was run. The release-from-a-branch path
(`bump.mjs` in the `plan` job, the `tag` job, the jobs that need it) has never run on GitHub; its
script logic is tested against temporary git repositories. Check these on the first dry run and the
first release:

- The `tag` job end to end: the push of `chore(release): X.Y.Z` to the branch, the tag created
  through the API, that neither starts a second run, and that `docker-publish` and the draft
  release start only after it. Do the first one with `prerelease = rc` so that nothing stable moves.

- Runner labels: `macos-15`, `macos-15-intel`, `windows-11-arm`, `ubuntu-22.04-arm` (arm runners
  are free for public repositories only; private ones need a larger-runner plan).
- Tauri bundle names (`app,dmg`, `nsis,msi`, `deb,rpm,appimage`), and the output folders and file
  names `scripts/release/collect.mjs` looks for. It fails loudly when one is missing.
- The esbuild bundle of the server (ADR 0004, option C) was run on Linux arm64 only, and `esbuild`
  must be in `pnpm-lock.yaml` (`pnpm add -D esbuild --filter @kiln/desktop`) or the install and the
  staging step fail on every runner.
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
