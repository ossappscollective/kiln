# Demo mode

Try the whole product in a browser without any real account. Everything the stores, GitHub, translation, AI and analytics would answer is simulated; nothing leaves your machine.

    pnpm demo          # builds the web app, seeds "Demo Studio", serves http://localhost:8788
    pnpm demo:reset    # wipes the demo data and seeds again

Open http://localhost:8788/demo/login. It signs you in as the demo owner. Other users: `/demo/login?as=admin|member|viewer`.

## What is simulated

App Store Connect, Google Play, GitHub (repository, workflows, runs), translation, AI (a deterministic built-in provider), analytics and the ASO sources. The data is seeded through the normal API on a virtual clock, so histories (60 days of ranks, 90 days of analytics, audit events) look real. All gated writes are on.

## What is real

The server, the API, the database schema (migrations), permissions, previews, confirmation hashes and audit log. Only the outside world is replaced.

## Moving the story forward

- `POST /demo/advance {"hours": 30, "outcome": "approve" | "reject" | "none"}`: time passes, reviews finish, phased releases start.
- `POST /demo/fail {"connector": "appstoreconnect", "kind": "rate_limit", "count": 1}`: make the next calls fail. Connectors: appstoreconnect, googleplay, stores, github, translation, ai, analytics, aso. Kinds: rate_limit, auth, forbidden, server, unknown, unknown_applied. `DELETE /demo/fail` clears them.
- `GET /demo/status`, `POST /demo/reset`.

A walk through: fix the alpha screenshot on Demo Notes (iOS), push the draft, submit, advance 30 hours with approve, release, advance 2 hours, pause the rollout.

## Safety

Off unless `MRM_DEMO=true`. It listens on 127.0.0.1 only, uses its own folder (`apps/server/.mrm-demo`, `MRM_DEMO_DIR`), its own SQLite file and a built-in master key. It never reads `.env`, the real master key or `.mrm-data`. It refuses to start when `DATABASE_URL` is Postgres, `NODE_ENV=production`, `MRM_MASTER_KEY` or `MRM_MODE=single_user` is set (override the look-alike cases with `MRM_DEMO_FORCE=true`; a folder that is not a demo folder is never accepted). `/demo/*` routes exist only in demo mode. Port: `MRM_DEMO_PORT` (default 8788).
