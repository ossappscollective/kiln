# ADR 0004: How the desktop app ships the server

Status: accepted, with option C (one esbuild bundle) built. The staging script, the bundle and the
packaged start path were run on Linux arm64 (staging with `--smoke`). The Tauri bundle, macOS
signing and notarization, Windows and Rust compilation are not (see "What is verified"). Closes the "how is the server shipped" half of [the sidecar spike](../spikes/sidecar.md).

## Context

The Tauri shell starts the Node server as a child process ([ADR 0003](0003-single-user-mode.md)).
Today it runs `node apps/server/src/index.ts` from the repository checkout. A user must be able to
install the app without installing Node. The server is TypeScript run by Node's type stripping, uses
`node:sqlite` ([ADR 0002](0002-node-sqlite-and-sql-migrations.md)), and has three runtime
dependencies (`hono`, `@hono/node-server`, `zod`) plus four workspace packages that export `.ts`.

## Options

**A. Node single executable application (SEA).**

- Stability 1.1, "active development". In Node 22 the embedded main script must be CommonJS and a
  single JavaScript file. ESM entry points (`mainFormat`) and the one-step `--build-sea` flag
  appear only in the current docs (`--build-sea` since v25.5.0), not in the v22 docs.
- The docs do not mention TypeScript. Treat type stripping as unavailable: the server and its
  workspace packages would have to be bundled to one CommonJS file first.
- `require` and `import()` inside the blob load built-in modules only, so `node:sqlite` should
  work (it is built in), but that is untested here. Third-party code must be bundled, and the
  server's top-level `await` and `await import('node:sqlite')` do not fit a CommonJS bundle without
  changes.
- The blob is injected with `postject`, and the Node binary that makes the blob must be the same
  version as the one it goes into. On macOS the signature is removed, the blob injected, and the
  binary signed again.
- The result is still the whole Node binary (116.6 MB for Node 22.23 on Linux arm64), so it saves
  no download size. It hides sources in a blob, which an Apache-2.0 project does not need.
- Needs a bundler. `esbuild` is only present as a transitive dependency of Vite, drizzle-kit and
  tsx, and `postject` is not installed. Both need a network install.

**B. Official Node binary as a Tauri sidecar, server as bundled resources.**

- Tauri supports this directly (`externalBin` plus `resources`). Node 22.18+ runs `.ts` natively
  (type stripping is on by default and silent since 22.18), so the server runs as it does in
  development, and a Node upgrade is a file swap.
- Constraint: Node refuses to strip types from files under a `node_modules` path. The workspace
  packages had to live outside `node_modules` in the bundle, which pnpm's symlinks cannot
  express, so a 30-line resolve hook mapped `@kiln/*` to the copied package folders. (Removed
  with option C.)
- Third-party packages were JavaScript and were copied as real folders (about 1,500 files with
  the sources). Sources were readable in the app bundle.

**C. Bundle the server to one file, then use B.** The same layout with one `launcher.mjs` made by
esbuild (`platform=node`, `format=esm`, `node:*` external, `pg` and `drizzle-orm` stubbed). It removes
the resolve hook, `node_modules` and every loose source file. **Done** (see "Option C: the bundle"
below); it was chosen to avoid shipping about 1,500 loose files and Node's type stripping, which is
stability 1.2 in Node 22. It needs `esbuild` as a devDependency of `@kiln/desktop`.

Bun `--compile` and a thin client stay as listed in the spike. They were not researched here. Bun
has its own SQLite module, so it would reopen ADR 0002.

## Decision

Adopt **B**, then **C**. Ship the official Node binary as the Tauri sidecar `kiln-node`, and the
server as a `server/` resource folder holding one bundled file, both staged by
`apps/desktop/scripts/prepare-sidecar.mjs`.

Reasons: it uses only documented, stable Tauri features; `node:sqlite` is part of the Node binary,
so there is no native module to sign or notarize; and the server is plain JavaScript, so a Node
upgrade stays a file swap and nothing depends on type stripping. SEA adds a CommonJS-only,
experimental layer to ship the same 117 MB binary. B alone shipped TypeScript sources, a resolve
hook and copied `node_modules`; C ships one file and the smoke test starts exactly that file. The
cost is one declared devDependency, `esbuild`, and a build step that must keep up with new
file-reading code (the script fails loudly, see the table).

