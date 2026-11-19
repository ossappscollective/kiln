# 0018. Demo mode

Status: accepted

## Context

Testing the product end to end needs store, GitHub, AI and analytics accounts. A person evaluating it has none.

## Decision

`MRM_DEMO=true` starts a separate, self-contained server (`apps/server/src/demo/`) with its own SQLite file, folder and master key. It builds the normal app through the existing injection seams (`createApp` deps), with stateful fakes for every outside service, and seeds "Demo Studio" through the real HTTP API on a virtual clock. `/demo/login`, `/demo/status`, `/demo/advance`, `/demo/fail` and `/demo/reset` are mounted only there. The normal app has none of them.

## Consequences

- No production code path changes; the demo reuses the test fakes and adds small additive hooks.
- Demo refuses Postgres/production-looking setups; the real folder and credentials are never read.
- The simulated stores keep their state in `world.json` next to the database.
