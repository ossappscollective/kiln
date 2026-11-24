# Self-hosting

Run Kiln on your own machine or server. It is one Node process (the API, the job worker and the web UI) plus a database: SQLite for one person, Postgres for a team.

## One container with SQLite

The image sets `DATABASE_URL=file:/data/kiln.db` and keeps all data under `/data`, so a named volume is all the state there is.

```sh
export KILN_MASTER_KEY="$(openssl rand -base64 32)"   # keep a copy somewhere safe
docker run -d --name kiln \
  -p 127.0.0.1:8787:8787 \
  -e KILN_MASTER_KEY \
  -v kiln-data:/data \
  ghcr.io/ossappscollective/kiln:latest
```

The image is published by the release workflow when a version is tagged. Until the first release exists, build the same image yourself from a clone with `docker build -t kiln .`.

Open `http://localhost:8787`. The first visit creates the owner account.

## Docker Compose with Postgres

The repository's `docker-compose.yml` runs the app next to a Postgres 17 container.

```sh
git clone https://github.com/ossappscollective/kiln.git
cd kiln
cp .env.example .env      # set KILN_MASTER_KEY: openssl rand -base64 32
docker compose up --build
```

The compose file refuses to start without `KILN_MASTER_KEY`. The Postgres user, database and volume names are `mrm` on purpose: they are what your data lives under, and renaming them would start an empty database.

## Put TLS in front

The server speaks plain HTTP and does not terminate TLS. By default Compose publishes port 8787 on `127.0.0.1` only. Before you expose Kiln:

- Run a TLS-terminating reverse proxy (Caddy, nginx, Traefik or a cloud load balancer) and send `X-Forwarded-Proto: https`, so the session cookie is marked `Secure`.
- Pass the original `Host`, and set HSTS in the proxy.
- Set `KILN_TRUST_PROXY=1` only when exactly one proxy you control sits in front and appends the client address.
- Set `KILN_PUBLIC_ORIGIN` to the address people use, so passkeys and the links in alert emails point at the right place.
- Only set `KILN_BIND=0.0.0.0` when something else already protects the port: it publishes plain HTTP on every interface.

The [deployment reference](../../docs/deployment.md) explains each of these and the risk of getting one wrong.

## Your data and your key

State lives in the database and in the data folder (`/data` in the container). Back up both, and keep `KILN_MASTER_KEY` separately: the credentials in the database cannot be read without it, and Kiln cannot recover it for you.

## What the container does

It runs as the unprivileged `node` user and writes only to `/data`. Request bodies are capped, every response carries a Content-Security-Policy, and sign-in is rate limited. The [security policy](../../SECURITY.md) lists the design rules.

## Next

[Configuration](configuration.md) lists the switches. Every store write, the AI features and the MCP server are off until you enable them.