### Layout

```
src-tauri/binaries/                      git-ignored, made by prepare-sidecar.mjs
  kiln-node-<target-triple>[.exe]         externalBin "binaries/kiln-node"
  server/                                resources {"binaries/server/": "server/"}
    launcher.mjs                         the whole server, minified (about 3 MB)
    locales/<namespace>/<language>.json  apps/server/locales, read at run time
    licenses/<package>/LICENSE           of hono, @hono/node-server and zod
    web/                                 apps/web/dist
```

No `node_modules`, no TypeScript, no resolve hook. About 20 files plus `web/`.

### Option C: the bundle

`apps/desktop/scripts/bundle-server.mjs` (called by `prepare-sidecar.mjs`, also runnable alone) runs
esbuild from `apps/server/src/index.ts`: `platform=node`, `format=esm`, `target=node22`, minified, tree
shaken, `node:*` and Node built-ins left external. `.ts` imports and the `@kiln/*` workspace packages
resolve through `node_modules` as in development. A banner defines `require` (for any CommonJS
dependency) and sets `KILN_LOCALES_DIR`.

Things that load files or detect "I am the entry point" were checked one by one:

| Risk | Handling |
| --- | --- |
| SQL migrations | TypeScript modules (`packages/db/src/migrations*.ts`), so they are bundled. Nothing reads `.sql`. |
| `import('node:sqlite')` | `node:*` is external; the Node binary has it. |
| `import('pg')` | Stubbed. The stub throws "PostgreSQL is not available in the Kiln desktop app" when loaded; the server prints it and exits 1 (`index.ts` catches the failure of `createDatabase`). The smoke test checks this. |
| `drizzle-orm` | Stubbed the same way; only schema files import it and nothing loads them. If a startup path ever does, the smoke test fails. |
| Message catalogs | `apps/server/src/i18n/catalogs.ts` read `../../locales/` from `import.meta.url`. It now takes `KILN_LOCALES_DIR` first (`localesDir`, unit tested); the banner points it at `locales/` next to the bundle, which the script copies. The previous copy step did not stage the catalogs, so a packaged server answered in message keys; this fixes that. |
| `demo/main.ts` and `mcp/stdio.ts` | Both start themselves when `import.meta.url` equals `process.argv[1]`, which is always true inside a one-file bundle. The demo server (not part of the desktop app) is stubbed. `mcp/stdio.ts` is not imported by the server. The script fails the bundle if any other bundled file has such a guard. |
| Other `import.meta.url` users | The script fails the bundle for any repository file other than `catalogs.ts` that uses `import.meta.url`, `dirname` or `filename`, so a new file read cannot go unnoticed. |
| Version | `VERSION` is a constant in `version.ts`, not read from `package.json`. |
| Top-level `await` | Fine in ES modules; `index.ts` uses it. |
| Worker threads, `createRequire`, `new Worker` | None in the server. The desktop runs `KILN_WORKER=inline`. |
| Licences | The licence files of the bundled third-party packages are copied to `licenses/`. |

`esbuild` is declared in `apps/desktop/package.json`. Add it to the lockfile with
`pnpm add -D esbuild --filter @kiln/desktop`; CI uses `--frozen-lockfile` and fails until that is
committed.

### Tauri wiring

- `tauri.conf.json`: `bundle.externalBin: ["binaries/kiln-node"]`,
  `bundle.resources: {"binaries/server/": "server/"}`,
  `bundle.macOS.entitlements: "entitlements.plist"`.
- Tauri needs a file named `kiln-node-<target-triple>` (plus `.exe` on Windows) for each target,
  and `tauri-build` is expected to fail when it is missing, so `tauri dev` also needs the staging step. The
  `dev` and `build` scripts in `apps/desktop/package.json` run it first.
- At run time the bundler puts the sidecar next to the app executable with the triple removed
  (`Contents/MacOS/kiln-node` on macOS) and the resources in the resource directory.
