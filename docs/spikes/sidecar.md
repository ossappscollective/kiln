# Spike: bundling the server for the desktop app

**Question:** how does the Tauri app ship the server and SQLite without asking the user to install
Node?

**Status:** open. Phase 0 exit gate needs a recorded outcome.

## Options

| Option | Idea | Watch for |
| --- | --- | --- |
| A. Node single-executable application | Bundle the server to one file, inject it into a Node binary | Bundling workspace packages. SQLite is built into Node (`node:sqlite`), so there is no native module |
| B. Bun compile | `bun build --compile` produces one executable | Native module support; behaviour differences from Node |
| C. Ship Node plus sources | Bundle a Node runtime and the TypeScript sources as Tauri resources | Larger download; simplest to get working |
| D. Thin client | The desktop app talks to a local or remote server the user already runs | Not a standalone app |

## How to decide

For each option, record: download size, cold start time, whether SQLite works, macOS signing
and notarization, and Windows and Linux behaviour. Build a throwaway sidecar that serves
`/api/health` and opens a SQLite file in the app data folder.

## Wiring it into Tauri

1. Build the executable as `apps/desktop/src-tauri/binaries/mrm-server-<target-triple>`.
2. Add `"externalBin": ["binaries/mrm-server"]` under `bundle` in `tauri.conf.json`.
3. Add `tauri-plugin-shell`, spawn the sidecar in `setup`, keep the child handle in managed
   state, and kill it on exit.
4. Allow only that sidecar in `capabilities/default.json`.
5. Choose a free port, pass it in, and point the window at it.

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

## Outcome

_Not decided._
