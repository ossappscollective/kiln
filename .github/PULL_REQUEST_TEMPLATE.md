## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

<!-- The title (the commit message when squashed) is read by the release tooling:
     `type(scope): subject`, with type feat, fix, perf, revert, docs, refactor, test, build, ci or
     chore, and `!` after it (or a `BREAKING CHANGE:` footer) for a breaking change.
     See CONTRIBUTING.md, "Commit messages". -->

## How it was checked

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `node scripts/i18n.mjs check --strict` (every new string has en, fr, es and de)
- [ ] The title follows `type(scope): subject` (Conventional Commits)
- [ ] Tests added for changes to `core`, `vault`, `db` or `connectors`
- [ ] Docs, `.env.example` and the relevant `docs/api/` page updated if behaviour or configuration changed

## Safety

- [ ] No secrets, credentials or customer data in code, tests, logs or screenshots
- [ ] Any new store write is off by default, previewed, role-checked and audited

<!-- Say what you could not verify (for example, not run against a real store account). -->