- **No shell plugin and no capability change.** `main.rs` starts the sidecar with
  `std::process::Command`, as it does today. Capabilities restrict what the web view can call; a
  Rust `Command` is outside them. Not adding `tauri-plugin-shell` means no `shell:allow-*`
  permission exists for a page to use. The plugin's `CommandChild` also has `write` and `kill`
  but no way to close stdin, which the server's `KILN_EXIT_WITH_PARENT` shutdown (ADR 0003) needs.
  The window loads a remote origin and `capabilities/default.json` grants that origin nothing;
  that does not change. If the shell plugin is ever added, the capability must allow only
  `{ "name": "binaries/kiln-node", "sidecar": true }` with fixed arguments.
- The secret, port, master key and data folder still go in the environment, never argv.
  `NODE_OPTIONS` is removed from the child's environment so a user's shell cannot inject code.

### macOS signing and notarization

- The bundler copies sidecars into `Contents/MacOS`, signs them before the `.app` ("inside out"),
  and passes the hardened-runtime flag and the entitlements file when `hardenedRuntime` (default
  true) is on. Notarization runs when credentials are present: `APPLE_ID`, `APPLE_PASSWORD` and
  `APPLE_TEAM_ID`, or `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_KEY_PATH`; the signing
  identity is `APPLE_SIGNING_IDENTITY` or `bundle.macOS.signingIdentity`.
- Node's JIT needs `com.apple.security.cs.allow-jit` under the hardened runtime.
  `entitlements.plist` also grants `allow-unsigned-executable-memory`. Node's own build grants
  those plus four more (`disable-executable-page-protection`, `allow-dyld-environment-variables`,
  `disable-library-validation`, `get-task-allow`). Which of ours are truly needed is untested.
  The one entitlements file applies to every executable Tauri signs, including the shell itself.
- The re-signed copy of Node loses the OpenJS Foundation signature and carries ours.
- Notarization rejects unsigned Mach-O files anywhere in the bundle. The staged tree has none
  (JavaScript, TypeScript, JSON, HTML), which is the benefit of `node:sqlite`. Adding a native
  module later breaks this.
- A free Apple Developer account cannot notarize, and ad-hoc signing (`"-"`) still triggers the
  Gatekeeper prompt. Public macOS releases need a paid account.

## Risks

1. **Node version drift.** We ship one Node. Security fixes to Node now need an app release. Ship
   the same major CI tests (22 today, `engines` says 22.18+), and decide before Node 22 reaches
   end of life whether to move to 24 (`node:sqlite` is still experimental in 22; check its status
   in the version chosen).
2. **Type stripping is "release candidate", not stable** (Node 22 docs, 1.2). Option C removes
   the dependency by shipping JavaScript. The server still needs it from a checkout and in Docker.
   A new `import.meta.url` file read, a new `await import()` of a package, or a new "run when
   entry point" check in the server breaks the bundle in a way the checkout does not show; the
   bundle script and the smoke test are the guard.
3. **Unproven Tauri details**: the directory form of `resources`, where the resource folder ends
   up in each package format (dmg, deb, AppImage, msi), and that the entitlements path is relative
   to `src-tauri`. Each is a first-build check.
4. **Official binaries only.** Homebrew and distribution Node link shared libraries and do not run
   elsewhere. The script refuses them.
5. **Universal macOS builds** (`universal-apple-darwin`) need a sidecar for that triple (both
   binaries joined with `lipo`). Not attempted. Build per architecture instead.
6. **Antivirus and size.** An unsigned `node.exe` copy on Windows can draw SmartScreen or antivirus
   attention. Windows signing is not covered here.
7. **Linux.** Official Node binaries are glibc builds, so there is no musl target.

## Consequences

- Installer size is the Node binary (about 117 MB uncompressed on Linux arm64) plus the server:
  `launcher.mjs` 3.1 MB minified, 3.2 MB for everything but `web/` in 20 files (was about 1,500
  files), plus the 7.0 MB web UI. Measured on Linux arm64 with esbuild 0.28.2: healthy
  `/api/health` after about 300 ms (one run, polled every 100 ms, so coarse).
- Releasing now includes fetching a verified official Node per target. The script does not
  download; it takes `--node <path>`.
- `main.rs` changes (still uncompiled): `packaged_server`, `spawn_server` takes the app handle,
  release builds use the packaged server, debug builds keep the repository stand-in unless
  `KILN_USE_PACKAGED_SERVER` is set.

## What is verified

See [the spike](../spikes/sidecar.md) for the list and the sources.
