# Spike: bundling the server for the desktop app

**Question:** how does the Tauri app ship the server and SQLite without asking the user to install
Node?

**Status:** outcome proposed in [ADR 0004](../adr/0004-desktop-sidecar.md). The staging script is
tested on Linux arm64; the Tauri bundle, signing and Windows are not. Phase 0 exit gate needs the
first real bundle (see "Still open").

## Options

| Option                                | Idea                                                                    | Watch for                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A. Node single-executable application | Bundle the server to one file, inject it into a Node binary             | Bundling workspace packages. SQLite is built into Node (`node:sqlite`), so there is no native module |
| B. Bun compile                        | `bun build --compile` produces one executable                           | Native module support; behaviour differences from Node                                               |
| C. Ship Node plus sources             | Bundle a Node runtime and the TypeScript sources as Tauri resources     | Larger download; simplest to get working                                                             |
| D. Thin client                        | The desktop app talks to a local or remote server the user already runs | Not a standalone app                                                                                 |

## How to decide

For each option, record: download size, cold start time, whether SQLite works, macOS signing
and notarization, and Windows and Linux behaviour. Build a throwaway sidecar that serves
`/api/health` and opens a SQLite file in the app data folder.

## Wiring it into Tauri

This was the plan before the research below. What was built instead (ADR 0004): the sidecar is the
Node binary (`binaries/mrm-node-<target-triple>`, `externalBin` `binaries/mrm-node`), the server is
a resource folder, and `main.rs` starts it with `std::process::Command`, so there is no
`tauri-plugin-shell` and no `shell:*` capability.

## What single-user mode changes ([ADR 0003](../adr/0003-single-user-mode.md))

The desktop shell now does the sidecar's job in a development form, so only the "how is the server
shipped" half of this spike is still open. `apps/desktop/src-tauri/src/main.rs` (never compiled)
already:

- generates a launch secret with the OS CSPRNG and a free loopback port;
- creates a master key in the app data folder (TODO: OS keychain) and passes the data folder and a
  SQLite path;
- starts the server as a child process with `MRM_MODE=single_user`, `MRM_LAUNCH_SECRET`, `PORT`,
  `MRM_MASTER_KEY` and `MRM_EXIT_WITH_PARENT=1` in the environment, never argv;
- waits for `/api/health`, then creates the window (no window is declared in `tauri.conf.json`
  any more) at `/api/auth/launch?secret=...`;
- closes the child's stdin on exit so it shuts down cleanly, then kills it after 3 seconds.

The stand-in is `node apps/server/src/index.ts` from the repository checkout, located through
`CARGO_MANIFEST_DIR` at compile time (override the Node binary with `MRM_NODE`). Replacing it with
the packaged sidecar changes only `spawn_server`; the secret, port, health wait, launch URL and
shutdown stay. Requirements the chosen option must meet:

- accept the same environment variables and the stdin-close shutdown;
- locate the web UI (`MRM_WEB_DIST`) inside the bundle instead of the repository;
- with `externalBin`, step 3 above uses the sidecar API but must still pass the secret by
  environment, not as an argument;
- the page is a remote origin, so the capability file must keep granting it no IPC.

Not covered yet: Windows and Linux behaviour, a macOS app started from Finder (short `PATH`, hence
`MRM_NODE`), and how the server is updated.

## Findings (docs read 2026-11-18)

Node single executable applications (SEA):

- Node 22 docs: stability 1.1; "only supports running a single embedded script using the CommonJS
  module system"; `require()` in the blob "can only be used to load built-in modules"; blob made
  with `--experimental-sea-config` and injected with `postject`; the Node used to make the blob
  must be the same version as the one it is injected into; `useCodeCache` breaks `import()`;
  macOS needs `codesign --remove-signature`, then `postject --macho-segment-name NODE_SEA`, then
  `codesign --sign`.
- Current docs add `--build-sea` (v25.5.0), `"mainFormat": "module"`, a `useVfs` virtual file system
  (v26.9.0, stability 1.0) and `import()` of built-ins only. None of that is in the v22 docs.
- Neither version mentions TypeScript or type stripping.
- `node:sqlite`: added v22.5.0, no flag needed since v22.13.0, stability 1.1, only available under
  the `node:` scheme. Built in, so no native addon, and loadable in a SEA by the docs' rule for
  built-ins (not tested).
- TypeScript: type stripping is on by default and silent since v22.18.0 (stability 1.2). Node
  "refuses to handle TypeScript files inside folders under a `node_modules` path", which is why the
  packaged server keeps workspace packages out of `node_modules`.

Tauri v2:

- `externalBin` entries need a copy named `<name>-<target-triple>[.exe]`; get the triple with
  `rustc --print host-tuple` (Rust 1.84+) or `rustc -vV`. The "Node.js as a sidecar" guide uses
  `pkg` and mentions "embedding the Node runtime and shipping JavaScript as a resource" as the
  alternative, with readable sources and a larger app.
- Capabilities "enable and constrain the core exposure to the application frontend"; remote content
  gets no IPC unless a capability lists `remote.urls`. The same page lists "intentional bypasses
  from Rust code" as outside the boundary. Shell plugin scopes (`shell:allow-execute`,
  `"sidecar": true`, `args` validators) apply to that plugin's JavaScript API.
- Plugin source (`plugins/shell`): sidecars are found next to the current executable;
  `CommandChild` has `write`, `kill` and `pid`, no stdin close.
- Bundler source (`tauri-bundler`, macOS): sidecars go to `Contents/MacOS`, are signed before the
  app ("inside out") with hardened runtime when `hardenedRuntime` is on, and notarization reads
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or `APPLE_API_ISSUER`/`APPLE_API_KEY`/
  `APPLE_API_KEY_PATH`. The macOS signing page says nothing about sidecars or entitlements.
- Node's own `tools/osx-entitlements.plist` grants six keys, including `allow-jit` and
  `allow-unsigned-executable-memory`.
- nodejs.org release table (read 2026-11-18): v22, v24 and v26 are LTS, v20 is EOL.

## Verified and not

Verified on this repository (Linux arm64, Node v22.23.4, `apps/desktop/scripts/prepare-sidecar.mjs
--smoke` into a temporary folder):

- The staged tree runs with `mrm-node launcher.mjs`: types stripped by Node alone (no tsx), `@mrm/*`
  resolved by the hook, migrations applied on SQLite through `node:sqlite`, `/api/health` 200, a
  foreign `Host` gets 403, the launch URL answers 302 and the process exits 0 when stdin closes.
- With an absolute `MRM_WEB_DIST` pointing at a stub UI, `/` and an unknown route both answer 200.
- Cold start to a healthy `/api/health`: 147, 179 and 201 ms (three runs, warm disk cache).
- Staged size: 902 files, 4.4 MB of server files plus the 116.6 MB Node binary; only text file
  types by extension (ts, js, cjs, mjs, json, md, html), so no native binaries under `server/`.
- The script refuses a Node older than 22.18, one without `node:sqlite`, one linked to shared
  libraries, one for the wrong platform, a missing web build, and a cross target without `--node`.

Not verified:

- Anything in Rust. `main.rs` was never compiled, including the packaged-server code.
- That Tauri accepts `resources` with a directory key, where it places `server/` in each package
  format, and the runtime path from `resource_dir()`.
- macOS signing, entitlements (which keys are truly needed), notarization and Gatekeeper on a clean
  machine. No Mac toolchain or Apple credentials here.
- Windows and Linux bundles, SmartScreen, AppImage behaviour, `universal-apple-darwin`.
- Any SEA build: `postject` is not installed and the network is off. SEA claims above come from the
  docs only, including `node:sqlite` inside a SEA.
- `esbuild` single-file bundling (option C in ADR 0004).
- The staged server was run only with the web UI stubbed: `apps/web/dist` has not been built.
- Node 22 end-of-life date and the `node:sqlite` status in Node 24.

## Still open

1. First `cargo check` and `pnpm --filter @mrm/desktop build` on a Mac with the web UI built.
2. Check `Contents/Resources/server` and `Contents/MacOS/mrm-node` in the `.app`, then run it from
   Finder.
3. Notarize with a paid account; try dropping `allow-unsigned-executable-memory`.
4. Decide the Node major to ship, and where releases fetch the verified Node binary per target.
5. Updates: the server now changes only with an app release.

## Outcome

Proposed in ADR 0004: official Node binary as a Tauri sidecar plus the server as a resource folder.
Not accepted until the first bundle (above) is built and run on macOS.

## Sources

- Node SEA (v22): https://nodejs.org/download/release/latest-v22.x/docs/api/single-executable-applications.md
- Node SEA (current): https://nodejs.org/api/single-executable-applications.md
- Node `node:sqlite` (v22): https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.md
- Node TypeScript (v22): https://nodejs.org/download/release/latest-v22.x/docs/api/typescript.md
- Node releases: https://nodejs.org/en/about/previous-releases
- Node macOS entitlements: https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Tauri Node.js sidecar guide: https://v2.tauri.app/learn/sidecar-nodejs/
- Tauri shell plugin: https://v2.tauri.app/plugin/shell/
- Tauri capabilities: https://v2.tauri.app/security/capabilities/
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri config reference: https://v2.tauri.app/reference/config/
- Tauri bundler (macOS app and sign): https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-bundler/src/bundle/macos
- Tauri shell plugin source: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/shell/src/process
