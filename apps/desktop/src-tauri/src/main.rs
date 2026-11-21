// UNCOMPILED: this file was written without a Rust toolchain and has never been built or run.
// That includes the packaged-server code (`packaged_server`, `use_packaged`), added for ADR 0004.
// Expect to fix small compile errors (Tauri v2 API names, borrow details) on first `cargo check`.
// It is meant to be small and conservative, so the fixes should be too.
//
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Single-user desktop shell. See docs/adr/0003-single-user-mode.md and docs/spikes/sidecar.md.
//
// On start this:
//   1. makes a launch secret from the OS CSPRNG (32 bytes, hex),
//   2. picks a free loopback port,
//   3. starts the server as a child process in MRM_MODE=single_user, passing the secret in the
//      environment (never argv: other users can read argv),
//   4. waits for /api/health,
//   5. opens the window at /api/auth/launch?secret=..., which trades the secret for a session
//      cookie and redirects to /,
//   6. stops the server when the app exits.
//
// Release builds start the packaged server: the Node binary is a Tauri sidecar (`externalBin`
// "binaries/mrm-node") and the server is a resource folder, both staged by
// apps/desktop/scripts/prepare-sidecar.mjs (docs/adr/0004-desktop-sidecar.md). Debug builds run
// `node apps/server/src/index.ts` from the repository checkout. Only `spawn_server` differs.
//
// The sidecar is started with std::process::Command, not the Tauri shell plugin, so no
// `shell:*` permission exists for any page to use, and stdin can be closed for a clean stop.
//
// The window is created in code, not in tauri.conf.json (`windows` is empty there), because its
// URL contains the secret and the port, which only exist at run time. The page it loads is a
// remote origin, so the capability file does not give it Tauri IPC. It talks to the server over
// HTTP like a browser tab would.

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The running server. Taken out and stopped when the app exits.
struct ServerChild(Mutex<Option<Child>>);

type BoxResult<T> = Result<T, Box<dyn Error>>;

/// `n` random bytes from the operating system's CSPRNG.
fn random_bytes(n: usize) -> BoxResult<Vec<u8>> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|e| format!("cannot read OS randomness: {e}"))?;
    Ok(buf)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Standard base64 with padding, which is what the server's MRM_MASTER_KEY expects.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// The key that encrypts store credentials at rest. Created once and kept in the app data folder
/// with owner-only permissions.
///
/// TODO: move this into the OS keychain. Next to the database it protects against a leaked
/// database file, but not against someone who can read the whole app data folder.
fn load_or_create_master_key(data_dir: &Path) -> BoxResult<String> {
    let path = data_dir.join("master.key");
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let key = base64(&random_bytes(32)?);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path)?.write_all(key.as_bytes())?;
    Ok(key)
}

/// Asks the OS for a free loopback port. Another process could take it before the server does;
/// the server then fails to start and the shell reports that.
fn free_port() -> BoxResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// The packaged server, as laid out by `scripts/prepare-sidecar.mjs` and the Tauri bundler
/// (docs/adr/0004-desktop-sidecar.md). The Node binary is the sidecar `mrm-node`: the bundler
/// puts it next to this executable (Contents/MacOS on macOS) with the target triple removed. The
/// server files are the `server` resource folder. Returns (node, launcher, web UI folder), or
/// None when they are not there.
fn packaged_server(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let node = exe_dir.join(if cfg!(windows) { "mrm-node.exe" } else { "mrm-node" });
    let server_dir = app.path().resource_dir().ok()?.join("server");
    let launcher = server_dir.join("launcher.mjs");
    if node.exists() && launcher.exists() {
        Some((node, launcher, server_dir.join("web")))
    } else {
        None
    }
}

