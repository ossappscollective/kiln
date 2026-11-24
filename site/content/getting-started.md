# Getting started

From a fresh clone to your first synced app. Kiln is early software: it has been tested against fixtures and simulated stores, not yet against live accounts, so read the [FAQ](faq.md#is-kiln-ready-for-production) before you point it at an app you care about.

## 1. Look around first (no accounts needed)

Demo mode runs the whole product on simulated App Store Connect, Google Play, GitHub, AI and analytics. Nothing leaves your machine.

```sh
git clone https://github.com/ossappscollective/kiln.git
cd kiln
pnpm install
pnpm demo
```

Open `http://localhost:8788/demo/login`. It signs you in as the demo owner of "Demo Studio". See [the demo guide](../../docs/demo.md) for what is simulated and how to move the story forward.

You need Node 22.18 or newer and pnpm 10.

## 2. Run your own instance

For development, with SQLite and nothing else to install:

```sh
cp .env.example .env      # then set KILN_MASTER_KEY: openssl rand -base64 32
pnpm install
pnpm dev                  # API on :8787, web UI on :5173
```

`KILN_MASTER_KEY` encrypts every store credential you add. Keep a copy somewhere safe: losing it means entering each credential again. With no `DATABASE_URL`, Kiln uses a SQLite file under `./.kiln-data`.

For a server, use Docker. The [self-hosting guide](self-hosting.md) has the commands, and the [configuration reference](configuration.md) lists the switches.

## 3. Create the owner account

The first visit asks you to create the owner account and a workspace. Registration closes after that, so claim a new instance before you expose it to a network.

## 4. Connect a store

Add a credential for App Store Connect (a team API key) or Google Play (a service account). The credential form shows a guide with the exact steps and the lowest role that works, and a "test connection" check tells you whether the key is accepted. The same steps are in [Store credentials](../../docs/credentials.md).

Then add an app and run a sync. A sync only reads: it stores a snapshot of your versions, tracks and listing, and never writes to a store.

## 5. Stage a change and publish it

Edit a listing text, replace a screenshot or prepare a release. Each change goes into the pending cart, where you can see the diff of everything before anything is sent.

Sending a change to a store is a separate switch, off by default, for each kind of write (listing drafts, submit for review, release, rollout, review replies, in-app product texts, price changes). Turn on only what you need, see [configuration](configuration.md#store-writes-all-off-by-default), and the cart then lets a person confirm each step.

## Where to go next

- [Self-hosting](self-hosting.md): Docker, TLS, data and backups.
- [Configuration](configuration.md): every switch that matters.
- [Store credentials](../../docs/credentials.md): keys and tokens for each service.
- [Connect an AI assistant](../../docs/mcp.md) and [AI features](../../docs/ai-features.md), both off until you turn them on.
