# ADR 0003: Single-user mode for the desktop app

Status: accepted for Phase 0. Server and web client are tested; the Tauri shell is written but has
never been compiled.

## Context

The desktop app runs the server on the user's own machine and has one user, so a login screen is
noise. But a local server with no login is reachable by more than the app window: any process on
the machine, any other user of the machine, and any web page open in the user's browser. A page can
send requests to `http://localhost:PORT` (CSRF), or point its own domain at 127.0.0.1 and then read
the answers because the browser considers it the same origin (DNS rebinding). The server holds store
credentials and can write to the stores, so "no login" must not mean "no authentication".

## Decision

`KILN_MODE=single_user` (default `multi`, which is unchanged). The server still has accounts and
sessions; single-user mode only changes how the one session starts.

1. **Loopback only.** The server listens on `127.0.0.1`, not on all interfaces.
2. **Host allowlist (anti DNS rebinding).** Every request, including static files and the launch
   URL, is refused with 403 `bad_host` unless `Host` is `localhost`, `127.0.0.1` or `[::1]` on the
   configured port. A rebound page still sends its own name in `Host`. Requests with
   `X-Forwarded-Host` are refused too, because nothing may sit in front of this server and the
   same-origin check trusts that header.
3. **A per-launch secret instead of a password.** The shell generates 32 random bytes from the OS
   CSPRNG and passes them in `KILN_LAUNCH_SECRET` (environment, never argv, which other users can
   read). Config requires 43 or more URL-safe characters (32 bytes as base64url, or 64 hex) and
   rejects repetitive values. That is a sanity check; the shell is responsible for real randomness.
4. **`GET /api/auth/launch?secret=...`** compares the secret in constant time (SHA-256 of both
   sides, then `timingSafeEqual`), creates the local user and workspace on first use (role `owner`,
   no password hash, so it can never log in), starts a normal `mrm_session` cookie (`HttpOnly`,
   `SameSite=Lax`) and redirects to `/`. The route exists only in single-user mode; in multi mode it
   is an ordinary 404. The response is `no-store` with `Referrer-Policy: no-referrer`, and the
   redirect keeps the secret out of the address bar. The server never logs request URLs or the
   secret, and config errors never echo it.
5. **The secret is single-use.** It is spent on the first success, in the same synchronous step as
   the comparison, so concurrent requests cannot both win. A server-side failure before the session
   exists (database error, wrong kind of database) gives it back. Wrong guesses do not spend it.
   Single-use beats a time limit here: the shell uses it within a second of starting, so a
   short-lived secret would add a failure mode for developers who start the server by hand and
   open the page later, while a stolen-but-unused secret is exactly what single-use limits. The
   session cookie then carries the user for its normal 30 days.
6. **Everything after that is the existing machinery.** Same sessions table, `requireUser`, role
   checks, same-origin check on writes, and audit events with a normal `user` actor ("Local user").
7. **No password endpoints.** `register`, `login` and `logout` answer 403
   `disabled_in_single_user_mode`. Logout is off because the secret is spent: signing out would
   lock the person out until they restart the app. The web UI hides the button.
8. **Refuses an existing hosted database.** If the database already has accounts and none is the
   local user, launch answers 409 `not_a_single_user_database` instead of adding an owner.
9. **`/api/auth/status`** says `mode: 'single_user'` and `setupRequired: false`. In multi mode the
   response is byte-for-byte what it was, so `mode` is absent there and clients read a missing
   `mode` as `multi`. (Adding it to multi mode too is one line in `routes/auth.ts`, once
   `app.test.ts` stops asserting the exact shape.)
10. **Dev servers.** Vite forwards the browser's own Host (`localhost:5173`), which the allowlist
    would refuse. `KILN_ALLOWED_HOSTS` (single-user only, default empty) adds exact extra Host values.
    Each must be `localhost`, `127.0.0.1` or `[::1]` with an explicit port; anything else, including
    wildcards and real hostnames, fails at startup, because that would reopen DNS rebinding.
    Example: `KILN_ALLOWED_HOSTS=localhost:5173`.

## Threat model

| Threat                                                                      | What stops it                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A web page does `fetch('http://localhost:PORT/...')` or posts a form (CSRF) | The cookie is `SameSite=Lax`; writes also need a matching `Origin` (existing check); a page cannot start a session without the secret; responses are not CORS-readable                                                                  |
| A web page rebinds its domain to 127.0.0.1                                  | `Host` allowlist rejects its name before any route or static file runs                                                                                                                                                                  |
| Another user on the same machine                                            | Loopback bind plus a secret they cannot read: it is in the child's environment (owner-only on Linux and macOS), not argv, not a file, not logged. The database and master key live in the app's data folder with the user's permissions |
| Another local process of the same user                                      | **Out of scope.** It can read the data folder, the master key and the child's environment, and attach to the process. A desktop app cannot defend against its own user's other programs                                                 |
| Guessing the secret                                                         | 256 bits; failed attempts do not spend it, and online guessing at that size is infeasible                                                                                                                                               |
| Replaying a captured launch URL                                             | Single-use. After the shell uses it, it does nothing                                                                                                                                                                                    |

Explicitly out of scope:

- Malware or a hostile browser extension running as the user, and anyone with the unlocked disk.
- Cookie scope across ports: cookies are shared by every port on `localhost`, so another local web
  app can overwrite or clear `mrm_session`. It cannot read it (`HttpOnly`) or forge one, so the
  effect is a nuisance, not access.
- Multiple local instances at once, and running single-user mode behind a reverse proxy or on a
  network. Both are unsupported; the Host guard refuses the proxy case on purpose.
- Encrypting the master key with the OS keychain. For now the shell keeps it in the data folder
  (mode 0600). That protects a leaked database file, not a copied data folder. Tracked as a TODO in
  `main.rs`.
- A browser pointed at the URL by hand. By design only the shell holds the secret.

## Consequences

- The web UI shows "Open this app from the desktop shell" when there is no session.
- If the cookie is lost or expires, the person restarts the app, which starts a new server and a
  new secret.
- The launch secret exists only in memory, so restarting the server always needs a new one.
- The shell's own failure mode: if the shell is killed, the server exits when its stdin closes
  (`KILN_EXIT_WITH_PARENT=1`), so a server never outlives its window.