/// Starts the server. Release builds run the packaged server (own Node binary, no Node needed on
/// the user's machine). Debug builds run the repository sources with the system Node, so editing
/// the server needs no re-staging; set MRM_USE_PACKAGED_SERVER=1 to test the packaged one in
/// `tauri dev`. In the repository case, MRM_NODE picks a specific Node binary (a macOS app
/// started from Finder has a short PATH).
fn spawn_server(
    app: &tauri::AppHandle,
    data_dir: &Path,
    port: u16,
    secret: &str,
    master_key: &str,
) -> BoxResult<Child> {
    let use_packaged =
        !cfg!(debug_assertions) || std::env::var_os("MRM_USE_PACKAGED_SERVER").is_some();

    let mut command = if use_packaged {
        let (node, launcher, web) = packaged_server(app).ok_or(
            "the packaged server is missing; run apps/desktop/scripts/prepare-sidecar.mjs before building",
        )?;
        let mut command = Command::new(node);
        command
            .arg("--disable-warning=ExperimentalWarning")
            .arg(launcher)
            .current_dir(data_dir)
            .env("MRM_WEB_DIST", web);
        command
    } else {
        // apps/desktop/src-tauri -> repository root. Fixed at compile time, so dev builds only.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let entry = root.join("apps/server/src/index.ts");
        if !entry.exists() {
            return Err(format!("server entry not found at {}", entry.display()).into());
        }
        let node = std::env::var("MRM_NODE").unwrap_or_else(|_| "node".to_string());
        let mut command = Command::new(node);
        command
            .arg("--disable-warning=ExperimentalWarning")
            .arg(&entry)
            .current_dir(&root)
            .env("MRM_WEB_DIST", root.join("apps/web/dist"));
        command
    };

    command
        .env("MRM_MODE", "single_user")
        .env("MRM_LAUNCH_SECRET", secret)
        .env("MRM_MASTER_KEY", master_key)
        .env("PORT", port.to_string())
        .env("MRM_DATA_DIR", data_dir)
        .env("DATABASE_URL", format!("file:{}", data_dir.join("mrm.db").display()))
        .env("MRM_WORKER", "inline")
        // The server watches its stdin and exits when it closes, so it stops even if this
        // process is killed without running its exit handler.
        .env("MRM_EXIT_WITH_PARENT", "1")
        .env_remove("MRM_TRUSTED_ORIGINS")
        // The app may be started from a shell that exports Node options; do not pass them on.
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    Ok(command.spawn()?)
}

/// True once GET /api/health answers 200. Plain TCP so the shell needs no HTTP client crate.
/// The Host header must match what the server's DNS-rebinding guard allows.
fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = String::new();
    let _ = stream.take(64).read_to_string(&mut head);
    head.starts_with("HTTP/1.1 200")
}

fn wait_for_health(port: u16, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if health_ok(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Closes the server's stdin so it shuts down cleanly, then kills it if it does not leave.
fn stop_server(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ServerChild>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    if let Some(mut child) = guard.take() {
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;

            // 32 bytes from the OS CSPRNG as 64 hex characters. Never logged, never in argv.
            let secret = hex(&random_bytes(32)?);
            let master_key = load_or_create_master_key(&data_dir)?;
            let port = free_port()?;
            let child = spawn_server(app.handle(), &data_dir, port, &secret, &master_key)?;
            app.manage(ServerChild(Mutex::new(Some(child))));

            // Wait off the main thread, then open the window on the launch URL.
            let handle = app.handle().clone();
            thread::spawn(move || {
                if !wait_for_health(port, Duration::from_secs(30)) {
                    eprintln!("The server did not become ready in time.");
                    handle.exit(1);
                    return;
                }
                let launch = format!("http://127.0.0.1:{port}/api/auth/launch?secret={secret}");
                let opened = launch
                    .parse::<tauri::Url>()
                    .map_err(|e| e.to_string())
                    .and_then(|url| {
                        WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                            .title("Kiln")
                            .inner_size(1280.0, 800.0)
                            .build()
                            .map(|_| ())
                            .map_err(|e| e.to_string())
                    });
                if let Err(message) = opened {
                    eprintln!("Cannot open the window: {message}");
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kiln");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_server(handle);
        }
    });
}
