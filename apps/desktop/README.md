# Desktop app (Tauri)

A Tauri v2 shell that starts the server as a child process and opens a window on it. No Node is
needed on the user's machine: the app ships its own Node binary. Design and open questions:
[ADR 0004](../../docs/adr/0004-desktop-sidecar.md), [ADR 0003](../../docs/adr/0003-single-user-mode.md),
[sidecar spike](../../docs/spikes/sidecar.md).

Needs Rust, and (for the build) the web UI built with `pnpm build` from the repository root.
`src-tauri/src/main.rs` has never been compiled, so expect small fixes on the first `cargo check`.

The menu bar and the start-up messages are translated (French, Spanish, German) from `locales/desktop/*.json`, in the system's language:
see [docs/i18n-desktop.md](../../docs/i18n-desktop.md). Try one with `KILN_LANG=fr pnpm --filter @kiln/desktop dev`.

## What gets packaged

`scripts/prepare-sidecar.mjs` copies files that are already on this machine into
`src-tauri/binaries/` (git-ignored). It does not download or compile anything.

| Output                           | Used as                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kiln-node-<target-triple>[.exe]` | Tauri `externalBin` `binaries/kiln-node`: the Node binary                                                                                                  |
| `server/`                        | Tauri `resources`, installed as `server/`: server sources, `@kiln/*` packages, `hono`, `zod`, `@hono/node-server`, the launcher, and `web/` (the built UI) |

The Node binary is the one running the script, so run it with the official Node 22.18 or newer
(nodejs.org, nvm, fnm, Volta). Homebrew and distribution packages are refused because they link
shared libraries.

## Build flow

```sh
pnpm install
pnpm build                                              # web UI -> apps/web/dist
pnpm --filter @kiln/desktop check-sidecar                # dry run: prints the plan, writes nothing
pnpm --filter @kiln/desktop tauri icon path/to/app-icon.png   # once
pnpm --filter @kiln/desktop build                        # stages the sidecar, then tauri build
```

- `build` and `dev` run the staging step first, because Tauri refuses to build when the
  `externalBin` file for the target is missing. `dev` passes `--allow-missing-web`.
- Debug builds (`tauri dev`) still run `apps/server/src/index.ts` from the checkout with the system
  `node` (`KILN_NODE` picks another). Set `KILN_USE_PACKAGED_SERVER=1` to run the staged one.
- Test the staged server on its own, without Tauri:
  `node apps/desktop/scripts/prepare-sidecar.mjs --smoke`. It starts the server once in
  single-user mode, calls it, and checks it exits when stdin closes.

### Script options

```
--check               validate and print the plan; write nothing (exit 1 on a problem)
--smoke               after staging, run the staged server once
--target <triple>     default: rustc's host triple, or guessed from this Node
--node <path>         Node binary to ship; required when --target is not the host
--out <dir>           default: src-tauri/binaries
--allow-missing-web   do not fail when apps/web/dist is missing
```

### Another target

Download the official `node-v<version>-<platform>-<arch>` archive from https://nodejs.org/dist/,
verify it against `SHASUMS256.txt`, extract the `node` binary, then for example:

```sh
node scripts/prepare-sidecar.mjs --target x86_64-apple-darwin --node /path/to/node
pnpm tauri build --target x86_64-apple-darwin
```

Supported triples: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`,
`aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`. The script cannot
run a Node for another platform, so for a cross target it does not check the version or
`node:sqlite`. Build on the target platform where you can.

### macOS signing and notarization

Set `APPLE_SIGNING_IDENTITY` and either `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`, or
`APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_KEY_PATH`, then run the build. Tauri signs
`kiln-node` and the app with the hardened runtime and `src-tauri/entitlements.plist` (JIT for V8).
Not yet tried; see the ADR.

## Files

- `scripts/prepare-sidecar.mjs`: the staging script.
- `sidecar/launcher.mjs`, `sidecar/workspace-resolve.mjs`: the server entry inside the bundle.
- `src-tauri/`: `tauri.conf.json`, `capabilities/default.json` (grants the page no IPC),
  `entitlements.plist`, `src/main.rs`.
