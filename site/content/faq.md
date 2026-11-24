# FAQ

Straight answers, including the uncomfortable ones.

## Is Kiln ready for production?

Not yet. Kiln is early, pre-release software. It is covered by automated tests that run against fixtures, in-process fakes and the simulated stores of demo mode. It has not been run against live App Store Connect, Google Play or GitHub accounts in production, and some store API details were written from documentation and have not been confirmed against a real account. Each feature's design note (the files under `docs/adr` in the repository) ends with an "unverified" list that says exactly what is missing.

That is why every store write is off by default. Start with reading and syncing, try the [demo](../../docs/demo.md), and turn writes on one at a time.

## What does Kiln do, and what does it not do?

Kiln manages what happens around your build: releases, store listings, graphics, ASO, reviews, insights, alerts and the people allowed to change things. It does not build or sign apps. Your CI (GitHub Actions, EAS or fastlane) does that, and Kiln starts workflows, follows runs and shows which run produced which store build.

## Which platforms and stores?

iOS and macOS through App Store Connect, and Android through Google Play. Expo (EAS) builds, submissions and updates are supported for linked apps.

## Will Kiln change my store listing without asking?

No. A sync only reads. Changes are staged in the pending cart, you review the diff, and sending a change to a store needs a separate server switch (off by default), a permitted role, a preview and a confirmation. Hard actions can also require a fresh passkey, password or authenticator code.

## Where are my store credentials kept?

In your own database, encrypted with AES-256-GCM using the master key (`KILN_MASTER_KEY`) from your environment. They are never returned by the API and never written to logs. Nobody else holds the key: if you lose it, you enter the credentials again.

## Does Kiln collect telemetry?

No. Kiln sends no usage data to anyone. It talks only to the services you connect (the stores, GitHub, Expo, RevenueCat and so on) and, if you enable them, your AI provider, mail server and webhook receivers. This website sets no cookies and loads no third-party scripts, fonts or analytics. The one optional request it makes is to GitHub's public releases API, when you scroll to the download section.

## What do the AI features send?

Nothing, until you turn them on: `KILN_AI_ENABLED` is false by default, and a workspace must also choose a provider, a model and add a key. Each task lists the data it sends. For reviews you choose per app what may be sent, and reviews are redacted before they leave. AI only makes suggestions that a person accepts; it never changes a store. See [AI features](../../docs/ai-features.md). You can point Kiln at a local model server instead of a hosted provider.

## Can I run it without Docker?

Yes. For development, `pnpm dev` runs the API and the web UI with SQLite and nothing else installed. There is also a desktop app (Tauri) for a single person. See [getting started](getting-started.md).

## Which languages does the app support?

English, French, Spanish and German.

## Why is Google Play keyword tracking marked unofficial?

Google Play has no official API for search results or app pages. Kiln can read the public pages of play.google.com, but that may be against Google's terms and breaks when Google changes the pages. It is off by default (`KILN_ASO_PLAY_UNOFFICIAL_ENABLED`). Apple keyword reads use Apple's documented iTunes Search API.

## Can an AI assistant use Kiln?

Through the MCP server, which is off by default. An assistant connects with an API token, sees only what that token allows, and can preview store actions but never apply them: a person confirms in the web app. See [Connect an AI assistant](../../docs/mcp.md).

## How do I report a security problem?

Privately, to the maintainers, not in a public issue. The [security policy](../../SECURITY.md) has the details and the design rules.

## Is Kiln affiliated with Apple or Google?

No. Kiln is an independent open-source project. App Store, iOS and macOS are trademarks of Apple Inc. Google Play and Android are trademarks of Google LLC.

## What is the license?

Apache License 2.0. You can use, change and redistribute it. See the [LICENSE](../../LICENSE) file.
