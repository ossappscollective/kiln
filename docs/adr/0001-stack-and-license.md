# ADR 0001: stack, license and packaging

Status: accepted for Phase 0. Revisit after the spikes.

## Context

Existing tools in this space are source-available under a noncommercial license, hosted-only,
or heavy to self-host (a service mesh with a message broker). We want a tool teams can adopt and
self-host with two containers, that also runs as a desktop app without Electron.

## Decisions

| Area     | Decision                                      | Notes                                                 |
| -------- | --------------------------------------------- | ----------------------------------------------------- |
| License  | Apache-2.0                                    | Permissive, patent grant, easy for companies to adopt |
| Language | TypeScript, pnpm workspaces                   | Shared types across API, UI and connectors            |
| API      | Hono                                          | Runs on Node or Bun; OpenAPI generation to be added   |
| UI       | Svelte 5 single-page app, Vite                | Not React, by request; Vue was the alternative        |
| Data     | Drizzle, Postgres and SQLite                  | Portable schema; see the dual-dialect spike           |
| Jobs     | Database-backed queue in the same binary      | No Redis or RabbitMQ                                  |
| Secrets  | AES-256-GCM, master key from the environment  | OS keychain on desktop later                          |
| Desktop  | Tauri around the same UI, server as a sidecar | No Electron; see the sidecar spike                    |
| Runtime  | Node 22.18 or newer, TypeScript run directly  | Native type stripping; revisit for the sidecar        |
| Tests    | `node:test`                                   | No extra runner to install                            |

## Consequences

- Code must stay within erasable TypeScript syntax: no enums, namespaces or constructor
  parameter properties. `erasableSyntaxOnly` enforces it.
- Relative imports use the `.ts` extension.
- Internal packages export their TypeScript source directly. This works because pnpm links
  workspace packages outside `node_modules`.
