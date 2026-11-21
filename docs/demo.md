# Demo mode

Try the whole product in a browser without any real account. Everything the stores, GitHub, translation, AI and analytics would answer is simulated; nothing leaves your machine.

    pnpm demo          # builds the web app, seeds "Demo Studio", serves http://localhost:8788
    pnpm demo:reset    # wipes the demo data and seeds again

Open http://localhost:8788/demo/login. It signs you in as the demo owner. Other users: `/demo/login?as=admin|member|viewer`.

## What is simulated

App Store Connect, Google Play, GitHub (repository, workflows, runs), translation, AI (a deterministic built-in provider), analytics and the ASO sources. The data is seeded through the normal API on a virtual clock, so histories (60 days of ranks, 90 days of analytics, audit events) look real. All gated writes are on.

Test builds work end to end: TestFlight public links (Demo Notes iOS: on, 100 testers; Demo Weather iOS: off; Demo Focus: none), tiny workflow artifacts (`.ipa`, `.apk`, `.aab`, `.dmg`, a few hundred bytes, created by finished build runs), downloads (on; `KILN_BUILDS_DOWNLOAD_ENABLED=false` switches them off), and Share to device (Google Play internal app sharing with a made-up link; the passkey step-up is approved automatically).

## What is real

The server, the API, the database schema (migrations), permissions, previews, confirmation hashes and audit log. Only the outside world is replaced.

## Moving the story forward

- `POST /demo/advance {"hours": 30, "outcome": "approve" | "reject" | "none"}`: time passes, reviews finish, phased releases start. The alert evaluator then runs once, so conditions the time brought (a sync that keeps failing, a stalled release) appear in the inbox; the answer has an `alerts` summary. The inbox already holds a few alerts (some read, some not) and the delivery log has their inbox entries; email is off in the demo, and "a competitor changed its listing" is turned off so the seeded ASO history does not flood it ([alerts](alerts.md)).
- `POST /demo/fail {"connector": "appstoreconnect", "kind": "rate_limit", "count": 1}`: make the next calls fail. Connectors: appstoreconnect, googleplay, stores, github, translation, ai, analytics, aso. Kinds: rate_limit, auth, forbidden, server, unknown, unknown_applied. `DELETE /demo/fail` clears them.
- `GET /demo/status`, `POST /demo/reset`. The web app reads `GET /demo/status` once at start: when it answers `demo: true` the shell shows a slim, permanent "Demo workspace" bar (any other server has no such route, so no bar).

The Android demo apps also have a release in the internal track ("Promote to production"), and "Check with Google Play" answers without Google: a release to everybody (100%) while another release rolls out gets one clearly labelled example error, anything else finds no errors.

A walk through: fix the alpha screenshot on Demo Notes (iOS), push the draft, submit, advance 30 hours with approve, release, advance 2 hours, pause the rollout.

## Safety

Off unless `KILN_DEMO=true`. It listens on 127.0.0.1 only, uses its own folder (`apps/server/.mrm-demo`, `KILN_DEMO_DIR`), its own SQLite file and a built-in master key. It never reads `.env`, the real master key or `.mrm-data`. It refuses to start when `DATABASE_URL` is Postgres, `NODE_ENV=production`, `KILN_MASTER_KEY` or `KILN_MODE=single_user` is set (override the look-alike cases with `KILN_DEMO_FORCE=true`; a folder that is not a demo folder is never accepted). `/demo/*` routes exist only in demo mode. Port: `KILN_DEMO_PORT` (default 8788).
