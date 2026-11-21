FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# git for reading repositories from a local clone (KILN_READS, docs/adr/0005-local-clone-reads.md).
# Debian 12 ships git 2.39; the server needs 2.34 or newer. Without it KILN_READS=auto falls back
# to the GitHub API. ca-certificates is for https to github.com. openssh-client (ssh-keygen) and
# gnupg are only used when KILN_GIT_SIGN is ssh or gpg (signed local commits, docs/deployment.md);
# they do nothing otherwise.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client gnupg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# pnpm-lock.yaml is committed: install exactly what it says, or fail.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @kiln/web build

ENV NODE_ENV=production
ENV PORT=8787
# The server writes only here (SQLite file, uploads, git clones in /data/clones). It is owned by
# the unprivileged user below; a named volume mounted at /data starts with this ownership.
ENV KILN_DATA_DIR=/data
ENV DATABASE_URL=file:/data/mrm.db
ENV KILN_CLONE_DIR=/data/clones
RUN mkdir -p /data/clones && chown -R node:node /data && chmod 700 /data/clones
EXPOSE 8787

# Do not run as root. The code under /app is only read.
USER node

# The server runs TypeScript directly (Node type stripping). See docs/spikes/sidecar.md.
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
